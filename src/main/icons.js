// Icones dels serveis: es descarreguen una vegada en alta resolució i es desen a
// <dades>/icons, de manera que després funcionen sense connexió. Ja no es fa servir el
// favicon de la pàgina oberta (canviava a la "G" de Google durant l'inici de sessió).
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

// Domini d'on treure la icona de cada tipus de servei del catàleg
const DOMAINS = {
  whatsapp: 'web.whatsapp.com', instagram: 'www.instagram.com', 'instagram-dm': 'www.instagram.com',
  outlook: 'outlook.live.com', yahoo: 'mail.yahoo.com', claude: 'claude.ai', ytmusic: 'music.youtube.com',
  discord: 'discord.com', gmail: 'mail.google.com', gdrive: 'drive.google.com', chatgpt: 'chatgpt.com'
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif' };

class Icons {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.dir = path.join(app.getPath('userData'), 'icons');
    fs.mkdirSync(this.dir, { recursive: true });
    this.mem = new Map();
    this.pending = new Map();
  }

  keyFor(svc) {
    if (svc.customIcon) return `custom-${svc.id}`;
    if (DOMAINS[svc.type]) return `type-${svc.type}`;
    try { return `host-${new URL(svc.url).hostname}`; } catch { return null; }
  }
  domainFor(key) {
    if (key.startsWith('type-')) return DOMAINS[key.slice(5)];
    if (key.startsWith('host-')) return key.slice(5);
    return null;
  }

  get(key) {
    if (!key) return null;
    if (this.mem.has(key)) return this.mem.get(key);
    const f = path.join(this.dir, `${key}.txt`);
    if (fs.existsSync(f)) { const v = fs.readFileSync(f, 'utf8'); this.mem.set(key, v); return v; }
    this.ensure(key);
    return null;
  }

  _save(key, dataUrl) {
    this.mem.set(key, dataUrl);
    fs.writeFileSync(path.join(this.dir, `${key}.txt`), dataUrl);
  }

  ensure(key) {
    const domain = this.domainFor(key);
    if (!domain || this.pending.has(key)) return;
    const p = this._fetch(domain).then((url) => {
      if (url) { this._save(key, url); this.onUpdate(); }
    }).catch(() => {}).finally(() => setTimeout(() => this.pending.delete(key), 60_000)); // reintenta en 1 min si ha fallat
    this.pending.set(key, p);
  }

  async _fetch(domain) {
    const candidates = [
      `https://${domain}/apple-touch-icon.png`,                          // normalment 180×180
      `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${domain}.ico`
    ];
    for (const u of candidates) {
      try {
        const r = await net.fetch(u, { redirect: 'follow' });
        const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
        if (!r.ok || !ct.startsWith('image/')) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 300) continue; // icones genèriques/buides
        return `data:${ct};base64,${buf.toString('base64')}`;
      } catch { /* prova la següent */ }
    }
    return null;
  }

  setCustom(svc, file) {
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('Format d\'imatge no suportat');
    this._save(`custom-${svc.id}`, `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`);
  }

  removeCustom(svc) {
    const key = `custom-${svc.id}`;
    this.mem.delete(key);
    fs.rmSync(path.join(this.dir, `${key}.txt`), { force: true });
  }

  /** Esborra la icona descarregada perquè es torni a baixar. */
  refresh(svc) {
    const key = this.keyFor(svc);
    if (!key || key.startsWith('custom-')) return;
    this.mem.delete(key); this.pending.delete(key);
    fs.rmSync(path.join(this.dir, `${key}.txt`), { force: true });
    this.ensure(key);
  }
}

module.exports = { Icons, DOMAINS };
