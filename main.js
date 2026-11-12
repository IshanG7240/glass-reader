'use strict';
// Glass Reader — main process.
// Runs in the background, owns one full-screen overlay window that is
// created once and shown/hidden instantly (no launch delay on the hotkey).

const {
  app, BrowserWindow, ipcMain, dialog, protocol, Tray, Menu, nativeImage, shell, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const claude = require('./bin/claude-to-reader.js');

const ROOT = __dirname;
const MAX_BYTES = 300 * 1024 * 1024;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.md': 'text/markdown', '.map': 'application/json',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.wasm': 'application/wasm',
};

let win = null;

// ---------- interface zoom ----------
// Ctrl+= / Ctrl+− / Ctrl+0 (and Ctrl+scroll) scale the whole interface: text, control
// bar, dialogs. Saved by us, so a stray Ctrl+− can always be undone with Ctrl+0, and
// Chromium's own remembered zoom never leaves the app stuck small.
const ZOOM_FILE = () => path.join(app.getPath('userData'), 'zoom.json');
let zoom = 1;
function setupZoom() {
  try { zoom = Number(JSON.parse(fs.readFileSync(ZOOM_FILE(), 'utf8')).zoom) || 1; } catch { zoom = 1; }
  const wc = win.webContents;
  const apply = (z, say) => {
    zoom = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
    wc.setZoomFactor(zoom);
    try { fs.writeFileSync(ZOOM_FILE(), JSON.stringify({ zoom })); } catch { /* ignore */ }
    if (say) wc.send('toast', `Interface ${Math.round(zoom * 100)}%${zoom === 1 ? '' : ' · Ctrl+0 resets'}`);
  };
  wc.on('did-finish-load', () => { wc.setZoomFactor(zoom); wc.setVisualZoomLevelLimits(1, 1); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const k = input.key;
    if (k === '=' || k === '+') apply(zoom + 0.1, true);
    else if (k === '-' || k === '_') apply(zoom - 0.1, true);
    else if (k === '0') apply(1, true);
    else return;
    e.preventDefault(); // also keeps Electron's default menu from zooming on its own
  });
  wc.on('zoom-changed', (e, dir) => apply(zoom + (dir === 'in' ? 0.1 : -0.1), true));
}
let tray = null;
let wallpaper = null;
let rendererReady = false;
let queuedPath = null;
let inbox = null; // a new Claude answer waiting to be read
let pickerPending = false;

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}]);

// ---------- helpers ----------

// GR_DEBUG=1 logs to stdout and ~/.cache/glass-reader/debug.log.
const DEBUG_LOG = path.join(require('node:os').homedir(), '.cache', 'glass-reader', 'debug.log');
const debug = (...a) => {
  if (!process.env.GR_DEBUG) return;
  console.log('[main]', ...a);
  try { fs.appendFileSync(DEBUG_LOG, `${new Date().toTimeString().slice(0, 8)} ${a.join(' ')}\n`); } catch { /* ignore */ }
};

function parseArgs(argv, cwd = process.cwd()) {
  const out = { action: null, file: null };
  for (const a of argv.slice(1)) {
    if (a.startsWith('--capture=')) { out.action = 'capture'; out.capture = a.slice(10); continue; } // GR_DEBUG only
    if (a === '--toggle') out.action = 'toggle';
    else if (a === '--show') out.action = 'show';
    else if (a === '--hide') out.action = 'hide';
    else if (a === '--quit') out.action = 'quit';
    else if (a === '--queue') out.action = 'queue';
    else if (a === '--background') out.action = 'background';
    else if (a === '--claude-picker') out.action = 'picker';
    else if (a === '--fetching') out.action = 'fetching';
    else if (!a.startsWith('-')) {
      const p = path.resolve(cwd, a);
      try { if (p !== ROOT && fs.statSync(p).isFile()) out.file = p; } catch { /* not a file */ }
    }
  }
  return out;
}

function readDoc(p) {
  const st = fs.statSync(p);
  if (st.size > MAX_BYTES) throw new Error('File is larger than 300 MB');
  return { name: path.basename(p), path: p, size: st.size, data: fs.readFileSync(p) };
}

