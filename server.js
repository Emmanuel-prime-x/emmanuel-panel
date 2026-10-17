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
  const { startupFile, env, autostart } = req.body || {};
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
    ...(typeof autostart === 'boolean' ? { autostart } : {})
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

/** Upload d'un ZIP puis extraction automatique dans le dossier du serveur. */
app.post(
  '/api/servers/:id/files/upload',
  auth.requireAuth,
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    const id = req.params.id;
    const destRel = req.body.path || '';
    try {
      if (req.file.originalname.toLowerCase().endsWith('.zip')) {
        // Supprime d'abord le fichier de demarrage par defaut du panel
        // (sinon il fausse la detection du dossier racine unique du ZIP).
        const removedStarter = files.removeStarter(id);

        files.extractZip(id, req.file.path, destRel);
        fs.unlinkSync(req.file.path);

        if (removedStarter.length) {
          servers.pushLog(id, `\x1b[36m[PANEL] Fichier temporaire supprime : ${removedStarter.join(', ')}\x1b[0m`);
        }

        // Detection automatique du fichier d'entree
        const entry = files.detectEntryPoint(id, destRel);
        let updated = null;
        if (entry) {
          updated = store.updateServer(id, { startupFile: entry });
          servers.pushLog(id, `\x1b[36m[PANEL] Fichier d'entree detecte : ${entry}\x1b[0m`);
        } else {
          servers.pushLog(id, `\x1b[33m[PANEL] Aucun fichier .js detecte. Verifie ton ZIP.\x1b[0m`);
        }

        // Installation automatique des dependances (npm install), en tache de fond.
        servers
          .installDependencies(id)
          .then((ok) => {
            if (ok) servers.pushLog(id, `\x1b[36m[PANEL] Pret : clique sur Demarrer.\x1b[0m`);
          })
          .catch((e) => servers.pushLog(id, `\x1b[31m[PANEL] Erreur d'installation : ${e.message}\x1b[0m`));

        return res.json({ ok: true, extracted: true, entry, server: updated });
      }
      // Fichier simple : on le deplace tel quel
      const dest = files.safeResolve(id, path.posix.join(destRel, req.file.originalname));
      fs.renameSync(req.file.path, dest);
      res.json({ ok: true, extracted: false });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Installe manuellement les dependances npm du bot. */
app.post('/api/servers/:id/install', auth.requireAuth, async (req, res) => {
  if (!store.getServer(req.params.id)) return res.status(404).json({ error: 'Serveur introuvable' });
  try {
    const ok = await servers.installDependencies(req.params.id);
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
    // Rejoue l'historique des logs
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
