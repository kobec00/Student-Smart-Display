// De gsm-app bij Lumen: je takenlijst, in je broekzak.
// Ze praat met dezelfde server als het display; een wijziging staat daar binnen een seconde.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const LOCALE = 'nl-BE';
const F_WD = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const F_DM = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const today = () => iso(new Date());
const addDays = (s, n) => {
  const d = fromIso(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const diffDays = (a, b) => Math.round((fromIso(b) - fromIso(a)) / 864e5);
const isIsoDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
const dateText = (s) => F_DM.format(fromIso(s)).replace(/\./g, '');

const memory = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* privévenster: dan onthouden we het niet */
    }
  },
};

const APPS = ['taken'];
const appFromHash = () => {
  const h = location.hash.slice(1);
  return APPS.includes(h) ? h : null;
};

const state = {
  app: appFromHash() ?? (APPS.includes(memory.get('app')) ? memory.get('app') : 'taken'),
  items: [],
  cats: [],
  loaded: false,
  online: true,
  filter: memory.get('taken.filter'),
  showDone: false,
  add: { cat: memory.get('taken.cat'), due: '' },
  edit: null,
  undo: null,
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
    const todos = await api('GET', '/api/todos');
    state.items = todos.items ?? [];
    state.cats = todos.categories ?? [];
    state.loaded = true;
    state.online = true;
  } catch {
    state.online = false;
  }
  render();
}

const catOf = (id) => state.cats.find((c) => c.id === id);
const addCat = () => (catOf(state.filter) ?? catOf(state.add.cat) ?? state.cats[0])?.id ?? '';

// ── Tekenen ─────────────────────────────────────────────────
function dueInfo(due, t) {
  if (!due) return { text: '', cls: '' };
  const n = diffDays(t, due);
  if (n < -1) return { text: `${-n} dagen te laat`, cls: 'is-late' };
  if (n === -1) return { text: 'gisteren', cls: 'is-late' };
  if (n === 0) return { text: 'vandaag', cls: 'is-today' };
  if (n === 1) return { text: 'morgen', cls: '' };
  if (n < 7) return { text: F_WD.format(fromIso(due)), cls: '' };
  return { text: dateText(due), cls: '' };
}

function taskItem(item, t) {
  const cat = catOf(item.category);
  const due = dueInfo(item.due, t);
  return (
    `<div class="task${item.done ? ' is-done' : ''}" data-tone="${cat?.tone ?? ''}">` +
    `<button class="check" role="checkbox" aria-checked="${item.done}" data-act="toggle" data-id="${esc(item.id)}" aria-label="${esc(item.title)}">` +
    `<span class="check__ring">${icon('i-check')}</span></button>` +
    `<button class="task__body" data-act="edit" data-id="${esc(item.id)}" aria-label="${esc(item.title)} aanpassen">` +
    `<span class="task__title">${esc(item.title)}</span>` +
    `<span class="task__sub"><span class="task__cat">${esc(cat?.label ?? '')}</span>${due.text && !item.done ? `<span class="task__due ${due.cls}">${due.text}</span>` : ''}</span>` +
    `</button></div>`
  );
}

function render() {
  document.documentElement.dataset.app = state.app;
  const link = $('#link');
  link.className = `link${state.online ? '' : ' is-off'}`;
  link.textContent = state.online ? 'Gekoppeld' : 'Geen verbinding';
  renderTasks();
}

