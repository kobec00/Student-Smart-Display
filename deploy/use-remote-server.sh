#!/usr/bin/env bash
# Laat het display (de Pi Zero 2 W) de server op een andere Pi gebruiken, bv. de Pi 4.
# Draai dit op het display:
#   bash deploy/use-remote-server.sh http://192.168.1.20:8090
#
# Wat het doet:
#   1. de server op het display stoppen en uitzetten (scheelt ~50 MB geheugen);
#   2. poort 8090 van het display doorsturen naar de server (in de kernel, kost geen
#      geheugen), zodat oude links blijven werken: de gsm-app, de iPhone-opdracht, je VPN;
#   3. de kiosk het dashboard van de server laten openen;
#   4. elke minuut het wifi-signaal van het scherm aan de server melden.
# Daarna Chromium herstarten:  pkill -x chromium  (de kiosk start vanzelf opnieuw).
#
# Terug naar een server op het display zelf:
#   bash deploy/use-remote-server.sh --local
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"
LAUNCHER="${HOME}/.local/bin/smart-display-browser"
NFT=/etc/smart-display-forward.nft

if [ "${1:-}" = "--local" ]; then
  echo "==> Doorsturen en wifi-meldingen uit"
  sudo systemctl disable --now smart-display-forward.service smart-display-wifi.timer 2>/dev/null || true
  sudo rm -f "${NFT}" /etc/sysctl.d/90-smart-display-forward.conf \
    /etc/systemd/system/smart-display-forward.service \
    /etc/systemd/system/smart-display-wifi.service /etc/systemd/system/smart-display-wifi.timer
  sudo systemctl daemon-reload
  [ -f "${LAUNCHER}" ] && sed -i -E 's#https?://[A-Za-z0-9.-]+:8090#http://localhost:8090#g' "${LAUNCHER}"
  echo "==> Server op het display weer aan"
  sudo systemctl enable --now smart-display
  echo "Klaar. Herstart Chromium:  pkill -x chromium"
  exit 0
fi

SERVER="${1:?geef de server-URL mee, bv. http://192.168.1.20:8090}"
SERVER="${SERVER%/}"
HOSTPORT="${SERVER#*://}"
HOSTPORT="${HOSTPORT%%/*}"
TARGET_HOST="${HOSTPORT%%:*}"
TARGET_PORT="${HOSTPORT##*:}"
[ "${TARGET_PORT}" = "${HOSTPORT}" ] && TARGET_PORT=80
# nftables wil een IPv4-adres
if ! [[ "${TARGET_HOST}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  TARGET_IP="$(getent ahostsv4 "${TARGET_HOST}" | awk 'NR==1 {print $1}')"
else
  TARGET_IP="${TARGET_HOST}"
fi
[ -n "${TARGET_IP:-}" ] || { echo "Kan ${TARGET_HOST} niet vinden."; exit 1; }

echo "==> Server controleren: ${SERVER}"
curl -fsS -m 5 -o /dev/null "${SERVER}/api/health" || { echo "De server op ${SERVER} antwoordt niet. Draait hij al?"; exit 1; }

echo "==> Server op het display stoppen"
sudo systemctl disable --now smart-display 2>/dev/null || true

echo "==> Poort 8090 doorsturen naar ${TARGET_IP}:${TARGET_PORT}"
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/90-smart-display-forward.conf >/dev/null
sudo sysctl -q -w net.ipv4.ip_forward=1
sudo tee "${NFT}" >/dev/null <<EOF
# Lumen: links naar het display (poort 8090) gaan naar de server op ${TARGET_IP}.
# (eerst aanmaken en weer wissen, zodat opnieuw laden geen dubbele regels geeft)
table ip smartdisplay
delete table ip smartdisplay
table ip smartdisplay {
  chain prerouting {
    type nat hook prerouting priority dstnat;
    fib daddr type local tcp dport 8090 dnat to ${TARGET_IP}:${TARGET_PORT}
  }
  chain postrouting {
    type nat hook postrouting priority srcnat;
    ip daddr ${TARGET_IP} tcp dport ${TARGET_PORT} masquerade
  }
}
EOF
sudo tee /etc/systemd/system/smart-display-forward.service >/dev/null <<EOF
[Unit]
Description=Lumen: poort 8090 doorsturen naar de server
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${NFT}
ExecStop=/usr/sbin/nft delete table ip smartdisplay

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wifi-signaal elke minuut melden"
sudo tee /etc/systemd/system/smart-display-wifi.service >/dev/null <<EOF
[Unit]
Description=Lumen: wifi-signaal van het scherm melden aan de server

[Service]
Type=oneshot
User=${RUN_USER}
ExecStart=/usr/bin/env bash ${APP_DIR}/deploy/report-wifi.sh ${SERVER}
EOF
sudo tee /etc/systemd/system/smart-display-wifi.timer >/dev/null <<'EOF'
[Unit]
Description=Lumen: wifi-signaal elke minuut melden

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable smart-display-forward.service smart-display-wifi.timer
sudo systemctl restart smart-display-forward.service smart-display-wifi.timer

if [ -f "${LAUNCHER}" ]; then
  echo "==> Kiosk opent voortaan ${SERVER}"
  sed -i -E "s#https?://[A-Za-z0-9.-]+:8090#${SERVER}#g" "${LAUNCHER}"
fi

echo
echo "Klaar. Herstart Chromium:  pkill -x chromium"
