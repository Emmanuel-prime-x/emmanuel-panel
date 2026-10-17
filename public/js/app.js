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
  socket.on('console', ({ id, line }) => {
    if (currentServer && currentServer.id === id) appendConsole(line);
  });
  socket.on('status', ({ id, status }) => {
    if (currentServer && currentServer.id === id) updateStatusUI(status);
  });
}

function appendConsole(line) {
  const c = $('#console');
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = ansiToHtml(line);
  c.appendChild(div);
  // Limite le nombre de lignes dans le DOM (console fluide sur mobile).
  while (c.childElementCount > 1000) c.removeChild(c.firstChild);
  // Ne force le defilement que si on est deja en bas (permet de relire les logs).
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  if (nearBottom) c.scrollTop = c.scrollHeight;
}

/* Convertit les codes couleur ANSI (\x1b[31m ...) en HTML — evite les "▯[31m" a l'ecran. */
const ANSI_COLORS = {
  30: '#6b7686', 31: '#ff6b6b', 32: '#3ddc97', 33: '#ffc857', 34: '#6ea8ff', 35: '#d68cff', 36: '#4fd8e6', 37: '#d5dde8',
  90: '#7d8898', 91: '#ff8585', 92: '#6df0b4', 93: '#ffd97a', 94: '#8fbaff', 95: '#e3a8ff', 96: '#7fe6f0', 97: '#ffffff'
};
function ansiToHtml(text) {
  let out = '';
  let open = false;
  let last = 0;
  const re = /(?:\u001b|\x1b)\[([0-9;]*)m/g;
  let m;
  const esc = (t) => escapeHtml(t.replace(/[\u0000-\u0008\u000b-\u001f]/g, ''));
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    if (open) { out += '</span>'; open = false; }
    const codes = m[1].split(';').map(Number);
    let style = '';
    for (const c of codes) {
      if (ANSI_COLORS[c]) style += 'color:' + ANSI_COLORS[c] + ';';
      else if (c === 1) style += 'font-weight:700;';
    }
    if (style) { out += '<span style="' + style + '">'; open = true; }
  }
  out += esc(text.slice(last));
  if (open) out += '</span>';
  return out;
}

/* ---------------- Liste des serveurs ---------------- */
async function loadServers() {
  try {
    const servers = await api('/api/servers');
    const grid = $('#serverGrid');
    if (!servers.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Aucun serveur. Clique sur « + Nouveau serveur » pour commencer.</div>';
      return;
    }
    grid.innerHTML = servers.map((s) => `
      <div class="card" data-id="${s.id}">
        <div class="name"><span class="status-dot ${s.status}"></span>${escapeHtml(s.name)}</div>
        <div class="meta">Fichier : ${escapeHtml(s.startupFile || 'index.js')}</div>
        <div class="meta">ID : ${s.id}</div>
      </div>`).join('');
    $$('#serverGrid .card').forEach((el) =>
      el.addEventListener('click', () => openServer(el.dataset.id))
    );
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
    $('#listView').style.display = 'none';
    $('#serverView').style.display = 'block';
    $('#svNameText').textContent = s.name;
    $('#svSub').textContent = 'ID : ' + s.id + ' · Fichier : ' + (s.startupFile || 'index.js');
    $('#startupFile').value = s.startupFile || 'index.js';
    $('#startupEnv').value = JSON.stringify(s.env || {}, null, 2);
    const autoChk = $('#autostartChk');
    if (autoChk) autoChk.checked = s.autostart !== false;

    $('#console').innerHTML = '';
    (s.logs || []).forEach(appendConsole);
    updateStatusUI(s.status);

    if (socket) socket.emit('join', { id });
    loadFiles('');
    startStats();
  } catch (err) {
    toast(err.message, true);
  }
}

function updateStatusUI(status) {
  const dot = $('#svDot');
  dot.className = 'status-dot ' + status;
  $('#stStatus').textContent = status;
}

$('#backBtn').addEventListener('click', () => {
  if (currentServer && socket) socket.emit('leave', { id: currentServer.id });
  stopStats();
  currentServer = null;
  $('#serverView').style.display = 'none';
  $('#listView').style.display = 'block';
  loadServers();
});

/* ---------------- Power ---------------- */
async function power(action) {
  if (!currentServer) return;
  try {
    await api(`/api/servers/${currentServer.id}/power`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    toast('Action : ' + action);
  } catch (err) {
    toast(err.message, true);
  }
}
$('#pStart').addEventListener('click', () => power('start'));
$('#pStop').addEventListener('click', () => power('stop'));
$('#pRestart').addEventListener('click', () => power('restart'));
$('#pKill').addEventListener('click', () => power('kill'));

$('#delServerBtn').addEventListener('click', async () => {
  if (!currentServer) return;
  if (!confirm('Supprimer définitivement ce serveur et tous ses fichiers ?')) return;
  await api('/api/servers/' + currentServer.id, { method: 'DELETE' });
  toast('Serveur supprimé');
  $('#backBtn').click();
});

/* ---------------- Console ---------------- */
$('#cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#cmdInput');
  const cmd = input.value.trim();
  if (!cmd || !currentServer) return;
  if (socket) socket.emit('command', { id: currentServer.id, command: cmd });
  input.value = '';
});

