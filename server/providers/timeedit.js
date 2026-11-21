// Timetable from TimeEdit (used by many universities and colleges): one public ICS link per student.
// The link lives in config.json as school.timeedit and is personal: never commit it.
//
// Een TimeEdit-afspraak ziet er zo uit:
//   SUMMARY:     AB1234 Statistiek 1, <lecturer>, Statistiek 1
//   LOCATION:    AUD 0.01 Aula A
//   DESCRIPTION: \nAB1234-STAT1\nID 1234567      (first line is sometimes a note)
// From that we take the course (abbreviation STAT), the name, the room and the times (local clock time).
import ICAL from 'ical.js';
import { poller } from '../util.js';

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localStart = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${clock(d)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function parseLesson(ev) {
  const start = ev.startDate?.toJSDate();
  const end = ev.endDate?.toJSDate();
  if (!start || Number.isNaN(+start)) return null;
  const parts = String(ev.summary ?? '').split(/,\s*/).map((p) => p.trim()).filter(Boolean);
  const desc = String(ev.description ?? '').split('\n').map((l) => l.trim());
  const abbrs = [];
  for (const line of desc) {
    const m = /^[A-Z]{1,4}\d{2,6}-([A-Za-z&]+?)\d*$/.exec(line);
    if (m) abbrs.push(m[1]);
  }
  const note = desc.find((l) => l && !/^ID \d+$/.test(l) && !/^[A-Z]{1,4}\d{2,6}-/.test(l)) ?? '';
  const first = parts[0] ?? '';
  const coded = /^[A-Z]{1,4}\d{2,6}\s+(.+?)(?:\s+\d+)?$/.exec(first);
  const courseName = coded ? coded[1] : '';
  // Zonder vakcode (bv. "Info&Algemeenheden, Taal en ICT") is het een algemene sessie.
  const title = coded ? courseName : `${first.replace(/&/g, ' & ')}${parts[1] ? `: ${parts[1]}` : ''}`;
  // Een deel dat met een kleine letter begint is een soort les ("docent onafhankelijk practicum"), geen docent.
  const kind = parts.slice(1).find((p) => /^[a-zà-ÿ]/.test(p));
  const loc = String(ev.location ?? '').split(/,\s*/)[0];
  const room = (/^([A-Z]{2,6}\s+\d+(?:\.\d+)?)/.exec(loc)?.[1] ?? loc).slice(0, 40);
  return {
    start: localStart(start),
    end: end && end.toDateString() === start.toDateString() ? clock(end) : null,
    abbrs,
    courseName,
    title: title.slice(0, 200),
    text: kind ? cap(kind) : note,
    room,
  };
}

export function createTimeEdit(url) {
  return poller('timeedit', 30 * 60_000, async () => {
    const res = await fetch(url.replace(/^webcal:\/\//i, 'https://'), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`TimeEdit gaf HTTP ${res.status}`);
    const text = await res.text();
    const root = new ICAL.Component(ICAL.parse(text));
    const lessons = [];
    for (const vevent of root.getAllSubcomponents('vevent')) {
      if (String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') continue;
      const l = parseLesson(new ICAL.Event(vevent));
      if (l) lessons.push(l);
    }
    // Vanaf wanneer het rooster geldt ("Date limit 02-11-2026 - …"); lessen van vóór die datum
    // komen nog uit school.json.
    const m = /Date limit (\d{2})-(\d{2})-(\d{4})/.exec(String(root.getFirstPropertyValue('x-wr-caldesc') ?? ''));
    const from = m ? `${m[3]}-${m[2]}-${m[1]}` : lessons.map((l) => l.start.slice(0, 10)).sort()[0] ?? null;
    lessons.sort((a, b) => a.start.localeCompare(b.start));
    console.log(`[timeedit] ${lessons.length} lessen geladen`);
    return { state: 'ok', updatedAt: new Date().toISOString(), from, lessons };
  });
}

/**
 * Voegt het TimeEdit-rooster samen met school.json: TimeEdit beslist over de lessen (uur en lokaal),
 * school.json levert de titels, uitleg en opmerkingen die het al had voor dezelfde les.
 * Deadlines en examens blijven uit school.json. Vakken die TimeEdit kent maar school.json niet
 * (bv. het volgende semester) komen er vanzelf bij.
 */
export function mergeTimeEdit(base, te) {
  if (!te || te.state !== 'ok' || !te.lessons?.length) {
    return te ? { ...base, timeedit: { state: te.state, error: te.error ?? null } } : base;
  }
  const courses = [...(base.courses ?? [])];
  const byAbbr = (a) => courses.find((c) => c.abbr.toLowerCase() === a.toLowerCase());
  const nextTone = () => {
    const used = new Set(courses.map((c) => c.tone));
    return [1, 2, 3, 4, 5, 6].find((t) => !used.has(t)) ?? (courses.length % 6) + 1;
  };
  const addCourse = (abbr, name) => {
    let id = abbr.toLowerCase().replace(/[^a-z0-9]/g, '') || 'les';
    while (courses.some((c) => c.id === id)) id += 'x';
    const c = { id, abbr: abbr.slice(0, 12), name: (name || abbr).slice(0, 80), tone: nextTone() };
    courses.push(c);
    return c;
  };
  const courseFor = (l) => {
    for (const a of l.abbrs) {
      const c = byAbbr(a);
      if (c) return c.id;
    }
    if (l.abbrs.length === 1) return addCourse(l.abbrs[0], l.courseName).id;
    return (byAbbr('Alg') ?? addCourse('Alg', 'Algemeen')).id;
  };

  const baseLessons = (base.items ?? []).filter((i) => i.kind === 'les');
  const used = new Set();
  const lessons = te.lessons.map((l) => {
    const course = courseFor(l);
    const day = l.start.slice(0, 10);
    const same = baseLessons.filter((b) => !used.has(b) && b.start.slice(0, 10) === day);
    const pick = same.find((b) => b.course === course && b.start === l.start) ?? same.find((b) => b.start === l.start) ?? same.find((b) => b.course === course);
    if (pick) used.add(pick);
    return {
      start: l.start,
      end: l.end,
      noTime: false,
      course: pick?.course ?? course,
      kind: 'les',
      title: pick?.title || l.title,
      room: l.room || pick?.room || '',
      text: pick?.text || l.text || '',
      note: pick?.note || '',
    };
  });
  const from = te.from ?? '0000-00-00';
  const keep = (base.items ?? []).filter((i) => i.kind !== 'les' || (!used.has(i) && i.start.slice(0, 10) < from));
  const items = [...keep, ...lessons].sort((a, b) => a.start.localeCompare(b.start));
  return { ...base, state: 'ok', courses, items, timeedit: { state: 'ok', updatedAt: te.updatedAt, lessons: lessons.length } };
}
