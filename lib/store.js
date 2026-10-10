/**
 * Persistance simple sur disque (JSON).
 * Stocke la liste des serveurs et les identifiants hashes.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDirs() {
  for (const dir of [config.DATA_DIR, config.SERVERS_DIR, config.UPLOAD_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

const SERVERS_FILE = path.join(config.DATA_DIR, 'servers.json');
const SERVERS_BAK = path.join(config.DATA_DIR, 'servers.json.bak');
const AUTH_FILE = path.join(config.DATA_DIR, 'auth.json');
const AUTH_BAK = path.join(config.DATA_DIR, 'auth.json.bak');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- Servers ---------------- */
/**
 * Lecture robuste : si le fichier principal a disparu ou est corrompu, on le
 * restaure automatiquement depuis la sauvegarde (.bak). Les serveurs ne sont
 * donc JAMAIS perdus, meme en cas de redemarrage ou d'ecriture interrompue.
 */
function getServers() {
  const data = readJSON(SERVERS_FILE, null);
  if (Array.isArray(data)) return data;
  // Fichier absent ou corrompu -> tentative de restauration.
  const bak = readJSON(SERVERS_BAK, null);
  if (Array.isArray(bak)) {
    try {
      writeJSON(SERVERS_FILE, bak);
    } catch (e) {}
    return bak;
  }
  return [];
}

function saveServers(servers) {
  writeJSON(SERVERS_FILE, servers);
  try {
    writeJSON(SERVERS_BAK, servers);
  } catch (e) {}
}

function getServer(id) {
  return getServers().find((s) => s.id === id);
}

function addServer(server) {
  const servers = getServers();
  servers.push(server);
  saveServers(servers);
  return server;
}

function updateServer(id, patch) {
  const servers = getServers();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  servers[idx] = { ...servers[idx], ...patch };
  saveServers(servers);
  return servers[idx];
}

function deleteServer(id) {
  const servers = getServers().filter((s) => s.id !== id);
  saveServers(servers);
}

/* ---------------- Auth ---------------- */
function getAuth() {
  const data = readJSON(AUTH_FILE, null);
  if (data) return data;
  const bak = readJSON(AUTH_BAK, null);
  if (bak) {
    try {
      writeJSON(AUTH_FILE, bak);
    } catch (e) {}
    return bak;
  }
  return null;
}

function saveAuth(auth) {
  writeJSON(AUTH_FILE, auth);
  try {
    writeJSON(AUTH_BAK, auth);
  } catch (e) {}
}

module.exports = {
  ensureDirs,
  getServers,
  saveServers,
  getServer,
  addServer,
  updateServer,
  deleteServer,
  getAuth,
  saveAuth
};
