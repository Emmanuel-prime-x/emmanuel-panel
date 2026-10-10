# EMMANUEL PANEL — Déploiement GRATUIT sur Render (SANS carte bancaire)

## Pourquoi cette solution ?

Le **sandbox** (où tournait le panel) est **coupé automatiquement** quand il n'y a
pas d'activité : c'est pour ça que « le panel ne marchait plus » pendant 3 jours.
Aucun logiciel ne peut garder une machine **éteinte** allumée.

**Oracle Cloud** (gratuit à vie) demande une **carte bancaire** → impossible pour toi.

👉 La meilleure solution **gratuite ET sans carte** s'appelle **Render**.
Render héberge le panel sur un vrai serveur, accessible par un **lien HTTPS permanent**.

---

## Ce que tu obtiens

Un lien du type :

```
https://emmanuel-panel-XXXX.onrender.com
```

Ce lien **ne change jamais**. Tu t'y connectes avec `admin` + ton mot de passe.

> ⚠️ Sur l'offre gratuite, Render met le service en veille après ~15 min **sans visite**,
> puis le réveille en ~1 min. Pour qu'il reste **éveillé 24/7**, on ajoute un « pinger »
> gratuit (UptimeRobot) — étape 4 ci-dessous. C'est gratuit et sans carte.

---

## Étape 1 — Mettre le code sur GitHub (gratuit, sans carte)

1. Crée un compte : <https://github.com/signup>
2. **New repository** → nom `emmanuel-panel` → coche **Public** → **Create**.
3. Clique **uploading an existing file**.
4. Décompresse `emmanuel-panel-RENDER.zip`, puis **glisse-dépose tous les fichiers**.
5. **Commit changes**.

## Étape 2 — Déployer sur Render (gratuit, sans carte)

1. <https://render.com> → **Get Started** → inscris-toi **avec GitHub**.
2. **New +** → **Web Service** → **Build and deploy from a Git repository**.
3. Colle l'URL de ton dépôt GitHub.
4. Render détecte le **Dockerfile** tout seul.
5. **Instance Type** = **Free**.
6. **Environment Variables** (Add) :
   - `PANEL_USER` = `admin`
   - `PANEL_PASS` = *(ton mot de passe)*
   - `PANEL_SECRET` = *(une longue phrase au hasard)*
   - `PANEL_TUNNEL` = `0`
7. **Create Web Service** → attends 3-5 min.

## Étape 3 — Récupère ton lien

En haut de la page Render : `https://emmanuel-panel-XXXX.onrender.com`
→ **C'est ton panel.** Connecte-toi : `admin` + ton mot de passe.

## Étape 4 — Garder le panel ÉVEILLÉ 24/7 (gratuit)

1. <https://uptimerobot.com> → compte gratuit (sans carte).
2. **Add New Monitor** → **HTTP(s)**.
3. URL : `https://emmanuel-panel-XXXX.onrender.com/api/ping`
4. Intervalle : **5 minutes** → **Create Monitor**.

✅ Le panel est ping toutes les 5 min → **il ne s'endort plus jamais**.

---

## Alternative : VRAI 24/7 pour ~1 €/mois (sans carte, via crypto/PayPal)

Si tu veux un serveur **toujours allumé sans veille** :

- **RackNerd** : VPS à partir de **~10 €/an** (~1 €/mois). Accepte **crypto**
  (USDT, BTC, LTC…) et **PayPal** → **pas besoin de carte bancaire**.
- Utilise le kit `emmanuel-panel-VPS-24-7.zip` (déjà prêt) : une seule commande
  installe le panel en service **systemd** qui redémarre tout seul pour toujours.

---

## Récapitulatif honnête

| Solution | Prix | Carte bancaire | 24/7 réel |
|---|---|---|---|
| **Render (gratuit)** | 0 € | ❌ non | ✅ avec UptimeRobot |
| **RackNerd VPS** | ~1 €/mois | ❌ non (crypto/PayPal) | ✅ oui |
| Oracle Cloud | 0 € | ✅ **oui (obligatoire)** | ✅ oui |
| Sandbox (avant) | 0 € | ❌ non | ❌ **non** (s'éteint) |

Je ne peux **pas créer ton compte à ta place** : chaque service exige **ton email**
(c'est une règle de sécurité de leur côté). Mais tout le reste est déjà préparé :
tu n'as qu'à suivre les étapes ci-dessus.
