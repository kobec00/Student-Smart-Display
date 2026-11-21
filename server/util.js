import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Datums (lokale tijd van de server) ─────────────────────

/** 'YYYY-MM-DD' in lokale tijd. */
export function isoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Dagnummer voor een 'YYYY-MM-DD'-string, om dagen tussen datums te tellen. */
export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return dayNumber(toIso) - dayNumber(fromIso);
}

export function isIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

export function parseClock(hhmm, fallback = '07:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '') ?? /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── JSON-opslag met atomisch schrijven ─────────────────────

export function createStore(file, seed) {
  let data;
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[store] ${file} is onleesbaar, ik begin opnieuw:`, err.message);
    }
  }
  if (!data) {
    data = seed();
    save();
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  }

  return {
    get: () => data,
    update(fn) {
      const result = fn(data);
      save();
      return result;
    },
  };
}

export const newId = () => randomUUID().slice(0, 8);

export async function fetchJSON(url, { timeout = 8000, ...opts } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${new URL(url).pathname}`);
  return res.json();
}

/**
 * Voert `task` periodiek uit en houdt het laatste resultaat bij.
 * Mislukt een poging (bv. vlak na het opstarten, als de Pi nog druk bezig is),
 * dan volgt er snel een nieuwe: na 20 s, 40 s, 80 s … in plaats van pas na het volle interval.
 */
export function poller(name, intervalMs, task) {
  let state = { state: 'loading' };
  let running = false;
  let failures = 0;
  let retry = null;
  async function run() {
    if (running) return;
    running = true;
    clearTimeout(retry);
    try {
      state = await task();
      failures = 0;
    } catch (err) {
      console.error(`[${name}]`, err.message);
      state = { ...state, state: 'error', error: err.message, failedAt: new Date().toISOString() };
      const wait = 20_000 * 2 ** failures++;
      if (wait < intervalMs) {
        retry = setTimeout(run, wait);
        retry.unref();
      }
    } finally {
      running = false;
    }
  }
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { get: () => state, refresh: run };
}
