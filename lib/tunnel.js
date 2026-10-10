/**
 * Gestionnaire de tunnel public (Cloudflare "quick tunnel").
 *
 * Objectif : rendre le panel accessible depuis Internet de facon AUTONOME,
 * FIABLE et AUTO-REPARANTE.
 *
 * Points cles :
 *  - Le binaire cloudflared vit dans /workspace (persistant).
 *  - Le panel est le SEUL proprietaire du tunnel : il nettoie les processus
 *    cloudflared orphelins puis lance le sien.
 *  - Un watchdog relance le tunnel s'il meurt.
 *  - Un auto-test ("health check") verifie que l'URL publique repond vraiment ;
 *    sinon le tunnel est recree (protection contre un tunnel "zombie").
 *  - L'URL courante est publiee sur ntfy.sh pour que la page "launcher"
 *    (URL stable) redirige toujours vers le panel en ligne.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../config');

const CFG = config.TUNNEL;
const TARGET = `http://localhost:${config.PORT}`;
// Port de metriques "ignore" par la plateforme (evite le tracking supervisord).
const METRICS = process.env.CLOUDFLARED_METRICS || '127.0.0.1:8000';

let watchdog = null;
let republish = null;
let healthTimer = null;
let state = { pid: null, url: null, startedAt: null };
let healthFails = 0;

/* ---------------- Helpers ---------------- */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
    fs.writeFileSync(CFG.stateFile, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('[tunnel] ecriture etat impossible:', e.message);
  }
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

function isCloudflared(pid) {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    return comm.includes('cloudflared');
  } catch (e) {
    return false;
  }
}

function readUrlFromLog() {
  try {
    const data = fs.readFileSync(CFG.logFile, 'utf8');
    // On ne considere que le contenu APRES le dernier marqueur de demarrage,
    // pour ne jamais renvoyer une ancienne URL (tunnel mort).
    const idx = data.lastIndexOf('demarrage tunnel');
    const segment = idx >= 0 ? data.slice(idx) : data;
    const matches = segment.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return matches && matches.length ? matches[matches.length - 1] : null;
  } catch (e) {
    return null;
  }
}

function ensureLog() {
  fs.mkdirSync(path.dirname(CFG.logFile), { recursive: true });
  if (!fs.existsSync(CFG.logFile)) fs.writeFileSync(CFG.logFile, '');
}

/**
 * S'assure que le binaire cloudflared est present. S'il manque, on le
 * telecharge automatiquement depuis GitHub (Linux amd64).
 */
function ensureBinary() {
  if (fs.existsSync(CFG.binary)) return true;
  const url =
    process.env.CLOUDFLARED_URL ||
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  try {
    fs.mkdirSync(path.dirname(CFG.binary), { recursive: true });
    console.log('[tunnel] cloudflared absent -> telechargement...');
    execSync(`curl -fsSL -o "${CFG.binary}" "${url}" && chmod +x "${CFG.binary}"`, {
      stdio: 'ignore',
      timeout: 120000
    });
    return fs.existsSync(CFG.binary);
  } catch (e) {
    console.error('[tunnel] telechargement cloudflared impossible :', e.message);
    return false;
  }
}

/** Tue les processus cloudflared orphelins (pas celui de l'etat courant). */
function killStray(keepPid) {
  try {
    const out = execSync('pgrep -x cloudflared || true', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!out) return;
    const keep = keepPid || state.pid;
    out
      .split(/\s+/)
      .map(Number)
      .filter((p) => p && p !== keep)
      .forEach((p) => {
        try {
          process.kill(p, 'SIGTERM');
        } catch (e) {}
      });
  } catch (e) {}
}

/**
 * Publie l'URL publique courante sur ntfy.sh (topic fixe). La page "launcher"
 * (URL stable) lit ce topic pour toujours rediriger vers le panel en ligne.
 */
