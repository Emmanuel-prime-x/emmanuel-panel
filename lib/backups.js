/**
 * Sauvegardes (backups) des serveurs : archives .zip stockees dans
 * data/backups/<serverId>/. Les dossiers node_modules sont exclus (ils se
 * reinstallent avec npm install).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../config');
const servers = require('./servers');

const MAX_BACKUPS = 10;
const BACKUP_ROOT = path.join(config.DATA_DIR, 'backups');

function dirFor(id) {
  return path.join(BACKUP_ROOT, id);
}

function validName(name) {
  return /^[\w.-]+\.zip$/.test(name || '');
}

function list(id) {
  const dir = dirFor(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(validName)
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function addDir(zip, abs, zipBase) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(abs, e.name);
    const z = zipBase ? zipBase + '/' + e.name : e.name;
    if (e.isDirectory()) addDir(zip, p, z);
    else if (e.isFile()) zip.addLocalFile(p, path.posix.dirname(z) === '.' ? '' : path.posix.dirname(z), e.name);
  }
}

function create(id, label) {
  const src = servers.serverDir(id);
  if (!fs.existsSync(src)) throw new Error('Serveur introuvable');
  const dir = dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  const existing = list(id);
  if (existing.length >= MAX_BACKUPS) {
    throw new Error(`Limite de ${MAX_BACKUPS} sauvegardes atteinte : supprime-en une d'abord.`);
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const safe = (label || '').replace(/[^\w-]/g, '_').slice(0, 30);
  const name = `backup-${stamp}${safe ? '-' + safe : ''}.zip`;
  const zip = new AdmZip();
  addDir(zip, src, '');
  zip.writeZip(path.join(dir, name));
  return list(id).find((b) => b.name === name);
}

function filePath(id, name) {
  if (!validName(name)) throw new Error('Nom de sauvegarde invalide');
  const p = path.join(dirFor(id), name);
  if (!fs.existsSync(p)) throw new Error('Sauvegarde introuvable');
  return p;
}

function remove(id, name) {
  fs.rmSync(filePath(id, name), { force: true });
}

/** Restaure : vide le serveur (sauf node_modules) puis extrait l'archive. */
function restore(id, name) {
  const p = filePath(id, name);
  const dir = servers.serverDir(id);
  servers.stop(id, true);
  for (const e of fs.readdirSync(dir)) {
    if (e === 'node_modules') continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  const zip = new AdmZip(p);
  for (const e of zip.getEntries()) {
    const target = path.resolve(dir, e.entryName);
    if (target !== dir && !target.startsWith(dir + path.sep)) continue;
    if (e.isDirectory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
    }
  }
}

function removeAll(id) {
  fs.rmSync(dirFor(id), { recursive: true, force: true });
}

module.exports = { list, create, remove, restore, filePath, removeAll };
