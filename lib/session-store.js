/**
 * Store de sessions PERSISTANT sur disque.
 *
 * Pourquoi : express-session utilise par defaut un MemoryStore qui perd TOUTES
 * les sessions a chaque redemarrage du panel. Resultat : l'utilisateur restait
 * "connecte" dans son navigateur mais le serveur repondait "Non authentifie".
 *
 * Ce store ecrit chaque session dans un fichier JSON (dossier persistant), donc
 * la connexion SURVIT aux redemarrages du panel.
 */
const fs = require('fs');
const path = require('path');
const session = require('express-session');

class FileSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.dir = options.dir || path.join(__dirname, '..', 'data', 'sessions');
    this.ttl = options.ttl || 1000 * 60 * 60 * 24 * 30; // 30 jours
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {}
    // Nettoyage periodique des sessions expirees (non bloquant).
    this._timer = setInterval(() => this.cleanup(), 1000 * 60 * 60);
    if (this._timer.unref) this._timer.unref();
  }

  _file(sid) {
    const safe = String(sid).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, safe + '.json');
  }

  get(sid, cb) {
    fs.readFile(this._file(sid), 'utf8', (err, data) => {
      if (err) return cb(null, null);
      let obj;
      try {
        obj = JSON.parse(data);
      } catch (e) {
        return cb(null, null);
      }
      if (!obj || !obj.session) return cb(null, null);
      if (obj.expires && Date.now() > obj.expires) {
        return this.destroy(sid, () => cb(null, null));
      }
      cb(null, obj.session);
    });
  }

  set(sid, sess, cb) {
    let expires = Date.now() + this.ttl;
    if (sess && sess.cookie && sess.cookie.expires) {
      const t = new Date(sess.cookie.expires).getTime();
      if (!isNaN(t)) expires = t;
    }
    const obj = { session: sess, expires };
    const file = this._file(sid);
    const tmp = file + '.' + process.pid + '.tmp';
    // Ecriture atomique : on ecrit dans un fichier temporaire puis on renomme.
    fs.writeFile(tmp, JSON.stringify(obj), (err) => {
      if (err) return cb && cb(err);
      fs.rename(tmp, file, (err2) => cb && cb(err2));
    });
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    fs.rm(this._file(sid), { force: true }, (err) => cb && cb(err));
  }

  length(cb) {
    fs.readdir(this.dir, (err, files) => {
      if (err) return cb(err, 0);
      cb(null, files.filter((f) => f.endsWith('.json')).length);
    });
  }

  clear(cb) {
    fs.readdir(this.dir, (err, files) => {
      if (err) return cb && cb(err);
      for (const f of files) {
        if (f.endsWith('.json')) fs.rm(path.join(this.dir, f), { force: true }, () => {});
      }
      cb && cb(null);
    });
  }

  cleanup() {
    fs.readdir(this.dir, (err, files) => {
      if (err) return;
      const now = Date.now();
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(this.dir, f);
        fs.readFile(fp, 'utf8', (e, d) => {
          if (e) return;
          try {
            const o = JSON.parse(d);
            if (o.expires && now > o.expires) fs.rm(fp, { force: true }, () => {});
          } catch (_) {
            fs.rm(fp, { force: true }, () => {});
          }
        });
      }
    });
  }
}

module.exports = FileSessionStore;
