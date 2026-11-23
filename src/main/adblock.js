// Bloquejador d'anuncis integrat (motor de Ghostery, compatible amb filtres d'uBlock Origin i EasyList).
// Electron no implementa chrome.declarativeNetRequest, i per això les extensions de bloqueig
// Manifest V3 (Adblock Plus, uBlock Origin Lite...) no bloquegen res dins de l'app.
// Aquest motor actua directament sobre cada sessió: bloqueig de xarxa, filtres cosmètics
// i scriptlets (necessaris per als anuncis de YouTube).
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

const MAX_AGE = 2 * 24 * 3600 * 1000; // actualitza els filtres cada 2 dies
let blockerPromise = null;
const enabledSessions = new Set();

// net.fetch fa servir el proxy del sistema (important en xarxes d'empresa)
const fetchImpl = (url, init) => net.fetch(url, init);

function getBlocker() {
  if (!blockerPromise) {
    blockerPromise = (async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
      try { if (Date.now() - fs.statSync(cache).mtimeMs > MAX_AGE) fs.rmSync(cache, { force: true }); } catch { /* no hi és */ }
      return ElectronBlocker.fromPrebuiltAdsAndTracking(fetchImpl, {
        path: cache, read: fs.promises.readFile, write: fs.promises.writeFile
      });
    })().catch((err) => { blockerPromise = null; throw err; });
  }
  return blockerPromise;
}

/** Activa el bloqueig en una sessió. Espera com a màxim `timeoutMs` per no endarrerir l'arrencada. */
async function enable(ses, timeoutMs = 8000) {
  if (enabledSessions.has(ses)) return true;
  try {
    const blocker = await Promise.race([
      getBlocker(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('temps esgotat')), timeoutMs))
    ]);
    if (!enabledSessions.has(ses)) { blocker.enableBlockingInSession(ses); enabledSessions.add(ses); }
    return true;
  } catch (err) {
    console.warn('[adblock] no s\'ha pogut activar:', err.message);
    // Si ha estat per temps, l'activem igualment quan acabi de carregar
    getBlocker().then((b) => { if (!enabledSessions.has(ses) && ses.__mhWantsAdblock) { b.enableBlockingInSession(ses); enabledSessions.add(ses); } }).catch(() => {});
    return false;
  }
}

async function disable(ses) {
  if (!enabledSessions.has(ses)) return;
  try { (await getBlocker()).disableBlockingInSession(ses); } catch { /* ignora */ }
  enabledSessions.delete(ses);
}

module.exports = { enable, disable, isEnabled: (ses) => enabledSessions.has(ses) };
