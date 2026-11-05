/**
 * Upload par morceaux (reprise automatique).
 * Le navigateur decoupe le fichier en morceaux de 512 Ko ; chaque morceau est
 * envoye (et renvoye en cas de coupure) independamment. Un reseau mobile
 * instable ou un proxy qui coupe les longues requetes ne fait donc plus echouer
 * l'envoi complet. Un morceau reenvoye est idempotent (ecriture a position fixe).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const CHUNK_SIZE = 512 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;
const pending = new Map(); // uid -> { file, got:Set, total, last }

function cleanUid(uid) {
  const u = String(uid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  if (u.length < 8) throw new Error('Identifiant d\'envoi invalide');
  return u;
}

/** Ecrit un morceau. Retourne { done, received, total, file } (file = chemin temporaire si termine). */
function writeChunk({ uid, idx, total, buf }) {
  uid = cleanUid(uid);
  idx = Number(idx);
  total = Number(total);
  if (!Number.isInteger(idx) || !Number.isInteger(total) || idx < 0 || total < 1 || idx >= total) {
    throw new Error('Morceau invalide');
  }
  if (total * CHUNK_SIZE > config.MAX_UPLOAD + CHUNK_SIZE) throw new Error('Fichier trop volumineux');
  if (!Buffer.isBuffer(buf) || (idx < total - 1 && buf.length !== CHUNK_SIZE) || buf.length > CHUNK_SIZE) {
    throw new Error('Taille de morceau invalide');
  }
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  let p = pending.get(uid);
  if (!p) {
    p = { file: path.join(config.UPLOAD_DIR, `chunk-${uid}.part`), got: new Set(), total, last: 0 };
    fs.writeFileSync(p.file, ''); // (re)cree un fichier vide
    pending.set(uid, p);
  }
  if (p.total !== total) throw new Error('Envoi incoherent');
  if (!fs.existsSync(p.file)) throw new Error('Envoi perdu (redemarrage du panel) : recommence');
  const fd = fs.openSync(p.file, 'r+');
  try {
    fs.writeSync(fd, buf, 0, buf.length, idx * CHUNK_SIZE);
  } finally {
    fs.closeSync(fd);
  }
  p.got.add(idx);
  p.last = Date.now();
  const done = p.got.size === total;
  if (done) pending.delete(uid);
  return { done, received: p.got.size, total, file: done ? p.file : null };
}

/** Supprime les envois abandonnes (> 1 h). */
function cleanup() {
  const now = Date.now();
  for (const [uid, p] of pending) {
    if (now - p.last > MAX_AGE_MS) {
      try { fs.rmSync(p.file, { force: true }); } catch (e) {}
      pending.delete(uid);
    }
  }
  try {
    for (const n of fs.readdirSync(config.UPLOAD_DIR)) {
      if (!/^chunk-.*\.part$/.test(n)) continue;
      const f = path.join(config.UPLOAD_DIR, n);
      if (now - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.rmSync(f, { force: true });
    }
  } catch (e) {}
}
const timer = setInterval(cleanup, 10 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { writeChunk, CHUNK_SIZE };
