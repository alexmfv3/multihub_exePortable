// Utilitats per a fitxers .crx (formats CRX2 i CRX3 de Chrome).
// Extreu el ZIP intern i la clau pública, perquè l'extensió conservi el mateix ID
// que té a la Chrome Web Store (algunes extensions en depenen).
const crypto = require('crypto');

const MAGIC = 0x34327243; // "Cr24"

function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [result, pos];
}

// Parser protobuf mínim: retorna [{field, wire, value}]
function parseProto(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag; [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ field, wire, value: v }); }
    else if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos); len = Number(len);
      out.push({ field, wire, value: buf.subarray(pos, pos + len) }); pos += len;
    } else if (wire === 1) { pos += 8; }
    else if (wire === 5) { pos += 4; }
    else throw new Error('Capçalera CRX no vàlida');
  }
  return out;
}

function idFromKey(pubKey) {
  const hash = crypto.createHash('sha256').update(pubKey).digest().subarray(0, 16);
  return [...hash.toString('hex')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** @returns {{ zip: Buffer, publicKey: Buffer|null, id: string|null }} */
function parseCrx(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return { zip: buf, publicKey: null, id: null }; // ja és un zip
  if (buf.length < 16 || buf.readUInt32LE(0) !== MAGIC) throw new Error('No és un fitxer CRX vàlid');
  const version = buf.readUInt32LE(4);

  if (version === 2) {
    const keyLen = buf.readUInt32LE(8), sigLen = buf.readUInt32LE(12);
    const publicKey = buf.subarray(16, 16 + keyLen);
    return { zip: buf.subarray(16 + keyLen + sigLen), publicKey, id: idFromKey(publicKey) };
  }
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    const header = buf.subarray(12, 12 + headerLen);
    const zip = buf.subarray(12 + headerLen);
    let publicKey = null, id = null;
    try {
      const fields = parseProto(header);
      const signed = fields.find(f => f.field === 10000);
      const crxId = signed ? parseProto(signed.value).find(f => f.field === 1)?.value : null;
      const keys = fields.filter(f => f.field === 2 || f.field === 3)
        .map(f => parseProto(f.value).find(x => x.field === 1)?.value).filter(Boolean);
      for (const k of keys) {
        const h = crypto.createHash('sha256').update(k).digest().subarray(0, 16);
        if (!crxId || h.equals(crxId)) { publicKey = k; break; }
      }
      if (publicKey) id = idFromKey(publicKey);
    } catch { /* sense clau: l'ID dependrà de la ruta */ }
    return { zip, publicKey, id };
  }
  throw new Error(`Versió CRX no suportada: ${version}`);
}

module.exports = { parseCrx, idFromKey };
