/**
 * Gestionnaire de fichiers par serveur.
 * Toutes les operations sont confinees dans le dossier du serveur (anti path-traversal).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const servers = require('./servers');

/** Resout un chemin relatif en securite dans le dossier du serveur. */
function safeResolve(id, relPath) {
  const root = servers.serverDir(id);
  const target = path.resolve(root, '.' + path.sep + (relPath || ''));
  if (!target.startsWith(root)) throw new Error('Chemin invalide');
  return target;
}

function list(id, relPath) {
  const dir = safeResolve(id, relPath);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = 0;
      try {
        if (e.isFile()) size = fs.statSync(full).size;
      } catch (_) {}
      return {
        name: e.name,
        isDir: e.isDirectory(),
        size,
        path: path.posix.join(relPath || '', e.name)
      };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

function read(id, relPath) {
  const file = safeResolve(id, relPath);
  const stat = fs.statSync(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error('Fichier trop volumineux pour l\'edition (>2Mo)');
  return fs.readFileSync(file, 'utf8');
}

function write(id, relPath, content) {
  const file = safeResolve(id, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function remove(id, relPath) {
  const target = safeResolve(id, relPath);
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function mkdir(id, relPath) {
  const target = safeResolve(id, relPath);
  fs.mkdirSync(target, { recursive: true });
  return true;
}

function rename(id, relPath, newName) {
  const src = safeResolve(id, relPath);
  const dest = path.join(path.dirname(src), newName);
  if (!dest.startsWith(servers.serverDir(id))) throw new Error('Chemin invalide');
  fs.renameSync(src, dest);
  return true;
}

/**
 * Extrait un ZIP (deja sauvegarde sur disque) dans le dossier du serveur.
 * Gere le cas ou l'archive contient un dossier racine unique (ex. monbot/index.js).
 */
function extractZip(id, zipPath, destRel) {
  const dest = safeResolve(id, destRel || '');
  fs.mkdirSync(dest, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dest, true);

  // Si l'archive a cree un unique sous-dossier, on remonte son contenu.
  // On repete l'operation (dossiers imbriques) en ignorant les fichiers systeme.
  const isJunk = (n) => n === '__MACOSX' || n === '.DS_Store' || n.startsWith('._');
  for (let i = 0; i < 5; i++) {
    const entries = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => !isJunk(e.name));
    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());
    if (dirs.length === 1 && files.length === 0) {
      const inner = path.join(dest, dirs[0].name);
      for (const name of fs.readdirSync(inner)) {
        fs.renameSync(path.join(inner, name), path.join(dest, name));
      }
      fs.rmdirSync(inner);
    } else {
      break;
    }
  }
  return list(id, destRel || '');
}

/**
 * Detecte automatiquement le fichier d'entree du bot.
 * Priorite : champ "main" de package.json -> fichiers usuels -> premier .js trouve.
 * Retourne le chemin relatif (ex. "index.js") ou null.
 */
function detectEntryPoint(id, destRel) {
  const root = safeResolve(id, destRel || '');

  // 1) package.json -> main / scripts.start
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main && fs.existsSync(path.join(root, pkg.main))) return pkg.main;
      const startScript = pkg.scripts && pkg.scripts.start;
      if (startScript) {
        // ex. "node bot.js" -> on extrait "bot.js"
        const m = startScript.match(/(?:node|nodemon)\s+([^\s&|]+)/);
        if (m && fs.existsSync(path.join(root, m[1]))) return m[1];
      }
    } catch (e) {}
  }

  // 2) Fichiers usuels
  const common = [
    'index.js', 'bot.js', 'main.js', 'app.js', 'server.js', 'start.js',
    'index.mjs', 'bot.mjs', 'main.mjs', 'index.cjs', 'app.cjs'
  ];
  for (const name of common) {
    if (fs.existsSync(path.join(root, name))) return name;
  }

  // 3) Premier fichier .js / .mjs / .cjs a la racine
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) return e.name;
  }
  return null;
}

/**
 * Supprime le fichier de demarrage par defaut du panel (marque EMMANUEL_PANEL_STARTER)
 * s'il est encore present. Appele apres l'upload d'un vrai bot.
 */
function removeStarter(id) {
  const root = safeResolve(id, '');
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    return removed;
  }
  for (const name of names) {
    const p = path.join(root, name);
    try {
      if (fs.statSync(p).isFile()) {
        const head = fs.readFileSync(p, 'utf8').slice(0, 80);
        if (head.includes('EMMANUEL_PANEL_STARTER')) {
          fs.unlinkSync(p);
          removed.push(name);
        }
      }
    } catch (e) {}
  }
  return removed;
}

module.exports = { list, read, write, remove, mkdir, rename, extractZip, detectEntryPoint, removeStarter, safeResolve };
