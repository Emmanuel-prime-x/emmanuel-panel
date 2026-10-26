/* ============================================================
   EMMANUEL PANEL - Client
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let socket = null;
let currentServer = null;
let currentPath = '';
let statsTimer = null;

/* ---------------- Resolution du backend ---------------- */
// Le panel peut etre servi :
//   - par le backend lui-meme (meme origine)  -> API_BASE = ''
//   - par un hebergeur statique (URL STABLE)  -> API_BASE = URL du backend,
//     trouvee automatiquement via un canal public (ntfy.sh).
// Ainsi, l'URL que tu ouvres ne change JAMAIS, meme si le backend redemarre.
const NTFY_TOPIC = 'emmanuel-panel-9f4a2c7b';
let API_BASE = '';
let BACKEND_READY = false;
let TOKEN = null;
try { TOKEN = localStorage.getItem('panel_token') || null; } catch (e) { TOKEN = null; }

function setToken(t) {
  TOKEN = t || null;
  try {
    if (t) localStorage.setItem('panel_token', t);
    else localStorage.removeItem('panel_token');
  } catch (e) {}
}

function apiUrl(url) {
  const q = String(url).replace(/^\/+/, '');
  return API_BASE ? API_BASE.replace(/\/+$/, '') + '/' + q : q;
}

async function fetchBackendFromNtfy() {
  const res = await fetch('https://ntfy.sh/' + NTFY_TOPIC + '/json?poll=1&_=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('ntfy ' + res.status);
  const txt = await res.text();
  const msgs = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && o.event === 'message' && o.message) msgs.push(o); } catch (e) {}
  }
  msgs.sort((a, b) => (b.time || 0) - (a.time || 0));
  for (const m of msgs) {
    const u = String(m.message).trim();
    if (/^https?:\/\/[a-z0-9.-]+/i.test(u)) return u;
  }
  return null;
}

