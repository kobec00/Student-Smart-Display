// Kleine visuele bouwstenen: gevulde weericoontjes, sparklines en de statusring.

// ── Weer (viewBox 32×32) ──
const cloudShape = (cls, x = 0, y = 0, s = 1) =>
  `<g class="${cls}" transform="translate(${x} ${y}) scale(${s})"><circle cx="10" cy="20" r="5"/><circle cx="16.5" cy="15.5" r="7"/><circle cx="23" cy="19.5" r="5.5"/><rect x="10" y="19" width="13" height="6"/></g>`;

const sunShape = (cx, cy, r) => {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 2.6);
    const y1 = cy + Math.sin(a) * (r + 2.6);
    const x2 = cx + Math.cos(a) * (r + 5);
    const y2 = cy + Math.sin(a) * (r + 5);
    rays += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return `<circle class="wx-sun" cx="${cx}" cy="${cy}" r="${r}"/><path class="wx-ray" d="${rays}"/>`;
};

const moonShape = (x = 0, y = 0, s = 1) =>
  `<path class="wx-moon" transform="translate(${x} ${y}) scale(${s})" d="M19 4a11 11 0 1 0 9 16.5A9 9 0 0 1 19 4z"/>`;

export function wxIcon(kind, isDay = true, cls = '') {
  let body;
  switch (kind) {
    case 'clear':
      body = isDay ? sunShape(16, 16, 6.5) : moonShape(1, 1, 0.95);
      break;
    case 'partly':
      body = (isDay ? sunShape(11, 11, 4.6) : moonShape(-1, -1, 0.62)) + cloudShape('wx-cloud', 4, 4, 0.9);
      break;
    case 'cloud':
      body = cloudShape('wx-cloud-dark', -3, -4, 0.8) + cloudShape('wx-cloud', 2, 1, 0.92);
      break;
    case 'fog':
      body = cloudShape('wx-cloud', 0, -4) + '<path class="wx-fog" d="M6 25h20M9 29h14"/>';
      break;
    case 'drizzle':
      body = cloudShape('wx-cloud', 0, -5) + '<path class="wx-rain" d="M11 25v.5M16 27v.5M21 25v.5"/>';
      break;
    case 'rain':
      body = cloudShape('wx-cloud-dark', 0, -5) + '<path class="wx-rain" d="M11.5 24l-1.5 4M16.5 24l-1.5 4M21.5 24l-1.5 4"/>';
      break;
    case 'snow':
      body = cloudShape('wx-cloud', 0, -5) + '<g class="wx-snow"><circle cx="11" cy="26" r="1.4"/><circle cx="16" cy="28.5" r="1.4"/><circle cx="21" cy="26" r="1.4"/></g>';
      break;
    case 'storm':
      body = cloudShape('wx-cloud-dark', 0, -5) + '<path class="wx-bolt" d="M17 20.5l-4.5 6h3.2l-1.7 5 5.5-7h-3.4z"/>';
      break;
    default:
      body = cloudShape('wx-cloud', 0, 0);
  }
  return `<svg class="wx-icon ${cls}" viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
}

// ── Sparkline: lijn door de waarden, onderbroken waar een waarde ontbreekt ──
export function spark(values, color = 'green') {
  const pts = (values ?? []).map((v, i) => [i, v]);
  const nums = pts.filter(([, v]) => Number.isFinite(v)).map(([, v]) => v);
  if (nums.length < 2) return `<svg class="spark spark--${color}" viewBox="0 0 100 30" aria-hidden="true"></svg>`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const segments = [];
  let current = [];
  for (const [i, v] of pts) {
    if (!Number.isFinite(v)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    const x = (i / n) * 100;
    const y = 28 - ((v - min) / span) * 26;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (current.length) segments.push(current);
  const lines = segments.map((s) => `<polyline points="${s.length === 1 ? `${s[0]} ${s[0]}` : s.join(' ')}"/>`).join('');
  return `<svg class="spark spark--${color}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`;
}

// ── Statusring ──
export function ring({ up, total, pending }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = total ? up / total : 0;
  const bad = total && up < total && !pending;
  return (
    `<div class="ring${pending && up < total ? ' ring--pending' : ''}"><svg viewBox="0 0 64 64" aria-hidden="true">` +
    `<circle class="${bad ? 'ring__bad' : 'ring__track'}" cx="32" cy="32" r="${r}"/>` +
    (frac > 0 ? `<circle class="ring__arc" cx="32" cy="32" r="${r}" stroke-dasharray="${(frac * c).toFixed(1)} ${c.toFixed(1)}"/>` : '') +
    `</svg><span class="ring__label"><span><b>${up}</b>/${total}</span></span></div>`
  );
}
