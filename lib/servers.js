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
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const pidusage = require('pidusage');

const config = require('../config');
const store = require('./store');
const filesLib = () => require('./files');

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

  if (!startupFile) startupFile = 'index.js';
  writeStarter(id, name, startupFile);

  const server = {
    id,
    name,
    startupFile,
    nodeVersion: nodeVersion || 'node',
    env: env || { NODE_ENV: 'production' },
    // Les bots sont relances automatiquement apres un redemarrage du panel
    // (comportement type Pterodactyl). Mets false pour desactiver.
    autostart: true,
    // Relance automatique si le bot plante (limite anti-boucle : 5 crashs / 2 min).
    autorestart: true,
    args: '',
    schedules: [],
    createdAt: Date.now()
  };
  store.addServer(server);
  return server;
}

/** Ecrit le fichier de demarrage par defaut (bot Baileys non encore uploade). */
function writeStarter(id, name, startupFile) {
  const server = store.getServer(id) || {};
  name = name || server.name || 'serveur';
  startupFile = startupFile || server.startupFile || 'index.js';
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(name).replace(/[^\w .-]/g, '');
  const starter = `// EMMANUEL_PANEL_STARTER
// Fichier temporaire cree par le panel. Il sera remplace par ton bot
// des que tu uploades puis decompresses le ZIP de ton bot dans l'onglet Fichiers.
console.log('[BOT] Aucun bot installe pour "${safeName}".');
console.log('[BOT] Upload ton ZIP dans l\\'onglet Fichiers, puis clique sur Decompresser.');
setInterval(() => {}, 1 << 30);
`;
  const starterPath = path.join(dir, startupFile);
  // Fichier d'entree dans un sous-dossier (ex. src/bootstrap.js) : on cree le dossier.
  fs.mkdirSync(path.dirname(starterPath), { recursive: true });
  if (!fs.existsSync(starterPath)) fs.writeFileSync(starterPath, starter, 'utf8');
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
        try {
          process.kill(-pid, 'SIGKILL'); // groupe complet (bot + sous-process)
        } catch (e) {
          process.kill(pid, 'SIGKILL');
        }
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
    runtime.set(id, {
      child: null,
      npmChild: null,
      installPromise: null,
      status: 'offline',
      startedAt: null,
      cancelled: false,
      logs: []
    });
  }
  return runtime.get(id);
}

function pushLog(id, line) {
  const rt = getRuntime(id);
  rt.logs.push(line);
  if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
  bus.emit('output', { id, line });
}

function setStatus(id, status) {
  const rt = getRuntime(id);
  rt.status = status;
  bus.emit('status', { id, status });
}

/** Tue un process ET ses enfants (le bot est lance dans son propre groupe). */
function killTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (e) {
    try {
      child.kill(signal);
    } catch (e2) {}
  }
}

/** Lit package.json (null si absent / invalide). */
function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Nombre de dependances declarees dans package.json (0 si aucune). */
function countDeps(dir) {
  const json = readPkg(dir);
  if (!json) return 0;
  return (
    Object.keys(json.dependencies || {}).length +
    Object.keys(json.devDependencies || {}).length +
    Object.keys(json.optionalDependencies || {}).length
  );
}

/** Vrai si une dependance est un depot git (github:, git+https:, user/repo...). */
function hasGitDeps(dir) {
  const json = readPkg(dir);
  if (!json) return false;
  const all = { ...json.dependencies, ...json.devDependencies, ...json.optionalDependencies };
  return Object.values(all).some((v) => {
    v = String(v);
    return /^(git|github:|git\+|gitlab:|bitbucket:)/.test(v) || /\.git(#|$)/.test(v) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(v);
  });
}

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch (e) {
    return false;
  }
}

/** Taille (Mo) d'un dossier, pour le suivi de l'installation. */
function dirMb(p) {
  try {
    return Math.round(require('./files').dirSize(p) / 1048576);
  } catch (e) {
    return 0;
  }
}

const NPM_TIMEOUT_MS = 15 * 60 * 1000; // un npm install qui depasse 15 min est tue
const NPM_HEARTBEAT_MS = 20 * 1000; // message "toujours en cours" toutes les 20 s

