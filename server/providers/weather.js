// Weer via Open-Meteo (gratis, geen API-sleutel), plus luchtkwaliteit en pollen
// van de Open-Meteo Air Quality API (ook gratis).
//
// Eén verzoek per kwartier levert alles: het dashboard krijgt een kleine samenvatting
// (get), het tabblad Weer haalt het volledige beeld op via /api/weather (detail).
import { fetchJSON, poller } from '../util.js';

// WMO-weercodes → Nederlandse omschrijving + icoon.
const WMO = {
  0: ['Helder', 'clear'],
  1: ['Overwegend helder', 'partly'],
  2: ['Half bewolkt', 'partly'],
  3: ['Bewolkt', 'cloud'],
  45: ['Mist', 'fog'],
  48: ['Rijpmist', 'fog'],
  51: ['Lichte motregen', 'drizzle'],
  53: ['Motregen', 'drizzle'],
  55: ['Dichte motregen', 'drizzle'],
  56: ['IJzel', 'drizzle'],
  57: ['IJzel', 'drizzle'],
  61: ['Lichte regen', 'rain'],
  63: ['Regen', 'rain'],
  65: ['Zware regen', 'rain'],
  66: ['IJzel', 'rain'],
  67: ['IJzel', 'rain'],
  71: ['Lichte sneeuw', 'snow'],
  73: ['Sneeuw', 'snow'],
  75: ['Zware sneeuw', 'snow'],
  77: ['Korrelsneeuw', 'snow'],
  80: ['Buien', 'rain'],
  81: ['Buien', 'rain'],
  82: ['Zware buien', 'rain'],
  85: ['Sneeuwbuien', 'snow'],
  86: ['Sneeuwbuien', 'snow'],
  95: ['Onweer', 'storm'],
  96: ['Onweer met hagel', 'storm'],
  99: ['Onweer met hagel', 'storm'],
};
const describe = (code) => WMO[code] ?? ['Onbekend', 'cloud'];
const round = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function createWeather(cfg) {
  const { latitude, longitude } = cfg.location ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { get: () => ({ state: 'unconfigured' }), detail: () => ({ state: 'unconfigured' }), refresh() {} };
  }
  const where = `latitude=${latitude}&longitude=${longitude}`;
  const url =
    `https://api.open-meteo.com/v1/forecast?${where}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,is_day,' +
    'wind_speed_10m,wind_gusts_10m,wind_direction_10m,pressure_msl,cloud_cover,precipitation,uv_index' +
    '&hourly=temperature_2m,apparent_temperature,weather_code,precipitation_probability,precipitation,is_day,' +
    'wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,' +
    'sunrise,sunset,daylight_duration,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant' +
    '&minutely_15=precipitation&timezone=auto&forecast_days=8&past_days=1';
  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?${where}` +
    '&current=european_aqi,pm2_5,pm10,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen&timezone=auto';

  let detail = { state: 'loading' };

  const main = poller('weer', 15 * 60_000, async () => {
    const d = await fetchJSON(url, { timeout: 15_000 });
    const h = d.hourly;
    const hoursAll = h.time.map((t, i) => ({
      time: t,
      temp: Math.round(h.temperature_2m[i]),
      feels: Math.round(h.apparent_temperature[i]),
      precip: h.precipitation_probability[i] ?? 0,
      mm: round(h.precipitation[i], 1) ?? 0,
      icon: describe(h.weather_code[i])[1],
      isDay: h.is_day[i] === 1,
      wind: Math.round(h.wind_speed_10m[i]),
      gusts: Math.round(h.wind_gusts_10m[i]),
      windDir: Math.round(h.wind_direction_10m[i]),
      uv: round(h.uv_index[i], 1) ?? 0,
    }));
    const dl = d.daily;
    const daysAll = dl.time.map((t, i) => ({
      date: t,
      max: Math.round(dl.temperature_2m_max[i]),
      min: Math.round(dl.temperature_2m_min[i]),
      precip: dl.precipitation_probability_max[i] ?? 0,
      mm: round(dl.precipitation_sum[i], 1) ?? 0,
      label: describe(dl.weather_code[i])[0],
      icon: describe(dl.weather_code[i])[1],
      sunrise: dl.sunrise[i],
      sunset: dl.sunset[i],
      daylight: Math.round(dl.daylight_duration[i] ?? 0),
      daylightDelta: i > 0 ? Math.round((dl.daylight_duration[i] ?? 0) - (dl.daylight_duration[i - 1] ?? 0)) : null,
      uv: round(dl.uv_index_max[i], 1) ?? 0,
      wind: Math.round(dl.wind_speed_10m_max[i]),
      gusts: Math.round(dl.wind_gusts_10m_max[i]),
      windDir: Math.round(dl.wind_direction_10m_dominant[i]),
    }));
    // past_days=1 levert gisteren mee (voor "x min meer daglicht dan gisteren"); vanaf vandaag tonen.
    const today = daysAll[1]?.date ?? daysAll[0].date;
    const days = daysAll.filter((x) => x.date >= today);
    const c = d.current;
    const [label, icon] = describe(c.weather_code);
    const current = {
      time: c.time,
      temp: Math.round(c.temperature_2m),
      feels: Math.round(c.apparent_temperature),
      humidity: Math.round(c.relative_humidity_2m),
      dewPoint: Math.round(c.dew_point_2m),
      wind: Math.round(c.wind_speed_10m),
      gusts: Math.round(c.wind_gusts_10m),
      windDir: Math.round(c.wind_direction_10m),
      pressure: Math.round(c.pressure_msl),
      cloud: Math.round(c.cloud_cover),
      precip: round(c.precipitation, 1) ?? 0,
      uv: round(c.uv_index, 1) ?? 0,
      isDay: c.is_day === 1,
      label,
      icon,
    };
    // Regen per kwartier voor de komende twee uur (nu + 8 kwartieren).
    const m = d.minutely_15;
    const nowcast = [];
    if (m?.time) {
      for (let i = 0; i < m.time.length && nowcast.length < 9; i++) {
        if (m.time[i] >= c.time) nowcast.push({ time: m.time[i], mm: round(m.precipitation[i], 2) ?? 0 });
      }
    }
    const updatedAt = new Date().toISOString();
    detail = {
      state: 'ok',
      updatedAt,
      location: cfg.location?.name ?? '',
      current,
      nowcast,
      hours: hoursAll.filter((x) => x.time >= `${today}T00:00`),
      days,
      air: air.get(),
    };
    // Samenvatting voor het dashboard (zelfde vorm als vroeger): 14 uur vanaf het volgende uur, 5 dagen.
    const next = hoursAll.findIndex((x) => x.time > c.time);
    return {
      state: 'ok',
      updatedAt,
      current: { temp: current.temp, feels: current.feels, wind: current.wind, isDay: current.isDay, label, icon },
      hours: hoursAll.slice(next, next + 14).map(({ time, temp, precip, icon: ic, isDay }) => ({ time, temp, precip, icon: ic, isDay })),
      days: days.slice(0, 5).map(({ date, max, min, precip, label: l, icon: ic, sunrise, sunset }) => ({ date, max, min, precip, label: l, icon: ic, sunrise, sunset })),
    };
  });

  const air = poller('lucht', 30 * 60_000, async () => {
    const a = (await fetchJSON(airUrl, { timeout: 15_000 })).current;
    return {
      state: 'ok',
      aqi: round(a.european_aqi),
      pm25: round(a.pm2_5, 1),
      pm10: round(a.pm10, 1),
      pollen: {
        els: round(a.alder_pollen, 1),
        berk: round(a.birch_pollen, 1),
        gras: round(a.grass_pollen, 1),
        bijvoet: round(a.mugwort_pollen, 1),
        ambrosia: round(a.ragweed_pollen, 1),
      },
    };
  });

  return {
    get: main.get,
    refresh: main.refresh,
    // Het volledige beeld, met de laatste luchtkwaliteit (die apart en minder vaak ververst).
    detail: () => (detail.state === 'ok' ? { ...detail, air: air.get() } : { ...detail, ...(main.get().state === 'error' ? { state: 'error', error: main.get().error } : {}) }),
  };
}
