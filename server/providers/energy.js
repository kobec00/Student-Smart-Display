// Zonnepanelen en thuisbatterij: Huawei SUN2000 (hybride omvormer) met LUNA2000-batterij en
// slimme meter (DTSU666-H / DDSU666-H), rechtstreeks uitgelezen via Modbus TCP in je eigen netwerk.
// Geen FusionSolar-account, geen cloud. Optioneel: zonder "energy.host" staat het uit.
//
// Wat we lezen (Huawei "Solar Inverter Modbus Interface Definitions", zelfde adressen als de
// huawei-solar-bibliotheek die Home Assistant gebruikt):
//   32064 PV-vermogen (W)            32080 AC-vermogen van de omvormer (W)   32089 status
//   32087 temperatuur (0,1 °C)       32114 dagopbrengst AC (0,01 kWh)
//   37758 batterijcapaciteit (Wh)    37760 laadtoestand (0,1 %)              37762 batterijstatus
//   37765 laden(+)/ontladen(−) (W)   37784/37786 vandaag geladen/ontladen (0,01 kWh)
//   37113 meter (W, + = injectie)    37119/37121 totaal geïnjecteerd/afgenomen (0,01 kWh)
//
// Rekenwerk:
//   huisverbruik = AC-vermogen omvormer − meter (de omvormer levert ook uit de batterij)
//   zon vandaag  = dagopbrengst + vandaag geladen − vandaag ontladen (zoals FusionSolar het doet:
//                  de dagopbrengst van de omvormer is wat er aan AC-kant uitgaat, dus mét batterij)
//   afname/injectie vandaag = meterstand nu − meterstand om middernacht (bewaard in data/energy.json)
import { join } from 'node:path';
import { createModbusClient, ModbusError } from '../modbus.js';
import { createStore, isoDate, addDays } from '../util.js';

const SLOT_MIN = 5; // het verloop van de dag in blokjes van 5 minuten
const KEEP_DAYS = 14;
const RECHECK_MS = 60 * 60_000; // ontbrekende batterij of meter: na een uur opnieuw proberen

const u16 = (b, o = 0) => b.readUInt16BE(o);
const i16 = (b, o = 0) => b.readInt16BE(o);
const u32 = (b, o = 0) => b.readUInt32BE(o);
const i32 = (b, o = 0) => b.readInt32BE(o);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

function inverterStatus(code) {
  if (code === 0x0200 || code === 0x0202 || code === 0x0203) return ['run', 'Levert stroom'];
  if (code === 0x0201) return ['run', 'Levert stroom (begrensd)'];
  if (code === 0xa000) return ['idle', 'Stand-by: geen zon'];
  if (code === 0x0306) return ['off', 'Uit: DC-schakelaar open'];
  if (code === 0x0308) return ['idle', 'Uit: te weinig zon'];
  if (code === 0x0300) return ['fault', 'Uit: storing'];
  if (code >= 0x0300 && code < 0x0400) return ['off', 'Uitgeschakeld'];
  if (code <= 0x0003 || code === 0x0100) return ['idle', 'Opstarten'];
  return ['idle', `Status 0x${code.toString(16).padStart(4, '0')}`];
}
const BATTERY_STATUS = ['offline', 'stand-by', 'actief', 'storing', 'slaapstand'];

// ── Het toestel uitlezen ───────────────────────────────────

