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
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Chemin invalide');
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
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        mtime = st.mtimeMs;
        if (e.isFile()) size = st.size;
      } catch (_) {}
      return {
        name: e.name,
        isDir: e.isDirectory(),
        size,
        mtime,
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
  const root = servers.serverDir(id);
  if (/[\\/]/.test(newName) || !newName.trim()) throw new Error('Nom invalide');
  if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error('Chemin invalide');
  if (fs.existsSync(dest)) throw new Error('Un fichier porte deja ce nom');
  fs.renameSync(src, dest);
  return true;
}

/**
 * Extrait un ZIP (manuellement demande par l'utilisateur) dans un dossier du
 * serveur. Protege contre le "zip-slip" (entrees qui sortent du dossier).
 * Si l'archive contient un dossier racine unique (ex. monbot/index.js), son
 * contenu est remonte d'un niveau.
 */
function extractZip(id, zipRel, destRel) {
  const zipPath = safeResolve(id, zipRel);
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) throw new Error('Archive introuvable');
  if (!/\.zip$/i.test(zipPath)) throw new Error('Seuls les fichiers .zip sont supportes');
  const dest = safeResolve(id, destRel || '');
  fs.mkdirSync(dest, { recursive: true });
  const zip = new AdmZip(zipPath);
  const isJunk = (n) => /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(n) || /(^|\/)\._/.test(n);

  const entries = zip.getEntries().filter((e) => !isJunk(e.entryName));
  // Dossier racine unique ?
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const hasRootFiles = entries.some((e) => !e.isDirectory && !e.entryName.includes('/'));
  const strip = tops.size === 1 && !hasRootFiles ? [...tops][0] + '/' : '';

  let count = 0;
  for (const e of entries) {
    let name = e.entryName.replace(/\\/g, '/');
    if (strip && name.startsWith(strip)) name = name.slice(strip.length);
    if (!name) continue;
    const target = path.resolve(dest, name);
    if (target !== dest && !target.startsWith(dest + path.sep)) continue; // zip-slip
    if (e.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
      count++;
    }
  }
  return count;
}

/** Cree une archive .zip a partir d'une liste de chemins relatifs. */
function archive(id, relPaths, destDirRel, name) {
  const dir = safeResolve(id, destDirRel || '');
  const zip = new AdmZip();
  const addPath = (abs, zipBase) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs)) addPath(path.join(abs, n), path.posix.join(zipBase, n));
    } else {
      zip.addLocalFile(abs, path.posix.dirname(zipBase) === '.' ? '' : path.posix.dirname(zipBase), path.posix.basename(zipBase));
    }
  };
  for (const rel of relPaths) {
    const abs = safeResolve(id, rel);
    if (!fs.existsSync(abs)) continue;
    addPath(abs, path.basename(abs));
  }
  let fname = (name || `archive-${Date.now()}`).replace(/[\\/]/g, '_');
  if (!/\.zip$/i.test(fname)) fname += '.zip';
  const out = path.join(dir, fname);
  zip.writeZip(out);
  return path.posix.join(destDirRel || '', fname);
}

/** Deplace des fichiers/dossiers vers un dossier de destination. */
function move(id, relPaths, destRel) {
  const dest = safeResolve(id, destRel || '');
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of relPaths) {
    const src = safeResolve(id, rel);
    const target = path.join(dest, path.basename(src));
    if (target === src) continue;
    if (target.startsWith(src + path.sep)) throw new Error('Impossible de deplacer un dossier dans lui-meme');
    if (fs.existsSync(target)) throw new Error(`"${path.basename(src)}" existe deja dans la destination`);
    fs.renameSync(src, target);
  }
  return true;
}

/** Duplique un fichier ou dossier ("nom copie"). */
function copy(id, relPath) {
  const src = safeResolve(id, relPath);
  const ext = path.extname(src);
  const base = path.basename(src, ext);
  let n = 1;
  let dest;
  do {
    dest = path.join(path.dirname(src), `${base} copie${n > 1 ? ' ' + n : ''}${ext}`);
    n++;
  } while (fs.existsSync(dest));
  fs.cpSync(src, dest, { recursive: true });
  return path.basename(dest);
}

/** Taille totale (octets) d'un dossier. */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch (_) {}
  }
  return total;
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

module.exports = { list, read, write, remove, mkdir, rename, extractZip, archive, move, copy, dirSize, detectEntryPoint, removeStarter, safeResolve };
