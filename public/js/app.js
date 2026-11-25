// Lumen: één scherm, een handvol weergaven, geen framework.
// Data komt elke 20 s van /api/dashboard; een regio wordt alleen opnieuw
// getekend als haar HTML echt veranderd is (zuinig voor een Pi Zero).
import { wxIcon } from './viz.js';

// ── Hulpjes ─────────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');

const qs = new URLSearchParams(location.search);
const KIOSK = qs.has('kiosk');
if (KIOSK) document.documentElement.classList.add('kiosk');

const LOCALE = 'nl-BE';
const F = {
  time: new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }),
  long: new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }),
  weekday: new Intl.DateTimeFormat(LOCALE, { weekday: 'long' }),
  wd: new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }),
  dm: new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }),
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s) => s.replace(/\./g, '');

const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = fromIso(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const diffDays = (a, b) => Math.round((fromIso(b) - fromIso(a)) / 864e5);
const shortDate = (s) => clean(F.dm.format(fromIso(s)));
const clockMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const today = () => iso(new Date());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── Toestand ────────────────────────────────────────────────
const state = {
  data: null,
  offline: false,
  ui: { todoForm: null },
  undo: null,
  wakeUntil: 0,
  lastInput: Date.now(),
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
  return data;
}

async function load() {
  try {
    state.data = await api('GET', '/api/dashboard');
    state.offline = false;
    noticeRecipe();
  } catch {
    state.offline = true;
  }
  render();
}

const cats = () => state.data?.config.categories ?? [];
const catOf = (id) => cats().find((c) => c.id === id);
const toneOf = (id) => catOf(id)?.tone ?? '';
// Een agenda kan een eigen kleur hebben ("tone" in config.json), anders de kleur van zijn categorie.
const eventTone = (e) => e.tone || toneOf(e.category);

// ── Navigatie (staat in de URL) ─────────────────────────────
const PATHS = { overzicht: '/', agenda: '/agenda', taken: '/taken', school: '/school', energie: '/energie', recept: '/recept', weer: '/weer' };
// Weer heeft geen knop in de zijbalk; daar licht dan Overzicht op (je komt er via het weer op het overzicht).
const RAIL_OF = { weer: 'overzicht' };
const VIEWS = Object.fromEntries(Object.entries(PATHS).map(([k, v]) => [v, k]));

function route() {
  const [p, q = ''] = location.hash.slice(1).split('?');
  return { view: VIEWS[p || '/'] ?? 'overzicht', q: new URLSearchParams(q) };
}

function go(view, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();
  const hash = `#${PATHS[view]}${q ? `?${q}` : ''}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  if (state.tw?.open) {
    state.tw.open = false;
    renderTimerSheet();
  }
  render();
});

const painted = new WeakMap();
function paint(el, html) {
  if (!el || painted.get(el) === html) return;
  painted.set(el, html);
  el.innerHTML = html;
}

// ── Alles tekenen ───────────────────────────────────────────
function render() {
  const { view, q } = route();
  // Andere tabbladen slapen (class is-off: content-visibility: hidden) in plaats van te
  // verdwijnen: hun opmaak blijft bewaard, zodat terugkeren op de Pi bijna niets kost.
  for (const v of $$('.view')) {
    if (v.hidden) v.hidden = false;
    v.classList.toggle('is-off', v.dataset.view !== view);
  }
  for (const t of $$('.rail__btn')) {
    if (t.dataset.view === (RAIL_OF[view] ?? view)) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  renderAlert();
  applyTheme();
  const greet = greeting(new Date());
  if ($('#clock-greet').textContent !== greet) $('#clock-greet').textContent = greet;
  const d = state.data;
  if (!d) {
    if (state.offline) {
      paint($('#ov-agenda'), notice('De server is niet bereikbaar. Draait smart-display, en zit dit scherm op hetzelfde netwerk?'));
    }
    return;
  }
  renderSystem(d.system);
  $('.rail__btn[data-view="energie"]').hidden = !enOn(d.energy);

  if (view === 'overzicht') {
    renderOvEnergy(d.energy);
    renderOvWeather(d);
    renderOvAgenda(d);
    renderOvTodos(d);
    renderOvSchool(d.school);
  } else if (view === 'agenda') {
    renderAgenda(d, q);
  } else if (view === 'taken') {
    renderBoard(d);
  } else if (view === 'school') {
    renderSchool(d.school, q);
  } else if (view === 'recept') {
    renderRecipe(d, q);
  } else if (view === 'weer') {
    renderWeather(d, q);
  } else if (view === 'energie') {
    renderEnergy(d);
  }
  updateMorning(new Date());
  updateNight(new Date());
}

const notice = (text) => `<div class="notice">${icon('i-alert')}<span>${esc(text)}</span></div>`;
const demoTag = (on, text = 'Demo') => (on ? `<span class="tag">${text}</span>` : '');
// Een kaartkop: een klein icoon en een titel in HUD-stijl.
const cardHead = (title, meta = '', ic = null, hue = '') =>
  `<div class="card__head"><h2 class="card__title">${ic ? `<span class="card__ic" data-hue="${hue}">${icon(ic)}</span>` : ''}<span>${title}</span></h2><span class="card__meta">${meta}</span></div>`;

// ── Licht overdag, donker na zonsondergang ──────────────────
// Daarbovenop een stemming die de gloed kleurt: dageraad, gouden uur en schemering.
function sunTimes(now) {
  const day = (state.data?.weather?.days ?? []).find((x) => x.date === iso(now));
  let rise = day ? new Date(day.sunrise) : null;
  let set = day ? new Date(day.sunset) : null;
  if (!rise || !set || Number.isNaN(+rise) || Number.isNaN(+set)) {
    rise = new Date(now);
    rise.setHours(7, 0, 0, 0);
    set = new Date(now);
    set.setHours(19, 0, 0, 0);
  }
  return { rise, set };
}

function themeFor(now) {
  const forced = qs.get('theme') || state.data?.config.display.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  const { rise, set } = sunTimes(now);
  return now >= rise && now < set ? 'light' : 'dark';
}

const MIN = 60_000;
function moodFor(now) {
  const { rise, set } = sunTimes(now);
  if (now >= rise - 45 * MIN && now < +rise + 60 * MIN) return 'dawn';
  if (now >= set - 75 * MIN && now < set) return 'golden';
  if (now >= set && now < +set + 60 * MIN) return 'dusk';
  return now >= rise && now < set ? 'day' : 'night';
}

function applyTheme(now = new Date()) {
  const root = document.documentElement;
  const mood = moodFor(now);
  if (root.dataset.mood !== mood) root.dataset.mood = mood;
  const theme = themeFor(now);
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* geen opslag beschikbaar */
  }
}

// Goeiemorgen, goeiemiddag, goeienavond (met je naam erachter als display.name ingevuld is).
function greeting(now) {
  const h = now.getHours();
  const word = h >= 5 && h < 12 ? 'Goeiemorgen' : h >= 12 && h < 18 ? 'Goeiemiddag' : h >= 18 && h < 23 ? 'Goeienavond' : 'Goeienacht';
  const name = String(state.data?.config.display.name ?? '').trim();
  return name ? `${word}, ${name}` : word;
}

// ── Klok ────────────────────────────────────────────────────
let lastMinute = '';
function tick() {
  const now = new Date();
  if (state.timers?.length || state.ringing?.length) renderTimers();
  $('#clock-sec').textContent = pad(now.getSeconds());
  const t = F.time.format(now);
  if (t === lastMinute) return;
  lastMinute = t;
  const el = $('#clock-time');
  el.textContent = t;
  el.dateTime = now.toISOString();
  $('#clock-date').textContent = cap(F.long.format(now));
  $('#clock-greet').textContent = greeting(now);
  for (const c of $$('.page-clock')) c.textContent = t;
  render();
}

// ── Zijbalk: storing en systeem ─────────────────────────────
function renderAlert() {
  // Een stip op School zodra er binnen een week iets in te dienen of af te leggen is.
  const now = new Date();
  const soon = schoolItems(state.data?.school).some((i) => isDue(i) && i.end >= now && diffDays(today(), i.day) <= 7);
  $('.rail__btn[data-view="school"]').classList.toggle('has-due', soon);
}

function renderSystem(sys) {
  let html = '';
  if (Number.isFinite(sys?.wifi)) {
    const dbm = sys.wifi;
    const bars = dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
    html += `<div class="sys" title="Wifi-signaal"><span class="bars">${[1, 2, 3, 4].map((b) => `<span class="${b <= bars ? 'on' : ''}"></span>`).join('')}</span><span>${dbm}</span></div>`;
  }
  paint($('#sys'), html);
}

// ── Overzicht ───────────────────────────────────────────────
const timeShort = (isoString) => F.time.format(new Date(isoString));
const hourLabel = (isoString) => `${pad(new Date(isoString).getHours())}u`;
const avgOf = (list) => {
  const nums = list.filter(Number.isFinite);
  return nums.length ? Math.round(nums.reduce((x, y) => x + y, 0) / nums.length) : null;
};

// De lucht kleurt mee: de gloed achter de kaarten volgt het weer.
function applySky(w) {
  const kind = w?.current?.icon;
  const sky = !kind ? '' : kind === 'clear' || kind === 'partly' ? 'clear' : kind === 'cloud' || kind === 'fog' ? 'cloud' : kind === 'snow' ? 'snow' : 'rain';
  const root = document.documentElement;
  if ((root.dataset.sky ?? '') !== sky) root.dataset.sky = sky;
}

// Zeven stappen van twee uur: zo reikt de vooruitblik tot de volgende ochtend of avond.
function everyTwoHours(hours) {
  const out = [];
  for (let i = 0; i < hours.length && out.length < 7; i += 2) {
    out.push({ ...hours[i], precip: Math.max(hours[i].precip ?? 0, hours[i + 1]?.precip ?? 0) });
  }
  return out;
}

// Temperatuur per uur als lijn, met het weer en de kans op regen eronder.
function hoursChart(hours) {
  const n = hours.length;
  if (!n) return '';
  const temps = hours.map((h) => h.temp);
  const min = Math.min(...temps);
  const span = Math.max(...temps) - min;
  const pts = hours.map((h, i) => [((i + 0.5) / n) * 100, span ? 88 - ((h.temp - min) / span) * 44 : 66]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const wet = hours.some((h) => h.precip >= 30);
  return (
    `<div class="wxc${wet ? '' : ' wxc--dry'}"><div class="wxc__plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><linearGradient id="wxc-fill" x1="0" y1="0" x2="0" y2="1"><stop class="wxc__s1" offset="0"/><stop class="wxc__s2" offset="1"/></linearGradient></defs>` +
    `<polygon class="wxc__area" fill="url(#wxc-fill)" points="0,100 0,${pts[0][1].toFixed(1)} ${line} 100,${pts[n - 1][1].toFixed(1)} 100,100"/>` +
    `<polyline class="wxc__line" points="0,${pts[0][1].toFixed(1)} ${line} 100,${pts[n - 1][1].toFixed(1)}"/></svg>` +
    pts.map(([x, y], i) => `<span class="wxc__pt" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%"><b>${hours[i].temp}°</b></span>`).join('') +
    `</div><div class="wxc__cols">` +
    hours
      .map((h) => `<div>${wxIcon(h.icon, h.isDay)}<span>${hourLabel(h.time)}</span><small>${h.precip >= 30 ? `${h.precip}%` : ''}</small></div>`)
      .join('') +
    `</div></div>`
  );
}

function renderOvWeather(d) {
  const w = d.weather;
  const el = $('#ov-weather');
  applySky(w);
  if (!w?.current) {
    paint($('#ov-now'), '');
    paint(el, w?.state === 'error' ? notice(`Geen weerdata: ${w.error}`) : '<div class="skel"><span></span><span></span></div>');
    return;
  }
  const t = w.days?.[0];
  const c = w.current;
  const now = new Date();
  // Voor zonsondergang tonen we wanneer de zon ondergaat, daarna wanneer ze weer opkomt.
  let sun = '';
  if (t) {
    const up = new Date(t.sunrise);
    const down = new Date(t.sunset);
    const next = w.days?.[1];
    if (now < up) sun = `${icon('i-sunrise')}zon op ${F.time.format(up)}`;
    else if (now < down) sun = `${icon('i-sunset')}zon onder ${F.time.format(down)}`;
    else if (next) sun = `${icon('i-sunrise')}zon op ${timeShort(next.sunrise)}`;
  }
  paint($('#ov-now'), `${wxIcon(c.icon, c.isDay)}<b>${c.temp}°</b>`);
  paint(
    el,
    `${icon('i-chev-right', 'i wx-go')}<div class="wx-now">${wxIcon(c.icon, c.isDay)}<span class="wx-now__temp">${c.temp}°</span>` +
      `<div class="wx-now__text"><b>${esc(c.label)}</b><span>voelt ${c.feels}°${t ? `, ↑${t.max}° ↓${t.min}°` : ''}</span>${sun ? `<span class="wx-now__sun">${sun}</span>` : ''}</div></div>` +
      hoursChart(everyTwoHours(w.hours ?? [])),
  );
}

// De eerstvolgende afspraak met een uur: bezig, of nog te komen.
function nextEvent(events, now) {
  let best = null;
  for (const e of events) {
    if (e.allDay || new Date(e.end) <= now) continue;
    if (!best || new Date(e.start) < new Date(best.start)) best = e;
  }
  return best;
}

