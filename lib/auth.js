/**
 * Authentification : hash du mot de passe admin + middleware de protection.
 *
 * Deux modes d'authentification sont supportes :
 *   1. Session (cookie)  -> usage direct du panel (meme origine).
 *   2. Token Bearer signe (HMAC, sans etat) -> usage via le "launcher" statique
 *      (requetes cross-origin) ET persistance de la connexion : le token reste
 *      valide meme apres un redemarrage complet du panel, car il est signe avec
 *      SESSION_SECRET et ne depend d'aucun stockage memoire.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');
const config = require('../config');

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30 jours

/**
 * Initialise les identifiants si absents (premier lancement).
 * Le mot de passe en clair de config.js est hashe une seule fois.
 */
function initAuth() {
  let auth = store.getAuth();
  if (!auth) {
    const hash = bcrypt.hashSync(config.ADMIN.password, 10);
    auth = { username: config.ADMIN.username, passwordHash: hash };
    store.saveAuth(auth);
    console.log(`[AUTH] Identifiants initialises -> utilisateur: ${auth.username}`);
  }
  return auth;
}

function verify(username, password) {
  const auth = store.getAuth();
  if (!auth) return false;
  if (username !== auth.username) return false;
  return bcrypt.compareSync(password, auth.passwordHash);
}

function changePassword(newPassword) {
  const auth = store.getAuth() || {};
  auth.passwordHash = bcrypt.hashSync(newPassword, 10);
  store.saveAuth(auth);
}

/* ---------------- Tokens signes (stateless) ---------------- */

function b64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function hmac(payload) {
  return crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Cree un token signe pour un utilisateur donne. */
function issueToken(username) {
  const body = JSON.stringify({
    u: username,
    exp: Date.now() + TOKEN_TTL,
    n: crypto.randomBytes(8).toString('hex')
  });
  const p = b64urlEncode(body);
  return p + '.' + hmac(p);
}

/** Verifie un token signe et renvoie le nom d'utilisateur, ou null. */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = hmac(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload));
  } catch (e) {
    return null;
  }
  if (!obj || !obj.u || !obj.exp || Date.now() > obj.exp) return null;
  return obj.u;
}

function tokenFromReq(req) {
  const h = (req && req.headers && req.headers['authorization']) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/**
 * Renvoie l'utilisateur authentifie (session OU token Bearer), sinon null.
 * C'est le point d'entree unique utilise par les routes et par Socket.IO.
 */
function isAuthed(req) {
  if (req && req.session && req.session.logged) {
    return req.session.user || 'admin';
  }
  const u = verifyToken(tokenFromReq(req));
  if (u) return u;
  return null;
}

/** Middleware Express : bloque si non connecte. */
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Non authentifie' });
}

module.exports = {
  initAuth,
  verify,
  changePassword,
  requireAuth,
  issueToken,
  verifyToken,
  isAuthed,
  tokenFromReq,
  TOKEN_TTL
};