async function pingBase(base) {
  try {
    const r = await fetch((base ? base.replace(/\/+$/, '') : '') + '/api/ping?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// Determine l'URL du backend. Retourne true si trouve et joignable.
async function resolveBackend() {
  if (await pingBase('')) { API_BASE = ''; BACKEND_READY = true; return true; }
  try {
    const url = await fetchBackendFromNtfy();
    if (url && (await pingBase(url))) { API_BASE = url; BACKEND_READY = true; return true; }
  } catch (e) {}
  BACKEND_READY = false;
  return false;
}

/* ---------------- Helpers ---------------- */
async function api(url, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const init = Object.assign({}, opts, { headers, credentials: 'include' });
  let res;
  try {
    res = await fetch(apiUrl(url), init);
  } catch (netErr) {
    // Le backend a peut-etre change d'adresse (redemarrage) : on re-resout.
    if (await resolveBackend()) {
      res = await fetch(apiUrl(url), init);
    } else {
      throw new Error('BACKEND_UNAVAILABLE');
    }
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('BACKEND_UNAVAILABLE');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !String(url).includes('/api/login')) {
    handleSessionLost();
    const e = new Error('Session expirée — reconnecte-toi.');
    e.code = 401;
    throw e;
  }
  if (!res.ok) throw new Error(data.error || 'Erreur serveur');
  return data;
}

/** Reaffiche l'ecran de connexion quand la session n'est plus valide. */
function handleSessionLost() {
  if (window._sessionLost) return;
  window._sessionLost = true;
  setToken(null);
  try {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  } catch (e) {}
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  const appView = $('#appView');
  if (appView) appView.classList.remove('active');
  const loginView = $('#loginView');
  if (loginView) loginView.style.display = '';
  const err = $('#loginErr');
  if (err) err.textContent = 'Ta session a expiré. Reconnecte-toi.';
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 3200);
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtUptime(s) {
  if (!s) return '0s';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
}

/* ---------------- Auth ---------------- */
function showStartingBanner() {
  if ($('#backendBanner')) return;
  const div = document.createElement('div');
  div.id = 'backendBanner';
  div.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a1d00;color:#ffd28a;' +
    'border-bottom:1px solid #7a4a00;padding:10px 16px;font-size:13px;text-align:center;line-height:1.5';
  div.innerHTML =
    '⏳ <b>Connexion au panel…</b> Le serveur démarre ou redémarre. Cette page se reconnectera ' +
    'automatiquement — patiente quelques secondes.';
  document.body.appendChild(div);
}
function hideStartingBanner() {
  const b = $('#backendBanner');
  if (b) b.remove();
}

async function checkSession() {
  const ok = await resolveBackend();
  if (!ok) {
    showStartingBanner();
    // Reessaie en boucle : le backend peut etre en cours de redemarrage.
    if (!window._resolveTimer) {
      window._resolveTimer = setInterval(async () => {
        if (await resolveBackend()) {
          clearInterval(window._resolveTimer);
          window._resolveTimer = null;
          hideStartingBanner();
          checkSession();
        }
      }, 4000);
    }
    return;
  }
  hideStartingBanner();
  try {
    const me = await api('/api/me');
    if (me.token) setToken(me.token);
    if (me.brand) {
      $('#loginBrand').textContent = me.brand;
      $('#topBrand').textContent = me.brand;
    }
    if (me.owner) {
      $('#ownerLink').textContent = me.owner;
      $('#ownerLink').href = me.ownerTg || '#';
    }
    if (me.logged) showApp();
  } catch (err) {
    if (err.message === 'BACKEND_UNAVAILABLE') showStartingBanner();
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  $('#loginBtn').disabled = true;
  try {
    if (!BACKEND_READY) await resolveBackend();
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPass').value })
    });
    if (r.token) setToken(r.token);
    showApp();
  } catch (err) {
    $('#loginErr').textContent =
      err.message === 'BACKEND_UNAVAILABLE'
        ? 'Serveur du panel en cours de démarrage. Patiente quelques secondes puis réessaie.'
        : err.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

function showApp() {
  window._sessionLost = false;
  $('#loginView').style.display = 'none';
  $('#appView').classList.add('active');
  initSocket();
  loadServers();
  refreshPubUrl();
  if (!window._pubTimer) window._pubTimer = setInterval(refreshPubUrl, 30000);
  // Verifie regulierement que la session est toujours valide.
  if (!window._sessTimer) window._sessTimer = setInterval(checkAlive, 45000);
}

/** Verifie que la session est toujours valide (sinon -> ecran de connexion). */
async function checkAlive() {
  try {
    const me = await api('/api/me');
    if (!me.logged) handleSessionLost();
  } catch (e) {
    /* reseau indisponible : on ne deconnecte pas pour un simple hoquet */
  }
}

/* ---------------- URL publique ---------------- */
async function refreshPubUrl() {
  try {
    const me = await api('/api/me');
    const a = $('#pubUrl');
    if (me && me.publicUrl) {
      a.href = me.publicUrl;
      a.textContent = me.publicUrl.replace(/^https?:\/\//, '');
      a.style.display = '';
    } else {
      a.style.display = 'none';
    }
  } catch (e) {}
}

/* ---------------- Socket.IO ---------------- */
function initSocket() {
  if (socket) return;
  if (typeof io === 'undefined') return;
  const opts = { auth: { token: TOKEN }, transports: ['websocket', 'polling'] };
  socket = API_BASE ? io(API_BASE, opts) : io(opts);

  socket.on('connect', () => {
    if (currentServer) socket.emit('join', { id: currentServer.id });
  });
  socket.on('connect_error', () => {});
  socket.on('console-reset', ({ id }) => {
    if (currentServer && currentServer.id === id) $('#console').innerHTML = '';
  });
  socket.on('console', ({ id, line }) => {
    if (currentServer && currentServer.id === id) appendConsole(line);
  });
  socket.on('status', ({ id, status }) => {
    if (currentServer && currentServer.id === id) updateStatusUI(status);
  });
}

/* ---------------- Console (couleurs ANSI) ---------------- */
const ANSI_COLORS = {
  30: '#6b7686', 31: '#ff6b6b', 32: '#3ddc97', 33: '#ffc857', 34: '#6ea8ff', 35: '#d68cff', 36: '#4fd8e6', 37: '#d5dde8',
  90: '#7d8898', 91: '#ff8585', 92: '#6df0b4', 93: '#ffd97a', 94: '#8fbaff', 95: '#e3a8ff', 96: '#7fe6f0', 97: '#ffffff'
};
function ansiToHtml(text) {
  let out = '';
  let open = false;
  let last = 0;
  const re = /\u001b\[([0-9;]*)m/g;
  let m;
  const esc = (t) => escapeHtml(t.replace(/[\u0000-\u0008\u000b-\u001f]/g, ''));
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    if (open) { out += '</span>'; open = false; }
    let style = '';
    for (const c of m[1].split(';').map(Number)) {
      if (ANSI_COLORS[c]) style += 'color:' + ANSI_COLORS[c] + ';';
      else if (c === 1) style += 'font-weight:700;';
    }
    if (style) { out += '<span style="' + style + '">'; open = true; }
  }
  out += esc(text.slice(last));
  if (open) out += '</span>';
  return out;
}

function appendConsole(line) {
  const c = $('#console');
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = ansiToHtml(line);
  c.appendChild(div);
  while (c.childElementCount > 1000) c.removeChild(c.firstChild);
  if (nearBottom) c.scrollTop = c.scrollHeight;
}
$('#clearConsole').addEventListener('click', () => { $('#console').innerHTML = ''; });

$('#cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#cmdInput');
  const cmd = input.value.trim();
  if (!cmd || !currentServer) return;
  if (socket) socket.emit('command', { id: currentServer.id, command: cmd });
  else api(`/api/servers/${currentServer.id}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) }).catch(() => {});
  input.value = '';
});

/* ---------------- Navigation / menu ---------------- */
function openSidebar(v) {
  $('#sidebar').classList.toggle('open', v);
  $('#overlay').classList.toggle('open', v);
}
$('#burger').addEventListener('click', () => openSidebar(!$('#sidebar').classList.contains('open')));
$('#overlay').addEventListener('click', () => openSidebar(false));

function showList() {
  if (currentServer && socket) socket.emit('leave', { id: currentServer.id });
  stopStats();
  currentServer = null;
  $('#serverView').style.display = 'none';
  $('#listView').style.display = 'block';
  $('#serverNav').style.display = 'none';
  $('#navServers').classList.add('active');
  $('#mobTitle').textContent = 'Mes serveurs';
  $('#mobPill').style.display = 'none';
  openSidebar(false);
  loadServers();
}
$('#navServers').addEventListener('click', (e) => { e.preventDefault(); showList(); });

function setTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('#serverNav .nav-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'files') loadFiles(currentPath);
  if (name === 'schedules') loadSchedules();
  if (name === 'backups') loadBackups();
  if (name === 'console') { const c = $('#console'); c.scrollTop = c.scrollHeight; }
  const strip = $('.tab.active');
  if (strip && strip.scrollIntoView) strip.scrollIntoView({ block: 'nearest', inline: 'center' });
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$$('#serverNav .nav-item').forEach((t) =>
  t.addEventListener('click', (e) => { e.preventDefault(); $('#navServers').classList.remove('active'); setTab(t.dataset.tab); openSidebar(false); })
);

/* ---------------- Liste des serveurs ---------------- */
async function loadServers() {
  try {
    const list = await api('/api/servers');
    const grid = $('#serverGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Aucun serveur pour le moment.<br>Clique sur « + Nouveau serveur » pour commencer.</div>';
      return;
    }
    grid.innerHTML = list.map((s) => `
      <div class="card" data-id="${escapeAttr(s.id)}">
        <div class="top">
          <div class="name"><span class="status-dot ${escapeAttr(s.status)}"></span><span>${escapeHtml(s.name)}</span></div>
          <span class="status-pill ${escapeAttr(s.status)}">${escapeHtml(s.status)}</span>
        </div>
        <div class="meta">Fichier : ${escapeHtml(s.startupFile || 'index.js')}</div>
        <div class="meta">ID : ${escapeHtml(s.id)}</div>
      </div>`).join('');
    $$('#serverGrid .card').forEach((el) => el.addEventListener('click', () => openServer(el.dataset.id)));
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- Vue serveur ---------------- */
async function openServer(id) {
  try {
    const s = await api('/api/servers/' + id);
    currentServer = s;
    currentPath = '';
    selected.clear();
    histCpu.length = 0; histRam.length = 0;
    $('#listView').style.display = 'none';
    $('#serverView').style.display = 'block';
    $('#serverNav').style.display = '';
    $('#serverNavTitle').textContent = s.name;
    $('#mobTitle').textContent = s.name;
    fillServerInfo(s);
    $('#console').innerHTML = '';
    (s.logs || []).forEach(appendConsole);
    updateStatusUI(s.status);
    setTab('console');
    $('#navServers').classList.remove('active');
    if (socket) socket.emit('join', { id });
    startStats();
  } catch (err) {
    toast(err.message, true);
  }
}

function fillServerInfo(s) {
  $('#svNameText').textContent = s.name;
  $('#svSub').textContent = 'ID : ' + s.id + ' · Fichier : ' + (s.startupFile || 'index.js');
  $('#serverNavTitle').textContent = s.name;
  $('#mobTitle').textContent = s.name;
  $('#startupFile').value = s.startupFile || 'index.js';
  $('#startupArgs').value = s.args || '';
  renderEnvRows(s.env || {});
  $('#autostartChk').checked = s.autostart !== false;
  $('#autorestartChk').checked = s.autorestart !== false;
  $('#setName').value = s.name;
  $('#setId').textContent = s.id;
  $('#setDir').textContent = '/servers/' + s.id;
}

function updateStatusUI(status) {
  $('#svDot').className = 'status-dot ' + status;
  const p = $('#stStatus');
  p.className = 'status-pill ' + status;
  p.textContent = status;
  const m = $('#mobPill');
  m.className = 'status-pill ' + status;
  m.textContent = status;
  m.style.display = currentServer ? '' : 'none';
}

/* ---------------- Power ---------------- */
const POWER_LABELS = { start: 'Démarrage...', stop: 'Arrêt...', restart: 'Redémarrage...', kill: 'Processus tué' };
async function power(action) {
  if (!currentServer) return;
  try {
    await api(`/api/servers/${currentServer.id}/power`, { method: 'POST', body: JSON.stringify({ action }) });
    toast(POWER_LABELS[action] || action);
  } catch (err) {
    toast(err.message, true);
  }
}
$('#pStart').addEventListener('click', () => power('start'));
$('#pStop').addEventListener('click', () => power('stop'));
$('#pRestart').addEventListener('click', () => power('restart'));
$('#pKill').addEventListener('click', () => power('kill'));

/* ---------------- Stats + graphiques ---------------- */
const histCpu = [];
const histRam = [];
function startStats() {
  stopStats();
  statsTimer = setInterval(refreshStats, 2000);
  refreshStats();
}
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}
async function refreshStats() {
  if (!currentServer) return;
  try {
    const s = await api(`/api/servers/${currentServer.id}/stats`);
    $('#stCpu').innerHTML = s.cpu + '<small>%</small>';
    $('#stRam').innerHTML = s.memory + '<small>Mo</small>';
    $('#stDisk').innerHTML = (s.disk || 0) + '<small>Mo</small>';
    $('#stUptime').textContent = fmtUptime(s.uptime);
    updateStatusUI(s.status);
    histCpu.push(s.cpu); histRam.push(s.memory);
    if (histCpu.length > 60) { histCpu.shift(); histRam.shift(); }
    drawChart($('#chCpu'), histCpu, '#7c6cff', '%', 100);
    drawChart($('#chRam'), histRam, '#22c58b', 'Mo');
  } catch (_) {}
}
function drawChart(canvas, data, color, unit, fixedMax) {
  if (!canvas || !canvas.offsetWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth, h = 70;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const max = fixedMax ? Math.max(fixedMax, ...data) : Math.max(10, ...data) * 1.25;
  const n = 60, step = w / (n - 1);
  const pts = data.map((v, i) => [w - (data.length - 1 - i) * step, h - 6 - (v / max) * (h - 14)]);
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((f) => { ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke(); });
  if (!pts.length) return;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(pts[0][0], h);
  pts.forEach((p) => ctx.lineTo(p[0], p[1]));
  ctx.lineTo(pts[pts.length - 1][0], h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = '#8691a7'; ctx.font = '11px Inter, sans-serif';
  ctx.fillText(data[data.length - 1] + ' ' + unit, 6, 12);
}

/* ---------------- Dialogue de saisie ---------------- */
function ask(title, value) {
  return new Promise((resolve) => {
    $('#promptTitle').textContent = title;
    const input = $('#promptInput');
    input.value = value || '';
    openModal('#promptModal');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const done = (v) => {
      $('#promptOk').onclick = null;
      input.onkeydown = null;
      closeModal('#promptModal');
      resolve(v);
    };
    $('#promptOk').onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); };
    $('#promptModal')._cancel = () => resolve(null);
  });
}

/* ---------------- Gestionnaire de fichiers ---------------- */
const selected = new Set();
let lastEntries = [];
const F = (p) => `/api/servers/${currentServer.id}/files${p || ''}`;
const join = (name) => (currentPath ? currentPath + '/' : '') + name;
const fmtDate = (t) => (t ? new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const isZip = (n) => /\.zip$/i.test(n);
function fileIcon(f) {
  if (f.isDir) return '📁';
  if (isZip(f.name)) return '🗜';
  if (/\.(js|mjs|cjs|ts)$/i.test(f.name)) return '🟨';
  if (/\.json$/i.test(f.name)) return '🧾';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) return '🖼';
  if (/\.(mp3|ogg|wav|mp4|mkv)$/i.test(f.name)) return '🎞';
  return '📄';
}

async function loadFiles(p) {
  if (!currentServer) return;
  currentPath = p || '';
  selected.clear();
  try {
    const entries = await api(F(`?path=${encodeURIComponent(currentPath)}`));
    lastEntries = entries;
    renderCrumbs();
    let html = '';
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      html += `<tr><td class="chk"></td><td class="name" colspan="4"><a href="#" data-dir="${escapeAttr(parent)}"><span class="ico">↩</span>..</a></td></tr>`;
    }
    html += entries.map((f) => `
      <tr data-path="${escapeAttr(f.path)}">
        <td class="chk"><input type="checkbox" data-sel="${escapeAttr(f.path)}" /></td>
        <td class="name"><a href="#" ${f.isDir ? 'data-dir' : 'data-file'}="${escapeAttr(f.path)}"><span class="ico">${fileIcon(f)}</span>${escapeHtml(f.name)}</a></td>
        <td class="size">${f.isDir ? '—' : fmtSize(f.size)}</td>
        <td class="date">${fmtDate(f.mtime)}</td>
        <td class="actions"><button class="icon-btn" data-menu="${escapeAttr(f.path)}">⋮</button></td>
      </tr>`).join('');
    $('#filesBody').innerHTML = html || '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:26px">Dossier vide</td></tr>';
    $('#selAll').checked = false;
    updateSelBar();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#filesBody').addEventListener('click', (e) => {
  const dir = e.target.closest('[data-dir]');
  if (dir) { e.preventDefault(); return loadFiles(dir.dataset.dir); }
  const file = e.target.closest('[data-file]');
  if (file) { e.preventDefault(); return editFile(file.dataset.file); }
  const menu = e.target.closest('[data-menu]');
  if (menu) return openRowMenu(menu, menu.dataset.menu);
  const sel = e.target.closest('[data-sel]');
  if (sel) {
    if (sel.checked) selected.add(sel.dataset.sel); else selected.delete(sel.dataset.sel);
    sel.closest('tr').classList.toggle('sel', sel.checked);
    updateSelBar();
  }
});
$('#selAll').addEventListener('change', (e) => {
  selected.clear();
  $$('#filesBody [data-sel]').forEach((c) => {
    c.checked = e.target.checked;
    c.closest('tr').classList.toggle('sel', e.target.checked);
    if (e.target.checked) selected.add(c.dataset.sel);
  });
  updateSelBar();
});
function updateSelBar() {
  $('#selBar').style.display = selected.size ? 'flex' : 'none';
  $('#selCount').textContent = selected.size + ' sélectionné(s)';
}

function renderCrumbs() {
  const parts = currentPath ? currentPath.split('/') : [];
  let acc = '';
  let html = '';
  parts.forEach((p) => {
    acc = acc ? acc + '/' + p : p;
    html += `<span class="sep">/</span><span class="crumb" data-crumb="${escapeAttr(acc)}">${escapeHtml(p)}</span>`;
  });
  $('#crumbPath').innerHTML = html;
  $('#crumbPath').querySelectorAll('[data-crumb]').forEach((c) => c.addEventListener('click', () => loadFiles(c.dataset.crumb)));
}
$('#crumbRoot').addEventListener('click', () => loadFiles(''));
$('#refreshFilesBtn').addEventListener('click', () => loadFiles(currentPath));

/* Menu contextuel d'une ligne */
function closeMenu() { const m = $('.menu'); if (m) m.remove(); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('[data-menu]')) closeMenu(); });
window.addEventListener('scroll', closeMenu, true);

function openRowMenu(btn, p) {
  closeMenu();
  const f = lastEntries.find((x) => x.path === p);
  if (!f) return;
  const items = [];
  if (!f.isDir) items.push(['edit', '✏️', 'Éditer']);
  if (isZip(f.name)) items.push(['unzip', '📂', 'Décompresser']);
  items.push(['rename', '🔤', 'Renommer'], ['move', '➡️', 'Déplacer'], ['copy', '📑', 'Dupliquer']);
  if (!f.isDir) items.push(['download', '⬇️', 'Télécharger']);
  items.push(['archive', '🗜', 'Compresser'], ['---'], ['delete', '🗑', 'Supprimer', 'red']);
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((i) => i[0] === '---' ? '<hr>' : `<button data-act="${i[0]}" class="${i[3] || ''}"><span>${i[1]}</span>${i[2]}</button>`).join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  const mh = m.offsetHeight, mw = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    closeMenu();
    fileAction(b.dataset.act, f);
  });
}

async function fileAction(act, f) {
  try {
    if (act === 'edit') return editFile(f.path);
    if (act === 'download') return downloadFile(f.path, f.name);
    if (act === 'rename') {
      const name = await ask('Renommer', f.name);
      if (!name || name === f.name) return;
      await api(F('/rename'), { method: 'POST', body: JSON.stringify({ path: f.path, newName: name }) });
    } else if (act === 'move') {
      const dest = await ask('Déplacer vers (dossier, ex : lib ou vide pour la racine)', currentPath);
      if (dest === null) return;
      await api(F('/move'), { method: 'POST', body: JSON.stringify({ paths: [f.path], dest: dest.replace(/^\/+|\/+$/g, '') }) });
    } else if (act === 'copy') {
      await api(F('/copy'), { method: 'POST', body: JSON.stringify({ path: f.path }) });
      toast('Dupliqué');
    } else if (act === 'archive') {
      const name = await ask('Nom de l\'archive', f.name.replace(/\.[^.]+$/, '') + '.zip');
      if (!name) return;
      toast('Compression...');
      await api(F('/archive'), { method: 'POST', body: JSON.stringify({ paths: [f.path], dir: currentPath, name }) });
      toast('Archive créée ✔');
    } else if (act === 'unzip') {
      toast('Décompression...');
      const r = await api(F('/unarchive'), { method: 'POST', body: JSON.stringify({ path: f.path }) });
      toast(`Décompressé ✔ (${r.count} fichiers)` + (r.entry ? ' · entrée : ' + r.entry : ''));
      if (r.entry) { currentServer.startupFile = r.entry; $('#startupFile').value = r.entry; fillServerInfo(Object.assign(currentServer, { startupFile: r.entry })); }
    } else if (act === 'delete') {
      if (!confirm('Supprimer « ' + f.name + ' » ?')) return;
      await api(F('/delete'), { method: 'POST', body: JSON.stringify({ paths: [f.path] }) });
      toast('Supprimé');
    }
    loadFiles(currentPath);
  } catch (err) {
    toast(err.message, true);
  }
}

async function downloadFile(p, name) {
  try {
    const res = await fetch(apiUrl(F(`/download?path=${encodeURIComponent(p)}`)), {
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Téléchargement impossible');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (err) {
    toast(err.message, true);
  }
}

/* Actions groupées */
$('#selDelete').addEventListener('click', async () => {
  if (!confirm('Supprimer ' + selected.size + ' élément(s) ?')) return;
  try {
    await api(F('/delete'), { method: 'POST', body: JSON.stringify({ paths: [...selected] }) });
    toast('Supprimé');
    loadFiles(currentPath);
  } catch (err) { toast(err.message, true); }
});
$('#selMove').addEventListener('click', async () => {
  const dest = await ask('Déplacer vers (dossier, vide = racine)', '');
  if (dest === null) return;
  try {
    await api(F('/move'), { method: 'POST', body: JSON.stringify({ paths: [...selected], dest: dest.replace(/^\/+|\/+$/g, '') }) });
    toast('Déplacé ✔');
    loadFiles(currentPath);
  } catch (err) { toast(err.message, true); }
});
$('#selArchive').addEventListener('click', async () => {
  const name = await ask('Nom de l\'archive', 'archive.zip');
  if (!name) return;
  try {
    toast('Compression...');
    await api(F('/archive'), { method: 'POST', body: JSON.stringify({ paths: [...selected], dir: currentPath, name }) });
    toast('Archive créée ✔');
    loadFiles(currentPath);
  } catch (err) { toast(err.message, true); }
});

$('#newDirBtn').addEventListener('click', async () => {
  const name = await ask('Nom du dossier');
  if (!name) return;
  try {
    await api(F('/mkdir'), { method: 'POST', body: JSON.stringify({ path: join(name) }) });
    loadFiles(currentPath);
  } catch (err) { toast(err.message, true); }
});
$('#newFileBtn').addEventListener('click', async () => {
  const name = await ask('Nom du fichier', 'nouveau.js');
  if (!name) return;
  try {
    await api(F('/write'), { method: 'POST', body: JSON.stringify({ path: join(name), content: '' }) });
    loadFiles(currentPath);
    editFile(join(name));
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Éditeur ---------------- */
let editingPath = null;
async function editFile(p) {
  try {
    const { content } = await api(F(`/read?path=${encodeURIComponent(p)}`));
    editingPath = p;
    $('#editorTitle').textContent = p;
    $('#editorContent').value = content;
    openModal('#editorModal');
  } catch (err) {
    toast(err.message, true);
  }
}
async function saveEditor() {
  try {
    await api(F('/write'), { method: 'POST', body: JSON.stringify({ path: editingPath, content: $('#editorContent').value }) });
    toast('Fichier enregistré ✔');
  } catch (err) { toast(err.message, true); }
}
$('#saveFileBtn').addEventListener('click', async () => { await saveEditor(); closeModal('#editorModal'); loadFiles(currentPath); });
$('#editorContent').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target, s = t.selectionStart;
    t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
    t.selectionStart = t.selectionEnd = s + 2;
  }
});

/* ---------------- Upload (plusieurs fichiers, SANS extraction) ---------------- */
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
dropzone.addEventListener('click', () => fileInput.click());
$('#uploadBtn').addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]); });
fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFiles([...fileInput.files]); fileInput.value = ''; });

async function uploadFiles(fileList, retried) {
  if (!currentServer) return;
  if (!TOKEN) {
    try { const me = await api('/api/me'); if (me.token) setToken(me.token); } catch (e) {}
  }
  const form = new FormData();
  fileList.forEach((f) => form.append('file', f));
  form.append('path', currentPath);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl(F('/upload')));
  if (TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
  xhr.withCredentials = true;
  const prog = $('#uploadProgress'), bar = $('#uploadBar');
  prog.classList.add('active');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
  xhr.onload = () => {
    prog.classList.remove('active');
    bar.style.width = '0';
    if (xhr.status === 200) {
      const hasZip = fileList.some((f) => isZip(f.name));
      toast(hasZip ? 'Envoyé ✔ — utilise « Décompresser » sur le .zip' : 'Fichier(s) envoyé(s) ✔');
      loadFiles(currentPath);
    } else if (xhr.status === 401 && !retried) {
      api('/api/me').then((me) => { if (me && me.token) setToken(me.token); uploadFiles(fileList, true); })
        .catch(() => toast('Session expirée — reconnecte-toi.', true));
    } else {
      let msg = 'Erreur upload';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      toast(msg, true);
    }
  };
  xhr.onerror = () => { prog.classList.remove('active'); toast('Erreur réseau', true); };
  xhr.send(form);
}

/* ---------------- Démarrage ---------------- */
function renderEnvRows(env) {
  const rows = Object.entries(env);
  $('#envRows').innerHTML = rows.map(([k, v]) => envRowHtml(k, v)).join('');
}
function envRowHtml(k, v) {
  return `<div class="env-row"><input type="text" class="env-k" placeholder="NOM" value="${escapeAttr(k)}" /><input type="text" class="env-v" placeholder="valeur" value="${escapeAttr(v)}" /><button type="button" class="btn danger sm env-del">✕</button></div>`;
}
$('#addEnvBtn').addEventListener('click', () => $('#envRows').insertAdjacentHTML('beforeend', envRowHtml('', '')));
$('#envRows').addEventListener('click', (e) => { if (e.target.closest('.env-del')) e.target.closest('.env-row').remove(); });
function readEnv() {
  const env = {};
  $$('#envRows .env-row').forEach((r) => {
    const k = r.querySelector('.env-k').value.trim();
    if (k) env[k] = r.querySelector('.env-v').value;
  });
  return env;
}

$('#saveStartupBtn').addEventListener('click', async () => {
  try {
    const updated = await api(`/api/servers/${currentServer.id}/startup`, {
      method: 'PUT',
      body: JSON.stringify({
        startupFile: $('#startupFile').value.trim() || 'index.js',
        args: $('#startupArgs').value.trim(),
        env: readEnv(),
        autostart: $('#autostartChk').checked,
        autorestart: $('#autorestartChk').checked
      })
    });
    currentServer = Object.assign(currentServer, updated);
    fillServerInfo(currentServer);
    toast('Configuration enregistrée ✔');
  } catch (err) { toast(err.message, true); }
});

$('#detectEntryBtn').addEventListener('click', async () => {
  try {
    const r = await api(`/api/servers/${currentServer.id}/detect`, { method: 'POST' });
    $('#startupFile').value = r.entry;
    currentServer.startupFile = r.entry;
    fillServerInfo(currentServer);
    toast('Fichier d\'entrée détecté : ' + r.entry);
  } catch (err) { toast(err.message, true); }
});

$('#installDepsBtn').addEventListener('click', async () => {
  toast('Installation en cours... (voir la console)');
  setTab('console');
  try {
    const r = await api(`/api/servers/${currentServer.id}/install`, { method: 'POST' });
    toast(r && r.ok === false ? 'Échec de l\'installation — voir la console' : 'Dépendances installées ✔', r && r.ok === false);
  } catch (err) { toast(err.message, true); }
});
$('#pkgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const packages = $('#pkgInput').value.trim();
  if (!packages) return;
  setTab('console');
  try {
    const r = await api(`/api/servers/${currentServer.id}/install`, { method: 'POST', body: JSON.stringify({ packages }) });
    toast(r.ok ? 'Paquet installé ✔' : 'Échec — voir la console', !r.ok);
    if (r.ok) $('#pkgInput').value = '';
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Planification ---------------- */
async function loadSchedules() {
  try {
    const list = await api(`/api/servers/${currentServer.id}/schedules`);
    const ACT = { restart: 'Redémarrer', start: 'Démarrer', stop: 'Arrêter', command: 'Commande' };
    $('#schedList').innerHTML = list.length ? list.map((s) => `
      <div class="item" data-sid="${escapeAttr(s.id)}">
        <div class="grow">
          <div class="t">${escapeHtml(s.name)} ${s.enabled ? '' : '<span class="status-pill">désactivée</span>'}</div>
          <div class="s">${ACT[s.action]}${s.action === 'command' ? ' « ' + escapeHtml(s.payload) + ' »' : ''} · ${s.type === 'daily' ? 'chaque jour à ' + escapeHtml(s.at) + ' UTC' : 'toutes les ' + s.everyMin + ' min'}${s.lastRun ? ' · dernière : ' + fmtDate(s.lastRun) : ''}</div>
        </div>
        <div class="btns">
          <button class="btn ghost sm" data-sact="run">▶ Lancer</button>
          <button class="btn ghost sm" data-sact="toggle">${s.enabled ? 'Désactiver' : 'Activer'}</button>
          <button class="btn danger sm" data-sact="del">Supprimer</button>
        </div>
      </div>`).join('') : '<div class="empty">Aucune tâche planifiée.</div>';
    $('#schedList')._data = list;
  } catch (err) { toast(err.message, true); }
}
$('#schedList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sact]');
  if (!b) return;
  const sid = b.closest('.item').dataset.sid;
  const s = ($('#schedList')._data || []).find((x) => x.id === sid);
  const base = `/api/servers/${currentServer.id}/schedules/${sid}`;
  try {
    if (b.dataset.sact === 'run') { await api(base + '/run', { method: 'POST' }); toast('Tâche lancée'); }
    if (b.dataset.sact === 'toggle') await api(base, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) });
    if (b.dataset.sact === 'del') { if (!confirm('Supprimer cette tâche ?')) return; await api(base, { method: 'DELETE' }); }
    loadSchedules();
  } catch (err) { toast(err.message, true); }
});
function syncSchedForm() {
  const daily = $('#schType').value === 'daily';
  $('#schEveryBox').style.display = daily ? 'none' : '';
  $('#schAtBox').style.display = daily ? '' : 'none';
  $('#schPayloadBox').style.display = $('#schAction').value === 'command' ? '' : 'none';
}
$('#schType').addEventListener('change', syncSchedForm);
$('#schAction').addEventListener('change', syncSchedForm);
$('#newSchedBtn').addEventListener('click', () => { $('#schName').value = ''; syncSchedForm(); openModal('#schedModal'); });
$('#saveSchedBtn').addEventListener('click', async () => {
  try {
    await api(`/api/servers/${currentServer.id}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: $('#schName').value.trim() || 'Tâche',
        action: $('#schAction').value,
        type: $('#schType').value,
        everyMin: $('#schEvery').value,
        at: $('#schAt').value,
        payload: $('#schPayload').value
      })
    });
    closeModal('#schedModal');
    toast('Tâche créée ✔');
    loadSchedules();
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Sauvegardes ---------------- */
async function loadBackups() {
  try {
    const list = await api(`/api/servers/${currentServer.id}/backups`);
    $('#backupList').innerHTML = list.length ? list.map((b) => `
      <div class="item" data-bname="${escapeAttr(b.name)}">
        <div class="grow"><div class="t">${escapeHtml(b.name)}</div><div class="s">${fmtDate(b.createdAt)} · ${fmtSize(b.size)}</div></div>
        <div class="btns">
          <button class="btn ghost sm" data-bact="download">⬇ Télécharger</button>
          <button class="btn ghost sm" data-bact="restore">↺ Restaurer</button>
          <button class="btn danger sm" data-bact="del">Supprimer</button>
        </div>
      </div>`).join('') : '<div class="empty">Aucune sauvegarde.</div>';
  } catch (err) { toast(err.message, true); }
}
$('#newBackupBtn').addEventListener('click', async () => {
  const label = await ask('Nom de la sauvegarde (optionnel)', '');
  if (label === null) return;
  toast('Création de la sauvegarde...');
  try {
    await api(`/api/servers/${currentServer.id}/backups`, { method: 'POST', body: JSON.stringify({ label }) });
    toast('Sauvegarde créée ✔');
    loadBackups();
  } catch (err) { toast(err.message, true); }
});
$('#backupList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bact]');
  if (!b) return;
  const name = b.closest('.item').dataset.bname;
  const base = `/api/servers/${currentServer.id}/backups/${encodeURIComponent(name)}`;
  try {
    if (b.dataset.bact === 'download') {
      const res = await fetch(apiUrl(base + '/download'), { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}, credentials: 'include' });
      if (!res.ok) throw new Error('Téléchargement impossible');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } else if (b.dataset.bact === 'restore') {
      if (!confirm('Restaurer cette sauvegarde ? Les fichiers actuels seront remplacés et le bot arrêté.')) return;
      await api(base + '/restore', { method: 'POST' });
      toast('Sauvegarde restaurée ✔');
    } else if (b.dataset.bact === 'del') {
      if (!confirm('Supprimer cette sauvegarde ?')) return;
      await api(base, { method: 'DELETE' });
      loadBackups();
    }
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Paramètres ---------------- */
$('#saveNameBtn').addEventListener('click', async () => {
  try {
    const s = await api(`/api/servers/${currentServer.id}/settings`, { method: 'PUT', body: JSON.stringify({ name: $('#setName').value }) });
    currentServer = Object.assign(currentServer, s);
    fillServerInfo(currentServer);
    toast('Serveur renommé ✔');
  } catch (err) { toast(err.message, true); }
});
$('#pwdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ password: $('#newPwd').value }) });
    $('#newPwd').value = '';
    toast('Mot de passe modifié ✔');
  } catch (err) { toast(err.message, true); }
});
$('#reinstallBtn').addEventListener('click', async () => {
  if (!confirm('Supprimer TOUS les fichiers de ce serveur ? Cette action est irréversible (pense à faire une sauvegarde).')) return;
  try {
    await api(`/api/servers/${currentServer.id}/reinstall`, { method: 'POST' });
    toast('Serveur réinitialisé');
    currentPath = '';
  } catch (err) { toast(err.message, true); }
});
$('#delServerBtn').addEventListener('click', async () => {
  if (!currentServer) return;
  if (!confirm('Supprimer définitivement ce serveur, ses fichiers et ses sauvegardes ?')) return;
  try {
    await api('/api/servers/' + currentServer.id, { method: 'DELETE' });
    toast('Serveur supprimé');
    showList();
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Nouveau serveur ---------------- */
$('#newServerBtn').addEventListener('click', () => openModal('#newServerModal'));
$('#createServerBtn').addEventListener('click', async () => {
  const name = $('#nsName').value.trim();
  if (!name) return toast('Nom requis', true);
  try {
    const s = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name, startupFile: $('#nsFile').value.trim() || 'index.js' })
    });
    closeModal('#newServerModal');
    $('#nsName').value = '';
    toast('Serveur créé ✔');
    openServer(s.id);
  } catch (err) { toast(err.message, true); }
});

/* ---------------- Modals ---------------- */
function openModal(sel) { $(sel).classList.add('active'); }
function closeModal(sel) { $(sel).classList.remove('active'); }
function dismissModal(m) {
  m.classList.remove('active');
  if (m._cancel) { m._cancel(); m._cancel = null; }
}
$$('[data-close]').forEach((b) => b.addEventListener('click', () => dismissModal(b.closest('.modal-bg'))));
$$('.modal-bg').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) dismissModal(m); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-bg.active').forEach(dismissModal); });

/* ---------------- Escape ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------------- Boot ---------------- */
checkSession();
