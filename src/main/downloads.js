// Gestor de descàrregues: recull les descàrregues de TOTS els serveis en una sola llista,
// amb progrés, pausa/reprendre, cancel·lar, obrir, mostrar a la carpeta i historial.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, shell, Notification, session } = require('electron');

const MAX_HISTORY = 200;

function uniquePath(dir, name) {
  const clean = (name || 'descarrega').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  let p = path.join(dir, clean), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}

class Downloads {
  constructor(store, { serviceName, onChange, onProgress, isLocked }) {
    this.store = store;
    this.serviceName = serviceName;
    this.onChange = onChange;
    this.onProgress = onProgress;
    this.isLocked = isLocked;
    this.active = new Map(); // id -> DownloadItem
    if (!Array.isArray(store.data.downloads)) store.data.downloads = [];
    // Les que estaven en curs quan es va tancar l'app queden com a interrompudes
    for (const d of store.data.downloads) if (d.state === 'progressing') d.state = 'interrupted';
    this._t = null;
  }

  get list() { return this.store.data.downloads; }
  get dir() { return this.store.data.settings.downloadDir || app.getPath('downloads'); }

  _progress() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.onProgress(this.list); }, 400);
  }

  attach(ses) {
    if (ses.__mhDownloads) return;
    ses.__mhDownloads = true;
    ses.on('will-download', (_e, item) => {
      const id = crypto.randomUUID();
      if (!this.store.data.settings.askDownload) {
        fs.mkdirSync(this.dir, { recursive: true });
        item.setSavePath(uniquePath(this.dir, item.getFilename()));
      }
      const entry = {
        id, filename: item.getFilename(), url: item.getURL(), partition: ses.__mhPartition || null,
        service: this.serviceName(ses), total: item.getTotalBytes(), received: 0,
        state: 'progressing', paused: false, savePath: item.getSavePath() || null, start: Date.now(), end: null
      };
      this.list.unshift(entry);
      this.list.splice(MAX_HISTORY);
      this.active.set(id, item);
      this.onChange();

      item.on('updated', (_ev, state) => {
        entry.state = state;
        entry.received = item.getReceivedBytes();
        entry.total = item.getTotalBytes();
        entry.paused = item.isPaused();
        const sp = item.getSavePath();
        if (sp) { entry.savePath = sp; entry.filename = path.basename(sp); }
        this._progress();
      });
      item.once('done', (_ev, state) => {
        this.active.delete(id);
        entry.state = state; // completed | cancelled | interrupted
        entry.received = item.getReceivedBytes();
        entry.paused = false;
        entry.end = Date.now();
        const sp = item.getSavePath();
        if (sp) { entry.savePath = sp; entry.filename = path.basename(sp); }
        this.store.save();
        this.onChange();
        if (state === 'completed' && Notification.isSupported() && !this.isLocked()) {
          const n = new Notification({ title: 'Descàrrega completada', body: entry.filename });
          n.on('click', () => shell.showItemInFolder(entry.savePath));
          n.show();
        }
      });
    });
  }

  async action(id, act) {
    const entry = this.list.find(d => d.id === id);
    const item = this.active.get(id);
    switch (act) {
      case 'pause': item?.pause(); break;
      case 'resume': if (item?.canResume()) item.resume(); break;
      case 'cancel': item?.cancel(); break;
      case 'open': if (entry?.savePath) { const err = await shell.openPath(entry.savePath); if (err) throw new Error(err); } break;
      case 'folder': if (entry?.savePath) shell.showItemInFolder(entry.savePath); break;
      case 'retry':
        if (entry?.url) {
          const ses = entry.partition ? session.fromPartition(entry.partition) : session.defaultSession;
          this.store.data.downloads = this.list.filter(d => d.id !== id);
          ses.downloadURL(entry.url);
        }
        break;
      case 'remove':
        item?.cancel();
        this.store.data.downloads = this.list.filter(d => d.id !== id);
        break;
      case 'deleteFile':
        if (entry?.savePath && fs.existsSync(entry.savePath)) await shell.trashItem(entry.savePath);
        this.store.data.downloads = this.list.filter(d => d.id !== id);
        break;
    }
    this.store.save();
    this.onChange();
  }

  clearFinished() {
    this.store.data.downloads = this.list.filter(d => this.active.has(d.id));
    this.store.save();
    this.onChange();
  }

  activeCount() { return this.active.size; }

  view() {
    return this.list.map(d => ({ ...d, exists: d.savePath ? fs.existsSync(d.savePath) : false }));
  }
}

module.exports = Downloads;