/* ---------------- Stats ---------------- */
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
    $('#stUptime').innerHTML = fmtUptime(s.uptime);
    updateStatusUI(s.status);
  } catch (_) {}
}

/* ---------------- Onglets ---------------- */
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tabpane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('#pane-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'files') loadFiles(currentPath);
  });
});

/* ---------------- Gestionnaire de fichiers ---------------- */
async function loadFiles(p) {
  if (!currentServer) return;
  currentPath = p || '';
  try {
    const entries = await api(`/api/servers/${currentServer.id}/files?path=${encodeURIComponent(currentPath)}`);
    renderCrumbs();
    const body = $('#filesBody');
    let html = '';
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      html += `<tr><td class="name"><a href="#" data-dir="${escapeAttr(parent)}">📁 ..</a></td><td>—</td><td class="actions"></td></tr>`;
    }
    html += entries.map((f) => `
      <tr>
        <td class="name">
          ${f.isDir
            ? `<a href="#" data-dir="${escapeAttr(f.path)}">📁 ${escapeHtml(f.name)}</a>`
            : `<a href="#" data-file="${escapeAttr(f.path)}">📄 ${escapeHtml(f.name)}</a>`}
        </td>
        <td>${f.isDir ? '—' : fmtSize(f.size)}</td>
        <td class="actions">
          <button class="icon-btn" data-rename="${escapeAttr(f.path)}" title="Renommer">✏️</button>
          <button class="icon-btn" data-del="${escapeAttr(f.path)}" title="Supprimer">🗑</button>
        </td>
      </tr>`).join('');
    body.innerHTML = html || '<tr><td colspan="3" style="color:var(--muted)">Dossier vide</td></tr>';

    body.querySelectorAll('[data-dir]').forEach((a) =>
      a.addEventListener('click', (e) => { e.preventDefault(); loadFiles(a.dataset.dir); })
    );
    body.querySelectorAll('[data-file]').forEach((a) =>
      a.addEventListener('click', (e) => { e.preventDefault(); editFile(a.dataset.file); })
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Supprimer ' + b.dataset.del + ' ?')) return;
        await api(`/api/servers/${currentServer.id}/files?path=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        toast('Supprimé');
        loadFiles(currentPath);
      })
    );
    body.querySelectorAll('[data-rename]').forEach((b) =>
      b.addEventListener('click', async () => {
        const old = b.dataset.rename;
        const newName = prompt('Nouveau nom :', old.split('/').pop());
        if (!newName) return;
        await api(`/api/servers/${currentServer.id}/files/rename`, {
          method: 'POST',
          body: JSON.stringify({ path: old, newName })
        });
        loadFiles(currentPath);
      })
    );
  } catch (err) {
    toast(err.message, true);
  }
}

function renderCrumbs() {
  const parts = currentPath ? currentPath.split('/') : [];
  let acc = '';
  let html = '';
  parts.forEach((p) => {
    acc = acc ? acc + '/' + p : p;
    html += ` / <span class="crumb" data-crumb="${escapeAttr(acc)}">${escapeHtml(p)}</span>`;
  });
  $('#crumbPath').innerHTML = html;
  $('#crumbPath').querySelectorAll('[data-crumb]').forEach((c) =>
    c.addEventListener('click', () => loadFiles(c.dataset.crumb))
  );
}
$('#crumbRoot').addEventListener('click', () => loadFiles(''));
$('#refreshFilesBtn').addEventListener('click', () => loadFiles(currentPath));

$('#newDirBtn').addEventListener('click', async () => {
  const name = prompt('Nom du dossier :');
  if (!name) return;
  await api(`/api/servers/${currentServer.id}/files/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ path: (currentPath ? currentPath + '/' : '') + name })
  });
  loadFiles(currentPath);
});

$('#newFileBtn').addEventListener('click', async () => {
  const name = prompt('Nom du fichier :');
  if (!name) return;
  await api(`/api/servers/${currentServer.id}/files/write`, {
    method: 'POST',
    body: JSON.stringify({ path: (currentPath ? currentPath + '/' : '') + name, content: '' })
  });
  loadFiles(currentPath);
});

