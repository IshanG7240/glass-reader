// Glass Reader inside a web page. One source, two builds:
//
//   npm run build:ios        → dist/glass-reader.user.js, the userscript for Safari on
//     iPad / iPhone (and any browser with a userscript manager). On ChatGPT, Claude and
//     Gemini it adds a READ tab on the right edge; tap it (or Ctrl+Option+C) and the
//     whole conversation opens in the reader, at the latest answer.
//   npm run build:extension  → dist/glass-reader-extension/, the standalone browser
//     extension (Chrome, Edge, Brave). Its toolbar button reads any page: articles,
//     GitHub, Google Docs, AI chats. No tab, no desktop app.
//
// The __GR_*__ placeholders are filled with the desktop reader (renderer/, bundled),
// its styles and fonts, and the capture code from extension/browser/background.js.
// Nothing leaves the page: it is read with your own sign-in and shown in a frame of
// this same page.

(() => {
  'use strict';
  if (window.top !== window || window.__glassReader) return;
  window.__glassReader = true;

  const BODY_HTML = __GR_BODY__;
  const READER_CSS = __GR_CSS__;
  const FONTS = __GR_FONTS__; // [{ family, weight, style, b64 }]
  // The extension build: no READ tab, the page is read by the extension's background
  // (it can also look into frames and fetch Google Docs exports), any page will do.
  const EXTENSION = __GR_EXTENSION__;

  // The desktop reader, bundled. GRW is the overlay frame's window: every global the
  // reader uses (document, innerWidth, addEventListener…) is rewritten to GRW.*.
  function runReader(GRW) {
    __GR_BUNDLE__
  }

  // From extension/browser/background.js: reads the conversation on this page.
  __GR_EXTRACT__

  // From bin/read-focused.js: a GitHub diff as a document.
  __GR_DIFF__

  // ---------- state ----------

  let frame = null, W = null, handlers = {}, fontsP = null, busy = false;
  const overlayOpen = () => !!frame && frame.style.display !== 'none';
  const emit = (name, ...a) => handlers[name]?.(...a);

  // ---------- which page is a conversation ----------

  const isConversation = () => {
    const h = location.hostname, p = location.pathname;
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return /\/(c|share)\/[\w-]{8,}/.test(p);
    if (h === 'claude.ai') return /\/(chat|share)\/[\w-]{8,}/.test(p);
    if (h === 'gemini.google.com') return /\/(app|gem\/[^/]+|share)\/[\w-]{6,}/.test(p) || !!document.querySelector('user-query');
    return false;
  };

  // ---------- the tab on the right edge ----------

  const host = document.createElement('div');
  host.id = 'glass-reader-launcher';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    button {
      all: unset; position: fixed; z-index: 2147483646; right: 0; top: 50%; transform: translateY(-50%);
      width: 40px; height: 84px; border-radius: 16px 0 0 16px; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
      background: linear-gradient(160deg, #5d7bff, #8b5cf6); border: 1px solid rgba(255, 255, 255, 0.35); border-right: 0;
      box-shadow: 0 8px 28px rgba(60, 50, 160, 0.45), 0 0 0 1px rgba(0, 0, 0, 0.08);
      color: #fff; font: 700 9.5px/1 -apple-system, system-ui, sans-serif; letter-spacing: .06em;
      transition: width .2s, box-shadow .2s;
      -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none;
    }
    button:hover, button:focus-visible { width: 46px; box-shadow: 0 10px 34px rgba(60, 50, 160, 0.6); }
    button[hidden] { display: none; }
    .bars { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
    .bars i { display: block; height: 3px; width: 18px; border-radius: 2px; background: #fff; }
    .bars i:nth-child(3) { width: 12px !important; }
    .bars i:nth-child(2) { opacity: .6; } .bars i:nth-child(3) { width: 9px; opacity: .4; }
    button.busy { opacity: 1; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .45; } }
    .note {
      position: fixed; z-index: 2147483647; right: 54px; top: 50%; transform: translateY(-50%);
      max-width: min(420px, calc(100vw - 64px)); padding: 10px 14px; border-radius: 14px;
      font: 500 13.5px/1.4 -apple-system, system-ui, sans-serif; color: #fff; white-space: pre-wrap;
      background: rgba(28, 30, 38, 0.82); border: 1px solid rgba(255, 255, 255, 0.16);
      -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
      -webkit-user-select: text; user-select: text;
    }
    .note.err { color: #ffd0c8; }
    .note[hidden] { display: none; }
`;
  const tab = document.createElement('button');
  tab.title = 'Read this conversation in Glass Reader (Ctrl+Option+C)';
  tab.setAttribute('aria-label', 'Read in Glass Reader');
  const bars = document.createElement('span');
  bars.className = 'bars';
  bars.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const label = document.createElement('span');
  label.textContent = 'READ';
  tab.append(bars, label);
  // A note beside the tab: shows that a tap registered, and what went wrong if it did.
  const note = document.createElement('div');
  note.className = 'note';
  note.hidden = true;
  note.addEventListener('click', () => { note.hidden = true; });
  shadow.append(style, tab, note);
  let noteT = 0;
  const say = (msg, err = false, ms = err ? 15000 : 0) => {
    clearTimeout(noteT);
    note.textContent = msg;
    note.classList.toggle('err', err);
    note.hidden = !msg;
    if (ms) noteT = setTimeout(() => { note.hidden = true; }, ms);
  };
  const fail = (where, e) => {
    tab.classList.remove('busy');
    const msg = `Glass Reader couldn't open (${where}):\n${e?.message || e}`;
    console.error(msg, e);
    say(msg + '\n\nTap to dismiss.', true);
    if (frame) close();
  };
  // touchend as well as click: some iPad setups never turn a tap here into a click.
  let lastTap = 0;
  const tapped = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - lastTap < 600) return;
    lastTap = Date.now();
    open();
  };
  tab.addEventListener('touchend', tapped, { passive: false });
  tab.addEventListener('click', tapped);

  const mount = () => { if (!host.isConnected) document.documentElement.append(host); };
  // Always shown on these sites, so it's easy to tell the script is running at all.
  const refresh = () => { mount(); tab.hidden = EXTENSION || overlayOpen(); };
  refresh();
  if (!EXTENSION) setInterval(refresh, 1000); // these are single-page apps: the URL changes without a reload
  // The toolbar button (or its shortcut) again while the reader is up puts it away.
  if (EXTENSION) window.__glassReaderToggle = () => (overlayOpen() ? close() : open());

  addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'KeyC') { e.preventDefault(); e.stopPropagation(); open(); }
  }, true);

  // ---------- the overlay frame ----------


  function build() {
    frame = document.createElement('iframe');
    frame.setAttribute('aria-label', 'Glass Reader');
    // CSSOM styles (not a style attribute): allowed under every site's CSP.
    Object.assign(frame.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100dvh', border: '0', margin: '0', padding: '0',
      zIndex: '2147483647', background: 'transparent', colorScheme: 'normal', display: 'none',
    });
    document.documentElement.append(frame);
    // An empty frame is this page's own origin, so the reader runs here, with no
    // server and nothing to load. Its document is written from this script.
    W = frame.contentWindow;
    const D = W.document;
    // Gemini requires Trusted Types, and the frame inherits that. The reader builds
    // its views from its own sanitised HTML, so pass strings through in this frame only.
    try { W.trustedTypes?.createPolicy('default', { createHTML: (s) => s }); } catch { /* already set */ }
    // An empty frame starts in quirks mode; the reader (and KaTeX) want standards mode.
    D.open();
    D.write('<!doctype html><html><head></head><body></body></html>');
    D.close();

    const css = D.createElement('style');
    css.textContent = READER_CSS;
    D.head.append(css);
    const meta = D.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    D.head.append(meta);
    D.title = 'Glass Reader';
    D.body.innerHTML = BODY_HTML;
    D.body.dataset.theme = 'glass';
    D.body.classList.add('in-page');

    // First run on this site: start on Glass, which here is the conversation itself,
    // blurred, behind the text.
    try { if (!W.localStorage.getItem('gr:settings')) W.localStorage.setItem('gr:settings', JSON.stringify({ theme: 'glass' })); } catch { /* no storage */ }

    const on = (name) => (cb) => { handlers[name] = cb; };
    W.reader = {
      inPage: true,
      hide: close, quit: close, ready() {}, log() {},
      wallpaper: async () => null,
      readPath: async () => null,
      pathForFile: () => null,
      openDialog: () => pickFile(D),
      claudeSessions: async () => [],
      openClaude: async () => 'Claude Code sessions open in the desktop app.',
      openInbox() {},
      onOpen: on('open'), onError: on('error'), onShown: on('shown'), onRequestOpen: on('requestOpen'),
      onPicker: on('picker'), onFetching: on('fetching'), onFetchingOff: on('fetchingOff'),
      onToast: on('toast'), onInbox: on('inbox'),
    };

    // Before the reader's own keys: C reads the conversation again (it may have grown);
    // the desktop's C (Claude Code sessions) has no meaning here.
    W.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyC') { e.preventDefault(); e.stopImmediatePropagation(); return capture(); }
      if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); e.stopImmediatePropagation(); capture(); }
    }, true);

    touch(D);
    glassBackdrop(D);
    runReader(W);
  }

  // The Glass, Frost and Clear backgrounds see through to the page, blurred.
  function glassBackdrop(D) {
    const set = () => {
      const see = ['glass', 'frost', 'clear'].includes(D.body.dataset.theme);
      const f = see ? 'blur(34px) saturate(1.5)' : 'none';
      frame.style.backdropFilter = f;
      frame.style.webkitBackdropFilter = f;
    };
    new W.MutationObserver(set).observe(D.body, { attributes: true, attributeFilter: ['data-theme'] });
    set();
  }

  // Touch: a tap shows the controls; in Book, Focus and Cinema a swipe turns the page.
  function touch(D) {
    const key = (k) => W.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));
    let x0 = 0, y0 = 0, t0 = 0;
    D.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') W.dispatchEvent(new W.MouseEvent('mousemove'));
    }, { passive: true });
    D.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      [x0, y0, t0] = [t.clientX, t.clientY, Date.now()];
    }, { passive: true });
    D.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      const mode = W.__gr?.S?.mode;
      if (e.touches.length || Date.now() - t0 > 700 || mode === 'column' || mode === 'prompter') return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) key(dx < 0 ? 'ArrowRight' : 'ArrowLeft');
      else if (mode !== 'book' && Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.5) key(dy < 0 ? 'ArrowDown' : 'ArrowUp');
    }, { passive: true });
  }

  // "Open a file" in the overlay: Markdown, HTML and text from Files.
  function pickFile(D) {
    return new Promise((resolve) => {
      const input = D.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt,.html,.htm,text/*';
      input.onchange = async () => {
        const f = input.files[0];
        resolve(f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null);
      };
      input.click();
    });
  }

  // The reader's typefaces, from this script (no font requests, which some sites' CSP blocks).
  function loadFonts() {
    return (fontsP ??= (async () => {
      const D = W.document;
      for (const f of FONTS) {
        try {
          const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
          const face = new W.FontFace(f.family, bytes, { weight: f.weight, style: f.style });
          D.fonts.add(face);
          await face.load();
        } catch { /* fall back to the system fonts in the stack */ }
      }
    })());
  }

  function show() {
    frame.style.display = 'block';
    tab.hidden = true;
    document.documentElement.style.overflow = 'hidden';
    W.focus();
    emit('shown');
  }
  function close() {
    if (!frame) return;
    frame.style.display = 'none';
    document.documentElement.style.overflow = '';
    refresh();
    window.focus();
  }

  async function open() {
    if (!EXTENSION && !isConversation()) return say('Glass Reader is ready. Open a conversation (or start one), then tap READ.\n\nTap to dismiss.', false, 6000);
    tab.classList.add('busy');
    say('Opening…');
    try {
      if (!frame) build();
    } catch (e) { frame?.remove(); frame = null; handlers = {}; return fail('setting up the reader', e); }
    try { show(); } catch (e) { return fail('showing the reader', e); }
    tab.classList.remove('busy');
    say('');
    await capture();
  }

  // The extension's background reads the tab (this script can't see into other
  // frames or fetch across sites) and hands the page back.
  async function readByExtension() {
    let page;
    try { page = await chrome.runtime.sendMessage({ type: 'capture' }); } catch (e) {
      // Updated or reloaded since this page loaded: this copy of the script is orphaned.
      throw new Error('Glass Reader was updated. Reload the page, then click it again.');
    }
    return page || { error: 'Nothing came back from the page. Try again.' };
  }

  // What was read → a file for the reader: Markdown, HTML or text.
  function toDoc(page) {
    const title = page.title || (page.chat ? `${page.chat} conversation` : 'Untitled');
    const base = slug(title) + (page.selection ? ' (selection)' : '');
    let ext, body;
    if (page.kind === 'diff') {
      ext = 'md';
      body = diffMarkdown(page);
    } else if (page.kind === 'markdown') {
      ext = 'md';
      body = page.base ? absolutize(page.content, page.base) : page.content;
      if (!/^\s*#\s/m.test(body.split('\n').slice(0, 8).join('\n'))) body = `# ${title}\n\n${body}`;
    } else if (page.kind === 'code') {
      ext = 'md';
      const fence = '`'.repeat(Math.max(3, ...(page.content.match(/`{3,}/g) || []).map((f) => f.length + 1)));
      body = `# ${title}\n\n${fence}${page.lang || ''}\n${page.content.replace(/\n$/, '')}\n${fence}\n`;
    } else if (page.kind === 'text') {
      ext = 'txt';
      body = page.content;
    } else {
      ext = 'html';
      const meta = page.selection && !page.chat ? 'Selection' : [page.byline, page.site || page.chat].filter(Boolean).join(' · ');
      const src = page.url && !page.chat ? `<p><em>From <a href="${esc(page.url)}">${esc(page.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, ''))}</a></em></p>` : '';
      body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><article>` +
        `<h1>${esc(title)}</h1>${meta ? `<p><em>${esc(meta)}</em></p>` : ''}${page.content}${src}</article></body></html>`;
    }
    // A chat: how it was read, at the very end. Helps tell what went wrong when something did.
    if (page.chat) {
      const d = page.dbg || {};
      const how = typeof d.api === 'number' && page.kind === 'markdown'
        ? `Read from ${page.chat}'s own API${d.images && d.images !== '0/0' ? ` · images ${d.images.replace('/', ' of ')}` : ''}`
        : `Read from the page${d.dom ? ` (${d.dom} messages)` : ''}${typeof d.api === 'string' ? `; the API answered “${d.api}”` : ''}`;
      if (ext === 'md') body += `\n\n---\n\n*${how}.*\n`;
      else if (ext === 'html') body = body.replace('</article>', `<hr><p><em>${esc(how)}.</em></p></article>`);
    }
    return { name: `${base}.${ext}`, body };
  }

  // Relative image links in Markdown (a GitHub README): point them at the web.
  function absolutize(md, base) {
    const fix = (u) => {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u)) return u;
      try { return new URL(u, base.endsWith('/') ? base : base + '/').href; } catch { return u; }
    };
    return md
      .replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?/g, (_, a, u) => a + fix(u))
      .replace(/(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi, (_, a, q, u) => a + q + fix(u) + q);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const slug = (s) => (s || 'conversation').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'conversation';

  async function capture() {
    if (busy) return;
    busy = true;
    emit('fetching');
    try {
      const slow = new Promise((_, no) => setTimeout(() => no(new Error('The page took too long to answer. Try again in a moment.')), 30000));
      const read = EXTENSION ? readByExtension() : extract();
      const [page] = await Promise.race([Promise.all([read, loadFonts()]), slow]);
      if (page.error) throw new Error(page.error);
      if (!EXTENSION && !page.chat && !page.selection) throw new Error('Open a ChatGPT, Claude or Gemini conversation first.');
      const { name, body } = toDoc(page);
      // A "captures" path tells the reader a chat is one: open at the latest answer.
      emit('open', { name, data: new TextEncoder().encode(body), path: `/glass-reader/captures/${name}` });
    } catch (err) {
      emit('fetchingOff');
      emit('error', err?.message || String(err));
    } finally {
      busy = false;
    }
  }
})();
