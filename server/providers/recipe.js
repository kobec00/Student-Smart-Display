// Recepten naar het display sturen: de Pi haalt de pagina één keer op en leest alleen
// het recept eruit (schema.org/Recipe in JSON-LD, dat bijna elke receptensite meelevert).
// De zware website zelf komt nooit in de browser van het display.
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createStore, newId } from '../util.js';

const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_RECENT = 12;
const UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 smart-display';

export function createRecipes(dataDir) {
  const store = createStore(join(dataDir, 'recipes.json'), () => ({ current: null, recent: [] }));

  function view() {
    const { current, recent } = store.get();
    return {
      current,
      recent: recent.map(({ id, title, source, totalMinutes }) => ({ id, title, source, totalMinutes })),
    };
  }

  async function send({ url }) {
    const target = await checkUrl(url);
    const html = await download(target);
    const recipe = extractRecipe(html, target);
    if (!recipe) throw httpError(422, 'Op die pagina vond ik geen recept. Werkt een andere site wel?');
    return show({ ...recipe, id: newId() });
  }

  function show(recipe) {
    const item = { ...recipe, sentAt: new Date().toISOString() };
    store.update((d) => {
      d.current = item;
      d.recent = [item, ...d.recent.filter((r) => r.url !== item.url && r.id !== item.id)].slice(0, KEEP_RECENT);
    });
    console.log(`[recept] ${item.title} (${item.source})`);
    return { ok: true, title: item.title, message: `Staat op het display: ${item.title}`, recipe: item };
  }

  function open({ id }) {
    const found = store.get().recent.find((r) => r.id === id);
    if (!found) throw httpError(404, 'Dat recept staat niet meer in de lijst.');
    return show(found);
  }

  function close() {
    store.update((d) => {
      d.current = null;
    });
    return { ok: true };
  }

  function forget(id) {
    store.update((d) => {
      d.recent = d.recent.filter((r) => r.id !== id);
      if (d.current?.id === id) d.current = null;
    });
    return { ok: true };
  }

  return { view, send, open, close, forget };
}

// ── Ophalen ─────────────────────────────────────────────────

// Alleen gewone websites: geen adressen in het thuisnetwerk (de Pi 4, de router …).
async function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim().match(/https?:\/\/\S+/i)?.[0] ?? '');
  } catch {
    throw httpError(400, 'Dat is geen geldige link.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Alleen http- en https-links.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) throw httpError(400, 'Dat is een adres in je eigen netwerk.');
  const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!ips.length) throw httpError(422, `${host} is niet bereikbaar.`);
  if (ips.some((ip) => isPrivate(ip.address))) throw httpError(400, 'Dat is een adres in je eigen netwerk.');
  return url;
}

function isPrivate(ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function download(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.6' },
    });
  } catch (err) {
    throw httpError(502, err.name === 'TimeoutError' ? 'De site antwoordde niet op tijd.' : 'De site is niet bereikbaar.');
  }
  if (!res.ok) throw httpError(502, res.status === 403 || res.status === 429 ? 'Die site laat het display niet binnen.' : `De site gaf fout ${res.status}.`);
  if (!/html|xml/i.test(res.headers.get('content-type') ?? 'text/html')) throw httpError(422, 'Die link is geen webpagina.');
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) break;
    chunks.push(chunk);
  }
  try {
    return new TextDecoder(charset).decode(Buffer.concat(chunks));
  } catch {
    return Buffer.concat(chunks).toString('utf8');
  }
}

// ── Uitlezen ────────────────────────────────────────────────

export function extractRecipe(html, url) {
  const blocks = [...html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    const data = parseJson(raw);
    const node = data && findRecipe(data);
    if (!node) continue;
    const recipe = normalize(node, url);
    // Sommige sites (zoals Dagelijkse Kost) zetten maar een deel van de bereiding in de data;
    // staat de volledige, genummerde lijst op de pagina zelf, dan nemen we die.
    const fuller = htmlSteps(html, recipe.steps[0]?.text);
    if (fuller.length > recipe.steps.length) recipe.steps = fuller;
    return recipe;
  }
  return null;
}

