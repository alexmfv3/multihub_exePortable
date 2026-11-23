// Bloqueig amb contrasenya mestra.
// La contrasenya no es desa mai: només un hash scrypt amb sal aleatòria.
const crypto = require('crypto');
const { powerMonitor } = require('electron');

const LOCK_DEFAULTS = { salt: null, hash: null, autoMinutes: 0, onSystemLock: true };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Lock {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    store.data.lock = { ...LOCK_DEFAULTS, ...(store.data.lock || {}) };
    this.locked = this.enabled; // si hi ha contrasenya, l'app arrenca bloquejada

    // Bloqueig automàtic per inactivitat del sistema
    setInterval(() => {
      const min = this.cfg.autoMinutes;
      if (this.enabled && !this.locked && min > 0 && powerMonitor.getSystemIdleTime() >= min * 60) this.lock();
    }, 20_000);
    // Bloqueig quan es bloqueja Windows o l'ordinador entra en suspensió
    const onSys = () => { if (this.cfg.onSystemLock) this.lock(); };
    powerMonitor.on('lock-screen', onSys);
    powerMonitor.on('suspend', onSys);
  }

  get cfg() { return this.store.data.lock; }
  get enabled() { return !!this.cfg.hash; }

  _hash(pw, salt) { return crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64).toString('hex'); }

  verify(pw) {
    if (!this.enabled) return true;
    const a = Buffer.from(this._hash(pw, this.cfg.salt), 'hex');
    const b = Buffer.from(this.cfg.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async unlock(pw) {
    if (!this.verify(pw)) { await sleep(800); return false; } // frena els intents a cegues
    this.locked = false;
    this.onChange();
    return true;
  }

  lock() {
    if (!this.enabled || this.locked) return;
    this.locked = true;
    this.onChange();
  }

  setPassword(newPw, currentPw) {
    if (this.enabled && !this.verify(currentPw)) throw new Error('La contrasenya actual no és correcta.');
    if (!newPw || String(newPw).length < 4) throw new Error('La contrasenya ha de tenir com a mínim 4 caràcters.');
    const salt = crypto.randomBytes(16).toString('hex');
    Object.assign(this.cfg, { salt, hash: this._hash(newPw, salt) });
    this.store.save();
    this.onChange();
  }

  disable(currentPw) {
    if (!this.verify(currentPw)) throw new Error('La contrasenya no és correcta.');
    Object.assign(this.cfg, { salt: null, hash: null });
    this.locked = false;
    this.store.save();
    this.onChange();
  }

  setOptions({ autoMinutes, onSystemLock }) {
    if (autoMinutes != null) this.cfg.autoMinutes = Math.max(0, Number(autoMinutes) || 0);
    if (onSystemLock != null) this.cfg.onSystemLock = !!onSystemLock;
    this.store.save();
    this.onChange();
  }

  publicState() {
    return { locked: this.locked, enabled: this.enabled, autoMinutes: this.cfg.autoMinutes, onSystemLock: this.cfg.onSystemLock };
  }
}

module.exports = Lock;
