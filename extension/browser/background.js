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
  // A prompt → its heading (the first line, as plain text) and the rest, to quote. Pasted
  // notes keep their shape: "•" bullets (alone on a line, or before the text) become a list.
  const promptParts = (prompt) => {
    const L = prompt.replace(/\r/g, '').split('\n'), tidy = [];
    for (let i = 0; i < L.length; i++) {
      if (/^\s*[•◦▪●‣∙]\s*$/.test(L[i])) {
        let j = i + 1;
        while (j < L.length && !L[j].trim()) j++;
        if (j < L.length) { tidy.push('- ' + L[j].trim()); i = j; continue; }
      }
      tidy.push(L[i].replace(/^(\s*)[•◦▪●‣∙]\s+/, '$1- '));
    }
    const at = tidy.findIndex((l) => l.trim());
    const first = at < 0 ? '' : tidy[at].trim();
    const plain = first.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    const cut = plain.length > 120;
    const head = cut ? plain.slice(0, 119) + '…' : plain;
    const rest = (cut ? tidy.slice(at) : tidy.slice(at + 1)).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    return { head, rest };
  };
  const chatDoc = (name, heading, turns) => {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const answered = turns.filter((t) => t.answers.length || t.extras?.length).length;
    const parts = [`# ${heading}`, `*${name} · ${answered} answer${answered === 1 ? '' : 's'}*`];
    turns.forEach((t, i) => {
      const { head: h, rest } = promptParts(t.prompt);
      const head = h || (t.images?.length ? 'Image' : `${name}’s answer`);
      if (i) parts.push('---');
      parts.push(`<h2 id="gr-turn-${i + 1}">${esc(head)}</h2>`);
      if (rest.trim()) parts.push(rest.split('\n').map((l) => '> ' + l).join('\n'));
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

  // ChatGPT's newer answers mix Markdown with its own UI: components (<box>, <row>,
  // <badge>, <divider/>, <AsyncImageGroup/>, <WritingBlock>…, with JSX in attributes)
  // and small interactive widgets written as templates ({@body const questions = […]},
  // {#each questions as q, i}, {#if submitted}…{/if}). A browser reads <divider/> as an
  // element left open that swallows the rest of the answer, and the templates are code.
  // So: the templates are run here (data and loops; nothing that depends on what you'd
  // click), a quiz becomes its questions with the answers, containers become paragraphs,
  // pictures the pictures (or a caption), and any other tag that isn't plain formatting
  // goes, keeping its text. Code and formulas are left alone.

  // A small, safe JavaScript expression reader for those templates (no eval: the chat
  // sites forbid it, and nothing here should be able to do anything but compute).
  const NOPE = Symbol('unknown'), STATE = Symbol('state');
  const OWN = new WeakSet(), own = (f) => (OWN.add(f), f);
  const METHODS = new Set(['map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'includes', 'indexOf', 'join', 'slice',
    'concat', 'flat', 'flatMap', 'at', 'keys', 'values', 'entries', 'toFixed', 'toUpperCase', 'toLowerCase', 'trim', 'split',
    'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat', 'charAt', 'toString', 'toLocaleString', 'replace', 'replaceAll']);
  const GLOBALS = Object.assign(Object.create(null), {
    Number: own((x) => Number(x)), String: own((x) => String(x)), Boolean: own((x) => Boolean(x)),
    parseInt: own((x, b) => parseInt(x, b)), parseFloat: own((x) => parseFloat(x)),
    Math: Object.fromEntries(['max', 'min', 'round', 'floor', 'ceil', 'abs', 'sqrt', 'pow', 'sign', 'trunc'].map((k) => [k, own((...a) => Math[k](...a))])),
    Object: { keys: own((o) => Object.keys(o)), values: own((o) => Object.values(o)), entries: own((o) => Object.entries(o)) },
    Array: { isArray: own((a) => Array.isArray(a)), from: own((a) => Array.from(a)) },
    JSON: { stringify: own((v) => JSON.stringify(v)) },
  });
  const skipStr = (s, i) => { const q = s[i]; for (i++; i < s.length && s[i] !== q; i++) { if (s[i] === '\\') i++; else if (s[i] === '\n' && q !== '`') return i; } return i + 1; };
  // s[i] is ( [ or {: the index after its partner, or -1.
  const skipBalanced = (s, i) => {
    const pair = { '(': ')', '[': ']', '{': '}' }, want = [pair[s[i]]];
    for (i++; i < s.length && want.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { i = skipStr(s, i) - 1; continue; }
      if (pair[c]) want.push(pair[c]); else if (c === want[want.length - 1]) want.pop();
    }
    return want.length ? -1 : i;
  };
  const jsLex = (src) => {
    const out = [];
    for (let i = 0; i < src.length;) {
      const c = src[i], rest = src.slice(i);
      let m;
      if (/\s/.test(c)) { i++; continue; }
      if ((m = /^(?:0[xX][\da-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(rest)) && /[\d.]/.test(c)) { out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) { out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"' || c === "'") {
        const end = skipStr(src, i);
        if (src[end - 1] !== c) throw new SyntaxError('string');
        out.push({ t: 'str', v: unesc(src.slice(i + 1, end - 1)) }); i = end; continue;
      }
      if (c === '`') {
        const end = skipStr(src, i), body = src.slice(i + 1, end - 1), parts = [];
        let k = 0, from = 0;
        while ((k = body.indexOf('${', k)) >= 0) {
          const e = skipBalanced(body, k + 1);
          if (e < 0) throw new SyntaxError('template');
          parts.push(unesc(body.slice(from, k)), body.slice(k + 2, e - 1));
          k = from = e;
        }
        parts.push(unesc(body.slice(from)));
        out.push({ t: 'tpl', v: parts }); i = end; continue;
      }
      m = /^(?:\.\.\.|===|!==|\*\*|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d))/.exec(rest);
      const p = m ? m[0] : c;
      out.push({ t: 'p', v: p }); i += p.length;
    }
    return out;
  };
  function unesc(s) {
    return s.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])/g, (_, e) => (/^u\{/.test(e) ? String.fromCodePoint(parseInt(e.slice(2, -1), 16))
      : /^[ux]/.test(e) && e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : { n: '\n', t: '\t', r: '', b: '', f: '', v: '', 0: '\0' }[e] ?? e));
  }
  const PREC = { '??': 1, '||': 2, '&&': 3, '==': 6, '!=': 6, '===': 6, '!==': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 };
  const BAD = /^(constructor|prototype|__\w*)$/;
  const getProp = (o, k) => {
    if (o == null) throw new TypeError('no object');
    if (BAD.test(String(k))) throw new TypeError('blocked');
    const v = o[k];
    if (typeof v === 'function' && !OWN.has(v) && !(METHODS.has(k) && (Array.isArray(o) || typeof o === 'string' || typeof o === 'number'))) throw new TypeError('blocked');
    return v;
  };
  // Source → a function of the scope (a prototype chain of plain objects).
  const jsParse = (src) => {
    const tk = jsLex(src);
    let p = 0;
    const is = (v, t = 'p') => tk[p] && tk[p].t === t && tk[p].v === v;
    const eat = (v) => { if (!is(v)) throw new SyntaxError('expected ' + v); p++; };
    const list = (close, item) => { const xs = []; while (!is(close)) { xs.push(item()); if (!is(close)) eat(','); } p++; return xs; };
    const spreadable = () => (is('...') ? (p++, { spread: expr() }) : { v: expr() });
    const arrow = (params) => {
      if (is('{')) throw new SyntaxError('block body');
      const body = expr();
      return (s) => own((...a) => { const sc = Object.create(s); params.forEach((n, i) => { sc[n] = a[i]; }); return body(sc); });
    };
    function expr() {
      if (tk[p]?.t === 'id' && tk[p + 1]?.t === 'p' && tk[p + 1].v === '=>') { const n = tk[p].v; p += 2; return arrow([n]); }
      if (is('(')) {
        let d = 0, k = p;
        for (; k < tk.length; k++) { if (tk[k].t === 'p' && tk[k].v === '(') d++; else if (tk[k].t === 'p' && tk[k].v === ')' && !--d) break; }
        if (tk[k + 1]?.t === 'p' && tk[k + 1].v === '=>') {
          const params = tk.slice(p + 1, k).filter((t) => !(t.t === 'p' && t.v === ','));
          if (params.some((t) => t.t !== 'id')) throw new SyntaxError('params');
          p = k + 2;
          return arrow(params.map((t) => t.v));
        }
      }
      const c = binary(1);
      if (!is('?')) return c;
      p++;
      const a = expr(); eat(':'); const b = expr();
      return (s) => (c(s) ? a(s) : b(s));
    }
    function binary(min) {
      let l = unary();
      for (;;) {
        const t = tk[p], op = t?.t === 'p' ? t.v : null, pr = PREC[op];
        if (!pr || pr < min) return l;
        p++;
        const r = binary(op === '**' ? pr : pr + 1), L = l;
        l = (s) => {
          if (op === '&&') return L(s) && r(s);
          if (op === '||') return L(s) || r(s);
          if (op === '??') return L(s) ?? r(s);
          const a = L(s), b = r(s);
          switch (op) {
            case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b; // eslint-disable-line eqeqeq
            case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
            case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
            default: return a ** b;
          }
        };
      }
    }
    function unary() {
      if (is('!') || is('-') || is('+') || is('typeof', 'id')) {
        const op = tk[p++].v, x = unary();
        return op === '!' ? (s) => !x(s) : op === '-' ? (s) => -x(s) : op === '+' ? (s) => +x(s) : (s) => typeof x(s);
      }
      return postfix(primary());
    }
    function postfix(f) {
      for (;;) {
        const opt = is('?.');
        if (is('.') || opt) {
          p++;
          if (opt && (is('(') || is('['))) continue; // a?.(…) / a?.[…]: handled below as plain
          const o = f, k = tk[p++];
          if (k?.t !== 'id') throw new SyntaxError('property');
          f = Object.assign((s) => { const x = o(s); return opt && x == null ? undefined : getProp(x, k.v); }, { obj: o, key: () => k.v, opt });
        } else if (is('[')) {
          p++;
          const o = f, k = expr(); eat(']');
          f = Object.assign((s) => getProp(o(s), k(s)), { obj: o, key: k });
        } else if (is('(')) {
          p++;
          const callee = f, args = list(')', spreadable);
          f = (s) => {
            const a = args.flatMap((x) => (x.spread ? [...x.spread(s)] : [x.v(s)]));
            if (callee.obj) {
              const o = callee.obj(s);
              if (callee.opt && o == null) return undefined;
              const fn = getProp(o, callee.key(s));
              if (typeof fn !== 'function') throw new TypeError('not a function');
              return fn.apply(o, a);
            }
            const fn = callee(s);
            if (!OWN.has(fn)) throw new TypeError('not callable');
            return fn(...a);
          };
        } else return f;
      }
    }
    function primary() {
      const t = tk[p++];
      if (!t) throw new SyntaxError('end');
      if (t.t === 'num' || t.t === 'str') return () => t.v;
      if (t.t === 'tpl') {
        const fs = t.v.map((x, i) => (i % 2 ? jsParse(x) : () => x));
        return (s) => fs.map((f) => { const v = f(s); return v == null ? '' : String(v); }).join('');
      }
      if (t.t === 'id') {
        const lit = { true: true, false: false, null: null, undefined, NaN, Infinity };
        if (t.v in lit) return () => lit[t.v];
        return (s) => {
          if (!(t.v in s)) throw NOPE;
          const v = s[t.v];
          if (v === STATE) throw NOPE;
          return v;
        };
      }
      if (t.v === '(') { const e = expr(); eat(')'); return e; }
      if (t.v === '[') {
        const xs = list(']', spreadable);
        return (s) => xs.flatMap((x) => (x.spread ? [...x.spread(s)] : [x.v(s)]));
      }
      if (t.v === '{') {
        const props = list('}', () => {
          if (is('...')) { p++; return { spread: expr() }; }
          const k = tk[p++];
          let key;
          if (k.t === 'p' && k.v === '[') { key = expr(); eat(']'); } else if (k.t === 'id' || k.t === 'str' || k.t === 'num') key = () => k.v;
          else throw new SyntaxError('key');
          if (is(':')) { p++; return { key, v: expr() }; }
          if (k.t !== 'id') throw new SyntaxError('shorthand');
          return { key, v: jsParse(k.v) };
        });
        return (s) => {
          const o = {};
          for (const x of props) {
            if (x.spread) Object.assign(o, x.spread(s));
            else { const k = String(x.key(s)); if (!BAD.test(k)) o[k] = x.v(s); }
          }
          return o;
        };
      }
      throw new SyntaxError('unexpected ' + t.v);
    }
    const e = expr();
    if (p < tk.length) throw new SyntaxError('trailing');
    return e;
  };
  const jsEval = (src, scope) => jsParse(src)(scope);

  // {@body const x = …} / {@const …}: data, and React-style state (unknown until clicked).
  const runBody = (src, scope) => {
    const stmts = [];
    for (let i = 0, from = 0; i <= src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') { i = skipStr(src, i) - 1; continue; }
      if (c === '(' || c === '[' || c === '{') { const e = skipBalanced(src, i); if (e < 0) break; i = e - 1; continue; }
      if (c === ';' || c === '\n' && /^\s*(const|let|var|function)\b/.test(src.slice(i + 1)) || i === src.length) { stmts.push(src.slice(from, i)); from = i + 1; }
    }
    for (const st of stmts) {
      const m = /^\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[\w$]+)\s*=(?!=)\s*([\s\S]+?)\s*$/.exec(st);
      if (!m) continue;
      const names = m[1].replace(/[[\]{}]/g, '').split(',').map((x) => x.split(':').pop().split('=')[0].trim()).filter(Boolean);
      const hook = /^(?:[\w$]+\.)?use([A-Z]\w*)\s*\(/.exec(m[2]);
      if (hook) {
        names.forEach((n, i) => { scope[n] = i === 1 && /^(State|Reducer)$/.test(hook[1]) ? own(() => undefined) : STATE; });
        continue;
      }
      try {
        const v = jsEval(m[2], scope);
        if (m[1][0] === '[') names.forEach((n, i) => { scope[n] = v?.[i]; });
        else if (m[1][0] === '{') names.forEach((n) => { scope[n] = v?.[n]; });
        else scope[names[0]] = v;
      } catch { names.forEach((n) => { scope[n] = STATE; }); }
    }
  };

  // A quiz's questions, whatever the fields are called: the questions and their answers.
  const quizMd = (xs) => {
    if (!Array.isArray(xs) || !xs.length || !xs.every((x) => x && typeof x === 'object')) return null;
    const pick = (x, keys, ok) => keys.find((k) => k in x && ok(x[k]));
    const str = (v) => typeof v === 'string' || typeof v === 'number';
    const qk = pick(xs[0], ['question', 'q', 'prompt', 'stem', 'text', 'title'], (v) => typeof v === 'string');
    const ok = pick(xs[0], ['options', 'opts', 'choices', 'answers', 'alternatives'], (v) => Array.isArray(v) && v.every(str));
    if (!qk || !ok) return null;
    const ak = pick(xs[0], ['answer', 'a', 'correct', 'correctIndex', 'correctAnswer', 'ans', 'solution', 'answerIndex'], (v) => v != null);
    const wk = pick(xs[0], ['explanation', 'why', 'explain', 'rationale', 'feedback', 'reason', 'hint'], (v) => typeof v === 'string');
    const L = (i) => String.fromCharCode(65 + i);
    return xs.map((x, n) => {
      const opts = Array.isArray(x[ok]) ? x[ok].map(String) : [];
      const a = x[ak];
      const idx = (Array.isArray(a) ? a : [a]).map((v) => (typeof v === 'number' ? v
        : typeof v === 'string' ? (/^[A-Za-z]$/.test(v.trim()) && opts.length <= 26 ? v.trim().toUpperCase().charCodeAt(0) - 65
          : opts.findIndex((o) => o.trim().toLowerCase() === v.trim().toLowerCase())) : -1)).filter((i) => i >= 0 && i < opts.length);
      const why = wk && typeof x[wk] === 'string' ? x[wk].trim() : '';
      const ans = idx.length ? `**Answer: ${idx.map((i) => `${L(i)}. ${opts[i]}`).join('; ')}**${why ? ' — ' + why : ''}` : why;
      return [`**Q${n + 1}. ${String(x[qk]).trim()}**`, opts.map((o, i) => `- ${L(i)}. ${o}`).join('\n'), ans && '> ' + ans].filter(Boolean).join('\n\n');
    }).join('\n\n');
  };

  const PICTURE = /^(Async\w*|\w*Image\w*|\w*Photo\w*|Picture|image|img)$/;
  const KEEP = new Set(['br', 'sub', 'sup', 'kbd', 'u', 'mark', 'b', 'i', 'em', 'strong', 's', 'del', 'ins', 'small', 'a',
    'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  const VOID = new Set(['br', 'hr', 'img', 'wbr', 'input', 'source']);
  const UIBLOCK = /^(box|row|column|col|stack|hstack|vstack|grid|grid-item|list|card|radio-group|checkbox-group|section|group|container|carousel|tabs|tab|panel|callout|div|p|ul|ol|blockquote|center)$/i;
  const ITEM = /^(list-item|li|radio|checkbox|option|choice|step)$/i;
  const DROP = /^(button|icon|spacer|input|textarea|select|svg|script|style|slider|switch|toggle|chart|video|audio|iframe)$/i;
  const attrOf = (attrs, k) => {
    const m = new RegExp(`(?:^|\\s)${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)')\\s*\\})`).exec(attrs || '');
    return m ? m[1] ?? m[2] ?? m[3] ?? m[4] : null;
  };
  // A picture component: the pictures when their addresses are in it, or when they were
  // found (ctx.found: what it shows → picture; ctx.imgs: the answer's pictures on the
  // page, in order), else a caption with what they show. ctx.want collects what it shows.
  const pictures = (tag, ctx) => {
    const urls = [...tag.matchAll(/https?:\/\/[^\s"'<>\]})]+/g)].map((m) => m[0]);
    if (urls.length) return '\n\n' + urls.slice(0, 8).map((u) => `![](${u})`).join('\n\n') + '\n\n';
    const words = [];
    for (const m of tag.matchAll(/\b(quer(?:y|ies)|alt|caption|title|prompt|search|label)\s*=\s*(\{[\s\S]*?\}(?=\s+[\w-]+\s*=|\s*\/?>|\s*$)|"[^"]*"|'[^']*')/g)) {
      for (const q of m[2].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) { const w = (q[1] ?? q[2]).trim(); if (w) words.push(w); }
    }
    const want = [...new Set(words)];
    ctx.want?.push(...want);
    const out = [], missing = [];
    for (const w of want.length ? want : ['']) {
      const f = w && ctx.found?.get(w);
      if (f) { out.push(`![${w.replace(/[[\]]/g, '')}](${f.src})`); continue; }
      const pool = ctx.imgs || [];
      const k = pool.findIndex((x) => x.alt && w && (x.alt.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(x.alt.toLowerCase())));
      const hit = pool.splice(k >= 0 ? k : 0, pool.length ? 1 : 0)[0];
      if (hit) out.push(`![${w.replace(/[[\]]/g, '')}](${hit.src})`);
      else if (w) missing.push(w);
    }
    if (missing.length) out.push(`*Picture${missing.length > 1 ? 's' : ''}: ${missing.join(' · ')}*`);
    return out.length ? '\n\n' + out.join('\n\n') + '\n\n' : '';
  };

  const uiToMd = (md, ctx = {}) => {
    if (!/<\/?[A-Za-z][\w.:-]*[\s/>]|\{[@#][a-z]/.test(md)) return md;
    // 1. Code and formulas aside, as placeholders.
    const kept = [];
    const keep = (s) => `\u0001${kept.push(s) - 1}\u0002`;
    const lines = md.split('\n'), noFence = [];
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].match(/^([ \t]*)(`{3,}|~{3,})/);
      if (!f) { noFence.push(lines[i]); continue; }
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^[ \\t]*${f[2][0] === '`' ? '`' : '~'}{${f[2].length},}[ \\t]*$`).test(lines[j])) j++;
      const ind = f[1].length;
      noFence.push(keep(lines.slice(i, j + 1).map((l) => l.slice(Math.min(ind, l.match(/^[ \t]*/)[0].length))).join('\n')));
      i = j;
    }
    let s = noFence.join('\n')
      .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m) => (/\n\s*\n/.test(m) ? m : keep(m)))
      .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g, (m) => (/<[A-Za-z/]/.test(m) ? m : keep(m)))
      .replace(/\$(?![\s$])[^$\n]+?\$/g, (m) => (/<[A-Za-z/]|\{[@#/:]/.test(m) ? m : keep(m)));

    // 2. Tokens: text, tags, and (when there are templates) {directives} and {expressions}.
    const TPL = /\{[@#][a-z]/.test(s);
    const toks = [];
    let text = '';
    const flush = () => { if (text) toks.push({ t: 'text', v: text }); text = ''; };
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '<') {
        const tag = scanTag(s, i);
        if (tag) { flush(); tag.own = /(^|\n)[ \t]*$/.test(s.slice(Math.max(0, i - 200), i)) || i === 0; toks.push(tag); i = tag.end; continue; }
      }
      if (c === '{' && TPL) {
        const e = skipBalanced(s, i);
        if (e > 0) {
          const inner = s.slice(i + 1, e - 1);
          if (/^[#:/@]/.test(inner)) { flush(); toks.push({ t: 'dir', v: inner.trim() }); i = e; continue; }
          if (/^\s*[\w$("'`[!-]/.test(inner) && !/\\|\n\s*\n/.test(inner)) { flush(); toks.push({ t: 'expr', v: inner }); i = e; continue; }
        }
      }
      text += c;
      i++;
    }
    flush();

    // 3. Templates: run them.
    const flat = TPL ? runTemplate(nestTemplate(toks), Object.create(GLOBALS), false) : toks;

    // 4. Tags → a tree → Markdown.
    const root = { kids: [] }, stack = [root];
    for (const t of flat) {
      const top = stack[stack.length - 1];
      if (t.t !== 'tag') { top.kids.push(t); continue; }
      if (t.close) {
        const k = stack.findLastIndex((x, i) => i && x.name.toLowerCase() === t.name.toLowerCase());
        if (k > 0) stack.length = k;
        continue;
      }
      const el = { ...t, kids: [] };
      top.kids.push(el);
      if (!t.self && !VOID.has(t.name.toLowerCase())) stack.push(el);
    }
    const plain = (n) => (n.t === 'text' ? n.v : (n.kids || []).map(plain).join(''));
    const render = (n, depth) => {
      if (n.t === 'text') return depth ? n.v.replace(/\n[ \t]+/g, '\n') : n.v;
      const kids = () => n.kids.map((k) => render(k, depth + 1)).join('');
      const N = n.name, lo = N.toLowerCase();
      if (lo === 'img' && attrOf(n.attrs, 'src')) return `![${(attrOf(n.attrs, 'alt') || '').replace(/[[\]]/g, '')}](${attrOf(n.attrs, 'src')})`;
      if (PICTURE.test(N)) return pictures(`${n.attrs} ${plain(n)}`, ctx);
      if (lo === 'writingblock') return '\n\n' + kids().trim().split('\n').map((l) => '> ' + l.trim()).join('\n') + '\n\n';
      if (DROP.test(lo)) return '';
      if (lo === 'title' || lo === 'heading') return `\n\n**${kids().trim()}**\n\n`;
      if (lo === 'badge' || lo === 'tag' || lo === 'chip') { const k = kids().trim(); return k ? ` \`${k}\` ` : ''; }
      if (ITEM.test(lo)) { const k = (attrOf(n.attrs, 'label') || kids()).trim(); return k ? `\n- ${k.replace(/\n+/g, ' ')}\n` : ''; }
      if (/^(divider|separator|hr)$/.test(lo)) return '\n\n';
      if (lo === 'link' && attrOf(n.attrs, 'href')) return `[${kids().trim()}](${attrOf(n.attrs, 'href')})`;
      if (KEEP.has(N)) return VOID.has(N) ? `<${N}>` : `<${N}${/[{}]/.test(n.attrs) ? '' : n.attrs}>${kids()}</${N}>`;
      if (UIBLOCK.test(lo)) return '\n\n' + kids() + '\n\n';
      const k = kids();
      return n.own && /\S/.test(k) && !/\n/.test(k.trim()) ? '\n\n' + k.trim() + '\n\n' : n.own ? '\n' + k + '\n' : k;
    };
    let out = root.kids.map((k) => render(k, 0)).join('');
    // 5. Code and formulas back.
    for (let n = 0; n < 3 && /\u0001\d+\u0002/.test(out); n++) out = out.replace(/\u0001(\d+)\u0002/g, (_, i) => kept[i]);
    return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  };

  // <name attr="…" attr={…}> at s[i], or null when it isn't a tag (a < in prose).
  const scanTag = (s, i) => {
    const m = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(s.slice(i, i + 80));
    if (!m) return null;
    const name = m[2];
    let j = i + m[0].length;
    if (m[1]) { const k = /^\s*>/.exec(s.slice(j, j + 40)); return k ? { t: 'tag', name, close: true, end: j + k[0].length } : null; }
    const start = j;
    let bare = false;
    for (;;) {
      const ws = /^\s*/.exec(s.slice(j, j + 400))[0];
      if (/\n[ \t]*\n/.test(ws)) return null;
      j += ws.length;
      if (j >= s.length) return null;
      if (s[j] === '>' || s.startsWith('/>', j)) {
        const self = s[j] === '/';
        // An unknown lowercase name with bare words after it is prose ("if a<b then c>d").
        const known = KEEP.has(name) || VOID.has(name) || /[A-Z]|-/.test(name) || UIBLOCK.test(name) || ITEM.test(name) || DROP.test(name) || PICTURE.test(name) ||
          /^(text|title|heading|badge|tag|chip|divider|separator|link|writingblock)$/i.test(name);
        if (bare && !(known && !KEEP.has(name))) return null;
        if (!known && !/^[a-z]{2,}$/.test(name)) return null;
        // No attributes and never closed: a word in angle brackets (Vec<T>), not a tag.
        if (!self && start === j - ws.length && !VOID.has(name) && !s.includes(`</${name}`, j)) return null;
        return { t: 'tag', name, attrs: s.slice(start, j), self, end: j + (self ? 2 : 1) };
      }
      if (!ws && j > start) return null;
      if (s[j] === '{') { const e = skipBalanced(s, j); if (e < 0) return null; j = e; continue; }
      const a = /^[^\s=>/"'{}<]+/.exec(s.slice(j, j + 100));
      if (!a) return null;
      j += a[0].length;
      const eq = /^\s*=\s*/.exec(s.slice(j, j + 40));
      if (!eq) { bare = true; continue; }
      j += eq[0].length;
      const q = s[j];
      if (q === '"' || q === "'") { const e = s.indexOf(q, j + 1); if (e < 0) return null; j = e + 1; }
      else if (q === '{') { const e = skipBalanced(s, j); if (e < 0) return null; j = e; }
      else { const v = /^[^\s>]+?(?=\/?>|\s)/.exec(s.slice(j, j + 200)); if (!v) return null; j += v[0].length; }
    }
  };

  // Tokens → blocks: {#each}…{/each}, {#if}…{:else if}…{:else}…{/if}, others transparent.
  const nestTemplate = (toks) => {
    const root = { kids: [] }, stack = [root];
    for (const t of toks) {
      const top = stack[stack.length - 1];
      if (t.t !== 'dir') { (top.cur || top.kids).push(t); continue; }
      const m = /^([#:/@])(\w+)\s*([\s\S]*)$/.exec(t.v);
      if (!m) continue;
      const [, sig, word, rest] = m;
      if (sig === '#') {
        const b = { t: word, head: rest, kids: [], branches: word === 'if' ? [{ cond: rest, kids: [] }] : null };
        if (b.branches) b.cur = b.branches[0].kids;
        (top.cur || top.kids).push(b);
        stack.push(b);
      } else if (sig === ':' && stack.length > 1) {
        if (top.branches) {
          const cond = /^if\s+([\s\S]*)$/.exec(rest);
          top.branches.push({ cond: word === 'else' && cond ? cond[1] : word === 'else' ? null : rest, kids: [] });
          top.cur = top.branches[top.branches.length - 1].kids;
        } else { top.elseKids = []; top.cur = top.elseKids; }
      } else if (sig === '/') {
        const k = stack.findLastIndex((x, i) => i && x.t === word);
        if (k > 0) stack.length = k;
      } else (top.cur || top.kids).push({ t: '@', word, v: rest });
    }
    return root.kids;
  };
  const show = (v) => (v == null || typeof v === 'function' || typeof v === 'symbol' ? '' : Array.isArray(v) ? v.filter((x) => typeof x !== 'object').join(', ')
    : typeof v === 'object' ? '' : String(v));
  // strict: something unknown (what you'd click) drops the whole branch (throws NOPE).
  const runTemplate = (nodes, scope, strict) => {
    const out = [];
    const val = (src) => { try { return { v: jsEval(src, scope) }; } catch { if (strict) throw NOPE; return null; } };
    for (const n of nodes) {
      if (n.t === 'text') out.push(n);
      else if (n.t === 'tag') {
        if (n.close || !/=\s*\{/.test(n.attrs)) { out.push(n); continue; }
        // Attribute values the loop knows (label={opt}) become plain strings.
        let a = '', i = 0;
        const src = n.attrs;
        while (i < src.length) {
          const m = /=\s*\{/.exec(src.slice(i));
          if (!m) { a += src.slice(i); break; }
          const at = i + m.index + m[0].length - 1, e = skipBalanced(src, at);
          if (e < 0) { a += src.slice(i); break; }
          let v = null;
          try { v = jsEval(src.slice(at + 1, e - 1), scope); } catch { /* leave it */ }
          a += src.slice(i, at) + (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? `"${String(v).replace(/"/g, '&quot;')}"` : src.slice(at, e));
          i = e;
        }
        out.push({ ...n, attrs: a });
      } else if (n.t === 'expr') {
        const r = val(n.v);
        if (r) out.push({ t: 'text', v: show(r.v) });
        else if (!/[.([]/.test(n.v)) out.push({ t: 'text', v: `{${n.v}}` }); // braces in prose
      } else if (n.t === '@') {
        if (n.word === 'body' || n.word === 'const') runBody(n.word === 'const' ? 'const ' + n.v : n.v, scope);
        else if (n.word === 'html') { const r = val(n.v); if (r) out.push({ t: 'text', v: show(r.v) }); }
      } else if (n.t === 'each') {
        const m = /^([\s\S]+?)\s+as\s+([\w$]+|\[[^\]]*\]|\{[^}]*\})\s*(?:,\s*([\w$]+))?\s*(?:\([^)]*\))?\s*$/.exec(n.head);
        const r = m && val(m[1]);
        const xs = r && Array.isArray(r.v) ? r.v : r && r.v && typeof r.v === 'object' ? Object.values(r.v) : null;
        if (!xs) { if (n.elseKids) out.push(...runTemplate(n.elseKids, scope, strict)); continue; }
        const quiz = quizMd(xs);
        if (quiz) { out.push({ t: 'text', v: `\n\n${quiz}\n\n` }); continue; }
        if (!xs.length && n.elseKids) out.push(...runTemplate(n.elseKids, scope, strict));
        xs.slice(0, 200).forEach((x, i) => {
          const sc = Object.create(scope);
          if (/^[[{]/.test(m[2])) {
            const names = m[2].replace(/[[\]{}]/g, '').split(',').map((y) => y.trim()).filter(Boolean);
            names.forEach((k, j) => { sc[k] = m[2][0] === '[' ? x?.[j] : x?.[k]; });
          } else sc[m[2]] = x;
          if (m[3]) sc[m[3]] = i;
          try { out.push(...runTemplate(n.kids, sc, strict)); } catch (e) { if (strict) throw e; }
        });
      } else if (n.t === 'if') {
        let chosen = null, unknown = false;
        for (const b of n.branches) {
          if (b.cond == null) { chosen = b; break; }
          let c;
          try { c = jsEval(b.cond, scope); } catch { unknown = true; break; }
          if (c) { chosen = b; break; }
        }
        if (!unknown) { if (chosen) out.push(...runTemplate(chosen.kids, scope, strict)); continue; }
        if (strict) throw NOPE;
        // Shown only after a click: if it is a plain "show more" (no else), show it when
        // it doesn't depend on what was clicked; otherwise leave it out.
        if (n.branches.length === 1) { try { out.push(...runTemplate(n.branches[0].kids, scope, true)); } catch { /* depends on clicks */ } }
      } else if (n.kids) out.push(...runTemplate(n.kids, scope, strict)); // {#key} and others
    }
    return out;
  };

  // Sources an answer cites, as small links after the sentence.
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const escA = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cite = (items) => {
    const seen = new Set(), out = [];
    for (const it of items) {
      const u = it?.url;
      if (!/^https?:/.test(u || '') || seen.has(u)) continue;
      seen.add(u);
      out.push(`<a href="${escA(u)}">${escA(String(it.attribution || it.source || host(u) || 'source').slice(0, 40))}</a>`);
    }
    return out.length ? `<sup>${out.slice(0, 4).join(' ')}</sup>` : '';
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
      // ChatGPT marks citations, entities and image results in the text with private-use
      // characters (citeturn0search3); what they stand for is in the
      // message's content_references. Citations become small links to their sources,
      // image results the pictures, entities their name; anything else goes.
      const refMd = (r) => {
        const imgs = (r.images || []).map((x) => x?.image_result || x).filter(Boolean);
        if (imgs.length) {
          const list = imgs.slice(0, 8).map((x) => ({ src: x.thumbnail_url || x.content_url || x.image_url || x.url, alt: x.title || '' })).filter((x) => /^https?:/.test(x.src || ''));
          if (list.length) return '\n\n' + list.map((x) => `![${x.alt.replace(/[[\]\n]/g, ' ')}](${x.src})`).join('\n\n') + '\n\n';
        }
        if (r.type === 'entity' || r.name) { if (typeof r.name === 'string' && r.name) return r.name; }
        const items = [...(r.items || []), ...(r.items || []).flatMap((x) => x?.supporting_websites || []), ...(r.sources || []), ...(r.url ? [r] : [])];
        if (items.length) return cite(items);
        if (/footnote|hidden|attribution/.test(r.type || '')) return '';
        return typeof r.alt === 'string' && !/[-]/.test(r.alt) && r.alt.length < 300 ? r.alt : '';
      };
      const unmark = (s, m) => {
        for (const r of m?.metadata?.content_references || []) {
          if (!r?.matched_text || !s.includes(r.matched_text)) continue;
          let md = '';
          try { md = refMd(r); } catch { /* an unfamiliar kind: drop the marker */ }
          s = s.split(r.matched_text).join(md);
        }
        return s
          .replace(/entity(\[[\s\S]*?\])/g, (_, a) => { try { const v = JSON.parse(a); return typeof v[1] === 'string' ? v[1] : ''; } catch { return ''; } })
          .replace(/[ \t]*[^]*/g, '')
          .replace(/[-]/g, '')
          .replace(/【[^【】\n]{0,80}†[^【】\n]{0,80}】/g, '') // the older form: 【4†source】
          .replace(/\b(?:cite|filecite|navlist|image_group)(?:turn\d+[a-z]+\d+)+/g, ''); // markers whose characters were lost
      };
      const textOf = (m) => unmark(m?.content?.content_type === 'text' || m?.content?.content_type === 'multimodal_text'
        ? (m.content.parts || []).filter((p) => typeof p === 'string').join('\n\n') : '', m).trim();
      // Pictures ChatGPT looked up while drawing an answer are only on the page: the
      // answer's own pictures, in order, for its picture components to use.
      const pageImages = (id) => {
        let el = null;
        try { el = id && document.querySelector(`[data-message-id="${CSS.escape(id)}"]`); } catch { /* no such message */ }
        if (!el) return [];
        const seen = new Set();
        return [...el.querySelectorAll('img')].filter((img) => {
          const src = img.currentSrc || img.getAttribute('src') || '';
          const r = img.getBoundingClientRect();
          if (!/^(https?:|blob:|data:image\/)/.test(src) || seen.has(src) || img.closest('[class*="avatar"], [class*="favicon"]')) return false;
          if (Math.max(img.naturalWidth, r.width) < 72 || Math.max(img.naturalHeight, r.height) < 48) return false;
          seen.add(src);
          return true;
        }).map((img) => ({ src: new URL(img.currentSrc || img.getAttribute('src'), location.href).href, alt: (img.alt || '').trim() }));
      };
      // Finding them: (1) on the page, after scrolling each answer into view (ChatGPT draws
      // and loads its pictures as they come on screen), then put back where it was;
      // (2) for any still missing, ChatGPT's own picture search, the same request the
      // page made for them (read from the browser's list of what the page loaded), with
      // the other queries put in. Pictures from chatgpt.com itself come along as data.
      const findPictures = async (looks, api) => {
        if (!looks.length) return;
        const until = Date.now() + 9000;
        const wait = async (ok, ms) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 150)); };
        const scrollers = new Map();
        for (const l of looks) {
          l.imgs = pageImages(l.id);
          if (l.imgs.length >= l.want.length || Date.now() > until) continue;
          let el = null;
          try { el = document.querySelector(`[data-message-id="${CSS.escape(l.id)}"]`); } catch { /* none */ }
          if (!el) continue;
          for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 10 && !scrollers.has(p)) scrollers.set(p, p.scrollTop);
          el.scrollIntoView({ block: 'center' });
          await wait(() => pageImages(l.id).length >= l.want.length, 1600);
          l.imgs = pageImages(l.id);
        }
        for (const [p, top] of scrollers) p.scrollTop = top;
        const missing = looks.flatMap((l) => l.want.slice(l.imgs.length));
        const all = looks.flatMap((l) => l.want);
        const search = missing.length ? searchLike(all) : null;
        const found = new Map();
        if (search) {
          await Promise.all([...new Set(missing)].slice(0, 16).map(async (q) => {
            try {
              const r = await Promise.race([api(search(q)), new Promise((_, no) => setTimeout(no, 5000))]);
              if (!r.ok) return;
              const hit = imagesIn(await r.text())[0];
              if (hit) found.set(q, hit);
            } catch { /* not found */ }
          }));
        }
        // Pictures served by chatgpt.com need your sign-in: fetched here, passed on as data.
        const local = (x) => { try { return new URL(x.src).origin === location.origin; } catch { return false; } };
        const inline = async (x) => {
          if (!local(x)) return;
          try {
            const b = await Promise.race([fetch(x.src, { credentials: 'include' }).then((r) => r.blob()), new Promise((_, no) => setTimeout(no, 5000))]);
            if (b.type.startsWith('image/') && b.size < 6e6) x.src = await blobData(b);
          } catch { /* the address will do */ }
        };
        await Promise.all([...found.values(), ...looks.flatMap((l) => l.imgs)].slice(0, 32).map(inline));
        for (const l of looks) { l.found = new Map(l.want.filter((q) => found.has(q)).map((q) => [q, found.get(q)])); }
      };
      // The picture search the page made: a request to chatgpt.com with one of these
      // queries in its address. A function from a query to the same request for it.
      const searchLike = (queries) => {
        for (const e of performance.getEntriesByType('resource')) {
          if (!/fetch|xmlhttprequest/.test(e.initiatorType)) continue;
          let u;
          try { u = new URL(e.name); } catch { continue; }
          if (u.origin !== location.origin) continue;
          for (const q of queries) {
            for (const plus of [false, true]) {
              const enc = (x) => (plus ? encodeURIComponent(x).replace(/%20/g, '+') : encodeURIComponent(x));
              const k = e.name.indexOf(enc(q));
              if (k >= 0 && enc(q).length > 2) return (x) => e.name.slice(0, k) + enc(x) + e.name.slice(k + enc(q).length);
            }
          }
        }
        return null;
      };
      // Pictures in a search's answer (JSON, or a stream of JSON lines), in order.
      const imagesIn = (text) => {
        const docs = [];
        try { docs.push(JSON.parse(text)); } catch {
          for (const line of text.split('\n')) { try { docs.push(JSON.parse(line.replace(/^data:\s*/, ''))); } catch { /* not JSON */ } }
        }
        const out = [];
        const IMG = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
        const walk = (v, d) => {
          if (d > 8 || out.length >= 8 || !v || typeof v !== 'object') return;
          if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
          const src = [v.thumbnail_url, v.content_url, v.image_url, v.thumbnail, v.src, IMG.test(v.url || '') ? v.url : null]
            .find((x) => typeof x === 'string' && /^(https?:|\/)/.test(x));
          if (src) out.push({ src: new URL(src, location.href).href, alt: String(v.title || v.alt || '').trim() });
          else Object.values(v).forEach((x) => walk(x, d + 1));
        };
        docs.forEach((x) => walk(x, 0));
        return out;
      };
      const imagesOf = (m) => [
        ...(m?.content?.parts || []).filter((p) => p?.content_type === 'image_asset_pointer' && p.asset_pointer).map((p) => p.asset_pointer),
        ...(m?.metadata?.aggregate_result?.messages || []).filter((x) => x?.image_url).map((x) => x.image_url), // charts from code
      ];
      const turns = [], docs = [], pending = []; // pending: [turn, 'images'|'answers', pointer]
      const looks = []; // answers with pictures to find: { list, at, raw, id, want }
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
          const raw = textOf(m);
          // Pictures to look for: what the answer's picture components show (a dry run
          // collects them, templates included); they're found after this loop.
          const want = [];
          if (/<\w*(Image|Photo|Picture)|<img\b/i.test(raw)) uiToMd(raw, { want });
          if (want.length) { const a = turns[turn()].answers; a.push(''); looks.push({ list: a, at: a.length - 1, raw, id: m.id, want: [...new Set(want)] }); }
          else { const t = uiToMd(raw); if (t) turns[turn()].answers.push(t); }
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
      await findPictures(looks, api);
      for (const l of looks) l.list[l.at] = uiToMd(l.raw, { imgs: l.imgs, found: l.found });
      for (const t of turns) t.answers = t.answers.filter(Boolean);
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
      // With web search, one paragraph arrives as several text pieces, each with the
      // sources it cites: put them back together, the sources as links after each.
      const textOf = (m) => {
        if (!Array.isArray(m.content) || !m.content.length) return (m.text || '').trim();
        let out = '', joined = false;
        for (const c of m.content) {
          if (c?.type !== 'text' || !c.text) { if (c?.type) joined = false; continue; }
          const src = (c.citations || []).map((x) => ({ url: x?.url || x?.details?.url || x?.source?.url || x?.metadata?.url, source: x?.details?.source || x?.source?.name }));
          const links = cite(src);
          out += (out && !joined ? '\n\n' : '') + c.text.replace(/\s*$/, (ws) => links + ws);
          joined = true;
        }
        return out.replace(/<\/?(?:antml:)?cite\b[^>]*>/g, '').trim();
      };
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
        // Citation chips and footnote markers: a small link to the source, or nothing.
        b.querySelectorAll('source-footnote, source-inline-chip, sources-carousel-inline, sources-carousel, [data-testid*="citation"], .citation-pill')
          .forEach((el) => {
            if (!b.contains(el)) return;
            const a = el.querySelector('a[href^="http"]') || el.closest('a[href^="http"]');
            if (!a || el.matches('sources-carousel-inline, sources-carousel')) { el.remove(); return; }
            const sup = document.createElement('sup'), link = document.createElement('a');
            link.href = a.href;
            link.textContent = (a.textContent || '').trim().replace(/\s*\+\d+$/, '').slice(0, 40) || host(a.href);
            sup.append(link);
            el.replaceWith(sup);
          });
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
      const { head: h, rest } = promptParts(t.prompt);
      const head = h || `${chat.name}’s answer`;
      const quote = rest.trim() ? `<blockquote>${rest.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</blockquote>` : '';
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