const durText = (m) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} u` : `${Math.floor(m / 60)} u ${m % 60} min`);

function nextHtml(e, now) {
  if (!e) return `<div class="next next--none"><span class="next__label">Volgende</span><span class="next__title">Niets gepland</span><span class="next__meta">De komende twee weken is je agenda leeg.</span></div>`;
  const s = new Date(e.start);
  const en = new Date(e.end);
  const live = s <= now;
  const days = diffDays(iso(now), iso(s));
  let rel;
  if (live) rel = `nog ${durText(Math.max(1, Math.round((en - now) / 60000)))}`;
  else if (days === 0) rel = `over ${durText(Math.max(1, Math.round((s - now) / 60000)))}`;
  else if (days === 1) rel = 'morgen';
  else rel = days < 7 ? F.weekday.format(s) : shortDate(iso(s));
  const span = `${F.time.format(s)}–${F.time.format(en)}`;
  const progress = live ? Math.min(1, Math.max(0, (now - s) / (en - s || 1))) : 0;
  return (
    `<div class="next${live ? ' is-live' : ''}" data-tone="${eventTone(e)}">` +
    `<div class="next__top"><span class="next__label">${live ? 'Nu bezig' : 'Volgende'}</span><span class="next__rel">${rel}</span></div>` +
    `<span class="next__title">${esc(e.title)}</span>` +
    `<span class="next__meta"><span>${icon('i-clock')}${span}</span>${e.location ? `<span class="next__where">${icon('i-pin')}${esc(e.location)}</span>` : ''}</span>` +
    (live ? `<span class="next__bar"><span style="--p:${progress.toFixed(3)}"></span></span>` : '') +
    `</div>`
  );
}

function renderOvAgenda(d) {
  const cal = d.calendar;
  const t = today();
  const now = new Date();
  const events = cal.events ?? [];
  const days = groupEvents(events, t, 14);
  const next = nextEvent(events, now);
  const wx = new Map((d.weather?.days ?? []).map((w) => [w.date, w]));

  // De week in één oogopslag: zeven dagen vanaf vandaag, met een bolletje per afspraak.
  let strip = '';
  let i = 0;
  for (const [date, list] of days) {
    if (i++ >= 7) break;
    const dots = list.slice(0, 4).map((e) => `<i data-tone="${eventTone(e)}"></i>`).join('');
    strip +=
      `<button class="wk__day${date === t ? ' is-today' : ''}" data-action="cal-day" data-date="${date}" aria-label="${esc(cap(F.long.format(fromIso(date))))}, ${plural(list.length, 'afspraak', 'afspraken')}">` +
      `<span class="wk__dow">${clean(F.wd.format(fromIso(date)))}</span><span class="wk__num">${Number(date.slice(8))}</span><span class="wk__dots">${dots}</span></button>`;
  }

  let list = '';
  let shown = 0;
  for (const [date, all] of days) {
    const n = diffDays(t, date);
    // Wat al voorbij is en wat bovenaan als "volgende" staat, hoeft hier niet nog eens.
    const rows = all.filter((e) => e !== next && (e.allDay || new Date(e.end) > now));
    if (n > 1 && (!rows.length || shown >= 12)) continue;
    const w = wx.get(date);
    list +=
      `<div class="agenda-day"><div class="agenda-day__head"><span class="agenda-day__name">${n === 0 ? 'Vandaag' : n === 1 ? 'Morgen' : cap(F.weekday.format(fromIso(date)))}</span>` +
      `<span class="agenda-day__date">${n > 1 ? shortDate(date) : ''}</span>` +
      (w && n > 0 ? `<span class="agenda-day__wx">${wxIcon(w.icon, true)}${w.max}° / ${w.min}°${w.precip >= 40 ? `<small>${w.precip}%</small>` : ''}</span>` : '') +
      `</div>`;
    if (rows.length) list += rows.map((e) => eventRow(e, date, now)).join('');
    else list += `<div class="agenda-empty">${n === 0 && all.length ? 'Verder niets meer vandaag' : 'Niets gepland'}</div>`;
    list += '</div>';
    shown += rows.length;
  }
  paint(
    $('#ov-agenda'),
    cardHead('Agenda', `${demoTag(cal.state === 'demo')}<a class="head-link" href="#/agenda">Week${icon('i-chev-right')}</a>`, 'i-calendar', 'apricot') +
      (cal.state === 'error' ? notice(`Agenda niet bijgewerkt: ${cal.error}`) : '') +
      `<div class="ag"><div class="ag__top"><div class="wk">${strip}</div>${nextHtml(next, now)}</div><div class="card__body ag__list">${list}</div></div>`,
  );
}

function renderOvTodos(d) {
  const t = today();
  const items = d.todos.items ?? [];
  const open = items.filter((i) => !i.done);
  const doneToday = items.filter((i) => i.done && i.doneAt === t).length;
  const list = sortTodos(items.filter((i) => !i.done || i.doneAt === t));
  let body = list.map((i) => todoRow(i, { showCat: true })).join('');
  if (!open.length) body = `<div class="empty"><strong>Alles gedaan</strong><span>Geen open taken.</span></div>${body}`;
  const total = open.length + doneToday;
  paint(
    $('#ov-todos'),
    cardHead(
      'Taken',
      `<span>${open.length} open${doneToday ? `, ${doneToday} gedaan` : ''}</span><button class="head-btn" data-hue="honey" data-action="todo-new" aria-label="Taak toevoegen">${icon('i-plus')}</button>`,
      'i-list',
      'honey',
    ) +
      (doneToday ? `<div class="meter" aria-hidden="true"><span style="--p:${(doneToday / total).toFixed(3)}"></span></div>` : '') +
      `<div class="card__body">${body}</div>`,
  );
}

// ── Agenda ──────────────────────────────────────────────────
function groupEvents(events, from, nDays) {
  const days = new Map();
  for (let i = 0; i < nDays; i++) days.set(addDays(from, i), []);
  const now = new Date();
  for (const e of events) {
    if (e.allDay) {
      let dd = e.start;
      for (let guard = 0; dd < e.end && guard < 62; guard++, dd = addDays(dd, 1)) days.get(dd)?.push(e);
    } else {
      const s = new Date(e.start);
      let key = iso(s);
      if (key < from && new Date(e.end) > now) key = from;
      days.get(key)?.push(e);
    }
  }
  for (const list of days.values()) {
    list.sort((a, b) => (b.allDay - a.allDay) || (a.allDay ? 0 : new Date(a.start) - new Date(b.start)));
  }
  return days;
}

function dayTitle(date, t) {
  const n = diffDays(t, date);
  if (n === 0) return 'Vandaag';
  if (n === 1) return 'Morgen';
  return cap(F.weekday.format(fromIso(date)));
}

function eventRow(e, day, now) {
  let time;
  let past = false;
  let live = false;
  if (e.allDay) {
    time = 'Hele<small>dag</small>';
  } else {
    const s = new Date(e.start);
    const en = new Date(e.end);
    past = en <= now;
    live = s <= now && en > now;
    time = iso(s) < day ? `tot<small>${F.time.format(en)}</small>` : `${F.time.format(s)}<small>${F.time.format(en)}</small>`;
  }
  return (
    `<div class="event${past ? ' is-past' : ''}${live ? ' is-now' : ''}" data-tone="${eventTone(e)}">` +
    `<span class="event__time">${time}</span><span class="event__bar"></span>` +
    `<span class="event__body"><span class="event__title">${esc(e.title)}${live ? '<span class="now">Nu</span>' : ''}</span>` +
    `${e.location ? `<span class="event__where">${esc(e.location)}</span>` : ''}</span></div>`
  );
}

const F_MONTH = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const isIsoDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
const isIsoMonth = (v) => /^\d{4}-\d{2}$/.test(v ?? '');
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

function agendaState(q) {
  const mode = q.get('v') === 'maand' ? 'maand' : 'week';
  const start = isIsoDay(q.get('d')) ? q.get('d') : today();
  const month = isIsoMonth(q.get('m')) ? q.get('m') : today().slice(0, 7);
  return { mode, start, month };
}

function renderAgenda(d, q) {
  const cal = d.calendar;
  const { mode, start, month } = agendaState(q);
  const range = cal.range ?? { from: addDays(today(), -31), to: addDays(today(), 90) };
  let label;
  let canPrev;
  let canNext;
  if (mode === 'week') {
    const end = addDays(start, 6);
    label = start.slice(5, 7) === end.slice(5, 7) ? `${Number(start.slice(8))}–${shortDate(end)}` : `${shortDate(start)} – ${shortDate(end)}`;
    canPrev = addDays(start, -1) >= range.from;
    canNext = addDays(start, 7) < range.to;
  } else {
    const [y, m] = month.split('-').map(Number);
    label = cap(F_MONTH.format(new Date(y, m - 1, 1)));
    canPrev = `${addMonths(month, -1)}-31` >= range.from;
    canNext = `${addMonths(month, 1)}-01` < range.to;
  }
  const isNow = mode === 'week' ? start === today() : month === today().slice(0, 7);
  paint(
    $('#agenda-controls'),
    `<nav class="seg-toggle" aria-label="Weergave"><a href="#/agenda?v=week" ${mode === 'week' ? 'aria-current="page"' : ''}>Week</a><a href="#/agenda?v=maand" ${mode === 'maand' ? 'aria-current="page"' : ''}>Maand</a></nav>` +
      `<div class="cal-nav"><button class="icon-btn" data-action="cal-step" data-step="-1" aria-label="Vorige"${canPrev ? '' : ' disabled'}>${icon('i-chev-left')}</button>` +
      `<span class="cal-nav__label">${label}</span>` +
      `<button class="icon-btn" data-action="cal-step" data-step="1" aria-label="Volgende"${canNext ? '' : ' disabled'}>${icon('i-chev-right')}</button></div>` +
      (isNow ? '' : `<button class="btn btn--sm btn--ghost" data-action="cal-today">Vandaag</button>`),
  );
  let note = '';
  if (cal.state === 'demo') note = `${demoTag(true)}<span>Koppel je eigen agenda's met iCal-links in config.json.</span>`;
  else if (cal.state === 'error') note = `<span class="st-down">Agenda niet bijgewerkt: ${esc(cal.error)}</span>`;
  paint($('#agenda-note'), note);
  paint($('#agenda-body'), mode === 'maand' ? monthHtml(d, month) : COMPACT.matches ? weekHtml(d, start) : weekGridHtml(d, start));
}

// Op een laag of smal scherm (strook, gsm) is een lijst per dag leesbaarder dan een urenrooster.
const COMPACT = matchMedia('(min-aspect-ratio: 3/1), (max-width: 47.99em), (orientation: portrait)');
COMPACT.addEventListener('change', () => render());

const dayHeadHtml = (date, t, w) =>
  `<span class="wday__name">${dayTitle(date, t)}</span><span class="wday__date">${shortDate(date)}</span>` +
  (w ? `<span class="wday__wx">${wxIcon(w.icon, true)}<span>${w.max}° / ${w.min}°</span></span>` : '');

// Week als urenrooster: elke afspraak staat op haar uur, zo zie je meteen waar er nog ruimte is.
function weekGridHtml(d, start) {
  const t = today();
  const now = new Date();
  const events = d.calendar.events ?? [];
  const wx = new Map((d.weather?.days ?? []).map((w) => [w.date, w]));
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const allDay = groupEvents(events.filter((e) => e.allDay), start, 7);

  // Per dag de stukken van afspraken met een uur (een afspraak over middernacht telt op beide dagen).
  const perDay = dates.map((date) => {
    const from = fromIso(date);
    const to = fromIso(addDays(date, 1));
    const segs = [];
    for (const e of events) {
      if (e.allDay) continue;
      const s = new Date(e.start);
      const en = new Date(e.end);
      if (en <= from || s >= to) continue;
      const a = Math.max(0, (s - from) / 36e5);
      const b = Math.min(24, (en - from) / 36e5);
      segs.push({ e, a, b: Math.max(b, a + 0.25), past: en <= now });
    }
    segs.sort((x, y) => x.a - y.a || y.b - x.b);
    // Overlappende afspraken naast elkaar.
    let cluster = [];
    let clusterEnd = 0;
    let lanes = [];
    const close = () => {
      for (const sgm of cluster) sgm.lanes = lanes.length;
      cluster = [];
      lanes = [];
    };
    for (const sgm of segs) {
      if (cluster.length && sgm.a >= clusterEnd) close();
      let lane = lanes.findIndex((end) => end <= sgm.a);
      if (lane === -1) lane = lanes.push(0) - 1;
      lanes[lane] = sgm.b;
      sgm.lane = lane;
      cluster.push(sgm);
      clusterEnd = Math.max(clusterEnd, sgm.b);
    }
    close();
    return segs;
  });

  const all = perDay.flat();
  const h0 = Math.max(0, Math.min(8, ...all.map((x) => Math.floor(x.a))));
  const h1 = Math.min(24, Math.max(20, ...all.map((x) => Math.ceil(x.b))));
  const span = h1 - h0;
  const pct = (h) => (((h - h0) / span) * 100).toFixed(2);
  const step = span > 14 ? 2 : 1;
  let hours = '';
  for (let h = h0 + (step === 2 && h0 % 2 ? 1 : 0); h < h1; h += step) hours += `<span style="top:${pct(h)}%">${pad(h)}:00</span>`;

  const heads = dates
    .map((date) => {
      const chips = (allDay.get(date) ?? []).map((e) => `<span class="tg__chip" data-tone="${eventTone(e)}">${esc(e.title)}</span>`).join('');
      return `<div class="tg__dayhead${date === t ? ' is-today' : ''}">${dayHeadHtml(date, t, wx.get(date))}<div class="tg__allday">${chips}</div></div>`;
    })
    .join('');
  const cols = dates
    .map((date, i) => {
      const evs = perDay[i]
        .map(({ e, a, b, lane, lanes, past }) => {
          const w = 100 / lanes;
          const time = `${F.time.format(new Date(e.start))}–${F.time.format(new Date(e.end))}`;
          return (
            `<div class="tev${past ? ' is-past' : ''}${b - a < 0.8 ? ' tev--short' : ''}" data-tone="${eventTone(e)}" style="top:${pct(a)}%;height:${(((b - a) / span) * 100).toFixed(2)}%;left:${(lane * w).toFixed(1)}%;width:${w.toFixed(1)}%">` +
            `<span class="tev__title">${esc(e.title)}</span><span class="tev__time">${time}${e.location ? `, ${esc(e.location)}` : ''}</span></div>`
          );
        })
        .join('');
      const nowH = now.getHours() + now.getMinutes() / 60;
      const line = date === t && nowH > h0 && nowH < h1 ? `<span class="tg__now" style="top:${pct(nowH)}%"></span>` : '';
      return `<div class="tg__col${date === t ? ' is-today' : ''}">${evs}${line}</div>`;
    })
    .join('');
  return (
    `<section class="card tg" style="--hours:${span / step}" aria-label="Week"><div class="tg__head"><span></span>${heads}</div>` +
    `<div class="tg__body"><div class="tg__hours">${hours}</div>${cols}</div></section>`
  );
}

function weekHtml(d, start) {
  const t = today();
  const now = new Date();
  const days = groupEvents(d.calendar.events ?? [], start, 7);
  const wx = new Map((d.weather?.days ?? []).map((w) => [w.date, w]));
  let html = '<div class="week">';
  for (const [date, list] of days) {
    const w = wx.get(date);
    html += `<section class="card wday${date === t ? ' is-today' : ''}" aria-label="${esc(dayTitle(date, t))}"><div class="wday__head">${dayHeadHtml(date, t, w)}</div><div class="wday__list">`;
    if (!list.length) html += '<span class="wday__empty">Niets gepland</span>';
    for (const e of list) {
      const past = !e.allDay && new Date(e.end) <= now;
      const time = e.allDay ? 'Hele dag' : `${F.time.format(new Date(e.start))}–${F.time.format(new Date(e.end))}`;
      html +=
        `<div class="wevent${past ? ' is-past' : ''}" data-tone="${eventTone(e)}"><span class="wevent__title">${esc(e.title)}</span>` +
        `<span class="wevent__time">${time}${e.location ? `, ${esc(e.location)}` : ''}</span></div>`;
    }
    html += '</div></section>';
  }
  return `${html}</div>`;
}

function monthHtml(d, month) {
  const t = today();
  const [y, m] = month.split('-').map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const gridStart = iso(new Date(y, m - 1, 1 - offset));
  const weeks = Math.ceil((offset + new Date(y, m, 0).getDate()) / 7);
  const days = groupEvents(d.calendar.events ?? [], gridStart, weeks * 7);
  const dow = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((x) => `<span class="label month__dow">${x}</span>`).join('');
  let cells = '';
  for (const [date, list] of days) {
    const other = date.slice(0, 7) !== month;
    const shown = list.slice(0, 3);
    cells +=
      `<button class="mday${other ? ' is-other' : ''}${date === t ? ' is-today' : ''}" data-action="cal-day" data-date="${date}" aria-label="${esc(cap(F.long.format(fromIso(date))))}, ${plural(list.length, 'afspraak', 'afspraken')}">` +
      `<span class="mday__num">${Number(date.slice(8))}</span>` +
      shown
        .map(
          (e) =>
            `<span class="mev" data-tone="${eventTone(e)}">${e.allDay ? '' : `<span class="mev__time">${F.time.format(new Date(e.start))}</span>`}<span class="mev__title">${esc(e.title)}</span></span>`,
        )
        .join('') +
      (list.length > 3 ? `<span class="mday__more">+${list.length - 3} meer</span>` : '') +
      `</button>`;
  }
  return `<div class="month" style="--weeks:${weeks}">${dow}${cells}</div>`;
}

// ── Taken ───────────────────────────────────────────────────
function sortTodos(items) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.doneAt ?? '').localeCompare(a.doneAt ?? '');
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due || b.due) return a.due ? -1 : 1;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

function dueLabel(due, t) {
  if (!due) return '';
  const n = diffDays(t, due);
  let text;
  let cls = '';
  if (n < -1) [text, cls] = [`${-n} dagen te laat`, 'due--late'];
  else if (n === -1) [text, cls] = ['gisteren', 'due--late'];
  else if (n === 0) [text, cls] = ['vandaag', 'due--today'];
  else if (n === 1) text = 'morgen';
  else if (n < 7) text = clean(F.wd.format(fromIso(due)));
  else text = shortDate(due);
  return `<span class="due ${cls}">${text}</span>`;
}

// Een taak: het rondje om af te vinken, de titel, en eronder de categorie en tegen wanneer.
function todoRow(item, { showCat = false, deletable = false } = {}) {
  const c = catOf(item.category);
  const cat = showCat && c && !item.done ? `<span class="todo__cat">${esc(c.label)}</span>` : '';
  const due = item.done ? '' : dueLabel(item.due, today());
  return (
    `<div class="todo${item.done ? ' is-done' : ''}" data-tone="${c?.tone ?? ''}">` +
    `<button class="check" role="checkbox" aria-checked="${item.done}" data-action="todo-toggle" data-id="${esc(item.id)}" aria-label="${esc(item.title)}">` +
    `<span class="check__ring">${item.done ? icon('i-check') : ''}</span></button>` +
    `<span class="todo__body"><span class="todo__title">${esc(item.title)}</span>${cat || due ? `<span class="todo__sub">${cat}${due}</span>` : ''}</span>` +
    (deletable ? `<button class="icon-btn" data-action="todo-delete" data-id="${esc(item.id)}" aria-label="Verwijder ${esc(item.title)}">${icon('i-x')}</button>` : '<span></span>') +
    `</div>`
  );
}

function todoForm(where, defaultCat) {
  const f = state.ui.todoForm;
  if (!f || f.where !== where) {
    return `<button class="add" data-action="todo-open" data-where="${where}" data-cat="${esc(defaultCat ?? '')}">${icon('i-plus')}Taak toevoegen</button>`;
  }
  const seg = (key, value, label, on) =>
    `<button type="button" class="chip" data-action="seg" data-key="${key}" data-value="${value}" aria-pressed="${on}">${label}</button>`;
  return (
    `<form class="form" data-form="todo" data-cat="${esc(f.category)}" data-due="">` +
    `<label class="field"><span class="field__label">Nieuwe taak</span><input class="input" name="title" autocomplete="off" maxlength="200" placeholder="Wat moet er gebeuren?"></label>` +
    `<div class="field"><span class="field__label">Categorie</span><div class="seg">${cats().map((c) => seg('cat', c.id, esc(c.label), c.id === f.category)).join('')}</div></div>` +
    `<div class="field"><span class="field__label">Wanneer</span><div class="seg">${seg('due', '', 'Geen datum', true)}${seg('due', '0', 'Vandaag', false)}${seg('due', '1', 'Morgen', false)}${seg('due', '7', 'Over een week', false)}</div></div>` +
    `<div class="btn-row"><button class="btn btn--primary btn--sm" type="submit">Toevoegen</button><button class="btn btn--ghost btn--sm" type="button" data-action="todo-close">Annuleren</button></div>` +
    `</form>`
  );
}

// Snel een taak typen op je gsm: één veld, daaronder categorie en datum.
const DUE_CHOICES = [['', 'Geen datum'], ['0', 'Vandaag'], ['1', 'Morgen'], ['7', 'Over een week']];
function renderComposer(list, sig) {
  const el = $('#composer');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  let cat = null;
  try {
    cat = localStorage.getItem('todoCat');
  } catch {
    /* geen opslag beschikbaar */
  }
  if (!list.some((c) => c.id === cat)) cat = list[0]?.id ?? '';
  el.dataset.cat = cat;
  el.dataset.due = '';
  el.innerHTML =
    `<div class="composer__row"><input class="input" name="title" maxlength="200" placeholder="Nieuwe taak" enterkeyhint="send" aria-label="Nieuwe taak">` +
    `<button class="composer__send" type="submit" aria-label="Toevoegen">${icon('i-send')}</button></div>` +
    `<div class="composer__opts">${list
      .map(
        (c) =>
          `<button type="button" class="chip" data-tone="${c.tone}" data-action="seg" data-key="cat" data-value="${esc(c.id)}" aria-pressed="${c.id === cat}"><span class="chip__dot"></span>${esc(c.label)}</button>`,
      )
      .join('')}</div>` +
    `<div class="composer__opts">${DUE_CHOICES.map(([v, label], i) => `<button type="button" class="chip" data-action="seg" data-key="due" data-value="${v}" aria-pressed="${i === 0}">${label}</button>`).join('')}</div>`;
}

