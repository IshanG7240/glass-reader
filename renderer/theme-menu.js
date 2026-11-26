// The background picker: the Background button (or T) opens a small panel of swatches
// above the control bar. Two rows: the see-through ones, and the ones made for the light
// in your room, bright to dark. Pointing at a swatch shows the whole reader in it; a click
// keeps it. On a touch screen a tap puts it on and the panel stays, so you can try
// another; tap outside when you're done. Keys: ← → (or T / ⇧T) step through them, live;
// Enter keeps, Esc goes back to what you had.
//
//   initThemeMenu({ names, about, current, preview(theme), commit(theme), anchor: () => element, onClose })
//   returns { open(), close(), toggle(), isOpen(), key(e) }

const ROWS = [
  { label: 'See-through', themes: ['glass', 'clear', 'frost', 'studio'] },
  { label: 'For the room', scale: true, themes: ['daylight', 'paper', 'lamp', 'dusk', 'night', 'lightsout'] },
];

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function initThemeMenu({ names, about, current, preview, commit, anchor, onClose }) {
  const order = ROWS.flatMap((r) => r.themes).filter((t) => names[t]);
  const el = document.createElement('div');
  el.id = 'theme-menu';
  el.hidden = true;
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Background');
  el.innerHTML = ROWS.map((r) => `
    <div class="tm-row">
      <div class="tm-label">${r.label}${r.scale ? '<span class="tm-scale" aria-hidden="true"><i></i>bright → dark</span>' : ''}</div>
      <div class="tm-grid" style="--n:${r.themes.length}">
        ${r.themes.filter((t) => names[t]).map((t) => `
          <button class="tm-sw" data-t="${t}" role="option" title="${escHtml(names[t])}">
            <span class="tm-chip" data-t="${t}"><span>Aa</span></span>
            <span class="tm-name">${escHtml(names[t])}</span>
          </button>`).join('')}
      </div>
    </div>`).join('') + '<div class="tm-foot"><b></b><span></span></div>';
  document.body.append(el);
  const foot = el.querySelector('.tm-foot');

  let start = null; // the theme when the panel opened (Esc goes back to it)
  let chosen = null; // the theme kept so far
  let pointer = 'mouse';

  const isOpen = () => !el.hidden;
  function describe(t) {
    foot.querySelector('b').textContent = names[t];
    foot.querySelector('span').textContent = about(t) || '';
  }
  function mark(t) {
    for (const b of el.querySelectorAll('.tm-sw')) {
      const on = b.dataset.t === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    describe(t);
  }
  function place() {
    const a = anchor()?.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = a && a.width ? a.left + a.width / 2 - w / 2 : (innerWidth - w) / 2;
    left = Math.min(Math.max(12, left), innerWidth - w - 12);
    // Above the button; where there is no room (the bar near the top), below it.
    let top = a && a.height ? a.top - h - 12 : innerHeight - h - 90;
    if (top < 12 && a) top = Math.min(a.bottom + 12, innerHeight - h - 12);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(Math.max(12, top)) + 'px';
  }
  function open() {
    start = chosen = current();
    el.hidden = false;
    mark(chosen);
    place();
  }
  function close(revert = false) {
    if (!isOpen()) return;
    if (revert && start && start !== chosen) { chosen = start; commit(start); }
    else if (current() !== chosen) preview(chosen); // a swatch was only being pointed at
    el.hidden = true;
    onClose?.();
  }
  function pick(t, keepOpen) {
    chosen = t;
    commit(t);
    mark(t);
    if (!keepOpen) close();
  }
  function step(d) {
    const i = order.indexOf(chosen);
    pick(order[(i + d + order.length) % order.length], true);
  }
  // ↑ ↓ move between the two rows, to the swatch in about the same place.
  function row(d) {
    const ri = ROWS.findIndex((r) => r.themes.includes(chosen));
    const to = ROWS[ri + d];
    if (!to) return;
    const from = ROWS[ri].themes;
    const at = from.indexOf(chosen) / Math.max(1, from.length - 1);
    pick(to.themes[Math.round(at * (to.themes.length - 1))], true);
  }

  el.addEventListener('pointerdown', (e) => { pointer = e.pointerType || 'mouse'; });
  el.addEventListener('pointerover', (e) => {
    const b = e.target.closest('.tm-sw');
    if (!b || e.pointerType !== 'mouse') return;
    preview(b.dataset.t);
    describe(b.dataset.t);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse' || !isOpen()) return;
    preview(chosen);
    describe(chosen);
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.tm-sw');
    if (!b) return;
    // A mouse click (or Enter on a focused swatch) keeps it and closes; a tap stays open to compare.
    pick(b.dataset.t, pointer !== 'mouse' && e.detail !== 0);
  });
  // Anywhere else closes it, keeping what's on.
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !el.contains(e.target) && !anchor()?.contains(e.target)) close();
  }, true);
  addEventListener('resize', () => { if (isOpen()) place(); });

  function key(e) {
    switch (e.key) {
      case 'ArrowRight': step(1); return true;
      case 'ArrowLeft': step(-1); return true;
      case 'ArrowDown': row(1); return true;
      case 'ArrowUp': row(-1); return true;
      case 't': case 'T': step(e.shiftKey ? -1 : 1); return true;
      case 'Enter': case ' ': close(); return true;
      case 'Escape': close(true); return true;
    }
    return false;
  }

  return { open, close, isOpen, key, toggle: () => (isOpen() ? close() : open()) };
}