function parseJson(raw) {
  const text = raw.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').replace(/^\s*<!--|-->\s*$/g, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Sommige sites zetten echte regeleinden in tekstwaarden.
    try {
      return JSON.parse(text.replace(/[\n\r\t]+/g, ' '));
    } catch {
      return null;
    }
  }
}

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findRecipe(n, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const type = [].concat(node['@type'] ?? []).map(String);
  if (type.some((t) => /(^|\/)Recipe$/i.test(t))) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const hit = findRecipe(node[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function normalize(r, url) {
  const ingredients = [].concat(r.recipeIngredient ?? r.ingredients ?? []).map(text).filter(Boolean).slice(0, 80);
  const steps = instructions(r.recipeInstructions).slice(0, 80);
  // Eén kop boven alle stappen ("Bereiding") zegt niets: weg ermee.
  if (new Set(steps.map((s) => s.section)).size === 1) for (const s of steps) s.section = null;
  const yieldText = [].concat(r.recipeYield ?? []).map(text).find(Boolean) ?? '';
  const servings = Number(/\d+/.exec(yieldText)?.[0]) || null;
  const prep = minutes(r.prepTime);
  const cook = minutes(r.cookTime);
  const total = minutes(r.totalTime) ?? (prep || cook ? (prep ?? 0) + (cook ?? 0) : null);
  return {
    title: text(r.name) || 'Recept',
    url: url.href,
    source: url.hostname.replace(/^www\./, ''),
    image: imageUrl(r.image, url),
    servings: servings && servings < 100 ? servings : null,
    yieldText: yieldText.slice(0, 60),
    prepMinutes: prep,
    cookMinutes: cook,
    totalMinutes: total,
    ingredients,
    steps,
  };
}

// recipeInstructions kan tekst zijn, een lijst tekst, HowToStep's of HowToSection's met stappen erin.
function instructions(v, section = null, out = []) {
  if (!v) return out;
  if (typeof v === 'string') {
    const t = text(v, true);
    for (const line of t.split(/\n+|(?<=[.!?])\s+(?=\d+[.)]\s)/)) {
      const clean = line.replace(/^\s*(stap\s*)?\d+[.):]\s*/i, '').trim();
      if (clean) out.push({ section, text: clean });
    }
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) instructions(x, section, out);
    return out;
  }
  if (typeof v === 'object') {
    const type = [].concat(v['@type'] ?? []).join(' ');
    if (/HowToSection/i.test(type) || (v.itemListElement && !v.text)) {
      return instructions(v.itemListElement, text(v.name) || section, out);
    }
    const t = text(v.text ?? v.name ?? v.description ?? '', true);
    if (t) instructions(t, section, out);
  }
  return out;
}

// Een genummerde stappenlijst in de HTML: "<span>1</span> … <p>tekst</p>", "<span>2</span> …".
// Alleen geldig als stap 1 dezelfde is als de eerste stap uit de receptdata.
function htmlSteps(html, first) {
  if (!first) return [];
  const want = first.slice(0, 30);
  const re = />\s*(\d{1,2})\s*<\/(?:span|div|strong|b|h\d)>(?:\s*<[^>]+>){0,8}\s*<p[^>]*>([\s\S]{2,1500}?)<\/p>/g;
  let run = [];
  for (const [, n, body] of html.matchAll(re)) {
    const num = Number(n);
    const t = text(body);
    if (num === 1) {
      if (run.length > 1 && run[0].startsWith(want)) break;
      run = t.startsWith(want) ? [t] : [];
    } else if (run.length && num === run.length + 1) {
      run.push(t);
    } else if (run.length && run[0].startsWith(want) && run.length > 1) {
      break;
    }
  }
  return run.length > 1 && run[0].startsWith(want) ? run.slice(0, 80).map((t) => ({ section: null, text: t })) : [];
}

// ISO 8601-duur ("PT1H30M") → minuten.
function minutes(v) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const total = Math.round(Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
  return total > 0 && total < 7 * 1440 ? total : null;
}

function imageUrl(v, base) {
  const first = [].concat(v ?? [])[0];
  const raw = typeof first === 'string' ? first : first?.url ?? first?.contentUrl;
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', euml: 'ë', iuml: 'ï', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ouml: 'ö', uuml: 'ü', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };

/** Platte tekst: geen HTML-tags, entiteiten omgezet, witruimte opgeruimd. */
function text(v, keepLines = false) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  let s = String(v)
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
  s = keepLines ? s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, 1200);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
