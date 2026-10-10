/**
 * Gestionnaire de serveurs.
 * Chaque "serveur" = un dossier dans /servers/<id> contenant le bot WhatsApp.
 * On lance le bot via un process enfant (node <fichier>), on capture sa sortie
 * et on permet l'envoi de commandes sur stdin depuis la console du panel.
 *
 * Robustesse : chaque bot a un fichier PID. Au demarrage du panel, les bots
 * orphelins (restes d'une instance precedente plantee) sont tues avant d'etre
 * relances -> jamais de doublon qui se disputerait la connexion WhatsApp.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const pidusage = require('pidusage');

const config = require('../config');
const store = require('./store');

const bus = new EventEmitter(); // diffuse la sortie console vers socket.io

// id -> { child, status, startedAt, logs: [] }
const runtime = new Map();

const MAX_LOG_LINES = 500;
const PID_DIR = path.join(config.DATA_DIR, 'pids');

function serverDir(id) {
  return path.join(config.SERVERS_DIR, id);
}

function pidFile(id) {
  return path.join(PID_DIR, `${id}.pid`);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- Creation / suppression ---------------- */

function createServer({ name, startupFile, nodeVersion, env }) {
  const id = crypto.randomBytes(4).toString('hex');
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });

  // Fichier de depart par defaut pour un bot Baileys
  const starter = `// EMMANUEL_PANEL_STARTER
// Fichier temporaire cree par le panel. Il sera remplace par ton bot
// des que tu uploades le ZIP de ton bot WhatsApp dans l'onglet Fichiers.
console.log('[BOT] Aucun bot installe pour "${name}".');
console.log('[BOT] Upload le ZIP de ton bot dans l\\'onglet Fichiers.');
setInterval(() => {}, 1 << 30);
`;
  if (!startupFile) startupFile = 'index.js';
  const starterPath = path.join(dir, startupFile);
  if (!fs.existsSync(starterPath)) fs.writeFileSync(starterPath, starter, 'utf8');

  const server = {
    id,
    name,
    startupFile,
    nodeVersion: nodeVersion || 'node',
    env: env || { NODE_ENV: 'production' },
    // Les bots sont relances automatiquement apres un redemarrage du panel
    // (comportement type Pterodactyl). Mets false pour desactiver.
    autostart: true,
    createdAt: Date.now()
  };
  store.addServer(server);
  return server;
}

function deleteServer(id) {
  stop(id, true);
  const dir = serverDir(id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
  try {
    fs.rmSync(pidFile(id), { force: true });
  } catch (e) {}
  runtime.delete(id);
  store.deleteServer(id);
}

/**
 * Tue les bots orphelins restes d'une instance precedente du panel (crash,
 * redemarrage brutal...). Sans cela, l'ancien bot continuerait de tourner ET le
 * nouveau serait relance -> deux connexions WhatsApp concurrentes.
 */
function killOrphans() {
  let list = [];
  try {
    list = store.getServers();
  } catch (e) {
    return;
  }
  for (const s of list) {
    const pf = pidFile(s.id);
    let pid = null;
    try {
      pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
    } catch (e) {
      pid = null;
    }
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
        pushLog(s.id, `\x1b[33m[PANEL] Processus orphelin (PID ${pid}) arrete avant relance.\x1b[0m`);
      } catch (e) {}
    }
    try {
      fs.rmSync(pf, { force: true });
    } catch (e) {}
  }
}

/**
 * Relance automatiquement les bots marques "autostart" apres un redemarrage
 * du panel. Ainsi les serveurs continuent de tourner comme sur Pterodactyl.
 */
function restoreOnBoot() {
  let list = [];
  try {
    list = store.getServers();
  } catch (e) {
    return;
  }
  list.forEach((s, i) => {
    if (s.autostart === false) return;
    const dir = serverDir(s.id);
    if (!fs.existsSync(dir)) return;
    // Petit decalage pour ne pas surcharger le demarrage du panel.
    const t = setTimeout(() => {
      try {
        pushLog(s.id, `\x1b[36m[PANEL] Relance automatique apres demarrage du panel.\x1b[0m`);
        start(s.id);
      } catch (e) {}
    }, 2500 + i * 1200);
    if (t.unref) t.unref();
  });
}

