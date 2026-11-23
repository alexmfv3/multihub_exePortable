// ─────────────────────────────────────────────────────────────────────────────
// "Identitat" del navegador per a cada pestanya de servei.
//
// Google bloqueja l'inici de sessió als navegadors incrustats (Electron). Ens hi
// presentem com a Firefox, però de manera coherent i SENSE canviar el User-Agent
// mentre una pàgina carrega: en Chromium, canviar-lo a mig carregar força una
// recàrrega, i això trencava el flux de Google després de posar la contrasenya
// (la pàgina es quedava carregant per sempre).
//
//  · Serveis de Google (Gmail, Drive, YouTube Music...): Firefox de forma permanent,
//    a tota la sessió (pàgina, service workers i peticions).
//  · Finestres emergents cap a accounts.google.com (p. ex. "Continua amb Google" de
//    Claude): Firefox des que es creen, abans de carregar res.
//  · Altres serveis que redirigeixen a Google: s'atura la redirecció, es canvia la
//    identitat i es torna a obrir l'adreça. En tornar al servei es recupera Chrome.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function createIdentity({ isEnabled }) {
  const platform = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    linux: 'X11; Linux x86_64'
  }[process.platform] || 'X11; Linux x86_64';
  const chromeMajor = Number(process.versions.chrome.split('.')[0]);
  const ffMajor = chromeMajor + 3; // Firefox i Chrome surten al mateix ritme: versió "actual" equivalent
  const ffPlatform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : platform;

  const CHROME_UA = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  const FIREFOX_UA = `Mozilla/5.0 (${ffPlatform}; rv:${ffMajor}.0) Gecko/20100101 Firefox/${ffMajor}.0`;

  const firefoxWCs = new Set();
  let pendingFirefoxPopups = 0;

  const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  const isGoogleLogin = (u) => ['accounts.google.com', 'accounts.youtube.com'].includes(host(u));
  const isGoogleService = (u) => /(^|\.)(google\.com|youtube\.com)$/.test(host(u));

  function set(wc, firefox) {
    if (wc.isDestroyed()) return;
    if (firefox) firefoxWCs.add(wc.id); else firefoxWCs.delete(wc.id);
    const ua = firefox ? FIREFOX_UA : CHROME_UA;
    if (wc.__mhUA !== ua) { wc.__mhUA = ua; wc.setUserAgent(ua); }
  }

  /** Cridar per a cada webContents d'una sessió de servei, just quan es crea. */
  function attach(wc) {
    const startFirefox = (isEnabled() && wc.getType() === 'window' && pendingFirefoxPopups > 0)
      || !!wc.session.__mhFirefox;
    if (wc.getType() === 'window' && pendingFirefoxPopups > 0) pendingFirefoxPopups--;
    set(wc, startFirefox && isEnabled());
    if (startFirefox) wc.__mhPermanent = true;

    const onNav = (e, url) => {
      if (!isEnabled() || wc.__mhPermanent || firefoxWCs.has(wc.id)) return;
      if (!isGoogleLogin(url)) return;
      e.preventDefault();
      setImmediate(() => { set(wc, true); wc.__mhTemp = true; wc.loadURL(url); });
    };
    wc.on('will-navigate', (e) => { if (e.isMainFrame !== false) onNav(e, e.url); });
    wc.on('will-redirect', (e) => { if (e.isMainFrame !== false) onNav(e, e.url); });
    wc.on('did-stop-loading', () => {
      // Tornem a Chrome quan ja hem sortit de Google i la pàgina està en repòs (sense recàrrega)
      if (wc.__mhTemp && !isGoogleLogin(wc.getURL())) { wc.__mhTemp = false; set(wc, false); }
    });
    const id = wc.id;
    wc.once('destroyed', () => firefoxWCs.delete(id));
  }

  /** Per a la vista principal d'un servei, abans de carregar la seva URL. */
  function forService(wc, ses, url) {
    const ff = isEnabled() && isGoogleService(url);
    ses.__mhFirefox = ff;
    ses.setUserAgent(ff ? FIREFOX_UA : CHROME_UA);
    wc.__mhPermanent = ff;
    set(wc, ff);
  }

  /** Des de setWindowOpenHandler: la propera finestra emergent serà un inici de sessió de Google. */
  function notePopup(url) { if (isEnabled() && isGoogleLogin(url)) pendingFirefoxPopups++; }

  /** Capçaleres coherents: sense Client Hints de Chromium quan fem de Firefox. */
  function rewriteHeaders(details, ses) {
    if (!(firefoxWCs.has(details.webContentsId) || ses.__mhFirefox)) return;
    details.requestHeaders['User-Agent'] = FIREFOX_UA;
    for (const k of Object.keys(details.requestHeaders)) if (/^sec-ch-ua/i.test(k)) delete details.requestHeaders[k];
  }

  return { CHROME_UA, FIREFOX_UA, attach, forService, notePopup, rewriteHeaders };
};
