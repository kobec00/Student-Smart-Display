// Kiosk-waakhond. Chromium onder Wayland (cage) start soms zonder naar de
// opgegeven URL te navigeren: het scherm blijft grijs op about:blank.
// Deze waakhond kijkt via de DevTools-poort (alleen lokaal, 127.0.0.1) of het
// dashboard geladen is en navigeert anders zelf. Zodra het dashboard staat,
// stopt hij, zodat hij geen geheugen blijft gebruiken.
//
//   node kiosk-watchdog.mjs <url> [poort]
const url = process.argv[2];
const port = Number(process.argv[3] ?? 9222);
const target = new URL(url);
const log = (...a) => console.log('[kiosk-waakhond]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json();
  return list.find((t) => t.type === 'page');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      const onMessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== n) return;
        ws.removeEventListener('message', onMessage);
        resolve(msg.result ?? {});
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

async function check() {
  const page = await pageTarget();
  if (!page) return false;
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ href: location.href, title: document.title, ready: document.readyState })',
      returnByValue: true,
    });
    const state = JSON.parse(r.result?.value ?? '{}');
    const loaded = state.href?.startsWith(target.origin) && state.ready !== 'loading' && state.title;
    if (loaded) return true;
    log(`pagina staat op ${state.href || '?'}, ik open ${url}`);
    await c.send('Page.navigate', { url });
    return false;
  } finally {
    c.close();
  }
}

// Geef Chromium eerst de kans om zelf te laden; controleer dan tot 5 minuten lang.
await sleep(20_000);
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    if (await check()) {
      log('dashboard geladen, waakhond stopt');
      process.exit(0);
    }
  } catch (err) {
    log('nog geen verbinding met Chromium:', err.message);
  }
  await sleep(10_000);
}
log('dashboard niet geladen na 5 minuten');
process.exit(1);
