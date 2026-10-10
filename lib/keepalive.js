/**
 * Anti-veille (keep-alive) pour les hebergements qui "endorment" les services
 * gratuits apres quelques minutes sans trafic (ex. Render : 15 min).
 *
 * Le panel se "ping" lui-meme sur son URL publique toutes les 10 minutes :
 * ce trafic entrant empeche la plateforme de l'endormir -> le panel (et les
 * bots qu'il heberge) restent EN LIGNE 24/7.
 *
 * URL publique detectee automatiquement :
 *   - PANEL_PUBLIC_URL (si definie), sinon
 *   - RENDER_EXTERNAL_URL (fournie automatiquement par Render), sinon
 *   - desactive.
 */
const https = require('https');
const http = require('http');

function resolveBaseUrl() {
  const explicit = process.env.PANEL_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const render = process.env.RENDER_EXTERNAL_URL;
  if (render) return render.replace(/\/+$/, '');
  return null;
}

function pingOnce(url) {
  const lib = url.startsWith('https') ? https : http;
  const req = lib.get(url, { timeout: 20000 }, (res) => {
    res.resume();
    console.log(`[keepalive] ping ${url} -> ${res.statusCode}`);
  });
  req.on('timeout', () => { console.log('[keepalive] timeout'); req.destroy(); });
  req.on('error', (e) => console.log('[keepalive] erreur:', e.message));
}

function startKeepAlive() {
  const base = resolveBaseUrl();
  if (!base) {
    console.log('[keepalive] desactive (aucune URL publique detectee)');
    return;
  }
  const url = base + '/api/ping';
  const everyMs = 10 * 60 * 1000; // 10 minutes (< seuil d'endormissement de 15 min)
  // Premier ping apres 2 minutes (laisse le temps au service de demarrer).
  setTimeout(() => pingOnce(url), 2 * 60 * 1000);
  const timer = setInterval(() => pingOnce(url), everyMs);
  if (timer.unref) timer.unref();
  console.log(`[keepalive] actif -> ${url} toutes les 10 min (24/7)`);
}

module.exports = { startKeepAlive };