function renderBoard(d) {
  const el = $('#board');
  const list = cats();
  const sig = list.map((c) => c.id).join(',');
  renderComposer(list, sig);
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.style.setProperty('--cols', String(list.length));
    el.innerHTML = list
      .map(
        (c) =>
          `<section class="card" data-tone="${c.tone}" aria-labelledby="hb-${esc(c.id)}"><div class="card__head"><h2 class="card__title" id="hb-${esc(c.id)}">${esc(c.label)}</h2><span class="card__meta" data-meta="${esc(c.id)}"></span></div>` +
          `<div class="card__body"><div data-list="${esc(c.id)}"></div><div data-form="${esc(c.id)}"></div></div></section>`,
      )
      .join('');
  }
  const items = d.todos.items ?? [];
  paint($('#board-meta'), `<span>${items.filter((i) => !i.done).length} open</span>`);
  for (const c of list) {
    const mine = sortTodos(items.filter((i) => i.category === c.id));
    const open = mine.filter((i) => !i.done).length;
    paint($(`[data-meta="${CSS.escape(c.id)}"]`, el), `<span>${open} open</span>`);
    let html = mine.map((i) => todoRow(i, { deletable: true })).join('');
    if (!open) html += `<div class="empty"><strong>Niets open</strong><span>Voeg hieronder een taak toe.</span></div>`;
    paint($(`[data-list="${CSS.escape(c.id)}"]`, el), html);
    paint($(`div[data-form="${CSS.escape(c.id)}"]`, el), todoForm(`board-${c.id}`, c.id));
  }
}

// Overzicht: de eerstvolgende deadlines en examens, dezelfde gegevens als op het tabblad School.
function renderOvSchool(s) {
  const el = $('#ov-school');
  el.hidden = !s || s.state !== 'ok';
  if (el.hidden) return;
  const now = new Date();
  const t = iso(now);
  const due = schoolItems(s).filter((i) => isDue(i) && i.end > now);
  const row = (i) => {
    const c = s.courses.find((x) => x.id === i.course);
    const n = diffDays(t, i.day);
    const count = n === 0 ? ['nu', 'vandaag'] : [n, n === 1 ? 'morgen' : 'dagen'];
    return (
      `<div class="odue${n <= 7 ? ' is-soon' : ''}" data-tone="${c?.tone ?? ''}">` +
      `<span class="odue__count"><b>${count[0]}</b><small>${count[1]}</small></span>` +
      `<span class="odue__body"><span class="odue__title">${esc(i.title)}</span>` +
      `<span class="odue__sub">${schoolBadge(c)}${i.kind === 'examen' ? schoolKind('examen') : ''}<span>${esc(clean(F_SHORT.format(i.dt)))}</span><span>${esc(schoolTimeText(i))}</span></span></span></div>`
    );
  };
  const more = due.length - 4;
  paint(
    el,
    cardHead('Deadlines', `<span class="head-link">${more > 0 ? `nog ${more}` : 'School'}${icon('i-chev-right')}</span>`, 'i-school', 'sky') +
      (due.length ? `<div class="odues">${due.slice(0, 4).map(row).join('')}</div>` : `<div class="empty"><strong>Niets meer in te dienen</strong><span>Geen deadlines of examens gepland.</span></div>`),
  );
}

// ── School ──────────────────────────────────────────────────
// Lessen, deadlines en examens uit school.json (zie school.example.json).
const KIND_LABEL = { les: 'Les', deadline: 'Indienen', examen: 'Examen', opdracht: 'Opdracht' };
const SCHOOL_STALE_DAYS = 14;
const F_SHORT = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const isDue = (i) => i.kind === 'deadline' || i.kind === 'examen';
const countLabel = (n) => (n < 0 ? 'voorbij' : n === 0 ? 'vandaag' : n === 1 ? 'morgen' : `nog ${n} dagen`);

function schoolItems(s) {
  return (s?.items ?? []).map((i) => {
    const dt = new Date(i.start);
    const end = new Date(dt);
    if (i.end) {
      const [h, m] = i.end.split(':').map(Number);
      end.setHours(h, m, 0, 0);
    }
    return { ...i, endTime: i.end, dt, end, day: i.start.slice(0, 10) };
  });
}

// [groot, klein] voor de tijdkolom, en dezelfde info als één zin.
function schoolTime(i) {
  if (i.noTime) return ['–', 'uur n.t.b.'];
  const t = F.time.format(i.dt);
  if (i.endTime) return [t, i.endTime];
  return [t, i.kind === 'deadline' ? 'uiterlijk' : i.kind === 'examen' ? 'vanaf' : ''];
}
function schoolTimeText(i) {
  if (i.noTime) return 'uur n.t.b.';
  const t = F.time.format(i.dt);
  if (i.endTime) return `${t}–${i.endTime}`;
  return i.kind === 'deadline' ? `tegen ${t}` : i.kind === 'examen' ? `vanaf ${t}` : t;
}

function schoolState(s, q) {
  const show = ['deadlines', 'lessen'].includes(q.get('toon')) ? q.get('toon') : 'alles';
  const course = (s?.courses ?? []).some((c) => c.id === q.get('vak')) ? q.get('vak') : '';
  return { show, course, past: q.get('voorbij') === '1' };
}
function schoolHref(st, changes = {}) {
  const n = { ...st, ...changes };
  const q = new URLSearchParams();
  if (n.show !== 'alles') q.set('toon', n.show);
  if (n.course) q.set('vak', n.course);
  if (n.past) q.set('voorbij', '1');
  const text = q.toString();
  return `#/school${text ? `?${text}` : ''}`;
}

const schoolBadge = (c) => `<span class="sch-badge" data-tone="${c?.tone ?? ''}">${esc(c?.abbr ?? '')}</span>`;
const schoolKind = (k) => `<span class="sch-kind sch-kind--${k}">${KIND_LABEL[k] ?? ''}</span>`;

function schoolHero(el, label, list, none, now, courseOf) {
  const [a, b] = list;
  if (!a) {
    el.dataset.tone = '';
    paint(el, `<div class="sch-hero__main"><span class="label">${label}</span><span class="sch-hero__none">${none}</span></div>`);
    return;
  }
  const c = courseOf(a.course);
  const n = diffDays(iso(now), a.day);
  let big;
  let unit;
  let cls = '';
  if (a.kind === 'les' && a.dt <= now) [big, unit, cls] = ['Nu', 'bezig', ' is-text'];
  else if (n === 0) [big, unit, cls] = [a.noTime ? '!' : F.time.format(a.dt), 'vandaag', ' is-text'];
  else [big, unit] = [n, n === 1 ? 'morgen' : 'dagen'];
  el.dataset.tone = c?.tone ?? '';
  paint(
    el,
    `<div class="sch-hero__count${cls}"><b>${big}</b><span>${unit}</span></div>` +
      `<div class="sch-hero__main"><span class="label">${label}</span>` +
      `<span class="sch-hero__title">${esc(a.title)}</span>` +
      `<span class="sch-hero__meta">${schoolBadge(c)}<span>${esc(clean(F_SHORT.format(a.dt)))}</span><span>${esc(schoolTimeText(a))}</span>` +
      `${a.room ? `<span class="sch-hero__where">${icon('i-pin')}${esc(a.room)}</span>` : ''}</span>` +
      (b ? `<span class="sch-hero__after">Daarna <b>${esc(b.title)}</b>, ${esc(courseOf(b.course)?.abbr ?? '')}, ${esc(clean(F_SHORT.format(b.dt)))}</span>` : '') +
      `</div>`,
  );
}

function schoolCoursesHtml(s, items, st, now) {
  const open = (id) => {
    const due = items.filter((i) => isDue(i) && i.end >= now && (!id || i.course === id));
    const dl = due.filter((i) => i.kind === 'deadline').length;
    const ex = due.length - dl + s.undated.filter((u) => u.kind === 'examen' && (!id || u.course === id)).length;
    const parts = [dl ? plural(dl, 'deadline', 'deadlines') : '', ex ? plural(ex, 'examen', 'examens') : ''].filter(Boolean);
    return parts.length ? parts.join('<br>') : 'Niets meer in te dienen';
  };
  const row = (id, tone, title, sub) =>
    `<a class="sch-course" href="${schoolHref(st, { course: st.course === id ? '' : id })}" data-tone="${tone}"${st.course === id ? ' aria-current="true"' : ''}>` +
    `<span class="sch-course__dot"></span><span class="sch-course__body"><b>${esc(title)}</b><span>${esc(sub)}</span></span>` +
    `<span class="sch-course__n">${open(id)}</span></a>`;
  return (
    cardHead('Vakken', st.course ? `<a class="head-link" href="${schoolHref(st, { course: '' })}">Toon alles</a>` : '') +
    `<div class="card__body">${row('', '', 'Alle vakken', s.period || '')}${s.courses.map((c) => row(c.id, c.tone, c.abbr, c.name)).join('')}</div>`
  );
}

function schoolRow(i, courseOf) {
  const [main, small] = schoolTime(i);
  return (
    `<div class="event srow srow--${i.kind}" data-tone="${courseOf(i.course)?.tone ?? ''}">` +
    `<span class="event__time">${main}<small>${small}</small></span><span class="event__bar"></span>` +
    `<span class="event__body"><span class="srow__tags">${schoolBadge(courseOf(i.course))}${schoolKind(i.kind)}` +
    `${i.room ? `<span class="srow__room">${icon('i-pin')}${esc(i.room)}</span>` : ''}</span>` +
    `<span class="event__title">${esc(i.title)}</span>` +
    (i.text ? `<span class="srow__text">${esc(i.text)}</span>` : '') +
    (i.note ? `<span class="srow__note"><b>Let op</b> ${esc(i.note)}</span>` : '') +
    `</span></div>`
  );
}

function schoolListHtml(s, items, st, now) {
  const t = iso(now);
  const courseOf = (id) => s.courses.find((c) => c.id === id);
  const sel = items.filter((i) => (!st.course || i.course === st.course) && (st.show === 'alles' || (st.show === 'lessen') === (i.kind === 'les')));
  const nPast = sel.filter((i) => i.day < t).length;
  const shown = st.past ? sel : sel.filter((i) => i.day >= t);
  const marker = `<div class="sch-today" role="separator">Vandaag, ${esc(clean(F_SHORT.format(now)))}</div>`;

  let body = '';
  let month = '';
  let day = '';
  let marked = !(st.past && nPast);
  for (const i of shown) {
    if (i.day !== day) {
      if (day) body += '</div>';
      if (!marked && i.day >= t) {
        body += marker;
        marked = true;
      }
      const m = cap(F_MONTH.format(i.dt));
      if (m !== month) {
        body += `<h3 class="sch-month">${m}</h3>`;
        month = m;
      }
      const n = diffDays(t, i.day);
      const soon = n >= 0 && n <= 7 && shown.some((x) => x.day === i.day && isDue(x));
      body +=
        `<div class="agenda-day sday${n < 0 ? ' is-past' : ''}"><div class="agenda-day__head">` +
        `<span class="agenda-day__name">${cap(F.weekday.format(i.dt))}</span><span class="agenda-day__date">${shortDate(i.day)}</span>` +
        `<span class="sday__rel${soon ? ' is-soon' : ''}">${countLabel(n)}</span></div>`;
      day = i.day;
    }
    body += schoolRow(i, courseOf);
  }
  if (day) body += '</div>';
  if (!marked) body += marker;
  if (!shown.length) body += `<div class="empty"><strong>Niets gepland in deze selectie</strong><span>Kies een ander vak of toon alles.</span></div>`;

  const undated = st.show === 'lessen' ? [] : s.undated.filter((u) => !st.course || u.course === st.course);
  if (undated.length) {
    body +=
      `<h3 class="sch-month">Nog geen datum</h3>` +
      undated
        .map(
          (u) =>
            `<div class="event srow srow--${u.kind}" data-tone="${courseOf(u.course)?.tone ?? ''}">` +
            `<span class="event__time">–<small>datum n.t.b.</small></span><span class="event__bar"></span>` +
            `<span class="event__body"><span class="srow__tags">${schoolBadge(courseOf(u.course))}${schoolKind(u.kind)}</span>` +
            `<span class="event__title">${esc(u.title)}</span>` +
            `<ul class="srow__points">${u.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></span></div>`,
        )
        .join('');
  }
  body += `<p class="sch-foot">Je eigen overzicht uit school.json. Bij verschillen geldt wat op het leerplatform staat of wat de docent zegt.</p>`;

  const upcoming = sel.filter((i) => i.day >= t);
  const nDue = upcoming.filter(isDue).length;
  const nLes = upcoming.length - nDue;
  const counts = [st.show !== 'lessen' ? plural(nDue, 'deadline of examen', 'deadlines en examens') : '', st.show !== 'deadlines' ? plural(nLes, 'les', 'lessen') : ''].filter(Boolean).join(', ');
  const toggle = nPast ? `<a class="head-link" href="${schoolHref(st, { past: !st.past })}">${st.past ? 'Verberg voorbije' : `Toon ${nPast} voorbije`}</a>` : '';
  return cardHead('Planning', `<span>${counts}</span>${toggle}`) + `<div class="card__body">${body}</div>`;
}

function renderSchool(s, q) {
  if (!s || s.state !== 'ok') {
    paint($('#school-controls'), '');
    paint($('#school-meta'), '');
    for (const id of ['#school-due', '#school-les', '#school-courses']) paint($(id), '');
    paint($('#school-list'), notice(s?.error ?? 'Geen schoolgegevens gevonden. Maak een school.json naast config.json (zie de README).'));
    return;
  }
  const now = new Date();
  const st = schoolState(s, q);
  const items = schoolItems(s);
  const courseOf = (id) => s.courses.find((c) => c.id === id);

  const tab = (value, label) => `<a href="${schoolHref(st, { show: value })}"${st.show === value ? ' aria-current="page"' : ''}>${label}</a>`;
  paint($('#school-controls'), `<nav class="seg-toggle" aria-label="Wat wil je zien?">${tab('alles', 'Alles')}${tab('deadlines', 'Deadlines')}${tab('lessen', 'Lessen')}</nav>`);

  let meta = demoTag(s.demo, 'Voorbeeld');
  if (s.checked && !s.demo) {
    const age = diffDays(s.checked, iso(now));
    meta =
      age > SCHOOL_STALE_DAYS
        ? `<span class="sch-stale">${icon('i-alert')}Al ${age} dagen niet nagekeken, check je leerplatform</span>`
        : `<span>Nagekeken op ${shortDate(s.checked)}</span>`;
  }
  // Lessen uit het officiële TimeEdit-rooster (server: school.timeedit in config.json).
  if (s.timeedit?.state === 'ok') meta += `<span class="sch-te">${icon('i-calendar')}Lesrooster uit TimeEdit</span>`;
  else if (s.timeedit?.state === 'error') meta += `<span class="sch-stale">${icon('i-alert')}TimeEdit niet bereikbaar</span>`;
  paint($('#school-meta'), meta);

  const due = items.filter((i) => isDue(i) && i.end > now);
  schoolHero($('#school-due'), due[0]?.kind === 'examen' ? 'Volgend examen' : 'Volgende deadline', due, 'Geen deadlines of examens meer.', now, courseOf);
  schoolHero($('#school-les'), 'Volgende les', items.filter((i) => i.kind === 'les' && i.end > now), 'Geen lessen meer dit semester.', now, courseOf);
  paint($('#school-courses'), schoolCoursesHtml(s, items, st, now));
  paint($('#school-list'), schoolListHtml(s, items, st, now));
}

// ── Weer ────────────────────────────────────────────────────
// Het tabblad Weer (via het weer op het overzicht): het weer nu onder een lucht die meekleurt,
// regen per kwartier voor de komende twee uur, zes tegels (wind, UV, vocht, lucht, zon, maan),
// het verloop per uur van de gekozen dag en de komende zeven dagen. Tik een dag om zijn uren te
// zien, tik een uur voor de details. Het volledige beeld komt van /api/weather, pas als je kijkt.
state.wx = { data: null, at: 0, failedAt: 0, loading: false, hour: null, hourDay: null };

async function loadWx() {
  const w = state.wx;
  const fresh = w.data && Date.now() - w.at < 10 * 60_000 && w.data.updatedAt === state.data?.weather?.updatedAt;
  if (w.loading || fresh || Date.now() - w.failedAt < 60_000) return;
  w.loading = true;
  try {
    const d = await api('GET', '/api/weather');
    if (d.state === 'ok') {
      w.data = d;
      w.at = Date.now();
    } else w.failedAt = Date.now();
  } catch {
    w.failedAt = Date.now();
  } finally {
    w.loading = false;
  }
  if (route().view === 'weer') render();
}

