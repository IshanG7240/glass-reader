#!/usr/bin/env node
'use strict';
// Opens a Claude Code conversation in Glass Reader: the whole session as one document,
// scrolled to the latest answer, with earlier prompts and answers above it.
//
//   claude-to-reader.js --hook          Claude Code "Stop" hook (JSON on stdin). Long answers
//                                       are queued in the reader and announced with a notification.
//   claude-to-reader.js --last          Open the session this runs in (`! claude-read`, which
//                                       Claude Code tags with CLAUDE_CODE_SESSION_ID).
//         --pid 123,456                 …or the session owning one of these processes
//                                       (the kitty shortcut passes the focused tab's processes).
//         --transcript F                …or a specific transcript file.
//         --print                       write the document and print its path; don't open it.
//   claude-to-reader.js --pick          Show the session picker in the reader.
//
// With --last, if no session can be identified the picker opens instead of guessing.
//
// Env: GR_CLAUDE_MIN_WORDS  answers shorter than this are ignored by the hook (default 250)
//      GR_CLAUDE_NOTIFY=0   no desktop notification
//
// Also loaded by the reader's main process (see main.js) for the session picker.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = os.homedir();
const LAUNCHER = path.join(__dirname, 'glass-reader');
const OUT_DIR = path.join(HOME, '.cache', 'glass-reader', 'claude');
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const KEEP = 40;
const MAX_TURNS = 150;
const MIN_WORDS = Number(process.env.GR_CLAUDE_MIN_WORDS || 250);

// ---------- transcript ----------

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}
const readEntries = (file) => parseLines(fs.readFileSync(file, 'utf8'));

// The last `bytes` of a transcript: enough for recent turns without reading a huge file.
function tailEntries(file, bytes = 3 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  if (size <= bytes) return readEntries(file);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  fs.readSync(fd, buf, 0, bytes, size - bytes);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  return parseLines(text.slice(text.indexOf('\n') + 1)); // drop the cut first line
}

const contentText = (c) => typeof c === 'string' ? c
  : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';

// Wrappers Claude Code puts around what you type: pasted text keeps its contents,
// editor context and reminders go.
const cleanPrompt = (t) => t
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '')
  .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, '$1')
  .trim();

// Something that woke Claude without you typing: a subagent's report or a finished
// background task. Returns a short label, or null.
function notificationLabel(t) {
  if (/<task-notification>/.test(t)) {
    const s = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    return s || 'A background task finished';
  }
  if (/<agent-message\b/.test(t)) {
    // The report itself, minus the harness's frame: its first line says what it is about.
    const report = t.split(/The report follows:\s*\n/)[1] || t.replace(/^[\s\S]*?<agent-message[^>]*>\s*/, '');
    const first = firstLine(report.replace(/<\/agent-message>[\s\S]*$/, ''), 90);
    return '\u2063' + (first ? `Report: ${first}` : /Subagent hand-back/.test(t) ? 'A subagent reported back' : 'Another session sent a message');
  }
  return null;
}

// What a user entry is: { kind: 'user', text } for a prompt you typed (slash commands
// included, as "/name args"), { kind: 'auto', text } for a notification, or null for
// tool results, shell input, local-command echoes and other plumbing.
function userInput(e, prev) {
  if (e.type !== 'user' || e.isSidechain) return null;
  const c = e.message?.content;
  const t = contentText(c) || (Array.isArray(c) && c.some((b) => b.type === 'image') ? ' ' : '');
  if (!t) return null;
  const note = notificationLabel(t);
  if (note) return { kind: 'auto', text: note };
  if (e.isMeta) return null; // a skill's expanded instructions, caveats
  const cmd = t.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  if (cmd) {
    // Local commands (/login, /model…) are preceded by a caveat and never reach Claude.
    if (/<local-command-caveat>/.test(contentText(prev?.message?.content))) return null;
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '').trim();
    return { kind: 'user', text: `/${cmd[1]}${args ? ' ' + args : ''}` };
  }
  // `! command` typed into Claude Code: Claude sees it and often answers it.
  const bash = t.match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return bash[1].trim() ? { kind: 'user', text: '! ' + bash[1].trim() } : null;
  const text = cleanPrompt(t);
  if (/^\s*<(bash-|local-command|user-memory)/.test(text) || /^\s*\[Request interrupted/.test(text)) return null;
  if (text) return { kind: 'user', text };
  // A pasted screenshot with nothing typed is still a prompt.
  return Array.isArray(c) && c.some((b) => b.type === 'image') ? { kind: 'user', text: '[Image]' } : null;
}

const STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

// The conversation as answers, oldest first. An answer is what Claude said when it
// stopped: the text after its last tool call (earlier text in a turn is "let me look
// at…" narration). Each stop is its own answer, so the updates a long-running session
// posts after each subagent or background task report are all kept, not just the last.
//
//   { prompt, extra, trigger, text, ts }
//   prompt   what you typed to start it ('' if a notification started it)
//   extra    messages you sent while Claude was already working
//   trigger  for answers you didn't prompt: what woke Claude
//
// Turns without an answer (still running, or interrupted) are left out.
function turns(entries) {
  const out = [];
  let cur = null, prev = null;
  const open = (ts) => (cur = { prompt: '', extra: [], triggers: [], trailing: [], all: [], ts });
  // Back into the turn that just ended: a cut-off answer Claude Code asks Claude to
  // resume, or an error notice about it, is part of that answer, not a new one.
  const reopen = (ts) => {
    if (!prev) return open(ts);
    if (prev.pushed) out.pop();
    cur = prev; prev = null;
    return cur;
  };
  const close = () => {
    if (!cur) return;
    prev = cur;
    const text = (cur.trailing.length ? cur.trailing : cur.all).join('\n\n').trim();
    if (text) {
      const extra = cur.extra.filter((x) => x !== cur.prompt);
      const prompt = cur.prompt || extra.shift() || '';
      // A finished task's summary names the agent; prefer it over its report's first line
      // (marked with an invisible U+2063 by notificationLabel).
      const named = cur.triggers.filter((x) => !x.startsWith('\u2063'));
      const trig = [...new Set(named.length ? named : cur.triggers.map((x) => x.slice(1)))];
      cur.pushed = true;
      out.push({ prompt, extra, trigger: prompt ? '' : !trig.length ? 'Claude continued' : trig[0] + (trig.length > 1 ? ` (+${trig.length - 1} more)` : ''), text, ts: cur.ts });
    }
    cur = null;
  };

  // Claude Code writes each block of a message (thinking, text, tool call) as its own
  // entry, all stamped with the message's stop reason. A stop counts once the message's
  // last entry is in, and only if no entry of it called a tool.
  const lastOf = new Map(), usesTool = new Set();
  entries.forEach((e, i) => {
    const id = e.type === 'assistant' && !e.isSidechain && e.message?.id;
    if (!id) return;
    lastOf.set(id, i);
    if (Array.isArray(e.message.content) && e.message.content.some((b) => b.type === 'tool_use')) usesTool.add(id);
  });

  entries.forEach((e, i) => {
    if (e.isSidechain) return;
    if (e.type === 'user') {
      if (e.isMeta && /^\s*Your response above was cut off/.test(contentText(e.message?.content))) { if (!cur) reopen(e.timestamp); return; }
      const u = userInput(e, entries[i - 1]);
      if (!u) return;
      if (u.kind === 'user') { close(); open(e.timestamp).prompt = u.text; }
      else (cur || open(e.timestamp)).triggers.push(u.text);
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      // Typed while Claude was busy: it reads it mid-turn, so it belongs to this turn.
      const a = e.attachment, p = typeof a.prompt === 'string' ? a.prompt : contentText(a.prompt);
      if (!p?.trim()) return;
      const note = notificationLabel(p);
      if (note) (cur || open(e.timestamp)).triggers.push(note);
      else if (a.origin?.kind === 'human' || a.commandMode === 'prompt') (cur || open(e.timestamp)).extra.push(cleanPrompt(p));
    } else if (e.type === 'assistant') {
      const c = e.message?.content;
      if (!Array.isArray(c)) return;
      const synthetic = e.message?.model === '<synthetic>'; // usage limits, API errors
      if (!cur) (synthetic ? reopen : open)(e.timestamp);
      for (const b of c) {
        if (b.type === 'tool_use') cur.trailing = [];
        else if (b.type === 'text' && b.text.trim()) {
          const t = synthetic ? `*${b.text.trim()}*` : b.text;
          cur.trailing.push(t); cur.all.push(t);
        }
      }
      const id = e.message?.id;
      const last = !id || lastOf.get(id) === i;
      if (last && STOPS.has(e.message?.stop_reason) && !(id ? usesTool.has(id) : c.some((b) => b.type === 'tool_use'))) close();
    } else if (e.type === 'system' && e.subtype === 'turn_duration') close();
  });
  close();
  return out;
}