function createHuawei(e) {
  const client = createModbusClient({ host: e.host, port: Number(e.port ?? 502), unit: Number(e.unit ?? 1), timeout: Number(e.timeout ?? 10) * 1000 });
  const missing = { battery: 0, meter: 0 };
  let capacityWh = Number(e.batteryKwh) > 0 ? Number(e.batteryKwh) * 1000 : null;

  // Een batterij of meter die er niet is, antwoordt met een Modbus-fout (of nullen). Dat is geen storing.
  async function optional(part, fn) {
    if (missing[part] && Date.now() - missing[part] < RECHECK_MS) return null;
    try {
      const v = await fn();
      if (v === null) missing[part] = Date.now();
      else missing[part] = 0;
      return v;
    } catch (err) {
      if (err instanceof ModbusError && err.code !== null) {
        if (!missing[part]) console.log(`[energie] geen ${part === 'battery' ? 'batterij' : 'slimme meter'} gevonden (${err.message})`);
        missing[part] = Date.now();
        return null;
      }
      throw err;
    }
  }

  async function sample() {
    const inv = await client.read(32064, 26); // 32064 … 32089 liggen aaneen
    const daily = await client.read(32114, 2);
    const battery = await optional('battery', async () => {
      const soc = u16(await client.read(37760, 1)) / 10;
      const status = u16(await client.read(37762, 1));
      if (status === 0 && soc === 0) return null; // geen batterij aangesloten
      const power = i32(await client.read(37765, 2));
      const day = await client.read(37784, 4);
      if (!capacityWh) capacityWh = (await client.read(37758, 2).then((b) => u32(b)).catch(() => 0)) || null;
      return { soc, status, power, chargeKwh: u32(day, 0) / 100, dischargeKwh: u32(day, 4) / 100 };
    });
    const meter = await optional('meter', async () => {
      const power = i32(await client.read(37113, 2));
      const totals = await client.read(37119, 4);
      return { power, exportKwh: Math.abs(i32(totals, 0)) / 100, importKwh: i32(totals, 4) / 100 };
    });
    return {
      pv: i32(inv, 0),
      ac: i32(inv, (32080 - 32064) * 2),
      temp: i16(inv, (32087 - 32064) * 2) / 10,
      status: u16(inv, (32089 - 32064) * 2),
      yieldKwh: u32(daily) / 100,
      battery,
      meter,
      capacityWh,
    };
  }

  return { sample };
}

// ── Voorbeelddata: een gesimuleerd huis met 4,6 kWp en een batterij van 5 kWh ──
// Deterministisch per dag (een "weer" per datum), zodat het display bij elke herstart hetzelfde vertelt.

function createDemo() {
  const CAP = 5000;
  let t = null;
  let soc = 38;
  const totals = { import: 18234.5, export: 9120.2 };
  let day = { date: null, yieldKwh: 0, charge: 0, discharge: 0 };
  let last = null;

  // Een vast "toevalsgetal" tussen 0 en 1 per datum.
  const rnd = (s, salt = 0) => {
    let h = [...s].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 0x5bd1e995) >>> 0, 0x9747b28c ^ salt);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 2 ** 32;
  };
  function solar(d) {
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
    const season = Math.cos((2 * Math.PI * (doy - 172)) / 365); // 1 in juni, −1 in december
    const half = 6.1 + 2.1 * season; // halve daglengte in uren (België)
    const noon = d.getTimezoneOffset() === -120 ? 13.75 : 12.75;
    const h = minutesOf(d) / 60 + d.getSeconds() / 3600;
    const x = (h - noon) / half;
    if (Math.abs(x) >= 1) return 0;
    const peak = 1500 + 1700 * (season + 1);
    const sky = 0.25 + 0.75 * rnd(isoDate(d)); // bewolking van de dag
    const clouds = 0.8 + 0.2 * Math.sin(h * 7.3 + 13 * rnd(isoDate(d), 1));
    return Math.max(0, peak * sky * clouds * Math.cos((x * Math.PI) / 2) ** 1.6);
  }
  function load(d) {
    const h = minutesOf(d) / 60;
    const bump = (c, w, a) => a * Math.exp(-(((h - c) / w) ** 2));
    const wiggle = 60 * Math.sin(h * 11.1) + 40 * Math.sin(h * 23.7);
    return 230 + bump(7.4, 0.6, 650) + bump(12.5, 0.8, 380) + bump(18.6, 1.1, 1350) + bump(21, 0.9, 420) + wiggle;
  }
  function step(d, dtH) {
    const date = isoDate(d);
    if (day.date !== date) day = { date, yieldKwh: 0, charge: 0, discharge: 0 };
    const pv = solar(d);
    const house = load(d);
    let bat = 0;
    if (pv > house && soc < 100) bat = Math.min(pv - house, 2500, ((100 - soc) / 100) * CAP / dtH);
    else if (pv < house && soc > 5) bat = -Math.min(house - pv, 2500, ((soc - 5) / 100) * CAP / dtH);
    soc = Math.min(100, Math.max(5, soc + (bat * dtH * (bat > 0 ? 0.95 : 1.05)) / CAP * 100));
    const ac = pv - bat; // wat de omvormer aan AC-kant levert (verliezen even buiten beschouwing)
    const grid = house - ac; // + = afname
    if (grid > 0) totals.import += (grid * dtH) / 1000;
    else totals.export += (-grid * dtH) / 1000;
    if (ac > 0) day.yieldKwh += (ac * dtH) / 1000;
    if (bat > 0) day.charge += (bat * dtH) / 1000;
    else day.discharge += (-bat * dtH) / 1000;
    last = { pv, ac, bat, grid };
  }

  return {
    sample(now = new Date()) {
      if (!t) {
        t = new Date(now.getTime() - 60_000);
      }
      while (t < now) {
        const next = new Date(Math.min(now.getTime(), t.getTime() + 60_000));
        step(next, (next - t) / 3_600_000);
        t = next;
      }
      return {
        pv: Math.round(last.pv),
        ac: Math.round(last.ac),
        temp: 31.5,
        status: last.pv > 20 || last.bat < 0 ? 0x0200 : 0xa000,
        yieldKwh: r2(day.yieldKwh),
        battery: { soc: r1(soc), status: 2, power: Math.round(last.bat), chargeKwh: r2(day.charge), dischargeKwh: r2(day.discharge) },
        meter: { power: Math.round(-last.grid), exportKwh: r2(totals.export), importKwh: r2(totals.import) },
        capacityWh: CAP,
      };
    },
    /** Start de simulatie op een bepaald moment (om een paar dagen geschiedenis te vullen). */
    startAt(d) {
      t = d;
    },
  };
}