/* ---------------- Editeur ---------------- */
let editingPath = null;
async function editFile(p) {
  try {
    const { content } = await api(`/api/servers/${currentServer.id}/files/read?path=${encodeURIComponent(p)}`);
    editingPath = p;
    $('#editorTitle').textContent = 'Éditer : ' + p;
    $('#editorContent').value = content;
    openModal('#editorModal');
  } catch (err) {
    toast(err.message, true);
  }
}
$('#saveFileBtn').addEventListener('click', async () => {
  try {
    await api(`/api/servers/${currentServer.id}/files/write`, {
      method: 'POST',
      body: JSON.stringify({ path: editingPath, content: $('#editorContent').value })
    });
    toast('Fichier enregistré');
    closeModal('#editorModal');
    loadFiles(currentPath);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- Upload ZIP ---------------- */
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
  fileInput.value = '';
});

async function uploadFile(file) {
  if (!currentServer) return;
  // Securite : on s'assure d'avoir un jeton valide AVANT l'upload.
  if (!TOKEN) {
    try { const me = await api('/api/me'); if (me.token) setToken(me.token); } catch (e) {}
  }
  const form = new FormData();
  form.append('file', file);
  form.append('path', currentPath);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl(`/api/servers/${currentServer.id}/files/upload`));
  // IMPORTANT : envoyer le jeton d'authentification sur l'upload (sinon 401 "Non authentifie").
  if (TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
  xhr.withCredentials = true;
  const prog = $('#uploadProgress');
  const bar = $('#uploadBar');
  prog.classList.add('active');

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  };
  let retried = false;
  xhr.onload = () => {
    prog.classList.remove('active');
    bar.style.width = '0';
    if (xhr.status === 200) {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (data.entry) {
        toast('Upload terminé ✔ · entrée : ' + data.entry);
        $('#startupFile').value = data.entry;
        if (currentServer) currentServer.startupFile = data.entry;
      } else {
        toast('Upload terminé ✔ (démarrage auto des dépendances)');
      }
      loadFiles(currentPath);
    } else if (xhr.status === 401 && !retried) {
      // Jeton expire ou manquant : on le rafraichit et on reessaie une fois.
      retried = true;
      api('/api/me').then((me) => {
        if (me && me.token) setToken(me.token);
        uploadFile(file);
      }).catch(() => toast('Session expirée — reconnecte-toi.', true));
    } else {
      let msg = 'Erreur upload';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      toast(msg, true);
    }
  };
  xhr.onerror = () => { prog.classList.remove('active'); toast('Erreur réseau', true); };
  xhr.send(form);
}

/* ---------------- Startup ---------------- */
$('#saveStartupBtn').addEventListener('click', async () => {
  try {
    const env = $('#startupEnv').value.trim() || '{}';
    JSON.parse(env); // validation
    await api(`/api/servers/${currentServer.id}/startup`, {
      method: 'PUT',
      body: JSON.stringify({
        startupFile: $('#startupFile').value,
        env,
        autostart: $('#autostartChk') ? $('#autostartChk').checked : true
      })
    });
    toast('Configuration enregistrée');
  } catch (err) {
    toast('JSON invalide : ' + err.message, true);
  }
});

/* Détecter le fichier d'entrée */
$('#detectEntryBtn').addEventListener('click', async () => {
  if (!currentServer) return;
  try {
    const r = await api(`/api/servers/${currentServer.id}/detect`, { method: 'POST' });
    $('#startupFile').value = r.entry;
    currentServer.startupFile = r.entry;
    toast('Fichier d\'entrée détecté : ' + r.entry);
  } catch (err) {
    toast(err.message, true);
  }
});

/* Installer les dépendances */
$('#installDepsBtn').addEventListener('click', async () => {
  if (!currentServer) return;
  toast('Installation des dépendances en cours... (voir la console)');
  try {
    const r = await api(`/api/servers/${currentServer.id}/install`, { method: 'POST' });
    if (r && r.ok === false) toast('Échec de l\'installation — voir la console', true);
    else toast('Dépendances installées ✔');
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- Nouveau serveur ---------------- */
$('#newServerBtn').addEventListener('click', () => openModal('#newServerModal'));
$('#createServerBtn').addEventListener('click', async () => {
  const name = $('#nsName').value.trim();
  if (!name) return toast('Nom requis', true);
  try {
    const env = $('#nsEnv').value.trim();
    if (env) JSON.parse(env);
    const s = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        startupFile: $('#nsFile').value.trim() || 'index.js',
        env: env || undefined
      })
    });
    closeModal('#newServerModal');
    $('#nsName').value = '';
    $('#nsEnv').value = '';
    toast('Serveur créé');
    loadServers();
    openServer(s.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- Modals ---------------- */
function openModal(sel) { $(sel).classList.add('active'); }
function closeModal(sel) { $(sel).classList.remove('active'); }
$$('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-bg').classList.remove('active'))
);
$$('.modal-bg').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('active'); })
);

/* ---------------- Escape ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------------- Boot ---------------- */
checkSession();
