// Glass Reader browser extension (Brave, Chrome, other Chromium browsers).
//
// Keeps a native-messaging connection to bin/browser-host.js open. Over it:
//   * tells the host when the browser window gains or loses focus
//   * answers "capture" with the current tab's readable content
// The global Ctrl+Alt+C shortcut (bin/read-focused.js) asks the host, the host asks
// us. Nothing is sent anywhere else.

const HOST = 'com.glassreader.host';
let port = null;

function connect() {
  if (port) return;
  try { port = chrome.runtime.connectNative(HOST); } catch { port = null; return; }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // host not installed yet, or it exited
    port = null;
    setTimeout(connect, 10000);
  });
  reportFocus();
}

async function reportFocus() {
  let focused = false;
  try { focused = !!(await chrome.windows.getLastFocused()).focused; } catch { /* no windows */ }
  port?.postMessage({ type: 'focus', focused });
}

chrome.windows.onFocusChanged.addListener((id) => {
  connect();
  port?.postMessage({ type: 'focus', focused: id !== chrome.windows.WINDOW_ID_NONE });
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

async function onMessage(msg) {
  if (msg?.type === 'focus?') {
    let focused = false;
    try { focused = !!(await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).focused; } catch { /* no windows */ }
    return port?.postMessage({ type: 'focusState', id: msg.id, focused });
  }
  if (msg?.type !== 'capture') return;
  port?.postMessage({ type: 'ack', id: msg.id });
  const t0 = Date.now(), debug = {};
  let page;
  try { page = await capture(debug); } catch (e) { page = { error: String(e?.message || e) }; }
  page.debug = { v: chrome.runtime.getManifest().version, ...debug, ...(page.dbg || {}), ms: Date.now() - t0, chars: page.text ?? (page.content || page.diff || '').length };
  delete page.dbg;
  port?.postMessage({ type: 'page', id: msg.id, page });
}

async function capture(debug = {}) {
  // The last focused *normal* window: a popup, DevTools or installed-app window can
  // count as "last focused" too, and its tab would be some older page.
  let tab = null;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  } catch { /* no normal window */ }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return captureTab(tab, debug);
}

// Reads one tab. From here to the end of the file is shared with the standalone
// extension (scripts/build-extension.js), which has no native host.
async function captureTab(tab, debug = {}) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return { error: 'This tab has no page to read.' };
  debug.host = new URL(tab.url).hostname;
  // A tab still loading, or showing a dialog, can stall script injection: don't wait forever.
  const res = await within(15000, (async () => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['Readability.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extract });
    return r;
  })());
  if (!res) return { error: 'The page didn’t respond (still loading?). Try again in a moment.', url: tab.url };
  let page = res.result || { error: 'Nothing to read on this tab.', url: tab.url };

  // Little text on the page itself: the content probably lives in an iframe (Claude
  // artifacts, embedded posts, some newsletter hosts). Read every frame, keep the fullest.
  if (page.weak) {
    const best = await fromFrames(tab.id, debug);
    if (best && best.text > (page.text || 0)) page = { ...best, title: page.title || best.title, url: page.url };
    delete page.weak;
  }

  // Google Docs draws text on a canvas; ask Docs for the document itself instead.
  if (page.kind === 'gdoc') {
    // Markdown export first (best formatting), then Docs' plain mobile view (served
    // from docs.google.com itself, fast, follows document tabs), then the HTML export.
    for (const src of page.sources) {
      const got = await within(src.wait, fetchText(tab.id, src.url));
      debug[src.type] = got?.body ? got.body.length : (got?.status || 'timeout');
      if (!got?.body) continue;
      if (src.type === 'md') return { kind: 'markdown', title: page.title, url: page.url, content: got.body };
      const m = got.body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const html = (m ? m[1] : got.body).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
      return { kind: 'html', title: page.title, url: page.url, content: html };
    }
    return { error: 'Google Docs didn’t send the document (are you signed in, and allowed to download it?).' };
  }

  if (page.kind === 'diff' && page.diffUrl) {
    // GitHub serves .diff files from another host for private repos; fetching from here
    // (with the extension's host access, and your GitHub sign-in) avoids the page's CORS.
    try {
      const r = await fetch(page.diffUrl, { credentials: 'include' });
      if (r.ok) page.diff = await r.text();
    } catch { /* fall back to the page's own fetch below */ }
    if (!page.diff) {
      const [r2] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, args: [page.diffUrl],
        func: async (u) => { try { const r = await fetch(u); return r.ok ? r.text() : null; } catch { return null; } },
      });
      page.diff = r2?.result || null;
    }
    if (!page.diff) return page.fallback || { error: 'GitHub didn’t send the diff.' };
    delete page.fallback;
  }
  return page;
}

// Fetch as the page would (same origin, your sign-in), then from here (no CORS).
// { body } on success, else { status } saying what went wrong (for the capture log).
async function fetchText(tabId, url) {
  let status = 'failed';
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, args: [url],
      func: async (u) => {
        try { const r = await fetch(u, { credentials: 'include' }); return r.ok ? { body: await r.text() } : { status: r.status }; }
        catch (e) { return { status: 'page:' + (e?.name || 'error') }; }
      },
    });
    if (r?.result?.body) return r.result;
    status = r?.result?.status || status;
  } catch { /* fall through */ }
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (r.ok) return { body: await r.text() };
    status += '/' + r.status;
  } catch (e) { status += '/' + (e?.name || 'error'); }
  return { status };
}