/* ---------------- Process ---------------- */

function getRuntime(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { child: null, status: 'offline', startedAt: null, logs: [] });
  }
  return runtime.get(id);
}

function pushLog(id, line) {
  const rt = getRuntime(id);
  rt.logs.push(line);
  if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
  bus.emit('output', { id, line });
}

/** Lit les dependances declarees dans package.json (0 si aucune). */
function countDeps(dir) {
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) return 0;
  try {
    const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    return Object.keys(json.dependencies || {}).length + Object.keys(json.devDependencies || {}).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Installe les dependances npm du bot (npm install) en diffusant la sortie
 * dans la console du panel. Retourne une promesse resolue a la fin.
 */
function installDependencies(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Serveur introuvable');
  const dir = serverDir(id);
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) {
    pushLog(id, `\x1b[33m[PANEL] Aucun package.json : installation ignoree.\x1b[0m`);
    return Promise.resolve(false);
  }
  if (countDeps(dir) === 0) {
    pushLog(id, `\x1b[36m[PANEL] Aucune dependance a installer.\x1b[0m`);
    return Promise.resolve(true);
  }

  pushLog(id, `\x1b[36m[PANEL] Installation des dependances (npm install)...\x1b[0m`);
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['install', '--no-audit', '--no-fund'], {
      cwd: dir,
      env: { ...process.env, ...(server.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, l)));
    child.stderr.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, `\x1b[90m${l}\x1b[0m`)));
    child.on('exit', (code) => {
      if (code === 0) pushLog(id, `\x1b[32m[PANEL] Dependances installees.\x1b[0m`);
      else pushLog(id, `\x1b[31m[PANEL] npm install a echoue (code ${code}).\x1b[0m`);
      resolve(code === 0);
    });
    child.on('error', (err) => {
      pushLog(id, `\x1b[31m[PANEL] npm introuvable: ${err.message}\x1b[0m`);
      resolve(false);
    });
  });
}

function needsInstall(dir) {
  const pkg = path.join(dir, 'package.json');
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(pkg)) return false;
  if (countDeps(dir) === 0) return false; // rien a installer
  if (!fs.existsSync(nm)) return true;
  // node_modules present mais vide ?
  try {
    return fs.readdirSync(nm).length === 0;
  } catch (e) {
    return true;
  }
}

function start(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Serveur introuvable');
  const rt = getRuntime(id);
  if (rt.child) return rt.status;
  rt.cancelled = false;

  const dir = serverDir(id);
  const entry = path.join(dir, server.startupFile || 'index.js');
  if (!fs.existsSync(entry)) {
    pushLog(id, `\x1b[31m[PANEL] Fichier de demarrage introuvable: ${server.startupFile}\x1b[0m`);
    pushLog(id, `\x1b[33m[PANEL] Verifie l'onglet Demarrage ou re-uploade ton ZIP.\x1b[0m`);
    return 'offline';
  }

  // Installation automatique des dependances si necessaire, puis demarrage.
  if (needsInstall(dir)) {
    rt.status = 'installing';
    bus.emit('status', { id, status: 'installing' });
    installDependencies(id).then(() => {
      if (rt.cancelled) {
        rt.status = 'offline';
        bus.emit('status', { id, status: 'offline' });
        return;
      }
      spawnBot(id, server, dir);
    });
    return 'installing';
  }

  return spawnBot(id, server, dir);
}

