/**
 * Lance AU DEMARRAGE du panel (avant tout le reste, de facon synchrone) :
 * si REDIS_URL est defini, recupere la configuration sauvegardee (serveurs,
 * identifiants) et la remet dans data/ ; sinon envoie la copie locale vers Redis.
 * Ne plante jamais : en cas de probleme, le panel demarre normalement.
 */
const fs = require('fs');
const path = require('path');
const redis = require('../lib/redis');
const DATA = path.join(__dirname, '..', 'data');

(async () => {
  if (!redis.enabled) return;
  fs.mkdirSync(DATA, { recursive: true });
  for (const [key, file] of [['servers', 'servers.json'], ['auth', 'auth.json']]) {
    const local = path.join(DATA, file);
    const remote = await redis.get(key);
    if (remote) {
      JSON.parse(remote); // verifie que c'est du JSON valide
      fs.writeFileSync(local, remote, 'utf8');
      fs.writeFileSync(local + '.bak', remote, 'utf8');
      console.log(`[redis] ${file} restaure depuis Redis`);
    } else if (fs.existsSync(local)) {
      await redis.set(key, fs.readFileSync(local, 'utf8'));
      console.log(`[redis] ${file} envoye vers Redis (premiere sauvegarde)`);
    }
  }
})().catch((e) => console.error('[redis] restauration impossible :', e.message)).finally(() => process.exit(0));
