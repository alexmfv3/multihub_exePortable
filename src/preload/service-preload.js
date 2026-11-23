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
