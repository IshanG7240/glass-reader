// End-to-end check of dist/glass-reader.user.js, offline: Electron serves made-up
// ChatGPT, Claude and Gemini conversations under the real hostnames, with each site's
// real security headers (CSP, Trusted Types, COEP), runs the userscript the way a
// userscript manager does, taps the tab on the right edge, and screenshots the result.
//
//   npm run build:ios && npm run test:ios      → screenshots in ios/test/out/

'use strict';
// Run with plain node, this is the driver: one Electron process per case (several
// offscreen windows in one process crash Electron on some GPUs).
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const F = require('./fixtures');
  const want = process.argv.slice(2);
  let failed = 0;
  for (const site of Object.keys(F.pages)) {
    for (const size of ['ipad', 'ipad-portrait', 'iphone']) {
      const name = `${site}-${size}`;
      if (want.length && !want.some((o) => name.includes(o))) continue;
      const r = spawnSync(require('electron'), [__filename, name], { encoding: 'utf8', timeout: 90000 });
      const out = (r.stdout || '').split('\n').filter((l) => /^(ok|FAIL| {5})/.test(l));
      if (!out.some((l) => l.startsWith('ok'))) failed++;
      console.log(out.join('\n') || `FAIL ${name} (Electron exited: ${r.signal || r.status})`);
    }
  }
  console.log(failed ? `${failed} failed` : 'all passed', '· screenshots in ios/test/out/');
  process.exit(failed ? 1 : 0);
}
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const F = require('./fixtures');

const OUT = path.join(__dirname, 'out');
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'glass-reader.user.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = { ipad: [1180, 820], 'ipad-portrait': [820, 1180], iphone: [390, 844] };
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

async function serve(req) {
  const u = new URL(req.url);
  const site = F.sites[u.hostname];
  if (!site) return new Response('offline', { status: 404 });
  const hit = site.routes.find((r) => r.match.test(u.pathname));
  if (!hit) return new Response('not found: ' + u.pathname, { status: 404 });
  const body = typeof hit.body === 'function' ? hit.body(u) : hit.body;
  if (body?.__status) return new Response('', { status: body.__status });
  if (Buffer.isBuffer(body)) return new Response(body, { headers: { 'content-type': 'image/png', 'cross-origin-resource-policy': 'same-origin' } });
  const json = typeof body !== 'string';
  return new Response(json ? JSON.stringify(body) : body, {
    headers: { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', ...(json ? {} : site.headers) },
  });
}

async function run(name, url, [w, h]) {
  const win = new BrowserWindow({ width: w, height: h, show: false, webPreferences: { offscreen: true } });
  const errors = [];
  const js = (label, code) => win.webContents.executeJavaScript(`(async () => { try { return await (${code}); } catch (e) { return { __err: String(e.stack || e) }; } })()`)
    .then((r) => { if (r?.__err) throw new Error(`${label}: ${r.__err.slice(0, 300)}`); return r; });
  win.webContents.on('console-message', (e) => {
    const { level, message } = e;
    if (level === 'error' || /Refused|TrustedHTML|Trusted Type|violat/i.test(message)) errors.push(message.slice(0, 300));
  });
  await win.loadURL(url);
  const ran = await win.webContents.executeJavaScript(`(() => { try {\n${SCRIPT}\n; return 'ok'; } catch (e) { return String(e.stack || e); } })()`);
  if (ran !== 'ok') errors.push('userscript threw: ' + ran.slice(0, 300));
  await sleep(1200);
  const shot = async (label) => fs.writeFileSync(path.join(OUT, `${name}-${label}.png`), (await win.webContents.capturePage()).toPNG());
  await shot('1-page');

  // Tap the glass tab on the right edge.
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: w - 18, y: Math.round(h / 2), button: 'left', clickCount: 1 });
  await sleep(4500);
  const state = await js('state', `(() => {
    const f = document.querySelector('iframe[aria-label="Glass Reader"]');
    const gr = f?.contentWindow.__gr;
    const doc = gr?.st.doc;
    const B = f?.contentDocument.body;
    return {
      shown: !!f && f.style.display !== 'none',
      title: doc?.title, blocks: doc?.blocks.length,
      turns: doc?.blocks.filter((b) => b.anchor?.startsWith('gr-turn')).length,
      types: doc && Object.entries(doc.blocks.reduce((m, b) => (m[b.type] = (m[b.type] || 0) + 1, m), {})).map(([k, v]) => k + ':' + v).join(' '),
      math: f?.contentDocument.querySelectorAll('.katex').length,
      imgs: f ? [...f.contentDocument.querySelectorAll('.doc img')].filter((i) => i.complete && i.naturalWidth).length : 0,
      longest: doc ? Math.max(...doc.blocks.map((b) => (b.text || '').length)) : 0, // one giant paragraph = formatting lost
      pos: gr?.st.pos, theme: B?.dataset.theme,
      fonts: f && [...f.contentDocument.fonts].filter((x) => x.status === 'loaded').length,
      toast: f?.contentDocument.querySelector('#toast')?.textContent,
      backdrop: f?.style.backdropFilter || f?.style.webkitBackdropFilter,
    };
  })()`);
  await shot('2-reader');

  // Scroll to the top of the conversation, to see the earlier turns.
  await js('scroll', `document.querySelector('iframe[aria-label="Glass Reader"]').contentDocument.querySelector('.scroller')?.scrollTo(0, 0)`);
  await sleep(500);
  await shot('3-top');

  // A tap brings up the control bar.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: Math.round(h / 2) });
  await sleep(600);
  await shot('4-controls');

  // Escape closes it; the tab comes back.
  await js('focus', `document.querySelector('iframe[aria-label="Glass Reader"]').contentWindow.focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(1300);
  state.closed = await js('closed', `document.querySelector('iframe[aria-label="Glass Reader"]').style.display === 'none'`);
  win.destroy();
  return { state, errors };
}

app.whenReady().then(async () => {
  protocol.handle('https', serve);
  fs.mkdirSync(OUT, { recursive: true });
  let failed = 0;
  for (const [site, url] of Object.entries(F.pages)) {
    for (const [size, dims] of Object.entries(SIZES)) {
      const name = `${site}-${size}`;
      if (only.length && !only.includes(name)) continue;
      const { state, errors } = await run(name, url, dims).catch((e) => ({ state: {}, errors: ['harness: ' + (e.stack || e).toString().slice(0, 400)] }));
      const ok = state.shown && state.blocks > 5 && state.turns === F.expectTurns[site] && state.longest < 1500 && state.closed && !errors.length;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`, JSON.stringify(state));
      for (const e of errors) console.log('     ', e);
    }
  }
  app.exit(failed ? 1 : 0);
});