// The session's title as Claude Code shows it: one you set (/rename), else the one
// it generated ("Fix flaky login tests"). Read from the raw text so the picker
// doesn't have to parse whole transcripts.
function transcriptTitle(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const last = (key) => {
    const re = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`, 'g');
    let m, v = '';
    while ((m = re.exec(text))) v = m[1];
    try { return v ? JSON.parse(v).trim() : ''; } catch { return ''; }
  };
  return { custom: last('customTitle'), ai: last('aiTitle') };
}

// Name to show: your own title, then a session name you chose, then the generated title,
// then Claude Code's derived name ("myapp-main-78").
function displayName(file, s) {
  const t = transcriptTitle(file) || {};
  const ownName = s?.name && s.nameSource && s.nameSource !== 'derived' ? s.name : '';
  return t.custom || ownName || t.ai || s?.name || '';
}

function transcripts() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(PROJECTS_DIR, dir.name))) {
      if (!f.endsWith('.jsonl')) continue; // subagent transcripts live in subfolders
      const p = path.join(PROJECTS_DIR, dir.name, f);
      out.push({ p, m: fs.statSync(p).mtimeMs, id: f.slice(0, -6) });
    }
  }
  return out;
}

function transcriptFor(sessionId, cwd) {
  if (cwd) {
    const p = path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return transcripts().find((t) => t.id === sessionId)?.p || null;
}

// ---------- live sessions ----------
// Claude Code keeps ~/.claude/sessions/<pid>.json for every running session
// (session id, folder, name, busy/idle). That maps a process to its conversation.

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Field 22 of /proc/<pid>/stat (start time), to tell a live session from a reused pid.
function procStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function liveSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    const s = readJSON(path.join(SESSIONS_DIR, f));
    if (!s?.sessionId || !s.pid) continue;
    const started = procStart(s.pid);
    if (!started || (s.procStart && String(s.procStart) !== started)) continue;
    out.push(s);
  }
  return out;
}

function parentMap() {
  const ppid = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      ppid.set(+d, +s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { /* exited */ }
  }
  return ppid;
}

// The session owning one of `pids`: the process itself, something it started
// (a shell's child), or something that started it (a tool command run by Claude).
function sessionForPids(pids) {
  const live = new Map(liveSessions().map((s) => [s.pid, s]));
  if (!live.size || !pids.length) return null;
  for (const p of pids) if (live.has(p)) return live.get(p);
  const ppid = parentMap();
  const comm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } };
  for (const p of pids) { // ancestors, up to the terminal itself
    for (let q = ppid.get(p), n = 0; q > 1 && n < 30; q = ppid.get(q), n++) {
      if (live.has(q)) return live.get(q);
      if (/^(kitty|gnome-terminal|alacritty|wezterm|foot|konsole|code|cursor)/.test(comm(q))) break;
    }
  }
  const kids = new Map();
  for (const [c, p] of ppid) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c); }
  const queue = [...pids];
  for (let n = 0; queue.length && n < 5000; n++) { // descendants, nearest first
    const p = queue.shift();
    if (live.has(p)) return live.get(p);
    queue.push(...(kids.get(p) || []));
  }
  return null;
}

const wordCount = (s) => (s.match(/\S+/g) || []).length;
const WHERE = { cli: 'Terminal', 'claude-desktop': 'Desktop app', 'claude-vscode': 'VS Code', vscode: 'VS Code' };

// Running sessions for the picker, most recently answered first.
function sessionSummaries() {
  const out = [];
  // A resumed conversation can be open in two processes; list it once.
  const byId = new Map();
  for (const s of liveSessions()) {
    const o = byId.get(s.sessionId);
    if (!o || (s.updatedAt || 0) > (o.updatedAt || 0)) byId.set(s.sessionId, s);
  }
  for (const s of byId.values()) {
    const transcript = transcriptFor(s.sessionId, s.cwd);
    if (!transcript) continue;
    let last = null, count = 0, at = 0;
    try {
      const t = turns(tailEntries(transcript, 1024 * 1024));
      count = t.length;
      last = t[t.length - 1] || null;
      at = Date.parse(last?.ts || '') || fs.statSync(transcript).mtimeMs;
    } catch { /* unreadable */ }
    out.push({
      sessionId: s.sessionId,
      name: displayName(transcript, s) || (s.cwd ? path.basename(s.cwd) : 'Claude session'),
      project: s.cwd ? path.basename(s.cwd) : '',
      where: WHERE[s.entrypoint] || (s.entrypoint ? s.entrypoint.replace(/^claude-/, '') : ''),
      status: s.status || '',
      at,
      prompt: last ? firstLine(last.prompt || last.trigger, 110) : '',
      words: last ? wordCount(last.text) : 0,
      answers: count,
    });
  }
  return out.sort((a, b) => (b.words > 0) - (a.words > 0) || b.at - a.at);
}

// ---------- the document ----------

function firstLine(s, max) {
  const l = (s.replace(/<!--[\s\S]*?-->/g, '').split('\n').find((x) => x.trim()) || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return l.length > max ? l.slice(0, max - 1).trimEnd() + '…' : l;
}
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Answer headings move down two levels so the prompts stay the top-level structure.
function demoteHeadings(md, by = 2) {
  let fence = null;
  return md.split('\n').map((l) => {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return l;
    }
    if (fence) return l;
    const m = l.match(/^(#{1,6})(\s)/);
    return m ? '#'.repeat(Math.min(6, m[1].length + by)) + l.slice(m[1].length) : l;
  }).join('\n');
}

const quote = (s) => s.split('\n').map((l) => '> ' + l.replace(/^(\s*)#/, '$1\\#')).join('\n');

function buildMarkdown(all, { name, cwd }) {
  const list = all.slice(-MAX_TURNS);
  const project = cwd ? path.basename(cwd) : '';
  const title = name || firstLine(list[0]?.prompt || '', 80) || 'Claude conversation';
  const time = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };
  const parts = [
    `# ${title}`,
    `*Claude${project ? ` · ${project}` : ''} · ${all.length} answer${all.length === 1 ? '' : 's'}${all.length > list.length ? ` (last ${list.length} shown)` : ''}*`,
  ];
  const clip = (p) => p.length > 1500 ? p.slice(0, 1500) + ' …' : p;
  list.forEach((t, i) => {
    const auto = !t.prompt;
    const head = firstLine(t.prompt || t.trigger || '', 120) || 'Claude’s answer';
    const meta = [time(t.ts), `${wordCount(t.text).toLocaleString()} words`].filter(Boolean).join(' · ');
    parts.push(i ? '---' : '');
    // Raw HTML heading: the id lets the reader find each prompt (and open at the last).
    // "-auto" marks an answer nobody prompted (the reader labels it "Update", not "You").
    parts.push(`<h2 id="gr-turn-${i + 1}${auto ? '-auto' : ''}">${escHtml(head)}</h2>`);
    const prompt = (t.prompt || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (prompt.replace(/\s+/g, ' ').length > head.length + 2) parts.push(quote(clip(prompt)));
    for (const x of t.extra || []) parts.push('*You added, while Claude was working:*', quote(clip(x)));
    parts.push(`*${meta}*`, demoteHeadings(t.text));
  });
  return parts.filter((p) => p !== '').join('\n\n') + '\n';
}

// Writes the session's document; returns its path, or null if there is nothing to read.
// One file per session, so reopening a session replaces its document.
function writeSessionDoc({ transcript, sessionId, name, cwd, session }) {
  const entries = readEntries(transcript);
  const all = turns(entries);
  if (!all.length) return null;
  cwd = cwd || entries.findLast?.((e) => e.cwd)?.cwd;
  name = displayName(transcript, session || (name ? { name } : null)) || name;
  sessionId = sessionId || path.basename(transcript, '.jsonl');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `session-${sessionId}.md`);
  fs.writeFileSync(file, buildMarkdown(all, { name, cwd }));
  pruneCache();
  return { file, last: all[all.length - 1] };
}