function renderTasks() {
  const t = today();
  const inFilter = (i) => !state.filter || i.category === state.filter;
  const open = state.items.filter((i) => !i.done);
  const shown = open.filter(inFilter);
  const done = state.items.filter((i) => i.done && inFilter(i)).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));

  const late = open.filter((i) => i.due && i.due < t).length;
  $('#sub').textContent = !state.loaded
    ? state.online
      ? 'Laden…'
      : 'Het display is niet bereikbaar'
    : open.length
      ? `${open.length} open${late ? `, ${late} te laat` : ''}`
      : 'Alles is gedaan';

  const chip = (id, label, n, tone = '') =>
    `<button class="chip" data-act="filter" data-id="${esc(id)}" data-tone="${tone}" aria-pressed="${state.filter === id}">` +
    `${tone ? '<span class="chip__dot"></span>' : ''}${esc(label)}<span class="chip__n">${n}</span></button>`;
  $('#filters').innerHTML = state.cats.length
    ? chip('', 'Alles', open.length) + state.cats.map((c) => chip(c.id, c.label, open.filter((i) => i.category === c.id).length, c.tone)).join('')
    : '';

  const byDue = (a, b) => (a.due ?? '').localeCompare(b.due ?? '') || (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  const groups = [
    ['Te laat', 'is-late', shown.filter((i) => i.due && i.due < t).sort(byDue)],
    ['Vandaag', '', shown.filter((i) => i.due === t).sort(byDue)],
    ['Binnenkort', '', shown.filter((i) => i.due && i.due > t).sort(byDue)],
    ['Zonder datum', '', shown.filter((i) => !i.due).sort(byDue)],
  ].filter(([, , list]) => list.length);

  let html = groups.map(([title, cls, list]) => `<section class="group"><h2 class="group__title ${cls}">${title}</h2>${list.map((i) => taskItem(i, t)).join('')}</section>`).join('');
  if (state.loaded && !shown.length) {
    html += `<div class="empty"><strong>${state.filter ? `Niets te doen voor ${esc(catOf(state.filter)?.label ?? '')}` : 'Niets te doen'}</strong><span>Typ hieronder een taak, dan staat ze meteen op het display.</span></div>`;
  }
  if (!state.loaded && !state.online) html += offlineHtml();
  if (done.length) {
    html +=
      `<section class="group group--done"><button class="group__toggle" data-act="done-toggle" aria-expanded="${state.showDone}">Afgevinkt<span class="chip__n">${done.length}</span>${icon('i-chev')}</button>` +
      `${state.showDone ? done.map((i) => taskItem(i, t)).join('') : ''}</section>`;
  }
  $('#list').innerHTML = html;
  renderAddOpts();
}

const offlineHtml = () =>
  `<div class="empty"><strong>Geen verbinding met het display</strong><span>Deze app werkt op hetzelfde netwerk als het display. Staat het aan?</span><button class="btn" data-act="retry">Opnieuw proberen</button></div>`;

// Keuzes voor categorie en datum: één rij knoppen, in het invoerveld onderaan en in het aanpasvenster.
function catChips(selected) {
  return state.cats
    .map((c) => `<button type="button" class="chip" data-act="cat" data-id="${esc(c.id)}" data-tone="${c.tone}" aria-pressed="${c.id === selected}"><span class="chip__dot"></span>${esc(c.label)}</button>`)
    .join('');
}
function dueChips(selected) {
  const t = today();
  const quick = [['', 'Geen datum'], [t, 'Vandaag'], [addDays(t, 1), 'Morgen']];
  const custom = selected && !quick.some(([v]) => v === selected);
  return (
    quick.map(([v, label]) => `<button type="button" class="chip" data-act="due" data-value="${v}" aria-pressed="${v === selected}">${label}</button>`).join('') +
    `<label class="chip chip--date" data-pressed="${custom}">${icon('i-calendar')}<span>${custom ? dateText(selected) : 'Datum'}</span>` +
    `<input type="date" value="${custom ? selected : ''}" aria-label="Kies een datum"></label>`
  );
}

function renderAddOpts() {
  $('#add-opts').innerHTML = `<div class="chips">${catChips(addCat())}</div><div class="chips">${dueChips(state.add.due)}</div>`;
}

function renderSheet() {
  const e = state.edit;
  $('#sheet').hidden = !e;
  document.documentElement.classList.toggle('has-sheet', Boolean(e));
  if (!e) return;
  $('#edit-cats').innerHTML = catChips(e.cat);
  $('#edit-due').innerHTML = dueChips(e.due);
}

