// Every key the reader knows, in one place. The help sheet (?) is drawn from this list
// and the single-key commands are dispatched from it, so the two can't drift apart.
// Keys that a layout handles itself (arrows, Space, Home, End) are listed for the sheet
// only. `on` limits a row to some versions of the reader (see platformOf below).
//
//   show   what the sheet prints, one <kbd> each ('–' and '·' print as separators)
//   press  the KeyboardEvent.key values that run it (lower case for letters)
//   act    an ACT name in app.js, or (e) => ACT name, for keys whose Shift does the reverse

export const KEYMAP = [
  {
    group: 'Reading',
    rows: [
      { show: ['↑', '↓'], label: 'Scroll, or step a passage' },
      { show: ['Space'], label: 'Next page · with ⇧ the one before' },
      { show: ['←', '→'], label: 'Turn the page (Book, Focus, Cinema)' },
      { show: ['Home', 'End'], label: 'Beginning · end' },
      { show: ['P'], press: ['p'], act: 'play', label: 'Play / pause (Focus, Cinema, Prompter)' },
      { show: [',', '.'], press: [',', '<', '.', '>'], act: (e) => (e.key === ',' || e.key === '<' ? 'wpm-' : 'wpm+'), label: 'Slower · faster' },
    ],
  },
  {
    group: 'Layout & text',
    rows: [
      { show: ['1', '–', '5'], label: 'Column · Book · Focus · Cinema · Prompter' },
      { show: ['−', '+'], press: ['-', '_', '=', '+'], act: (e) => (e.key === '-' || e.key === '_' ? 'size-' : 'size+'), label: 'Text size' },
      { show: ['[', ']'], press: ['[', ']'], act: (e) => (e.key === '[' ? 'measure-' : 'measure+'), label: 'Line width' },
      { show: ['L', '·', '⇧L'], press: ['l'], act: (e) => (e.shiftKey ? 'lead-' : 'lead+'), label: 'Looser · tighter lines' },
      { show: ['F'], press: ['f'], act: 'font', label: 'Typeface' },
      { show: ['T'], press: ['t'], act: 'theme', label: 'Background' },
      { show: ['A'], press: ['a'], act: 'align', label: 'Ragged / justified' },
      { show: ['I'], press: ['i'], act: 'para', label: 'Spacing / book indents' },
      { show: ['H'], press: ['h'], act: 'hud', label: 'Pin / auto-hide the control bar' },
    ],
  },
  {
    group: 'Documents',
    rows: [
      { show: ['R'], label: 'History: everything you’ve read' },
      { show: ['⌫', '·', '⇧⌫'], label: 'Back · forward between documents' },
      { show: ['O'], label: 'Open a file', on: ['linux', 'windows', 'android', 'web', 'userscript', 'extension'] },
      { show: ['C'], label: 'Claude Code sessions', on: ['linux', 'windows'] },
      { show: ['C'], label: 'Read the page again (a chat that has grown)', on: ['userscript', 'extension'] },
      { show: ['N'], label: 'Claude’s new answer, when one is waiting', on: ['linux', 'windows'] },
    ],
  },
  {
    group: 'Notes',
    rows: [
      { show: ['M'], label: 'Show / hide the notes panel' },
      { show: ['S'], label: 'Add the selected text to your notes' },
    ],
  },
  {
    group: 'Window',
    rows: [
      { show: ['?'], label: 'This sheet' },
      { show: ['Esc'], label: 'Close what’s open, then hide the reader' },
      { show: ['Ctrl', '+', '−', '0'], label: 'Zoom the whole interface', on: ['linux', 'windows'] },
      { show: ['Ctrl', 'Q'], label: 'Quit', on: ['linux', 'windows'] },
    ],
  },
  {
    group: 'From anywhere',
    rows: [
      { show: ['Ctrl', 'Alt', 'C'], label: 'Read what you’re looking at', on: ['linux'] },
      { show: ['Ctrl', 'Alt', 'C'], label: 'Read the Claude Code session in front of you', on: ['windows'] },
      { show: ['Ctrl', 'Alt', 'R'], label: 'Show / hide the reader', on: ['linux', 'windows'] },
      { show: ['Ctrl', '⌥', 'C'], label: 'Read this conversation', on: ['userscript'] },
      { show: ['Alt', '⇧', 'R'], label: 'Read this page / put the reader away', on: ['extension'] },
    ],
  },
];

// Which version of the reader this is, from what its host put in window.reader.
export function platformOf(api) {
  if (!api) return 'web';
  if (api.inPage) return api.extension ? 'extension' : 'userscript';
  if (api.isAndroid) return 'android';
  if (api.isWindowsHost) return 'windows';
  return 'linux';
}

const shown = (row, platform) => !row.on || row.on.includes(platform);

// key → row, for the commands this table dispatches itself.
export function bindings(platform) {
  const map = new Map();
  for (const g of KEYMAP) for (const r of g.rows) if (r.act && r.press && shown(r, platform)) for (const k of r.press) map.set(k, r);
  return map;
}

export function renderHelp(el, platform, esc) {
  const kbd = (k) => (k === '–' || k === '·' ? `<i>${k}</i>` : `<kbd>${esc(k)}</kbd>`);
  el.innerHTML = KEYMAP.map((g) => {
    const rows = g.rows.filter((r) => shown(r, platform));
    if (!rows.length) return '';
    return `<section><h3>${esc(g.group)}</h3>${rows.map((r) =>
      `<div class="key"><span>${esc(r.label)}</span><b>${r.show.map(kbd).join('')}</b></div>`).join('')}</section>`;
  }).join('');
}
