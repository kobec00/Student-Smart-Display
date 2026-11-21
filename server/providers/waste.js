// Afvalophaling via Recycle! (Fost Plus): dezelfde gratis bron als de app en recycleapp.be,
// zonder account of sleutel. Dekt heel België. Optioneel: zonder adres staat het uit.
// Het adres staat alleen in config.json; de browser krijgt enkel datums en afvalsoorten te zien.
import { fetchJSON, poller, isoDate, addDays } from '../util.js';

const API = 'https://api.fostplus.be/recyclecms/public/v1';
const HEADERS = { 'x-consumer': 'recycleapp.be', 'User-Agent': 'smart-display' };
const DAYS_AHEAD = 45;
const norm = (s) => String(s ?? '').trim().toLowerCase();

async function resolveAddress(w) {
  const zips = (await fetchJSON(`${API}/zipcodes?q=${encodeURIComponent(w.postcode)}`, { headers: HEADERS })).items ?? [];
  // De zoekopdracht van Recycle! struikelt over afkortingen met een punt ("Th. De Beckerstraat").
  const query = String(w.street).split('.').pop().trim();
  for (const zip of zips.filter((z) => z.available !== false && String(z.code) === String(w.postcode))) {
    const url = `${API}/streets?q=${encodeURIComponent(query)}&zipcodes=${encodeURIComponent(zip.id)}`;
    const streets = (await fetchJSON(url, { method: 'POST', headers: HEADERS })).items ?? [];
    const street = streets.find((s) => norm(s.name) === norm(w.street)) ?? streets[0];
    if (street) return { zipcodeId: zip.id, streetId: street.id, street: street.name };
  }
  throw new Error(`Straat "${w.street}" niet gevonden in ${w.postcode}.`);
}

async function fetchCollections(address, houseNumber) {
  const from = isoDate();
  const byDate = new Map();
  for (let page = 1, pages = 1; page <= pages && page <= 5; page++) {
    const q = new URLSearchParams({ zipcodeId: address.zipcodeId, streetId: address.streetId, houseNumber: String(houseNumber), fromDate: from, untilDate: addDays(from, DAYS_AHEAD), page: String(page), size: '100' });
    const data = await fetchJSON(`${API}/collections?${q}`, { headers: HEADERS });
    pages = data.pages ?? 1;
    for (const item of data.items ?? []) {
      // Alleen echte ophalingen (geen Repair Cafés), en geen ophaling die naar een andere dag verplaatst is.
      if (item.type !== 'collection' || item.exception?.replacedBy) continue;
      const date = String(item.timestamp).slice(0, 10);
      const name = item.fraction?.name?.nl ?? item.fraction?.name?.en;
      if (!name || date < from) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      if (!byDate.get(date).includes(name)) byDate.get(date).push(name);
    }
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, names]) => ({ date, names }));
}

export function createWaste(cfg, onUpdate = () => {}) {
  const w = cfg.waste ?? {};
  if (!w.postcode || !w.street || !w.houseNumber) return { get: () => ({ state: 'off', collections: [] }) };
  let address = null;
  return poller('afval', 6 * 60 * 60_000, async () => {
    address ??= await resolveAddress(w);
    const collections = await fetchCollections(address, w.houseNumber);
    console.log(`[afval] ${collections.length} ophaaldagen geladen`);
    setImmediate(() => onUpdate(collections));
    return { state: 'ok', updatedAt: new Date().toISOString(), collections };
  });
}

// "Restafval" + "Gft" → "Restafval en GFT"
function joinNames(names) {
  const tidy = names.map((n) => (norm(n) === 'gft' ? 'GFT' : n));
  const words = tidy.map((n, i) => (i === 0 || n === n.toUpperCase() ? n : n.charAt(0).toLowerCase() + n.slice(1)));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} en ${words.at(-1)}` : words[0];
}

/**
 * De taken die nu op de lijst horen: één per ophaaldag, bv. "PMD buitenzetten".
 * putOut "evening": tegen de avond vóór de ophaling; "morning": tegen de dag zelf.
 * De taak verschijnt showDaysBefore dagen vooraf en verdwijnt na de ophaaldag.
 */
export function wasteTasks(collections, opts = {}, today = isoDate()) {
  const before = opts.putOut === 'morning' ? 0 : 1;
  const show = Number.isFinite(Number(opts.showDaysBefore)) ? Math.max(0, Number(opts.showDaysBefore)) : 1;
  return collections
    .map((c) => ({ key: `afval:${c.date}`, title: `${joinNames(c.names)} buitenzetten`, category: opts.category ?? 'huis', due: addDays(c.date, -before), until: c.date }))
    .filter((t) => today >= addDays(t.due, -show) && today <= t.until);
}