// ── Meldingen ───────────────────────────────────────────────
let toastTimer;
function toast(message, undo) {
  const slot = $('#toast');
  slot.innerHTML = `<div class="toast"><span>${esc(message)}</span>${undo ? '<button class="toast__undo" data-act="undo">Ongedaan maken</button>' : ''}</div>`;
  state.undo = undo ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    slot.innerHTML = '';
    state.undo = null;
  }, 6000);
}

async function attempt(fn) {
  try {
    await fn();
    state.online = true;
  } catch (err) {
    toast(err instanceof TypeError ? 'Geen verbinding met het display' : err.message);
    await load();
  }
}

// ── Acties ──────────────────────────────────────────────────
const find = (id) => state.items.find((i) => i.id === id);
function switchApp(app) {
  if (!APPS.includes(app) || app === state.app) return;
  state.app = app;
  memory.set('app', app);
  history.replaceState(null, '', `#${app}`);
  window.scrollTo(0, 0);
  render();
}

// ── Recept naar het display ─────────────────────────────────
const recipeSheet = $('#recipe-sheet');
const recipeUrl = $('#recipe-url');
const recipeHint = $('#recipe-hint');
const RECIPE_HINT = recipeHint.textContent;
function recipeSheetOpen(open) {
  recipeSheet.hidden = !open;
  document.documentElement.classList.toggle('has-sheet', open || Boolean(state.edit));
  recipeHint.textContent = RECIPE_HINT;
  recipeHint.classList.remove('is-error');
  if (open) requestAnimationFrame(() => recipeUrl.focus());
}
async function sendRecipe(url) {
  const res = await api('POST', '/api/recipe', { url });
  toast(res.message);
  return res;
}

const actions = {
  'recipe-open'() {
    recipeSheetOpen(true);
  },
  'recipe-close'() {
    recipeSheetOpen(false);
  },
  app(el) {
    switchApp(el.dataset.app);
  },
  toggle(el) {
    const item = find(el.dataset.id);
    if (!item) return;
    const done = !item.done;
    Object.assign(item, { done, doneAt: done ? today() : null });
    render();
    attempt(async () => {
      await api('PATCH', `/api/todos/${item.id}`, { done });
      if (done) {
        toast('Afgevinkt', async () => {
          await api('PATCH', `/api/todos/${item.id}`, { done: false });
          load();
        });
      }
    });
  },
  edit(el) {
    const item = find(el.dataset.id);
    if (!item) return;
    state.edit = { id: item.id, cat: item.category, due: item.due ?? '' };
    $('#edit-title').value = item.title;
    renderSheet();
  },
  close() {
    state.edit = null;
    renderSheet();
  },
  delete() {
    const item = find(state.edit?.id);
    if (!item) return;
    state.items = state.items.filter((i) => i !== item);
    state.edit = null;
    renderSheet();
    render();
    attempt(async () => {
      await api('DELETE', `/api/todos/${item.id}`);
      toast('Taak verwijderd', async () => {
        await api('POST', '/api/todos/restore', item);
        load();
      });
    });
  },
  filter(el) {
    state.filter = el.dataset.id;
    memory.set('taken.filter', state.filter);
    render();
  },
  cat(el) {
    if (el.closest('#edit')) {
      state.edit.cat = el.dataset.id;
      renderSheet();
    } else {
      state.add.cat = el.dataset.id;
      memory.set('taken.cat', state.add.cat);
      // Een nieuwe taak in een andere categorie dan de filter zou meteen uit beeld verdwijnen.
      if (state.filter && state.filter !== state.add.cat) {
        state.filter = '';
        memory.set('taken.filter', '');
        render();
      } else {
        renderAddOpts();
      }
    }
  },
  due(el) {
    setDue(el, el.dataset.value);
  },
  'done-toggle'() {
    state.showDone = !state.showDone;
    render();
  },
  retry() {
    load();
  },
  async undo() {
    const fn = state.undo;
    state.undo = null;
    $('#toast').innerHTML = '';
    if (fn) await attempt(fn);
  },

};

function setDue(el, value) {
  if (el.closest('#edit')) {
    state.edit.due = value;
    renderSheet();
  } else {
    state.add.due = value;
    renderAddOpts();
  }
}

