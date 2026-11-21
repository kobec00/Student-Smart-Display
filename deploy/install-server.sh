#!/usr/bin/env bash
# Installeert de Lumen-server als systemd-dienst.
# Draai dit op de Pi waar de server moet lopen (liefst de Pi 4; op de Zero kost hij ~50 MB
# van de 415 MB die Chromium nodig heeft):
#   bash deploy/install-server.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"
# Weinig geheugen (een Zero): Node zuinig laten draaien. Op een Pi 4 is dat niet nodig.
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
NODE_OPTS=""
if [ "${MEM_KB}" -lt 1000000 ]; then
  NODE_OPTS='Environment=NODE_OPTIONS="--max-old-space-size=48 --max-semi-space-size=1"'
fi

echo "==> Lumen in ${APP_DIR} (gebruiker: ${RUN_USER})"

# Node.js 18 of nieuwer (zonder npm: dat is op een Pi Zero erg traag)
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> Node.js installeren"
  sudo apt-get update
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v)"

cd "${APP_DIR}"
if [ ! -f node_modules/ical.js/package.json ]; then
  echo "==> Afhankelijkheden installeren (zonder dev-pakketten)"
  command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm
  npm ci --omit=dev --no-audit --no-fund
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "==> config.json aangemaakt uit het voorbeeld. Pas het aan en herstart met:"
  echo "    sudo systemctl restart smart-display"
fi

echo "==> systemd-dienst schrijven"
sudo tee /etc/systemd/system/smart-display.service >/dev/null <<EOF
[Unit]
Description=Lumen (student smart display server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
${NODE_OPTS}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now smart-display
sleep 2
systemctl --no-pager --lines=5 status smart-display || true
echo
echo "Klaar. Test met:  curl -s http://localhost:8090/api/health"
