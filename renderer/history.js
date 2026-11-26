// History: everything you've read, newest first, kept with your settings and notes (so
// on the iPad, ChatGPT, Claude and Gemini share one list). R opens it as a panel: type to
// search, ↑↓ and Enter, or click. The document you came from is picked already, so
// R Enter swaps back and forth between two.
//
//   initHistory({ store, toast, reopen: (entry) => Promise, current: () => id | null, hint })
//   returns { record(entry), progress(id, pct), list(), open(), close(), isOpen(), key(e), reload() }
//
// An entry: { id, title, kind: chat | claude | page | file, site, url?, path?, session?, at, pct }.
// Only what can be opened again is kept: a file's path, a page's address, a Claude Code
// session, or a capture saved on this device.

const KEY = 'gr:history';
const MAX = 150;

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const ICON = {
  chat: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h0a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  claude: '<path d="M4 6h16v12H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.5 10l2.5 2-2.5 2M12 14.5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  page: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 12h16M12 4c2.5 2.3 3.6 5 3.6 8s-1.1 5.7-3.6 8c-2.5-2.3-3.6-5-3.6-8S9.5 6.3 12 4z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  file: '<path d="M7 3.5h7l4 4V20.5H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3.5v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
};

function dayOf(t, now = new Date()) {
  const d = new Date(t);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return 'Today';
  if (t >= start - 864e5) return 'Yesterday';
  if (t >= start - 6 * 864e5) return 'This week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month';
  return d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function timeOf(t, group) {
  const d = new Date(t);
  const hm = d.toTimeString().slice(0, 5);
  if (group === 'Today' || group === 'Yesterday') return hm;
  if (group === 'This week') return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + hm;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function initHistory({ store, toast, reopen, current, hint = '' }) {
  let items = [];
  function load() {
    items = store.get(KEY, null);
    if (!Array.isArray(items)) {
      // The welcome screen's "Continue reading" list, from before there was a history.
      items = store.get('gr:recents', []).filter((r) => r?.path).map((r, i) => ({
        id: r.path, title: r.title, kind: 'file', site: (r.path.match(/\.(\w+)$/)?.[1] || '').toUpperCase(),
        path: r.path, at: Date.now() - (i + 1) * 60e3, pct: r.pct || 0,
      }));
      if (items.length) store.set(KEY, items);
    }
  }
  load();

  let saveT = 0;
  const save = (soon = false) => {
    clearTimeout(saveT);
    if (soon) store.set(KEY, items);
    else saveT = setTimeout(() => store.set(KEY, items), 3000); // reading progress: not on every scroll
  };

  function record(e) {
    if (!e?.id) return;
    const old = items.find((x) => x.id === e.id);
    items = [{ ...old, ...e, at: Date.now(), pct: e.pct ?? old?.pct ?? 0 }, ...items.filter((x) => x.id !== e.id)].slice(0, MAX);
    save(true);
    if (isOpen()) render();
  }
  function progress(id, pct) {
    const e = items.find((x) => x.id === id);
    if (!e || e.pct === pct) return;
    e.pct = pct;
    save();
  }
  function remove(id) {
    items = items.filter((x) => x.id !== id);
    save(true);
    render();
  }

  // ---------- the panel ----------

  const box = document.createElement('section');
  box.id = 'history';
  box.hidden = true;
  box.innerHTML = `
    <div class="history-card" role="dialog" aria-label="History">
      <div class="history-head">
        <h2>History</h2>
        <input type="search" placeholder="Search what you’ve read" autocomplete="off" spellcheck="false" aria-label="Search history">
      </div>
      <div class="history-list" role="listbox"></div>
      <div class="history-foot">
        <span class="history-keys">↑↓ choose · Enter open · ⇧Del remove · Esc close</span>
        <span class="history-hint"></span>
        <button data-h="clear">Clear history</button>
      </div>
    </div>`;
  document.body.append(box);
  const q = box.querySelector('input');
  const listEl = box.querySelector('.history-list');
  const clearBtn = box.querySelector('[data-h="clear"]');
  box.querySelector('.history-hint').textContent = hint;

  let shown = [], sel = 0;
  function filtered() {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((e) => {
      const hay = `${e.title} ${e.site} ${e.url || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  function render() {
    shown = filtered();
    sel = clamp(sel, 0, Math.max(0, shown.length - 1));
    const now = new Date(), cur = current();
    let html = '', group = '';
    shown.forEach((e, i) => {
      const g = dayOf(e.at, now);
      if (g !== group) { html += `<h3>${escHtml(g)}</h3>`; group = g; }
      const meta = [e.site, timeOf(e.at, g), e.id === cur ? 'reading now' : ''].filter(Boolean).join(' · ');
      const pct = clamp(Math.round(e.pct || 0), 0, 100);
      html += `<div class="hrow${e.id === cur ? ' now' : ''}" role="option" data-i="${i}">
        <svg class="hk" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICON[e.kind] || ICON.file}</svg>
        <span class="hmain"><span class="ht">${escHtml(e.title || 'Untitled')}</span><span class="hm">${escHtml(meta)}</span></span>
        <span class="hp" title="${pct}% read"><i style="width:${pct}%"></i></span>
        <button class="hx" data-x="${i}" title="Remove from history" aria-label="Remove from history">×</button>
      </div>`;
    });
    listEl.innerHTML = html || `<p class="empty">${items.length ? 'Nothing matches.' : 'Nothing read yet. Whatever you open shows up here.'}</p>`;
    mark();
  }
  function mark() {
    const rows = listEl.querySelectorAll('.hrow');
    rows.forEach((r, i) => r.classList.toggle('sel', i === sel));
    rows[sel]?.scrollIntoView({ block: 'nearest' });
  }

  const isOpen = () => !box.hidden;
  function open() {
    load();
    q.value = '';
    // The one you came from is first after the one you're reading: R, Enter goes back to it.
    sel = items[0] && items[0].id === current() && items.length > 1 ? 1 : 0;
    box.hidden = false;
    render();
    // No on-screen keyboard popping up on a tablet: there, tap the box to search.
    if (!matchMedia('(pointer: coarse)').matches) q.focus();
  }
  function close() {
    box.hidden = true;
    q.blur();
    resetClear();
  }
  async function choose(i) {
    const e = shown[i];
    if (!e) return;
    close();
    if (e.id === current()) return;
    await reopen(e);
  }

  let clearArmed = false, clearT = 0;
  function resetClear() { clearArmed = false; clearTimeout(clearT); clearBtn.textContent = 'Clear history'; clearBtn.classList.remove('armed'); }
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = 'Clear all? Click again';
      clearBtn.classList.add('armed');
      clearT = setTimeout(resetClear, 3500);
      return;
    }
    resetClear();
    items = [];
    save(true);
    render();
    toast('History cleared');
  });

  listEl.addEventListener('click', (ev) => {
    const x = ev.target.closest('[data-x]');
    if (x) { ev.stopPropagation(); remove(shown[+x.dataset.x]?.id); return; }
    const row = ev.target.closest('.hrow');
    if (row) choose(+row.dataset.i);
  });
  listEl.addEventListener('mousemove', (ev) => {
    const row = ev.target.closest('.hrow');
    if (row && +row.dataset.i !== sel) { sel = +row.dataset.i; mark(); }
  });
  box.addEventListener('click', (ev) => { if (ev.target === box) close(); });
  q.addEventListener('input', () => { sel = 0; render(); });

  // Keys, from the search box or (with it not focused) from the reader's own handler.
  function key(e) {
    const k = e.key;
    if (k === 'Escape') { if (q.value) { q.value = ''; render(); } else close(); }
    else if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey)) { sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) { sel = Math.max(0, sel - 1); mark(); }
    else if (k === 'PageDown') { sel = Math.min(shown.length - 1, sel + 8); mark(); }
    else if (k === 'PageUp') { sel = Math.max(0, sel - 8); mark(); }
    else if (k === 'Enter') choose(sel);
    else if (k === 'Delete' && (e.shiftKey || document.activeElement !== q)) remove(shown[sel]?.id);
    else if ((k === 'r' || k === 'R') && document.activeElement !== q) close();
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== q) { q.focus(); return false; } // typing starts a search
    else return false;
    return true;
  }
  q.addEventListener('keydown', (e) => { if (key(e)) { e.preventDefault(); e.stopPropagation(); } });

  return {
    record, progress, open, close, isOpen, key, reload: () => { load(); if (isOpen()) render(); },
    list: () => items.slice(),
    toggle: () => (isOpen() ? close() : open()),
    choose: (e) => reopen(e),
  };
}
