import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Standaardinstellingen. Overschrijf ze in config.json (zie config.example.json).
const DEFAULTS = {
  port: 8090,
  host: '0.0.0.0',
  title: 'Lumen',
  locale: 'nl-BE',
  location: { name: 'Brussel', latitude: 50.85, longitude: 4.35 },
  calendars: [],
  categories: [
    { id: 'school', label: 'School' },
    { id: 'persoonlijk', label: 'Persoonlijk' },
    { id: 'werk', label: 'Werk' },
    { id: 'kot', label: 'Kot' },
  ],
  // Afvalophaling (Recycle!): vul je adres in en de ophaaltaken komen vanzelf op de takenlijst.
  waste: { postcode: '', street: '', houseNumber: '', category: 'kot', putOut: 'evening', showDaysBefore: 1 },
  network: { pingHost: '1.1.1.1', pingPort: 443 },
  display: {
    nightStart: '23:00',
    nightEnd: '07:00',
    // Ochtendscherm: verschijnt om morningStart en verdwijnt bij een tik of om morningEnd. Leeg = uit.
    morningStart: '06:00',
    morningEnd: '11:00',
    idleReturnSeconds: 90,
    theme: 'auto',
    // Je voornaam voor de begroeting ("Goeiemorgen, …"). Leeg = gewoon "Goeiemorgen".
    name: '',
  },
};

function merge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig(root) {
  const file = process.env.SMART_DISPLAY_CONFIG ?? join(root, 'config.json');
  let user = {};
  if (existsSync(file)) {
    user = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`[config] ${file} geladen`);
  } else {
    console.log('[config] geen config.json gevonden, ik draai met voorbeelddata');
  }
  const cfg = merge(DEFAULTS, user);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  // Elke categorie krijgt een kleur uit het palet (1 t/m 6), in volgorde.
  cfg.categories = cfg.categories.map((c, i) => ({ ...c, tone: c.tone ?? (i % 6) + 1 }));
  return cfg;
}

/** Het deel van de config dat de browser mag zien (geen URL's van agenda's). */
export function publicConfig(cfg) {
  return {
    title: cfg.title,
    locale: cfg.locale,
    location: cfg.location?.name ?? '',
    categories: cfg.categories,
    display: cfg.display,
  };
}
