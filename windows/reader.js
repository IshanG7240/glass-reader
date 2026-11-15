#!/usr/bin/env node
'use strict';
// Glass Reader on Windows: what main.js is in the Electron app, for Windows PCs where
// Electron can't run (Smart App Control blocks its unsigned electron.exe). Everything
// here runs on signed parts: Node, Windows PowerShell and Microsoft's WebView2.
//
//   reader.js  ── stdin/stdout ──  host.ps1 / host.cs   the window, shortcuts, tray icon
//      │
//      ├── http://127.0.0.1:<port>/<secret>/   the page (renderer/), documents, images
//      └── \\.\pipe\glass-reader-<user>        commands from claude-read, the Claude hook,
//                                              glass-reader.cmd (same arguments as main.js)
//
// Usage: node windows/reader.js [--background | --toggle | --show | --hide | --quit |
//                                --claude-picker | --queue FILE | FILE]
//        first start only: --toggle-key=Control+Alt+R --read-key=Control+Alt+C ('none' for none)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const claude = require('../bin/claude-to-reader.js');
const shared = require('../bin/shared-store.js');

const ROOT = path.join(__dirname, '..');
const MAX_BYTES = 300 * 1024 * 1024;
const CACHE = path.join(os.homedir(), '.cache', 'glass-reader');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.wasm': 'application/wasm',
};

// GR_DEBUG=1 logs to stdout and ~/.cache/glass-reader/debug.log, and turns on DevTools (F12).
const DEBUG = !!process.env.GR_DEBUG;
const debug = (...a) => {
  if (!DEBUG) return;
  const line = `${new Date().toTimeString().slice(0, 8)} [win] ${a.join(' ')}`;
  console.log(line);
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.appendFileSync(path.join(CACHE, 'debug.log'), line + '\n'); } catch { /* ignore */ }
};

// ---------- arguments (as in main.js) ----------

function parseArgs(argv, cwd = process.cwd()) {
  const out = { action: null, file: null };
  for (const a of argv) {
    if (a.startsWith('--capture=')) { out.action = 'capture'; out.capture = a.slice(10); continue; } // GR_DEBUG only
    if (a === '--toggle') out.action = 'toggle';
    else if (a === '--show') out.action = 'show';
    else if (a === '--hide') out.action = 'hide';
    else if (a === '--quit') out.action = 'quit';
    else if (a === '--queue') out.action = 'queue';
    else if (a === '--background') out.action = 'background';
    else if (a === '--claude-picker') out.action = 'picker';
    else if (a === '--fetching') out.action = 'fetching';
    else if (a.startsWith('--note=')) out.note = a.slice(7); // "title\nwords" from the Claude hook
    else if (a.startsWith('--toggle-key=')) out.toggleKey = a.slice(13);
    else if (a.startsWith('--read-key=')) out.readKey = a.slice(11);
    else if (!a.startsWith('-')) {
      const p = path.resolve(cwd, a);
      try { if (fs.statSync(p).isFile()) out.file = p; } catch { /* not a file */ }
    }
  }
  return out;
}

// ---------- state ----------

const token = crypto.randomBytes(18).toString('base64url');
let base = ''; // http://127.0.0.1:<port>/<token>
let host = null;
let hostReady = false;
let rendererReady = false;
let visible = false;
let inbox = null; // a new Claude answer waiting to be read
let queuedPath = null;
let pickerPending = false;
let lastOpenAt = 0;
const hotkeys = { toggle: 'Control+Alt+R', read: 'Control+Alt+C' };
const files = new Map(); // id -> path: the documents the page may fetch
const dialogs = new Map(); // open-file dialog id -> reply
let wallpaper = null;

const cmd = (o) => { if (host && !host.stdin.destroyed) host.stdin.write(JSON.stringify(o) + '\n'); };
const post = (m) => cmd({ c: 'post', json: JSON.stringify(m) });
const send = (ch, ...args) => post({ kind: 'event', ch, args });