const within = (ms, p) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

// Run extract() in every frame of the tab; the result with the most text. Ads and
// trackers often have frames that never answer, so each gets 3 seconds.
async function fromFrames(tabId, debug = {}) {
  if (!chrome.webNavigation) return fromAllFrames(tabId, debug);
  let frames = [];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { return null; }
  frames = (frames || []).filter((f) => f.frameId !== 0 && /^https?:|^about:|^blob:/.test(f.url));
  debug.frames = frames.length;
  const results = await Promise.all(frames.map((f) => within(3000, (async () => {
    const target = { tabId, frameIds: [f.frameId] };
    await chrome.scripting.executeScript({ target, files: ['Readability.js'] });
    const [r] = await chrome.scripting.executeScript({ target, func: extract });
    return r?.result;
  })())));
  debug.framesAnswered = results.filter(Boolean).length;
  return results.filter((p) => p && p.kind === 'html' && p.text > 0).sort((a, b) => b.text - a.text)[0] || null;
}

// The standalone extension asks for fewer permissions (no webNavigation): every frame
// it may read, in one go, given 4 seconds.
async function fromAllFrames(tabId, debug = {}) {
  const target = { tabId, allFrames: true };
  const rs = await within(4000, (async () => {
    await chrome.scripting.executeScript({ target, files: ['Readability.js'] });
    return chrome.scripting.executeScript({ target, func: extract });
  })());
  const results = (rs || []).filter((r) => r.frameId !== 0).map((r) => r.result);
  debug.framesAnswered = results.filter(Boolean).length;
  return results.filter((p) => p && p.kind === 'html' && p.text > 0).sort((a, b) => b.text - a.text)[0] || null;
}

