/**
 * Planification (schedules) : actions automatiques par serveur.
 *   type "interval" : toutes les N minutes
 *   type "daily"    : chaque jour a HH:MM (heure du serveur / UTC)
 * Actions : start | restart | stop | command (envoie une commande a la console)
 */
const crypto = require('crypto');
const store = require('./store');
const servers = require('./servers');

const ACTIONS = ['start', 'restart', 'stop', 'command'];

function sanitize(input) {
  const s = {
    name: String(input.name || 'Tache').slice(0, 60),
    action: ACTIONS.includes(input.action) ? input.action : 'restart',
    payload: String(input.payload || '').slice(0, 500),
    type: input.type === 'daily' ? 'daily' : 'interval',
    enabled: input.enabled !== false
  };
  if (s.type === 'interval') {
    s.everyMin = Math.max(1, Math.min(10080, parseInt(input.everyMin, 10) || 60));
  } else {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(input.at || ''));
    const h = m ? Math.min(23, +m[1]) : 4;
    const mn = m ? Math.min(59, +m[2]) : 0;
    s.at = String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
  }
  return s;
}

function list(id) {
  const sv = store.getServer(id);
  return (sv && sv.schedules) || [];
}

function add(id, input) {
  const sv = store.getServer(id);
  if (!sv) throw new Error('Serveur introuvable');
  const sch = { id: crypto.randomBytes(4).toString('hex'), lastRun: Date.now(), createdAt: Date.now(), ...sanitize(input) };
  store.updateServer(id, { schedules: [...(sv.schedules || []), sch] });
  return sch;
}

function update(id, sid, patch) {
  const sv = store.getServer(id);
  if (!sv) throw new Error('Serveur introuvable');
  const schedules = (sv.schedules || []).map((s) => (s.id === sid ? { ...s, ...sanitize({ ...s, ...patch }) } : s));
  store.updateServer(id, { schedules });
}

function remove(id, sid) {
  const sv = store.getServer(id);
  if (!sv) return;
  store.updateServer(id, { schedules: (sv.schedules || []).filter((s) => s.id !== sid) });
}

function run(id, sch) {
  servers.pushLog(id, `\x1b[36m[PLANIF] Execution de "${sch.name}" (${sch.action})\x1b[0m`);
  try {
    if (sch.action === 'start') servers.start(id);
    else if (sch.action === 'stop') servers.stop(id, false);
    else if (sch.action === 'restart') servers.restart(id);
    else if (sch.action === 'command' && sch.payload) servers.sendCommand(id, sch.payload);
  } catch (e) {
    servers.pushLog(id, `\x1b[31m[PLANIF] Erreur : ${e.message}\x1b[0m`);
  }
}

function runNow(id, sid) {
  const sch = list(id).find((s) => s.id === sid);
  if (!sch) throw new Error('Tache introuvable');
  run(id, sch);
  markRun(id, sid);
}

function markRun(id, sid) {
  const sv = store.getServer(id);
  if (!sv) return;
  store.updateServer(id, {
    schedules: (sv.schedules || []).map((s) => (s.id === sid ? { ...s, lastRun: Date.now() } : s))
  });
}

function due(sch, now) {
  if (!sch.enabled) return false;
  if (sch.type === 'interval') return now - (sch.lastRun || sch.createdAt || now) >= sch.everyMin * 60000;
  const d = new Date(now);
  const [h, m] = (sch.at || '04:00').split(':').map(Number);
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return now >= slot && (sch.lastRun || 0) < slot;
}

function tick() {
  const now = Date.now();
  let all;
  try {
    all = store.getServers();
  } catch (e) {
    return;
  }
  for (const sv of all) {
    for (const sch of sv.schedules || []) {
      if (due(sch, now)) {
        markRun(sv.id, sch.id);
        run(sv.id, sch);
      }
    }
  }
}

function startScheduler() {
  const t = setInterval(tick, 30000);
  if (t.unref) t.unref();
}

module.exports = { list, add, update, remove, runNow, startScheduler };
