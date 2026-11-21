// Netwerk: internetlatentie (eigen meting, geen dienst nodig) en het
// wifi-signaal van de Pi. Op een Mac is wifi niet beschikbaar (null).
import net from 'node:net';
import { readFile } from 'node:fs/promises';

const HISTORY = 40;

/** Meet hoe lang een TCP-verbinding naar host:port duurt (ms), of null bij een fout. */
function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(null));
    socket.once('error', () => done(null));
    socket.once('connect', () => done(Math.round(Number(process.hrtime.bigint() - start) / 1e6)));
  });
}

async function wifiSignal() {
  try {
    const text = await readFile('/proc/net/wireless', 'utf8');
    const line = text.split('\n').find((l) => /^\s*wlan\d+:/.test(l));
    if (!line) return null;
    const dbm = Number.parseFloat(line.trim().split(/\s+/)[3]);
    return Number.isFinite(dbm) ? Math.round(dbm) : null;
  } catch {
    return null;
  }
}

// Draait de server niet op het display zelf (maar op de Pi 4), dan meldt het display zijn
// wifi-signaal elke minuut met POST /api/display/wifi (deploy/report-wifi.sh). Een melding
// geldt drie minuten; daarna valt de server terug op zijn eigen wifi (of niets).
const REPORT_FRESH_MS = 3 * 60_000;

export function createSystem(cfg) {
  const host = cfg.network?.pingHost ?? '1.1.1.1';
  const port = Number(cfg.network?.pingPort ?? 443);
  const state = { internet: { host, ping: null, history: [] }, wifi: null, updatedAt: null };
  let localWifi = null;
  let reported = null;

  async function run() {
    const [ping, wifi] = await Promise.all([tcpPing(host, port), wifiSignal()]);
    state.internet.ping = ping;
    state.internet.history = [...state.internet.history, ping].slice(-HISTORY);
    localWifi = wifi;
    state.updatedAt = new Date().toISOString();
  }
  run();
  setInterval(run, 30_000).unref();

  function get() {
    state.wifi = reported && Date.now() - reported.at < REPORT_FRESH_MS ? reported.dbm : localWifi;
    return state;
  }

  function reportWifi(dbm) {
    const n = Math.round(Number(dbm));
    if (!Number.isFinite(n) || n > 0 || n < -120) {
      throw Object.assign(new Error('Geef het wifi-signaal in dBm, bv. -55.'), { status: 400 });
    }
    reported = { dbm: n, at: Date.now() };
    return { ok: true };
  }

  return { get, reportWifi };
}
