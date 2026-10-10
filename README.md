# ⚡ EMMANUEL PANEL

Panel d'hébergement **de type Pterodactyl** pour gérer tes bots **WhatsApp Baileys**.
Écrit en **Node.js** (Express + Socket.IO), interface web sombre moderne.

> Owner : **PROFESSEUR EMMANUEL X** — Telegram : https://t.me/emmanuelprimex

---

## 🔒 SOLUTION DÉFINITIVE — le panel ne s'éteint plus

Le panel **tourne en arrière-plan en permanence** et **revient tout seul** après un
redémarrage du serveur, grâce à **trois mécanismes redondants** :

| # | Mécanisme | Ce qu'il fait |
| --- | --- | --- |
| 1 | **Service supervisord** `/etc/supervisor/conf.d/emmanuel-panel.conf` (`autostart` + `autorestart`) | Démarre le panel **au boot**, le **relance en quelques secondes** s'il plante, détaché de tout terminal. |
| 2 | **Watchdog** `watchdog.sh` (service `panel-watchdog`) | Vérifie toutes les 20 s que le panel tourne (sinon il le relance) et **supprime tout doublon** de démarrage (conflit de port). |
| 3 | **Hook de démarrage** `.agent_hooks/startup/00_ensure_panel.py` | Au boot du sandbox, **réécrit la config** et relance les services : filet de sécurité. |

- ✅ Démarrage **automatique** au boot ; **relance auto** après un crash (testé : `kill -9` → de retour en ~13 s).
- ✅ **URL de tunnel réutilisée** après un redémarrage du panel → elle ne change pas.
- ✅ **Bots relancés automatiquement** (autostart) ; orphelins nettoyés (jamais de doublon WhatsApp).
- ✅ **Point d'entrée stable** : la page *launcher* retrouve le panel même si l'adresse `trycloudflare` change.

> ⏱️ Pendant un **redémarrage complet du serveur**, le panel est indisponible le temps du boot (~20–40 s), puis **revient seul**.

```bash
./manage.sh status | restart | logs | url | health
supervisorctl status emmanuel-panel panel-watchdog
```

---

## ✨ Fonctionnalités

| Fonction | Description |
|---|---|
| 🖥️ **Console temps réel** | Sortie du bot en direct + envoi de commandes sur `stdin` (Socket.IO) |
| 📦 **Upload ZIP** | Glisse-dépose le ZIP de ton bot → extraction automatique |
| 🎯 **Détection auto de l'entrée** | Lit `package.json` (`main` / `scripts.start`) pour trouver le bon fichier à lancer |
| ⚙️ **npm install automatique** | Installe les dépendances du bot (Baileys, etc.) dès l'upload et au démarrage |
| 🗂️ **Gestionnaire de fichiers** | Naviguer, éditer, renommer, créer, supprimer des fichiers/dossiers |
| ▶️ **Contrôles d'alimentation** | Démarrer / Redémarrer / Arrêter / Kill |
| 📊 **Statistiques** | CPU, RAM, uptime en direct |
| ⚙️ **Démarrage** | Fichier d'entrée + variables d'environnement (JSON) |
| 🔐 **Authentification** | Login par session, mot de passe hashé (bcrypt) |
| 🧩 **Multi-serveurs** | Héberge plusieurs bots indépendants |

---

## 🔒 Démarrage automatique en arrière-plan (supervisord)

Le panel **ne s'éteint plus**. Il est enregistré comme **service supervisord**
(`/etc/supervisor/conf.d/emmanuel-panel.conf`) avec `autostart=true` et
`autorestart=true` : il démarre tout seul, se relance en quelques secondes après
un crash, tourne détaché de tout terminal et réutilise son tunnel (URL stable).

```bash
./manage.sh status     # état du service
./manage.sh restart    # redémarrer le panel
./manage.sh logs       # suivre les logs
./manage.sh url        # URL publique courante
./manage.sh health     # état complet (tunnel + bots)
```

> 🧷 Hook de démarrage : `/workspace/.agent_hooks/startup/00_ensure_panel.py`
> (réécrit la config et relance le service après un redémarrage du sandbox).

* * *

## 🛡️ Persistance & fiabilité (serveurs qui ne disparaissent plus)

Le panel est conçu pour **ne jamais perdre tes serveurs** ni te déconnecter
intempestivement, même après un redémarrage :

