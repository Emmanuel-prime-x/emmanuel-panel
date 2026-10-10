/**
 * Configuration globale du panel.
 * Modifie ces valeurs avant le deploiement.
 */
const path = require('path');

module.exports = {
  // Port d'ecoute du panel.
  // IMPORTANT : on utilise 3000 par defaut car c'est un port "suivi" par la
  // plateforme d'hebergement (le port 8080 est reserve/ignore et ne serait pas
  // restaure automatiquement apres un redemarrage du sandbox).
  // SERVER_PORT est la convention Pterodactyl (allocation du serveur).
  // Ordre de priorite : PANEL_PORT (VPS/Docker) > SERVER_PORT (Pterodactyl)
  // > PORT (convention des PaaS comme Render/Railway/Koyeb) > 3000 (defaut).
  PORT: process.env.PANEL_PORT || process.env.SERVER_PORT || process.env.PORT || 3000,

  // Identifiants de connexion au panel (a changer !)
  ADMIN: {
    username: process.env.PANEL_USER || 'admin',
    // Mot de passe en clair au premier lancement : il sera hashe automatiquement
    password: process.env.PANEL_PASS || 'emmanuel2024'
  },

  // Cle secrete des sessions (a changer !)
  SESSION_SECRET: process.env.PANEL_SECRET || 'change-moi-secret-emmanuel-panel',

  // Dossiers
  DATA_DIR: path.join(__dirname, 'data'),
  SERVERS_DIR: path.join(__dirname, 'servers'),
  UPLOAD_DIR: path.join(__dirname, 'data', 'uploads'),

  // Limite de taille d'upload (en octets) -> 500 Mo
  MAX_UPLOAD: 500 * 1024 * 1024,

  // ---- Tunnel public (Cloudflare) ----
  // Le panel expose automatiquement une URL publique https via un tunnel
  // Cloudflare "quick tunnel". Le binaire est stocke dans /workspace (persistant)
  // pour survivre aux redemarrages du sandbox.
  TUNNEL: {
    enabled: process.env.PANEL_TUNNEL === '0' ? false : true,
    // Binaire cloudflared (chemin persistant)
    binary: process.env.CLOUDFLARED_BIN || path.join(__dirname, 'bin', 'cloudflared'),
    // Fichier log du tunnel
    logFile: path.join(__dirname, 'data', 'cloudflared.log'),
    // Fichier d'etat (pid + url)
    stateFile: path.join(__dirname, 'data', 'tunnel.json'),
    // Publication de l'URL courante sur ntfy.sh : permet a la page "launcher"
    // (URL stable) de toujours rediriger vers le panel en ligne.
    publishBase: process.env.PANEL_PUBLISH_BASE || 'https://ntfy.sh',
    publishTopic: process.env.PANEL_PUBLISH_TOPIC || 'emmanuel-panel-9f4a2c7b'
  },

  // Nom du panel (branding)
  BRAND: 'EMMANUEL PANEL',
  OWNER: 'PROFESSEUR EMMANUEL X',
  OWNER_TG: 'https://t.me/emmanuelprimex'
};