function spawnBot(id, server, dir) {
  const rt = getRuntime(id);
  if (rt.child || rt.cancelled) return rt.status;

  const env = { ...process.env, ...(server.env || {}) };
  const child = spawn(process.execPath, [server.startupFile || 'index.js'], {
    cwd: dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  rt.child = child;
  rt.status = 'starting';
  rt.startedAt = Date.now();

  // Enregistre le PID pour pouvoir tuer un eventuel orphelin au prochain boot.
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(pidFile(id), String(child.pid), 'utf8');
  } catch (e) {}

  pushLog(id, `\x1b[32m[PANEL] Demarrage du serveur "${server.name}"...\x1b[0m`);

  child.stdout.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, l)));
  child.stderr.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, `\x1b[31m${l}\x1b[0m`)));

  child.on('spawn', () => {
    rt.status = 'running';
    bus.emit('status', { id, status: 'running' });
    pushLog(id, `\x1b[32m[PANEL] Serveur en ligne (PID ${child.pid}).\x1b[0m`);
  });

  child.on('exit', (code, signal) => {
    pushLog(id, `\x1b[33m[PANEL] Processus termine (code ${code}, signal ${signal}).\x1b[0m`);
    rt.child = null;
    rt.status = 'offline';
    rt.startedAt = null;
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
    bus.emit('status', { id, status: 'offline' });
  });

  child.on('error', (err) => {
    pushLog(id, `\x1b[31m[PANEL] Erreur: ${err.message}\x1b[0m`);
    rt.child = null;
    rt.status = 'offline';
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
    bus.emit('status', { id, status: 'offline' });
  });

  return rt.status;
}

function stop(id, force) {
  const rt = getRuntime(id);
  rt.cancelled = true; // annule un eventuel demarrage/installation en cours
  if (!rt.child) {
    rt.status = 'offline';
    bus.emit('status', { id, status: 'offline' });
    return;
  }
  rt.status = force ? 'offline' : 'stopping';
  bus.emit('status', { id, status: rt.status });
  try {
    if (force) rt.child.kill('SIGKILL');
    else rt.child.kill('SIGTERM');
  } catch (e) {}
  if (force) {
    rt.child = null;
    rt.status = 'offline';
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
  }
}

/** Arrete TOUS les bots (utilise a l'arret propre du panel). */
function stopAll() {
  for (const [id, rt] of runtime.entries()) {
    rt.cancelled = true;
    if (rt.child) {
      try {
        rt.child.kill('SIGKILL');
      } catch (e) {}
    }
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
  }
}

function restart(id) {
  stop(id, false);
  setTimeout(() => start(id), 800);
}

function kill(id) {
  stop(id, true);
}

function sendCommand(id, cmd) {
  const rt = getRuntime(id);
  if (!rt.child) return false;
  try {
    rt.child.stdin.write(cmd + '\n');
    pushLog(id, `\x1b[36m> ${cmd}\x1b[0m`);
    return true;
  } catch (e) {
    return false;
  }
}

function getStatus(id) {
  return getRuntime(id).status;
}

function getLogs(id) {
  return getRuntime(id).logs;
}

/* ---------------- Stats ---------------- */

async function getStats(id) {
  const rt = getRuntime(id);
  const base = {
    status: rt.status,
    uptime: rt.startedAt ? Math.floor((Date.now() - rt.startedAt) / 1000) : 0,
    cpu: 0,
    memory: 0
  };
  if (!rt.child) return base;
  try {
    const usage = await pidusage(rt.child.pid);
    base.cpu = Math.round(usage.cpu * 10) / 10;
    base.memory = Math.round(usage.memory / 1024 / 1024); // Mo
  } catch (e) {}
  return base;
}

/* ---------------- Utils ---------------- */

function splitLines(buf) {
  return buf
    .toString()
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.length > 0);
}

module.exports = {
  bus,
  createServer,
  deleteServer,
  restoreOnBoot,
  killOrphans,
  stopAll,
  start,
  stop,
  restart,
  kill,
  sendCommand,
  getStatus,
  getLogs,
  getStats,
  installDependencies,
  pushLog,
  serverDir
};
