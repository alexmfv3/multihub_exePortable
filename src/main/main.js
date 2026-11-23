const path = require('path');
const crypto = require('crypto');
const {
  app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, Tray, nativeImage, dialog, clipboard
} = require('electron');
const Store = require('./store');
const CATALOG = require('./catalog');
const { ExtensionManager } = require('./extensions');
const { Icons } = require('./icons');
const Lock = require('./lock');
const Downloads = require('./downloads');
const { enableScreenShare } = require('./screen-picker');
const adblock = require('./adblock');

const DEV = process.argv.includes('--dev');
const SIDEBAR = 72;
const TOOLBAR = 44;
const ASSETS = path.join(__dirname, '..', '..', 'assets');

// ── Identitat del navegador (User-Agent) ─────────────────────────────────────
// Sense "Electron/x": WhatsApp Web, Discord i d'altres rebutgen navegadors que no semblen Chrome.
// Per als inicis de sessió de Google ens presentem com a Firefox (vegeu identity.js).
const identity = require('./identity')({ isEnabled: () => store?.data.settings.googleLoginCompat !== false });
const { CHROME_UA } = identity;
app.userAgentFallback = CHROME_UA;

// Perquè les trucades i les notificacions funcionin encara que el servei no estigui a la vista:
// sense "adormir" la pàgina en segon pla i amb so automàtic (to de trucada entrant).
const CALL_PREFS = { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' };

const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'pointerLock', 'mediaKeySystem', 'speaker-selection', 'display-capture'
]);

// Dominis on s'obren finestres emergents DINS l'app (inicis de sessió, OAuth...)
const AUTH_HOSTS = [
  'accounts.google.com', 'login.live.com', 'login.microsoftonline.com', 'login.yahoo.com',
  'appleid.apple.com', 'discord.com', 'auth.openai.com', 'www.facebook.com', 'm.facebook.com'
];

// ── Mode portable ───────────────────────────────────────────────────────────
// Totes les dades (comptes, sessions, cookies, extensions) es desen a la carpeta
// "MultiHub-dades" que hi ha al costat de l'executable. Així es pot portar en un USB.
//  · .exe portable  → electron-builder defineix PORTABLE_EXECUTABLE_DIR
//  · versió .zip    → carpeta de l'executable
//  · npm start      → només si es crea un fitxer "portable.txt" a l'arrel del projecte
(function setupPortable() {
  const fs = require('fs');
  let base = process.env.PORTABLE_EXECUTABLE_DIR || null;
  if (!base && app.isPackaged) base = path.dirname(process.execPath);
  if (!base && fs.existsSync(path.join(__dirname, '..', '..', 'portable.txt'))) base = path.join(__dirname, '..', '..');
  if (!base) return;
  const dataDir = path.join(base, 'MultiHub-dades');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    console.warn('No es pot escriure al costat de l\'executable; s\'usarà la carpeta d\'usuari.');
    return;
  }
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
  app.setPath('crashDumps', path.join(dataDir, 'crashes'));
  app.setAppLogsPath(path.join(dataDir, 'logs'));
})();

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let store, extensions, icons, lock, downloads, win, tray;
let servicesStarted = false;
const views = new Map(); // serviceId -> { view, badge, favicon, title, loading, crashed }
let overlay = false;
let quitting = false;

// ── Utilitats ───────────────────────────────────────────────────────────────
const baseDomain = (host) => {
  const parts = host.split('.');
  const two = parts.slice(-2).join('.');
  return /^(co|com|org|net|gov|edu)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
};
const safeUrl = (u) => { try { return new URL(u); } catch { return null; } };
const service = (id) => store.data.services.find(s => s.id === id);

function state() {
  if (lock.locked) return { lock: lock.publicState(), services: [], groups: [], extensions: [], catalog: [], downloads: [], settings: store.data.settings, activeId: null };
  return {
    services: store.data.services.map(s => {
      const v = views.get(s.id) || {};
      const cat = CATALOG.find(c => c.type === s.type) || {};
      return { ...s, color: cat.color, badge: v.badge || 0, icon: icons.get(icons.keyFor(s)),
        loading: !!v.loading, crashed: !!v.crashed };
    }),
    groups: store.data.groups,
    lock: lock.publicState(),
    downloads: downloads.view(),
    activeId: store.data.activeId,
    catalog: CATALOG.map(c => ({ ...c, icon: icons.get(icons.keyFor({ type: c.type, url: c.url })) })),
    extensions: extensions.describe(),
    settings: store.data.settings
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state());
  updateBadge();
}

