'use strict';
// Your reader settings and notes as files, so they belong to you and not to a browser
// profile: they survive reinstalling, clearing app data, and a change of the reader's
// local address. Used by the desktop apps (main.js, windows/reader.js); the page keeps a
// copy in its localStorage and hands every change here (api.persist in renderer/app.js).
//
//   <dir>/settings.json    theme, layout, text size…
//   <dir>/notes.json       your notes (the source of truth)
//   <dir>/notes.md         the same notes as Markdown, rewritten on every change, to read anywhere
//   <dir>/notes-ui.json    where the notes panel sits
//   <dir>/history.json     what you've read (titles, where they came from, how far you got)
//   <dir>/backups/         notes.json as it was before deletions, and at most hourly otherwise
//
// <dir> is GR_DATA_DIR, else Documents/Glass Reader, else ~/.local/share/glass-reader.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILES = { 'gr:settings': 'settings.json', 'gr:notes': 'notes.json', 'gr:notes-ui': 'notes-ui.json', 'gr:history': 'history.json' };
const KEEP_BACKUPS = 40;

// The real Documents folder: on Windows it is often moved (into OneDrive, say), so
// ask the registry; on Linux, xdg-user-dir.
function documentsDir() {
  const { execFileSync } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
        { encoding: 'utf8', windowsHide: true });
      const raw = (out.match(/Personal\s+REG_\w+\s+(.+)/i)?.[1] || '').trim();
      const p = raw.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
      if (p && fs.existsSync(p)) return p;
    } else if (process.platform === 'linux') {
      const p = execFileSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8' }).trim();
      if (p && p !== os.homedir() && fs.existsSync(p)) return p;
    }
  } catch { /* fall back */ }
  const docs = path.join(os.homedir(), 'Documents');
  return fs.existsSync(docs) ? docs : null;
}

function dataDir() {
  if (process.env.GR_DATA_DIR) return process.env.GR_DATA_DIR;
  const docs = documentsDir();
  return docs ? path.join(docs, 'Glass Reader') : path.join(os.homedir(), '.local', 'share', 'glass-reader');
}
const DIR = dataDir();

// An earlier version used ~/Documents even where Documents lives elsewhere: bring its files over.
(function adoptOld() {
  const old = path.join(os.homedir(), 'Documents', 'Glass Reader');
  if (path.resolve(old) === path.resolve(DIR) || !fs.existsSync(old) || fs.existsSync(path.join(DIR, 'settings.json'))) return;
  try { fs.cpSync(old, DIR, { recursive: true, force: false }); fs.rmSync(old, { recursive: true, force: true }); } catch { /* leave both */ }
})();
const file = (k) => path.join(DIR, FILES[k]);

// Everything stored, as { key: value }. A damaged file is set aside, not lost.
function loadAll() {
  const out = {};
  for (const k of Object.keys(FILES)) {
    let raw;
    try { raw = fs.readFileSync(file(k), 'utf8'); } catch { continue; }
    try { out[k] = JSON.parse(raw); } catch {
      try { fs.renameSync(file(k), file(k) + `.damaged-${stamp()}`); } catch { /* leave it */ }
    }
  }
  return out;
}

const stamp = () => { // local time, 20261115-170643
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

// Write to a temporary file, then rename over: a crash mid-write never leaves half a file.
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function backupNotes(prev, next) {
  if (!Array.isArray(prev) || !prev.length) return;
  const dir = path.join(DIR, 'backups');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^notes-.*\.json$/.test(f)).sort(); } catch { /* none yet */ }
  const nextIds = new Set((Array.isArray(next) ? next : []).map((n) => n.id));
  const deleted = prev.some((n) => !nextIds.has(n.id));
  let lastAt = 0;
  try { if (names.length) lastAt = fs.statSync(path.join(dir, names[names.length - 1])).mtimeMs; } catch { /* ignore */ }
  if (!deleted && Date.now() - lastAt < 3600e3) return;
  writeAtomic(path.join(dir, `notes-${stamp()}${deleted ? '-before-delete' : ''}.json`), JSON.stringify(prev, null, 1));
  names = fs.readdirSync(dir).filter((f) => /^notes-.*\.json$/.test(f)).sort();
  for (const f of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
}

function notesMarkdown(notes) {
  const out = ['# Glass Reader notes', `*${notes.length} note${notes.length === 1 ? '' : 's'} · updated ${new Date().toLocaleString()}*`];
  const byDoc = new Map();
  for (const n of notes) {
    const t = n.title || 'Not from a document';
    if (!byDoc.has(t)) byDoc.set(t, []);
    byDoc.get(t).push(n);
  }
  for (const [title, list] of byDoc) {
    out.push(`## ${title}`);
    for (const n of list) {
      if (n.kind === 'clip') {
        out.push(String(n.text || '').split('\n').map((l) => '> ' + l).join('\n'));
        if (n.comment?.trim()) out.push(n.comment.trim());
      } else out.push(String(n.text || '').trim());
    }
  }
  return out.join('\n\n') + '\n';
}

// One change from the page. Returns false for keys that aren't kept as files.
function save(k, v) {
  if (!FILES[k]) return false;
  if (k === 'gr:notes') {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file(k), 'utf8')); } catch { /* first save */ }
    try { backupNotes(prev, v); } catch (err) { console.warn('notes backup:', err.message); }
    writeAtomic(file(k), JSON.stringify(v, null, 1));
    try { writeAtomic(path.join(DIR, 'notes.md'), notesMarkdown(Array.isArray(v) ? v : [])); } catch { /* the JSON is what counts */ }
  } else writeAtomic(file(k), JSON.stringify(v, null, 1));
  return true;
}

module.exports = { DIR, FILES, loadAll, save };