function publishUrl(url) {
  if (!url || !CFG.publishTopic) return;
  try {
    const req = https.request(
      `${CFG.publishBase}/${CFG.publishTopic}`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' } },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.write(url);
    req.end();
    console.log('[tunnel] URL publiee sur ' + CFG.publishBase + '/' + CFG.publishTopic);
  } catch (e) {
    console.error('[tunnel] publication URL impossible :', e.message);
  }
}

/** Verifie que l'URL publique repond bien (auto-test). */
function checkUrl(url, cb) {
  if (!url) return cb(false);
  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(url.replace(/\/+$/, '') + '/api/ping', { timeout: 12000 }, (res) => {
    res.resume();
    cb(res.statusCode >= 200 && res.statusCode < 400);
  });
  req.on('timeout', () => {
    req.destroy();
    cb(false);
  });
  req.on('error', () => cb(false));
}

/* ---------------- Core ---------------- */

function spawnTunnel() {
  if (!ensureBinary()) {
    console.error('[tunnel] binaire cloudflared indisponible :', CFG.binary);
    return null;
  }
  ensureLog();
  const fd = fs.openSync(CFG.logFile, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} demarrage tunnel -> ${TARGET} =====\n`);

  const child = spawn(
    CFG.binary,
    ['tunnel', '--url', TARGET, '--metrics', METRICS, '--no-autoupdate'],
    { detached: true, stdio: ['ignore', fd, fd] }
  );
  child.unref();
  try {
    fs.closeSync(fd);
  } catch (e) {}

  state = { pid: child.pid, url: null, startedAt: Date.now() };
  healthFails = 0;
  writeState(state);
  console.log('[tunnel] cloudflared demarre (pid ' + child.pid + ') -> ' + TARGET);

  // Recupere l'URL publique des qu'elle apparait dans le log
  let tries = 0;
  const poll = setInterval(() => {
    const url = readUrlFromLog();
    if (url && url !== state.url) {
      state.url = url;
      writeState(state);
      console.log('[tunnel] URL publique :', url);
      publishUrl(url);
      clearInterval(poll);
    }
    if (++tries > 60) clearInterval(poll);
  }, 1000);
  poll.unref();
  return child.pid;
}

function start() {
  if (!CFG.enabled) {
    console.log('[tunnel] desactive (PANEL_TUNNEL=0)');
    return;
  }

  const st = readState();
  // IMPORTANT : on charge l'etat AVANT de nettoyer, sinon killStray() ne
  // connait pas le pid a conserver et tue le tunnel en cours -> nouvelle URL
  // a chaque redemarrage du panel (et donc session perdue cote navigateur).
  state = st;

  if (isAlive(st.pid) && isCloudflared(st.pid)) {
    // Le tunnel tourne encore : on le REUTILISE tel quel -> l'URL publique ne
    // change PAS, la session de l'utilisateur reste valide.
    state.url = readUrlFromLog() || st.url;
    writeState(state);
    console.log('[tunnel] tunnel existant reutilise (pid ' + st.pid + ') -> ' + state.url);
    publishUrl(state.url);
    // Nettoie d'eventuels doublons (en conservant le tunnel actif).
    killStray(st.pid);
  } else {
    // Aucun tunnel vivant : on nettoie les orphelins puis on en cree un.
    killStray();
    spawnTunnel();
  }

  if (!watchdog) {
    watchdog = setInterval(() => {
      if (!isAlive(state.pid) || !isCloudflared(state.pid)) {
        console.log('[tunnel] tunnel mort -> redemarrage automatique');
        spawnTunnel();
      }
    }, 15000);
    watchdog.unref();
  }

  // Auto-test : si l'URL publique ne repond plus 3 fois de suite, on recree
  // le tunnel (cas d'un cloudflared vivant mais tunnel casse).
  if (!healthTimer) {
    healthTimer = setInterval(() => {
      const url = getUrl();
      if (!url) return;
      checkUrl(url, (ok) => {
        if (ok) {
          healthFails = 0;
          return;
        }
        healthFails++;
        console.log(`[tunnel] auto-test echoue (${healthFails}/3) pour ${url}`);
        if (healthFails >= 3) {
          healthFails = 0;
          console.log('[tunnel] URL publique injoignable -> recreation du tunnel');
          try {
            if (isAlive(state.pid)) process.kill(state.pid, 'SIGTERM');
          } catch (e) {}
          setTimeout(spawnTunnel, 1500);
        }
      });
    }, 30000);
    healthTimer.unref();
  }

  // Republie l'URL regulierement (les messages ntfy expirent apres 12h).
  if (!republish) {
    republish = setInterval(() => publishUrl(getUrl()), 60 * 60 * 1000);
    republish.unref();
  }
}

function getUrl() {
  return state.url || readUrlFromLog();
}

function getStatus() {
  return {
    running: isAlive(state.pid) && isCloudflared(state.pid),
    pid: state.pid || null,
    url: getUrl(),
    target: TARGET
  };
}

function restart() {
  if (isAlive(state.pid) && isCloudflared(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (e) {}
  }
  setTimeout(spawnTunnel, 1500);
  return true;
}

module.exports = { start, getUrl, getStatus, restart };