function updateBadge() {
  const total = [...views.values()].reduce((a, v) => a + (v.badge || 0), 0);
  if (!win || win.isDestroyed()) return;
  const act = !lock.locked && service(store.data.activeId);
  win.setTitle(`${total ? `(${total}) ` : ''}${act ? `${act.name} — ` : ''}MultiHub`);
  // Número a la icona de la barra de tasques i de la safata: 1…9 o "+9"
  const label = total > 9 ? '9plus' : String(total);
  const desc = total ? `${total} missatge${total > 1 ? 's' : ''} sense llegir` : '';
  if (process.platform !== 'win32') app.setBadgeCount(total);
  else win.setOverlayIcon(total ? nativeImage.createFromPath(path.join(ASSETS, 'badges', `badge-${label}.png`)) : null, desc);
  if (tray && tray.__mhBadge !== label) {
    tray.__mhBadge = label;
    tray.setImage(nativeImage.createFromPath(path.join(ASSETS, total ? path.join('badges', `tray-${label}.png`) : 'tray.png')));
  }
  tray?.setToolTip(total ? `MultiHub — ${desc}` : 'MultiHub');
}

function parseBadge(title) {
  // "(3) WhatsApp", "Safata d'entrada (12) - x@gmail.com", "• Discord" ...
  const m = /\((\d+)\+?\)/.exec(title || '');
  if (m) return parseInt(m[1], 10);
  if (/^[•●]\s/.test(title || '')) return 1;
  return 0;
}

// ── Sessions de servei ──────────────────────────────────────────────────────
function prepareSession(ses) {
  if (ses.__multihub) return;
  ses.__multihub = true;
  ses.setUserAgent(CHROME_UA);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMISSIONS.has(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ALLOWED_PERMISSIONS.has(perm));
  enableScreenShare(ses, () => win); // compartir pantalla a les trucades
  downloads.attach(ses);
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    identity.rewriteHeaders(d, ses);
    cb({ requestHeaders: d.requestHeaders });
  });
  const preload = path.join(__dirname, '..', 'preload', 'service-preload.js');
  if (typeof ses.registerPreloadScript === 'function') ses.registerPreloadScript({ type: 'frame', filePath: preload });
  else ses.setPreloads([...ses.getPreloads(), preload]);
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const bounds = { x: SIDEBAR, y: TOOLBAR, width: Math.max(0, w - SIDEBAR), height: Math.max(0, h - TOOLBAR) };
  for (const [id, v] of views) {
    v.view.setBounds(bounds);
    v.view.setVisible(!overlay && !lock.locked && id === store.data.activeId);
  }
}