const num = (n) => String(n).replace('-', '−');
const mmText = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace('.', ','));
const WIND_DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OZO', 'ZO', 'ZZO', 'Z', 'ZZW', 'ZW', 'WZW', 'W', 'WNW', 'NW', 'NNW'];
const windDir = (deg) => WIND_DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const BFT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
const BFT_NAME = ['windstil', 'zwak', 'zwak', 'matig', 'matig', 'vrij krachtig', 'krachtig', 'hard', 'stormachtig', 'storm', 'zware storm', 'zeer zware storm', 'orkaan'];
const beaufort = (kmh) => BFT.filter((v) => kmh >= v).length;
const uvLevel = (uv) => (uv < 3 ? 'laag' : uv < 6 ? 'matig' : uv < 8 ? 'hoog' : uv < 11 ? 'zeer hoog' : 'extreem');
const aqiLevel = (a) => (a <= 20 ? ['goed', 'good'] : a <= 40 ? ['redelijk', 'fair'] : a <= 60 ? ['matig', 'moderate'] : a <= 80 ? ['slecht', 'poor'] : ['zeer slecht', 'bad']);
const humidityWord = (h) => (h < 35 ? 'droge lucht' : h < 65 ? 'aangenaam' : h < 85 ? 'vochtig' : 'zeer vochtig');
// Pollen (korrels per m³): grenzen voor laag, matig, hoog verschillen per soort.
const POLLEN = { els: ['Els', [10, 50]], berk: ['Berk', [10, 50]], gras: ['Gras', [5, 30]], bijvoet: ['Bijvoet', [5, 20]], ambrosia: ['Ambrosia', [5, 20]] };
const POLLEN_WORD = ['geen', 'laag', 'matig', 'hoog'];
function pollenText(p) {
  let best = null;
  for (const [key, [name, [a, b]]] of Object.entries(POLLEN)) {
    const v = p?.[key];
    if (!Number.isFinite(v)) continue;
    const lvl = v < 1 ? 0 : v < a ? 1 : v < b ? 2 : 3;
    if (!best || lvl > best.lvl) best = { name, lvl };
  }
  if (!best) return 'pollen onbekend';
  return best.lvl ? `${best.name.toLowerCase()}pollen ${POLLEN_WORD[best.lvl]}` : 'geen pollen';
}
// Een temperatuur krijgt een toon (in Lumen bewust ingetogen).
const tempHue = (t) => (t <= 3 ? 'sky' : t <= 10 ? 'sage' : t <= 17 ? 'honey' : t <= 24 ? 'apricot' : 'rose');
const skyOf = (kind) => (kind === 'clear' || kind === 'partly' ? 'clear' : kind === 'snow' ? 'snow' : kind === 'cloud' || kind === 'fog' ? 'cloud' : 'rain');
const daylightText = (s) => `${Math.floor(s / 3600)} u ${pad(Math.round((s % 3600) / 60))} min`;

// Maanfase uit de datum (synodische maand, vanaf een bekende nieuwe maan).
function moonInfo(date) {
  const SYN = 29.530588853;
  const age = ((((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % SYN) + SYN) % SYN;
  const names = ['Nieuwe maan', 'Wassende sikkel', 'Eerste kwartier', 'Wassende maan', 'Volle maan', 'Afnemende maan', 'Laatste kwartier', 'Afnemende sikkel'];
  const name = names[Math.floor(((age + SYN / 16) % SYN) / (SYN / 8))];
  const toFull = (SYN / 2 - age + SYN) % SYN;
  const toNew = SYN - age;
  const days = (x) => Math.round(x);
  let next;
  if (days(toFull) === 0 || days(toFull) === Math.round(SYN)) next = 'Vannacht volle maan';
  else if (days(toNew) === 0 || days(toNew) === Math.round(SYN)) next = 'Vannacht nieuwe maan';
  else next = toFull < toNew ? `Volle maan over ${plural(days(toFull), 'dag', 'dagen')}` : `Nieuwe maan over ${plural(days(toNew), 'dag', 'dagen')}`;
  return { frac: age / SYN, name, next, lit: Math.round(((1 - Math.cos(2 * Math.PI * (age / SYN))) / 2) * 100) };
}
function wxMoonSvg(frac) {
  const r = 10;
  const k = Math.cos(2 * Math.PI * frac);
  const waxing = frac < 0.5;
  const rx = (r * Math.abs(k)).toFixed(2);
  const lit = `M12 2 A${r} ${r} 0 0 ${waxing ? 1 : 0} 12 22 A${rx} ${r} 0 0 ${(k > 0) === waxing ? 0 : 1} 12 2 Z`;
  return `<svg class="wx-moonglyph" viewBox="0 0 24 24" aria-hidden="true"><circle class="wx-moonglyph__dark" cx="12" cy="12" r="${r}"/><path class="wx-moonglyph__lit" d="${lit}"/></svg>`;
}
const windArrow = (deg, cls = 'wx-arrow') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${(deg + 180) % 360}deg)"><path d="M12 3.5v15M7 13.5l5 5 5-5"/></svg>`;

// De beste twee uur om naar buiten te gaan: droog (minder dan 40% kans), dan zo warm en windstil mogelijk.
function bestOutside(w, now) {
  for (const day of w.days.slice(0, 2)) {
    const rise = new Date(day.sunrise);
    const set = new Date(day.sunset);
    const from = new Date(Math.max(now - 30 * 60_000, rise - 30 * 60_000));
    const hours = w.hours.filter((h) => h.time.startsWith(day.date) && new Date(h.time) >= from && new Date(h.time) < set);
    let best = null;
    for (let i = 0; i + 1 < hours.length; i++) {
      const pair = [hours[i], hours[i + 1]];
      const rain = Math.max(...pair.map((h) => h.precip));
      if (rain >= 40) continue;
      const score = rain + Math.max(0, 15 - Math.min(...pair.map((h) => h.feels))) * 3 + Math.max(0, Math.max(...pair.map((h) => h.wind)) - 25);
      if (!best || score < best.score) best = { score, pair };
    }
    if (best) {
      const [a, b] = best.pair;
      const end = new Date(new Date(b.time).getTime() + 3600e3);
      const when = day.date === iso(now) ? '' : 'Morgen ';
      return `${when}${hourLabel(a.time).replace('u', '')}–${pad(end.getHours())}u, ${a.precip >= 20 || b.precip >= 20 ? 'wellicht droog' : 'droog'} en ${num(Math.round((a.temp + b.temp) / 2))}°`;
    }
    if (day.date === iso(now) && now < set) return 'Vandaag geen droog moment meer';
  }
  return '';
}

function wxHeroHtml(w, now) {
  const c = w.current;
  const t = w.days[0];
  const text = moWeatherText(state.data.weather, now);
  const best = bestOutside(w, now);
  return (
    `<div class="wx-hero__top"><span class="wx-hero__where">${icon('i-pin')}${esc(w.location || 'Hier')}</span><span>bijgewerkt ${F.time.format(new Date(w.updatedAt))}</span></div>` +
    `<div class="wx-hero__main"><span class="wx-hero__temp">${num(c.temp)}<span>°</span></span>${wxIcon(c.icon, c.isDay, 'wx-hero__icon')}</div>` +
    `<p class="wx-hero__label">${esc(c.label)}</p>` +
    `<p class="wx-hero__line">Voelt als ${num(c.feels)}°<span class="wx-hero__hl"><b>↑ ${num(t.max)}°</b><b>↓ ${num(t.min)}°</b></span></p>` +
    (text ? `<p class="wx-hero__text">${esc(text)}</p>` : '') +
    (best ? `<div class="wx-best">${icon('i-walk')}<span><small>Beste moment buiten</small>${esc(best)}</span></div>` : '')
  );
}

// Regen per kwartier voor de komende twee uur, als staafjes, met één zin erboven.
function wxRainHtml(w, now) {
  const n = w.nowcast?.length ? w.nowcast : [];
  const wet = (x) => x.mm >= 0.1;
  const at = (x) => F.time.format(new Date(x.time));
  let head;
  let sub;
  const first = n.findIndex(wet);
  if (!n.length) {
    head = 'Geen gegevens';
    sub = 'De regenverwachting per kwartier is er even niet.';
  } else if (first === -1) {
    head = 'Droog';
    sub = 'De komende twee uur valt er geen regen.';
  } else if (first === 0) {
    const dry = n.findIndex((x, i) => i > 0 && !wet(x));
    head = dry === -1 ? 'Het regent' : `Regen tot ${at(n[dry])}`;
    sub = dry === -1 ? 'Ook de komende twee uur blijft het nat.' : 'Daarna wordt het droog.';
  } else {
    const mins = Math.max(15, Math.round((new Date(n[first].time) - now) / 60000));
    head = `Regen vanaf ${at(n[first])}`;
    sub = `Over ongeveer ${durText(mins)}, droog tot dan.`;
  }
  const peak = Math.max(0, ...n.map((x) => x.mm * 4));
  if (peak >= 0.4) sub += ` ${peak < 2.5 ? 'Lichte regen' : peak < 8 ? 'Matige regen' : 'Zware regen'}, tot ${mmText(peak)} mm per uur.`;
  const bars = n
    .map((x, i) => {
      const rate = x.mm * 4;
      const h = rate <= 0 ? 0 : Math.max(10, Math.min(100, Math.sqrt(rate / 8) * 100));
      const lvl = rate < 2.5 ? 1 : rate < 8 ? 2 : 3;
      return `<div class="wx-rain__bar${h ? ` is-wet l${lvl}` : ''}"><span style="height:${h.toFixed(0)}%"></span><small>${i % 2 === 0 ? (i === 0 ? 'nu' : at(x)) : ''}</small></div>`;
    })
    .join('');
  const rest = w.hours.filter((h) => h.time.startsWith(iso(now)) && new Date(h.time) > now).reduce((s, h) => s + h.mm, 0);
  return (
    cardHead('Komende 2 uur', '', 'i-umbrella', 'sky') +
    `<p class="wx-rain__head">${esc(head)}</p><p class="wx-rain__sub">${esc(sub)}</p>` +
    `<div class="wx-rain__bars" role="img" aria-label="Regen per kwartier">${bars}</div>` +
    `<p class="wx-rain__day">${rest >= 0.1 ? `Nog ${mmText(rest)} mm regen verwacht vandaag` : 'Vandaag verder geen regen verwacht'}</p>`
  );
}

function wxTilesHtml(w, now) {
  const c = w.current;
  const t = w.days[0];
  const tile = (ic, hue, label, value, sub, extra = '') =>
    `<section class="card wx-tile" data-hue="${hue}"><div class="wx-tile__head"><span class="card__ic">${icon(ic)}</span><span>${label}</span></div>` +
    `<div class="wx-tile__value">${value}</div>${extra}<p class="wx-tile__sub">${sub}</p></section>`;
  const b = beaufort(c.wind);
  const wind = tile('i-wind', 'sky', 'Wind', `${windArrow(c.windDir)}${c.wind}<small>km/u, stoten ${c.gusts}</small>`, `${windDir(c.windDir)}, ${b} Bft (${BFT_NAME[b]})`);
  const todayHours = w.hours.filter((h) => h.time.startsWith(t.date));
  const peak = todayHours.reduce((m, h) => (h.uv > (m?.uv ?? -1) ? h : m), null);
  const uvPos = Math.min(100, (c.uv / 11) * 100);
  const uv = tile(
    'i-sun',
    'honey',
    'UV-index',
    `${num(Math.round(c.uv))}<small>${uvLevel(c.uv)}</small><span class="wx-uvbar"><i style="left:${uvPos.toFixed(0)}%"></i></span>`,
    peak && peak.uv >= 1 ? `Max ${num(Math.round(peak.uv))} rond ${hourLabel(peak.time)}` : 'Geen zonnebrand nodig',
  );
  const hum = tile('i-drop', 'lilac', 'Vochtigheid', `${c.humidity}<small>%</small>`, `Dauwpunt ${num(c.dewPoint)}°, ${humidityWord(c.humidity)}`);
  const a = w.air;
  const air =
    a?.state === 'ok' && Number.isFinite(a.aqi)
      ? tile('i-air', 'sage', 'Luchtkwaliteit', `<i class="wx-aqi is-${aqiLevel(a.aqi)[1]}"></i>${a.aqi}<small>${aqiLevel(a.aqi)[0]}</small>`, `Fijnstof ${Math.round(a.pm25)}, ${pollenText(a.pollen)}`)
      : tile('i-air', 'sage', 'Luchtkwaliteit', '–', 'Even geen gegevens');
  const rise = new Date(t.sunrise);
  const set = new Date(t.sunset);
  const tomorrow = w.days[1];
  let sunValue;
  if (now < rise) sunValue = `<small>op</small>${F.time.format(rise)}`;
  else if (now < set) sunValue = `<small>onder</small>${F.time.format(set)}`;
  else sunValue = `<small>op</small>${tomorrow ? timeShort(tomorrow.sunrise) : '–'}`;
  const delta = t.daylightDelta;
  const deltaText = Number.isFinite(delta) && Math.abs(delta) >= 30 ? ` (${delta < 0 ? '−' : '+'}${Math.round(Math.abs(delta) / 60)} min)` : '';
  const sun = tile('i-sunrise', 'apricot', 'Zon', sunValue, `${daylightText(t.daylight)} licht${deltaText}`);
  const m = moonInfo(now);
  const moon = tile('i-moon', 'pink', 'Maan', `${wxMoonSvg(m.frac)}<span class="wx-tile__name">${m.name}</span>`, `${m.next}`);
  return wind + uv + hum + air + sun + moon;
}

// Het verloop per uur: temperatuur (en gevoelstemperatuur, gestreept), regen als staafjes,
// wind om de drie uur, de nacht als donkere band. Vandaag = de komende 24 uur.
function wxHoursHtml(w, day, now) {
  const today = iso(now);
  let hours;
  if (day === today) {
    const start = w.hours.findIndex((h) => new Date(h.time).getTime() + 3600e3 > now.getTime());
    hours = w.hours.slice(Math.max(0, start), Math.max(0, start) + 24);
  } else hours = w.hours.filter((h) => h.time.startsWith(day));
  const n = hours.length;
  if (!n) return cardHead('Per uur') + notice('Voor deze dag is er nog geen verwachting per uur.');
  const all = hours.flatMap((h) => [h.temp, h.feels]);
  const lo = Math.min(...all);
  const span = Math.max(Math.max(...all) - lo, 5);
  const xp = (i) => ((i + 0.5) / n) * 100;
  const yp = (t) => 14 + (1 - (t - lo) / span) * 72;
  const line = (key) => hours.map((h, i) => `${(xp(i) * 10).toFixed(1)},${yp(h[key]).toFixed(1)}`).join(' ');
  let nights = '';
  for (let i = 0; i < n; ) {
    if (hours[i].isDay) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && !hours[j + 1].isDay) j++;
    nights += `<rect class="wxh__night" x="${((i / n) * 1000).toFixed(1)}" y="0" width="${(((j - i + 1) / n) * 1000).toFixed(1)}" height="100"/>`;
    i = j + 1;
  }
  const t0 = line('temp');
  const first = yp(hours[0].temp).toFixed(1);
  const last = yp(hours[n - 1].temp).toFixed(1);
  const every = (k) => hours.map((h, i) => [h, i]).filter(([, i]) => i % 3 === k);
  const sel = state.wx.hourDay === day ? state.wx.hour : null;
  const s = sel !== null && sel < n ? hours[sel] : null;
  const isToday = day === today;
  const pos = (i) => `left:${xp(i).toFixed(2)}%`;

  const icons = every(0).map(([h, i]) => `<span style="${pos(i)}">${wxIcon(h.icon, h.isDay)}</span>`).join('');
  const temps = every(0).map(([h, i]) => `<b class="wxh__t" style="${pos(i)};top:${yp(h.temp).toFixed(1)}%">${num(h.temp)}°</b>`).join('');
  const rain = hours
    .map((h, i) => {
      if (h.precip < 10 && h.mm < 0.1) return '';
      const lvl = h.mm < 0.5 ? 1 : h.mm < 2 ? 2 : 3;
      return `<span class="wxh__bar l${lvl}" style="${pos(i)};height:${Math.max(8, h.precip)}%">${h.mm >= 0.5 && i % 2 === 0 ? `<small>${mmText(h.mm)}</small>` : ''}</span>`;
    })
    .join('');
  const winds = every(1).map(([h, i]) => `<span style="${pos(i)}">${windArrow(h.windDir, 'wx-arrow wx-arrow--sm')}<small>${h.wind}</small></span>`).join('');
  const times = every(0).map(([h, i]) => `<span style="${pos(i)}">${isToday && i === 0 ? 'nu' : hourLabel(h.time)}</span>`).join('');
  const hits = hours.map((h, i) => `<button class="wxh__hit" style="left:${((i / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%" data-action="wx-hour" data-i="${i}" data-day="${day}" aria-label="${hourLabel(h.time)}"></button>`).join('');
  const nowX = isToday ? (((now - new Date(hours[0].time)) / 3600e3) / n) * 100 : null;

  const sumMm = hours.reduce((sum, h) => sum + h.mm, 0);
  const title = isToday ? 'Komende 24 uur' : `${cap(F.weekday.format(fromIso(day)))} ${clean(F.dm.format(fromIso(day)))}`;
  const meta = s
    ? `<span class="wxh__pick"><b>${hourLabel(s.time)}</b>${num(s.temp)}°, voelt ${num(s.feels)}°, ${s.precip}% kans${s.mm >= 0.1 ? ` (${mmText(s.mm)} mm)` : ''}, wind ${s.wind} km/u ${windDir(s.windDir)}</span>`
    : `<span>${num(Math.min(...hours.map((h) => h.temp)))}° tot ${num(Math.max(...hours.map((h) => h.temp)))}°, ${sumMm >= 0.1 ? `${mmText(sumMm)} mm regen` : 'droog'}, stoten tot ${Math.max(...hours.map((h) => h.gusts))} km/u</span>`;
  return (
    cardHead(title, meta, 'i-clock', 'sky') +
    `<div class="wxh">` +
    `<div class="wxh__icons">${icons}</div>` +
    `<div class="wxh__plot"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><linearGradient id="wxh-fill" x1="0" y1="0" x2="0" y2="1"><stop class="wxh__s1" offset="0"/><stop class="wxh__s2" offset="1"/></linearGradient></defs>${nights}` +
    `<polygon class="wxh__area" fill="url(#wxh-fill)" points="0,100 0,${first} ${t0} 1000,${last} 1000,100"/>` +
    `<polyline class="wxh__feels" points="${line('feels')}" vector-effect="non-scaling-stroke"/>` +
    `<polyline class="wxh__line" points="0,${first} ${t0} 1000,${last}" vector-effect="non-scaling-stroke"/></svg>` +
    temps +
    (nowX !== null ? `<span class="wxh__now" style="left:${nowX.toFixed(2)}%"></span>` : '') +
    `</div>` +
    `<div class="wxh__rain">${rain}</div>` +
    `<div class="wxh__wind">${winds}</div>` +
    `<div class="wxh__time">${times}</div>` +
    (s ? `<span class="wxh__sel" style="left:${((sel / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%"></span>` : '') +
    hits +
    `</div>` +
    `<p class="wxh__legend"><span class="wxh__key wxh__key--temp"></span>temperatuur<span class="wxh__key wxh__key--feels"></span>voelt als<span class="wxh__key wxh__key--rain"></span>kans op regen<span class="wxh__key wxh__key--night"></span>nacht</p>`
  );
}

