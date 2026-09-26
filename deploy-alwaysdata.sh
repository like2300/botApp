#!/bin/bash
# ============================================================================
# Deploiement rapide sur AlwaysData (appele par GitHub Actions apres un push).
# Leger : git pull + redemarrage, SANS reinstallation npm ni test de boot.
# Usage manuel :  bash ~/botApp/deploy-alwaysdata.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "==> git pull"
git pull --ff-only

if [ ! -d "node_modules/@whiskeysockets/baileys" ] || [ ! -d "node_modules/better-sqlite3" ]; then
  echo "ATTENTION : node_modules incomplet. Lancez d'abord : bash alwaysdata-setup.sh"
  exit 1
fi

echo "==> Redemarrage du bot (le superviseur AlwaysData le relance)"
pkill -f "node server.js" || echo "    (aucun processus en cours, demarrez le site depuis le panel)"
sleep 2
if pgrep -f "node server.js" >/dev/null; then
  echo "    OK : processus bot actif."
else
  echo "    Le bot ne semble pas relance tout seul : redemarrez le site dans le panel AlwaysData."
fi