// Runs inside the page (so it sees what you see, signed in). Must be self-contained.
async function extract() {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const title = () => document.title.replace(/\s+[-–|·]\s+[^-–|·]{1,40}$/, '').trim() || document.title;

  // Formulas: whatever drew them (KaTeX, MathJax, Wikipedia, MathML), keep the TeX on a
  // plain <span data-math> so it survives the clean-up below and Readability (which drops
  // classes and scripts). The reader draws them again. MathML without TeX stays as it is.
  const mathify = (root) => {
    const doc = root.ownerDocument || root;
    const texOf = (el) => (el?.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"], annotation[encoding="text/x-tex"]')?.textContent || '').trim();
    const put = (el, tex, display) => {
      tex = (tex || '').trim().replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, '$1');
      if (!tex) return;
      const s = doc.createElement('span');
      s.setAttribute('data-math', tex);
      s.setAttribute('data-display', display ? '1' : '0');
      s.textContent = tex;
      el.replaceWith(s);
    };
    const each = (sel, fn) => [...root.querySelectorAll(sel)].forEach((el) => { if (root.contains(el) && !el.parentElement?.closest('[data-display]')) fn(el); });
    each('[data-math]:not([data-display])', (el) => put(el, el.getAttribute('data-math'),
      /\bmath-(block|display)\b/.test(el.className || '') || !!el.querySelector('.katex-display, math[display="block"]')));
    each('script[type^="math/tex"]', (el) => {
      for (let p = el.previousElementSibling; p && /^(MathJax|mjx)/.test(p.className || p.id || ''); p = el.previousElementSibling) p.remove();
      put(el, el.textContent, /mode\s*=\s*display/.test(el.type));
    });
    each('.katex-display, .katex', (el) => put(el, texOf(el), el.matches('.katex-display') || !!el.parentElement?.closest('.katex-display')));
    each('mjx-container', (el) => put(el, el.getAttribute('data-latex') || texOf(el), /^(true|block)$/.test(el.getAttribute('display') || '')));
    each('.mwe-math-element', (el) => { const m = el.querySelector('math'); put(el, texOf(m) || m?.getAttribute('alttext'), /--display/.test(el.className) || m?.getAttribute('display') === 'block'); });
    each('math', (el) => put(el, texOf(el) || el.getAttribute('alttext'), el.getAttribute('display') === 'block'));
    return root;
  };

  // Make an HTML fragment safe to read elsewhere: absolute links and images, real
  // image sources for lazy-loaded pictures, and no page furniture.
  const clean = (root) => {
    mathify(root);
    root.querySelectorAll('script, style, noscript, iframe, button, form, input, select, textarea, ' +
      'svg.octicon, a.anchor, clipboard-copy, .zeroclipboard-container, [aria-hidden="true"]:not(img)').forEach((n) => n.remove());
    root.querySelectorAll('img').forEach((img) => {
      let src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) {
        src = img.getAttribute('data-src') || img.getAttribute('data-original') ||
          (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '').split(',').pop().trim().split(/\s+/)[0] || src;
      }
      if (!src) { img.remove(); return; }
      img.setAttribute('src', abs(src));
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
    });
    root.querySelectorAll('picture source').forEach((s) => s.remove());
    // Code blocks with a toolbar inside (language label, "Copy code"): keep just the code.
    root.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code || pre.children.length === 1 && pre.firstElementChild === code) return;
      const lang = (code.className.match(/language-[\w+-]+/) || [''])[0];
      const fresh = document.createElement('pre'), c = document.createElement('code');
      if (lang) c.className = lang;
      c.textContent = code.textContent;
      fresh.appendChild(c);
      pre.replaceWith(fresh);
    });
    root.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', abs(a.getAttribute('href'))));
    return root;
  };

  // 1. Selected text: read just that.
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 40) {
    const div = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
    return { kind: 'html', title: title(), url: location.href, content: clean(div).innerHTML, selection: true };
  }

  // 1a. ChatGPT and Claude: the whole conversation from the site's own API (what the
  // page itself loads, with your sign-in; the page only keeps some messages on screen,
  // and its markup changes often). Markdown, each prompt a heading like Claude Code
  // sessions. Canvases / artifacts (their latest version) and images come along.
  // Nothing leaves this page.
  const demote = (md) => { let fence = false; return md.split('\n').map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence && /^#{1,5}\s/.test(l) ? '#' + (l.startsWith('##') ? '' : '#') + l : l;
  }).join('\n'); };
  const shift = (md, n) => { let fence = false; return md.split('\n').map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && l.match(/^(#{1,6})(\s.*)$/);
    return m ? '#'.repeat(Math.min(6, m[1].length + n)) + m[2] : l;
  }).join('\n'); };
  const fenced = (code, lang = '') => {
    const f = '`'.repeat(Math.max(3, ...(code.match(/`{3,}/g) || []).map((x) => x.length + 1)));
    return `${f}${lang}\n${code}\n${f}`;
  };
  // A canvas / artifact as Markdown under its own heading. kind: markdown | code | html | svg | mermaid
  const artifactMd = (label, a) => {
    const content = String(a.content || '').replace(/\s+$/, '');
    let body;
    if (a.kind === 'markdown') body = shift(content, 3);
    else if (a.kind === 'mermaid') body = fenced(content, 'mermaid');
    else if (a.kind === 'svg' && /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(content)) body = content.replace(/<\?xml[^>]*>/, '').replace(/\n\s*\n/g, '\n');
    else if (a.kind === 'html') {
      const d = new DOMParser().parseFromString(content, 'text/html');
      d.querySelectorAll('script, style, noscript, link, meta, template').forEach((n) => n.remove());
      mathify(d.body);
      d.body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => { const x = d.createElement('h' + Math.min(6, +h.localName[1] + 3)); x.append(...h.childNodes); h.replaceWith(x); });
      body = d.body.textContent.replace(/\s+/g, ' ').trim().length > 120
        ? `<div>\n${d.body.innerHTML.replace(/\n\s*\n/g, '\n').trim()}\n</div>` : fenced(content, 'html');
    } else body = fenced(content, a.lang || '');
    return `### ${label}: ${(a.title || 'Untitled').replace(/\n/g, ' ')}\n\n${body}`;
  };
  const chatDoc = (name, heading, turns) => {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const answered = turns.filter((t) => t.answers.length || t.extras?.length).length;
    const parts = [`# ${heading}`, `*${name} · ${answered} answer${answered === 1 ? '' : 's'}*`];
    turns.forEach((t, i) => {
      const first = (t.prompt.split('\n').find((l) => l.trim()) || '').trim();
      const head = first.length > 120 ? first.slice(0, 119) + '…' : first || (t.images?.length ? 'Image' : `${name}’s answer`);
      if (i) parts.push('---');
      parts.push(`<h2 id="gr-turn-${i + 1}">${esc(head)}</h2>`);
      if (t.prompt.replace(/\s+/g, ' ').length > head.length + 2) parts.push(t.prompt.split('\n').map((l) => '> ' + l).join('\n'));
      for (const src of t.images || []) parts.push(`![Your image](${src})`);
      if (t.answers.length) parts.push(t.answers.map(demote).join('\n\n---\n\n'));
      for (const x of t.extras || []) parts.push(x);
    });
    return parts.join('\n\n') + '\n';
  };
  // Artifacts edited over several turns are shown once, in their latest version, after the
  // last answer that changed them; where they began, a line points ahead to it.
  const placeArtifacts = (turns, list, label) => {
    for (const a of list) {
      if (!a.content || a.at < 0 || !turns[a.at]) continue;
      (turns[a.at].extras ??= []).push(artifactMd(label, a));
      if (a.from >= 0 && a.from < a.at) (turns[a.from].extras ??= []).push(`*${label} “${a.title || 'Untitled'}”: its latest version is further down.*`);
    }
  };
  const blobData = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(b); });

  // ChatGPT's newer answers mix Markdown with its own UI components (<box>, <row>,
  // <badge>, <divider/>, <AsyncImage/>, <WritingBlock>…). A browser would read
  // <divider/> as an element left open that swallows the rest of the answer, so turn
  // them into plain Markdown: containers become line breaks, writing blocks quotes,
  // badges inline code, and decoration (icons, buttons, stock images) goes.
  const uiToMd = (md) => {
    const UI = /<\/?(box|row|column|stack|grid|grid-item|list|list-item|card|text|badge|title|divider|icon|button|radio-group|radio|checkbox|AsyncImage|WritingBlock|Image|image|link|spacer)\b[^>]*>/;
    if (!UI.test(md)) return md;
    const BLOCK = /^(box|row|column|stack|grid|grid-item|list|card|radio-group)$/;
    const out = [];
    let fence = null, depth = 0;
    for (const line of md.split('\n')) {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) { out.push(line); if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
      if (f) { fence = f[1]; out.push(depth ? line.trimStart() : line); continue; }
      out.push(depth ? line.trimStart() : line);
      for (const m of line.matchAll(/<(\/?)([\w-]+)\b[^>]*?(\/?)>/g)) {
        if (!BLOCK.test(m[2]) || m[3]) continue;
        depth = Math.max(0, depth + (m[1] ? -1 : 1));
      }
    }
    // Only outside code: split on fences, convert the even (prose) parts.
    return out.join('\n').split(/(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*$)/m).map((part, i) => (i % 2 ? part : part
      .replace(/<WritingBlock\b[^>]*>([\s\S]*?)<\/WritingBlock>/g, (_, t) => '\n\n' + t.trim().split('\n').map((l) => '> ' + l.trim()).join('\n') + '\n\n')
      .replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '')
      .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `**${t.trim()}**`)
      .replace(/<badge\b[^>]*>([\s\S]*?)<\/badge>/g, (_, t) => t.trim() ? `\`${t.trim()}\`` : '')
      .replace(/<list-item\b[^>]*>/g, '\n- ').replace(/<\/list-item>/g, '\n')
      .replace(/<(radio|checkbox)\b[^>]*?label="([^"]*)"[^>]*\/?>/g, '\n- $2\n')
      .replace(/<divider\b[^>]*\/?>/g, '\n\n')
      .replace(/<([\w-]+)\b[^>]*\/>/g, (t, n) => (UI.test(`<${n}>`) ? '' : t)) // other self-closing UI: icons, stock images
      .replace(/<\/?([\w-]+)\b[^>]*>/g, (t, n) => (!UI.test(`<${n}>`) ? t : BLOCK.test(n) ? '\n\n' : ''))
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n'))).join('');
  };

  const gpt = /^(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname) && location.pathname.match(/\/c\/([\w-]{20,})/);
  let gptDbg = null;
  if (gpt) {
    try {
      const sess = await (await fetch('/api/auth/session', { credentials: 'include' })).json();
      const auth = sess?.accessToken ? { Authorization: `Bearer ${sess.accessToken}` } : {};
      const api = (u) => fetch(u, { credentials: 'include', headers: auth });
      const r = await api(`/backend-api/conversation/${gpt[1]}`);
      if (!r.ok) throw new Error('api ' + r.status);
      const j = await r.json();
      const chain = [];
      for (let id = j.current_node; id && j.mapping?.[id]; id = j.mapping[id].parent) chain.unshift(j.mapping[id].message);
      // Citation and entity markers: entities keep their name, the rest go.
      const unmark = (s) => s
        .replace(/entity(\[[\s\S]*?\])/g, (_, a) => { try { const v = JSON.parse(a); return typeof v[1] === 'string' ? v[1] : ''; } catch { return ''; } })
        .replace(/[ \t]*[^]*/g, '');
      const textOf = (m) => unmark(m?.content?.content_type === 'text' || m?.content?.content_type === 'multimodal_text'
        ? (m.content.parts || []).filter((p) => typeof p === 'string').join('\n\n') : '').trim();
      const imagesOf = (m) => [
        ...(m?.content?.parts || []).filter((p) => p?.content_type === 'image_asset_pointer' && p.asset_pointer).map((p) => p.asset_pointer),
        ...(m?.metadata?.aggregate_result?.messages || []).filter((x) => x?.image_url).map((x) => x.image_url), // charts from code
      ];
      const turns = [], docs = [], pending = []; // pending: [turn, 'images'|'answers', pointer]
      let cur = null;
      const turn = () => { if (!turns.length) turns.push({ prompt: '', answers: [] }); return turns.length - 1; };
      const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
      for (const m of chain) {
        if (!m) continue;
        const role = m.author?.role, to = m.recipient || 'all';
        if (role === 'user') {
          if (m.metadata?.is_visually_hidden_from_conversation) continue;
          const t = textOf(m), imgs = imagesOf(m);
          if (!t && !imgs.length) continue;
          turns.push({ prompt: t, answers: [], images: [] });
          imgs.forEach((p) => pending.push([turns.length - 1, 'images', p]));
        } else if (role === 'assistant' && to === 'all') {
          if (m.metadata?.is_visually_hidden_from_conversation) continue;
          const t = uiToMd(textOf(m));
          if (t) turns[turn()].answers.push(t);
        } else if (role === 'assistant' && /^canmore\.create_textdoc$/.test(to)) {
          const c = json(m.content?.text || m.content?.parts?.[0] || '');
          if (!c) continue;
          const type = String(c.type || 'document');
          cur = { title: c.name, content: c.content || '', kind: type === 'document' ? 'markdown' : 'code',
            lang: (type.split('/')[1] || '').replace(/^react$/, 'jsx'), id: null, from: turn(), at: turn() };
          docs.push(cur);
        } else if (role === 'assistant' && /^canmore\.update_textdoc$/.test(to) && cur) {
          for (const u of json(m.content?.text || '')?.updates || []) {
            try { cur.content = cur.content.replace(new RegExp(u.pattern, u.multiple ? 'gs' : 's'), () => u.replacement); } catch { /* a pattern JS can't read */ }
          }
          cur.at = turn();
        } else if (role === 'tool') {
          const id = m.metadata?.canvas?.textdoc_id;
          if (id && cur && /^canmore\./.test(m.author?.name || '')) cur.id ??= id;
          imagesOf(m).forEach((p) => pending.push([turn(), 'answers', p])); // generated images
        }
      }
      // The canvases as ChatGPT keeps them now (covers edits made by hand in the canvas).
      try {
        const td = await Promise.race([api(`/backend-api/conversation/${gpt[1]}/textdocs`).then((x) => (x.ok ? x.json() : null)), new Promise((res) => setTimeout(() => res(null), 3000))]);
        for (const d of Array.isArray(td) ? td : td?.textdocs || []) {
          if (typeof d?.content !== 'string') continue;
          const mine = docs.find((x) => x.id && x.id === d.id) || docs.find((x) => !x.id && x.title === d.title);
          if (mine) { mine.content = d.content; continue; }
          const type = String(d.textdoc_type || 'document');
          docs.push({ title: d.title, content: d.content, kind: type === 'document' ? 'markdown' : 'code', lang: type.split('/')[1] || '', from: -1, at: turn() });
        }
      } catch { /* the replayed versions will do */ }
      // Images: fetched here (they need your sign-in) and passed on as data, within a few seconds.
      const conv = gpt[1];
      const fetchImg = async (ptr) => {
        const id = String(ptr).replace(/^[\w-]+:\/\//, '');
        const urls = [`/backend-api/files/download/${id}?conversation_id=${conv}&inline=false`, `/backend-api/files/${id}/download`];
        if (!/^sediment:/.test(ptr)) urls.reverse();
        for (const u of urls) {
          try {
            const meta = await (await api(u)).json();
            if (!meta?.download_url) continue;
            const href = new URL(meta.download_url, location.href).href;
            try {
              const b = await (await fetch(href, { credentials: new URL(href).origin === location.origin ? 'include' : 'omit' })).blob();
              if (b.type.startsWith('image/') && b.size < 8e6) return await blobData(b);
            } catch { /* cross-origin without CORS: the signed link itself still works for a while */ }
            return href;
          } catch { /* next */ }
        }
        return null;
      };
      const got = await Promise.all(pending.slice(0, 24).map(([, , p]) => Promise.race([fetchImg(p), new Promise((res) => setTimeout(() => res(null), 5000))])));
      pending.slice(0, 24).forEach(([t, where, p], i) => {
        const src = got[i];
        if (where === 'images') { if (src) turns[t].images.push(src); }
        else turns[t].answers.push(src ? '![Image](' + src + ')' : '*An image ChatGPT made (couldn’t be fetched).*');
      });
      placeArtifacts(turns, docs, 'Canvas');
      gptDbg = { api: turns.length, canvas: docs.length, images: got.filter(Boolean).length + '/' + pending.length };
      if (turns.length) {
        const content = chatDoc('ChatGPT', j.title || 'ChatGPT conversation', turns);
        return { kind: 'markdown', chat: 'ChatGPT', title: j.title || title(), url: location.href, content, text: content.length, dbg: gptDbg };
      }
    } catch (e) { gptDbg = { api: String(e?.message || e).slice(0, 60) }; }
  }
  const cld = location.hostname === 'claude.ai' && location.pathname.match(/\/chat\/([0-9a-f-]{36})/);
  if (cld) {
    try {
      let org = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/) || [])[1];
      if (!org) {
        const orgs = await (await fetch('/api/organizations', { credentials: 'include' })).json();
        org = (orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0])?.uuid;
      }
      if (!org) throw new Error('no org');
      const r = await fetch(`/api/organizations/${org}/chat_conversations/${cld[1]}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: 'include' });
      if (!r.ok) throw new Error('api ' + r.status);
      const j = await r.json();
      const all = j.chat_messages || [];
      // The branch on screen: walk back from the current leaf (edits and retries fork).
      const byId = new Map(all.map((m) => [m.uuid, m]));
      let chain = [];
      for (let m = byId.get(j.current_leaf_message_uuid); m; m = byId.get(m.parent_message_uuid)) chain.unshift(m);
      if (!chain.length) chain = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const textOf = (m) => (Array.isArray(m.content) && m.content.length
        ? m.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n\n')
        : m.text || '').trim();
      // Artifacts: the artifacts tool (create / update / rewrite), and files Claude made
      // for you to download (create_file / str_replace under outputs/).
      const KINDS = { 'text/markdown': 'markdown', 'text/html': 'html', 'image/svg+xml': 'svg', 'application/vnd.ant.mermaid': 'mermaid', 'application/vnd.ant.react': 'code' };
      const LANG = { py: 'python', js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx', sh: 'bash', rb: 'ruby', rs: 'rust', yml: 'yaml', md: '', txt: '' };
      const byExt = (p) => { const e = (p.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
        return { kind: /^(md|markdown)$/.test(e) ? 'markdown' : /^html?$/.test(e) ? 'html' : e === 'svg' ? 'svg' : /^(mmd|mermaid)$/.test(e) ? 'mermaid' : 'code', lang: LANG[e] ?? e }; };
      const arts = new Map();
      const turns = [];
      for (const m of chain) {
        const t = textOf(m);
        if (m.sender === 'human') { turns.push({ prompt: t, answers: [] }); continue; }
        if (m.sender !== 'assistant') continue;
        if (!turns.length) turns.push({ prompt: '', answers: [] });
        const at = turns.length - 1;
        if (t) turns[at].answers.push(t);
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type !== 'tool_use' || !c.input) continue;
          const x = c.input;
          if (c.name === 'artifacts' && x.id) {
            let a = arts.get(x.id);
            if (!a) { a = { title: x.title, content: '', from: at }; arts.set(x.id, a); }
            if (x.title) a.title = x.title;
            if (x.type) Object.assign(a, { kind: KINDS[x.type] || 'code', lang: x.type === 'application/vnd.ant.react' ? 'jsx' : x.language || '' });
            if (x.command === 'update' && typeof x.old_str === 'string') a.content = a.content.replace(x.old_str, () => x.new_str || '');
            else if (typeof x.content === 'string') a.content = x.content;
            a.at = at;
          } else if (/^(create_file|str_replace|str_replace_based_edit_tool)$/.test(c.name) && /\/outputs\//.test(x.path || '')) {
            let a = arts.get(x.path);
            if (!a) { a = { title: x.path.split('/').pop(), content: '', from: at, ...byExt(x.path) }; arts.set(x.path, a); }
            if (typeof x.file_text === 'string') a.content = x.file_text;
            else if (typeof x.old_str === 'string') a.content = a.content.replace(x.old_str, () => x.new_str || '');
            a.at = at;
          }
        }
      }
      placeArtifacts(turns, [...arts.values()], 'Artifact');
      gptDbg = { api: turns.length, artifacts: arts.size };
      if (turns.some((t) => t.answers.length || t.extras?.length)) {
        const name = j.name || title().replace(/\s*[-|·]\s*Claude$/i, '');
        const content = chatDoc('Claude', name || 'Claude conversation', turns);
        return { kind: 'markdown', chat: 'Claude', title: name || title(), url: location.href, content, text: content.length, dbg: gptDbg };
      }
    } catch (e) { gptDbg = { api: String(e?.message || e).slice(0, 60) }; }
  }

  // 1b. AI chats (ChatGPT, Claude, Gemini): the whole conversation, each prompt a heading
  // (like Claude Code sessions), not the one reply Readability would pick.
  const CHATS = {
    'chatgpt.com': { msg: '[data-message-author-role]', role: (n) => n.getAttribute('data-message-author-role'), body: (n) => n.querySelector('.markdown') || n, name: 'ChatGPT' },
    'chat.openai.com': { msg: '[data-message-author-role]', role: (n) => n.getAttribute('data-message-author-role'), body: (n) => n.querySelector('.markdown') || n, name: 'ChatGPT' },
    'claude.ai': { msg: '[data-testid="user-message"], [data-is-streaming], .font-claude-response, .font-claude-message', role: (n) => (n.matches('[data-testid="user-message"]') ? 'user' : 'assistant'), body: (n) => n, name: 'Claude' },
    'gemini.google.com': { msg: 'user-query, model-response', role: (n) => (n.localName === 'user-query' ? 'user' : 'assistant'), body: (n) => n.querySelector('.query-text, message-content') || n, name: 'Gemini' },
  };
  const chat = CHATS[location.hostname];
  // Gemini keeps only the latest turns on the page and loads older ones as you scroll
  // up: scroll its history to the top until no more arrive, then put it back.
  if (location.hostname === 'gemini.google.com' && document.querySelector('user-query')) {
    let sc = document.querySelector('user-query').parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (sc) {
      const fromBottom = sc.scrollHeight - sc.scrollTop;
      const until = Date.now() + 6000;
      for (let n = -1, same = 0; same < 3 && Date.now() < until;) {
        const count = document.querySelectorAll('user-query').length;
        same = count === n ? same + 1 : 0;
        n = count;
        sc.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 350));
      }
      sc.scrollTop = sc.scrollHeight - fromBottom;
    }
  }
  const msgs = chat ? [...document.querySelectorAll(chat.msg)].filter((n, i, all) => !all.some((o) => o !== n && o.contains(n))) : [];
  if (msgs.length) {
    const turns = []; // { prompt, answers: [html] }
    // Gemini: pictures it made sit outside the answer's text, and a canvas appears in the
    // answer only as a chip; its content is in a side panel, there only while it is open.
    const gem = location.hostname === 'gemini.google.com', chips = [];
    const geminiExtras = (n, b) => {
      for (const img of n.querySelectorAll('img')) {
        if (chat.body(n).contains(img) || img.closest('model-thoughts, sources-carousel-inline, source-inline-chip, sources-list, [class*="avatar"]')) continue;
        if ((img.naturalWidth || img.width) >= 160) b.append(img.cloneNode(true));
      }
      for (const chip of b.querySelectorAll('immersive-entry-chip, .immersive-entry-chip, [data-test-id*="immersive"]')) {
        if (!b.contains(chip)) continue;
        const t = (chip.querySelector('[data-test-id="artifact-text"], [class*="title"]')?.textContent || chip.textContent || '').trim().split('\n')[0].trim().slice(0, 120);
        const p = document.createElement('p'), em = document.createElement('em');
        em.textContent = `Canvas: ${t || 'untitled'}`;
        p.append(em);
        chip.replaceWith(p);
        chips.push({ title: t, turn: turns.length - 1 });
      }
    };
    for (const n of msgs) {
      const role = chat.role(n);
      const b = chat.body(n).cloneNode(true);
      if (role === 'user') {
        // Whichever keeps the line breaks (innerText depends on the page's CSS).
        const nl = (x) => (x.match(/\n/g) || []).length;
        const it = chat.body(n).innerText || '', tc = b.textContent || '';
        // Gemini starts each prompt with a hidden "You said" for screen readers.
        let prompt = (nl(it) >= nl(tc.trim()) ? it : tc).trim().replace(gem ? /^You said\s*/ : /^$/, '');
        // Gemini also holds each prompt twice (whole, then line by line): keep one copy.
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        const ps = prompt.split(/\n{2,}/);
        for (let k = 0; k < ps.length - 1; k++) if (flat(ps[k]) === flat(ps.slice(k + 1).join(' '))) { ps.splice(k, 1); k--; }
        for (let k = 1; k < ps.length; k++) if (flat(ps[k]) === flat(ps[k - 1])) ps.splice(k--, 1);
        prompt = ps.join('\n\n');
        turns.push({ prompt, answers: [] });
      } else if (role === 'assistant') {
        if (!turns.length) turns.push({ prompt: '', answers: [] });
        if (gem) geminiExtras(n, b);
        clean(b);
        // Move the children rather than copying innerHTML: Gemini enforces Trusted Types.
        b.querySelectorAll('h1, h2, h3').forEach((h) => { const x = document.createElement(h.localName === 'h3' ? 'h4' : 'h3'); x.append(...h.childNodes); h.replaceWith(x); });
        turns[turns.length - 1].answers.push(b.innerHTML);
      }
    }
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // The open Gemini canvas (or Deep Research report), after the answer that made it.
    const panel = gem && document.querySelector('immersive-panel, code-immersive-panel, deep-research-immersive-panel, [class*="immersive-panel"]');
    if (panel && panel.textContent.trim().length > 40) {
      const ptitle = (panel.querySelector('[data-test-id*="title"], [class*="title"], h1, h2')?.textContent || '').trim().split('\n')[0].trim().slice(0, 120);
      const rich = panel.querySelector('.ProseMirror, [contenteditable="true"], message-content, .markdown');
      const lines = panel.querySelector('.view-lines, .cm-content');
      let html;
      if (rich) {
        const c = clean(rich.cloneNode(true));
        c.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => { const x = document.createElement('h' + Math.min(6, +h.localName[1] + 3)); x.append(...h.childNodes); h.replaceWith(x); });
        html = c.innerHTML;
      }
      else if (lines) {
        const ls = [...lines.querySelectorAll('.view-line, .cm-line')].sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));
        html = `<pre><code>${esc(ls.map((l) => l.textContent.replace(/\u00a0/g, ' ')).join('\n'))}</code></pre>` +
          '<p><em>Code editors keep only the lines on screen, so this may be part of the code.</em></p>';
      } else html = clean(panel.cloneNode(true)).innerHTML;
      const near = (c) => c.title && ptitle && (c.title.includes(ptitle) || ptitle.includes(c.title));
      const at = (chips.findLast(near) || chips.at(-1))?.turn ?? turns.length - 1;
      turns[Math.max(0, at)]?.answers.push(`<h3>Canvas: ${esc(ptitle || 'open canvas')}</h3>${html}`);
    }
    const out = turns.map((t, i) => {
      const first = (t.prompt.split('\n').find((l) => l.trim()) || '').trim();
      const head = first.length > 120 ? first.slice(0, 119) + '…' : first || `${chat.name}’s answer`;
      const longer = t.prompt.replace(/\s+/g, ' ').length > head.length + 2;
      const quote = longer ? `<blockquote>${t.prompt.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</blockquote>` : '';
      return `${i ? '<hr>' : ''}<h2 id="gr-turn-${i + 1}">${esc(head)}</h2>${quote}${t.answers.join('<hr>')}`;
    }).join('');
    const tt = document.title.replace(/\s*[-|·]\s*(ChatGPT|Claude|Gemini)$/i, '').trim() || `${chat.name} chat`;
    const text = turns.reduce((n, t) => n + t.prompt.length + t.answers.join('').length, 0);
    return { kind: 'html', chat: chat.name, title: tt, url: location.href, content: out, text, dbg: { ...gptDbg, dom: msgs.length } };
  }

  // 2. GitHub: the Markdown itself where we can get it, else GitHub's rendered posts.
  if (location.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = location.pathname.split('/').filter(Boolean);
    const reserved = ['settings', 'orgs', 'notifications', 'search', 'marketplace', 'explore', 'topics', 'sponsors', 'login'];
    if (owner && repo && !reserved.includes(owner)) {
      const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
      const dir = (p) => p.split('/').slice(0, -1).join('/');
      try {
        if (kind === 'blob' && /\.(md|markdown|mdx)$/i.test(rest.join('/'))) {
          const p = rest.join('/');
          const r = await fetch(`/${owner}/${repo}/raw/${ref}/${p}`);
          if (r.ok) return { kind: 'markdown', title: `${repo}: ${p.split('/').pop()}`, url: location.href, content: await r.text(), base: `https://github.com/${owner}/${repo}/raw/${ref}/${dir(p)}` };
        } else if (!kind || kind === 'tree') {
          const sub = kind === 'tree' ? rest.join('/') : '';
          const q = kind === 'tree' ? `?ref=${encodeURIComponent(ref)}` : '';
          const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme${sub ? '/' + sub : ''}${q}`, { credentials: 'omit' });
          if (r.ok) {
            const j = await r.json();
            const at = kind === 'tree' ? ref : 'HEAD';
            return { kind: 'markdown', title: `${owner}/${repo}`, url: location.href, content: decode(j.content), base: `https://github.com/${owner}/${repo}/raw/${at}/${dir(j.path)}` };
          }
        }
      } catch { /* private repo or rate-limited: fall through to the page */ }
      const postsHTML = () => {
        const ps = [...document.querySelectorAll('.markdown-body')].filter((n) => !n.parentElement.closest('.markdown-body') && n.textContent.trim());
        if (!ps.length) return '';
        const div = document.createElement('div');
        ps.forEach((n, i) => { if (i) div.appendChild(document.createElement('hr')); div.appendChild(n.cloneNode(true)); });
        return clean(div).innerHTML;
      };
      // Code changes: a PR's "Files changed" / "Changes" tab (all of it, one commit,
      // or a range of commits), a commit, or a comparison. GitHub's own .diff file.
      const sub = rest[0] || '', pick = rest[1] || '';
      let diffUrl = null, scope = '';
      if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(ref)) { diffUrl = `/${owner}/${repo}/commit/${ref}.diff`; scope = `Commit ${ref.slice(0, 7)}`; }
      else if (kind === 'compare' && ref) { diffUrl = `/${owner}/${repo}/compare/${[ref, ...rest].join('/')}.diff`; scope = `Comparing ${[ref, ...rest].join('/')}`; }
      else if (kind === 'pull' && /^\d+$/.test(ref) && /^(files|changes|commits?)$/.test(sub)) {
        const range = pick.match(/^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/i);
        if (range) { diffUrl = `/${owner}/${repo}/compare/${range[1]}...${range[2]}.diff`; scope = `Commits ${range[1].slice(0, 7)}…${range[2].slice(0, 7)}`; }
        else if (/^[0-9a-f]{7,40}$/i.test(pick)) { diffUrl = `/${owner}/${repo}/commit/${pick}.diff`; scope = `Commit ${pick.slice(0, 7)}`; }
        else { diffUrl = `/${owner}/${repo}/pull/${ref}.diff`; scope = `Pull request #${ref}`; }
      }
      if (diffUrl) {
        const intro = postsHTML();
        // "Fix the thing by someone · Pull Request #12 · owner/repo" → "Fix the thing (#12)"
        const t = document.title.split(' · ')[0].replace(/\s+by\s+\S+$/, '').trim();
        const label = kind === 'pull' ? `${t} (#${ref})` : t || title();
        return {
          kind: 'diff', title: label, url: location.href, scope, repo: `${owner}/${repo}`, intro,
          diffUrl: abs(diffUrl), fallback: intro ? { kind: 'html', title: title(), url: location.href, content: intro } : null,
        };
      }

      const posts = [...document.querySelectorAll('.markdown-body')].filter((n) => !n.parentElement.closest('.markdown-body') && n.textContent.trim());
      if (posts.length) {
        const div = document.createElement('div');
        posts.forEach((n, i) => { if (i) div.appendChild(document.createElement('hr')); div.appendChild(n.cloneNode(true)); });
        return { kind: 'html', title: title(), url: location.href, content: clean(div).innerHTML };
      }
    }
  }

  // 3. Google Docs: the page is a canvas, so hand back where to export it from.
  if (location.hostname === 'docs.google.com') {
    const m = location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
    if (m) {
      const tabId = new URLSearchParams(location.search).get('tab');
      const q = tabId ? `&tab=${encodeURIComponent(tabId)}` : '';
      const base = `https://docs.google.com/document/d/${m[1]}/export`;
      return {
        kind: 'gdoc', title: document.title.replace(/\s+-\s+Google Docs$/, '').trim(), url: location.href,
        sources: [
          { type: 'md', url: `${base}?format=md${q}`, wait: 6000 },
          { type: 'mobile', url: `https://docs.google.com/document/d/${m[1]}/mobilebasic${tabId ? '?tab=' + encodeURIComponent(tabId) : ''}`, wait: 5000 },
          { type: 'html', url: `${base}?format=html${q}`, wait: 5000 },
        ],
      };
    }
  }

  // 4. Articles, newsletters, blogs: Readability (Firefox Reader View's engine).
  try {
    // eslint-disable-next-line no-undef
    const art = new Readability(mathify(document.cloneNode(true)), { keepClasses: false }).parse();
    if (art?.content && (art.textContent || '').trim().length > 200) {
      const div = document.createElement('div');
      div.innerHTML = art.content;
      const text = art.textContent.trim().length;
      return { kind: 'html', title: art.title || title(), byline: art.byline || '', site: art.siteName || '', url: location.href, content: clean(div).innerHTML, text, dbg: chat ? { ...gptDbg, dom: 0 } : undefined };
    }
  } catch { /* fall through */ }

  // 5. Anything else: the main part of the page as it is. Little text here usually
  // means the real content is in an iframe; "weak" asks the caller to look there.
  const main = (document.querySelector('article, main, [role="main"]') || document.body).cloneNode(true);
  main.querySelectorAll('nav, header, footer, aside').forEach((n) => n.remove());
  clean(main);
  const text = main.textContent.replace(/\s+/g, ' ').trim().length;
  return { kind: 'html', title: title(), url: location.href, content: main.innerHTML, text, weak: text < 400, dbg: chat ? { ...gptDbg, dom: 0 } : undefined };
}