function wxWeekHtml(w, selDay, now) {
  const days = w.days.slice(0, 7);
  const lo = Math.min(...days.map((d) => d.min));
  const hi = Math.max(...days.map((d) => d.max));
  const span = Math.max(hi - lo, 1);
  const at = (t) => (((t - lo) / span) * 100).toFixed(1);
  const today = iso(now);
  const rows = days
    .map((d) => {
      const n = diffDays(today, d.date);
      const name = n === 0 ? 'Vandaag' : n === 1 ? 'Morgen' : cap(clean(F.wd.format(fromIso(d.date))));
      const dot = n === 0 ? `<i style="left:${at(Math.min(hi, Math.max(lo, w.current.temp)))}%"></i>` : '';
      return (
        `<button class="wxd${d.date === selDay ? ' is-sel' : ''}" data-action="wx-day" data-date="${d.date}" aria-pressed="${d.date === selDay}">` +
        `<span class="wxd__name">${name}<small>${n > 1 ? shortDate(d.date) : ''}</small></span>${wxIcon(d.icon, true)}` +
        `<span class="wxd__rain">${d.precip >= 20 ? `${icon('i-drop')}${d.precip}%` : ''}</span>` +
        `<span class="wxd__lo">${num(d.min)}°</span>` +
        `<span class="wxd__bar"><span style="left:${at(d.min)}%;right:${(100 - at(d.max)).toFixed(1)}%;--c1:var(--${tempHue(d.min)});--c2:var(--${tempHue(d.max)})"></span>${dot}</span>` +
        `<span class="wxd__hi">${num(d.max)}°</span></button>`
      );
    })
    .join('');
  return cardHead('Komende dagen', `<span>${num(lo)}° tot ${num(hi)}°</span>`, 'i-calendar', 'sky') + `<div class="wxd-list">${rows}</div>`;
}

function renderWeather(d, q) {
  loadWx();
  const w = state.wx.data;
  const now = new Date();
  const today = iso(now);
  const day = isIsoDay(q.get('dag')) && w?.days.some((x) => x.date === q.get('dag')) ? q.get('dag') : today;
  const hero = $('#wx-hero');
  if (!w) {
    paint($('#wx-meta'), '');
    const msg = Date.now() - state.wx.failedAt < 60_000 ? notice('Het weer is even niet bereikbaar. Ik probeer het zo opnieuw.') : '<div class="skel"><span></span><span></span><span></span></div>';
    for (const id of ['#wx-hero', '#wx-rain', '#wx-hours', '#wx-week']) paint($(id), msg);
    paint($('#wx-tiles'), '');
    return;
  }
  paint($('#wx-meta'), `<span>Open-Meteo, ${w.days.length} dagen vooruit</span>`);
  hero.dataset.sky = skyOf(w.current.icon);
  hero.dataset.day = w.current.isDay ? '1' : '0';
  paint(hero, wxHeroHtml(w, now));
  paint($('#wx-rain'), wxRainHtml(w, now));
  paint($('#wx-tiles'), wxTilesHtml(w, now));
  paint($('#wx-hours'), wxHoursHtml(w, day, now));
  paint($('#wx-week'), wxWeekHtml(w, day, now));
}

const weatherActions = {
  'wx-day'(btn) {
    state.wx.hour = null;
    go('weer', { dag: btn.dataset.date === today() ? null : btn.dataset.date });
  },
  'wx-hour'(btn) {
    const i = Number(btn.dataset.i);
    const same = state.wx.hourDay === btn.dataset.day && state.wx.hour === i;
    state.wx.hour = same ? null : i;
    state.wx.hourDay = btn.dataset.day;
    render();
  },
};

// ── Energie ─────────────────────────────────────────────────
// Zonnepanelen, thuisbatterij en het net (Huawei SUN2000 + LUNA2000, lokaal via Modbus TCP).
// Het overzicht krijgt één regel onder de datum; het tabblad Energie toont de stroom nu, de batterij,
// de dagtotalen, het verloop van vandaag en de voorbije dagen. Het verloop komt van /api/energy,
// pas als je kijkt, en ververst dan elke 15 s.
state.en = { data: null, at: 0, failedAt: 0, loading: false };

async function loadEn(force = false) {
  const e = state.en;
  if (e.loading || (!force && e.data && Date.now() - e.at < 12_000) || Date.now() - e.failedAt < 20_000) return;
  e.loading = true;
  try {
    const d = await api('GET', '/api/energy');
    if (d.state === 'ok' || d.state === 'stale') {
      e.data = d;
      e.at = Date.now();
    } else e.failedAt = Date.now();
  } catch {
    e.failedAt = Date.now();
  } finally {
    e.loading = false;
  }
  if (route().view === 'energie') render();
}

const enOn = (en) => en && en.state !== 'off';
const dec = (v, d = 1) => v.toFixed(d).replace('.', ',');
// Vermogen: onder 1 kW in watt, daarboven in kW met één cijfer na de komma.
const powerParts = (w) => {
  const a = Math.abs(w ?? 0);
  return a < 1000 ? [String(Math.round(a)), 'W'] : [dec(a / 1000, a < 10_000 ? 1 : 0), 'kW'];
};
const powerHtml = (w) => {
  const [v, u] = powerParts(w);
  return `${v}<small>${u}</small>`;
};
const powerText = (w) => powerParts(w).join(' ');
const kwhText = (v) => (Number.isFinite(v) ? `${dec(v, v >= 100 ? 0 : 1)} kWh` : '–');
const IDLE_W = 30; // minder dan dit is "stil"

function renderOvEnergy(en) {
  const el = $('#ov-energy');
  const on = en?.state === 'ok' || en?.state === 'stale';
  el.hidden = !on;
  if (!on) return paint(el, '');
  const n = en.now;
  const parts = [`<span data-k="pv">${icon('i-panel')}${powerText(n.pv)}</span>`];
  if (n.battery) parts.push(`<span data-k="bat">${icon('i-battery')}${Math.round(n.battery.soc)}%${Math.abs(n.battery.power) >= IDLE_W ? (n.battery.power > 0 ? ' ↑' : ' ↓') : ''}</span>`);
  if (Number.isFinite(n.grid)) parts.push(`<span data-k="grid">${icon('i-pylon')}${Math.abs(n.grid) < IDLE_W ? '0 W' : `${n.grid > 0 ? '' : '−'}${powerText(n.grid)}`}</span>`);
  paint(el, parts.join(''));
}

// Stroom nu: de zon boven, het net links, het huis rechts, de batterij onder, de omvormer in het midden.
// Een pijltje op elke verbinding wijst waar de stroom heen gaat (geen animatie: de Pi Zero zegt dank).
function enFlowHtml(en) {
  const n = en.now;
  const arm = (pos, w, dirIn, dirOut, kind) => {
    const on = Number.isFinite(w) && Math.abs(w) >= IDLE_W;
    const rot = { r: 0, d: 90, l: 180, u: 270 }[w > 0 ? dirIn : dirOut];
    return `<span class="farm farm--${pos}${on ? ` is-on` : ''}" data-k="${kind}">${on ? `<svg class="i" style="transform:rotate(${rot}deg)" aria-hidden="true"><use href="#i-chev-right"/></svg>` : ''}</span>`;
  };
  const node = (pos, kind, ic, value, label, sub = '') =>
    `<div class="fnode fnode--${pos}" data-k="${kind}"><span class="fnode__ic">${icon(ic)}</span><span class="fnode__text"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</span></div>`;
  const grid = n.grid;
  const gridLabel = !Number.isFinite(grid) ? 'Net' : Math.abs(grid) < IDLE_W ? 'Net, stil' : grid > 0 ? 'Afname' : 'Injectie';
  const b = n.battery;
  const batLabel = !b ? '' : Math.abs(b.power) < IDLE_W ? 'Batterij, rust' : b.power > 0 ? `Laadt ${powerText(b.power)}` : `Levert ${powerText(b.power)}`;
  const inv = n.inverter;
  return (
    cardHead('Nu', `<span class="en-inv" data-kind="${inv.kind}">${esc(inv.label)}</span>`, 'i-bolt', 'honey') +
    `<div class="flow${b ? '' : ' flow--nobat'}">` +
    node('pv', 'pv', 'i-panel', powerHtml(n.pv), 'Zon') +
    arm('pv', n.pv, 'd', 'u', 'pv') +
    (Number.isFinite(grid) ? node('grid', 'grid', 'i-pylon', powerHtml(grid), gridLabel) + arm('grid', grid, 'r', 'l', 'grid') : '<span class="fnode fnode--grid"></span><span class="farm farm--grid"></span>') +
    `<span class="fhub" data-kind="${inv.kind}" title="Omvormer"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12.5" class="mark-ring"/><path d="M16 3.5a12.5 12.5 0 0 1 12.5 12.5" class="mark-arc"/><circle cx="16" cy="16" r="2.6" class="mark-dot"/></svg></span>` +
    (Number.isFinite(n.load) ? arm('home', n.load, 'r', 'l', 'home') + node('home', 'home', 'i-home', powerHtml(n.load), 'Huis') : '<span class="farm farm--home"></span><span class="fnode fnode--home"></span>') +
    (b ? arm('bat', b.power, 'd', 'u', 'bat') + node('bat', 'bat', 'i-battery', `${Math.round(b.soc)}<small>%</small>`, batLabel) : '') +
    `</div>`
  );
}

function enBatteryHtml(en) {
  const b = en.now.battery;
  if (!b) return cardHead('Batterij', '', 'i-battery', 'honey') + '<p class="empty">Geen thuisbatterij gevonden.</p>';
  const t = en.today;
  const soc = Math.max(0, Math.min(100, b.soc));
  let line = 'In rust';
  if (b.power >= IDLE_W) line = `Laadt met ${powerText(b.power)}`;
  else if (b.power <= -IDLE_W) line = `Levert ${powerText(b.power)}`;
  let eta = '';
  if (b.eta) {
    const at = new Date(b.eta.at);
    const day = iso(at) === today() ? '' : iso(at) === addDays(today(), 1) ? 'morgen ' : `${clean(F.wd.format(at))} `;
    eta = `${b.eta.kind === 'full' ? 'Vol' : 'Leeg'} rond ${day}${F.time.format(at)}`;
  } else if (soc >= 99) eta = 'Helemaal vol';
  return (
    cardHead('Batterij', b.capacityKwh ? `${dec(b.capacityKwh)} kWh` : '', 'i-battery', 'honey') +
    `<div class="enb"><div class="enb__gauge${soc <= 15 ? ' is-low' : ''}" role="img" aria-label="Batterij ${Math.round(soc)} procent"><span style="height:${soc.toFixed(1)}%"></span></div>` +
    `<div class="enb__main"><span class="enb__soc">${Math.round(soc)}<small>%</small></span><b>${line}</b>${eta ? `<span>${eta}</span>` : ''}</div></div>` +
    `<div class="enb__rows"><div><span>Vandaag geladen</span><b>${kwhText(t.charge)}</b></div><div><span>Vandaag geleverd</span><b>${kwhText(t.discharge)}</b></div></div>`
  );
}

function enTodayHtml(en) {
  const t = en.today;
  const bar = (label, pct, help) =>
    Number.isFinite(pct)
      ? `<div class="enr"><div class="enr__top"><span>${label}</span><b>${pct}%</b></div><span class="enr__bar"><i style="width:${pct}%"></i></span><small>${help}</small></div>`
      : '';
  const row = (k, label, v) => `<div class="ent__row" data-k="${k}"><i></i><span>${label}</span><b>${kwhText(v)}</b></div>`;
  return (
    cardHead('Vandaag', t.partial && t.since ? `net sinds ${F.time.format(new Date(t.since))}` : '', 'i-sun', 'honey') +
    `<div class="ent__big"><span class="ent__num">${dec(t.pv)}<small>kWh</small></span><span>opgewekt door de zon</span></div>` +
    `<div class="ent__rows">${Number.isFinite(t.load) ? row('home', 'Verbruik huis', t.load) : ''}${Number.isFinite(t.import) ? row('grid', t.partial ? 'Afgenomen (sinds start)' : 'Afgenomen van het net', t.import) : ''}${Number.isFinite(t.export) ? row('export', t.partial ? 'Teruggeleverd (sinds start)' : 'Teruggeleverd', t.export) : ''}</div>` +
    (t.partial ? `<p class="ent__note">Lumen houdt de meter vandaag pas ${t.since ? `sinds ${F.time.format(new Date(t.since))}` : 'sinds de start'} bij. Vanaf morgen zie je hier je verbruik en hoeveel je zelf opwekt.</p>` : '') +
    `<div class="ent__bars">${bar('Zelfvoorzienend', t.autarky, 'van je verbruik kwam niet van het net')}${bar('Eigen verbruik', t.selfUse, 'van je zonnestroom bleef in huis')}</div>`
  );
}