/** Lance une commande npm et diffuse sa sortie. Resout avec le code de sortie. */
function runNpm(id, server, dir, args) {
  const rt = getRuntime(id);
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let output = '';
    let timedOut = false;
    const child = spawn(npm, args, {
      cwd: dir,
      // NODE_ENV=production (defini par le Dockerfile) ferait ignorer les
      // devDependencies : on le neutralise pour l'installation uniquement.
      env: {
        ...process.env,
        ...(server.env || {}),
        NODE_ENV: 'development',
        GIT_TERMINAL_PROMPT: '0',
        // Limite la RAM de npm : sur l'offre gratuite (512 Mo) c'est npm qui
        // doit echouer proprement, pas tout le conteneur (qui tuerait le panel
        // et les autres bots).
        NODE_OPTIONS: '--max-old-space-size=256',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        npm_config_maxsockets: '6',
        npm_config_fetch_retries: '3',
        npm_config_fetch_timeout: '120000'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    rt.npmChild = child;
    const onData = (color) => (d) => {
      output += d.toString();
      splitLines(d).forEach((l) => pushLog(id, color ? `${color}${l}\x1b[0m` : l));
    };
    child.stdout.on('data', onData(''));
    child.stderr.on('data', onData('\x1b[90m'));

    // npm n'affiche rien pendant l'installation : sans ce message la console
    // semble "figee" sur "Installation des dependances...".
    const t0 = Date.now();
    const beat = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      pushLog(
        id,
        `\x1b[36m[PANEL] npm travaille toujours... ${sec}s (node_modules : ${dirMb(path.join(dir, 'node_modules'))} Mo)\x1b[0m`
      );
    }, NPM_HEARTBEAT_MS);
    const killer = setTimeout(() => {
      timedOut = true;
      pushLog(id, `\x1b[31m[PANEL] npm depasse ${NPM_TIMEOUT_MS / 60000} min : arret force.\x1b[0m`);
      killTree(child, 'SIGKILL');
    }, NPM_TIMEOUT_MS);
    const cleanup = () => {
      clearInterval(beat);
      clearTimeout(killer);
    };

    child.on('exit', (code, signal) => {
      cleanup();
      if (rt.npmChild === child) rt.npmChild = null;
      if (code === null && !timedOut && !rt.cancelled) {
        pushLog(
          id,
          `\x1b[31m[PANEL] npm a ete tue par le systeme (${signal || 'signal inconnu'}) : probablement manque de memoire (RAM).\x1b[0m`
        );
      }
      resolve({ code: code === null ? -1 : code, output });
    });
    child.on('error', (err) => {
      cleanup();
      if (rt.npmChild === child) rt.npmChild = null;
      pushLog(id, `\x1b[31m[PANEL] npm introuvable: ${err.message}\x1b[0m`);
      resolve({ code: -1, output: String(err.message) });
    });
  });
}

/**
 * File d'attente globale : un seul npm install a la fois pour tout le panel.
 * Sans ca, plusieurs bots qui s'installent en meme temps (ex. au demarrage du
 * panel) saturent la RAM de l'offre gratuite et les installations restent
 * bloquees.
 */
let npmQueue = Promise.resolve();
function queueNpm(id, task) {
  const rt = getRuntime(id);
  const waiting = npmQueue;
  const run = waiting.then(() => task());
  npmQueue = run.catch(() => {});
  return { run, waiting };
}

/**
 * Installe les dependances npm du bot en diffusant la sortie dans la console.
 * - un seul npm install a la fois par serveur (les appels concurrents partagent la meme promesse) ;
 * - si npm echoue, nouvelle tentative avec --legacy-peer-deps (conflits de versions) ;
 * - diagnostic clair si git est absent.
 * Retourne une promesse resolue avec true (succes) / false (echec).
 */
