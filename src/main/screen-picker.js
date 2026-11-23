// Selector de pantalla/finestra per compartir pantalla (getDisplayMedia) en trucades de
// WhatsApp Web, Discord, Google Meet... Electron no en porta cap per defecte a Windows.
const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');

let open = null;

async function pickSource(parent) {
  if (open) { open.focus(); return null; }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false
  });
  const items = sources
    .filter(s => !/^MultiHub/.test(s.name) || s.id.startsWith('screen'))
    .map(s => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen'), thumb: s.thumbnail.toDataURL() }));

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent, modal: !!parent, width: 760, height: 560, title: 'Comparteix la pantalla', autoHideMenuBar: true,
      backgroundColor: '#1e1f26', minimizable: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'picker-preload.js'), contextIsolation: true, sandbox: true }
    });
    open = win;
    let done = false;
    const finish = (id) => {
      if (done) return; done = true;
      ipcMain.removeListener('picker:choose', onChoose);
      open = null;
      resolve(id ? sources.find(s => s.id === id) || null : null);
      if (!win.isDestroyed()) win.close();
    };
    const onChoose = (e, id) => { if (e.sender === win.webContents) finish(id); };
    ipcMain.on('picker:choose', onChoose);
    win.on('closed', () => finish(null));
    win.webContents.once('did-finish-load', () => win.webContents.send('picker:sources', items));
    win.loadFile(path.join(__dirname, '..', 'renderer', 'picker.html'));
  });
}

/** Activa getDisplayMedia a una sessió de servei. */
function enableScreenShare(ses, getParent) {
  if (typeof ses.setDisplayMediaRequestHandler !== 'function') return;
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const source = await pickSource(getParent());
      if (!source) return callback({}); // cancel·lat
      // A Windows es pot enviar també el so del sistema
      callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      callback({});
    }
  });
}

module.exports = { enableScreenShare };
