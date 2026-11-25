// Lumen: kleine webserver zonder framework.
// Serveert het dashboard (public/) en een JSON-API die agenda, taken,
// school, weer en recepten samenbrengt.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { loadConfig, publicConfig } from './config.js';
import { createCalendar } from './providers/calendar.js';
import { createWeather } from './providers/weather.js';
import { createTodos } from './providers/todos.js';
import { createSystem } from './providers/system.js';
import { createSchool, lessonEvents } from './providers/school.js';
import { createWaste, wasteTasks } from './providers/waste.js';
import { createRecipes } from './providers/recipe.js';
import { createEnergy } from './providers/energy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.SMART_DISPLAY_DATA ?? join(ROOT, 'data');

const cfg = loadConfig(ROOT);
const calendar = createCalendar(cfg);
const weather = createWeather(cfg);
const todos = createTodos(DATA, cfg);
const system = createSystem(cfg);
// Je eigen vakken en deadlines staan in school.json (naast config.json). Zonder dat bestand
// draait School op school.example.json, met data die meeschuift met vandaag.
const SCHOOL_FILE = process.env.SMART_DISPLAY_SCHOOL ?? [join(ROOT, 'school.json'), join(ROOT, 'school.example.json')].find((f) => existsSync(f));
const school = createSchool(SCHOOL_FILE, cfg.school?.timeedit);
const recipes = createRecipes(DATA);
// Zonnepanelen en thuisbatterij (Huawei SUN2000 + LUNA2000), lokaal via Modbus TCP. Optioneel.
const energy = createEnergy(cfg, DATA);
// Afvalophaling: zet "PMD buitenzetten" en co. vanzelf op de takenlijst.
const syncWaste = (collections) => {
  if (todos.syncAuto('afval:', wasteTasks(collections, cfg.waste))) broadcast();
};
const waste = createWaste(cfg, syncWaste);
setInterval(() => {
  const w = waste.get();
  if (w.state === 'ok') syncWaste(w.collections);
}, 10 * 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ── API ────────────────────────────────────────────────────

const routes = [
  ['GET', /^\/api\/dashboard$/, () => dashboard()],
  ['GET', /^\/api\/health$/, () => ({ ok: true, uptime: Math.round(process.uptime()) })],
  // Het volledige weer (8 dagen per uur, regen per kwartier, lucht en pollen) voor het tabblad Weer.
  ['GET', /^\/api\/weather$/, () => weather.detail()],
  // Energie: nu, vandaag, het verloop per 5 minuten en de voorbije dagen, voor het tabblad Energie.
  ['GET', /^\/api\/energy$/, () => energy.detail()],

  // Voor de taken-app op de gsm: alleen de lijst en de categorieën.
  ['GET', /^\/api\/todos$/, () => ({ ...todos.list(), categories: cfg.categories })],
  ['POST', /^\/api\/todos$/, (_, body) => todos.add(body)],
  ['POST', /^\/api\/todos\/restore$/, (_, body) => todos.restore(body)],
  ['PATCH', /^\/api\/todos\/([\w-]+)$/, ([id], body) => todos.patch(id, body)],
  ['DELETE', /^\/api\/todos\/([\w-]+)$/, ([id]) => todos.remove(id)],

  // Recepten: een link vanaf de gsm (taken-app of een iPhone-opdracht) komt op het display.
  ['POST', /^\/api\/recipe$/, (_, body) => recipes.send(body)],
  ['POST', /^\/api\/recipe\/open$/, (_, body) => recipes.open(body)],
  ['DELETE', /^\/api\/recipe$/, () => recipes.close()],
  ['DELETE', /^\/api\/recipe\/([\w-]+)$/, ([id]) => recipes.forget(id)],

  // Het display meldt zijn wifi-signaal (server op een andere Pi). Stil: geen herlaadsignaal
  // naar de schermen, anders haalt de Zero elke minuut het hele dashboard opnieuw op.
  ['POST', /^\/api\/display\/wifi$/, (_, body) => system.reportWifi(body.dbm), { quiet: true }],
];

// De lessen (TimeEdit, anders school.json) staan ook in de agenda, in de categorie "school"
// (of school.category). Uitzetten: "school": { "inAgenda": false } in config.json.
const lessonCategory = [cfg.school?.category, 'school'].find((id) => id && cfg.categories.some((c) => c.id === id)) ?? cfg.categories[0]?.id;
const eventKey = (e) => (e.allDay ? `${e.start}T00:00:00.000Z~0` : `${e.start}~1`);
function calendarWithLessons() {
  const cal = calendar.get();
  if (cfg.school?.inAgenda === false || !Array.isArray(cal?.events)) return cal;
  const lessons = lessonEvents(school.get(), cal.range, lessonCategory);
  if (!lessons.length) return cal;
  return { ...cal, events: [...cal.events, ...lessons].sort((a, b) => eventKey(a).localeCompare(eventKey(b))) };
}

function dashboard() {
  return {
    serverTime: new Date().toISOString(),
    config: publicConfig(cfg),
    weather: weather.get(),
    calendar: calendarWithLessons(),
    todos: todos.list(),
    school: school.get(),
    waste: waste.get(),
    recipe: recipes.view(),
    energy: energy.get(),
    system: system.get(),
  };
}

// ── Live meldingen (server-sent events) ────────────────────
// Elke open pagina luistert mee; na een wijziging halen ze de data opnieuw op.
// Bij het verbinden krijgt de pagina een vingerafdruk van public/ mee: is die na een
// update veranderd, dan herlaadt ze zichzelf (de browser hoeft niet te herstarten).
// Een update die alleen de server raakt, laat de pagina met rust.
const BUILD = (() => {
  const hash = createHash('sha1');
  for (const name of readdirSync(PUBLIC, { recursive: true }).sort()) {
    const info = statSync(join(PUBLIC, name));
    if (info.isFile()) hash.update(`${name}:${info.size}:${Math.round(info.mtimeMs)};`);
  }
  return hash.digest('hex').slice(0, 12);
})();
const listeners = new Set();
function broadcast() {
  for (const res of listeners) res.write('data: change\n\n');
}
function subscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`retry: 5000\nevent: hello\ndata: ${BUILD}\n\n`);
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
}
setInterval(() => {
  for (const res of listeners) res.write(': ping\n\n');
}, 25_000).unref();

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Te groot verzoek.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Ongeldige JSON.'), { status: 400 });
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

// ── Statische bestanden ────────────────────────────────────

async function serveStatic(req, res, pathname) {
  if (pathname === '/taken') pathname = '/taken.html';
  else if (pathname === '/' || !extname(pathname)) pathname = '/index.html';
  const file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('geen bestand');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Niet gevonden');
  }
}

// ── Server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/events' && req.method === 'GET') {
      subscribe(req, res);
      return;
    }
    if (pathname.startsWith('/api/')) {
      for (const [method, pattern, handler, opts] of routes) {
        const match = pathname.match(pattern);
        if (match && req.method === method) {
          const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
          send(res, 200, await handler(match.slice(1), body));
          if (method !== 'GET' && !opts?.quiet) broadcast();
          return;
        }
      }
      send(res, 404, { error: 'Onbekend API-pad.' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: err.message });
  }
});

server.listen(cfg.port, cfg.host, () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${cfg.port}`);
  console.log(`Lumen draait op http://localhost:${cfg.port}`);
  if (ips.length) console.log(`In je netwerk: ${ips.join('  ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const res of listeners) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