function gsettings(schema, key) {
  try { return execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8' }).trim().replace(/^'|'$/g, ''); }
  catch { return ''; }
}

function findWallpaper() {
  const dark = gsettings('org.gnome.desktop.interface', 'color-scheme').includes('dark');
  for (const key of dark ? ['picture-uri-dark', 'picture-uri'] : ['picture-uri', 'picture-uri-dark']) {
    const uri = gsettings('org.gnome.desktop.background', key);
    if (!uri.startsWith('file://')) continue;
    try {
      const p = fileURLToPath(uri);
      if (/\.(png|jpe?g|webp)$/i.test(p) && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

function serveFile(p) {
  try {
    const body = fs.readFileSync(p);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// ---------- window ----------

function createWindow() {
  // Not created fullscreen: on Wayland that maps (shows) the window immediately,
  // which would pop the overlay up on a --background start. Fullscreen is
  // applied in show() instead; the screen-sized bounds avoid a visible resize.
  const { width, height } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    title: 'Glass Reader',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false, // keep parsing documents while the overlay is hidden
    },
  });
  win.loadURL('app://local/renderer/index.html');
  setupZoom();
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); hide(); }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || process.env.GR_DEBUG) console.log(`[renderer ${e.level}]`, e.message);
    debug(`[renderer ${e.level}]`, e.message.slice(0, 300));
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function show({ skipInbox = false } = {}) {
  if (!win) return;
  if (inbox && !skipInbox && !win.isVisible()) { const p = inbox; inbox = null; sendOpen(p); }
  win.show();
  win.setFullScreen(true);
  win.focus();
  win.webContents.send('shown');
}

function hide() {
  if (win && win.isVisible()) win.hide();
}

function toggle() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) hide();
  else show();
}

let lastOpenAt = 0;
function sendOpen(p) {
  lastOpenAt = Date.now();
  if (!rendererReady) { queuedPath = p; return; }
  try { win.webContents.send('open', readDoc(p)); }
  catch (err) { win.webContents.send('error', String(err.message || err)); }
}

// New Claude answer: open it on the next show. If the reader is open right now,
// don't yank the page away; offer it instead (N opens it).
function queue(p) {
  inbox = p;
  debug('queued', path.basename(p), 'visible=' + win?.isVisible());
  if (win?.isVisible() && rendererReady) win.webContents.send('inbox', path.basename(p));
}

// The Claude session picker: running sessions, newest answer first.
function showPicker() {
  if (!rendererReady) { pickerPending = true; return; }
  let list = [];
  try { list = claude.sessionSummaries(); } catch (err) { console.warn('sessions:', err.message); }
  win.webContents.send('picker', list);
  show({ skipInbox: true });
}

function quit() {
  app.isQuitting = true;
  app.quit();
}

// A tiny tray glyph drawn in code (a page with lines) so no image asset is needed.
function trayIcon() {
  const S = 22;
  const buf = Buffer.alloc(S * S * 4);
  const set = (x, y) => { const i = (y * S + x) * 4; buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 255; };
  for (let x = 4; x <= 17; x++) { set(x, 3); set(x, 18); }
  for (let y = 3; y <= 18; y++) { set(4, y); set(17, y); }
  for (let x = 7; x <= 14; x++) { set(x, 7); set(x, 10); }
  for (let x = 7; x <= 11; x++) set(x, 13);
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Glass Reader');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show reader', click: show },
      {
        label: 'Open file…',
        click: async () => {
          show();
          win.webContents.send('request-open');
        },
      },
      { type: 'separator' },
      { label: 'Quit Glass Reader', click: quit },
    ]));
  } catch (err) {
    console.warn('Tray unavailable:', err.message);
  }
}