| Mécanisme | Rôle |
|---|---|
| 💾 **Sessions persistantes** | Les sessions sont écrites sur disque (`data/sessions/`). Tu **restes connecté** après un redémarrage du panel (plus de « Non authentifié »). |
| 🔁 **Cookie glissant** | Le cookie est renouvelé à chaque requête : tant que tu utilises le panel, tu restes connecté (30 jours). |
| 🗂️ **Sauvegarde auto** | `servers.json` et `auth.json` sont dupliqués en `.bak`. Si un fichier disparaît ou se corrompt, il est **restauré automatiquement**. |
| ♻️ **Relance automatique** | Les bots marqués *autostart* redémarrent tout seuls après un redémarrage du panel (case à cocher dans l'onglet *Démarrage*). |
| 🔗 **URL stable** | Le tunnel Cloudflare est **réutilisé** (et non recréé) à chaque redémarrage du panel : l'URL publique ne change plus. |
| 🚨 **Session perdue = écran de connexion** | Si la session expire, le panel t'affiche proprement l'écran de connexion au lieu d'une erreur « Non authentifié ». |

> 💡 **Où sont stockées tes données ?** Dans `panel/data/` (identifiants,
> liste des serveurs, sessions) et `panel/servers/<id>/` (les fichiers de chaque
> bot). Ces dossiers sont **persistants** : ne les supprime pas.

---

## 🌐 Accès en ligne (URL permanente)

Le panel est une application **dynamique** (Node.js) : il a besoin de son backend
pour la console, l'upload et les commandes. Un simple hébergement statique ne
suffit pas.

Le panel **ouvre lui-même** un tunnel public Cloudflare au démarrage
(`lib/tunnel.js`) et publie l'adresse obtenue. Comme les tunnels « quick »
changent d'adresse à chaque redémarrage, une **page d'accès permanente** est
fournie : elle retrouve automatiquement l'adresse courante et redirige vers le
panel. **Utilise toujours cette page comme point d'entrée** :

🔗 **Page d'accès permanente (launcher)**
`https://sites.super.myninja.ai/9c0ae763-4d54-40f7-8e74-5998cfd75dd9/c1c10a25/index.html`

Comment ça marche :

1. Au démarrage, le panel lance `cloudflared` et récupère l'URL `https://….trycloudflare.com`.
2. Il la **publie** sur un canal public fixe (`https://ntfy.sh/emmanuel-panel-9f4a2c7b`).
3. Le **launcher** lit ce canal, vérifie que le panel répond (`/api/ping`) puis redirige. Le serveur expose aussi le **CORS** et une **auth par token Bearer** : le launcher (cross-origin) fonctionne même quand l'adresse change.
4. Un **watchdog** relance le tunnel s'il meurt et republie la nouvelle adresse. Un **auto-test** vérifie que l'URL publique répond vraiment, sinon le tunnel est recréé.
   Si le launcher affiche « Connexion au panel… », patiente quelques
   secondes : il se reconnecte tout seul.

> ✅ Le launcher ne change **jamais** : mets-le en favori. L'adresse
> `trycloudflare` du panel, elle, peut changer après un redémarrage — c'est
> normal, le launcher s'en occupe.

### Variables du tunnel

| Variable | Défaut | Rôle |
|---|---|---|
| `PANEL_TUNNEL` | `1` | Mets `0` pour désactiver le tunnel automatique |
| `CLOUDFLARED_BIN` | `panel/bin/cloudflared` | Chemin du binaire cloudflared |
| `PANEL_PUBLISH_TOPIC` | `emmanuel-panel-9f4a2c7b` | Canal de publication de l'URL |
| `CLOUDFLARED_METRICS` | `127.0.0.1:8000` | Port de métriques cloudflared |

### Tunnel manuel (si besoin)

```bash
# lance le panel
npm start
# dans un autre terminal :
cloudflared tunnel --url http://localhost:3000
```

---

## 🚀 Installation locale

```bash
cd panel
npm install
npm start
```

Ouvre ensuite : **http://localhost:3000**

### Identifiants par défaut

| Champ | Valeur |
|---|---|
| Utilisateur | `admin` |
| Mot de passe | `emmanuel2024` |

> ⚠️ **Change le mot de passe** dès la première connexion (ou via les variables
> d'environnement ci-dessous). Le mot de passe est hashé au premier lancement.

---

## 🔧 Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PANEL_PORT` | `3000` | Port d'écoute du panel (**8080 est réservé** par la plateforme d'hébergement) |
| `SERVER_PORT` | — | Port fourni par Pterodactyl (priorité si défini) |
| `PANEL_USER` | `admin` | Nom d'utilisateur |
| `PANEL_PASS` | `emmanuel2024` | Mot de passe (hashé au 1er lancement) |
| `PANEL_SECRET` | *(à changer)* | Clé secrète des sessions |

Exemple :

```bash
PANEL_PORT=3000 PANEL_USER=emmanuel PANEL_PASS=MonMotDePasseFort npm start
```

---

## 🐉 Déploiement sur Pterodactyl

1. **Crée un serveur** dans ton panel Pterodactyl avec une allocation **Node.js**
   (egg « Node.js Generic » ou « Node.js »).
2. Envoie le dossier `panel/` sur le serveur (via SFTP ou le gestionnaire de fichiers).
3. Dans la console Pterodactyl :
   ```bash
   npm install
   npm start
   ```
4. Ouvre l'adresse `http://<ton-ip>:<port-alloué>`.

> Le panel lit automatiquement la variable `SERVER_PORT` fournie par Pterodactyl.

### Utiliser PM2 (recommandé en production)

```bash
npm install -g pm2
pm2 start server.js --name emmanuel-panel
pm2 save
pm2 startup
```

---

## 📱 Utiliser le panel avec ton bot WhatsApp

1. Connecte-toi au panel.
2. Clique sur **« + Nouveau serveur »** et donne-lui un nom.
3. Ouvre le serveur → onglet **Fichiers**.
4. **Glisse-dépose le ZIP de ton bot Baileys** dans la zone d'upload.
   Le panel va automatiquement :
   - extraire l'archive (y compris si elle contient un dossier racine) ;
   - **détecter le fichier d'entrée** via `package.json` (`main` / `scripts.start`)
     ou les noms usuels (`index.js`, `bot.js`, `main.js`…) ;
   - **lancer `npm install`** pour installer les dépendances (Baileys, etc.).
5. Vérifie le **fichier de démarrage** dans l'onglet *Démarrage*.
6. Clique sur **▶ Démarrer** → la console affiche la sortie du bot
   (QR code Baileys, logs, etc.).
7. Tu peux **taper des commandes** dans la barre sous la console : elles sont
   envoyées sur l'entrée standard du bot.

> 💡 Le panel n'accède **jamais** à ton compte WhatsApp : il ne fait que
> lancer/arrêter **ton** bot et afficher ses logs. La connexion WhatsApp se fait
> normalement via Baileys dans ton propre code.

### 🛠️ Dépannage

| Symptôme | Cause / Solution |
|---|---|
| Le bot affiche « Aucun bot installé » | C'est le fichier temporaire du panel : **uploade ton ZIP** (onglet Fichiers). Il est supprimé automatiquement à l'upload. |
| `Cannot find module 'baileys'` | Dépendances non installées → onglet *Démarrage* → **📦 Installer les dépendances**. |
| Le bot démarre mais ne fait rien | Mauvais fichier d'entrée → onglet *Démarrage* → **🔍 Détecter le fichier d'entrée**, puis *Enregistrer*. |
| `Fichier de démarrage introuvable` | Le nom dans l'onglet *Démarrage* ne correspond pas → corrige-le ou relance la détection. |
| Rien ne s'affiche dans la console | Vérifie que ton bot écrit bien sur `stdout` (`console.log`) et non dans un fichier. |
| Le panel s'affiche en désordre / sans style | Les chemins des assets sont **relatifs** (`css/style.css`, `js/app.js`) : le panel fonctionne à la racine comme dans un sous-dossier. Si tu vois tout en vrac, vide le cache du navigateur. |
| « Backend introuvable » (bandeau orange) | Tu consultes un **aperçu statique** : lance le vrai serveur (`npm start`) puis ouvre l'URL du serveur. |

---

## 📁 Structure du projet

```
panel/
├── server.js            # Serveur principal (API + Socket.IO)
├── config.js            # Configuration (port, identifiants, branding)
├── package.json
├── lib/
│   ├── auth.js          # Authentification (bcrypt + sessions)
│   ├── session-store.js # Sessions persistantes sur disque
│   ├── store.js         # Persistance JSON (serveurs, identifiants) + sauvegarde .bak
│   ├── servers.js       # Gestion des process (spawn, console, stats, autostart)
│   ├── tunnel.js        # Tunnel public Cloudflare auto-réparant
│   └── files.js         # Gestionnaire de fichiers + extraction ZIP
├── public/
│   ├── index.html       # Interface
│   ├── css/style.css    # Thème sombre
│   └── js/app.js        # Logique client
├── data/                # (généré) identifiants, serveurs, sessions, sauvegardes
└── servers/             # (généré) un dossier par bot
```

---

## 🔒 Sécurité

- Change `PANEL_PASS` et `PANEL_SECRET` avant toute mise en production.
- Place le panel derrière un **reverse proxy HTTPS** (Nginx / Caddy).
- Les chemins de fichiers sont confinés au dossier de chaque serveur
  (protection anti *path traversal*).
- Limite d'upload : 500 Mo (modifiable dans `config.js`).

---

## 📜 Licence

Projet fourni tel quel pour héberger **tes propres** bots. Utilise-le de manière
responsable et conforme aux conditions d'utilisation de WhatsApp et Telegram.