function pruneCache() {
  try {
    const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: fs.statSync(path.join(OUT_DIR, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(KEEP)) fs.unlinkSync(path.join(OUT_DIR, f));
  } catch { /* ignore */ }
}

// Document for a running (or recent) session by id, for the picker.
function docForSession(sessionId) {
  const s = liveSessions().find((x) => x.sessionId === sessionId);
  const transcript = transcriptFor(sessionId, s?.cwd);
  if (!transcript) return null;
  return writeSessionDoc({ transcript, sessionId, name: s?.name, cwd: s?.cwd, session: s });
}

// ---------- launching ----------

// Start the reader and wait briefly to see whether it worked. A second launch hands
// the request to the running reader and exits 0 almost at once; a first launch keeps
// running (it *is* the reader), so still running after a few seconds means it started.
function launch(argv) {
  return viaSocket(argv).then((ok) => ok ? { ok: true } : spawnLaunch(argv));
}

// The running reader listens on ~/.cache/glass-reader/reader.sock (main.js). Handing
// the request over there takes milliseconds; starting Electron again takes a second.
function viaSocket(argv) {
  return new Promise((resolve) => {
    const c = require('node:net').createConnection(path.join(HOME, '.cache', 'glass-reader', 'reader.sock'));
    const done = (ok) => { clearTimeout(t); c.destroy(); resolve(ok); };
    const t = setTimeout(() => done(false), 1500);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ argv, cwd: process.cwd() }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) done(buf.startsWith('ok')); });
    c.on('error', () => done(false));
  });
}

