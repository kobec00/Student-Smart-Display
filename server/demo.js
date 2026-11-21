// Voorbeelddata, zodat het display er meteen gevuld uitziet.
// Elke bron schakelt automatisch over op echte data zodra je hem configureert.
import { isoDate, addDays, newId } from './util.js';

const at = (dayOffset, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export function demoEvents() {
  const today = isoDate();
  const ev = (day, from, to, title, category, location = '') => ({
    id: `demo-${day}-${from}-${title}`,
    title,
    location,
    allDay: false,
    start: at(day, from),
    end: at(day, to),
    category,
    calendar: 'Voorbeeld',
  });
  const allDay = (day, title, category) => ({
    id: `demo-${day}-${title}`,
    title,
    location: '',
    allDay: true,
    start: addDays(today, day),
    end: addDays(today, day + 1),
    category,
    calendar: 'Voorbeeld',
  });
  return [
    ev(0, '13:00', '15:00', 'Groepswerk: marketingplan', 'school', 'Bib, studieruimte 2'),
    ev(0, '19:30', '21:00', 'Sporten', 'persoonlijk', 'Sporthal'),
    allDay(1, 'Verjaardag Sam', 'persoonlijk'),
    ev(1, '17:00', '21:00', 'Studentenjob', 'werk', 'Café'),
    ev(2, '09:00', '12:00', 'Taalles Engels', 'school', 'Lokaal 0.12'),
    ev(2, '14:00', '15:00', 'Feedbackgesprek', 'school', 'Lokaal 2.04'),
    ev(3, '18:00', '19:00', 'Kotvergadering', 'kot'),
    ev(4, '10:00', '12:00', 'Studiegroep economie', 'school', 'Bib'),
    ev(5, '11:00', '15:00', 'Studentenjob', 'werk', 'Café'),
    ev(6, '15:00', '17:00', 'Was en boodschappen', 'kot'),
  ].sort((a, b) => (a.allDay ? a.start : a.start).localeCompare(b.start));
}

export function demoTodos() {
  const t = isoDate();
  const item = (title, category, due = null) => ({
    id: newId(),
    title,
    category,
    due,
    done: false,
    doneAt: null,
    createdAt: new Date().toISOString(),
  });
  return [
    item('Slides hoorcollege 4 herbekijken', 'school', t),
    item('Bronnen zoeken voor paper', 'school', addDays(t, 2)),
    item('Inschrijven voor examens', 'school', addDays(t, -1)),
    item('Oefenreeks statistiek 3', 'school', addDays(t, 3)),
    item('Cadeau voor Sam kopen', 'persoonlijk', t),
    item('Fiets laten herstellen', 'persoonlijk'),
    item('Uren doorgeven', 'werk', addDays(t, 1)),
    item('Huur overschrijven', 'kot', addDays(t, 4)),
    item('Vuilniszakken buiten zetten', 'kot', addDays(t, 1)),
  ];
}