function installDependencies(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Serveur introuvable');
  const rt = getRuntime(id);
  if (rt.installPromise) return rt.installPromise;

  const dir = serverDir(id);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    pushLog(id, `\x1b[33m[PANEL] Aucun package.json : installation ignoree.\x1b[0m`);
    return Promise.resolve(false);
  }
  if (countDeps(dir) === 0) {
    pushLog(id, `\x1b[36m[PANEL] Aucune dependance a installer.\x1b[0m`);
    return Promise.resolve(true);
  }

  rt.cancelled = false;
  if (!rt.child) setStatus(id, 'installing');
  pushLog(id, `\x1b[36m[PANEL] Installation des dependances (npm install)...\x1b[0m`);

  if (hasGitDeps(dir) && !gitAvailable()) {
    pushLog(
      id,
      `\x1b[31m[PANEL] git n'est pas installe sur ce serveur alors que ton bot a des dependances GitHub. ` +
        `Redeploie le panel avec le Dockerfile corrige (il installe git).\x1b[0m`
    );
  }

  const q = queueNpm(id, async () => {
    try {
      if (rt.cancelled) return false; // arrete pendant l'attente dans la file
      let r = await runNpm(id, server, dir, ['install', '--no-audit', '--no-fund', '--progress=false']);
      if (r.code !== 0 && !rt.cancelled) {
        pushLog(id, `\x1b[33m[PANEL] Echec (code ${r.code}). Nouvelle tentative avec --legacy-peer-deps...\x1b[0m`);
        r = await runNpm(id, server, dir, [
          'install',
          '--no-audit',
          '--no-fund',
          '--progress=false',
          '--legacy-peer-deps'
        ]);
      }
      if (r.code !== 0 && !rt.cancelled) {
        // Dernier recours : un script postinstall/preinstall du bot echoue
        // (compilation native, telechargement...). On installe sans scripts
        // pour que le bot puisse au moins demarrer.
        pushLog(id, `\x1b[33m[PANEL] Nouvelle tentative sans scripts d'installation (--ignore-scripts)...\x1b[0m`);
        r = await runNpm(id, server, dir, [
          'install',
          '--no-audit',
          '--no-fund',
          '--progress=false',
          '--legacy-peer-deps',
          '--ignore-scripts'
        ]);
      }
      if (r.code === 0) {
        pushLog(id, `\x1b[32m[PANEL] Dependances installees.\x1b[0m`);
        return true;
      }
      if (rt.cancelled) {
        pushLog(id, `\x1b[33m[PANEL] Installation annulee.\x1b[0m`);
        return false;
      }
      if (/spawn git|ENOENT.*git/i.test(r.output)) {
        pushLog(id, `\x1b[31m[PANEL] Cause : git est introuvable sur le serveur (redeploie avec le Dockerfile corrige).\x1b[0m`);
      }
      pushLog(id, `\x1b[31m[PANEL] npm install a echoue (code ${r.code}).\x1b[0m`);
      return false;
    } finally {
      rt.installPromise = null;
      if (!rt.child && rt.status === 'installing') setStatus(id, 'offline');
    }
  });
  rt.installPromise = q.run;
  // Si un autre bot est deja en train d'installer, on previent l'utilisateur.
  let started = false;
  q.waiting.then(() => (started = true));
  setTimeout(() => {
    if (!started && rt.installPromise === q.run) {
      pushLog(id, `\x1b[36m[PANEL] Un autre serveur installe ses dependances : le tien demarre juste apres (file d'attente).\x1b[0m`);
    }
  }, 50);
  return rt.installPromise;
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

/** Attend que le process d'un serveur soit reellement termine. */
function waitExit(id, timeoutMs) {
  const rt = getRuntime(id);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!rt.child || Date.now() - t0 > timeoutMs) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
}