document.addEventListener('click', (e) => {
  const picker = e.target.closest('.chip--date input');
  if (picker) {
    // Op een computer opent een klik naast het kalendertje de kiezer niet vanzelf.
    try {
      picker.showPicker();
    } catch {
      /* de browser opent hem zelf */
    }
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || !actions[el.dataset.act]) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.act](el);
});
document.addEventListener('change', (e) => {
  if (e.target.matches('.chip--date input')) setDue(e.target, isIsoDay(e.target.value) ? e.target.value : '');
});
// Een tik op een keuzeknop mag het toetsenbord niet laten dichtklappen.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.add__opts button')) e.preventDefault();
});

const addForm = $('#add');
const addInput = $('#add-title');
let closeTimer;
addForm.addEventListener('focusin', () => {
  clearTimeout(closeTimer);
  addForm.classList.add('is-open');
});
addForm.addEventListener('focusout', () => {
  closeTimer = setTimeout(() => {
    if (!addForm.contains(document.activeElement) && !addInput.value.trim()) addForm.classList.remove('is-open');
  }, 250);
});
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = addInput.value.trim();
  if (!title) {
    addInput.focus();
    return;
  }
  const category = addCat();
  const due = state.add.due || null;
  addInput.value = '';
  state.add.due = '';
  renderAddOpts();
  attempt(async () => {
    const item = await api('POST', '/api/todos', { title, category, due });
    if (!find(item.id)) state.items.push(item);
    render();
    toast(`Toegevoegd aan ${catOf(item.category)?.label ?? 'je taken'}`);
  });
});

$('#recipe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = recipeUrl.value.trim();
  if (!url) return recipeUrl.focus();
  const submit = $('button[type="submit"]', e.target);
  submit.setAttribute('aria-busy', 'true');
  submit.disabled = true;
  recipeHint.classList.remove('is-error');
  recipeHint.textContent = 'Het display haalt het recept op…';
  try {
    await sendRecipe(url);
    recipeUrl.value = '';
    recipeSheetOpen(false);
  } catch (err) {
    recipeHint.textContent = err instanceof TypeError ? 'Geen verbinding met het display.' : err.message;
    recipeHint.classList.add('is-error');
  } finally {
    submit.removeAttribute('aria-busy');
    submit.disabled = false;
  }
});

// Een link via het adres (?recept=…), bv. vanuit een opdracht op de gsm: meteen doorsturen.
{
  const params = new URLSearchParams(location.search);
  const shared = params.get('recept') || params.get('url') || params.get('text');
  if (shared) {
    params.delete('recept');
    params.delete('url');
    params.delete('text');
    params.delete('title');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    sendRecipe(shared).catch((err) => toast(err instanceof TypeError ? 'Geen verbinding met het display' : err.message));
  }
}

$('#edit').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = find(state.edit?.id);
  if (!item) return;
  const changes = { title: $('#edit-title').value.trim() || item.title, category: state.edit.cat, due: state.edit.due || null };
  Object.assign(item, changes);
  state.edit = null;
  renderSheet();
  render();
  attempt(() => api('PATCH', `/api/todos/${item.id}`, changes));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!recipeSheet.hidden) recipeSheetOpen(false);
  else if (state.edit) actions.close();
});
window.addEventListener('hashchange', () => {
  const app = appFromHash();
  if (app) switchApp(app);
});

// ── Koppeling met het display ───────────────────────────────
// De server meldt elke wijziging; na een update van de app herlaadt de pagina zichzelf.
let liveTimer;
let build = null;
if ('EventSource' in window) {
  const live = new EventSource('/api/events');
  live.onmessage = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(load, 150);
  };
  live.addEventListener('hello', (e) => {
    if (build && build !== e.data) return location.reload();
    build = e.data;
    load();
  });
  live.onerror = () => {
    state.online = false;
    render();
  };
} else {
  load();
}
setInterval(load, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  document.documentElement.dataset.theme = e.matches ? 'light' : 'dark';
});
render();
