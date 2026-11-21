#!/usr/bin/env bash
# Zet de nieuwste versie van de app op de Pi('s) en herstart de server.
# Het scherm (en je gsm) merkt dat en herlaadt de pagina zelf; de browser blijft
# draaien, want die opnieuw starten kost een Pi Zero enkele minuten.
# Je taken (data/), school.json en config.json op de server blijven ongemoeid.
#
#   bash deploy/update-pi.sh SERVER [SCHERM]
#   bash deploy/update-pi.sh pi@lumen-server.local pi@lumen.local   # server op de Pi 4, scherm op de Zero
#   bash deploy/update-pi.sh pi@lumen.local                          # server en scherm op dezelfde Pi
#   BROWSER=reload  bash deploy/update-pi.sh …    # pagina op het scherm geforceerd herladen
#   BROWSER=restart bash deploy/update-pi.sh …    # Chromium helemaal opnieuw starten
set -euo pipefail

SERVER="${1:-pi@lumen.local}"
SCREEN="${2:-${SERVER}}"
# Optional: SSH_KEY=~/.ssh/my_key bash deploy/update-pi.sh …
SSH="ssh ${SSH_KEY:+-i ${SSH_KEY}} -o StrictHostKeyChecking=accept-new"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

push() {
  rsync -az --delete \
    --exclude node_modules --exclude data --exclude config.json --exclude school.json --exclude .git --exclude .DS_Store \
    -e "${SSH}" ./ "$1:smart-display/"
}

echo "==> Bestanden naar ${SERVER}"
push "${SERVER}"
if [ "${SCREEN}" != "${SERVER}" ]; then
  echo "==> Kioskscripts naar ${SCREEN}"
  push "${SCREEN}"
fi

echo "==> Server herstarten op ${SERVER}"
${SSH} "${SERVER}" 'sudo systemctl restart smart-display'
case "${BROWSER:-}" in
  reload)
    echo "==> Pagina op het scherm herladen"
    ${SSH} "${SERVER}" 'for i in $(seq 1 30); do curl -fs -o /dev/null http://localhost:8090/api/health && break; sleep 1; done'
    ${SSH} "${SCREEN}" 'FLAGS=""; node -e "process.exit(typeof WebSocket === \"undefined\" ? 1 : 0)" 2>/dev/null || FLAGS="--experimental-websocket --no-warnings"
      node ${FLAGS} ~/smart-display/deploy/kiosk-reload.mjs' ;;
  restart)
    echo "==> Chromium opnieuw starten"
    ${SSH} "${SCREEN}" 'pkill -x chromium || true' ;;
esac
echo "Klaar."
