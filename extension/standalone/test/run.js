// End-to-end check of the standalone extension (dist/glass-reader-extension/) in real
// Google Chrome, offline. A local proxy answers for chatgpt.com, claude.ai,
// gemini.google.com and a blog with made-up pages and each site's security headers
// (ios/test/fixtures.js), Chrome loads the extension, the toolbar button's handler runs
// on each page, and the result is checked and screenshotted.
//
//   npm run build:extension && npm run test:extension   → screenshots in extension/standalone/test/out/
//
// The test copy of the extension also gets <all_urls>: activeTab is granted by a real
// click on the button, which a test can't make.

'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const F = require('../../../ios/test/fixtures');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, 'out');
const CHROME = process.env.CHROME || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser']
  .find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = process.argv.slice(2);

// ---------- a blog post, for the "any page" path (Readability) ----------

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Why eigenvectors matter — The Linear Blog</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe</a></nav>
<header><p>The Linear Blog</p></header>
<main><article><h1>Why eigenvectors matter</h1><p class="byline">By A. Writer</p>
${Array.from({ length: 6 }, (_, i) => `<h2>Section ${i + 1}</h2>
<p>A matrix acts on vectors by stretching, rotating and shearing them. An eigenvector is a direction the matrix only stretches, and the stretch is its eigenvalue. Most directions get knocked off their line; eigenvectors stay on theirs, which is why they describe what a matrix does over and over.</p>
<p>Power iteration multiplies a vector by the matrix again and again; whatever it started as, it turns toward the eigenvector with the largest eigenvalue. That one fact explains PageRank, principal components, and why some dynamical systems settle down while others blow up.</p>
<ul><li>Stretch along one direction</li><li>Shrink along another</li></ul>`).join('\n')}
</article></main><footer><p>© The Linear Blog</p></footer></body></html>`;

const SITES = {
  ...F.sites,
  'linear.example': {
    headers: { 'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'self'" },
    routes: [{ match: /^\/posts\//, body: ARTICLE }],
  },
};
const PAGES = { ...F.pages, article: 'https://linear.example/posts/eigenvectors' };
const EXPECT = { ...F.expectTurns, article: 0 };

// ---------- the sites, behind a proxy ----------

function certificate(dir) {
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=test'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function sites(tls) {
  const site = https.createServer(tls, (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const s = SITES[host];
    const u = new URL(req.url, `https://${host}`);
    const hit = s?.routes.find((r) => r.match.test(u.pathname));
    if (!hit) { res.writeHead(404).end('not found'); return; }
    const body = typeof hit.body === 'function' ? hit.body(u) : hit.body;
    if (body?.__status) { res.writeHead(body.__status).end(); return; }
    if (Buffer.isBuffer(body)) { res.writeHead(200, { 'content-type': 'image/png', 'cross-origin-resource-policy': 'same-origin' }).end(body); return; }
    const json = typeof body !== 'string';
    res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', ...(json ? {} : s.headers) });
    res.end(json ? JSON.stringify(body) : body);
  });
  // Chrome sends everything through this proxy; every CONNECT goes to the server above.
  const proxy = http.createServer((req, res) => res.writeHead(404).end());
  proxy.on('connect', (req, sock) => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    site.emit('connection', sock);
  });
  return new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy)));
}

// ---------- Chrome, over the DevTools protocol (a pipe) ----------

function chrome(profile, proxyPort) {
  const p = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>',
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1280,860', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let id = 0, buf = '';
  const waiting = new Map(), listeners = [];
  p.stdio[4].on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.no(new Error(`${w.method}: ${m.error.message}`)) : w.ok(m.result); }
      else listeners.forEach((l) => l(m));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const n = ++id;
    waiting.set(n, { ok, no, method });
    p.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { send, on: (l) => listeners.push(l), kill: () => p.kill() };
}

// Runs code in a session and returns its value (awaiting promises).
const evaluate = async (c, sessionId, expression) => {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const STATE = `(() => {
  const f = document.querySelector('iframe[aria-label="Glass Reader"]');
  const D = f?.contentDocument;
  const blocks = D ? [...D.querySelectorAll('.doc > *')] : [];
  return {
    shown: !!f && f.style.display !== 'none',
    title: D?.querySelector('.doc h1')?.textContent.trim(),
    blocks: blocks.length,
    turns: D ? D.querySelectorAll('.doc .turn').length : 0,
    math: D ? D.querySelectorAll('.katex').length : 0,
    imgs: D ? [...D.querySelectorAll('.doc img')].filter((i) => i.complete && i.naturalWidth).length : 0,
    longest: Math.max(0, ...blocks.map((b) => b.textContent.length)),
    theme: D?.body.dataset.theme,
    fonts: D ? [...D.fonts].filter((x) => x.status === 'loaded').length : 0,
    toast: D?.querySelector('#toast')?.textContent,
    error: D?.querySelector('#error, .error')?.textContent?.trim().slice(0, 200) || undefined,
    tail: blocks.slice(-1)[0]?.textContent.trim().slice(0, 90),
  };
})()`;

async function main() {
  if (!CHROME) { console.error('No Chrome or Chromium found (set CHROME=/path/to/chrome).'); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ext-test-'));
  fs.mkdirSync(OUT, { recursive: true });
  // The extension as built, plus <all_urls> (see the top).
  const ext = path.join(tmp, 'ext');
  fs.cpSync(path.join(ROOT, 'dist', 'glass-reader-extension'), ext, { recursive: true });
  const man = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  man.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(man));

  const proxy = await sites(certificate(tmp));
  const c = chrome(path.join(tmp, 'profile'), proxy.address().port);
  const logs = [];
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && /^(error|warning)$/.test(m.params.type)) logs.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') logs.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  });
  let failed = 0;
  try {
    const { id } = await c.send('Extensions.loadUnpacked', { path: ext });
    await sleep(800);
    const sw = (await c.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
    if (!sw) throw new Error('the extension\'s service worker didn\'t start');
    const { sessionId: bg } = await c.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await c.send('Runtime.enable', {}, bg);

    for (const [name, url] of Object.entries(PAGES)) {
      if (want.length && !want.some((w) => name.includes(w))) continue;
      logs.length = 0;
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: s } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Runtime.enable', {}, s);
      await c.send('Page.enable', {}, s);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, s);
      await c.send('Page.navigate', { url }, s);
      await sleep(2500);
      let state = {};
      try {
        // The button's handler, on this tab.
        const click = `chrome.tabs.query({}).then((ts) => openIn(ts.find((t) => t.url === ${JSON.stringify(url)})))`;
        await evaluate(c, bg, click);
        await sleep(5000);
        state = await evaluate(c, s, STATE);
        const shot = await c.send('Page.captureScreenshot', { format: 'png' }, s);
        fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
        // The button again puts it away.
        await evaluate(c, bg, click);
        await sleep(800);
        state.closed = await evaluate(c, s, `document.querySelector('iframe[aria-label="Glass Reader"]').style.display === 'none'`);
      } catch (e) { logs.push('harness: ' + String(e.message || e).slice(0, 300)); }
      const ok = state.shown && state.blocks > 5 && state.turns === EXPECT[name] && state.longest < 1500 && state.closed && !state.error && !logs.length;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`, JSON.stringify(state));
      for (const l of logs) console.log('     ', l);
      await c.send('Target.closeTarget', { targetId });
    }
  } catch (e) {
    failed++;
    console.log('FAIL', e.message || e);
  } finally {
    c.kill();
    proxy.close();
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all passed', '· screenshots in', path.relative(process.cwd(), OUT));
  process.exit(failed ? 1 : 0);
}

main();
