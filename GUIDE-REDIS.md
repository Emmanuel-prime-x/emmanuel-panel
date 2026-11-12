# Redis — la configuration du panel survit aux redémarrages

Avec la variable **`REDIS_URL`**, le panel sauvegarde automatiquement dans Redis :
la liste des serveurs (réglages, variables, planifications), tes identifiants
et les sessions de connexion. Après un redémarrage de Render, tout est restauré
au démarrage (message `[redis] servers.json restaure depuis Redis` dans les logs Render).

Sans `REDIS_URL`, le panel marche comme avant (fichiers locaux).

## Mise en place (Upstash, gratuit)

1. Crée un compte sur **upstash.com** → **Create Database** (Redis) → région proche (Europe).
2. Dans la base, copie l'URL **« Redis URL »** (elle commence par `rediss://default:...`).
3. Render → ton service → **Environment** → ajoute `REDIS_URL` = cette URL → Save.
4. Après redéploiement, ouvre `/api/ping` : tu dois voir `"redis":true`.

## Limites

- Redis garde la **configuration**, pas les fichiers des bots (utilise les bots intégrés : GUIDE-BOTS.md).
- Un serveur créé à la main (hors bots intégrés) retrouvera sa fiche mais pas ses fichiers.
- Si Redis est injoignable, le panel démarre quand même avec ses fichiers locaux.
