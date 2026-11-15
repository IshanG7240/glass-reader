// Notes: a floating panel beside the page. Select text and press S (or the "Add to notes"
// button that appears by the selection) to keep it; write your own notes underneath.
// The panel can be dragged by its header, resized from its edges and corners, and
// collapsed to its header. Everything is kept in localStorage: the notes, and where the
// panel sits.
//
//   initNotes({ store, toast, doc: () => ({ id, title } | null), jump: (block, text) => void,
//               where: 'where notes are kept, shown at the panel's foot' })
//   returns { toggle(), open(), addSelection() }

const NOTES_KEY = 'gr:notes';
const UI_KEY = 'gr:notes-ui';
const MIN_W = 260, MIN_H = 180, HEAD_H = 46, MARGIN = 8;

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function when(t) {
  const d = new Date(t);
  if (isNaN(d)) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toTimeString().slice(0, 5) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toTimeString().slice(0, 5);
}

export function initNotes({ store, toast, doc, jump, where = '' }) {
  let notes = store.get(NOTES_KEY, []);
  if (!Array.isArray(notes)) notes = [];
  const ui = {
    open: false, collapsed: false, scope: 'doc',
    w: 380, h: Math.min(560, innerHeight - 200), x: null, y: 84,
    ...store.get(UI_KEY, {}),
  };
  const saveNotes = () => store.set(NOTES_KEY, notes);
  const saveUi = () => store.set(UI_KEY, ui);

  // ---------- markup ----------

  const panel = document.createElement('aside');
  panel.id = 'notes';
  panel.setAttribute('aria-label', 'Notes');
  panel.innerHTML = `
    <header class="notes-head" title="Drag to move · double-click to collapse">
      <span class="notes-title">Notes <span class="notes-count"></span></span>
      <div class="notes-scope" role="tablist">
        <button data-scope="doc" title="Notes from this document">This doc</button>
        <button data-scope="all" title="Notes from every document">All</button>
      </div>
      <span class="notes-tools">
        <button data-n="clear" title="Delete all these notes" aria-label="Delete all these notes">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button data-n="copy" title="Copy these notes as Markdown" aria-label="Copy as Markdown">
          <svg viewBox="0 0 24 24" width="15" height="15"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>
        </button>
        <button data-n="collapse" title="Collapse / expand" aria-label="Collapse">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button data-n="close" title="Close (M)" aria-label="Close notes">
          <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </span>
    </header>
    <div class="notes-body">
      <div class="notes-list"></div>
      <div class="notes-compose">
        <textarea rows="2" placeholder="Write a note…  Enter adds it · Shift+Enter for a new line"></textarea>
        <div class="notes-where"></div>
      </div>
      <div class="notes-confirm" hidden>
        <span></span>
        <button data-n="clear-yes" class="danger">Delete</button>
        <button data-n="clear-no">Cancel</button>
      </div>
    </div>
    <i class="notes-grip" data-dir="l"></i><i class="notes-grip" data-dir="r"></i><i class="notes-grip" data-dir="b"></i>
    <i class="notes-grip" data-dir="lb"></i><i class="notes-grip" data-dir="rb"></i>`;
  document.body.append(panel);

  const clipBtn = document.createElement('button');
  clipBtn.id = 'clip-btn';
  clipBtn.type = 'button';
  clipBtn.hidden = true;
  clipBtn.innerHTML = '<span>+</span> Add to notes <kbd>S</kbd>';
  document.body.append(clipBtn);

  const list = panel.querySelector('.notes-list');
  const compose = panel.querySelector('.notes-compose textarea');
  const head = panel.querySelector('.notes-head');
  const confirmBar = panel.querySelector('.notes-confirm');
  const whereEl = panel.querySelector('.notes-where');
  whereEl.textContent = where ? `Saved in ${where}` : '';
  whereEl.title = where;

  // ---------- geometry ----------

  function place() {
    const w = clamp(ui.w, MIN_W, innerWidth - 2 * MARGIN);
    const h = clamp(ui.h, MIN_H, innerHeight - 2 * MARGIN);
    if (ui.x == null) ui.x = innerWidth - w - 24;
    const x = clamp(ui.x, MARGIN, innerWidth - w - MARGIN);
    const y = clamp(ui.y, MARGIN, innerHeight - (ui.collapsed ? HEAD_H : h) - MARGIN);
    Object.assign(panel.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: ui.collapsed ? '' : h + 'px' });
    panel.classList.toggle('collapsed', ui.collapsed);
    panel.hidden = !ui.open;
  }
  addEventListener('resize', place);

  // Drag by the header (not its buttons).
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    panel.classList.add('moving');
    const move = (ev) => { ui.x = ev.clientX - dx; ui.y = ev.clientY - dy; place(); };
    const up = () => {
      head.removeEventListener('pointermove', move);
      panel.classList.remove('moving');
      const p = panel.getBoundingClientRect();
      ui.x = p.left; ui.y = p.top;
      saveUi();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up, { once: true });
    head.addEventListener('pointercancel', up, { once: true });
  });
  head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setCollapsed(!ui.collapsed); });

  // Resize from the edges and bottom corners.
  for (const g of panel.querySelectorAll('.notes-grip')) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = g.dataset.dir;
      const r = panel.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      g.setPointerCapture(e.pointerId);
      panel.classList.add('moving');
      const move = (ev) => {
        const ddx = ev.clientX - sx, ddy = ev.clientY - sy;
        if (dir.includes('r')) ui.w = clamp(r.width + ddx, MIN_W, innerWidth - r.left - MARGIN);
        if (dir.includes('l')) {
          const w = clamp(r.width - ddx, MIN_W, r.right - MARGIN);
          ui.x = r.right - w; ui.w = w;
        }
        if (dir.includes('b') && !ui.collapsed) ui.h = clamp(r.height + ddy, MIN_H, innerHeight - r.top - MARGIN);
        place();
      };
      const up = () => { g.removeEventListener('pointermove', move); panel.classList.remove('moving'); saveUi(); };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up, { once: true });
      g.addEventListener('pointercancel', up, { once: true });
    });
  }

  // ---------- showing notes ----------

  const current = () => doc();
  function visibleNotes() {
    const d = current();
    if (ui.scope === 'all' || !d) return notes;
    return notes.filter((n) => n.doc === d.id);
  }

  function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }

  function render() {
    const d = current();
    for (const b of panel.querySelectorAll('[data-scope]')) b.classList.toggle('on', b.dataset.scope === (d ? ui.scope : 'all'));
    panel.querySelector('[data-scope="doc"]').disabled = !d;
    const shown = visibleNotes();
    panel.querySelector('.notes-count').textContent = shown.length ? shown.length : '';
    if (!shown.length) {
      list.innerHTML = `<p class="notes-empty">${d && ui.scope === 'doc'
        ? 'Nothing here yet. Select text in the page and press <kbd>S</kbd> (or <b>Add to notes</b>) to keep it, or write below.'
        : 'No notes yet.'}</p>`;
      return;
    }
    const showSource = ui.scope === 'all' || !d;
    list.innerHTML = shown.map((n) => {
      const here = d && n.doc === d.id;
      const src = showSource && n.title ? `<span class="note-src" title="${escHtml(n.title)}">${escHtml(n.title)}</span> · ` : '';
      const quote = n.kind === 'clip'
        ? `<blockquote class="note-quote${here ? ' can-jump' : ''}" title="${here ? 'Go to this passage' : ''}">${escHtml(n.text)}</blockquote>` : '';
      const area = n.kind === 'clip'
        ? `<textarea class="note-text" rows="1" placeholder="Add a thought…">${escHtml(n.comment || '')}</textarea>`
        : `<textarea class="note-text" rows="1">${escHtml(n.text)}</textarea>`;
      return `<div class="note ${n.kind}" data-id="${n.id}">${quote}${area}
        <div class="note-meta">${src}<span>${when(n.at)}</span><button data-n="del" title="Delete this note">Delete</button></div></div>`;
    }).join('');
    for (const t of list.querySelectorAll('textarea')) autosize(t);
  }

  list.addEventListener('input', (e) => {
    const t = e.target.closest('.note-text');
    if (!t) return;
    const n = notes.find((x) => x.id === t.closest('.note').dataset.id);
    if (!n) return;
    if (n.kind === 'clip') n.comment = t.value; else n.text = t.value;
    n.edited = Date.now();
    autosize(t);
    clearTimeout(list.saveT);
    list.saveT = setTimeout(saveNotes, 300);
  });
  // An emptied note of your own goes when you leave it.
  list.addEventListener('focusout', (e) => {
    const t = e.target.closest('.note-text');
    if (!t) return;
    const n = notes.find((x) => x.id === t.closest('.note').dataset.id);
    if (n && n.kind === 'note' && !n.text.trim()) { notes = notes.filter((x) => x !== n); saveNotes(); render(); }
  });
  list.addEventListener('click', (e) => {
    const del = e.target.closest('[data-n="del"]');
    if (del) {
      const id = del.closest('.note').dataset.id;
      notes = notes.filter((x) => x.id !== id);
      saveNotes();
      return render();
    }
    const q = e.target.closest('.note-quote.can-jump');
    if (q) {
      const n = notes.find((x) => x.id === q.closest('.note').dataset.id);
      if (n) jump(n.block, n.text);
    }
  });

  compose.addEventListener('input', () => autosize(compose));
  compose.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); compose.blur(); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const text = compose.value.trim();
    if (!text) return;
    const d = current();
    notes.push({ id: newId(), kind: 'note', text, doc: d?.id || '', title: d?.title || '', at: Date.now() });
    saveNotes();
    compose.value = '';
    autosize(compose);
    if (ui.scope === 'doc' && !d) ui.scope = 'all';
    render();
    list.scrollTop = list.scrollHeight;
  });

  // ---------- header buttons ----------

  function setCollapsed(c) { ui.collapsed = c; saveUi(); place(); }
  panel.addEventListener('click', (e) => {
    const s = e.target.closest('[data-scope]');
    if (s && !s.disabled) { ui.scope = s.dataset.scope; saveUi(); return render(); }
    const b = e.target.closest('.notes-tools [data-n]');
    if (!b) return;
    if (b.dataset.n === 'close') return close();
    if (b.dataset.n === 'collapse') return setCollapsed(!ui.collapsed);
    if (b.dataset.n === 'copy') return copyMarkdown();
    if (b.dataset.n === 'clear') return askClear();
  });

  // Delete all: the notes in view (this document's, or every one with All), after a
  // second click in the bar that asks. The desktop app keeps a backup of them anyway.
  function askClear() {
    const n = visibleNotes().length;
    if (!n) return toast('No notes to delete');
    if (ui.collapsed) setCollapsed(false);
    const d = current();
    confirmBar.querySelector('span').textContent = ui.scope === 'all' || !d
      ? `Delete all ${n} note${n === 1 ? '' : 's'}, from every document?`
      : `Delete this document's ${n} note${n === 1 ? '' : 's'}?`;
    confirmBar.hidden = false;
    confirmBar.querySelector('[data-n="clear-no"]').focus();
  }
  confirmBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    confirmBar.hidden = true;
    if (b.dataset.n !== 'clear-yes') return;
    const gone = new Set(visibleNotes().map((x) => x.id));
    notes = notes.filter((x) => !gone.has(x.id));
    saveNotes();
    render();
    toast(`Deleted ${gone.size} note${gone.size === 1 ? '' : 's'}${/notes.json$/.test(where) ? ' · a backup is in the backups folder next to notes.json' : ''}`);
  });
  confirmBar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); confirmBar.hidden = true; } });

  function markdown() {
    const shown = visibleNotes();
    const d = current();
    const out = [`# Notes${ui.scope === 'doc' && d ? `: ${d.title}` : ''}`];
    let lastTitle = null;
    for (const n of shown) {
      if (ui.scope === 'all' && n.title !== lastTitle) { out.push(`## ${n.title || 'Untitled'}`); lastTitle = n.title; }
      if (n.kind === 'clip') {
        out.push(n.text.split('\n').map((l) => '> ' + l).join('\n'));
        if (n.comment?.trim()) out.push(n.comment.trim());
      } else out.push(n.text.trim());
    }
    return out.join('\n\n') + '\n';
  }
  async function copyMarkdown() {
    if (!visibleNotes().length) return toast('No notes to copy');
    const text = markdown();
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast('Notes copied as Markdown');
  }

  // ---------- open / close ----------

  function open() {
    ui.open = true;
    saveUi();
    place();
    render();
  }
  function close() {
    ui.open = false;
    saveUi();
    place();
  }
  const toggle = () => (ui.open ? close() : open());

  // ---------- selection → notes ----------

  // The selected text in the page, with the block it starts in; null if nothing (or
  // something outside the page, like the notes themselves) is selected.
  function pageSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!node?.closest('#stage')) return null;
    const blockEl = node.closest('[data-b]') || range.cloneContents().querySelector?.('[data-b]');
    const block = blockEl ? Number(blockEl.dataset.b) : null;
    return { text, block, range };
  }

  function addSelection() {
    const s = pageSelection();
    if (!s) { toast('Select some text first'); return false; }
    const d = current();
    notes.push({ id: newId(), kind: 'clip', text: s.text, comment: '', block: s.block, doc: d?.id || '', title: d?.title || '', at: Date.now() });
    saveNotes();
    getSelection().removeAllRanges();
    clipBtn.hidden = true;
    if (ui.scope === 'doc' && !d) ui.scope = 'all';
    if (!ui.open) open(); else render();
    if (ui.collapsed) setCollapsed(false);
    list.scrollTop = list.scrollHeight;
    const words = s.text.split(/\s+/).length;
    toast(`Added to notes · ${words} word${words === 1 ? '' : 's'}`);
    return true;
  }

  // The "Add to notes" button follows the selection.
  let selT = 0;
  function updateClipBtn() {
    const s = pageSelection();
    if (!s) { clipBtn.hidden = true; return; }
    const rects = s.range.getClientRects();
    const r = rects[rects.length - 1] || s.range.getBoundingClientRect();
    clipBtn.hidden = false;
    const bw = clipBtn.offsetWidth, bh = clipBtn.offsetHeight;
    let x = clamp(r.right - bw / 2, MARGIN, innerWidth - bw - MARGIN);
    let y = r.bottom + 10;
    if (y + bh > innerHeight - MARGIN) y = Math.max(MARGIN, r.top - bh - 10);
    clipBtn.style.left = x + 'px';
    clipBtn.style.top = y + 'px';
  }
  document.addEventListener('selectionchange', () => {
    clearTimeout(selT);
    selT = setTimeout(updateClipBtn, 180);
  });
  // Scrolling moves the text away from the button; hide it until the selection changes again.
  document.addEventListener('scroll', () => { clipBtn.hidden = true; }, true);
  clipBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
  clipBtn.addEventListener('click', (e) => { e.stopPropagation(); addSelection(); });

  place();
  if (ui.open) render();

  return {
    toggle,
    open,
    addSelection,
    hasSelection: () => !!pageSelection(),
    refresh: () => { if (ui.open) render(); }, // a new document was opened
    // Notes or the panel changed elsewhere (another tab, with the browser extension).
    reload() {
      const n = store.get(NOTES_KEY, []);
      notes = Array.isArray(n) ? n : [];
      Object.assign(ui, store.get(UI_KEY, {}));
      place();
      if (ui.open && !panel.contains(document.activeElement)) render();
    },
  };
}
