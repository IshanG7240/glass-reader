// Native messaging host for the Glass Reader browser extension (extension/browser).
//
// The browser starts this when the extension connects, and it lives as long as the
// browser does. It does two things:
//   * records whether the browser window has focus (the extension reports changes) in
//     ~/.cache/glass-reader/focus/browser-<pid>.json
//   * listens on a private Unix socket next to it; when Ctrl+Alt+C asks
//     (bin/read-focused.js), it asks the extension for the current tab and passes the
//     answer back.
// No network port is opened. Messages to and from the browser use Chrome's native
// messaging framing: a 4-byte little-endian length, then JSON.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const DIR = path.join(os.homedir(), '.cache', 'glass-reader', 'focus');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DIR, 0o700); } catch { /* ignore */ }
const ID = `browser-${process.pid}`;
const REC = path.join(DIR, ID + '.json');
const SOCK = path.join(DIR, ID + '.sock');

// The browser that started us, for messages ("from Brave").
const name = (() => {
  try {
    const cmd = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8');
    if (/brave/i.test(cmd)) return 'Brave';
    if (/chromium/i.test(cmd)) return 'Chromium';
    if (/chrome/i.test(cmd)) return 'Chrome';
    if (/edge/i.test(cmd)) return 'Edge';
    if (/vivaldi/i.test(cmd)) return 'Vivaldi';
  } catch { /* ignore */ }
  return 'the browser';
})();

let state = { app: 'browser', name, owner: process.pid, sock: SOCK, focused: false, t: Date.now() / 1000 };
function record(patch) {
  state = { ...state, ...patch, t: Date.now() / 1000 };
  try {
    fs.writeFileSync(REC + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(REC + '.tmp', REC);
  } catch { /* ignore */ }
}

// ---------- browser side ----------

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

const waiting = new Map(); // capture id → resolve
let nextId = 1;
let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const n = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + n) break;
    let msg = null;
    try { msg = JSON.parse(inbuf.subarray(4, 4 + n).toString('utf8')); } catch { /* ignore */ }
    inbuf = inbuf.subarray(4 + n);
    if (!msg) continue;
    if (msg.type === 'focus') record({ focused: !!msg.focused });
    else if (msg.type === 'ack' && acked.has(msg.id)) acked.get(msg.id)();
    else if (msg.type === 'focusState' && waiting.has(msg.id)) { record({ focused: !!msg.focused }); waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else if (msg.type === 'page') {
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg.page); waiting.delete(msg.id); }
      else lateLog(msg); // answered after we gave up: note why it was slow
    }
  }
});
// The browser closed (or the extension was removed): clean up and go.
process.stdin.on('end', quit);
process.stdin.on('close', quit);

// ---------- reader side ----------

// The extension acks at once, then answers when the page is read. No ack means the
// extension itself is stuck (reload it); an ack but no answer means a slow page.
const acked = new Map();
const started = new Map();
function capture() {
  return new Promise((resolve) => {
    const id = nextId++;
    started.set(id, Date.now());
    let ack = false;
    acked.set(id, () => { ack = true; acked.delete(id); });
    const finish = (page) => { clearTimeout(t1); clearTimeout(t2); acked.delete(id); waiting.delete(id); resolve(page); };
    const t1 = setTimeout(() => { if (!ack) finish({ error: `${name}'s Glass Reader extension didn't respond. Reload it in ${name}'s extensions page.` }); }, 2500);
    const t2 = setTimeout(() => finish({ error: `The page took too long to read (over 20 s).` }), 20000);
    waiting.set(id, (page) => finish(page || { error: 'Nothing to read on this tab.' }));
    send({ type: 'capture', id });
  });
}

// Is a browser window focused right now? (Its focus events can arrive late.)
function focusNow() {
  return new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); resolve(null); }, 600);
    waiting.set(id, (m) => { clearTimeout(t); resolve(!!m.focused); });
    send({ type: 'focus?', id });
  });
}

function lateLog(msg) {
  try {
    const ms = Date.now() - (started.get(msg.id) || Date.now());
    const p = msg.page || {};
    const line = [new Date().toISOString().slice(0, 19), name, `LATE ${ms}ms`, p.kind || p.error || '', p.url || '', JSON.stringify(p.debug || '')].join('  ');
    fs.appendFileSync(path.join(os.homedir(), '.cache', 'glass-reader', 'capture.log'), line + '\n');
  } catch { /* ignore */ }
}

try { fs.unlinkSync(SOCK); } catch { /* not there */ }
const server = net.createServer((c) => {
  let buf = '';
  c.on('data', async (d) => {
    buf += d;
    if (!buf.includes('\n')) return;
    let req = {};
    try { req = JSON.parse(buf.split('\n')[0]); } catch { /* treat as capture */ }
    if (req.type === 'focus') return c.end(JSON.stringify({ focused: await focusNow() }));
    const page = await capture();
    c.end(JSON.stringify(page));
  });
  c.on('error', () => {});
});
const old = process.umask(0o177); // socket readable by you only
server.listen(SOCK, () => { process.umask(old); record({}); });

function quit() {
  try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
  try { fs.unlinkSync(REC); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
