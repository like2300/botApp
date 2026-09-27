# botApp — Bot WhatsApp + Mistral AI

Bot WhatsApp qui répond automatiquement aux messages grâce à l'IA **Mistral**, avec une **interface web** (QR, réglages, assistants, historique) et une base **SQLite** locale.

## ✨ Fonctionnalités

- 📲 **Connexion WhatsApp** via Baileys — QR affiché sur la page web, reconnexion auto
- 🤖 **Réponses IA Mistral** : API *Conversations* (suivi serveur + miroir SQLite) avec repli auto sur *chat/completions*
- 👥 **Comptes utilisateurs** : inscription / connexion (mot de passe haché scrypt), premier compte = admin
- 🧩 **Assistants multiples par utilisateur** (max 10) : chacun a son modèle, son prompt, sa clé API, son historique ; un assistant actif répond
- 🔐 **Clés API jamais exposées** : stockées côté serveur (SQLite ou variable d'env), l'interface ne voit que `***ABCD`
- ⏳ **Anti-blocage WhatsApp** : file d'attente, délai aléatoire 4–9 s, max 8 msg/min, cooldown 10 s/user, groupes ignorables
- 📱 **Mot de passe oublié** : code à 6 chiffres envoyé sur le numéro WhatsApp enregistré
- 🧹 **Reset de conversation** par contact (nouveau prompt/modèle = conversations réinitialisées)
- 📊 Logs temps réel (Socket.io), statistiques, historique par contact
- 🩺 Healthcheck `GET /api/health` pour les hébergeurs

## 🧰 Stack

| Couche | Techno |
|---|---|
| Serveur | Node.js ≥ 20, Express 4, Socket.io |
| WhatsApp | @whiskeysockets/baileys 6 |
| IA | Mistral (`/v1/conversations` + `/v1/chat/completions`) |
| Base | better-sqlite3 (`bot.db`) |
| Auth web | sessions SQLite + scrypt |
| Déploiement | Dockerfile, Railway, AlwaysData, Vercel (API seule) |

## 📁 Structure

```
server.js              → serveur Express + bot WhatsApp + file d'attente + API
db.js                  → SQLite : réglages, users, assistants, sessions, conversations, messages
auth.js                → inscription/connexion, hash scrypt, sessions, middleware
create-admin.js        → crée/promeut un admin : node create-admin.js <login> <pass> [nom] [tel]
public/
  index.html           → tableau de bord (QR, logs, réglages, contacts, historique)
  login.html           → connexion / inscription / mot de passe oublié
  assistants.html      → gestion des assistants
auth_info/             → SESSION WHATSAPP (gitignoré, à sauvegarder ! voir § Persistance)
bot.db                 → base SQLite (gitignorée)
Dockerfile             → image prod Node 20 (volume persistant /data)
railway.json           → déploiement Railway (Docker + healthcheck)
vercel.json            → déploiement Vercel (API seule, bot désactivé)
alwaysdata-setup.sh    → installation sur AlwaysData via SSH
deploy.bat / ecosystem.config.js → déploiement Windows / PM2
```

## 🚀 Installation locale

```bash
git clone https://github.com/like2300/botApp.git
cd botApp
npm install
node server.js
```

Ouvrez http://localhost:3000 :
1. Créez un compte (le 1er est **admin**)
2. Renseignez la **clé Mistral** (panneau réglages → stockée en SQLite)
3. Scannez le **QR** avec WhatsApp (Appareils liés)
4. Envoyez un message au numéro connecté → le bot répond 🤖

## 🔧 Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP (injecté par l'hébergeur en prod) |
| `MISTRAL_API_KEY` | — | Clé globale (prioritaire sur SQLite si définie) |
| `ADMIN_COOKIE_SECRET` | valeur dev | Secret des cookies de session — **à changer en prod** |
| `AUTH_DIR` | `./auth_info` | Dossier session WhatsApp |
| `DB_PATH` | `./bot.db` (`/tmp/bot.db` sur Vercel) | Fichier SQLite |
| `SKIP_BOT` | — | `=1` → démarre l'API sans WhatsApp (tests) |

Le modèle, le prompt système, les délais et les limites se règlent dans **l'interface web** (persistés en SQLite, clés `cfg_*`).

## 🔌 API (résumé)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health`, `/api/status` | santé / état WhatsApp |
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | comptes |
| GET | `/api/auth/me` | profil + assistants |
| POST | `/api/auth/forgot`, `/api/auth/reset` | reset mot de passe via WhatsApp |
| GET/POST/PUT/DELETE | `/api/assistants…`, `/api/assistants/:id/activate` | CRUD assistants |
| GET/POST | `/api/config` | réglages (clé masquée) |
| GET | `/api/test-mistral` | test réel de la clé (mini-conversation) |
| GET | `/api/contacts`, `/api/history` | contacts + historique par `?jid=` |
| POST | `/api/conversation/reset` | réinitialise une conversation |
| POST | `/api/logout` | déconnecte WhatsApp (supprime `auth_info`) |

## 📲 API OTP (pour vos apps externes)

Chaque compte a **sa propre URL d'envoi** (clé API créée sur le dashboard → carte *API OTP*) : vos apps appellent l'URL avec le numéro destinataire + le code, le message part du WhatsApp **de ce compte**.

```
GET https://VOTRE-DOMAINE/api/otp/send?token=CLE_DU_COMPTE&to=243810000000&code=482913
→ {"ok":true,"to":"243810000000","id":"..."}
```

- Message envoyé : `🔐 Votre code de vérification : *482913*` (`&message=...` pour un texte perso, 1000 car. max)
- Alternative : `POST /api/send-otp` (Bearer session) `{ "to", "code", "message?" }`
- Erreurs : `401` clé invalide, `422` numéro/code invalide, `409` WhatsApp du compte déconnecté (rescannez le QR), `429` quota/min, `502` échec d'envoi
- Les clés se gèrent sur le dashboard (créer / supprimer, max 10) ; la clé complète n'est affichée qu'à la création

## 💾 Persistance (important)

- `auth_info/` = appairage WhatsApp : **sans lui, il faut rescanner le QR**. Ne le commitez jamais, sauvegardez-le.
- `bot.db` = users, clés, conversations : même règle.
- En production il faut un **disque persistant** (Railway volume `/data`, AlwaysData : dossier home). Sur les plateformes serverless/stateless (Vercel), ces données **ne survivent pas** aux redémarrages.

## ☁️ Déploiement

**Railway (recommandé pour le bot complet)** : déploiement via le `Dockerfile`, healthcheck `/api/health`. Montez un volume sur `/data` et définissez `DB_PATH=/data/bot.db`, `AUTH_DIR=/data/auth_info`, `MISTRAL_API_KEY`, `ADMIN_COOKIE_SECRET`.

**Docker** : `docker build -t botapp . && docker run -p 3000:3000 -v botdata:/data -e DB_PATH=/data/bot.db -e AUTH_DIR=/data/auth_info -e MISTRAL_API_KEY=... botapp`

**AlwaysData (SSH)** : `bash alwaysdata-setup.sh` (installe les deps, crée `.env` + `start.sh`), puis créez un site *Programme utilisateur* avec commande `~/botApp/start.sh`. Détails affichés par le script.
**Déploiement auto** : chaque push sur `main` déclenche le workflow `deploy-alwaysdata` (git pull + redémarrage sur le serveur via SSH). Secrets requis : `ALWAYS_HOST`, `ALWAYS_USER`, `ALWAYS_SSH_KEY`, `ALWAYS_APP_DIR`.

**Vercel (limité)** : seule l'interface/API se déploie (`SKIP_BOT=1`, SQLite dans `/tmp`). Le **bot WhatsApp ne peut pas tourner en serverless** (connexion persistante + Socket.io + pas de disque). Gardez Vercel pour la vitrine, Railway/AlwaysData pour le bot.

## 🛠️ Scripts npm

- `npm start` → lance le bot (`node server.js`)
- `npm run admin` → `node create-admin.js <login> <pass> [nom] [tel]` (crée un admin)
