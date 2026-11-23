// ─────────────────────────────────────────────────────────────────────────────
// Gestor d'extensions — la peça central de MultiHub.
//
// Cada extensió instal·lada es desa UNA vegada a  <userData>/extensions/<clau>/
// i es carrega a:
//   1) Una sessió "amfitriona" compartida (persist:multihub-extensions). Aquí és on
//      s'obren els popups de la barra d'eines i les pàgines d'opcions, de manera que
//      l'emmagatzematge de l'extensió (chrome.storage) és el MATEIX per a tots els
//      serveis. Exemple: els codis d'Authenticator es veuen des de qualsevol compte.
//   2) La sessió de CADA servei (WhatsApp 1, WhatsApp 2, Gmail...), perquè els
//      content scripts de l'extensió s'executin dins de cada web.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, session, net, BrowserWindow, screen } = require('electron');
const AdmZip = require('adm-zip');
const { parseCrx } = require('./crx');

const HOST_PARTITION = 'persist:multihub-extensions';
const extApi = (ses) => ses.extensions || ses; // Electron ≥36 mou l'API a session.extensions

function readJson(file) {
  // Algunes extensions tenen BOM o comentaris al manifest
  const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try { return JSON.parse(txt); }
  catch { return JSON.parse(txt.replace(/^\s*\/\/.*$/gm, '')); }
}

function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
  if (subs.length === 1) return findManifestRoot(path.join(dir, subs[0].name));
  return null;
}

function rmrf(p) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return; }
    catch { /* Windows pot tenir el fitxer bloquejat un moment */ }
  }
}

