// Preload de les sessions de servei (s'executa abans que els scripts de cada web).
//  1) Notificacions per servei: "Silencia" fa que les notificacions de Windows no sonin, i
//     "Notificacions" desactivat no en mostra cap. Clicar una notificació obre aquell servei.
//  2) Compatibilitat amb l'inici de sessió de Google quan la pestanya fa de Firefox.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

let flags = {};
try { flags = ipcRenderer.sendSync('mh:flags') || {}; } catch { /* sessió sense servei */ }
ipcRenderer.on('mh:flags', (_e, f) => { flags = f || {}; });

contextBridge.exposeInMainWorld('__multihub', {
  flags: () => flags,
  clicked: () => ipcRenderer.send('mh:notification-click')
});

function inMainWorld(fn) {
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: fn });
  else webFrame.executeJavaScript(`(${fn.toString()})()`);
}

// ── 1. Notificacions ─────────────────────────────────────────────────────────
inMainWorld(() => {
  const api = window.__multihub;
  const Orig = window.Notification;
  if (!api || !Orig || Orig.__mh) return;

  const fix = (opts) => {
    const f = api.flags();
    return f.silent ? { ...(opts || {}), silent: true } : (opts || {});
  };

  function MHNotification(title, opts) {
    if (api.flags().notify === false) {
      // Notificació "fantasma": la web creu que s'ha mostrat, però no surt res
      const fake = new EventTarget();
      Object.assign(fake, { title, ...(opts || {}), close() {}, onclick: null, onshow: null, onclose: null, onerror: null });
      return fake;
    }
    const n = new Orig(title, fix(opts));
    n.addEventListener('click', () => api.clicked());
    return n;
  }
  MHNotification.prototype = Orig.prototype;
  Object.defineProperty(MHNotification, 'permission', { get: () => Orig.permission });
  Object.defineProperty(MHNotification, 'maxActions', { get: () => Orig.maxActions });
  MHNotification.requestPermission = (...a) => Orig.requestPermission(...a);
  MHNotification.__mh = true;
  window.Notification = MHNotification;

  const proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
  if (proto && proto.showNotification) {
    const orig = proto.showNotification;
    proto.showNotification = function (title, opts) {
      if (api.flags().notify === false) return Promise.resolve();
      return orig.call(this, title, fix(opts));
    };
  }
});

// ── 1b. YouTube / YouTube Music sense anuncis ────────────────────────────────
// S'executa abans que cap script de YouTube (per això funciona on el bloquejador general no arriba):
//  · Elimina les dades dels anuncis de les respostes del reproductor (com els filtres "json-prune" d'uBlock).
//  · Si algun anunci s'escola igualment, el salta automàticament.
//  · Amaga els anuncis de la pàgina i l'avís de "bloquejadors no permesos".
if (flags.adblock !== false && /(^|\.)youtube\.com$/.test(location.hostname)) {
  const AD_CSS = `
    ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
    ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer, ytd-compact-promoted-video-renderer,
    ytd-player-legacy-desktop-watch-ads-renderer, ytd-action-companion-ad-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
    #masthead-ad, #player-ads, #panels > ytd-ads-engagement-panel-content-renderer, .ytd-merch-shelf-renderer, ytd-merch-shelf-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer), ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-suggested-action, .ytp-featured-product,
    ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer,
    tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model
    { display: none !important; }
  `;
  try { webFrame.insertCSS(AD_CSS); } catch { /* el document encara no existeix */ }
  window.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style'); st.textContent = AD_CSS; document.documentElement.appendChild(st);
  });

  inMainWorld(() => {
    const AD_KEYS = ['playerAds', 'adPlacements', 'adSlots', 'adBreakHeartbeatParams'];
    const prune = (o) => {
      if (!o || typeof o !== 'object') return o;
      if (Array.isArray(o)) { for (const x of o) if (x && typeof x === 'object' && x.playerResponse) prune(x.playerResponse); return o; }
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse) prune(o.playerResponse);
      const mr = o.auxiliaryUi && o.auxiliaryUi.messageRenderers;
      if (mr && mr.enforcementMessageViewModel) delete mr.enforcementMessageViewModel;
      return o;
    };

    // JSON.parse i Response.json (Proxy: conserven l'aspecte de funció nativa)
    JSON.parse = new Proxy(JSON.parse, {
      apply(t, self, args) { const r = Reflect.apply(t, self, args); try { prune(r); } catch {} return r; }
    });
    const RP = Response.prototype;
    RP.json = new Proxy(RP.json, {
      apply(t, self, args) { return Reflect.apply(t, self, args).then((r) => { try { prune(r); } catch {} return r; }); }
    });

    // Dades inicials incrustades a la pàgina (var ytInitialPlayerResponse = {...})
    for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
      let value;
      try {
        Object.defineProperty(window, name, {
          configurable: true, enumerable: true,
          get: () => value,
          set: (v) => { try { prune(v); } catch {} value = v; }
        });
      } catch {}
    }

    // Pla B: si un anunci arriba a reproduir-se, se salta sol
    let mutedByUs = false, rateByUs = false;
    setInterval(() => {
      const player = document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
      const video = document.querySelector('.html5-video-player video, video.html5-main-video, video');
      if (player && video) {
        if (!video.muted) { video.muted = true; mutedByUs = true; }
        if (video.playbackRate < 16) { video.playbackRate = 16; rateByUs = true; }
        if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
          try { video.currentTime = video.duration - 0.1; } catch {}
        }
        for (const b of document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button')) b.click();
      } else if (video) {
        if (mutedByUs) { video.muted = false; mutedByUs = false; }
        if (rateByUs) { video.playbackRate = 1; rateByUs = false; }
      }
      // Avís de "bloquejadors no permesos": el treiem i el vídeo continua
      const enforce = document.querySelector('ytd-enforcement-message-view-model');
      if (enforce) {
        enforce.closest('tp-yt-paper-dialog')?.remove();
        document.querySelector('tp-yt-iron-overlay-backdrop')?.remove();
        if (video && video.paused) video.play().catch(() => {});
      }
    }, 300);
  });
}

// ── 2. Inici de sessió de Google (vegeu main/identity.js) ────────────────────
if (/Firefox\/\d+/.test(navigator.userAgent)) {
  inMainWorld(() => {
    try {
      const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
      def('userAgentData', undefined);
      def('vendor', '');
      def('productSub', '20100101');
      def('webdriver', false);
      def('oscpu', navigator.platform === 'Win32' ? 'Windows NT 10.0; Win64; x64' : navigator.platform);
      try { delete window.chrome; } catch { window.chrome = undefined; }
    } catch { /* ignora */ }
  });
}