// Verloop van vandaag (00:00 tot 24:00): zon als vlak, huis als lijn, batterij in % als dunne lijn.
function enChartHtml(en, now) {
  const h = en.history ?? [];
  const slot = en.slotMinutes ?? 5;
  const hasLoad = h.some((p) => Number.isFinite(p.load));
  const hasSoc = h.some((p) => Number.isFinite(p.soc));
  const peak = Math.max(500, ...h.map((p) => Math.max(p.pv ?? 0, p.load ?? 0)));
  const top = Math.ceil(peak / 500) * 500;
  const X = (m) => ((m + slot / 2) / 1440) * 1000;
  const Y = (w) => 100 - (Math.max(0, w) / top) * 92;
  const Ys = (s) => 100 - (s / 100) * 92;
  // Een gat in de metingen (server even uit) onderbreekt de lijn in plaats van er een rechte over te trekken.
  const segments = (key) => {
    const out = [];
    let cur = [];
    let prev = null;
    for (const p of h) {
      if (!Number.isFinite(p[key]) || (prev && p.m - prev.m > slot * 2)) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (Number.isFinite(p[key])) cur.push(p);
      prev = p;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const pts = (seg, key, f) => seg.map((p) => `${X(p.m).toFixed(1)},${f(p[key]).toFixed(1)}`).join(' ');
  let svg = '';
  for (const seg of segments('pv')) {
    if (seg.length < 2) continue;
    svg += `<polygon class="enc__pv" points="${X(seg[0].m).toFixed(1)},100 ${pts(seg, 'pv', Y)} ${X(seg.at(-1).m).toFixed(1)},100"/>`;
    svg += `<polyline class="enc__pvline" points="${pts(seg, 'pv', Y)}"/>`;
  }
  if (hasLoad) for (const seg of segments('load')) if (seg.length > 1) svg += `<polyline class="enc__load" points="${pts(seg, 'load', Y)}"/>`;
  if (hasSoc) for (const seg of segments('soc')) if (seg.length > 1) svg += `<polyline class="enc__soc" points="${pts(seg, 'soc', Ys)}"/>`;
  const nowX = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map((hr) => `<span style="left:${((hr * 60) / 1440) * 100}%">${pad(hr)}u</span>`).join('');
  const legend =
    `<span class="enc__key" data-k="pv">Zon</span>` + (hasLoad ? `<span class="enc__key" data-k="home">Huis</span>` : '') + (hasSoc ? `<span class="enc__key" data-k="soc">Batterij %</span>` : '');
  return (
    cardHead('Verloop vandaag', legend, 'i-clock', 'honey') +
    `<div class="enc"><div class="enc__plot"><span class="enc__max">${powerText(top)}</span>` +
    `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><line class="enc__grid" x1="0" x2="1000" y1="54" y2="54"/><line class="enc__grid" x1="0" x2="1000" y1="8" y2="8"/>${svg}</svg>` +
    `<i class="enc__now" style="left:${nowX.toFixed(2)}%"></i></div><div class="enc__hours">${hours}</div></div>`
  );
}

function enWeekHtml(en, now) {
  const t = en.today;
  const days = [...(en.days ?? []).filter((d) => d.date < today()).slice(-6), { ...t, date: today() }];
  const max = Math.max(1, ...days.map((d) => Math.max(d.pv ?? 0, d.load ?? 0)));
  const cols = days
    .map((d) => {
      const isToday = d.date === today();
      const label = isToday ? 'nu' : clean(F.wd.format(fromIso(d.date))).slice(0, 2);
      const hPv = ((d.pv ?? 0) / max) * 100;
      const hLoad = Number.isFinite(d.load) ? (d.load / max) * 100 : null;
      return (
        `<div class="enw__day${isToday ? ' is-today' : ''}" title="${esc(shortDate(d.date))}: ${kwhText(d.pv)} zon${Number.isFinite(d.load) ? `, ${kwhText(d.load)} verbruik` : ''}">` +
        `<small>${dec(d.pv ?? 0)}</small><div class="enw__bars"><span data-k="pv" style="height:${hPv.toFixed(1)}%"></span>${hLoad !== null ? `<span data-k="home" style="height:${hLoad.toFixed(1)}%"></span>` : ''}</div><span>${label}</span></div>`
      );
    })
    .join('');
  // Nog geen week geschiedenis: vandaag staat toch rechts, de lege dagen vullen zich van rechts naar links.
  const blanks = '<div class="enw__day"></div>'.repeat(Math.max(0, 7 - days.length));
  const legend = `<span class="enc__key" data-k="pv">Zon</span>${days.some((d) => Number.isFinite(d.load)) ? '<span class="enc__key" data-k="home">Verbruik</span>' : ''}`;
  return cardHead('Per dag', legend, 'i-calendar', 'honey') + `<div class="enw">${blanks}${cols}</div>`;
}

function renderEnergy(d) {
  loadEn();
  const live = state.en.data;
  const en = d.energy;
  const now = new Date();
  if (!enOn(en)) {
    for (const id of ['#en-flow', '#en-bat', '#en-today', '#en-chart', '#en-week']) paint($(id), '');
    paint($('#en-flow'), notice('Energie staat uit. Vul "energy" in config.json in (zie README).'));
    return;
  }
  // De samenvatting op het dashboard is soms nieuwer dan het laatst opgehaalde verloop: neem de verste.
  const src = live && (!en.updatedAt || live.updatedAt >= en.updatedAt) ? live : live ? { ...live, now: en.now, today: en.today, state: en.state, updatedAt: en.updatedAt } : null;
  if (!src?.now) {
    const msg = en.state === 'error' ? notice(`Geen verbinding met de omvormer: ${en.error}`) : '<div class="skel"><span></span><span></span><span></span></div>';
    for (const id of ['#en-flow', '#en-bat', '#en-today', '#en-chart', '#en-week']) paint($(id), id === '#en-flow' ? msg : '');
    paint($('#en-meta'), '');
    return;
  }
  const stale = en.state === 'stale' ? `<span class="en-stale">${icon('i-alert')}geen verbinding sinds ${F.time.format(new Date(src.updatedAt))}</span>` : `<span>bijgewerkt ${F.time.format(new Date(src.updatedAt))}</span>`;
  paint($('#en-meta'), `${demoTag(src.demo, 'Voorbeeld')}${stale}`);
  paint($('#en-flow'), enFlowHtml(src));
  paint($('#en-bat'), enBatteryHtml(src));
  paint($('#en-today'), enTodayHtml(src));
  paint($('#en-chart'), enChartHtml(src, now));
  paint($('#en-week'), enWeekHtml(src, now));
}

// ── Recept ──────────────────────────────────────────────────
// Een recept dat je vanaf je gsm stuurt, opent hier vanzelf: ingrediënten om af te vinken,
// stap voor stap in grote letters en kookwekkers die uit de stappen zelf komen.
const RC_IDLE_MS = 2 * 60 * 60_000;
const rcCurrent = () => state.data?.recipe?.current ?? null;
state.rc = { id: null, step: 0, done: new Set(), servings: null };
// Lopende wekkers overleven een herlaad van de pagina (bv. na een update van het display).
const TIMER_KEY = 'timers';
function loadTimers() {
  try {
    const list = JSON.parse(localStorage.getItem(TIMER_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.end) && t.end > Date.now() - 5 * 60_000).slice(0, 8);
  } catch {
    return [];
  }
}
function saveTimers() {
  try {
    localStorage.setItem(TIMER_KEY, JSON.stringify(state.timers.map(({ id, label, end }) => ({ id, label, end }))));
  } catch {
    /* geen opslag beschikbaar */
  }
}
state.timers = loadTimers();
state.ringing = [];
state.tw = { open: false, sec: 10 * 60, label: null };
state.recipeSeen = undefined;

function rcReset(r) {
  state.rc = { id: r?.id ?? null, step: 0, done: new Set(), servings: r?.servings ?? null };
}

// Een nieuw recept (of een recept opnieuw gestuurd) opent het display zelf.
function noticeRecipe() {
  const r = rcCurrent();
  const sent = r?.sentAt ?? null;
  if (state.recipeSeen === undefined) {
    state.recipeSeen = sent;
    if (r) rcReset(r);
    return;
  }
  if (sent === state.recipeSeen) return;
  state.recipeSeen = sent;
  if (!r) return;
  rcReset(r);
  if (morningShown) dismissMorning();
  state.lastInput = Date.now();
  state.wakeUntil = Date.now() + 2 * 60_000;
  kbHide();
  go('recept');
}

const FRACTIONS = [[0.25, '¼'], [0.5, '½'], [0.75, '¾'], [1 / 3, '⅓'], [2 / 3, '⅔']];
const UNICODE_FR = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
function readAmount(s) {
  s = s.trim();
  if (UNICODE_FR[s] !== undefined) return UNICODE_FR[s];
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\s*([½¼¾⅓⅔])$/.exec(s);
  if (m) return Number(m[1]) + UNICODE_FR[m[2]];
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  return Number(s.replace(',', '.'));
}
function writeAmount(n) {
  if (n >= 50) return String(Math.round(n / 5) * 5);
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n);
  const rest = n - whole;
  if (rest < 0.06) return String(whole);
  if (rest > 0.94) return String(whole + 1);
  const fr = FRACTIONS.find(([v]) => Math.abs(rest - v) < 0.06);
  if (fr) return whole ? `${whole}${fr[1]}` : fr[1];
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
}
const AMOUNT = /^(\d+\s+\d+\/\d+|\d+\s*[½¼¾⅓⅔]|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])(\s*(?:-|–|à|tot)\s*)?(\d+(?:[.,]\d+)?)?/;
function scaleIngredient(text, f) {
  if (!f || Math.abs(f - 1) < 0.001) return text;
  const m = AMOUNT.exec(text);
  if (!m) return text;
  const a = writeAmount(readAmount(m[1]) * f);
  const b = m[3] ? `${m[2]}${writeAmount(readAmount(m[3]) * f)}` : m[2] ?? '';
  return `${a}${b}${text.slice(m[0].length)}`;
}

// "15 minuten", "10 à 12 min", "1 uur", "30 seconden" → wekkers voor die stap.
const DURATION = /(\d+(?:[.,]\d+)?)(?:\s*(?:à|a|tot|of|-|–|to)\s*\d+(?:[.,]\d+)?)?\s*(minuten|minuut|minutes?|mins?\b|min\b|uren|uur|hours?|hrs?\b|u\b|seconden|seconds?|sec\b)/gi;
function stepTimers(text) {
  const out = [];
  for (const [, n, unit] of text.matchAll(DURATION)) {
    const v = Number(n.replace(',', '.'));
    const u = unit.toLowerCase();
    const sec = /^(sec|seconde)/.test(u) ? v : /^(u|uur|uren|hour|hr)/.test(u) ? v * 3600 : v * 60;
    if (sec >= 10 && sec <= 12 * 3600 && !out.includes(sec)) out.push(Math.round(sec));
    if (out.length === 3) break;
  }
  return out;
}
const secText = (s) => (s < 60 ? `${s} sec` : durText(Math.round(s / 60)));
const clockText = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

function rcMetaHtml(r) {
  const bits = [];
  if (r.totalMinutes) bits.push(`<span>${icon('i-clock')}${durText(r.totalMinutes)}</span>`);
  bits.push(`<span>${esc(r.source)}</span>`);
  return bits.join('');
}

function rcIngredientsHtml(r) {
  const f = r.servings && state.rc.servings ? state.rc.servings / r.servings : 1;
  const stepper = r.servings
    ? `<div class="rc-serv"><button class="icon-btn rc-serv__btn" data-action="rc-serv" data-step="-1" aria-label="Minder personen"${state.rc.servings <= 1 ? ' disabled' : ''}>${icon('i-minus')}</button>` +
      `<span><b>${state.rc.servings}</b> ${state.rc.servings === 1 ? 'persoon' : 'personen'}</span>` +
      `<button class="icon-btn rc-serv__btn" data-action="rc-serv" data-step="1" aria-label="Meer personen"${state.rc.servings >= 40 ? ' disabled' : ''}>${icon('i-plus')}</button></div>`
    : r.yieldText
      ? `<div class="rc-serv"><span>${esc(r.yieldText)}</span></div>`
      : '';
  const left = r.ingredients.length - state.rc.done.size;
  const rows = r.ingredients
    .map((ing, i) => {
      const on = state.rc.done.has(i);
      return (
        `<li><button class="rc-ing${on ? ' is-done' : ''}" role="checkbox" aria-checked="${on}" data-action="rc-ing" data-i="${i}">` +
        `<span class="check__ring">${on ? icon('i-check') : ''}</span><span class="rc-ing__text">${esc(scaleIngredient(ing, f))}</span></button></li>`
      );
    })
    .join('');
  return (
    (r.image ? `<img class="rc-img" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" decoding="async" loading="lazy" onerror="this.remove()">` : '') +
    `<h2 class="rc-title">${esc(r.title)}</h2>` +
    `<div class="rc-meta">${rcMetaHtml(r)}</div>` +
    stepper +
    `<div class="card__head rc-ing-head"><h3 class="card__title">Ingrediënten</h3><span class="card__meta">${r.ingredients.length ? (left ? `nog ${left}` : 'alles klaar') : ''}</span></div>` +
    `<div class="card__body"><ul class="rc-ings">${rows || '<li class="rc-empty">Deze site gaf geen ingrediënten mee.</li>'}</ul></div>`
  );
}

function rcStepHtml(r) {
  const steps = r.steps;
  if (!steps.length) {
    return `<div class="rc-step__none"><p>Deze site gaf geen bereiding mee.</p><p class="rc-step__src">Bron: ${esc(r.source)}</p></div>`;
  }
  const i = Math.min(state.rc.step, steps.length - 1);
  const s = steps[i];
  const timers = stepTimers(s.text)
    .map((sec) => {
      const label = secText(sec);
      return `<button class="btn rc-timer-btn" data-action="rc-timer" data-sec="${sec}" data-label="${esc(`${label}, stap ${i + 1}`)}">${icon('i-hourglass')}Wekker ${label}</button>`;
    })
    .join('');
  const dots = steps
    .map((_, n) => `<button class="rc-dot${n === i ? ' is-on' : n < i ? ' is-past' : ''}" data-action="rc-go" data-i="${n}" aria-label="Stap ${n + 1}"${n === i ? ' aria-current="step"' : ''}>${n + 1}</button>`)
    .join('');
  const next = steps[i + 1];
  return (
    `<div class="rc-step__head"><span class="label">Stap ${i + 1} van ${steps.length}</span>${s.section ? `<span class="rc-step__section">${esc(s.section)}</span>` : ''}</div>` +
    `<div class="rc-step__body" id="rc-swipe"><p class="rc-step__text">${esc(s.text)}</p>${timers ? `<div class="rc-step__timers">${timers}</div>` : ''}</div>` +
    (next ? `<p class="rc-step__next"><span>Daarna</span>${esc(next.text)}</p>` : `<p class="rc-step__next"><span>Laatste stap</span>Smakelijk!</p>`) +
    `<div class="rc-dots">${dots}</div>` +
    `<div class="rc-nav"><button class="btn rc-nav__btn" data-action="rc-step" data-step="-1"${i === 0 ? ' disabled' : ''}>${icon('i-chev-left')}Vorige</button>` +
    `<button class="btn btn--primary rc-nav__btn" data-action="rc-step" data-step="1"${i === steps.length - 1 ? ' disabled' : ''}>Volgende${icon('i-chev-right')}</button></div>`
  );
}

function rcRecentHtml(recent, current) {
  const rows = recent
    .map(
      (r) =>
        `<li class="rc-recent__row${current?.id === r.id ? ' is-current' : ''}"><button class="rc-recent__open" data-action="rc-open" data-id="${esc(r.id)}">` +
        `<span class="rc-recent__title">${esc(r.title)}</span><span class="rc-recent__meta">${esc(r.source)}${r.totalMinutes ? `<span>${durText(r.totalMinutes)}</span>` : ''}</span></button>` +
        `<button class="icon-btn" data-action="rc-forget" data-id="${esc(r.id)}" aria-label="Verwijder ${esc(r.title)}">${icon('i-x')}</button></li>`,
    )
    .join('');
  return (
    cardHead('Recent gestuurd', recent.length ? `<span>${recent.length}</span>` : '') +
    `<div class="card__body">${rows ? `<ul class="rc-recent">${rows}</ul>` : '<p class="rc-empty">Nog niets gestuurd. Wat je stuurt, blijft hier staan om later opnieuw te openen.</p>'}</div>`
  );
}

const RC_HOWTO =
  `<div class="rc-howto">${icon('i-pot', 'i rc-howto__icon')}<h2>Stuur een recept naar het display</h2>` +
  `<ol><li><b>iPhone:</b> tik op een receptpagina op <i>Deel</i> en kies <i>Stuur naar display</i>.</li>` +
  `<li><b>Taken-app:</b> tik bovenaan op het pannetje en plak de link.</li>` +
  `<li>Het recept opent hier vanzelf, met de stappen in grote letters en wekkers erbij.</li></ol>` +
  `<p>Werkt met de meeste receptensites, zoals Dagelijkse Kost, 24Kitchen en Leukerecepten.</p></div>`;

function renderRecipe(d, q) {
  const r = d.recipe?.current ?? null;
  if (r && state.rc.id !== r.id) rcReset(r);
  const list = !r || q.get('lijst') === '1';
  $('#recept').classList.toggle('is-list', list);
  paint(
    $('#recept-controls'),
    `<button class="btn btn--sm rc-tw-btn" data-action="tw-open">${icon('i-hourglass')}Kookwekker</button>` +
      (r
        ? (list
            ? `<button class="btn btn--sm" data-action="rc-back">${icon('i-chev-left')}Terug naar ${esc(r.title.length > 28 ? `${r.title.slice(0, 26)}…` : r.title)}</button>`
            : `<button class="btn btn--sm btn--ghost" data-action="rc-list">Recent</button>`) +
          `<button class="btn btn--sm btn--ghost" data-action="rc-close">${icon('i-x')}Sluiten</button>`
        : ''),
  );
  if (list) {
    paint($('#rc-side'), RC_HOWTO);
    paint($('#rc-main'), rcRecentHtml(d.recipe?.recent ?? [], r));
  } else {
    if (state.rc.step >= r.steps.length) state.rc.step = Math.max(0, r.steps.length - 1);
    paint($('#rc-side'), rcIngredientsHtml(r));
    paint($('#rc-main'), rcStepHtml(r));
  }
  renderTimers();
}

// ── Kookwekkers ──
let audio = null;
function beep() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    for (const [at, f] of [[0, 880], [0.22, 880], [0.44, 1175]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.35, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 0.2);
    }
  } catch {}
}

function startTimer(sec, label) {
  // Het geluid mag pas na een aanraking: dit is het moment om het klaar te zetten.
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {}
  state.timers.push({ id: Math.random().toString(36).slice(2, 8), label, end: Date.now() + sec * 1000 });
  saveTimers();
  toast(`Wekker gezet: ${label}`);
  renderTimers();
}

// Snelkeuzes voor de losse kookwekker: [naam, minuten].
const TW_PRESETS = [['Eitje zacht', 6], ['Eitje hard', 9], ['Pasta', 10], ['Rijst', 15], ['Aardappelen', 20], ['Oven', 30]];
const TW_MAX = 6 * 3600;

// Het venster van de kookwekker: tijd kiezen bovenaan, lopende wekkers eronder.
// Het aftellen zelf schrijft timerLeft() elke seconde in de [data-left]-velden,
// zodat de knoppen niet elke seconde opnieuw getekend worden.
function renderTimerSheet() {
  const el = $('#tsheet');
  el.hidden = !state.tw.open;
  if (!state.tw.open) return;
  const { sec, label } = state.tw;
  const adj = (d, text, aria) => `<button class="btn tw__adj" data-action="tw-add" data-sec="${d}" aria-label="${aria}"${(d < 0 && sec <= 0) || (d > 0 && sec >= TW_MAX) ? ' disabled' : ''}>${text}</button>`;
  const presets = TW_PRESETS.map(
    ([name, min]) =>
      `<button class="tw__preset" data-action="tw-preset" data-name="${esc(name)}" data-min="${min}" aria-pressed="${label === name && sec === min * 60}"><b>${esc(name)}</b><span>${min} min</span></button>`,
  ).join('');
  const running = state.timers
    .map(
      (t) =>
        `<li class="tw__run"><b class="tw__left" data-left="${t.id}"></b><span class="tw__label">${esc(t.label)}</span>` +
        `<button class="btn btn--sm" data-action="tw-more" data-id="${t.id}">+1 min</button>` +
        `<button class="btn btn--sm btn--ghost" data-action="rc-timer-stop" data-id="${t.id}">${icon('i-x')}Stop</button></li>`,
    )
    .join('');
  paint(
    el,
    `<div class="tw" role="dialog" aria-modal="true" aria-labelledby="tw-title">` +
      `<div class="tw__head"><h2 id="tw-title">Kookwekker</h2><button class="icon-btn" data-action="tw-close" aria-label="Sluiten">${icon('i-x')}</button></div>` +
      `<div class="tw__set">${adj(-60, `${icon('i-minus')}1 min`, 'Een minuut minder')}` +
      `<div class="tw__time"><b>${clockText(sec * 1000)}</b><span>${esc(label ?? (sec ? 'eigen tijd' : 'kies een tijd'))}</span></div>` +
      `${adj(60, `${icon('i-plus')}1 min`, 'Een minuut meer')}</div>` +
      `<div class="tw__more">${adj(30, '+30 sec', 'Dertig seconden meer')}${adj(300, '+5 min', 'Vijf minuten meer')}${adj(600, '+10 min', 'Tien minuten meer')}` +
      `<button class="btn btn--ghost tw__adj" data-action="tw-clear"${sec ? '' : ' disabled'}>Wissen</button></div>` +
      `<div class="tw__presets">${presets}</div>` +
      `<button class="btn btn--primary tw__start" data-action="tw-start"${sec ? '' : ' disabled'}>${icon('i-hourglass')}${sec ? `Start ${esc(label ? `${label.toLowerCase()}, ` : '')}${secText(sec)}` : 'Kies eerst een tijd'}</button>` +
      (running ? `<div class="tw__running"><span class="label">Loopt nu</span><ul>${running}</ul></div>` : '') +
      `</div>`,
  );
}

