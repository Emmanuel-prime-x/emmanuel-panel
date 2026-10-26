/**
 * EMMANUEL PANEL - Panel de type Pterodactyl pour bot WhatsApp Baileys.
 * Serveur principal : API REST + console temps reel (Socket.IO).
 *
 * Ce serveur est concu pour tourner EN ARRIERE-PLAN de facon permanente :
 *   - il est supervise par supervisord (voir /etc/supervisor/conf.d/emmanuel-panel.conf)
 *     qui le redemarre automatiquement en cas de crash ;
 *   - il ne s'arrete PAS sur une exception non geree (uncaughtException) ;
 *   - il reessaie de se lier au port si celui-ci est momentanement occupe ;
 *   - il nettoie les processus de bots orphelins au demarrage.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Server } = require('socket.io');

const config = require('./config');
const store = require('./lib/store');
const auth = require('./lib/auth');
const servers = require('./lib/servers');
const files = require('./lib/files');
const tunnel = require('./lib/tunnel');
const FileSessionStore = require('./lib/session-store');
const keepalive = require('./lib/keepalive');
const backups = require('./lib/backups');
const scheduler = require('./lib/scheduler');

/* ---------------- Robustesse : ne jamais mourir sur une erreur isolee ---------------- */
process.on('uncaughtException', (err) => {
  console.error('[panel] uncaughtException (ignoree, le panel reste en ligne):', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[panel] unhandledRejection (ignoree, le panel reste en ligne):', reason);
});
process.on('warning', (w) => {
  if (w && w.name !== 'ExperimentalWarning') console.warn('[panel] warning:', w.message);
});

/* ---------------- Init ---------------- */
store.ensureDirs();
auth.initAuth();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

/* ---------------- CORS (indispensable pour le launcher statique cross-origin) ---------------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Derriere le tunnel Cloudflare / un reverse proxy : necessaire pour que les
// cookies "secure" et l'IP reelle fonctionnent correctement.
app.set('trust proxy', 1);

/* ---------------- Session (partagee avec Socket.IO) ---------------- */
const sessionMiddleware = session({
  // Store PERSISTANT : la connexion survit aux redemarrages du panel.
  store: new FileSessionStore({
    dir: path.join(config.DATA_DIR, 'sessions'),
    ttl: 1000 * 60 * 60 * 24 * 30
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // rolling : le cookie est renouvele a chaque requete -> on reste connecte
  // tant qu'on utilise le panel.
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 jours
  }
});
app.use(sessionMiddleware);

/* ---------------- Upload (multer) ---------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: config.MAX_UPLOAD } });

/* ---------------- Health / ping (PUBLIC, sans auth) ---------------- */
// Utilise par le launcher pour detecter que le backend est joignable.
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, brand: config.BRAND, uptime: Math.floor(process.uptime()), time: Date.now() });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    brand: config.BRAND,
    uptime: Math.floor(process.uptime()),
    pid: process.pid,
    port: config.PORT,
    tunnel: tunnel.getStatus(),
    servers: store.getServers().map((s) => ({ id: s.id, name: s.name, status: servers.getStatus(s.id) }))
  });
});

/* ---------------- Auth routes ---------------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (auth.verify(username, password)) {
    req.session.logged = true;
    req.session.user = username;
    // Token signe : permet au launcher (cross-origin) de rester connecte.
    const token = auth.issueToken(username);
    return res.json({ ok: true, user: username, token });
  }
  return res.status(401).json({ error: 'Identifiants invalides' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const publicUrl = tunnel.getUrl();
  const user = auth.isAuthed(req);
  const base = {
    brand: config.BRAND,
    owner: config.OWNER,
    ownerTg: config.OWNER_TG,
    publicUrl
  };
  if (user) {
    return res.json({
      ...base,
      logged: true,
      user,
      // On renvoie un token frais : le launcher le stocke et s'en sert ensuite.
      token: auth.issueToken(user)
    });
  }
  return res.json({ ...base, logged: false });
});

/* ---------------- Tunnel public ---------------- */
app.get('/api/tunnel', auth.requireAuth, (req, res) => {
  res.json(tunnel.getStatus());
});

app.post('/api/tunnel/restart', auth.requireAuth, (req, res) => {
  tunnel.restart();
  res.json({ ok: true });
});

app.post('/api/password', auth.requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court' });
  auth.changePassword(password);
  res.json({ ok: true });
});

/* ---------------- Servers routes ---------------- */
app.get('/api/servers', auth.requireAuth, (req, res) => {
  const list = store.getServers().map((s) => ({ ...s, status: servers.getStatus(s.id) }));
  res.json(list);
});