function spawnLaunch(argv) {
  return new Promise((resolve) => {
    const child = spawn('bash', [LAUNCHER, ...argv], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const done = (r) => { clearTimeout(timer); child.stderr.destroy(); child.unref(); resolve(r); };
    const timer = setTimeout(() => done({ ok: true }), 4000);
    child.on('exit', (code) => {
      if (code === 0) return done({ ok: true });
      const fatal = err.split('\n').find((l) => /FATAL|One-time setup|Error/.test(l)) || err.trim().split('\n').pop() || `exit code ${code}`;
      const hint = /sandbox/i.test(fatal) ? `\nFix once with:  sudo ${path.join(__dirname, '..', 'scripts', 'install-apparmor.sh')}` : '';
      done({ ok: false, error: fatal.replace(/^\[[^\]]*\]\s*/, '').trim() + hint });
    });
  });
}

function detached(cmd, argv) {
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Desktop notification with a "Read" button. Talks to the notification service over
// D-Bus directly (notify-send drops buttons in some sandboxed environments), then waits
// up to 15 minutes for the click. Falls back to a plain notify-send.
function notify(title, words) {
  if (process.env.GR_CLAUDE_NOTIFY === '0') return;
  const head = `Claude’s answer is ready: ${title}`;
  const body = `${words.toLocaleString()} words · press Ctrl+Alt+R, or click Read`;
  const gv = (s) => JSON.stringify(s); // a JSON string is a valid GVariant string literal
  const script = `
    if ! command -v gdbus >/dev/null; then exec notify-send -a "Glass Reader" "$1" "$2"; fi
    id=$(gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications \\
      --method org.freedesktop.Notifications.Notify '"Glass Reader"' 0 '"accessories-text-editor"' "$4" "$5" \\
      '["default", "Read", "read", "Read"]' '{}' 0 | grep -o '[0-9]\\+' | head -1)
    [ -n "$id" ] || exit 0
    exec 3< <(exec timeout 900 gdbus monitor --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications)
    mon=$!
    while read -r line <&3; do
      case "$line" in
        *"ActionInvoked (uint32 $id, 'read')"*|*"ActionInvoked (uint32 $id, 'default')"*) bash "$3" --show; break ;;
        *"NotificationClosed (uint32 $id,"*) break ;;
      esac
    done
    kill "$mon" 2>/dev/null`;
  detached('bash', ['-c', script, 'notify', head, body, LAUNCHER, gv(head), gv(body)]);
}

// Errors reach a terminal when there is one, and a notification when run from a shortcut.
function fail(msg) {
  console.error(msg);
  if (!process.stderr.isTTY) detached('notify-send', ['-a', 'Glass Reader', '-i', 'dialog-warning', 'Glass Reader', msg]);
  process.exitCode = 1;
}

// ---------- main ----------

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The kitty window with focus right now, or null. The record is written by
// kitty_focus_watcher.py; ignore it if the shell it names has gone.
function kittyFocus() {
  const f = readJSON(path.join(HOME, '.cache', 'glass-reader', 'kitty-focus.json'));
  if (!f || !f.focused || !(f.pid > 0)) return null;
  try { process.kill(f.pid, 0); } catch { return null; }
  return f;
}

async function main(args) {
  const has = (f) => args.includes(f);
  const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

  if (has('--hook')) {
    let input = {};
    try { input = JSON.parse(await readStdin() || '{}'); } catch { /* ignore */ }
    const transcript = input.transcript_path;
    if (!transcript || !fs.existsSync(transcript)) return;
    let last = null;
    for (let i = 0; i < 4; i++) { // the final message can land a moment after the hook fires
      last = turns(tailEntries(transcript)).pop();
      if (last?.text) break;
      await sleep(350);
    }
    if (!last?.text || wordCount(last.text) < MIN_WORDS) return;
    const s = liveSessions().find((x) => x.sessionId === input.session_id);
    const doc = writeSessionDoc({ transcript, sessionId: input.session_id, name: s?.name, cwd: input.cwd, session: s });
    if (!doc) return;
    detached('bash', [LAUNCHER, '--queue', doc.file]);
    notify(firstLine(last.prompt || last.trigger || '', 90) || 'Claude’s answer', wordCount(last.text));
    return;
  }

  const pick = async (why) => {
    const r = await launch(['--claude-picker']);
    if (!r.ok) return fail(`Glass Reader couldn't open: ${r.error}`);
    console.log(why ? `${why} Opened the session picker.` : 'Opened the session picker.');
  };
  if (has('--pick')) return pick();

  // Global shortcut: if a kitty window has focus (kitty_focus_watcher.py records it),
  // open the session in that tab; anywhere else, show the picker.
  if (has('--focused')) {
    const f = kittyFocus();
    if (!f) return pick();
    args.push('--pid', String(f.pid));
  }

  // Which conversation: an explicit transcript, the session owning a process
  // (kitty shortcut), or the session this command was typed in (`! claude-read`).
  let target = null;
  if (argVal('--transcript')) target = { transcript: argVal('--transcript') };
  else {
    let s = null;
    const pids = (argVal('--pid') || '').split(',').map(Number).filter((n) => n > 0);
    if (pids.length) s = sessionForPids(pids);
    const envId = process.env.CLAUDE_CODE_SESSION_ID;
    if (!s && envId) s = liveSessions().find((x) => x.sessionId === envId) || { sessionId: envId };
    if (s) {
      const transcript = transcriptFor(s.sessionId, s.cwd);
      if (transcript) target = { transcript, sessionId: s.sessionId, name: s.name, cwd: s.cwd, session: s };
    }
  }
  if (!target) return pick(argVal('--pid') ? 'No Claude Code session in this tab.' : 'Couldn’t tell which Claude Code session you mean.');

  const doc = writeSessionDoc(target);
  if (!doc) return pick('That session has no answers yet.');
  if (has('--print')) { console.log(doc.file); return; }
  const r = await launch([doc.file]);
  if (!r.ok) return fail(`Glass Reader couldn't open: ${r.error}`);
  console.log(`Opened in Glass Reader: "${firstLine(doc.last.prompt || doc.last.trigger || '', 60)}" (${wordCount(doc.last.text).toLocaleString()} words).`);
}

module.exports = { liveSessions, sessionSummaries, docForSession, sessionForPids, turns, buildMarkdown, main, launch, fail };

if (require.main === module) {
  const args = process.argv.slice(2);
  main(args).catch((err) => { console.error(err); process.exit(args.includes('--hook') ? 0 : 1); });
}