// A document for the page: its bytes are fetched from our server, not pushed through
// the message channel (a 300 MB PDF would not enjoy that).
function docRef(p) {
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_BYTES) throw new Error('File is larger than 300 MB');
  const id = crypto.randomBytes(9).toString('base64url');
  files.set(id, p);
  if (files.size > 60) files.delete(files.keys().next().value);
  return { name: path.basename(p), path: p, size: st.size, url: `${base}/__file/${id}` };
}

// ---------- window ----------

function show({ skipInbox = false } = {}) {
  if (inbox && !skipInbox && !visible) { const p = inbox; inbox = null; sendOpen(p); }
  cmd({ c: 'show' });
  visible = true;
  send('shown');
}

function hide() { cmd({ c: 'hide' }); visible = false; }

function toggle(state = { visible, focused: visible }) {
  if (state.visible && state.focused) hide();
  else show();
}

function sendOpen(p) {
  lastOpenAt = Date.now();
  if (!rendererReady) { queuedPath = p; return; }
  try { send('open', docRef(p)); } catch (err) { send('error', String(err.message || err)); }
}

// New Claude answer: open it on the next show. If the reader is open right now, don't
// yank the page away; offer it instead (N opens it). Otherwise announce it from the tray.
function queue(p, note) {
  inbox = p;
  debug('queued', path.basename(p), 'visible=' + visible);
  if (visible && rendererReady) return send('inbox', path.basename(p));
  if (!note) return;
  const [title, words] = note.split('\n');
  const key = hotkeys.toggle && hotkeys.toggle !== 'none' ? `press ${hotkeys.toggle.replace('Control', 'Ctrl')}, or ` : '';
  cmd({
    c: 'balloon',
    title: `Claude’s answer is ready: ${title}`.slice(0, 63),
    text: `${Number(words || 0).toLocaleString()} words · ${key}click here to read`,
  });
}

function showPicker() {
  if (!rendererReady) { pickerPending = true; return; }
  let list = [];
  try { list = claude.sessionSummaries(); } catch (err) { debug('sessions:', err.message); }
  send('picker', list);
  show({ skipInbox: true });
}

// Ctrl+Alt+C: the Claude Code session in the window you were looking at (host.cs took a
// snapshot of it before showing anything), else the picker.
function readFocused(snap) {
  try {
    const table = snap ? claude.winTable(snap) : null;
    const f = table && table.fg !== host?.pid ? claude.focusedSessionWin(table) : {};
    debug('read-focused', table?.fg, JSON.stringify(table?.title || ''), f.session?.sessionId || (f.several ? `${f.several} sessions` : 'none'));
    const doc = f.session ? claude.docForSession(f.session.sessionId) : null;
    if (doc) { inbox = null; sendOpen(doc.file); return show({ skipInbox: true }); }
  } catch (err) { debug('read-focused failed:', err.message); }
  showPicker();
}

let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  cmd({ c: 'quit' });
  setTimeout(() => process.exit(0), 1500).unref();
  host?.once('exit', () => process.exit(0));
  if (!host) process.exit(0);
}

function handleArgs(argv, cwd) {
  const a = parseArgs(argv, cwd);
  debug('args', JSON.stringify(a));
  if (a.action === 'quit') return quit();
  if (a.action === 'capture' && DEBUG) return cmd({ c: 'capture', path: a.capture });
  if (a.action === 'queue' && a.file) return queue(a.file, a.note);
  if (a.action === 'picker') return showPicker();
  if (a.action === 'fetching') {
    if (rendererReady && Date.now() - lastOpenAt > 5000) send('fetching');
    return show({ skipInbox: true });
  }
  if (a.file) {
    inbox = null; // an explicitly opened file wins over a queued answer
    sendOpen(a.file);
    return a.action === 'background' ? undefined : show();
  }
  if (a.action === 'background') return undefined;
  if (a.action === 'hide') { if (rendererReady) send('fetching-off'); return hide(); }
  if (a.action === 'show') return show();
  return toggle();
}

// ---------- the page's requests ----------

