#!/usr/bin/env node
// Ctrl+Alt+C: read whatever has focus.
//
// GNOME on Wayland won't tell apps which window has focus, so each app reports it
// itself, in ~/.cache/glass-reader/focus/:
//   kitty             kitty_focus_watcher.py   → the Claude Code session in that tab
//   VS Code / Cursor  extension/vscode         → the open file (or the selection)
//   Brave / Chrome    extension/browser        → the article, GitHub README, or selection
// Records can be stale, so at the key press the apps with a socket are asked directly;
// kitty's record is the fallback. VS Code
// and the browser are asked for their content over a private Unix socket. Nothing
// focused that we know → the Claude session picker.
//
// Usage:  read-focused.js [--print] [--from kitty|vscode|browser]
//   --print   write the document and print its path instead of opening it
//   --from    ask that app even if it doesn't have focus (for testing)

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const claude = require('./claude-to-reader.js');

const CACHE = path.join(os.homedir(), '.cache', 'glass-reader');
const FOCUS_DIR = path.join(CACHE, 'focus');
const OUT_DIR = path.join(CACHE, 'captures');
const KEEP = 40;
const READER_EXT = /\.(pdf|epub|docx|md|markdown|html?|txt)$/i;

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return pid > 0; } catch (e) { return e.code === 'EPERM'; } };

function records() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(FOCUS_DIR); } catch { /* none yet */ }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const r = readJSON(path.join(FOCUS_DIR, n));
    if (r && alive(r.owner)) { out.push(r); continue; }
    // Its app is gone (crashed or killed before it could clean up).
    if (r) for (const p of [path.join(FOCUS_DIR, n), r.sock]) { try { if (p) fs.unlinkSync(p); } catch { /* ignore */ } }
  }
  const k = readJSON(path.join(CACHE, 'kitty-focus.json')); // written by the kitty watcher
  if (k && k.pid > 0 && alive(k.pid)) out.push({ ...k, app: 'kitty' });
  return out;
}

function ask(sock, timeout = 8000, msg = { type: 'capture' }) {
  return new Promise((resolve) => {
    let buf = '';
    const c = net.createConnection(sock);
    const done = (v) => { clearTimeout(t); c.destroy(); resolve(v); };
    const t = setTimeout(() => done({ error: 'The app took too long to answer.' }), timeout);
    c.on('connect', () => c.write(JSON.stringify(msg) + '\n'));
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { try { done(JSON.parse(buf)); } catch { done({ error: 'The app sent nothing readable.' }); } });
    c.on('error', (e) => done({ error: e.message }));
  });
}

// ---------- turning a capture into a document ----------

const slug = (s) => (s || 'page').replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markdown images with relative paths: point them at the web (GitHub raw) or at the
// file's folder on disk, since the document is saved somewhere else.
function absolutizeMarkdown(md, base) {
  if (!base) return md;
  const fix = (u) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u)) return u;
    if (base.startsWith('/')) return path.resolve(base, u);
    try { return new URL(u, base.endsWith('/') ? base : base + '/').href; } catch { return u; }
  };
  return md
    .replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?/g, (_, a, u) => a + fix(u))
    .replace(/(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi, (_, a, q, u) => a + q + fix(u) + q);
}

// A unified diff (GitHub's .diff) as a document: what changed, then each file's
// changes as a diff block. Lockfiles, minified and huge files are listed but not shown.
const NOISY = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock)$|\.(min\.(js|css)|map|snap)$/;
const MAX_FILE_LINES = 800;

function parseDiff(diff) {
  const files = [];
  let f = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { f = { from: m[1], path: m[2], lines: [], add: 0, del: 0, status: 'modified', binary: false }; files.push(f); continue; }
    if (!f) continue;
    if (!f.lines.length) { // file header
      if (line.startsWith('new file')) { f.status = 'added'; continue; }
      if (line.startsWith('deleted file')) { f.status = 'deleted'; continue; }
      if (line.startsWith('rename from') || line.startsWith('similarity index')) { f.status = 'renamed'; continue; }
      if (line.startsWith('Binary files')) { f.binary = true; continue; }
      if (!line.startsWith('@@')) continue; // index, ---, +++, mode lines
    }
    f.lines.push(line);
    if (line.startsWith('+')) f.add++;
    else if (line.startsWith('-')) f.del++;
  }
  for (const x of files) while (x.lines.length && x.lines[x.lines.length - 1] === '') x.lines.pop();
  return files;
}