function start(id) {
  const server = store.getServer(id);
  if (!server) throw new Error('Serveur introuvable');
  const rt = getRuntime(id);
  if (rt.installPromise) {
    // Une installation est deja en cours : on demarrera le bot juste apres.
    if (!rt.startQueued) {
      rt.startQueued = true;
      rt.installPromise.then((ok) => {
        rt.startQueued = false;
        if (!ok && !rt.cancelled) {
          pushLog(id, `\x1b[31m[PANEL] Demarrage annule : l'installation des dependances a echoue.\x1b[0m`);
        }
        if (ok && !rt.cancelled && !rt.child) {
          try {
            start(id);
          } catch (e) {}
        }
      });
    }
    return 'installing';
  }

  if (rt.child) {
    if (rt.status === 'running' || rt.status === 'starting') return rt.status;
    // Le process precedent est encore en train de s'arreter : on attend sa
    // fin pour ne jamais avoir deux instances du bot en parallele.
    waitExit(id, 15000).then(() => {
      if (!rt.child) {
        try {
          start(id);
        } catch (e) {}
      }
    });
    return 'starting';
  }
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
    installDependencies(id).then((ok) => {
      if (rt.cancelled) return setStatus(id, 'offline');
      if (!ok && needsInstall(dir)) {
        pushLog(id, `\x1b[31m[PANEL] Demarrage annule : les dependances ne sont pas installees. Corrige l'erreur ci-dessus puis clique sur Demarrer.\x1b[0m`);
        return setStatus(id, 'offline');
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
  const extra = String(server.args || '')
    .split(/\s+/)
    .filter((a) => /^--?[\w=.:/-]+$/.test(a)); // options node simples uniquement
  const child = spawn(process.execPath, [...extra, server.startupFile || 'index.js'], {
    cwd: dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Groupe de process dedie : on peut tuer le bot ET ses sous-process.
    detached: process.platform !== 'win32'
  });
  // Evite un crash du panel si le bot ferme stdin (EPIPE).
  child.stdin.on('error', () => {});

  rt.child = child;
  rt.status = 'starting';
  rt.startedAt = Date.now();
  bus.emit('status', { id, status: 'starting' });

  // Enregistre le PID pour pouvoir tuer un eventuel orphelin au prochain boot.
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(pidFile(id), String(child.pid), 'utf8');
  } catch (e) {}

  pushLog(id, `\x1b[32m[PANEL] Demarrage du serveur "${server.name}"...\x1b[0m`);

  child.stdout.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, l)));
  child.stderr.on('data', (d) => splitLines(d).forEach((l) => pushLog(id, `\x1b[31m${l}\x1b[0m`)));

  child.on('spawn', () => {
    if (rt.child !== child) return;
    rt.status = 'running';
    bus.emit('status', { id, status: 'running' });
    pushLog(id, `\x1b[32m[PANEL] Serveur en ligne (PID ${child.pid}).\x1b[0m`);
  });

  // IMPORTANT : on ne touche a l'etat que si ce process est TOUJOURS le process
  // courant. Sinon l'ancien process (tue puis relance) ecraserait l'etat du
  // nouveau -> le panel le perdrait de vue et on aurait deux instances du bot.
  child.on('exit', (code, signal) => {
    pushLog(id, `\x1b[33m[PANEL] Processus termine (code ${code}, signal ${signal}).\x1b[0m`);
    if (rt.child !== child) return;
    rt.child = null;
    rt.status = 'offline';
    rt.startedAt = null;
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
    bus.emit('status', { id, status: 'offline' });
    scheduleCrashRestart(id, code, signal);
  });

  child.on('error', (err) => {
    pushLog(id, `\x1b[31m[PANEL] Erreur: ${err.message}\x1b[0m`);
    if (rt.child !== child) return;
    rt.child = null;
    rt.status = 'offline';
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
    bus.emit('status', { id, status: 'offline' });
  });

  return rt.status;
}

/** Relance automatique apres un crash (code != 0), avec garde anti-boucle. */
function scheduleCrashRestart(id, code, signal) {
  const rt = getRuntime(id);
  const server = store.getServer(id);
  if (!server || server.autorestart === false) return;
  if (rt.cancelled || signal === 'SIGKILL' || signal === 'SIGTERM' || code === 0) return;
  const now = Date.now();
  rt.crashes = (rt.crashes || []).filter((t) => now - t < 120000);
  rt.crashes.push(now);
  if (rt.crashes.length > 5) {
    pushLog(id, `\x1b[31m[PANEL] Trop de crashs en 2 minutes : relance automatique suspendue.\x1b[0m`);
    return;
  }
  pushLog(id, `\x1b[33m[PANEL] Le bot a plante : relance automatique dans 5 s...\x1b[0m`);
  const t = setTimeout(() => {
    if (!rt.child && !rt.cancelled) {
      try {
        start(id);
      } catch (e) {}
    }
  }, 5000);
  if (t.unref) t.unref();
}

