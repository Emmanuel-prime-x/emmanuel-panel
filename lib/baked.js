/**
 * Bots "integres" : dossiers places dans bots/ (ou clones depuis bots.txt) et
 * dont les dependances npm sont installees PENDANT LE BUILD de l'image Docker
 * (scripts/build-bots.sh), sur une machine puissante.
 *
 * Au demarrage du panel, chaque dossier de bots/ devient automatiquement un
 * serveur. Plus aucun "npm install" sur l'offre gratuite de Render (0,1 CPU),
 * et les bots survivent aux redemarrages (ils font partie de l'image).
 *
 * Fichier optionnel bots/<dossier>/panel.json :
 *   { "name": "QUEEN HINA", "startupFile": "index.js", "env": { "FOO": "bar" } }
 * Les secrets (tokens...) se mettent dans les variables d'environnement Render :
 * elles sont transmises automatiquement aux bots.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const BAKED_DIR = path.join(__dirname, '..', 'bots');

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
}

function pickEntry(dir, cfg) {
  if (cfg && cfg.startupFile && fs.existsSync(path.join(dir, cfg.startupFile))) return cfg.startupFile;
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return pkg.main;
  const m = pkg.scripts && pkg.scripts.start && String(pkg.scripts.start).match(/(?:node|nodemon)\s+([^\s&|]+)/);
  if (m && fs.existsSync(path.join(dir, m[1]))) return m[1];
  for (const n of ['index.js', 'bot.js', 'main.js', 'app.js', 'server.js', 'start.js', 'src/bootstrap.js', 'src/index.js']) {
    if (fs.existsSync(path.join(dir, n))) return n;
  }
  const first = fs.readdirSync(dir).find((n) => /\.(js|mjs|cjs)$/.test(n));
  return first || 'index.js';
}

/** Cree / met a jour les serveurs correspondant aux dossiers de bots/. Retourne la liste des ids. */
function provision(log) {
  log = log || console.log;
  const ids = [];
  if (!fs.existsSync(BAKED_DIR)) return ids;
  for (const entry of fs.readdirSync(BAKED_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = entry.name;
    const dir = path.join(BAKED_DIR, folder);
    const cfg = readJson(path.join(dir, 'panel.json')) || {};
    const id = 'b' + crypto.createHash('sha1').update(folder).digest('hex').slice(0, 7);
    const startupFile = pickEntry(dir, cfg);
    const existing = store.getServer(id);
    if (existing) {
      store.updateServer(id, { dir, baked: folder, startupFile: existing.startupFile || startupFile });
    } else {
      store.addServer({
        id,
        name: cfg.name || folder,
        startupFile,
        nodeVersion: 'node',
        env: { NODE_ENV: 'production', ...(cfg.env || {}) },
        autostart: cfg.autostart !== false,
        autorestart: true,
        args: '',
        schedules: [],
        createdAt: Date.now(),
        baked: folder,
        dir
      });
    }
    const hasNm = fs.existsSync(path.join(dir, 'node_modules'));
    log(`[baked] bot integre "${folder}" -> serveur ${id} (entree: ${startupFile}, node_modules: ${hasNm ? 'ok' : 'ABSENT'})`);
    ids.push(id);
  }
  return ids;
}

module.exports = { provision, BAKED_DIR };
