// Configuration PM2 pour EMMANUEL PANEL (optionnel).
// Utilisation : pm2 start ecosystem.config.js
//
// IMPORTANT : le port 8080 est RESERVE par la plateforme d'hebergement
// (serveur HTTP du sandbox). Le panel doit donc ecouter sur 3000.
module.exports = {
  apps: [
    {
      name: 'emmanuel-panel',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PANEL_PORT: 3000,
        PANEL_TUNNEL: '1'
        // PANEL_USER: 'admin',
        // PANEL_PASS: 'change-moi',
        // PANEL_SECRET: 'change-moi-secret'
      }
    }
  ]
};