async function onInvoke(ch, args) {
  switch (ch) {
    case 'open-dialog': {
      const id = crypto.randomUUID();
      const p = await new Promise((resolve) => { dialogs.set(id, resolve); cmd({ c: 'dialog', id }); });
      return p ? docRef(p) : null;
    }
    case 'read-path': try { return docRef(String(args[0])); } catch { return null; }
    case 'wallpaper': return wallpaper ? `${base}/__wallpaper` : null;
    case 'claude-sessions': try { return claude.sessionSummaries(); } catch { return []; }
    case 'claude-open':
      try {
        const doc = claude.docForSession(String(args[0]));
        if (!doc) return 'That session has no answers yet.';
        inbox = null;
        sendOpen(doc.file);
        return null;
      } catch (err) { return String(err.message || err); }
    default: return null;
  }
}

function onPage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.kind === 'invoke') {
    onInvoke(m.ch, m.args || []).then(
      (result) => post({ kind: 'reply', id: m.id, ch: m.ch, result: result ?? null }),
      () => post({ kind: 'reply', id: m.id, ch: m.ch, result: null }),
    );
    return;
  }
  switch (m.ch) {
    case 'hide': return hide();
    case 'quit': return quit();
    case 'log': return console.log('[renderer]', ...(m.args?.[0] || []));
    case 'open-inbox': if (inbox) { const p = inbox; inbox = null; sendOpen(p); } return;
    case 'persist': // settings and notes, kept as files (bin/shared-store.js)
      try { if (Array.isArray(m.args) && typeof m.args[0] === 'string') shared.save(m.args[0], m.args[1]); }
      catch (err) { console.error('saving', m.args?.[0], 'failed:', err.message); send('error', `Couldn't save to ${shared.DIR}: ${err.message}`); }
      return;
    case 'ready':
      rendererReady = true;
      if (queuedPath) { const p = queuedPath; queuedPath = null; sendOpen(p); }
      if (pickerPending) { pickerPending = false; showPicker(); }
      return;
  }
}

// ---------- the window host ----------

function startHost() {
  const args = ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
    '-File', path.join(__dirname, 'host.ps1'), '-Url', `${base}/renderer/index.html`];
  if (DEBUG) args.push('-DevTools');
  host = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  host.stdin.on('error', () => {});
  let buf = '';
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onHost(line);
    }
  });
  let err = '';
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (d) => { err += d; debug('host stderr:', d.trim()); });
  host.on('exit', (code) => {
    debug('host exited', code);
    if (!quitting) {
      console.error(`Glass Reader's window closed unexpectedly (code ${code}).${err ? '\n' + err.trim().slice(-1500) : ''}`);
      process.exit(1);
    }
  });
}

function onHost(line) {
  let m;
  try { m = JSON.parse(line); } catch { return debug('host says:', line); }
  switch (m.t) {
    case 'msg': return onPage(m.data);
    case 'state': visible = !!m.visible; return debug('visible', visible);
    case 'ready':
      hostReady = true;
      cmd({ c: 'hotkeys', ...hotkeys });
      return onHostReady?.();
    case 'hotkeys':
      if (m.failed?.length) {
        const msg = `Couldn't set up ${m.failed.join(' and ')}: another app is using ${m.failed.length > 1 ? 'them' : 'it'}. Choose others with scripts\\install-windows.ps1 -ToggleKey … -ReadKey …`;
        console.error(msg);
        cmd({ c: 'balloon', title: 'Glass Reader', text: msg });
      }
      return undefined;
    case 'hotkey':
      debug('hotkey', m.name, 'visible=' + m.visible, 'focused=' + m.focused);
      if (m.name === 'toggle') return toggle(m);
      if (m.name === 'read') return readFocused(m.snap);
      return undefined;
    case 'tray':
      if (m.item === 'show' || m.item === 'balloon') return show();
      if (m.item === 'open') { show(); return send('request-open'); }
      if (m.item === 'quit') return quit();
      return undefined;
    case 'dialog': { const r = dialogs.get(m.id); dialogs.delete(m.id); return r?.(m.path || null); }
    case 'error':
      console.error(m.message);
      return process.exit(1);
    default: return undefined;
  }
}
let onHostReady = null;

// ---------- the local server ----------

