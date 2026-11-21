// Herlaadt de pagina in de kiosk-browser via de DevTools-poort (alleen lokaal),
// zonder Chromium opnieuw te starten.
//
//   node kiosk-reload.mjs [poort]
const port = Number(process.argv[2] ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(8000) })).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
if (!page) {
  console.error('[kiosk-reload] geen pagina gevonden');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('geen verbinding met Chromium')), { once: true });
});
await new Promise((resolve) => {
  ws.addEventListener('message', resolve, { once: true });
  ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
});
ws.close();
console.log('[kiosk-reload] pagina herladen');
