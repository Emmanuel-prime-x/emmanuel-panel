/**
 * Mini-client Redis (protocole RESP) SANS dependance : fonctionne avec Upstash,
 * Render Key Value, Redis Cloud, un Redis local... via la variable REDIS_URL
 * (redis://[user:]motdepasse@hote:port/db ou rediss:// pour TLS).
 * Une connexion courte par commande : simple et robuste (les ecritures sont rares).
 */
const net = require('net');
const tls = require('tls');

const URL_STR = process.env.REDIS_URL || '';
const enabled = !!URL_STR;
const TIMEOUT_MS = 6000;
const PREFIX = process.env.REDIS_PREFIX || 'emmanuelpanel:';

function parseUrl() {
  const u = new URL(URL_STR);
  return {
    tls: u.protocol === 'rediss:',
    host: u.hostname,
    port: Number(u.port) || 6379,
    user: decodeURIComponent(u.username || ''),
    pass: decodeURIComponent(u.password || ''),
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0
  };
}

function encode(args) {
  let out = `*${args.length}\r\n`;
  const parts = [Buffer.from(out)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Lit une reponse RESP a partir de buf[pos]. Retourne {v, next} ou null si incomplet. */
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const nl = buf.indexOf('\r\n', pos);
  if (nl === -1) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, nl);
  const next = nl + 2;
  if (type === '+') return { v: line, next };
  if (type === '-') return { v: new Error(line), next };
  if (type === ':') return { v: Number(line), next };
  if (type === '$') {
    const len = Number(line);
    if (len === -1) return { v: null, next };
    if (buf.length < next + len + 2) return null;
    return { v: buf.toString('utf8', next, next + len), next: next + len + 2 };
  }
  if (type === '*') {
    const n = Number(line);
    if (n === -1) return { v: null, next };
    const arr = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      arr.push(r.v);
      p = r.next;
    }
    return { v: arr, next: p };
  }
  throw new Error('Reponse Redis inconnue');
}

/** Envoie une commande (apres AUTH/SELECT) et retourne sa reponse. */
function command(args) {
  return new Promise((resolve, reject) => {
    if (!enabled) return reject(new Error('REDIS_URL non defini'));
    let cfg;
    try {
      cfg = parseUrl();
    } catch (e) {
      return reject(new Error('REDIS_URL invalide'));
    }
    const cmds = [];
    if (cfg.pass) cmds.push(cfg.user ? ['AUTH', cfg.user, cfg.pass] : ['AUTH', cfg.pass]);
    if (cfg.db) cmds.push(['SELECT', cfg.db]);
    cmds.push(args);
    let buf = Buffer.alloc(0);
    let pos = 0;
    let got = 0;
    let finished = false;
    const done = (err, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) {}
      err ? reject(err) : resolve(val);
    };
    const onConnect = () => sock.write(Buffer.concat(cmds.map(encode)));
    const sock = cfg.tls
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, onConnect)
      : net.connect({ host: cfg.host, port: cfg.port }, onConnect);
    const timer = setTimeout(() => done(new Error('Redis : delai depasse')), TIMEOUT_MS);
    sock.on('error', (e) => done(e));
    sock.on('close', () => done(new Error('Redis : connexion fermee')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        for (;;) {
          const r = parse(buf, pos);
          if (!r) return;
          pos = r.next;
          got++;
          if (r.v instanceof Error) return done(r.v);
          if (got === cmds.length) return done(null, r.v);
        }
      } catch (e) {
        done(e);
      }
    });
  });
}

const get = (key) => command(['GET', PREFIX + key]);
const set = (key, value, px) =>
  command(px ? ['SET', PREFIX + key, value, 'PX', Math.max(1000, Math.round(px))] : ['SET', PREFIX + key, value]);
const del = (key) => command(['DEL', PREFIX + key]);

/* Sauvegarde en arriere-plan, une seule ecriture en attente par cle (derniere valeur). */
const waiting = new Map();
let lastErr = 0;
function save(key, value) {
  if (!enabled) return;
  const had = waiting.has(key);
  waiting.set(key, value);
  if (had) return;
  setTimeout(async () => {
    const v = waiting.get(key);
    waiting.delete(key);
    try {
      await set(key, v);
    } catch (e) {
      if (Date.now() - lastErr > 60000) {
        lastErr = Date.now();
        console.error('[redis] ecriture impossible :', e.message);
      }
    }
  }, 300);
}

module.exports = { enabled, get, set, del, save, command };
