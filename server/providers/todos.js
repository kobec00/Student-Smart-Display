// Takenlijst, lokaal opgeslagen in data/todos.json.
import { join } from 'node:path';
import { createStore, newId, isoDate, addDays, isIsoDate } from '../util.js';
import { demoTodos } from '../demo.js';

const KEEP_DONE_DAYS = 2;

export function createTodos(dataDir, cfg) {
  const store = createStore(join(dataDir, 'todos.json'), () => ({ items: demoTodos() }));
  const validCategory = (c) => cfg.categories.some((x) => x.id === c);

  function list() {
    const cutoff = addDays(isoDate(), -KEEP_DONE_DAYS);
    const items = store.get().items.filter((t) => !t.done || (t.doneAt ?? '') >= cutoff);
    return { state: 'ok', items };
  }

  function add({ title, category, due }) {
    title = String(title ?? '').trim().slice(0, 200);
    if (!title) throw httpError(400, 'Een taak heeft een titel nodig.');
    if (!validCategory(category)) category = cfg.categories[0].id;
    const item = {
      id: newId(),
      title,
      category,
      due: isIsoDate(due) ? due : null,
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
    };
    store.update((d) => d.items.push(item));
    return item;
  }

  function patch(id, changes) {
    return store.update((d) => {
      const item = d.items.find((t) => t.id === id);
      if (!item) throw httpError(404, 'Taak niet gevonden.');
      if ('title' in changes) {
        const title = String(changes.title ?? '').trim().slice(0, 200);
        if (title) item.title = title;
      }
      if ('category' in changes && validCategory(changes.category)) item.category = changes.category;
      if ('due' in changes) item.due = isIsoDate(changes.due) ? changes.due : null;
      if ('done' in changes) {
        item.done = Boolean(changes.done);
        item.doneAt = item.done ? isoDate() : null;
      }
      return item;
    });
  }

  function remove(id) {
    return store.update((d) => {
      const i = d.items.findIndex((t) => t.id === id);
      if (i === -1) throw httpError(404, 'Taak niet gevonden.');
      return d.items.splice(i, 1)[0];
    });
  }

  function restore(item) {
    if (!item?.id || !item?.title) throw httpError(400, 'Ongeldige taak.');
    store.update((d) => {
      if (!d.items.some((t) => t.id === item.id)) d.items.push(item);
    });
    return item;
  }

  /**
   * Taken die het display zelf aanmaakt (bv. "PMD buitenzetten"). `wanted` is wat er nu hoort te staan.
   * Elke taak komt er één keer op: vink je ze af of verwijder je ze, dan komt ze niet terug.
   * Staat ze nog open wanneer ze niet meer gevraagd wordt (de ophaling is voorbij of verplaatst), dan verdwijnt ze.
   */
  function syncAuto(prefix, wanted, today = isoDate()) {
    const d = store.get();
    const seen = d.autoSeen ?? [];
    const keys = new Set(wanted.map((w) => w.key));
    const mine = (t) => typeof t.auto === 'string' && t.auto.startsWith(prefix);
    const stale = (t) => mine(t) && (t.done ? (t.doneAt ?? '') < addDays(today, -7) : !keys.has(t.auto));
    const fresh = wanted.filter((w) => !seen.includes(w.key));
    const keep = (k) => !k.startsWith(prefix) || keys.has(k) || k.slice(prefix.length) >= today;
    if (!fresh.length && !d.items.some(stale) && seen.every(keep)) return false;
    store.update((data) => {
      data.items = data.items.filter((t) => !stale(t));
      for (const w of fresh) {
        data.items.push({
          id: newId(),
          title: String(w.title).slice(0, 200),
          category: validCategory(w.category) ? w.category : cfg.categories[0].id,
          due: isIsoDate(w.due) ? w.due : null,
          done: false,
          doneAt: null,
          createdAt: new Date().toISOString(),
          auto: w.key,
        });
      }
      data.autoSeen = [...seen.filter(keep), ...fresh.map((w) => w.key)];
    });
    return true;
  }

  return { list, add, patch, remove, restore, syncAuto };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
