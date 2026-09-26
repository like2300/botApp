#!/bin/bash
# ============================================================================
# Installation / mise a jour du bot WhatsApp + Mistral sur AlwaysData (SSH)
# Usage :
#   1. Uploadez ce projet (ou git clone) dans ~/botApp sur AlwaysData
#   2. Connectez-vous en SSH :  ssh <compte>@ssh-alwaysdata.com
#   3. Lancez :  bash ~/botApp/alwaysdata-setup.sh
# ============================================================================
set -euo pipefail

APP_DIR="$HOME/botApp"
# Si le script est lance depuis le dossier du projet, on l'utilise tel quel
if [ -f "./server.js" ] && [ -f "./package.json" ]; then
  APP_DIR="$(pwd)"
fi

echo "==> Dossier applicatif : $APP_DIR"
cd "$APP_DIR"

echo "==> 1/ Version Node.js"
node --version || { echo "ERREUR : Node.js introuvable. Activez Node.js >= 20 sur AlwaysData (Panel > Environnements > Node.js)."; exit 1; }
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERREUR : Node.js >= 20 requis (actuel : $(node --version)). Changez la version dans le panel AlwaysData."
  exit 1
fi

echo "==> 2/ Dependances (npm ci)"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "==> 3/ Dossiers de donnees"
mkdir -p "${AUTH_DIR:-$APP_DIR/auth_info}"
touch "$APP_DIR/bot.db" 2>/dev/null || true

echo "==> 4/ Fichier .env (cree uniquement s'il n'existe pas)"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'EOF'
# Port injecte par AlwaysData (variable $PORT fournie par la plateforme).
# Laissez vide ici : c'est start.sh / le panel qui le fournit.
PORT=3000
# Cle Mistral (OBLIGATOIRE) : collez votre cle ci-dessous
MISTRAL_API_KEY=
# Secret cookies panneau /admin (changez-moi en production !)
ADMIN_COOKIE_SECRET=changez-moi-en-production
# Dossiers de persistance (defauts OK sur AlwaysData)
AUTH_DIR=./auth_info
DB_PATH=./bot.db
# Laissez vide en production (le bot WhatsApp doit tourner)
# SKIP_BOT=1
EOF
  echo "    .env cree : EDITEZ-LE (MISTRAL_API_KEY + ADMIN_COOKIE_SECRET)."
else
  echo "    .env existe deja, on n'y touche pas."
fi

echo "==> 5/ Wrapper de demarrage start.sh (charge .env puis lance le bot)"
cat > "$APP_DIR/start.sh" <<'EOF'
#!/bin/bash
# Demarre le bot en chargeant les variables de .env (sans dotenv requis).
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
[ -f ./.env ] && . ./.env
set +a
# Le $PORT fourni par AlwaysData a priorite sur celui du .env
exec node server.js
EOF
chmod +x "$APP_DIR/start.sh"

echo "==> 6/ Test de demarrage (10 s, bot desactive)"
SKIP_BOT=1 PORT=3001 timeout 10 node server.js || CODE=$?
CODE=${CODE:-0}
if [ "$CODE" -eq 124 ]; then
  echo "    OK : le serveur demarre (timeout de 10 s atteint = normal)."
elif [ "$CODE" -eq 0 ]; then
  echo "    OK : demarrage teste avec succes."
else
  echo "    ATTENTION : code de sortie $CODE pendant le test. Verifiez les logs ci-dessus."
fi

echo ""
echo "==================== SUITE DANS LE PANEL ALWAYSDATA ===================="
echo " 1. Web > Sites > Ajouter : type 'Programme utilisateur' (ou 'Node.js'),"
echo "    commande de demarrage :  $APP_DIR/start.sh"
echo " 2. Variables d'environnement du site :"
echo "      MISTRAL_API_KEY=<votre cle>  ADMIN_COOKIE_SECRET=<secret long>"
echo "    (le \$PORT est injecte automatiquement par AlwaysData)"
echo " 3. Redemarrez le site, puis ouvrez son URL : scannez le QR WhatsApp."
echo " 4. Mises a jour suivantes : git pull + relancez ce script."
echo "========================================================================"