/** Installe des paquets npm precis (npm install <pkg> ...). */
async function installPackages(id, packages) {
  const server = store.getServer(id);
  if (!server) throw new Error('Serveur introuvable');
  const pkgs = (Array.isArray(packages) ? packages : String(packages || '').split(/\s+/)).filter(Boolean);
  if (!pkgs.length) throw new Error('Aucun paquet indique');
  // Noms de paquets / URLs git simples uniquement (pas d'option npm injectee).
  if (!pkgs.every((p) => /^[@\w][\w@./:#~^+=-]*$/.test(p))) throw new Error('Nom de paquet invalide');
  const rt = getRuntime(id);
  if (rt.installPromise) throw new Error('Une installation est deja en cours');
  const dir = serverDir(id);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bot', version: '1.0.0' }, null, 2));
  }
  pushLog(id, `\x1b[36m[PANEL] npm install ${pkgs.join(' ')}\x1b[0m`);
  rt.installPromise = runNpm(id, server, dir, ['install', '--no-audit', '--no-fund', '--progress=false', ...pkgs]).then((r) => {
    pushLog(id, r.code === 0 ? `\x1b[32m[PANEL] Paquets installes.\x1b[0m` : `\x1b[31m[PANEL] Echec (code ${r.code}).\x1b[0m`);
    return r.code === 0;
  });
  try {
    return await rt.installPromise;
  } finally {
    rt.installPromise = null;
  }
}

function stop(id, force) {
  const rt = getRuntime(id);
  rt.cancelled = true; // annule un eventuel demarrage/installation en cours
  if (rt.npmChild) killTree(rt.npmChild, 'SIGKILL'); // stoppe un npm install en cours
  if (!rt.child) {
    if (!rt.installPromise) setStatus(id, 'offline');
    return;
  }
  const child = rt.child;
  if (force) {
    // Le status passe a offline, mais rt.child est conserve jusqu'a la fin
    // reelle du process (gere par l'evenement 'exit').
    killTree(child, 'SIGKILL');
    setStatus(id, 'offline');
    return;
  }
  setStatus(id, 'stopping');
  killTree(child, 'SIGTERM');
  // Si le bot ignore SIGTERM, on force apres 10 s.
  const t = setTimeout(() => {
    if (rt.child === child) killTree(child, 'SIGKILL');
  }, 10000);
  if (t.unref) t.unref();
}

/** Arrete TOUS les bots (utilise a l'arret propre du panel). */
function stopAll() {
  for (const [id, rt] of runtime.entries()) {
    rt.cancelled = true;
    if (rt.npmChild) killTree(rt.npmChild, 'SIGKILL');
    if (rt.child) killTree(rt.child, 'SIGKILL');
    try {
      fs.rmSync(pidFile(id), { force: true });
    } catch (e) {}
  }
}

function restart(id) {
  stop(id, false);
  // On attend la FIN reelle du process avant de relancer (sinon le nouveau
  // bot ne demarre pas, ou deux instances se disputent la meme session /
  // le meme token -> erreur Telegram 409 Conflict).
  waitExit(id, 15000).then(() => {
    try {
      start(id);
    } catch (e) {}
  });
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
    memory: 0,
    disk: 0
  };
  const now = Date.now();
  if (!rt.diskAt || now - rt.diskAt > 15000) {
    rt.diskAt = now;
    try {
      rt.diskMb = Math.round(filesLib().dirSize(serverDir(id)) / 1024 / 1024);
    } catch (e) {
      rt.diskMb = 0;
    }
  }
  base.disk = rt.diskMb || 0;
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
  writeStarter,
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
  installPackages,
  pushLog,
  serverDir
};
