// School: lessons, deadlines and exams from school.json (see school.example.json).
// With a TimeEdit link in config.json (school.timeedit), lessons come from that official
// timetable instead (see timeedit.js); deadlines and exams always come from school.json.
// A file with "demo": true and an "anchor" date is shifted so the anchor falls on today,
// which keeps the example timetable alive whenever you try the project.
// Tijden zijn lokale kloktijden ("2026-12-24T12:00"); de browser rekent ermee.
import { readFileSync, existsSync } from 'node:fs';
import { createTimeEdit, mergeTimeEdit } from './timeedit.js';

const KINDS = ['les', 'deadline', 'examen', 'opdracht'];
const START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const text = (v, max = 600) => String(v ?? '').trim().slice(0, max);

/**
 * De lessen als agenda-afspraken (zelfde vorm als calendar.js), zodat ze ook in de agenda,
 * op het overzicht en op het ochtendscherm staan.
 */
export function lessonEvents(s, range, category) {
  if (s?.state !== 'ok') return [];
  const out = [];
  for (const i of s.items ?? []) {
    if (i.kind !== 'les' || i.noTime) continue;
    const day = i.start.slice(0, 10);
    if (range && (day < range.from || day >= range.to)) continue;
    const start = new Date(i.start); // lokale kloktijd van de server
    const end = i.end ? new Date(`${day}T${i.end}`) : new Date(start.getTime() + 3600e3);
    if (Number.isNaN(+start) || Number.isNaN(+end)) continue;
    const c = (s.courses ?? []).find((x) => x.id === i.course);
    // Staat de vaknaam niet in de titel ("Werksessie Ethisch Dilemma"), dan komt de afkorting bij het lokaal.
    const named = !c || i.title.toLowerCase().startsWith(c.name.split(/\s+/)[0].toLowerCase());
    out.push({
      id: `les-${i.start}-${i.course}`,
      title: i.title,
      location: [i.room, named ? '' : c.abbr].filter(Boolean).join(', '),
      allDay: false,
      start: start.toISOString(),
      end: end.toISOString(),
      category,
      calendar: 'Lesrooster',
      tone: null,
    });
  }
  return out;
}

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function shiftDemo(raw) {
  if (!raw?.demo || !/^\d{4}-\d{2}-\d{2}$/.test(raw.anchor ?? '')) return raw;
  const [y, m, d] = raw.anchor.split('-').map(Number);
  const now = new Date();
  const offset = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / DAY);
  const move = (start) => {
    const [day, time] = start.split('T');
    const [yy, mm, dd] = day.split('-').map(Number);
    return `${localDay(new Date(yy, mm - 1, dd + offset))}T${time}`;
  };
  return { ...raw, checked: localDay(now), items: (raw.items ?? []).map((i) => (START.test(i.start ?? '') ? { ...i, start: move(i.start) } : i)) };
}

export function createSchool(file, timeeditUrl) {
  let data = { state: 'empty', courses: [], items: [], undated: [] };
  const timeedit = typeof timeeditUrl === 'string' && /^(https?|webcal):\/\//i.test(timeeditUrl) ? createTimeEdit(timeeditUrl) : null;
  if (file && existsSync(file)) {
    try {
      const raw = shiftDemo(JSON.parse(readFileSync(file, 'utf8')));
      const courses = (raw.courses ?? []).map((c) => ({ id: text(c.id, 20), abbr: text(c.abbr, 12), name: text(c.name, 80), tone: Number(c.tone) || 3 }));
      const known = (i) => courses.some((c) => c.id === i.course) && KINDS.includes(i.kind) && text(i.title);
      const items = (raw.items ?? [])
        .filter((i) => known(i) && START.test(i.start))
        .map((i) => ({
          start: i.start,
          end: /^\d{2}:\d{2}$/.test(i.end ?? '') ? i.end : null,
          noTime: Boolean(i.noTime),
          course: i.course,
          kind: i.kind,
          title: text(i.title, 200),
          room: text(i.room, 40),
          text: text(i.text),
          note: text(i.note),
        }))
        .sort((a, b) => a.start.localeCompare(b.start));
      const undated = (raw.undated ?? []).filter(known).map((u) => ({
        course: u.course,
        kind: u.kind,
        title: text(u.title, 200),
        points: (u.points ?? []).map((p) => text(p)),
      }));
      data = { state: 'ok', demo: Boolean(raw.demo), title: text(raw.title, 60), period: text(raw.period, 60), checked: /^\d{4}-\d{2}-\d{2}$/.test(raw.checked ?? '') ? raw.checked : null, courses, items, undated };
      console.log(`[school] ${items.length} items geladen`);
    } catch (err) {
      console.error(`[school] ${file} is niet leesbaar: ${err.message}`);
      data = { ...data, state: 'error', error: 'school.json is niet leesbaar.' };
    }
  }
  // Samenvoegen kost weinig, maar niet elke 30 s opnieuw: alleen als TimeEdit iets nieuws gaf.
  let merged = null;
  let mergedFrom = null;
  function get() {
    if (!timeedit || data.state === 'error') return data;
    const te = timeedit.get();
    if (te !== mergedFrom) {
      mergedFrom = te;
      merged = mergeTimeEdit(data, te);
    }
    return merged;
  }
  return { get };
}
