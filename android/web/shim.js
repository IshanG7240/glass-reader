// Glass Reader on Android: the desktop renderer runs unchanged in a WebView. This file
// runs before it and stands in for Electron's preload (window.reader), backed by the
// app's Java bridge (window.GRAndroid). It also adds the few things a phone needs:
// swipes, the back button, and turning on "read from the screen".
'use strict';
(() => {
  const N = window.GRAndroid;
  const cb = {};
  const on = (name) => (fn) => { cb[name] = fn; };
  const fire = (name, ...a) => cb[name]?.(...a);
  const queue = [];

  // Documents live in the app's storage and are served at /doc/<id>/<name>. The path the
  // reader sees is a stable stand-in, so recents and "resume where you were" work.
  const urlForPath = (p) => {
    const m = /^\/(?:android\/docs|glass-reader\/captures)\/([^/]+)\/(.+)$/.exec(p || '');
    return m ? `/doc/${m[1]}/${m[2]}` : null;
  };
  async function load(d) {
    const r = await fetch(d.url);
    if (!r.ok) throw new Error('That document is no longer on this phone.');
    return { name: d.name, path: d.path, data: new Uint8Array(await r.arrayBuffer()) };
  }

  window.reader = {
    isElectron: false,
    isAndroid: true,
    openDialog: async () => { N.pickFile(); return null; }, // the file arrives through onOpen
    readPath: async (p) => {
      const url = urlForPath(p);
      if (!url) return null;
      try { return await load({ url, path: p, name: p.split('/').pop() }); } catch { return null; }
    },
    // The Glass background: the chat you were reading, blurred (a picture taken when you tapped Read).
    wallpaper: async () => (N.hasWall() ? '/wall.jpg?' + Date.now() : null),
    pathForFile: () => null,
    hide: () => N.hide(),
    quit: () => N.quit(),
    ready: () => {
      N.ready();
      while (queue.length) queue.shift()();
    },
    log: (...a) => N.log(a.map(String).join(' ')),
    onOpen: on('open'),
    onError: on('error'),
    onShown: on('shown'),
    onRequestOpen: on('requestOpen'),
    onInbox: on('inbox'),
    openInbox: () => {},
    claudeSessions: async () => [],
    openClaude: async () => 'Claude Code sessions are on the desktop app.',
    onPicker: on('picker'),
    onFetching: on('fetching'),
    onFetchingOff: on('fetchingOff'),
    onToast: on('toast'),
  };

  // Called by the app (Kotlin) ----------------------------------------------------------
  const whenReady = (fn) => (cb.open ? fn() : queue.push(fn));
  window.__grAndroid = {
    open: (d) => whenReady(async () => {
      try { fire('open', await load(d)); } catch (e) { fire('error', e.message); }
    }),
    fetching: (on) => whenReady(() => fire(on ? 'fetching' : 'fetchingOff')),
    toast: (m) => whenReady(() => fire('toast', m)),
    error: (m) => whenReady(() => { fire('fetchingOff'); fire('error', m); }),
    shown: () => fire('shown'),
    wall: () => {
      if (!N.hasWall()) return;
      const img = document.getElementById('wall');
      img.onload = () => document.getElementById('bg').classList.add('has-wall');
      img.src = '/wall.jpg?' + Date.now();
    },
    // Back button: close what is open on top, then go back to the previous document,
    // then leave. Returns true when it handled it.
    back: () => {
      for (const id of ['help', 'picker']) {
        const el = document.getElementById(id);
        if (el && !el.hidden) { el.hidden = true; return true; }
      }
      if (window.__gr?.st?.prevFile) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    },
    key: (key, shiftKey = false) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    },
    hasDoc: () => !!window.__gr?.st?.doc,
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('android');
    // Volume keys turn pages only while a document is open.
    const docState = () => N.docOpen(!document.body.classList.contains('no-doc'));
    new MutationObserver(docState).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // The desktop's messages talk about keys; on a phone they mean the back button.
    const toastEl = document.getElementById('toast');
    new MutationObserver(() => {
      const t = toastEl.textContent;
      if (/Backspace/.test(t)) toastEl.textContent = t.replace(/Backspace/g, 'Back');
    }).observe(toastEl, { childList: true, characterData: true, subtree: true });

    // The Read button's icon (res/drawable/ic_read.xml), drawn inline.
    const ICON = `<span class="gr-pill" aria-label="Read"><svg viewBox="22 30 62 56" width="15" height="14" aria-hidden="true">
      <path fill="#fff" fill-opacity=".45" d="M30,32h40a6,6 0 0 1 6,6v34a6,6 0 0 1-6,6h-40a6,6 0 0 1-6-6v-34a6,6 0 0 1 6-6z"/>
      <path fill="#fff" fill-opacity=".7" d="M36,38h40a6,6 0 0 1 6,6v34a6,6 0 0 1-6,6h-40a6,6 0 0 1-6-6v-34a6,6 0 0 1 6-6z"/>
      <path fill="#161822" d="M42,50h32v4h-32zM42,58h28v4h-28zM42,66h30v4h-30z"/></svg></span>`;
    // Welcome card: phone wording, and turning on "read from the screen".
    const card = document.querySelector('.welcome-card');
    if (card) {
      card.querySelector('.formats').textContent = 'PDF · Markdown · EPUB · Word · HTML · Text';
      card.querySelector('.hint').innerHTML = 'Share or select text in any app → <b>Glass Reader</b>';
      card.querySelectorAll('kbd').forEach((k) => k.remove());
      const box = document.createElement('div');
      box.className = 'gr-android';
      card.querySelector('.actions').after(box);
      const paint = () => {
        const s = JSON.parse(N.status());
        box.innerHTML = s.screen
          ? `<p><b>Reading from ChatGPT, Claude and Gemini is on.</b> Open a chat and tap the ${ICON} button at the right edge of the screen. Drag it onto the ✕ to hide it for 10 minutes.</p>`
          : `<p>Read whole chats from the <b>ChatGPT</b>, <b>Claude</b> and <b>Gemini</b> apps with one tap.</p>
             <button class="primary" data-gr="screen">Turn on reading from the screen</button>
             <p class="gr-small">Android asks you to allow Glass Reader in Accessibility. It only looks at those three apps, only when you tap its button, and nothing leaves your phone.</p>`;
      };
      paint();
      box.addEventListener('click', (e) => { if (e.target.closest('[data-gr="screen"]')) N.openAccessibilitySettings(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
    }

    // Swipes. Column and Prompter scroll natively. Book turns pages left/right; Focus and
    // Cinema step through passages up/down (or left/right).
    let sx = 0, sy = 0, st0 = 0, tracking = false;
    const stage = document.getElementById('stage');
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st0 = performance.now();
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (performance.now() - st0 > 700 || Math.max(Math.abs(dx), Math.abs(dy)) < 40) return;
      const m = window.__gr?.S?.mode;
      const horiz = Math.abs(dx) > Math.abs(dy);
      let d = 0;
      if (m === 'book' && horiz) d = dx < 0 ? 1 : -1;
      else if (m === 'focus' || m === 'cinema') d = horiz ? (dx < 0 ? 1 : -1) : (dy < 0 ? 1 : -1);
      if (d) window.__grAndroid.key(d > 0 ? 'ArrowRight' : 'ArrowLeft');
    }, { passive: true });
    // Controls. The desktop shows them while the mouse moves and hides them after two
    // seconds; on a phone a tap shows them and they stay until the next tap on the page
    // (or 12 seconds without touching them).
    let hudT = 0;
    const hud = document.getElementById('hud');
    const setHud = (on) => {
      document.body.classList.toggle('gr-hud', on);
      clearTimeout(hudT);
      if (on) hudT = setTimeout(() => setHud(false), 12000);
    };
    hud.addEventListener('touchstart', () => setHud(true), { passive: true });
    hud.addEventListener('wheel', () => setHud(true), { passive: true });
    let tx = 0, ty = 0, tt = 0;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = performance.now();
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (performance.now() - tt > 400 || Math.hypot(t.clientX - tx, t.clientY - ty) > 12) return;
      if (e.target.closest('a, button, input, select, textarea, summary, [data-math]')) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      if (sideTap(t.clientX)) return;
      setHud(!document.body.classList.contains('gr-hud'));
    }, { passive: true });
    // In Book and Cinema a tap on the side of the screen turns the page; one in the middle
    // only shows the controls (Cinema would otherwise step forward on any tap).
    const sideTap = (x) => {
      const m = window.__gr?.S?.mode, w = window.innerWidth;
      if (m === 'book') return x < w * 0.22 || x > w * 0.78;
      if (m === 'cinema') return x < w * 0.3 || x > w * 0.7;
      return false;
    };
    window.addEventListener('click', (e) => {
      if (window.__gr?.S?.mode === 'cinema' && stage.contains(e.target) && !e.target.closest('a, button') && !sideTap(e.clientX)) e.stopPropagation();
    }, true);
    new MutationObserver(() => {
      if (document.body.classList.contains('no-doc') && document.body.classList.contains('gr-hud')) setHud(false);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // Focus scrolls on the wheel only; let a vertical drag there not scroll the page.
    stage.addEventListener('touchmove', (e) => {
      const m = window.__gr?.S?.mode;
      if (m === 'focus' || m === 'cinema' || m === 'book') e.preventDefault();
    }, { passive: false });
  });
})();
