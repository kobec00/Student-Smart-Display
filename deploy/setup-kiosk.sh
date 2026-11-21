#!/usr/bin/env bash
# Zet een Raspberry Pi (Zero 2 W) om in een kiosk: bij het opstarten logt hij
# automatisch in en opent Chromium schermvullend op het dashboard.
#
#   bash deploy/setup-kiosk.sh                                  # server op deze Pi
#   bash deploy/setup-kiosk.sh http://192.168.1.10:8090         # server op je Pi 4
#   ROTATE=90 bash deploy/setup-kiosk.sh                        # scherm een kwartslag draaien
#
# ROTATE (0, 90, 180 of 270) draait het beeld; nodig voor het Waveshare 11,9"-scherm,
# dat standaard rechtop staat (320×1480). Draai de aanraking mee met het knopje
# achteraan het scherm.
#
# Werkt op Raspberry Pi OS Lite (Bookworm of Trixie), 64-bit aanbevolen.
set -euo pipefail

BASE_URL="${1:-http://localhost:8090}"
BASE_URL="${BASE_URL%/}"
URL="${BASE_URL}/?kiosk=1"
ROTATE="${ROTATE:-0}"
case "${ROTATE}" in 0|90|180|270) ;; *) echo "ROTATE moet 0, 90, 180 of 270 zijn"; exit 1 ;; esac

echo "==> Kiosk voor ${URL} (beeld gedraaid: ${ROTATE}°)"

echo "==> Pakketten installeren (cage + Chromium)"
sudo apt-get update
if apt-cache show chromium >/dev/null 2>&1; then BROWSER_PKG=chromium; else BROWSER_PKG=chromium-browser; fi
sudo apt-get install -y --no-install-recommends cage "${BROWSER_PKG}" curl wlr-randr

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${HOME}/.local/bin"
cat > "${HOME}/.local/bin/smart-display-browser" <<EOF
#!/usr/bin/env bash
# Wacht tot de server antwoordt en start dan Chromium als kiosk.
for i in \$(seq 1 90); do
  curl -fs -o /dev/null "${BASE_URL}/api/health" && break
  sleep 2
done
if [ "${ROTATE}" != "0" ]; then
  OUTPUT="\$(wlr-randr 2>/dev/null | awk 'NR==1 {print \$1}')"
  [ -n "\${OUTPUT}" ] && wlr-randr --output "\${OUTPUT}" --transform ${ROTATE} || true
fi
BROWSER="\$(command -v chromium || command -v chromium-browser)"
# Geheugen is op een Zero 2 W (415 MB) de bottleneck: zonder deze vlaggen draait
# Chromium met zes hulpprocessen en swapt de Pi bij elke tik honderden MB.
#   PreloadTopChromeWebUI      geen voorgeladen browserschermen (~40 MB)
#   AudioServiceOutOfProcess   audio in het hoofdproces (geen apart proces)
#   NetworkServiceInProcess2   netwerk in het hoofdproces (geen apart proces)
#   --in-process-gpu           GPU in het hoofdproces (geen apart proces)
"\${BROWSER}" \\
  --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run \\
  --disable-session-crashed-bubble --disable-translate --lang=nl \\
  --disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints,PreloadTopChromeWebUI,AudioServiceOutOfProcess,BackForwardCache,SpareRendererForSitePerProcess \\
  --enable-features=NetworkServiceInProcess2 \\
  --in-process-gpu --renderer-process-limit=1 \\
  --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-breakpad \\
  --disable-component-update --check-for-update-interval=31536000 \\
  --password-store=basic --ozone-platform=wayland \\
  --enable-low-end-device-mode \\
  --disk-cache-size=16777216 --overscroll-history-navigation=0 \\
  --disable-pinch --touch-events=enabled \\
  --user-data-dir="\${HOME}/.cache/smart-display-chromium" \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \\
  "${URL}" &
BROWSER_PID=\$!

# Chromium onder Wayland navigeert soms niet bij het opstarten (grijs scherm);
# de waakhond controleert dat en opent het dashboard dan zelf.
NODE_FLAGS=""
node -e 'process.exit(typeof WebSocket === "undefined" ? 1 : 0)' 2>/dev/null || NODE_FLAGS="--experimental-websocket --no-warnings"
node \${NODE_FLAGS} "${APP_DIR}/deploy/kiosk-watchdog.mjs" "${URL}" 9222 >> "\${HOME}/.cache/smart-display-kiosk.log" 2>&1 &

wait "\${BROWSER_PID}"
EOF
chmod +x "${HOME}/.local/bin/smart-display-browser"

echo "==> Chromium-beleid: geen vertaal-, wachtwoord- of aanmeldvensters"
sudo mkdir -p /etc/chromium/policies/managed
sudo tee /etc/chromium/policies/managed/smart-display.json >/dev/null <<'POLICY'
{
  "TranslateEnabled": false,
  "BrowserSignin": 0,
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "SpellcheckEnabled": false,
  "BackgroundModeEnabled": false,
  "PromotionsEnabled": false
}
POLICY

echo "==> Onzichtbare muisaanwijzer (anders staat er een pijltje midden op het scherm)"
python3 "${APP_DIR}/deploy/blank-cursor.py"

echo "==> Bluetooth uit (niet nodig, scheelt geheugen)"
sudo systemctl disable --now bluetooth.service hciuart.service 2>/dev/null || true

echo "==> Wifi-energiebesparing uit (stabielere ping, sneller scherm)"
if [ -d /etc/NetworkManager/conf.d ]; then
  printf '[connection]\nwifi.powersave = 2\n' | sudo tee /etc/NetworkManager/conf.d/wifi-powersave-off.conf >/dev/null
fi

echo "==> Automatisch inloggen op de console"
sudo raspi-config nonint do_boot_behaviour B2

MARK="# smart-display kiosk"
if ! grep -q "${MARK}" "${HOME}/.bash_profile" 2>/dev/null; then
  cat >> "${HOME}/.bash_profile" <<EOF

${MARK}
if [ -z "\${WAYLAND_DISPLAY:-}" ] && [ "\$(tty)" = "/dev/tty1" ]; then
  while true; do
    cage -d -s -- "\${HOME}/.local/bin/smart-display-browser"
    sleep 3
  done
fi
EOF
fi

# Geen consoleschermbeveiliging
CMDLINE=/boot/firmware/cmdline.txt
[ -f "${CMDLINE}" ] || CMDLINE=/boot/cmdline.txt
if [ -f "${CMDLINE}" ] && ! grep -q consoleblank "${CMDLINE}"; then
  sudo sed -i '1 s/$/ consoleblank=0/' "${CMDLINE}"
fi

# Server op een andere Pi (bv. de Pi 4): oude links doorsturen en het wifi-signaal melden.
case "${BASE_URL}" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) bash "${APP_DIR}/deploy/use-remote-server.sh" "${BASE_URL}" ;;
esac

echo
echo "Klaar. Herstart met:  sudo reboot"
echo "Uitzetten: verwijder het blok '${MARK}' uit ~/.bash_profile."