function timerLeft(now) {
  for (const el of $$('[data-left]')) {
    const t = state.timers.find((x) => x.id === el.dataset.left);
    if (t) el.textContent = clockText(t.end - now);
  }
}

let ringTick = 0;
function renderTimers() {
  const now = Date.now();
  const before = state.timers.length;
  for (const t of state.timers.filter((t) => t.end <= now)) {
    state.ringing.push({ ...t, since: now });
  }
  state.timers = state.timers.filter((t) => t.end > now);
  if (state.timers.length !== before) saveTimers();
  state.ringing = state.ringing.filter((t) => now - t.since < 10 * 60_000);
  paint(
    $('#rc-timers'),
    state.timers
      .map((t) => `<button class="rc-pill" data-action="tw-open" aria-label="Wekker ${esc(t.label)}, tik om te openen"><b data-left="${t.id}"></b><span>${esc(t.label)}</span></button>`)
      .join(''),
  );
  renderTimerSheet();
  timerLeft(now);
  const alarm = $('#alarm');
  alarm.hidden = !state.ringing.length;
  if (state.ringing.length) {
    paint(
      alarm,
      `<div class="alarm__card">${icon('i-hourglass', 'i alarm__icon')}<div><span class="label">Wekker klaar</span><b>${esc(state.ringing.map((t) => t.label).join(', '))}</b></div>` +
        `<div class="alarm__btns"><button class="btn" data-action="rc-alarm-snooze">Nog 1 min</button><button class="btn btn--primary" data-action="rc-alarm-stop">Stoppen</button></div></div>`,
    );
    // Piepen tot je het stopt: elke 2 seconden de eerste minuut, daarna elke 6.
    const every = now - state.ringing[0].since < 60_000 ? 2 : 6;
    if (ringTick++ % every === 0) beep();
  } else {
    ringTick = 0;
  }
  $('.rail__btn[data-view="recept"]').classList.toggle('has-due', state.timers.length > 0 || state.ringing.length > 0);
}

const recipeActions = {
  'rc-ing'(btn) {
    const i = Number(btn.dataset.i);
    if (state.rc.done.has(i)) state.rc.done.delete(i);
    else state.rc.done.add(i);
    render();
  },
  'rc-serv'(btn) {
    state.rc.servings = Math.min(40, Math.max(1, (state.rc.servings ?? 1) + Number(btn.dataset.step)));
    render();
  },
  'rc-step'(btn) {
    const r = rcCurrent();
    if (!r) return;
    state.rc.step = Math.min(r.steps.length - 1, Math.max(0, state.rc.step + Number(btn.dataset.step)));
    render();
  },
  'rc-go'(btn) {
    state.rc.step = Number(btn.dataset.i);
    render();
  },
  'rc-timer'(btn) {
    startTimer(Number(btn.dataset.sec), btn.dataset.label);
  },
  'rc-timer-stop'(btn) {
    state.timers = state.timers.filter((t) => t.id !== btn.dataset.id);
    saveTimers();
    renderTimers();
  },
  'rc-alarm-stop'() {
    state.ringing = [];
    renderTimers();
  },
  'rc-alarm-snooze'() {
    const labels = state.ringing.map((t) => t.label);
    state.ringing = [];
    for (const label of labels) state.timers.push({ id: Math.random().toString(36).slice(2, 8), label, end: Date.now() + 60_000 });
    saveTimers();
    renderTimers();
  },
  'tw-open'() {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
    } catch {}
    state.tw.open = true;
    renderTimers();
  },
  'tw-close'() {
    state.tw.open = false;
    renderTimers();
  },
  'tw-add'(btn) {
    state.tw.sec = Math.min(TW_MAX, Math.max(0, state.tw.sec + Number(btn.dataset.sec)));
    if (!state.tw.sec) state.tw.label = null;
    renderTimers();
  },
  'tw-clear'() {
    state.tw.sec = 0;
    state.tw.label = null;
    renderTimers();
  },
  'tw-preset'(btn) {
    state.tw.sec = Number(btn.dataset.min) * 60;
    state.tw.label = btn.dataset.name;
    renderTimers();
  },
  'tw-start'() {
    const { sec, label } = state.tw;
    if (!sec) return;
    state.tw = { open: false, sec, label: null };
    startTimer(sec, label ?? `Wekker ${secText(sec)}`);
  },
  'tw-more'(btn) {
    const t = state.timers.find((x) => x.id === btn.dataset.id);
    if (!t) return;
    t.end += 60_000;
    saveTimers();
    renderTimers();
  },
  'rc-list'() {
    go('recept', { lijst: 1 });
  },
  'rc-back'() {
    go('recept');
  },
  async 'rc-close'() {
    await attempt(async () => {
      await api('DELETE', '/api/recipe');
      state.data.recipe.current = null;
      state.recipeSeen = null;
      go('recept');
    }, 'Sluiten lukte niet');
  },
  async 'rc-open'(btn) {
    await attempt(async () => {
      await api('POST', '/api/recipe/open', { id: btn.dataset.id });
      await load();
      go('recept');
    }, 'Openen lukte niet');
  },
  async 'rc-forget'(btn) {
    await attempt(async () => {
      await api('DELETE', `/api/recipe/${encodeURIComponent(btn.dataset.id)}`);
      await load();
    }, 'Verwijderen lukte niet');
  },
};

// Naast het venster tikken of Escape sluit de kookwekker.
$('#tsheet').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) recipeActions['tw-close']();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.tw.open) recipeActions['tw-close']();
});

// Vegen op de stap: naar links is volgende, naar rechts vorige.
let swipe = null;
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#rc-swipe')) swipe = { x: e.clientX, y: e.clientY };
});
document.addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) recipeActions['rc-step']({ dataset: { step: dx < 0 ? 1 : -1 } });
});

// ── Ochtend ─────────────────────────────────────────────────
// Van display.morningStart (06:00) tot display.morningEnd (11:00) staat er een
// ochtendscherm: je dag in één blik. Wegtikken = weg voor de rest van de dag.
// Het wint van het nachtscherm. Testen op een computer: ?ochtend.
const MORNING_KEY = 'morningDone';
const FORCE_MORNING = qs.has('ochtend');
// ?ochtend=07:30 doet alsof het dat uur is, om het scherm te testen.
const MO_FAKE = /^\d{1,2}:\d{2}$/.test(qs.get('ochtend') ?? '') ? qs.get('ochtend') : null;
state.morningDone = (() => {
  try {
    return localStorage.getItem(MORNING_KEY);
  } catch {
    return null;
  }
})();
const MO_AXIS = [6, 22]; // de tijdlijn loopt van 6 tot 22 uur

function isMorning(now) {
  if (!state.data || state.morningDone === iso(now)) return false;
  if (FORCE_MORNING) return true;
  if (!KIOSK) return false;
  const cfg = state.data.config.display;
  const s = clockMinutes(cfg?.morningStart);
  const e = clockMinutes(cfg?.morningEnd);
  if (s === null || e === null || s >= e) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= s && m < e;
}

function dismissMorning() {
  state.morningDone = today();
  if (!FORCE_MORNING) {
    try {
      localStorage.setItem(MORNING_KEY, state.morningDone);
    } catch {
      /* geen opslag beschikbaar */
    }
  }
  updateMorning(new Date());
}

const moEnd = (now) => {
  const end = new Date(now);
  end.setHours(MO_AXIS[1], 0, 0, 0);
  return end;
};

// Eén zin over het weer van vandaag, uit de verwachting per uur.
function moWeatherText(w, now) {
  const hours = (w?.hours ?? []).filter((h) => new Date(h.time) <= moEnd(now));
  if (!hours.length) return '';
  const first = hours.findIndex((h) => h.precip >= 50);
  if (first === -1) return hours.some((h) => h.precip >= 30) ? 'Wellicht droog, met een kleine kans op een bui.' : 'Het blijft de hele dag droog.';
  if (first === 0) {
    const dry = hours.findIndex((h, i) => i > 0 && h.precip < 30);
    return dry === -1 ? 'Grote kans op regen, de hele dag door.' : `Kans op regen, droger vanaf ${hourLabel(hours[dry].time)}.`;
  }
  return `Droog tot ${hourLabel(hours[first].time)}, daarna kans op regen.`;
}

function moTip(w, now) {
  const day = (w?.days ?? []).find((x) => x.date === iso(now));
  const hours = (w?.hours ?? []).filter((h) => new Date(h.time) <= moEnd(now));
  if (hours.some((h) => h.precip >= 50)) return 'Neem een regenjas mee.';
  if (day && day.min <= 0) return 'Het vriest: pas op voor gladheid.';
  if ((w?.current?.wind ?? 0) >= 40) return 'Er staat veel wind.';
  if (Number.isFinite(w?.current?.feels) && w.current.feels <= 4) return 'Frisjes: trek een warme jas aan.';
  return '';
}

// De dag als landschap: een lucht, heuvels, de boog van de zon tussen op- en ondergang
// (met de zon op haar echte plek) en op de grond het weer om de twee uur.
// Voor zonsopgang een sterrenhemel met een gloed waar de zon straks opkomt.
const MO_H = 82; // de horizon ligt op 82 % van de hoogte van het landschap
const MO_PEAK = 32; // zo hoog komt de zon (in % van de hoogte)
// Sterren: altijd op dezelfde plek, zodat de hemel niet verspringt als de minuut verandert.
const MO_STARS = (() => {
  let s = 11;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: 54 }, () => [rnd() * 1000, rnd() * 540, 0.7 + rnd() * 1.5, 0.2 + rnd() * 0.65]);
})();
const MO_LAND =
  `<svg class="mo__land" viewBox="0 0 1280 144" preserveAspectRatio="none" aria-hidden="true">` +
  `<path class="mo__hill-1" d="M0 44C120 18 230 14 330 30S560 34 660 16 880 4 990 22 1180 40 1280 18V144H0Z"/>` +
  `<path class="mo__hill-2" d="M0 66C150 44 290 52 420 58S640 46 780 38 1010 52 1120 58 1230 50 1280 46V144H0Z"/>` +
  `<path class="mo__hill-3" d="M0 74C210 58 420 70 640 66S1040 56 1280 68V144H0Z"/>` +
  `</svg>`;

function moSceneHtml(d, now) {
  const w = d.weather;
  const { rise, set } = sunTimes(now);
  const base = new Date(now);
  base.setHours(MO_AXIS[0], 0, 0, 0);
  const span = (MO_AXIS[1] - MO_AXIS[0]) * 3600_000;
  // De tijdlijn van 6 tot 22 uur loopt van 4 % tot 96 % van de breedte.
  const xAt = (t) => 4 + 92 * Math.min(1, Math.max(0, (t - base) / span));
  const x0 = xAt(rise);
  const x2 = xAt(set);
  const xm = (x0 + x2) / 2;
  const arc = `M${(x0 * 10).toFixed(1)},${MO_H * 10} Q${(xm * 10).toFixed(1)},${(MO_H - 2 * MO_PEAK) * 10} ${(x2 * 10).toFixed(1)},${MO_H * 10}`;
  const up = now >= rise && now < set;
  let sun = null;
  if (up) {
    const t = (now - rise) / (set - rise);
    sun = [(1 - t) ** 2 * x0 + 2 * (1 - t) * t * xm + t ** 2 * x2, MO_H - 4 * MO_PEAK * t * (1 - t)];
  }
  const glow = sun ?? [x0, MO_H];
  const nowX = sun ? sun[0] : x0;
  const stars = up
    ? ''
    : `<svg class="mo__stars" viewBox="0 0 1000 540" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${MO_STARS.map(([x, y, r, o]) => `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" opacity="${o.toFixed(2)}"/>`).join('')}</svg>`;

  // Op de grond: het weer om de twee uur, met zonsopgang en zonsondergang ertussen.
  const mins = (a, b) => durText(Math.max(1, Math.round((b - a) / 60000)));
  const marks = [];
  const sunMark = (t, ic, label, rel) =>
    marks.push({
      x: xAt(t),
      sun: true,
      html: `<span class="mo-h__w">${icon(ic)}<b>${F.time.format(t)}</b></span><span class="mo-h__t">${label}${rel ? ` · ${rel}` : ''}</span>`,
    });
  if (rise >= base) sunMark(rise, 'i-sunrise', 'zon op', now < rise ? `over ${mins(now, rise)}` : '');
  if (set <= moEnd(now)) sunMark(set, 'i-sunset', 'zon onder', up ? `nog ${mins(now, set)} licht` : '');
  const sunXs = marks.map((m) => m.x);
  for (const h of everyTwoHours(w?.hours ?? []).filter((x) => new Date(x.time) <= moEnd(now))) {
    const x = xAt(new Date(new Date(h.time).getTime() + 30 * MIN));
    if (sunXs.some((sx) => Math.abs(sx - x) < 7.5)) continue;
    marks.push({
      x,
      html: `<span class="mo-h__w">${wxIcon(h.icon, h.isDay)}<b>${h.temp}°</b></span><span class="mo-h__t">${hourLabel(h.time)}${h.precip >= 30 ? `<small>${h.precip}%</small>` : ''}</span>`,
    });
  }
  const hours = marks
    .sort((a, b) => a.x - b.x)
    .map((m) => `<div class="mo-h${m.sun ? ' mo-h--sun' : ''}" style="left:${m.x.toFixed(2)}%">${m.html}</div>`)
    .join('');

  return (
    `<div class="mo__sky" aria-hidden="true"></div>${stars}` +
    `<span class="mo__glow" style="left:${glow[0].toFixed(2)}%;top:${glow[1].toFixed(1)}%" aria-hidden="true"></span>` +
    `<svg class="mo__arc" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><clipPath id="mo-done"><rect x="0" y="0" width="${(nowX * 10).toFixed(1)}" height="1000"/></clipPath></defs>` +
    `<path d="${arc}"/>${up ? `<path class="is-done" d="${arc}" clip-path="url(#mo-done)"/>` : ''}</svg>` +
    (sun ? `<span class="mo__sun" style="left:${sun[0].toFixed(2)}%;top:${sun[1].toFixed(1)}%" aria-hidden="true"></span>` : '') +
    MO_LAND +
    `<div class="mo__hours" aria-label="Het weer vandaag, om de twee uur">${hours}</div>`
  );
}

function moAgendaHtml(d, now) {
  const t = today();
  const days = groupEvents(d.calendar.events ?? [], t, 2);
  const list = days.get(t) ?? [];
  const allDay = list.filter((e) => e.allDay);
  const all = list.filter((e) => !e.allDay);
  const timed = all.filter((e) => new Date(e.end) > now);
  let body = '';
  if (allDay.length) {
    body += `<div class="mo-allday">${allDay.map((e) => `<span class="mo-chip" data-tone="${eventTone(e)}"><i></i>${esc(e.title)}</span>`).join('')}</div>`;
  }
  if (timed.length) {
    body += timed.map((e) => eventRow(e, t, now)).join('') + `<p class="mo-more mo-fit" data-one="afspraak" data-many="afspraken" hidden></p>`;
  } else {
    const next = (days.get(addDays(t, 1)) ?? []).find((e) => !e.allDay);
    body +=
      `<div class="mo-empty"><b>${all.length ? 'Verder geen afspraken meer' : allDay.length ? 'Verder geen afspraken' : 'Een rustige dag'}</b>` +
      `<span>${next ? `Morgen om ${F.time.format(new Date(next.start))}: ${esc(next.title)}` : 'Er staat niets in je agenda.'}</span></div>`;
  }
  const past = all.length - timed.length;
  return (
    cardHead('Vandaag', all.length ? `<span>${plural(all.length, 'afspraak', 'afspraken')}${past ? `, ${past} voorbij` : ''}</span>` : '', 'i-calendar', 'apricot') +
    `<div class="card__body mo-list">${body}</div>`
  );
}

const moRow = (iconId, title, meta, { tone = '', hue = '' } = {}) =>
  `<li class="mo-row" data-tone="${tone}"${hue ? ` data-hue="${hue}"` : ''}><span class="mo-row__icon">${icon(iconId)}</span><span class="mo-row__text"><b>${esc(title)}</b><small>${esc(meta)}</small></span></li>`;

