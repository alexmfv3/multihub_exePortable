const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  services: [],      // { id, type, name, url, enabled, muted, zoom }
  extensions: [],    // { key, dir, name, version, enabled, excluded: [serviceId], source }
  groups: [],        // { id, name, collapsed }
  downloads: [],     // historial de descàrregues
  lock: null,        // { salt, hash, autoMinutes, onSystemLock }
  activeId: null,
  settings: { closeToTray: true, startMinimized: false, googleLoginCompat: true, showNames: true, adblock: true,
    downloadDir: null, askDownload: false }
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
    } catch { /* primera execució */ }
    this._timer = null;
  }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this._timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = Store;