async function createView(svc) {
  if (views.has(svc.id) || !svc.enabled) return;
  const entry = { view: null, badge: 0, loading: true, crashed: false };
  views.set(svc.id, entry);

  const ses = session.fromPartition(`persist:service-${svc.id}`);
  ses.__mhServiceId = svc.id;
  ses.__mhPartition = `persist:service-${svc.id}`;
  prepareSession(ses);
  ses.__mhWantsAdblock = wantsAdblock(svc);
  if (ses.__mhWantsAdblock) await adblock.enable(ses); // abans de carregar la web
  await extensions.registerSession(svc.id, ses); // ⟵ extensions abans de carregar la web

  const view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, spellcheck: true, ...CALL_PREFS }
  });
  entry.view = view;
  const wc = view.webContents;
  identity.forService(wc, ses, svc.url); // abans de carregar res
  wc.setAudioMuted(!!svc.muted);
  win.contentView.addChildView(view);
  layout();

  wc.on('page-title-updated', (_e, title) => {
    entry.title = title; const b = parseBadge(title);
    if (b !== entry.badge) { entry.badge = b; broadcast(); }
  });
  wc.on('did-start-loading', () => { entry.loading = true; broadcast(); });
  wc.on('did-stop-loading', () => { entry.loading = false; broadcast(); });
  wc.on('did-finish-load', () => wc.setZoomFactor(service(svc.id)?.zoom || 1));
  wc.on('render-process-gone', () => { entry.crashed = true; broadcast(); });

  wc.setWindowOpenHandler(({ url }) => {
    const u = safeUrl(url);
    const cur = safeUrl(wc.getURL());
    const popupWin = (extra = {}) => ({ action: 'allow', overrideBrowserWindowOptions: {
      autoHideMenuBar: true, ...extra, webPreferences: { session: ses, contextIsolation: true, sandbox: true, ...CALL_PREFS } } });
    // Les trucades de WhatsApp Web s'obren en una finestra a part (about:blank o del mateix domini)
    if (!u || url === 'about:blank') return popupWin({ width: 900, height: 650 });
    if (!/^https?:$/.test(u.protocol)) return { action: 'deny' };
    const inApp = AUTH_HOSTS.includes(u.hostname) || (cur && baseDomain(u.hostname) === baseDomain(cur.hostname));
    if (inApp) identity.notePopup(url);
    if (inApp) return popupWin({ width: 1000, height: 750 });
    shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ label: 'Afegeix al diccionari', click: () => ses.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    if (p.linkURL) items.push(
      { label: 'Obre l\'enllaç al navegador', click: () => shell.openExternal(p.linkURL) },
      { label: 'Copia l\'enllaç', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    if (p.isEditable) items.push({ role: 'undo', label: 'Desfés' }, { role: 'redo', label: 'Refés' }, { type: 'separator' },
      { role: 'cut', label: 'Retalla' }, { role: 'copy', label: 'Copia' }, { role: 'paste', label: 'Enganxa' }, { role: 'selectAll', label: 'Selecciona-ho tot' });
    else if (p.selectionText) items.push({ role: 'copy', label: 'Copia' });
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Enrere', enabled: wc.navigationHistory?.canGoBack?.() ?? wc.canGoBack(), click: () => goBack(wc) },
      { label: 'Recarrega', click: () => wc.reload() },
      { label: 'Inspecciona', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  wc.loadURL(svc.url);
}

function destroyView(id) {
  const v = views.get(id);
  if (!v) return;
  if (v.view) {
    win.contentView.removeChildView(v.view);
    v.view.webContents.close();
  }
  extensions.unregisterSession(id);
  views.delete(id);
}

const goBack = (wc) => (wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack());
const goForward = (wc) => (wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward());

function activate(id) {
  if (!service(id)) return;
  store.data.activeId = id; store.save();
  layout();
  views.get(id)?.view?.webContents.focus();
  broadcast();
}

function activeWC() { return views.get(store.data.activeId)?.view?.webContents || null; }

function serviceAction(id, action) {
  const svc = service(id); const wc = views.get(id)?.view?.webContents;
  if (!svc || lock.locked) return;
  switch (action) {
    case 'reload': if (views.get(id)?.crashed) { destroyView(id); createView(svc).then(broadcast); } else wc?.reload(); break;
    case 'back': wc && goBack(wc); break;
    case 'forward': wc && goForward(wc); break;
    case 'home': wc?.loadURL(svc.url); break;
    case 'devtools': wc?.openDevTools({ mode: 'detach' }); break;
    case 'zoomIn': case 'zoomOut': case 'zoomReset': {
      const z = action === 'zoomReset' ? 1 : Math.min(3, Math.max(0.3, (svc.zoom || 1) + (action === 'zoomIn' ? 0.1 : -0.1)));
      svc.zoom = Math.round(z * 10) / 10; wc?.setZoomFactor(svc.zoom); store.save(); break;
    }
    case 'mute': setSound(svc, { muted: !svc.muted }); break;
    case 'adblock': svc.adblock = svc.adblock === false; store.save(); applyAdblock(svc).then(() => wc?.reload()); broadcast(); break;
    case 'notifications': setSound(svc, { notifications: svc.notifications === false }); break;
    case 'clearCache': session.fromPartition(`persist:service-${id}`).clearCache().then(() => wc?.reload()); break;
  }
}

function cycle(dir) {
  const list = store.data.services.filter(s => s.enabled);
  if (!list.length) return;
  const i = list.findIndex(s => s.id === store.data.activeId);
  activate(list[(i + dir + list.length) % list.length].id);
}

// ── Finestra principal ──────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 850, minWidth: 700, minHeight: 450,
    title: 'MultiHub', backgroundColor: '#1e1f26', autoHideMenuBar: true,
    icon: path.join(ASSETS, 'icon.png'), show: !store.data.settings.startMinimized,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'app-preload.js'), contextIsolation: true, sandbox: true }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('resize', layout);
  win.on('close', (e) => {
    if (!quitting && store.data.settings.closeToTray && tray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('MultiHub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostra MultiHub', click: () => { win.show(); win.focus(); } },
    { label: 'Bloqueja', click: () => lock.lock() },
    { type: 'separator' },
    { label: 'Surt', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : (win.show(), win.focus())));
}

function buildMenu() {
  const ui = (what) => () => win.webContents.send('ui:open', what);
  const act = (a) => () => store.data.activeId && serviceAction(store.data.activeId, a);
  const numbers = Array.from({ length: 9 }, (_, i) => ({
    label: `Servei ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, visible: false,
    click: () => { const l = store.data.services.filter(s => s.enabled); if (l[i]) activate(l[i].id); }
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'MultiHub', submenu: [
      { label: 'Afegeix un servei…', accelerator: 'CmdOrCtrl+N', click: ui('add') },
      { label: 'Extensions…', accelerator: 'CmdOrCtrl+E', click: ui('extensions') },
      { label: 'Descàrregues…', accelerator: 'CmdOrCtrl+J', click: ui('downloads') },
      { label: 'Bloqueja', accelerator: 'CmdOrCtrl+L', click: () => { if (lock.enabled) lock.lock(); else win.webContents.send('ui:open', 'settings'); } },
      { label: 'Configuració…', accelerator: 'CmdOrCtrl+,', click: ui('settings') },
      { type: 'separator' },
      { label: 'Surt', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }
    ] },
    { label: 'Edita', submenu: [
      { role: 'undo', label: 'Desfés' }, { role: 'redo', label: 'Refés' }, { type: 'separator' },
      { role: 'cut', label: 'Retalla' }, { role: 'copy', label: 'Copia' }, { role: 'paste', label: 'Enganxa' },
      { role: 'selectAll', label: 'Selecciona-ho tot' }
    ] },
    { label: 'Servei', submenu: [
      { label: 'Recarrega', accelerator: 'CmdOrCtrl+R', click: act('reload') },
      { label: 'Recarrega (F5)', accelerator: 'F5', visible: false, click: act('reload') },
      { label: 'Enrere', accelerator: 'Alt+Left', click: act('back') },
      { label: 'Endavant', accelerator: 'Alt+Right', click: act('forward') },
      { label: 'Pàgina inicial', accelerator: 'Alt+Home', click: act('home') },
      { type: 'separator' },
      { label: 'Amplia', accelerator: 'CmdOrCtrl+=', click: act('zoomIn') },
      { label: 'Amplia (+)', accelerator: 'CmdOrCtrl+Plus', visible: false, click: act('zoomIn') },
      { label: 'Redueix', accelerator: 'CmdOrCtrl+-', click: act('zoomOut') },
      { label: 'Mida real', accelerator: 'CmdOrCtrl+0', click: act('zoomReset') },
      { type: 'separator' },
      { label: 'Silencia / activa el so', accelerator: 'CmdOrCtrl+Shift+M', click: act('mute') },
      { label: 'Eines de desenvolupament del servei', accelerator: 'CmdOrCtrl+Shift+I', click: act('devtools') },
      { label: 'Eines de desenvolupament de MultiHub', accelerator: 'CmdOrCtrl+Alt+I', click: () => win.webContents.openDevTools({ mode: 'detach' }) }
    ] },
    { label: 'Finestra', submenu: [
      { label: 'Servei següent', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
      { label: 'Servei anterior', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
      ...numbers
    ] }
  ]));
}

// ── Bloquejador d'anuncis ───────────────────────────────────────────────────
function wantsAdblock(svc) { return store.data.settings.adblock !== false && svc.adblock !== false; }
async function applyAdblock(svc) {
  const ses = session.fromPartition(`persist:service-${svc.id}`);
  ses.__mhWantsAdblock = wantsAdblock(svc);
  if (ses.__mhWantsAdblock) await adblock.enable(ses, 30000); else await adblock.disable(ses);
}

// ── So i notificacions per servei ────────────────────────────────────────────
// "Silencia": cap so de la pàgina (missatges, to de trucada...) i notificacions de Windows mudes.
//   Les finestres de trucada ja obertes continuen tenint so.
// "Mostra notificacions" desactivat: no surt cap notificació d'aquell servei.
function soundFlags(svc) {
  return { silent: !!svc?.muted, notify: svc ? svc.notifications !== false : true };
}
function setSound(svc, patch) {
  if ('muted' in patch) svc.muted = !!patch.muted;
  if ('notifications' in patch) svc.notifications = !!patch.notifications;
  views.get(svc.id)?.view?.webContents.setAudioMuted(!!svc.muted);
  const ses = session.fromPartition(`persist:service-${svc.id}`);
  for (const wc of require('electron').webContents.getAllWebContents()) {
    if (wc.session === ses && !wc.isDestroyed()) wc.send('mh:flags', soundFlags(svc));
  }
  store.save(); broadcast();
}

// ── Grups ───────────────────────────────────────────────────────────────────
function createGroup(name) {
  const g = { id: crypto.randomUUID(), name: String(name || 'Grup').trim().slice(0, 40) || 'Grup', collapsed: false };
  store.data.groups.push(g); store.save();
  return g;
}
function setGroup(serviceId, groupId) {
  const svc = service(serviceId); if (!svc) return;
  if (groupId && store.data.groups.some(g => g.id === groupId)) {
    svc.groupId = groupId;
    // El servei es col·loca just després de l'últim membre del grup, perquè quedin junts
    const list = store.data.services;
    list.splice(list.indexOf(svc), 1);
    const lastIdx = list.map(s => s.groupId).lastIndexOf(groupId);
    list.splice(lastIdx >= 0 ? lastIdx + 1 : list.length, 0, svc);
  } else delete svc.groupId;
  pruneGroups(); store.save(); broadcast();
}
// Mou un servei o un grup sencer (bloc de serveis) a una nova posició de la barra lateral.
// target: { kind: 'service'|'group'|'end', id, position: 'before'|'after'|'into' }
function moveInSidebar(drag, target) {
  const list = store.data.services;
  const block = drag.kind === 'group' ? list.filter(s => s.groupId === drag.id) : list.filter(s => s.id === drag.id);
  if (!block.length) return;
  const rest = list.filter(s => !block.includes(s));
  const groupBlock = (gid) => rest.filter(s => s.groupId === gid);
  let idx, newGroup = null;

  if (target.kind === 'end') {
    idx = rest.length;
  } else if (target.kind === 'group') {
    const members = groupBlock(target.id);
    if (!members.length) return;
    if (target.position === 'into' && drag.kind === 'service') {
      idx = rest.indexOf(members[members.length - 1]) + 1; newGroup = target.id;
    } else {
      idx = target.position === 'after' ? rest.indexOf(members[members.length - 1]) + 1 : rest.indexOf(members[0]);
    }
  } else {
    const t = rest.find(s => s.id === target.id);
    if (!t) return;
    if (drag.kind === 'group' && t.groupId) {
      // Un grup no pot anar dins d'un altre: es col·loca abans/després del grup on és el destí
      const members = groupBlock(t.groupId);
      idx = target.position === 'after' ? rest.indexOf(members[members.length - 1]) + 1 : rest.indexOf(members[0]);
    } else {
      idx = rest.indexOf(t) + (target.position === 'after' ? 1 : 0);
      newGroup = t.groupId || null; // posar-lo entre membres d'un grup el fica al grup
    }
  }

  rest.splice(idx, 0, ...block);
  if (drag.kind === 'service') { if (newGroup) block[0].groupId = newGroup; else delete block[0].groupId; }
  store.data.services = rest;
  pruneGroups(); store.save(); broadcast();
}

function pruneGroups() {
  const used = new Set(store.data.services.map(s => s.groupId).filter(Boolean));
  store.data.groups = store.data.groups.filter(g => used.has(g.id));
}

async function startServices() {
  if (servicesStarted) return;
  servicesStarted = true;
  for (const svc of store.data.services) if (svc.enabled) await createView(svc);
  if (!service(store.data.activeId)) store.data.activeId = store.data.services.find(s => s.enabled)?.id || null;
  layout(); broadcast();
}

async function chooseIcon(id) {
  const svc = service(id); if (!svc) return;
  const r = await dialog.showOpenDialog(win, { title: 'Tria una imatge per a la icona', properties: ['openFile'],
    filters: [{ name: 'Imatges', extensions: ['png', 'jpg', 'jpeg', 'svg', 'ico', 'webp', 'gif'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  try { icons.setCustom(svc, r.filePaths[0]); svc.customIcon = true; store.save(); broadcast(); }
  catch (err) { dialog.showErrorBox('Icona', err.message); }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
const ALLOWED_WHILE_LOCKED = new Set(['state:get', 'lock:unlock']);
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (lock.locked && !ALLOWED_WHILE_LOCKED.has(channel)) return { ok: false, error: 'MultiHub està bloquejat' };
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { console.error(channel, err); return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  // Preload de servei: demana l'estat de so/notificacions de la seva pestanya
  ipcMain.on('mh:flags', (e) => { e.returnValue = soundFlags(service(e.sender.session?.__mhServiceId)); });
  // Clic en una notificació: mostra MultiHub i obre aquell servei
  ipcMain.on('mh:notification-click', (e) => {
    const id = e.sender.session?.__mhServiceId;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (id && !lock.locked) activate(id);
  });

  handle('state:get', () => state());

  handle('service:add', async ({ type, name, url, groupId, newGroup }) => {
    const cat = CATALOG.find(c => c.type === type);
    if (!cat) throw new Error('Tipus de servei desconegut');
    const finalUrl = (url || cat.url || '').trim();
    const u = safeUrl(finalUrl);
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error('Cal una URL vàlida (https://...)');
    const count = store.data.services.filter(s => s.type === type).length;
    const svc = {
      id: crypto.randomUUID(), type, url: u.toString(), enabled: true, muted: false, zoom: 1,
      name: (name || '').trim() || (count ? `${cat.name} ${count + 1}` : cat.name)
    };
    if (newGroup && String(newGroup).trim()) groupId = createGroup(String(newGroup).trim()).id;
    if (groupId && store.data.groups.some(g => g.id === groupId)) svc.groupId = groupId;
    store.data.services.push(svc); store.save();
    await createView(svc);
    activate(svc.id);
    return svc;
  });

  handle('service:update', async (id, patch) => {
    const svc = service(id); if (!svc) return;
    const allowed = ['name', 'url', 'enabled', 'muted'];
    for (const k of allowed) if (k in patch) svc[k] = patch[k];
    if ('url' in patch) { const u = safeUrl(svc.url); if (!u) throw new Error('URL no vàlida'); svc.url = u.toString(); }
    store.save();
    if ('enabled' in patch) { if (svc.enabled) await createView(svc); else destroyView(id); }
    if ('muted' in patch) setSound(svc, {});
    if ('url' in patch) views.get(id)?.view?.webContents.loadURL(svc.url);
    layout(); broadcast();
  });

  handle('service:remove', async (id) => {
    destroyView(id);
    store.data.services = store.data.services.filter(s => s.id !== id);
    for (const e of store.data.extensions) e.excluded = (e.excluded || []).filter(x => x !== id);
    if (store.data.activeId === id) store.data.activeId = store.data.services.find(s => s.enabled)?.id || null;
    pruneGroups();
    store.save();
    // Esborra cookies i dades de la sessió eliminada
    session.fromPartition(`persist:service-${id}`).clearStorageData().catch(() => {});
    layout(); broadcast();
  });

  handle('service:reorder', (ids) => {
    const map = new Map(store.data.services.map(s => [s.id, s]));
    store.data.services = ids.map(i => map.get(i)).filter(Boolean)
      .concat(store.data.services.filter(s => !ids.includes(s.id)));
    store.save(); broadcast();
  });

  handle('service:activate', (id) => activate(id));
  handle('service:action', (id, action) => serviceAction(id, action));

  handle('service:contextMenu', (id) => {
    const svc = service(id); if (!svc) return;
    Menu.buildFromTemplate([
      { label: svc.name, enabled: false }, { type: 'separator' },
      { label: 'Recarrega', click: () => serviceAction(id, 'reload') },
      { label: 'Silencia (sense sons ni avisos sonors)', type: 'checkbox', checked: !!svc.muted, click: () => serviceAction(id, 'mute') },
      { label: 'Bloqueja anuncis', type: 'checkbox', enabled: store.data.settings.adblock !== false, checked: wantsAdblock(svc), click: () => serviceAction(id, 'adblock') },
      { label: 'Mostra notificacions', type: 'checkbox', checked: svc.notifications !== false, click: () => serviceAction(id, 'notifications') },
      { label: 'Edita…', click: () => win.webContents.send('ui:open', 'edit', id) },
      { label: 'Mou al grup', submenu: [
        ...store.data.groups.map(g => ({ label: g.name, type: 'radio', checked: svc.groupId === g.id, click: () => setGroup(id, g.id) })),
        ...(store.data.groups.length ? [{ type: 'separator' }] : []),
        { label: 'Nou grup…', click: () => win.webContents.send('ui:open', 'newGroup', id) },
        { label: 'Sense grup', enabled: !!svc.groupId, click: () => setGroup(id, null) }
      ] },
      { label: svc.enabled ? 'Desactiva (allibera memòria)' : 'Activa', click: async () => {
        svc.enabled = !svc.enabled; store.save();
        if (svc.enabled) await createView(svc); else destroyView(id);
        layout(); broadcast();
      } },
      { label: 'Canvia la icona…', click: () => chooseIcon(id) },
      ...(svc.customIcon ? [{ label: 'Restableix la icona original', click: () => { icons.removeCustom(svc); svc.customIcon = false; store.save(); broadcast(); } }]
        : [{ label: 'Torna a descarregar la icona', click: () => icons.refresh(svc) }]),
      { label: 'Buida la memòria cau', click: () => serviceAction(id, 'clearCache') },
      { label: 'Eines de desenvolupament', click: () => serviceAction(id, 'devtools') },
      { type: 'separator' },
      { label: 'Elimina…', click: () => win.webContents.send('ui:open', 'remove', id) }
    ]).popup({ window: win });
  });

  handle('ui:overlay', (on) => { overlay = !!on; layout(); });

  // Grups
  handle('group:create', (name, serviceId) => { const g = createGroup(name); if (serviceId) setGroup(serviceId, g.id); else broadcast(); return g; });
  handle('group:update', (id, patch) => {
    const g = store.data.groups.find(x => x.id === id); if (!g) return;
    if ('name' in patch && String(patch.name).trim()) g.name = String(patch.name).trim().slice(0, 40);
    if ('collapsed' in patch) g.collapsed = !!patch.collapsed;
    store.save(); broadcast();
  });
  handle('group:contextMenu', (id) => {
    const g = store.data.groups.find(x => x.id === id); if (!g) return;
    Menu.buildFromTemplate([
      { label: g.name, enabled: false }, { type: 'separator' },
      { label: g.collapsed ? 'Desplega' : 'Plega', click: () => { g.collapsed = !g.collapsed; store.save(); broadcast(); } },
      { label: 'Reanomena…', click: () => win.webContents.send('ui:open', 'renameGroup', id) },
      { label: 'Silencia tots els serveis del grup', click: () => {
        for (const s of store.data.services.filter(x => x.groupId === id)) setSound(s, { muted: true });
      } },
      { label: 'Treu el silenci a tots els serveis del grup', click: () => {
        for (const s of store.data.services.filter(x => x.groupId === id)) setSound(s, { muted: false });
      } },
      { type: 'separator' },
      { label: 'Desfés el grup (els serveis es mantenen)', click: () => {
        for (const s of store.data.services) if (s.groupId === id) delete s.groupId;
        store.data.groups = store.data.groups.filter(x => x.id !== id);
        store.save(); broadcast();
      } }
    ]).popup({ window: win });
  });
  handle('service:setGroup', (id, groupId) => setGroup(id, groupId));
  handle('sidebar:move', (drag, target) => moveInSidebar(drag, target));

  // Bloqueig
  handle('lock:unlock', async (pw) => {
    const ok = await lock.unlock(pw);
    if (ok) await startServices();
    return ok;
  });
  handle('lock:lock', () => lock.lock());
  handle('lock:setPassword', (newPw, currentPw) => lock.setPassword(newPw, currentPw));
  handle('lock:disable', (currentPw) => lock.disable(currentPw));
  handle('lock:options', (opts) => lock.setOptions(opts));

  // Descàrregues
  handle('downloads:action', (id, act) => downloads.action(id, act));
  handle('downloads:clear', () => downloads.clearFinished());
  handle('downloads:openDir', () => shell.openPath(downloads.dir));
  handle('downloads:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Carpeta de descàrregues', defaultPath: downloads.dir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.data.settings.downloadDir = r.filePaths[0]; store.save(); broadcast();
    return r.filePaths[0];
  });

  handle('settings:update', async (patch) => {
    Object.assign(store.data.settings, patch); store.save(); broadcast();
    if ('adblock' in patch) for (const svc of store.data.services) {
      if (!views.has(svc.id)) continue;
      await applyAdblock(svc); views.get(svc.id)?.view?.webContents.reload();
    }
  });

  // Extensions
  handle('ext:installStore', (input) => extensions.installFromWebStore(input));
  handle('ext:installCrx', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Tria un fitxer .crx o .zip', properties: ['openFile'],
      filters: [{ name: 'Extensions', extensions: ['crx', 'zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0].toLowerCase().endsWith('.zip') ? extensions.installZipFile(r.filePaths[0]) : extensions.installCrxFile(r.filePaths[0]);
  });
  handle('ext:installUnpacked', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Tria la carpeta de l\'extensió (on hi ha manifest.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return extensions.installUnpacked(r.filePaths[0]);
  });
  handle('ext:remove', (key) => extensions.remove(key));
  handle('ext:update', (key) => extensions.update(key));
  handle('ext:toggle', (key, on) => extensions.setEnabled(key, on));
  handle('ext:exclude', (key, serviceId, excluded) => extensions.setExcluded(key, serviceId, excluded));
  handle('ext:options', (key) => extensions.openOptions(key, win));
  handle('ext:popup', (key, rect) => {
    const cb = win.getContentBounds();
    extensions.openPopup(key, { x: cb.x + rect.right, y: cb.y + rect.bottom + 4 }, win);
  });
  handle('ext:openWebStore', () => shell.openExternal('https://chromewebstore.google.com/'));
}

// ── Arrencada ───────────────────────────────────────────────────────────────
app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; store?.flush(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => win?.show());

// Qualsevol finestra que no sigui un servei ni un popup: enllaços externs al navegador
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault()); // no permetem <webview> arbitraris
  // S'aplica a les vistes de servei i també a les finestres emergents que obren
  // (p. ex. "Continua amb Google" de Claude), que comparteixen la mateixa sessió.
  if (wc.session?.__multihub && wc.getType() !== 'backgroundPage') identity.attach(wc);
});

app.whenReady().then(async () => {
  store = new Store();
  if (!Array.isArray(store.data.groups)) store.data.groups = [];
  icons = new Icons(() => broadcast());
  lock = new Lock(store, () => {
    if (lock.locked) overlay = false; // en desbloquejar, el servei actiu torna a ser visible
    layout(); broadcast();
    if (lock.locked) { extensions?.popup?.isDestroyed?.() === false && extensions.popup.close(); }
  });
  downloads = new Downloads(store, {
    serviceName: (ses) => service(ses.__mhServiceId)?.name || 'MultiHub',
    onChange: () => broadcast(),
    onProgress: (list) => { if (!lock.locked && win && !win.isDestroyed()) win.webContents.send('downloads', list); },
    isLocked: () => lock.locked
  });
  extensions = new ExtensionManager(store, () => broadcast());
  prepareSession(extensions.host);
  await extensions.init();

  createWindow();
  buildMenu();
  try { createTray(); } catch (err) { console.warn('Sense safata del sistema:', err.message); }
  registerIpc();

  // Amb contrasenya mestra, els serveis no es carreguen fins que es desbloqueja
  if (!lock.locked) await startServices();
  else { layout(); broadcast(); }
});