// Wat vandaag niet mag blijven liggen: taken voor vandaag (of te laat), deadlines en examens
// binnen twee dagen.
function moRemindersHtml(d, now) {
  const t = today();
  const rows = [];
  const open = (d.todos.items ?? []).filter((i) => !i.done);
  const due = sortTodos(open.filter((i) => i.due && i.due <= t));
  for (const i of due) {
    const late = diffDays(i.due, t);
    const c = catOf(i.category);
    const when = late === 0 ? 'vandaag' : late === 1 ? 'sinds gisteren' : `al ${late} dagen te laat`;
    rows.push(moRow('i-list', i.title, c ? `${c.label}, ${when}` : when, { tone: c?.tone ?? '' }));
  }
  const school = schoolItems(d.school)
    .filter((i) => isDue(i) && i.end >= now && diffDays(t, i.day) <= 2)
    .sort((a, b) => a.dt - b.dt);
  for (const i of school) rows.push(moRow('i-school', i.title, `${KIND_LABEL[i.kind]} ${countLabel(diffDays(t, i.day))}, ${schoolTimeText(i)}`, { hue: 'sky' }));
  const rest = open.length - due.length;
  let body;
  if (rows.length) {
    body = `<ul class="mo-rows">${rows.join('')}</ul><p class="mo-more mo-fit" data-one="punt" data-many="punten" hidden></p>`;
  } else {
    body = `<div class="mo-empty"><b>Niets dringends</b><span>Geen taken of deadlines voor vandaag.</span></div>`;
  }
  if (rest > 0) body += `<p class="mo-more mo-foot">${plural(rest, 'andere open taak', 'andere open taken')} op je lijst</p>`;
  return cardHead('Niet vergeten', rows.length ? `<span>${rows.length}</span>` : '', 'i-heart', 'rose') + `<div class="card__body mo-list">${body}</div>`;
}

function morningHtml(d, now) {
  const w = d.weather;
  const c = w?.current;
  const day = (w?.days ?? []).find((x) => x.date === iso(now));
  const text = c ? [moWeatherText(w, now), moTip(w, now)].filter(Boolean).join(' ') : '';
  const wx = c
    ? `<div class="mo__wx"><div class="mo__wxnow">${wxIcon(c.icon, c.isDay)}<span class="mo__temp">${c.temp}°</span></div>` +
      `<p class="mo__wxlabel"><b>${esc(c.label)}</b>${day ? `<span>↑${day.max}° ↓${day.min}°</span>` : ''}</p>` +
      (text ? `<p class="mo__wxtext">${esc(text)}</p>` : '') +
      `</div>`
    : '';
  return (
    `<section class="mo__scene" aria-label="Zon en weer vandaag">${moSceneHtml(d, now)}` +
    `<header class="mo__top"><div class="mo__hello"><p class="mo__greet">${esc(greeting(now))}</p>` +
    `<time class="mo__time">${F.time.format(now)}</time><p class="mo__date">${cap(F.long.format(now))}</p></div>${wx}</header></section>` +
    `<div class="mo__cards"><section class="card mo__card" aria-label="Vandaag">${moAgendaHtml(d, now)}</section>` +
    `<section class="card mo__card" aria-label="Niet vergeten">${moRemindersHtml(d, now)}</section></div>` +
    `<p class="mo__hint"><i class="spectrum" aria-hidden="true"></i>Tik om je dag te beginnen<i class="spectrum" aria-hidden="true"></i></p>`
  );
}

let morningShown = false;
function updateMorning(now) {
  const el = $('#morning');
  if (MO_FAKE) {
    now = new Date(now);
    now.setHours(...MO_FAKE.split(':').map(Number), 0, 0);
  }
  const show = isMorning(now);
  if (show !== morningShown) {
    morningShown = show;
    el.hidden = !show;
    if (show) kbHide();
  }
  if (show) {
    paint(el, morningHtml(state.data, now));
    fitMorning(el);
  }
}

// Wat niet in een kaart past, verdwijnt van onderen; "en nog …" zegt hoeveel.
const NARROW = matchMedia('(max-width: 47.99em), (orientation: portrait)');
function fitMorning(el) {
  for (const list of $$('.mo-list', el)) {
    // Op een smal scherm scrolt het ochtendscherm: dan alles tonen.
    if (NARROW.matches) continue;
    const rows = $$('.mo-row, .event', list);
    const fit = $('.mo-fit', list);
    const foot = $('.mo-foot', list);
    const over = () => list.scrollHeight > list.clientHeight + 1;
    for (const r of rows) r.hidden = false;
    if (fit) fit.hidden = true;
    if (foot) foot.hidden = false;
    // Eerst de voetnoot weg, dan pas punten.
    if (foot && over()) foot.hidden = true;
    let n = 0;
    while (over() && n < rows.length) {
      rows[rows.length - 1 - n].hidden = true;
      n++;
      if (fit) {
        fit.hidden = false;
        fit.textContent = `en nog ${plural(n, fit.dataset.one, fit.dataset.many)}`;
      }
    }
  }
}

// Een tik (niet pointerdown): zo valt de tik niet door op wat eronder ligt.
$('#morning').addEventListener('click', (e) => {
  e.preventDefault();
  dismissMorning();
  state.lastInput = Date.now();
  go('overzicht');
});

// ── Nacht ───────────────────────────────────────────────────
function isNight(now) {
  if (qs.has('night')) return true;
  if (isMorning(now)) return false;
  // Tijdens het koken geen nachtscherm: niet zolang er een wekker loopt of je met een recept bezig bent.
  if (state.timers.length || state.ringing.length) return false;
  if (route().view === 'recept' && rcCurrent() && Date.now() - state.lastInput < 30 * 60_000) return false;
  if (!KIOSK) return false;
  const cfg = state.data?.config.display;
  const s = clockMinutes(cfg?.nightStart);
  const e = clockMinutes(cfg?.nightEnd);
  if (s === null || e === null || s === e) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return s < e ? m >= s && m < e : m >= s || m < e;
}

// De maan van vannacht: de fase volgt uit de synodische maand (29,53 dagen) sinds een bekende nieuwe maan.
function moonPhase(date) {
  const p = (((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % 29.530588853) / 29.530588853;
  return p < 0 ? p + 1 : p;
}
function moonSvg(p) {
  const [cx, cy, r] = [24, 24, 20];
  const waxing = p < 0.5;
  const k = Math.cos(2 * Math.PI * p);
  const rx = (Math.abs(k) * r).toFixed(2);
  // Wassend licht de rechterkant op, afnemend de linkerkant; de schaduwgrens is een halve ellips.
  const outer = waxing ? 1 : 0;
  const inner = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  return (
    `<svg viewBox="0 0 48 48"><circle class="moon-dark" cx="${cx}" cy="${cy}" r="${r}"/>` +
    `<path class="moon-lit" d="M${cx} ${cy - r}A${r} ${r} 0 0 ${outer} ${cx} ${cy + r}A${rx} ${r} 0 0 ${inner} ${cx} ${cy - r}Z"/></svg>`
  );
}

function updateNight(now) {
  const el = $('#night');
  const show = isNight(now) && Date.now() > state.wakeUntil;
  el.hidden = !show;
  if (!show) return;
  paint($('#night-moon'), moonSvg(Math.round(moonPhase(now) * 60) / 60));
  $('#night-time').textContent = F.time.format(now);
  $('#night-date').textContent = cap(F.long.format(now));
  const next = (state.data?.calendar.events ?? []).find((e) => !e.allDay && new Date(e.start) > now);
  if (next) {
    const s = new Date(next.start);
    const day = diffDays(iso(now), iso(s));
    const when = day === 0 ? '' : day === 1 ? 'Morgen ' : `${cap(clean(F.wd.format(s)))} `;
    $('#night-next').textContent = `${when}${F.time.format(s)}, ${next.title}`;
  } else {
    $('#night-next').textContent = '';
  }
}

$('#night').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  state.wakeUntil = Date.now() + 2 * 60_000;
  updateNight(new Date());
});

// ── Melding met ongedaan maken ──────────────────────────────
let toastTimer;
function toast(message, undo) {
  const slot = $('#toast-slot');
  slot.innerHTML = `<div class="toast"><span>${esc(message)}</span>${undo ? '<button class="btn btn--ghost btn--sm" data-action="undo">Ongedaan maken</button>' : ''}</div>`;
  state.undo = undo ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    slot.innerHTML = '';
    state.undo = null;
  }, 6000);
}

async function attempt(fn, failMessage = 'Dat lukte niet') {
  try {
    await fn();
  } catch (err) {
    toast(`${failMessage}: ${err.message}`);
    load();
  }
}

// ── Interactie ──────────────────────────────────────────────
const actions = {
  async 'todo-toggle'(btn) {
    const item = state.data.todos.items.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    const done = !item.done;
    Object.assign(item, { done, doneAt: done ? today() : null });
    render();
    await attempt(async () => {
      await api('PATCH', `/api/todos/${item.id}`, { done });
      if (done) {
        toast('Taak afgevinkt', async () => {
          await api('PATCH', `/api/todos/${item.id}`, { done: false });
          load();
        });
      }
    });
  },
  async 'todo-delete'(btn) {
    const items = state.data.todos.items;
    const idx = items.findIndex((i) => i.id === btn.dataset.id);
    if (idx === -1) return;
    const [item] = items.splice(idx, 1);
    render();
    await attempt(async () => {
      await api('DELETE', `/api/todos/${item.id}`);
      toast('Taak verwijderd', async () => {
        await api('POST', '/api/todos/restore', item);
        load();
      });
    });
  },
  'todo-open'(btn) {
    state.ui.todoForm = { where: btn.dataset.where, category: btn.dataset.cat || cats()[0]?.id };
    render();
    requestAnimationFrame(() => $('form[data-form="todo"] input[name="title"]')?.focus());
  },
  'cal-step'(btn) {
    const { mode, start, month } = agendaState(route().q);
    const step = Number(btn.dataset.step);
    if (mode === 'week') go('agenda', { v: 'week', d: addDays(start, 7 * step) });
    else go('agenda', { v: 'maand', m: addMonths(month, step) });
  },
  'cal-today'() {
    go('agenda', { v: agendaState(route().q).mode });
  },
  'cal-day'(btn) {
    go('agenda', { v: 'week', d: btn.dataset.date });
  },
  'todo-new'() {
    state.ui.todoForm = { where: `board-${cats()[0]?.id}`, category: cats()[0]?.id };
    go('taken');
    requestAnimationFrame(() => $('form[data-form="todo"] input[name="title"]')?.focus());
  },
  'todo-close'() {
    state.ui.todoForm = null;
    render();
  },
  seg(btn) {
    const form = btn.closest('form');
    for (const b of $$(`[data-key="${btn.dataset.key}"]`, btn.parentElement)) b.setAttribute('aria-pressed', String(b === btn));
    form.dataset[btn.dataset.key] = btn.dataset.value;
    if (form.id === 'composer' && btn.dataset.key === 'cat') {
      try {
        localStorage.setItem('todoCat', btn.dataset.value);
      } catch {
        /* geen opslag beschikbaar */
      }
    }
  },
  filter(btn) {
    go('overzicht', { cat: btn.dataset.cat });
  },
  async undo() {
    const fn = state.undo;
    $('#toast-slot').innerHTML = '';
    state.undo = null;
    if (fn) await attempt(fn, 'Ongedaan maken lukte niet');
  },
};

Object.assign(actions, recipeActions, weatherActions);

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled || !actions[btn.dataset.action]) return;
  e.preventDefault();
  actions[btn.dataset.action](btn);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const submit = $('button[type="submit"]', form);

  if (form.dataset.form === 'quick') {
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    const due = form.dataset.due ? addDays(today(), Number(form.dataset.due)) : null;
    const category = form.dataset.cat;
    submit.setAttribute('aria-busy', 'true');
    await attempt(async () => {
      await api('POST', '/api/todos', { title, category, due });
      input.value = '';
      await load();
      toast(`Toegevoegd aan ${catOf(category)?.label ?? 'taken'}`);
    }, 'Taak niet opgeslagen');
    submit.removeAttribute('aria-busy');
    input.focus();
    return;
  }

  if (form.dataset.form === 'todo') {
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    const due = form.dataset.due === '' || form.dataset.due === undefined ? null : addDays(today(), Number(form.dataset.due));
    submit.setAttribute('aria-busy', 'true');
    await attempt(async () => {
      await api('POST', '/api/todos', { title, category: form.dataset.cat, due });
      state.ui.todoForm = null;
      await load();
    }, 'Taak niet opgeslagen');
    submit.removeAttribute('aria-busy');
  }

});

document.addEventListener('input', (e) => {
  if (e.target.matches('[aria-invalid="true"]')) e.target.removeAttribute('aria-invalid');
});

// Kiosk: na een tijd zonder aanraking terug naar het overzicht.
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, () => (state.lastInput = Date.now()), { capture: true, passive: true });
}
if (KIOSK) document.addEventListener('contextmenu', (e) => e.preventDefault());
setInterval(() => {
  if (!KIOSK || !state.data) return;
  const idle = (state.data.config.display.idleReturnSeconds ?? 90) * 1000;
  const r = route();
  // Met een recept open blijft het display staan (twee uur), en zolang er een wekker loopt.
  if (state.timers.length || state.ringing.length) return;
  if (r.view === 'recept' && rcCurrent() && !r.q.toString() && Date.now() - state.lastInput < RC_IDLE_MS) return;
  if (Date.now() - state.lastInput > idle && (r.view !== 'overzicht' || r.q.toString() || state.ui.todoForm)) {
    state.ui = { todoForm: null };
    go('overzicht');
  }
}, 5000);

// ── Schermtoetsenbord ───────────────────────────────────────
// Aan het display hangt geen toetsenbord: in kioskmodus verschijnt er een
// eigen toetsenbord zodra je in een tekstveld tikt. Testen op een computer: ?kb=1.
const kb = { el: $('#kb'), target: null, layer: 'abc', shift: false };
const KB_LAYERS = {
  abc: ['azertyuiop', 'qsdfghjklm', "wxcvbn'-"],
  num: ['1234567890', 'éèëïàç@/:;', '!?()&+€%'],
};
const isTextField = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'search', ''].includes(el.getAttribute('type') ?? ''));

function kbDraw() {
  const rows = KB_LAYERS[kb.layer];
  const key = (ch) => {
    const out = kb.shift && kb.layer === 'abc' ? ch.toUpperCase() : ch;
    return `<div class="kb__key" data-ch="${esc(out)}">${esc(out)}</div>`;
  };
  const special = (name, label, cls = '') => `<div class="kb__key kb__key--fn ${cls}" data-fn="${name}">${label}</div>`;
  kb.el.innerHTML =
    `<div class="kb__row">${[...rows[0]].map(key).join('')}</div>` +
    `<div class="kb__row">${[...rows[1]].map(key).join('')}</div>` +
    `<div class="kb__row">${kb.layer === 'abc' ? special('shift', icon('i-shift'), kb.shift ? 'is-on' : '') : ''}${[...rows[2]].map(key).join('')}${special('back', icon('i-back'))}</div>` +
    `<div class="kb__row">${special('layer', kb.layer === 'abc' ? '123' : 'abc')}${key(',')}<div class="kb__key kb__key--space" data-ch=" " aria-label="spatie"></div>${key('.')}` +
    `${special('hide', 'Sluiten')}${special('enter', 'Klaar', 'kb__key--go')}</div>`;
}

function kbShow(target) {
  kb.target = target;
  kb.layer = 'abc';
  kb.shift = target.value === '';
  kbDraw();
  kb.el.hidden = false;
  document.documentElement.classList.add('kb-open');
  document.documentElement.style.setProperty('--kb-h', `${kb.el.offsetHeight}px`);
  target.scrollIntoView({ block: 'center' });
}

function kbHide() {
  kb.el.hidden = true;
  kb.target = null;
  document.documentElement.classList.remove('kb-open');
}

function kbPress(keyEl) {
  const el = kb.target;
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const fn = keyEl.dataset.fn;
  if (fn === 'shift') kb.shift = !kb.shift;
  else if (fn === 'layer') kb.layer = kb.layer === 'abc' ? 'num' : 'abc';
  else if (fn === 'hide') return el.blur();
  else if (fn === 'enter') return el.form ? el.form.requestSubmit() : el.blur();
  else if (fn === 'back') {
    if (start !== end) el.setRangeText('', start, end, 'end');
    else if (start > 0) el.setRangeText('', start - 1, start, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (el.value === '') kb.shift = true;
  } else {
    const ch = keyEl.dataset.ch;
    if (el.maxLength > 0 && el.value.length - (end - start) >= el.maxLength) return;
    el.setRangeText(ch, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    kb.shift = false;
  }
  kbDraw();
}

if (KIOSK || qs.has('kb')) {
  // mousedown tegenhouden houdt de cursor in het tekstveld; pointerdown doet het eigenlijke werk.
  kb.el.addEventListener('mousedown', (e) => e.preventDefault());
  kb.el.addEventListener('pointerdown', (e) => {
    const keyEl = e.target.closest('.kb__key');
    if (keyEl) kbPress(keyEl);
  });
  document.addEventListener('focusin', (e) => {
    if (isTextField(e.target)) kbShow(e.target);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!isTextField(document.activeElement)) kbHide();
    }, 60);
  });
}

// ── Start ───────────────────────────────────────────────────
tick();
setInterval(tick, 1000);
load();
setInterval(load, 30_000);
// Op het tabblad Energie verandert het vermogen voortdurend: haal dan elke 15 s het verloop op.
setInterval(() => {
  if (route().view === 'energie' && !document.hidden) loadEn(true);
}, 15_000);

// Live koppeling: de server meldt elke wijziging, zodat een taak die je op je
// gsm toevoegt meteen op het display staat (en omgekeerd).
let liveTimer;
let build = null;
if ('EventSource' in window) {
  const live = new EventSource('/api/events');
  live.onmessage = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(load, 150);
  };
  // Na een update start de server opnieuw: de pagina merkt dat en haalt zelf de nieuwe versie op.
  live.addEventListener('hello', (e) => {
    if (build && build !== e.data) return location.reload();
    build = e.data;
    load();
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