function findWallpaper() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], { encoding: 'utf8', windowsHide: true });
    const p = (out.match(/WallPaper\s+REG_\w+\s+(.+)/i)?.[1] || '').trim();
    if (/\.(png|jpe?g|webp|bmp)$/i.test(p) && fs.existsSync(p)) return p;
  } catch { /* no value */ }
  // Slideshows and Spotlight leave the value empty; Windows keeps a copy of what's shown.
  const t = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  return fs.existsSync(t) ? t : null;
}

function serveFile(res, p, type) {
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': type || MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(p).pipe(res);
  });
}

function onRequest(req, res) {
  const u = new URL(req.url, 'http://x');
  const prefix = `/${token}/`;
  if (req.method !== 'GET' || !u.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
  const rest = decodeURIComponent(u.pathname.slice(prefix.length));
  if (rest === '__shared') { // read by bridge.js before the page starts
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ dir: shared.DIR, values: shared.loadAll() }));
  }
  if (rest === '__wallpaper') return wallpaper ? serveFile(res, wallpaper, path.extname(wallpaper) ? undefined : 'image/jpeg') : res.writeHead(404).end();
  if (rest.startsWith('__file/')) { const p = files.get(rest.slice(7)); return p ? serveFile(res, p, 'application/octet-stream') : res.writeHead(404).end(); }
  if (rest === '__img') {
    // Images referenced by an open document (./diagram.png in Markdown). Images only.
    const p = u.searchParams.get('p') || '';
    return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(p) ? serveFile(res, path.resolve(p)) : res.writeHead(403).end();
  }
  const p = path.normalize(path.join(ROOT, rest));
  if (!p.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  return serveFile(res, p);
}

// ---------- start ----------

function forward(argv) {
  return new Promise((resolve) => {
    const c = net.createConnection(claude.IPC_PATH);
    const t = setTimeout(() => { c.destroy(); resolve(false); }, 1500);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ argv, cwd: process.cwd() }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(t); c.destroy(); resolve(buf.startsWith('ok')); } });
    c.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function main() {
  if (process.platform !== 'win32') { console.error('windows/reader.js is for Windows; use  npm start  elsewhere.'); process.exit(1); }
  const argv = process.argv.slice(2);
  // Already running? Hand the arguments over (like a second Electron instance would).
  if (await forward(argv)) process.exit(0);
  if (argv.includes('--quit')) process.exit(0);

  const pipe = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      try {
        const { argv: av, cwd } = JSON.parse(buf);
        if (Array.isArray(av) && av.every((x) => typeof x === 'string')) handleArgs(av, typeof cwd === 'string' ? cwd : ROOT);
        c.end('ok\n');
      } catch { c.end('bad\n'); }
    });
    c.on('error', () => {});
  });
  await new Promise((resolve) => {
    pipe.once('error', async () => { // lost a race with another start: hand over to that one
      process.exit((await forward(argv)) ? 0 : 1);
    });
    pipe.listen(claude.IPC_PATH, resolve);
  });

  // The page keeps your settings, reading positions and notes in localStorage, which
  // belongs to the page's origin, port included. So the port is the same every time: one
  // picked from your user name, or the next free one after it.
  const server = http.createServer(onRequest);
  const home = 41000 + (crypto.createHash('sha1').update(os.userInfo().username || 'user').digest().readUInt16BE(0) % 4000);
  for (let port = home, tries = 0; ; port++, tries++) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(tries < 25 ? port : 0, '127.0.0.1', () => resolve(true));
    });
    if (ok) break;
    if (tries >= 25) throw new Error("Couldn't open a local port for the reader");
  }
  base = `http://127.0.0.1:${server.address().port}/${token}`;
  wallpaper = findWallpaper();
  debug('serving', base.replace(token, '…'), 'wallpaper', wallpaper);

  const a = parseArgs(argv);
  if (a.toggleKey) hotkeys.toggle = a.toggleKey;
  if (a.readKey) hotkeys.read = a.readKey;
  onHostReady = () => {
    if (a.action === 'queue') queue(a.file, a.note);
    else if (a.file) sendOpen(a.file);
    if (a.action === 'picker') showPicker();
    else if (!['background', 'queue'].includes(a.action)) show();
  };
  startHost();
}

// Started detached by claude-read or the hook, whose pipes close when they exit.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
main().catch((err) => { console.error(err); process.exit(1); });