// ── Van ruwe metingen naar wat het display toont ───────────

const memoryStore = (seed) => {
  const data = seed();
  return { get: () => data, update: (fn) => fn(data) };
};

export function createEnergy(cfg, dataDir) {
  const e = cfg.energy ?? {};
  const demo = e.demo === true;
  if (!e.host && !demo) {
    const off = () => ({ state: 'off' });
    return { get: off, detail: off };
  }
  const device = demo ? createDemo() : createHuawei(e);
  const reserve = Number.isFinite(Number(e.batteryReserve)) ? Number(e.batteryReserve) : 5;
  const seed = () => ({ date: null, start: null, since: null, partial: false, history: [], days: [], last: null });
  // Voorbeelddata bewaren we niet: anders staat er na het instellen van je echte omvormer nog nep-geschiedenis.
  const store = demo ? memoryStore(seed) : createStore(join(dataDir, 'energy.json'), seed);
  let state = { state: 'loading', demo };
  let acc = null; // het lopende blokje van 5 minuten
  let failures = 0;

  // partial: de server draaide niet om middernacht, dus de meterstanden lopen pas vanaf `since`.
  // De omvormer telt wel vanaf middernacht; die twee mengen geeft onzin, dus dan geen verbruik of percentages.
  function totalsFor(s, start, partial, since = null) {
    const bat = s.battery;
    const charge = bat?.chargeKwh ?? 0;
    const discharge = bat?.dischargeKwh ?? 0;
    const pv = Math.max(0, s.yieldKwh + charge - discharge);
    const t = { pv: r2(pv), charge: r2(charge), discharge: r2(discharge), import: null, export: null, load: null, selfUse: null, autarky: null, partial, since: partial ? since : null };
    if (s.meter && start) {
      t.import = r2(Math.max(0, s.meter.importKwh - start.import));
      t.export = r2(Math.max(0, s.meter.exportKwh - start.export));
      if (partial) return t;
      t.load = r2(Math.max(0, pv + t.import - t.export + discharge - charge));
      if (pv > 0.05) t.selfUse = Math.round(clamp01((pv - t.export) / pv) * 100);
      if (t.load > 0.05) t.autarky = Math.round(clamp01(1 - t.import / t.load) * 100);
    }
    return t;
  }

  function closeSlot(data) {
    if (!acc || !acc.n) return;
    const avg = (k) => (acc[k] === null ? null : Math.round(acc[k] / acc.n));
    data.history.push({ m: acc.slot * SLOT_MIN, pv: avg('pv'), load: avg('load'), grid: avg('grid'), bat: avg('bat'), soc: acc.soc });
    acc = null;
  }

  function ingest(s, now) {
    const date = isoDate(now);
    const slot = Math.floor(minutesOf(now) / SLOT_MIN);
    const load = s.meter ? Math.max(0, s.ac - s.meter.power) : null;
    const grid = s.meter ? -s.meter.power : null;
    const bat = s.battery ? s.battery.power : null;
    const counters = s.meter ? { import: s.meter.importKwh, export: s.meter.exportKwh } : null;

    store.update((data) => {
      if (data.date !== date) {
        closeSlot(data);
        // Gisteren afsluiten met de laatste tellerstanden van vóór middernacht.
        if (data.date && data.last && addDays(data.date, 1) === date) {
          data.days = [...data.days.filter((d) => d.date !== data.date), { date: data.date, ...data.last }].slice(-KEEP_DAYS);
        }
        // Liep de server om middernacht (of draaien we pas net na middernacht), dan is het een volledige dag.
        data.partial = !(data.date && addDays(data.date, 1) === date) && minutesOf(now) > 15;
        data.date = date;
        data.start = counters;
        data.since = counters ? now.toISOString() : null;
        data.history = [];
        acc = null;
      }
      if (!data.start && counters) {
        data.start = counters;
        data.since = now.toISOString();
        // Een meter die pas in de loop van de dag opduikt: de netcijfers lopen dan ook pas vanaf nu.
        if (minutesOf(now) > 15) data.partial = true;
      }
      if (acc && acc.slot !== slot) closeSlot(data);
      acc ??= { slot, n: 0, pv: 0, load: load === null ? null : 0, grid: grid === null ? null : 0, bat: bat === null ? null : 0, soc: null };
      acc.n++;
      acc.pv += Math.max(0, s.pv);
      if (acc.load !== null && load !== null) acc.load += load;
      if (acc.grid !== null && grid !== null) acc.grid += grid;
      if (acc.bat !== null && bat !== null) acc.bat += bat;
      if (s.battery) acc.soc = s.battery.soc;
      data.last = totalsFor(s, data.start, data.partial, data.since);
    });
  }

  function view(s, now) {
    const data = store.get();
    const [kind, label] = inverterStatus(s.status);
    let battery = null;
    if (s.battery) {
      const b = s.battery;
      const cap = s.capacityWh;
      let eta = null;
      // Vol om … / leeg om …: alleen bij een duidelijke stroom, anders springt het alle kanten op.
      if (cap && b.power > 80 && b.soc < 99) eta = { kind: 'full', at: new Date(now.getTime() + (((100 - b.soc) / 100) * cap / b.power) * 3_600_000).toISOString() };
      else if (cap && b.power < -80 && b.soc > reserve + 1) eta = { kind: 'empty', at: new Date(now.getTime() + (((b.soc - reserve) / 100) * cap / -b.power) * 3_600_000).toISOString() };
      battery = { soc: b.soc, power: b.power, status: BATTERY_STATUS[b.status] ?? `status ${b.status}`, capacityKwh: cap ? r1(cap / 1000) : null, eta };
    }
    return {
      state: 'ok',
      demo,
      updatedAt: now.toISOString(),
      now: {
        pv: Math.max(0, s.pv),
        load: s.meter ? Math.max(0, s.ac - s.meter.power) : null,
        grid: s.meter ? -s.meter.power : null,
        battery,
        inverter: { kind, label, temp: s.temp, ac: s.ac },
      },
      today: totalsFor(s, data.start, data.partial, data.since),
    };
  }

  let lastSample = null;
  async function run(now = new Date()) {
    try {
      const s = await device.sample(now);
      ingest(s, now);
      lastSample = s;
      state = view(s, now);
      if (failures) console.log('[energie] weer verbonden');
      failures = 0;
    } catch (err) {
      if (!failures) console.error('[energie]', err.message);
      failures++;
      state = { ...state, state: lastSample ? 'stale' : 'error', error: err.message, failedAt: now.toISOString() };
    }
  }

  // Demo: een week vooraf simuleren, zodat er meteen een verloop en dagtotalen zijn.
  if (demo) {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    from.setHours(0, 0, 0, 0);
    device.startAt(from);
    for (let t = from.getTime() + 60_000; t < now.getTime(); t += 60_000) {
      const d = new Date(t);
      ingest(device.sample(d), d);
    }
  }

  const intervalMs = Math.max(5, Number(e.interval ?? 15)) * 1000;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    await run();
    busy = false;
  };
  tick();
  setInterval(tick, intervalMs).unref();

  return {
    get: () => state,
    detail() {
      if (state.state !== 'ok' && state.state !== 'stale') return state;
      const data = store.get();
      const history = acc?.n ? [...data.history, { m: acc.slot * SLOT_MIN, pv: Math.round(acc.pv / acc.n), load: acc.load === null ? null : Math.round(acc.load / acc.n), grid: acc.grid === null ? null : Math.round(acc.grid / acc.n), bat: acc.bat === null ? null : Math.round(acc.bat / acc.n), soc: acc.soc, live: true }] : data.history;
      return { ...state, slotMinutes: SLOT_MIN, history, days: data.days.slice(-7) };
    },
  };
}
