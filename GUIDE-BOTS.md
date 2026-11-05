# Bots intégrés — la solution définitive (Render gratuit)

Sur Render gratuit l'instance n'a que **0,1 CPU / 512 Mo** et son disque est **effacé à chaque
redémarrage**. Un `npm install` fait *sur* l'instance est donc très lent, échoue souvent, et tout
est perdu au redémarrage suivant.

**Solution : installer les bots pendant le BUILD** (machine puissante de Render) et les mettre
**dans l'image**. Résultat : plus aucun `npm install` au démarrage, plus rien à uploader, et les bots
reviennent tout seuls après chaque redémarrage.

## Méthode A — depuis GitHub (recommandée, faisable depuis le téléphone)

1. Sur GitHub, ouvre le fichier **`bots.txt`** de ton dépôt du panel → ✏️ Modifier.
2. Ajoute **une ligne par bot** : `nom  url-du-depot  [branche]`

   ```
   queen-hina   https://github.com/TON-COMPTE/queen-hina.git
   bug-bot      https://github.com/TON-COMPTE/bug-bot.git
   ```
   Dépôt privé : `https://${GITHUB_TOKEN}@github.com/TON-COMPTE/mon-bot.git`
   (et crée la variable `GITHUB_TOKEN` dans Render → Environment ; **n'écris jamais le jeton dans le fichier**).
3. **Commit** → Render reconstruit tout seul (3 à 8 min). Les bots apparaissent dans le panel et démarrent.

## Méthode B — dossier directement dans le dépôt

Mets le dossier du bot dans **`bots/<nom>/`** (avec son `package.json`). Même résultat.

## Secrets (tokens, clés)

Mets-les dans **Render → Environment** (ex. `BOT_TOKEN`) : elles sont transmises automatiquement aux bots.
Réglages facultatifs d'un bot : `bots/<nom>/panel.json`
```json
{ "name": "QUEEN HINA", "startupFile": "index.js", "env": { "PREFIX": "." } }
```

## Bon à savoir

- Un bot intégré se met à jour en modifiant son dépôt puis en relançant un déploiement.
- Les données écrites par le bot (sessions, bases locales) restent éphémères sur Render gratuit :
  pour les garder il faut un disque Render payant ou une base externe (MongoDB Atlas gratuit, etc.).
- L'upload de fichiers dans le panel reste disponible (par morceaux, avec reprise automatique).
