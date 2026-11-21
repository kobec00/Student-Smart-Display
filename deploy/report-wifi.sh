#!/usr/bin/env bash
# Meldt het wifi-signaal van het display aan de server, als die op een andere Pi draait
# (zo tonen de balkjes onderaan de navigatiebalk het signaal van het scherm zelf).
# Wordt elke minuut gestart door smart-display-wifi.timer (zie deploy/use-remote-server.sh).
#   bash deploy/report-wifi.sh http://192.168.1.20:8090
set -eu
SERVER="${1:?geef de server-URL mee, bv. http://192.168.1.20:8090}"
DBM="$(awk '/^ *wlan[0-9]+:/ { v = $4; sub(/\.$/, "", v); print v; exit }' /proc/net/wireless)"
[ -n "${DBM}" ] || exit 0
curl -fsS -m 5 -o /dev/null -H 'Content-Type: application/json' -d "{\"dbm\":${DBM}}" "${SERVER%/}/api/display/wifi"
