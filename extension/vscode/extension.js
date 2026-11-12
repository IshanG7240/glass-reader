// Glass Reader for VS Code and Cursor.
//
// Lets the global Ctrl+Alt+C shortcut (bin/read-focused.js) read what you're looking
// at in the editor:
//   * records whether this window has focus in ~/.cache/glass-reader/focus/
//   * answers on a private Unix socket with the open file: the selection if you've
//     selected text, unsaved edits included; PDFs/EPUBs open as themselves; with no
//     editor open, the Claude Code session in the active terminal.
// No network port is opened.

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const DIR = path.join(os.homedir(), '.cache', 'glass-reader', 'focus');
const ID = `vscode-${process.pid}`;
const REC = path.join(DIR, ID + '.json');
const SOCK = path.join(DIR, ID + '.sock');
const READER_FILES = /\.(pdf|epub|docx|md|markdown|html?|txt)$/i;

let server = null;

function record(focused) {
  const data = { app: 'vscode', name: vscode.env.appName, owner: process.pid, sock: SOCK, focused: !!focused, t: Date.now() / 1000 };
  try {
    fs.writeFileSync(REC + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(REC + '.tmp', REC);
  } catch { /* ignore */ }
}

async function capture() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;

  // PDFs, images and other files shown by a custom viewer: open the file itself.
  if (input instanceof vscode.TabInputCustom && input.uri.scheme === 'file' && READER_FILES.test(input.uri.fsPath)) {
    return { kind: 'file', file: input.uri.fsPath, title: path.basename(input.uri.fsPath) };
  }

  let doc = null, editor = vscode.window.activeTextEditor;
  if (input instanceof vscode.TabInputText) doc = editor?.document.uri.toString() === input.uri.toString() ? editor.document : await vscode.workspace.openTextDocument(input.uri);
  else if (input instanceof vscode.TabInputWebview && /preview/i.test(tab.label)) {
    // Markdown preview: read the Markdown it shows.
    const name = tab.label.replace(/^\s*(Open\s+)?Preview\s+/i, '').replace(/^\[|\]$/g, '').trim();
    doc = vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && path.basename(d.fileName) === name) || null;
    editor = null;
  } else if (editor) doc = editor.document;

  if (!doc) {
    const term = vscode.window.activeTerminal;
    const pid = term && await term.processId;
    if (pid) return { kind: 'claude', pids: [pid] };
    return { error: 'No file is open.' };
  }

  const sel = editor && editor.document === doc ? editor.selection : null;
  const selection = !!(sel && !sel.isEmpty);
  const content = selection ? doc.getText(sel) : doc.getText();
  const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : null;
  const lang = doc.languageId;
  const kind = lang === 'markdown' ? 'markdown' : lang === 'html' ? 'html' : lang === 'plaintext' ? 'text' : 'code';
  const title = path.basename(doc.fileName) + (selection ? ' (selection)' : '');
  return { kind, lang, title, content, file, dirty: doc.isDirty, selection, base: file ? path.dirname(file) : undefined };
}

function activate(context) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  server = net.createServer((c) => {
    let buf = '';
    c.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      let r, req = {};
      try { req = JSON.parse(buf.split('\n')[0]); } catch { /* treat as capture */ }
      if (req.type === 'focus') return c.end(JSON.stringify({ focused: vscode.window.state.focused }));
      try { r = await capture(); } catch (e) { r = { error: String(e?.message || e) }; }
      c.end(JSON.stringify(r));
    });
    c.on('error', () => {});
  });
  const old = process.umask(0o177); // socket usable by you only
  server.listen(SOCK, () => { process.umask(old); record(vscode.window.state.focused); });

  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => record(s.focused)));
}

function deactivate() {
  try { server?.close(); } catch { /* ignore */ }
  for (const p of [SOCK, REC]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
}

module.exports = { activate, deactivate };