function diffMarkdown(r) {
  const files = parseDiff(r.diff || '');
  const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const out = [`# ${r.title || 'Changes'}`, '',
    `*${[r.scope, r.repo, `${files.length} file${files.length === 1 ? '' : 's'}`, `+${add} −${del}`].filter(Boolean).join(' · ')}*`, ''];
  if (r.intro) out.push(`<div>${r.intro}</div>`, '');
  if (files.length > 1) {
    out.push('## Files', '', '| File | + | − |', '| --- | ---: | ---: |');
    for (const f of files) out.push(`| ${cell(f.path)}${f.status !== 'modified' ? ` (${f.status})` : ''} | ${f.add} | ${f.del} |`);
    out.push('');
  }
  out.push('## Changes', '');
  for (const f of files) {
    out.push(`### ${f.path}`, '');
    const note = [f.status !== 'modified' ? f.status + (f.status === 'renamed' ? ` from ${f.from}` : '') : '', `+${f.add} −${f.del}`].filter(Boolean).join(' · ');
    out.push(`*${note}*`, '');
    if (f.binary) { out.push('*Binary file, not shown.*', ''); continue; }
    if (NOISY.test(f.path)) { out.push('*Generated or lock file, not shown.*', ''); continue; }
    if (f.lines.length > MAX_FILE_LINES) { out.push(`*${f.lines.length.toLocaleString()} lines of changes, too long to show here.*`, ''); continue; }
    if (!f.lines.length) continue;
    const body = f.lines.join('\n');
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`{3,}/g) || []).map((x) => x.length + 1)));
    out.push(fence + 'diff', body, fence, '');
  }
  if (r.url) out.push(`*From ${r.url}*`, '');
  return out.join('\n');
}

function writeDoc(r) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ext, body;
  const title = r.title || 'Untitled';
  if (r.kind === 'diff') {
    ext = 'md';
    body = diffMarkdown(r);
  } else if (r.kind === 'markdown') {
    ext = 'md';
    body = absolutizeMarkdown(r.content, r.base);
    if (!/^\s*#\s/m.test(body.split('\n').slice(0, 8).join('\n'))) body = `# ${title}\n\n${body}`;
  } else if (r.kind === 'code') {
    ext = 'md';
    const fence = '`'.repeat(Math.max(3, ...(r.content.match(/`{3,}/g) || []).map((f) => f.length + 1)));
    body = `# ${title}\n\n${fence}${r.lang || ''}\n${r.content.replace(/\n$/, '')}\n${fence}\n`;
  } else if (r.kind === 'text') {
    ext = 'txt';
    body = r.content;
  } else { // html
    ext = 'html';
    const meta = [r.byline, r.site || r.chat].filter(Boolean).map(esc).join(' · ');
    const src = r.url ? `<p><em>From <a href="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, ''))}</a></em></p>` : '';
    body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><article>` +
      `<h1>${esc(title)}</h1>${meta ? `<p><em>${meta}</em></p>` : ''}${r.content}${src}</article></body></html>`;
  }
  const file = path.join(OUT_DIR, `${slug(title.replace(/\.(md|markdown|txt|html?|[a-z0-9]{1,5})(?= \(selection\)|$)/i, ''))}.${ext}`);
  fs.writeFileSync(file, body);
  prune();
  return file;
}

function prune() {
  try {
    fs.readdirSync(OUT_DIR).map((n) => path.join(OUT_DIR, n))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)
      .slice(KEEP).forEach(({ p }) => fs.rmSync(p, { force: true }));
  } catch { /* ignore */ }
}

// One line per capture in ~/.cache/glass-reader/capture.log (last 200 kept), so a
// wrong page can be traced to the app, window and URL it came from.
function log(rec, r) {
  try {
    const f = path.join(CACHE, 'capture.log');
    const line = [new Date().toISOString().slice(0, 19), rec.name || rec.app, r.error ? 'ERROR ' + r.error : r.kind,
      r.url || r.file || '', JSON.stringify(r.title || ''),
      r.debug ? JSON.stringify(r.debug) : ''].join('  ').trimEnd();
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-199) : [];
    fs.writeFileSync(f, [...old, line].join('\n') + '\n');
  } catch { /* ignore */ }
}

// ---------- who has focus ----------

const byNewest = (a, b) => (b.t || 0) - (a.t || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The records can be stale: a focus event comes late or never (Brave after the reader
// hides, kitty windows opened before the watcher). So at the moment of the key press,
// ask the apps with a socket directly. true / false, or null if it can't say (an older
// extension, or no answer in time).
async function liveFocus(r) {
  if (!r.sock) return null;
  const a = await ask(r.sock, 700, { type: 'focus' });
  return typeof a?.focused === 'boolean' ? a.focused : null;
}

async function choose(all) {
  const apps = all.filter((r) => r.sock);
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = await Promise.all(apps.map(liveFocus));
    const now = apps.filter((r, i) => live[i] === true).sort(byNewest)[0];
    if (now) return { rec: now, how: 'live' };
    // Apps that couldn't answer: trust their record.
    const unsure = apps.filter((r, i) => live[i] === null && r.focused).sort(byNewest)[0];
    if (unsure) return { rec: unsure, how: 'record' };
    // Everyone with a socket says no. kitty (no socket) is the fallback, but a window
    // that just got focus back may not know yet: look again shortly before settling.
    const kitty = all.find((r) => r.app === 'kitty' && r.focused);
    if (!kitty || !apps.length || attempt === 2) return { rec: kitty || null, how: kitty ? 'kitty' : 'none' };
    await sleep(250);
  }
  return { rec: null, how: 'none' };
}

function logLine(fields) {
  try {
    const f = path.join(CACHE, 'capture.log');
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-199) : [];
    fs.writeFileSync(f, [...old, [new Date().toISOString().slice(0, 19), ...fields].join('  ')].join('\n') + '\n');
  } catch { /* ignore */ }
}

// ---------- main ----------

async function main(args) {
  const has = (f) => args.includes(f);
  const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const from = argVal('--from');
  const print = has('--print');

  const all = records();
  const { rec, how } = from ? { rec: all.filter((r) => r.app === from).sort(byNewest)[0], how: 'from' } : await choose(all);
  if (!print) logLine(['PICK', rec ? `${rec.name || rec.app} (${how})` : 'nothing focused → picker']);

  if (!rec) return print ? console.log('Nothing focused that Glass Reader knows; would open the picker.') : claude.main(['--pick']);
  if (rec.app === 'kitty') return claude.main(['--last', '--pid', String(rec.pid), ...(print ? ['--print'] : [])]);

  if (!print) claude.launch(['--fetching']); // reader up at once, blank, while we fetch
  const r = await ask(rec.sock, rec.app === 'browser' ? 23000 : 8000);
  log(rec, r);
  if (r.error) {
    if (print) return console.error(`${rec.name || rec.app}: ${r.error}`);
    // VS Code with nothing open: the Claude picker is a useful next step. Otherwise say
    // what went wrong and put the reader away, rather than showing something unrelated.
    if (rec.app === 'vscode' && /No file is open/.test(r.error)) return claude.main(['--pick']);
    claude.launch(['--hide']);
    return claude.fail(`${rec.name || rec.app}: ${r.error}`);
  }
  if (r.kind === 'claude') return claude.main(['--last', '--pid', r.pids.join(','), ...(print ? ['--print'] : [])]);

  // A saved file the reader understands opens as itself: relative images work and
  // your place in it is remembered.
  const file = r.kind === 'file' || (r.file && !r.dirty && !r.selection && READER_EXT.test(r.file)) ? r.file : writeDoc(r);
  if (print) { console.log(file); return; }
  const l = await claude.launch([file]);
  if (!l.ok) return claude.fail(`Glass Reader couldn't open: ${l.error}`);
  console.log(`Opened "${r.title || path.basename(file)}" from ${rec.name || rec.app}.`);
}

module.exports = { writeDoc, absolutizeMarkdown, records, parseDiff, diffMarkdown };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => { claude.fail(String(err.stack || err)); });
}
