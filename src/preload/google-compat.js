// Preload de sessió. Quan la pestanya s'està presentant com a Firefox (vegeu identity.js),
// amaga els senyals propis de Chromium perquè el conjunt sigui coherent; si no, Google
// detecta la contradicció i bloqueja l'inici de sessió.
const { webFrame, contextBridge } = require('electron');

if (/Firefox\/\d+/.test(navigator.userAgent)) {
  const patch = () => {
    try {
      const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
      def('userAgentData', undefined);
      def('vendor', '');
      def('productSub', '20100101');
      def('webdriver', false);
      def('oscpu', navigator.platform === 'Win32' ? 'Windows NT 10.0; Win64; x64' : navigator.platform);
      try { delete window.chrome; } catch { window.chrome = undefined; }
    } catch { /* ignora */ }
  };
  if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func: patch }); // síncron, abans dels scripts de la pàgina
  } else {
    webFrame.executeJavaScript(`(${patch.toString()})()`);
  }
}