app.post('/api/servers', auth.requireAuth, (req, res) => {
  const { name, startupFile, nodeVersion, env } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  let parsedEnv = { NODE_ENV: 'production' };
  if (env) {
    try {
      parsedEnv = typeof env === 'string' ? JSON.parse(env) : env;
    } catch (e) {
      return res.status(400).json({ error: 'Variables d\'environnement JSON invalides' });
    }
  }
  const s = servers.createServer({ name, startupFile, nodeVersion, env: parsedEnv });
  res.json(s);
});

app.get('/api/servers/:id', auth.requireAuth, (req, res) => {
  const s = store.getServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json({ ...s, status: servers.getStatus(s.id), logs: servers.getLogs(s.id) });
});

app.delete('/api/servers/:id', auth.requireAuth, (req, res) => {
  servers.deleteServer(req.params.id);
  try {
    backups.removeAll(req.params.id);
  } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/servers/:id/power', auth.requireAuth, (req, res) => {
  const { action } = req.body || {};
  const id = req.params.id;
  if (!store.getServer(id)) return res.status(404).json({ error: 'Serveur introuvable' });
  try {
    switch (action) {
      case 'start':
        servers.start(id);
        break;
      case 'stop':
        servers.stop(id, false);
        break;
      case 'restart':
        servers.restart(id);
        break;
      case 'kill':
        servers.kill(id);
        break;
      default:
        return res.status(400).json({ error: 'Action inconnue' });
    }
    res.json({ ok: true, status: servers.getStatus(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/servers/:id/stats', auth.requireAuth, async (req, res) => {
  res.json(await servers.getStats(req.params.id));
});

app.post('/api/servers/:id/command', auth.requireAuth, (req, res) => {
  const { command } = req.body || {};
  const ok = servers.sendCommand(req.params.id, command || '');
  res.json({ ok });
});

app.put('/api/servers/:id/startup', auth.requireAuth, (req, res) => {
  const { startupFile, env, autostart, autorestart, args } = req.body || {};
  let parsedEnv;
  if (env) {
    try {
      parsedEnv = typeof env === 'string' ? JSON.parse(env) : env;
    } catch (e) {
      return res.status(400).json({ error: 'JSON invalide' });
    }
  }
  const updated = store.updateServer(req.params.id, {
    ...(startupFile ? { startupFile } : {}),
    ...(parsedEnv ? { env: parsedEnv } : {}),
    ...(typeof autostart === 'boolean' ? { autostart } : {}),
    ...(typeof autorestart === 'boolean' ? { autorestart } : {}),
    ...(typeof args === 'string' ? { args: args.slice(0, 200) } : {})
  });
  res.json(updated);
});

/* ---------------- Files routes ---------------- */
app.get('/api/servers/:id/files', auth.requireAuth, (req, res) => {
  try {
    res.json(files.list(req.params.id, req.query.path || ''));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/servers/:id/files/read', auth.requireAuth, (req, res) => {
  try {
    res.json({ content: files.read(req.params.id, req.query.path) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/servers/:id/files/write', auth.requireAuth, (req, res) => {
  try {
    files.write(req.params.id, req.body.path, req.body.content || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/servers/:id/files/mkdir', auth.requireAuth, (req, res) => {
  try {
    files.mkdir(req.params.id, req.body.path);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/servers/:id/files/rename', auth.requireAuth, (req, res) => {
  try {
    files.rename(req.params.id, req.body.path, req.body.newName);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/servers/:id/files', auth.requireAuth, (req, res) => {
  try {
    files.remove(req.params.id, req.query.path);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Upload d'un ou plusieurs fichiers dans le dossier courant.
 * Les archives .zip ne sont PAS extraites automatiquement : l'extraction se
 * fait a la demande (bouton « Décompresser » du gestionnaire de fichiers).
 */
app.post(
  '/api/servers/:id/files/upload',
  auth.requireAuth,
  upload.array('file', 50),
  (req, res) => {
    const list = req.files || [];
    if (!list.length) return res.status(400).json({ error: 'Aucun fichier' });
    const id = req.params.id;
    if (!store.getServer(id)) {
      list.forEach((f) => fs.rmSync(f.path, { force: true }));
      return res.status(404).json({ error: 'Serveur introuvable' });
    }
    const destRel = req.body.path || '';
    try {
      const names = [];
      for (const f of list) {
        const clean = path.basename(f.originalname).replace(/[\u0000-\u001f]/g, '');
        const dest = files.safeResolve(id, path.posix.join(destRel, clean));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f.path, dest);
        fs.rmSync(f.path, { force: true });
        names.push(clean);
      }
      files.removeStarter(id);
      servers.pushLog(id, `\x1b[36m[PANEL] Fichier(s) envoye(s) : ${names.join(', ')}\x1b[0m`);
      res.json({ ok: true, names });
    } catch (e) {
      list.forEach((f) => fs.rmSync(f.path, { force: true }));
      res.status(500).json({ error: e.message });
    }
  }
);

/** Telecharge un fichier du serveur. */
app.get('/api/servers/:id/files/download', auth.requireAuth, (req, res) => {
  try {
    const abs = files.safeResolve(req.params.id, req.query.path || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'Fichier introuvable' });
    res.download(abs);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Decompresse manuellement une archive .zip. */
app.post('/api/servers/:id/files/unarchive', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  try {
    const { path: zipRel, dest } = req.body || {};
    const removed = files.removeStarter(id);
    const destRel = dest !== undefined ? dest : path.posix.dirname(zipRel || '.') === '.' ? '' : path.posix.dirname(zipRel);
    const count = files.extractZip(id, zipRel, destRel);
    servers.pushLog(id, `\x1b[36m[PANEL] Archive decompressee : ${path.posix.basename(zipRel)} (${count} fichiers)\x1b[0m`);
    if (removed.length) servers.pushLog(id, `\x1b[36m[PANEL] Fichier temporaire supprime : ${removed.join(', ')}\x1b[0m`);
    const entry = files.detectEntryPoint(id, '');
    let server = null;
    if (entry) {
      server = store.updateServer(id, { startupFile: entry });
      servers.pushLog(id, `\x1b[36m[PANEL] Fichier d'entree detecte : ${entry}\x1b[0m`);
    }
    res.json({ ok: true, count, entry, server });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Compresse des fichiers/dossiers en .zip. */
app.post('/api/servers/:id/files/archive', auth.requireAuth, (req, res) => {
  try {
    const { paths, dir, name } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'Rien a compresser' });
    res.json({ ok: true, file: files.archive(req.params.id, paths, dir || '', name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/servers/:id/files/move', auth.requireAuth, (req, res) => {
  try {
    files.move(req.params.id, req.body.paths || [], req.body.dest || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/servers/:id/files/copy', auth.requireAuth, (req, res) => {
  try {
    res.json({ ok: true, name: files.copy(req.params.id, req.body.path) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Suppression groupee. */
app.post('/api/servers/:id/files/delete', auth.requireAuth, (req, res) => {
  try {
    (req.body.paths || []).forEach((p) => files.remove(req.params.id, p));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- Parametres / reinstallation ---------------- */
app.put('/api/servers/:id/settings', auth.requireAuth, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const s = store.updateServer(req.params.id, { name });
  if (!s) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json(s);
});

/** Vide tous les fichiers du serveur (fichier de demarrage par defaut recree). */
app.post('/api/servers/:id/reinstall', auth.requireAuth, (req, res) => {
  const id = req.params.id;
  const s = store.getServer(id);
  if (!s) return res.status(404).json({ error: 'Serveur introuvable' });
  servers.stop(id, true);
  const dir = servers.serverDir(id);
  try {
    for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    servers.writeStarter(id);
    servers.pushLog(id, `\x1b[33m[PANEL] Serveur reinitialise : tous les fichiers ont ete supprimes.\x1b[0m`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Planification ---------------- */
app.get('/api/servers/:id/schedules', auth.requireAuth, (req, res) => res.json(scheduler.list(req.params.id)));
app.post('/api/servers/:id/schedules', auth.requireAuth, (req, res) => {
  try {
    res.json(scheduler.add(req.params.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/servers/:id/schedules/:sid', auth.requireAuth, (req, res) => {
  try {
    scheduler.update(req.params.id, req.params.sid, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/servers/:id/schedules/:sid/run', auth.requireAuth, (req, res) => {
  try {
    scheduler.runNow(req.params.id, req.params.sid);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/servers/:id/schedules/:sid', auth.requireAuth, (req, res) => {
  scheduler.remove(req.params.id, req.params.sid);
  res.json({ ok: true });
});

/* ---------------- Sauvegardes ---------------- */
app.get('/api/servers/:id/backups', auth.requireAuth, (req, res) => res.json(backups.list(req.params.id)));
app.post('/api/servers/:id/backups', auth.requireAuth, (req, res) => {
  try {
    res.json(backups.create(req.params.id, (req.body || {}).label));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/servers/:id/backups/:name/download', auth.requireAuth, (req, res) => {
  try {
    res.download(backups.filePath(req.params.id, req.params.name));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});
app.post('/api/servers/:id/backups/:name/restore', auth.requireAuth, (req, res) => {
  try {
    backups.restore(req.params.id, req.params.name);
    servers.pushLog(req.params.id, `\x1b[33m[PANEL] Sauvegarde restauree : ${req.params.name}\x1b[0m`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/servers/:id/backups/:name', auth.requireAuth, (req, res) => {
  try {
    backups.remove(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

/** Installe manuellement les dependances npm du bot. */
app.post('/api/servers/:id/install', auth.requireAuth, async (req, res) => {
  if (!store.getServer(req.params.id)) return res.status(404).json({ error: 'Serveur introuvable' });
  try {
    const pk = (req.body || {}).packages;
    const ok = pk ? await servers.installPackages(req.params.id, pk) : await servers.installDependencies(req.params.id);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Re-detecte le fichier d'entree et met a jour la config de demarrage. */
app.post('/api/servers/:id/detect', auth.requireAuth, (req, res) => {
  if (!store.getServer(req.params.id)) return res.status(404).json({ error: 'Serveur introuvable' });
  const entry = files.detectEntryPoint(req.params.id, '');
  if (!entry) return res.status(404).json({ error: 'Aucun fichier .js detecte' });
  const updated = store.updateServer(req.params.id, { startupFile: entry });
  res.json({ ok: true, entry, server: updated });
});

/* ---------------- Statique ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------- Socket.IO (console temps reel) ---------------- */
// On partage la session Express avec Socket.IO (cookie) et on accepte aussi
// le token Bearer envoye par le launcher via `auth.token`.
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const req = socket.request;
  const token = (socket.handshake.auth && socket.handshake.auth.token) || null;
  if ((req.session && req.session.logged) || auth.verifyToken(token)) return next();
  // Non authentifie : on refuse la connexion (les logs peuvent etre sensibles).
  return next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.on('join', ({ id }) => {
    if (!id) return;
    socket.join(`server:${id}`);
    // Rejoue l'historique des logs (le client vide d'abord sa console : pas de doublons)
    socket.emit('console-reset', { id });
    servers.getLogs(id).forEach((line) => socket.emit('console', { id, line }));
    socket.emit('status', { id, status: servers.getStatus(id) });
  });

  socket.on('command', ({ id, command }) => {
    servers.sendCommand(id, command);
  });

  socket.on('leave', ({ id }) => {
    socket.leave(`server:${id}`);
  });
});

// Diffusion des sorties process vers les rooms concernees
servers.bus.on('output', ({ id, line }) => {
  io.to(`server:${id}`).emit('console', { id, line });
});
servers.bus.on('status', ({ id, status }) => {
  io.to(`server:${id}`).emit('status', { id, status });
});

/* ---------------- Start (avec nouvelle tentative si le port est occupe) ---------------- */
let started = false;
function onListening() {
  if (started) return;
  started = true;
  console.log('==================================================');
  console.log(`  ${config.BRAND} demarre sur le port ${config.PORT} (pid ${process.pid})`);
  console.log(`  Owner : ${config.OWNER} (${config.OWNER_TG})`);
  console.log('==================================================');

  // Lance (ou reutilise) le tunnel public Cloudflare
  try {
    tunnel.start();
  } catch (e) {
    console.error('[tunnel] erreur au demarrage :', e.message);
  }

  // Nettoie les bots orphelins d'une instance precedente, puis relance ceux
  // marques "autostart" (survit aux redemarrages du panel).
  try {
    servers.killOrphans();
  } catch (e) {
    console.error('[boot] erreur nettoyage orphelins :', e.message);
  }
  try {
    servers.restoreOnBoot();
  } catch (e) {
    console.error('[boot] erreur relance automatique :', e.message);
  }
}

function listenWithRetry(attempt) {
  attempt = attempt || 1;
  const onError = (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt <= 60) {
      console.error(`[panel] port ${config.PORT} deja utilise (tentative ${attempt}) -> nouvel essai dans 2s`);
      setTimeout(() => listenWithRetry(attempt + 1), 2000);
    } else {
      console.error('[panel] erreur fatale du serveur :', (err && err.message) || err);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(config.PORT, () => {
    server.removeListener('error', onError);
    onListening();
  });
}

listenWithRetry(1);

/* ---------------- Anti-veille 24/7 (self-ping) ---------------- */
// Empeche les hebergeurs gratuits (Render, etc.) d'endormir le service.
keepalive.startKeepAlive();
scheduler.startScheduler();

/* ---------------- Arret propre ---------------- */
function shutdown(sig) {
  console.log(`[panel] signal ${sig} recu -> arret propre`);
  try {
    servers.stopAll();
  } catch (e) {}
  try {
    io.close();
  } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
