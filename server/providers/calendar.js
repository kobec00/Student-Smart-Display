// Agenda's via iCal/ICS-links (Google Agenda, iCloud, Outlook/Microsoft 365).
// Elke agenda in config.json krijgt een categorie (persoonlijk, werk, school …).
import ICAL from 'ical.js';
import { poller, isoDate, addDays } from '../util.js';
import { demoEvents } from '../demo.js';

const MAX_OCCURRENCES = 20_000;

export function createCalendar(cfg) {
  const feeds = (cfg.calendars ?? []).filter((c) => c.url);
  if (feeds.length === 0) {
    return { get: () => ({ state: 'demo', updatedAt: new Date().toISOString(), range: fetchWindow().range, events: demoEvents() }), refresh() {} };
  }

  return poller('agenda', 10 * 60_000, async () => {
    const { from, to, range } = fetchWindow();
    const results = await Promise.allSettled(feeds.map((f) => loadFeed(f, from, to)));
    const events = [];
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') events.push(...r.value);
      else {
        failed.push(feeds[i].name ?? feeds[i].category);
        console.error(`[agenda] ${feeds[i].name ?? feeds[i].url}:`, r.reason?.message);
      }
    });
    if (failed.length === feeds.length) throw new Error(`Geen agenda bereikbaar (${failed.join(', ')})`);
    events.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return { state: 'ok', updatedAt: new Date().toISOString(), range, events, failed };
  });
}

// Bereik: vanaf de eerste dag van vorige maand tot het begin van de maand over drie maanden,
// zodat je in de agenda een maand terug en twee maanden vooruit kunt bladeren.
function fetchWindow() {
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const toDate = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  return { from: fromDate, to: toDate, range: { from: isoDate(fromDate), to: isoDate(toDate) } };
}

const sortKey = (e) => (e.allDay ? `${e.start}T00:00:00.000Z~0` : `${new Date(e.start).toISOString()}~1`);

async function loadFeed(feed, from, to) {
  const url = feed.url.replace(/^webcal:\/\//i, 'https://');
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const root = new ICAL.Component(ICAL.parse(await res.text()));

  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* tijdzone al bekend */
    }
  }

  const masters = new Map();
  const exceptions = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid ?? Math.random().toString(36), ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const out = [];
  const push = (item, start, end) => {
    if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const allDay = start.isDate;
    const s = allDay ? icalDate(start) : start.toJSDate().toISOString();
    let e = end ? (allDay ? icalDate(end) : end.toJSDate().toISOString()) : s;
    if (allDay && e === s) e = addDays(s, 1);
    out.push({
      id: `${item.uid}-${s}`,
      title: item.summary || '(geen titel)',
      location: item.location || '',
      allDay,
      start: s,
      end: e,
      category: feed.category ?? 'persoonlijk',
      calendar: feed.name ?? '',
      tone: Number.isInteger(feed.tone) && feed.tone >= 1 && feed.tone <= 6 ? feed.tone : null,
    });
  };

  for (const ev of masters.values()) {
    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next;
      let n = 0;
      while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
        if (next.toJSDate() >= to) break;
        const d = ev.getOccurrenceDetails(next);
        if (d.endDate.toJSDate() <= from) continue;
        push(d.item, d.startDate, d.endDate);
      }
    } else {
      const start = ev.startDate;
      const end = ev.endDate;
      if (!start) continue;
      if (start.toJSDate() >= to || (end ?? start).toJSDate() <= from) continue;
      push(ev, start, end);
    }
  }
  return out;
}

function icalDate(t) {
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}