class ExtensionManager {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange || (() => {});
    this.root = path.join(app.getPath('userData'), 'extensions');
    fs.mkdirSync(this.root, { recursive: true });
    this.host = session.fromPartition(HOST_PARTITION);
    this.sessions = new Map(); // serviceId -> Session
    this.ids = new Map();      // clau -> ID d'Electron (chrome-extension://ID)
    this.popup = null;
  }

  get list() { return this.store.data.extensions; }
  find(key) { return this.list.find(e => e.key === key); }
  dirOf(meta) { return path.join(this.root, meta.dir); }

  // ── Càrrega a sessions ────────────────────────────────────────────────────
  async _load(ses, meta) {
    const dir = this.dirOf(meta);
    const api = extApi(ses);
    const already = api.getAllExtensions().find(e => path.resolve(e.path) === path.resolve(dir));
    if (already) return already;
    try {
      return await api.loadExtension(dir, { allowFileAccess: true });
    } catch (err) {
      console.error(`[ext] No s'ha pogut carregar ${meta.name}:`, err.message);
      return null;
    }
  }

  _unload(ses, meta) {
    const dir = path.resolve(this.dirOf(meta));
    const api = extApi(ses);
    for (const e of api.getAllExtensions()) {
      if (path.resolve(e.path) === dir) api.removeExtension(e.id);
    }
  }

  async init() {
    for (const meta of this.list) {
      if (!fs.existsSync(this.dirOf(meta))) continue;
      const ext = await this._load(this.host, meta);
      if (ext) this.ids.set(meta.key, ext.id);
    }
  }

  /** S'ha de cridar ABANS de carregar la URL del servei (perquè s'injectin els content scripts). */
  async registerSession(serviceId, ses) {
    this.sessions.set(serviceId, ses);
    for (const meta of this.list) {
      if (meta.enabled && !meta.excluded?.includes(serviceId)) await this._load(ses, meta);
    }
  }

  unregisterSession(serviceId) {
    const ses = this.sessions.get(serviceId);
    if (!ses) return;
    for (const meta of this.list) this._unload(ses, meta);
    this.sessions.delete(serviceId);
  }

  async _applyEverywhere(meta) {
    for (const [serviceId, ses] of this.sessions) {
      const should = meta.enabled && !meta.excluded?.includes(serviceId);
      if (should) await this._load(ses, meta); else this._unload(ses, meta);
    }
  }

  // ── Instal·lació ──────────────────────────────────────────────────────────
  async installFromWebStore(input) {
    const m = String(input).match(/([a-p]{32})/);
    if (!m) throw new Error('No he trobat cap ID d\'extensió vàlid (32 lletres a-p) a l\'enllaç.');
    const id = m[1];
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect'
      + `&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`La Chrome Web Store ha respost ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('No s\'ha pogut descarregar l\'extensió (potser ja no existeix).');
    return this._installCrxBuffer(buf, { source: 'webstore', storeId: id });
  }

  async installCrxFile(file) {
    return this._installCrxBuffer(fs.readFileSync(file), { source: 'crx' });
  }

  async installZipFile(file) {
    return this._installCrxBuffer(fs.readFileSync(file), { source: 'zip' });
  }

  async installUnpacked(srcDir) {
    const root = findManifestRoot(srcDir);
    if (!root) throw new Error('La carpeta no conté cap manifest.json.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ext-'));
    fs.cpSync(root, tmp, { recursive: true });
    return this._finishInstall(tmp, { source: 'unpacked', sourcePath: srcDir });
  }

  async _installCrxBuffer(buf, info) {
    const { zip, publicKey, id } = parseCrx(buf);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ext-'));
    new AdmZip(zip).extractAllTo(tmp, true);
    const root = findManifestRoot(tmp);
    if (!root) { rmrf(tmp); throw new Error('El paquet no conté cap manifest.json.'); }
    if (publicKey) {
      // Afegim la clau al manifest perquè l'ID coincideixi amb el de la Web Store
      const mf = path.join(root, 'manifest.json');
      const manifest = readJson(mf);
      if (!manifest.key) {
        manifest.key = publicKey.toString('base64');
        fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
      }
    }
    return this._finishInstall(root, { ...info, storeId: info.storeId || id }, tmp);
  }

  async _finishInstall(root, info, tmpToClean) {
    const manifest = readJson(path.join(root, 'manifest.json'));
    const key = info.storeId || (String(manifest.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30)
      + '-' + crypto.randomBytes(3).toString('hex'));

    // Si ja existia (actualització), la descarreguem de totes les sessions
    const existing = this.find(key);
    if (existing) {
      this._unload(this.host, existing);
      for (const ses of this.sessions.values()) this._unload(ses, existing);
    }
    const dest = path.join(this.root, key);
    rmrf(dest);
    fs.cpSync(root, dest, { recursive: true });
    if (tmpToClean) rmrf(tmpToClean); else rmrf(root);

    const meta = {
      key, dir: key,
      name: this._resolveName(dest, manifest),
      version: manifest.version || '?',
      enabled: existing ? existing.enabled : true,
      excluded: existing ? existing.excluded : [],
      source: info.source, storeId: info.storeId || null, sourcePath: info.sourcePath || null,
      installedAt: Date.now()
    };
    if (existing) Object.assign(existing, meta); else this.list.push(meta);
    this.store.save();

    const ext = await this._load(this.host, meta);
    if (!ext) throw new Error('L\'extensió s\'ha copiat però Electron no l\'ha pogut carregar (mira la consola).');
    this.ids.set(key, ext.id);
    await this._applyEverywhere(meta);
    this.onChange();
    return meta;
  }

  async update(key) {
    const meta = this.find(key);
    if (!meta) return;
    if (meta.source === 'webstore' && meta.storeId) return this.installFromWebStore(meta.storeId);
    if (meta.source === 'unpacked' && meta.sourcePath && fs.existsSync(meta.sourcePath)) return this.installUnpacked(meta.sourcePath);
    throw new Error('Aquesta extensió no es pot actualitzar automàticament. Torna-la a instal·lar.');
  }

  async remove(key) {
    const meta = this.find(key);
    if (!meta) return;
    this._unload(this.host, meta);
    for (const ses of this.sessions.values()) this._unload(ses, meta);
    rmrf(this.dirOf(meta));
    this.store.data.extensions = this.list.filter(e => e.key !== key);
    this.ids.delete(key);
    this.store.save();
    this.onChange();
  }

  async setEnabled(key, enabled) {
    const meta = this.find(key);
    if (!meta) return;
    meta.enabled = !!enabled;
    this.store.save();
    await this._applyEverywhere(meta);
    this.onChange();
  }

  async setExcluded(key, serviceId, excluded) {
    const meta = this.find(key);
    if (!meta) return;
    const set = new Set(meta.excluded || []);
    excluded ? set.add(serviceId) : set.delete(serviceId);
    meta.excluded = [...set];
    this.store.save();
    await this._applyEverywhere(meta);
    this.onChange();
  }

  // ── Informació per a la interfície ────────────────────────────────────────
  _resolveName(dir, manifest, field = 'name') {
    const raw = manifest[field] || manifest.name || '';
    const mm = /^__MSG_(.+)__$/.exec(raw);
    if (!mm) return raw;
    const locales = [app.getLocale(), app.getLocale().split('-')[0], 'ca', 'es', manifest.default_locale, 'en']
      .filter(Boolean).map(l => l.replace('-', '_'));
    for (const loc of locales) {
      const f = path.join(dir, '_locales', loc, 'messages.json');
      if (!fs.existsSync(f)) continue;
      try {
        const msgs = readJson(f);
        const k = Object.keys(msgs).find(x => x.toLowerCase() === mm[1].toLowerCase());
        if (k) return msgs[k].message;
      } catch { /* ignora */ }
    }
    return raw;
  }

  _icon(dir, manifest) {
    const action = manifest.action || manifest.browser_action || manifest.page_action || {};
    let icon = action.default_icon || manifest.icons;
    if (icon && typeof icon === 'object') {
      const sizes = Object.keys(icon).map(Number).sort((a, b) => a - b);
      const best = sizes.find(s => s >= 32) || sizes[sizes.length - 1];
      icon = icon[best];
    }
    if (typeof icon !== 'string') return null;
    const file = path.join(dir, icon.replace(/^\//, ''));
    if (!fs.existsSync(file)) return null;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  describe() {
    return this.list.map(meta => {
      const dir = this.dirOf(meta);
      let manifest = {};
      try { manifest = readJson(path.join(dir, 'manifest.json')); } catch { /* falta */ }
      const action = manifest.action || manifest.browser_action || manifest.page_action || {};
      return {
        ...meta,
        id: this.ids.get(meta.key) || null,
        manifestVersion: manifest.manifest_version,
        description: this._resolveName(dir, manifest, 'description'),
        icon: this._icon(dir, manifest),
        popup: action.default_popup || null,
        options: manifest.options_ui?.page || manifest.options_page || null,
        broken: !fs.existsSync(dir)
      };
    });
  }

  // ── Popups i opcions (s'obren a la sessió compartida) ─────────────────────
  openPopup(key, anchor, parent) {
    const info = this.describe().find(e => e.key === key);
    if (!info?.id) return;
    if (!info.popup) { if (info.options) this.openOptions(key, parent); return; }

    if (this.popup && !this.popup.isDestroyed()) {
      const same = this.popup.__key === key;
      this.popup.close();
      if (same) return; // segon clic = tancar
    }

    const win = new BrowserWindow({
      parent, show: false, frame: false, resizable: false, skipTaskbar: true,
      width: 360, height: 500, x: Math.round(anchor.x - 360), y: Math.round(anchor.y),
      backgroundColor: '#ffffff',
      webPreferences: { session: this.host, contextIsolation: true, sandbox: true }
    });
    win.__key = key;
    this.popup = win;

    const fit = async () => {
      if (win.isDestroyed()) return;
      try {
        const s = await win.webContents.executeJavaScript(
          '({w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth||0),' +
          '  h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight||0)})');
        const w = Math.min(Math.max(s.w, 80), 800), h = Math.min(Math.max(s.h, 40), 600);
        const area = screen.getDisplayNearestPoint(anchor).workArea;
        const x = Math.max(area.x, Math.min(Math.round(anchor.x - w), area.x + area.width - w));
        const y = Math.min(Math.round(anchor.y), area.y + area.height - h);
        win.setBounds({ x, y, width: w, height: h });
      } catch { /* pàgina navegant */ }
    };

    win.webContents.on('did-finish-load', async () => {
      await fit(); win.show(); win.focus();
      // Molts popups es renderitzen de forma asíncrona: reajustem uns segons
      let n = 0; const t = setInterval(() => { fit(); if (++n > 12 || win.isDestroyed()) clearInterval(t); }, 250);
    });
    win.on('blur', () => { if (!win.webContents.isDevToolsOpened()) win.close(); });
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') win.close();
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.openDevTools({ mode: 'detach' });
    });
    win.loadURL(`chrome-extension://${info.id}/${info.popup.replace(/^\//, '')}`);
  }

  openOptions(key, parent) {
    const info = this.describe().find(e => e.key === key);
    if (!info?.id || !info.options) return false;
    const win = new BrowserWindow({
      parent, width: 900, height: 700, autoHideMenuBar: true, title: `${info.name} — Opcions`,
      webPreferences: { session: this.host, contextIsolation: true, sandbox: true }
    });
    win.loadURL(`chrome-extension://${info.id}/${info.options.replace(/^\//, '')}`);
    return true;
  }
}

module.exports = { ExtensionManager, HOST_PARTITION };