// ---------- IPC ----------

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a document',
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt', 'docx', 'epub', 'html', 'htm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readDoc(r.filePaths[0]);
});
ipcMain.handle('read-path', (_e, p) => {
  try { return readDoc(p); } catch { return null; }
});
ipcMain.handle('wallpaper', () => (wallpaper ? 'app://local/__wallpaper' : null));
ipcMain.on('hide', hide);
ipcMain.on('open-inbox', () => { if (inbox) { const p = inbox; inbox = null; sendOpen(p); } });
ipcMain.handle('claude-sessions', () => { try { return claude.sessionSummaries(); } catch { return []; } });
ipcMain.handle('claude-open', (_e, id) => {
  try {
    const doc = claude.docForSession(String(id));
    if (!doc) return 'That session has no answers yet.';
    inbox = null;
    sendOpen(doc.file);
    return null;
  } catch (err) { return String(err.message || err); }
});
ipcMain.on('quit', quit);
ipcMain.on('log', (_e, ...a) => console.log('[renderer]', ...a));
ipcMain.on('ready', () => {
  rendererReady = true;
  if (queuedPath) { const p = queuedPath; queuedPath = null; sendOpen(p); }
  if (pickerPending) { pickerPending = false; showPicker(); }
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Second launch (e.g. from the GNOME hotkey) talks to the running instance.
  app.on('second-instance', (_e, argv, cwd) => handleArgs(argv, cwd));
  const handleArgs = (argv, cwd) => {
    const a = parseArgs(argv, cwd);
    debug('second-instance', JSON.stringify(a), 'visible=' + win?.isVisible(), 'focused=' + win?.isFocused());
    if (a.action === 'quit') return quit();
    if (a.action === 'capture' && process.env.GR_DEBUG) {
      // Debugging aid: save a screenshot of the overlay (works on Wayland, where screen capture is restricted).
      win.webContents.invalidate();
      return setTimeout(() => win.webContents.capturePage().then((img) => fs.writeFileSync(a.capture, img.toPNG())), 400);
    }
    if (a.action === 'queue' && a.file) return queue(a.file);
    if (a.action === 'picker') return showPicker();
    if (a.action === 'fetching') { // Ctrl+Alt+C: something is on its way; don't show the old page meanwhile
      // The page can beat this signal here (two separate launches); then it's already open.
      if (rendererReady && Date.now() - lastOpenAt > 5000) win.webContents.send('fetching');
      return show({ skipInbox: true });
    }
    if (a.file) {
      inbox = null; // an explicitly opened file wins over a queued answer
      sendOpen(a.file);
      return a.action === 'background' ? undefined : show();
    }
    if (a.action === 'background') return undefined; // already running
    if (a.action === 'hide') { if (rendererReady) win.webContents.send('fetching-off'); return hide(); }
    if (a.action === 'show') return show();
    return toggle();
  };

  // A faster door than a second instance: scripts (Ctrl+Alt+C, the Claude hook) hand
  // their arguments over this socket in milliseconds instead of starting Electron
  // again (about a second). Your user only; same arguments as the command line.
  const sock = path.join(require('node:os').homedir(), '.cache', 'glass-reader', 'reader.sock');
  try { fs.unlinkSync(sock); } catch { /* not there */ }
  const server = require('node:net').createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      try {
        const { argv, cwd } = JSON.parse(buf);
        if (Array.isArray(argv) && argv.every((x) => typeof x === 'string')) handleArgs(['electron', '.', ...argv], typeof cwd === 'string' ? cwd : ROOT);
        c.end('ok\n');
      } catch { c.end('bad\n'); }
    });
    c.on('error', () => {});
  });
  app.whenReady().then(() => {
    const old = process.umask(0o177);
    server.listen(sock, () => process.umask(old));
  });
  app.on('will-quit', () => { try { server.close(); fs.unlinkSync(sock); } catch { /* ignore */ } });

  app.on('window-all-closed', () => { /* stay alive in the background */ });

  app.whenReady().then(() => {
    wallpaper = findWallpaper();
    protocol.handle('app', (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/__wallpaper') return wallpaper ? serveFile(wallpaper) : new Response('', { status: 404 });
      if (u.pathname === '/__img') {
        // Images referenced by an open document (e.g. ./diagram.png in Markdown). Images only.
        const p = u.searchParams.get('p') || '';
        return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(p) ? serveFile(p) : new Response('forbidden', { status: 403 });
      }
      const p = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
      if (!p.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return serveFile(p);
    });
    createWindow();
    createTray();
    const a = parseArgs(process.argv);
    debug('first-instance', JSON.stringify(a), JSON.stringify(process.argv.slice(1)));
    if (a.action === 'queue') inbox = a.file;
    else if (a.file) sendOpen(a.file);
    if (a.action === 'picker') showPicker();
    else if (!['background', 'queue'].includes(a.action)) win.once('ready-to-show', () => show());
  });
}
