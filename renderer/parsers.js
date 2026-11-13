// Document parsers. Every format is normalised into one simple model:
//   { title, blocks: [{ type, html?, text, ... }] }
// type: h1..h6 | p | li | quote | code | table | img | hr | diagram | math
// The reader never shows the source app's layout — only these clean blocks.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { Marked } from '../node_modules/marked/lib/marked.esm.js';
import katex from '../node_modules/katex/dist/katex.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

const scriptCache = {};
function loadScript(rel) {
  const src = new URL(rel, import.meta.url).href;
  return (scriptCache[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + rel));
    document.head.append(s);
  }));
}

export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// opts.resolveImage(src) → URL for a relative image reference, or null.
export async function parseDocument({ name, data }, onProgress = () => {}, opts = {}) {
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let doc;
  if (ext === 'pdf') doc = await parsePDF(bytes, onProgress);
  else if (ext === 'docx') doc = await parseDOCX(bytes);
  else if (ext === 'epub') doc = await parseEPUB(bytes, onProgress);
  else {
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    if (['md', 'markdown', 'mdx', 'mkd'].includes(ext)) doc = parseMarkdown(text, opts);
    else if (['html', 'htm', 'xhtml'].includes(ext)) doc = parseHTML(text, opts);
    else doc = parseText(text);
  }
  doc.blocks = doc.blocks.filter((b) => ['hr', 'img', 'code', 'diagram', 'math'].includes(b.type) || (b.text || '').trim());
  if (!doc.title) doc.title = doc.blocks.find((b) => b.type === 'h1')?.text || name.replace(/\.[^.]+$/, '');
  return doc;
}

// ---------- Math ----------
// Formulas reach us as TeX (chat Markdown) or as whatever a page drew them with: KaTeX
// (ChatGPT, Claude, Gemini, many blogs), Gemini's data-math, MathJax 2 and 3, Wikipedia,
// plain MathML (EPUB). All are first turned into <gr-math data-tex|data-mml data-display>,
// then drawn by KaTeX in the reader's own colours (MathML without TeX is kept as MathML,
// which Chromium draws itself).

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const TEX_ANN = 'annotation[encoding="application/x-tex"], annotation[encoding="TeX"], annotation[encoding="text/x-tex"], annotation[encoding="application/x-latex"]';
const MML_OK = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'msub', 'msup', 'msubsup', 'mfrac',
  'msqrt', 'mroot', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose',
  'mfenced', 'merror', 'mmultiscripts', 'mprescripts', 'none', 'semantics', 'mlabeledtr']);
const MML_ATTRS = ['display', 'mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder',
  'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'linethickness', 'scriptlevel', 'displaystyle', 'notation',
  'width', 'height', 'depth', 'open', 'close', 'separators', 'largeop', 'movablelimits', 'symmetric', 'minsize', 'maxsize'];

const isDisplayMath = (el) => el.localName?.toLowerCase() === 'gr-math' && el.getAttribute('data-display') === '1';

function normalizeMath(root) {
  const doc = root.ownerDocument || document;
  const texOf = (el) => (el.querySelector(TEX_ANN)?.textContent || '').trim();
  const swap = (el, { tex = '', mml = '', display = false, text = '' }) => {
    tex = tex.trim().replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, '$1'); // Wikipedia wraps every formula in this
    if (!tex && !mml) return;
    const g = doc.createElement('gr-math');
    if (tex) g.setAttribute('data-tex', tex); else g.setAttribute('data-mml', mml);
    if (display) g.setAttribute('data-display', '1');
    g.textContent = tex || norm(text);
    el.replaceWith(g);
  };
  const each = (sel, fn) => { for (const el of [...root.querySelectorAll(sel)]) if (root.contains(el) && !el.closest('gr-math')) fn(el); };

  // TeX kept on the element: Gemini (data-math), and pages the browser extension prepared.
  each('[data-math]', (el) => swap(el, {
    tex: el.getAttribute('data-math'),
    display: el.hasAttribute('data-display') ? el.getAttribute('data-display') === '1'
      : /\bmath-(block|display)\b/.test(el.className || '') || !!el.querySelector('.katex-display, math[display="block"]'),
  }));
  // MathJax 2 keeps TeX in a script after the drawing (and a preview before it).
  each('script[type^="math/tex"]', (el) => {
    for (let p = el.previousElementSibling; p && /^(MathJax|mjx)/.test(p.className || p.id || ''); p = el.previousElementSibling) p.remove();
    swap(el, { tex: el.textContent, display: /mode\s*=\s*display/.test(el.type) });
  });
  // KaTeX: the TeX is in the MathML annotation.
  each('.katex-display, .katex', (el) => {
    const m = el.querySelector('math');
    swap(el, { tex: texOf(el), mml: m?.outerHTML || '', text: m?.textContent, display: el.matches('.katex-display') || el.parentElement?.matches('.katex-display') });
  });
  // MathJax 3 (and 4, which keeps the TeX).
  each('mjx-container', (el) => {
    const m = el.querySelector('mjx-assistive-mml math, math');
    swap(el, { tex: el.getAttribute('data-latex') || (m && texOf(m)) || '', mml: m?.outerHTML || '', text: m?.textContent,
      display: /^(true|block)$/.test(el.getAttribute('display') || '') });
  });
  // Wikipedia: MathML with alttext, plus a fallback image of the same formula.
  each('.mwe-math-element', (el) => {
    const m = el.querySelector('math');
    swap(el, { tex: (m && (texOf(m) || m.getAttribute('alttext'))) || el.querySelector('img')?.getAttribute('alt') || '',
      mml: m?.outerHTML || '', text: m?.textContent, display: /mwe-math-element--display/.test(el.className) || m?.getAttribute('display') === 'block' });
  });
  each('math', (el) => swap(el, { tex: texOf(el) || el.getAttribute('alttext') || '', mml: el.outerHTML, text: el.textContent,
    display: el.getAttribute('display') === 'block' || el.getAttribute('mode') === 'display' }));
}

// MathML from a page, keeping only presentation elements and harmless attributes.
function cleanMathML(src) {
  const d = new DOMParser().parseFromString(`<!doctype html><body>${src}`, 'text/html');
  const m = d.querySelector('math');
  if (!m) return null;
  const copy = (from) => {
    const t = from.localName.toLowerCase();
    if (!MML_OK.has(t)) return null;
    const e = document.createElementNS(MATHML_NS, t);
    for (const a of MML_ATTRS) if (from.hasAttribute(a)) e.setAttribute(a, from.getAttribute(a));
    for (const n of from.childNodes) {
      if (n.nodeType === 3) e.append(n.nodeValue);
      else if (n.nodeType === 1) { const c = copy(n); if (c) e.append(c); }
    }
    return e;
  };
  return copy(m);
}

// A <gr-math> placeholder → the drawn formula (a span; KaTeX's display mode is a block inside it).
function mathNode(el) {
  const tex = el.getAttribute('data-tex') || '', display = el.getAttribute('data-display') === '1';
  const out = document.createElement('span');
  out.className = 'gr-math' + (display ? ' display' : '');
  if (tex) {
    try {
      out.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
      return out;
    } catch { /* TeX KaTeX can't draw: MathML if the page had it, else the TeX itself */ }
  }
  const mml = el.getAttribute('data-mml') && cleanMathML(el.getAttribute('data-mml'));
  if (mml) { if (display) mml.setAttribute('display', 'block'); out.append(mml); return out; }
  const code = document.createElement('code');
  code.textContent = tex || el.textContent;
  out.append(code);
  return out;
}

// ---------- HTML → blocks (used by Markdown, DOCX, EPUB, HTML) ----------

const INLINE_OK = new Set(['em', 'i', 'strong', 'b', 'code', 'a', 'sup', 'sub', 'br', 'mark', 's', 'del', 'u',
  'small', 'kbd', 'abbr', 'q', 'cite', 'dfn', 'var', 'samp', 'ins']);
const TABLE_OK = new Set([...INLINE_OK, 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
const SKIP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'head', 'title',
  'meta', 'link', 'button', 'input', 'select', 'textarea', 'form', 'nav', 'svg', 'math', 'canvas', 'video', 'audio']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'body', 'html',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'table', 'figure',
  'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'center', 'address', 'hgroup']);

function sanitize(src, allow, keepRoot = false) {
  const out = document.createElement('div');
  const copy = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) { to.append(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.localName.toLowerCase();
      if (t === 'gr-math') { to.append(mathNode(n)); continue; }
      if (SKIP.has(t)) continue;
      if (allow.has(t)) {
        const e = document.createElement(t);
        if (t === 'a') {
          const href = n.getAttribute('href') || '';
          if (/^(https?:|mailto:)/i.test(href)) e.setAttribute('href', href);
        }
        for (const at of ['colspan', 'rowspan']) if (n.hasAttribute(at)) e.setAttribute(at, n.getAttribute(at));
        copy(n, e);
        to.append(e);
      } else {
        copy(n, to);
        if (BLOCK.has(t)) to.append(' ');
      }
    }
  };
  if (keepRoot) {
    const root = document.createElement(src.localName.toLowerCase());
    copy(src, root);
    out.append(root);
  } else copy(src, out);
  return out.innerHTML.trim();
}

// Removed / added in a rendered diff: <del>/<ins> around blocks, or GitHub's rich diff
// of Markdown files, which marks whole blocks with "removed" / "added" classes.
function changeOf(el, t) {
  if (t === 'del' || t === 'ins') return t;
  const c = typeof el.className === 'string' ? el.className : '';
  if (!/\brich-diff-level-zero\b/.test(c)) return '';
  return /\bremoved\b/.test(c) ? 'del' : /\badded\b/.test(c) ? 'ins' : '';
}

function hasBlockChild(el) {
  for (const c of el.children) {
    const t = c.localName.toLowerCase();
    if (BLOCK.has(t) || t === 'img' || t === 'svg' || isDisplayMath(c)) return true;
    if ((!INLINE_OK.has(t) || t === 'a' || t === 'del' || t === 'ins') && hasBlockChild(c)) return true; // a wrapper around blocks
  }
  return false;
}

const SHOWABLE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

export function htmlToBlocks(root, opts = {}) {
  normalizeMath(root);
  const blocks = [];
  const pushImg = (img) => {
    let src = (img.getAttribute('src') || '').trim();
    if (!src) return;
    if (src.startsWith('data:')) { if (!SHOWABLE.test(src)) return; } // e.g. EMF/WMF from Word
    else if (!/^(blob:|https?:)/i.test(src)) src = opts.resolveImage?.(src) || '';
    if (src) blocks.push({ type: 'img', src, alt: norm(img.getAttribute('alt') || img.getAttribute('title') || ''), text: '' });
  };
  // Inline SVG drawings become images (as <img>, nothing inside them can run).
  const pushSvg = (svg) => {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const w = parseFloat(svg.getAttribute('width')) || vb[2] || 0;
    const h = parseFloat(svg.getAttribute('height')) || vb[3] || 0;
    if (w && h && (w < 48 || h < 32)) return; // icons
    const c = svg.cloneNode(true);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.querySelectorAll('script, foreignObject').forEach((x) => x.remove());
    const xml = new XMLSerializer().serializeToString(c);
    const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    blocks.push({ type: 'img', src, alt: norm(svg.querySelector('title')?.textContent), text: '', ink: true });
  };
  const pushDiagram = (lang, source) => blocks.push({ type: 'diagram', lang, text: source.replace(/\n+$/, '') });
  const pushPara = (el, ctx, type = 'p') => {
    const text = norm(el.textContent);
    if (text) blocks.push({ type: ctx.quote ? 'quote' : type, html: sanitize(el, INLINE_OK), text });
    if (el.querySelectorAll) {
      for (const m of el.querySelectorAll('img, svg')) {
        if (m.localName.toLowerCase() === 'svg') { if (!m.parentElement?.closest('svg')) pushSvg(m); } else pushImg(m);
      }
    }
  };

  const list = (el, ctx, ordered, depth) => {
    let n = parseInt(el.getAttribute('start') || '1', 10) || 1;
    for (const li of el.children) {
      if (li.localName.toLowerCase() !== 'li') continue;
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach((x) => x.remove());
      const box = clone.querySelector('input[type="checkbox"]');
      let marker = ordered ? `${n}.` : ['•', '◦', '▪'][depth % 3];
      if (box) { marker = box.hasAttribute('checked') ? '☑' : '☐'; box.remove(); }
      const text = norm(clone.textContent);
      // In a quote (a chat prompt), a list stays part of the quote: marker and all.
      if (text && ctx.quote) blocks.push({ type: 'quote', html: `${'&emsp;'.repeat(depth)}${marker} ${sanitize(clone, INLINE_OK)}`, text: `${marker} ${text}` });
      else if (text) blocks.push({ type: 'li', html: sanitize(clone, INLINE_OK), text, marker, depth });
      for (const img of clone.querySelectorAll('img')) pushImg(img);
      for (const sub of li.querySelectorAll(':scope > ul, :scope > ol, :scope > * > ul, :scope > * > ol')) {
        list(sub, ctx, sub.localName.toLowerCase() === 'ol', depth + 1);
      }
      n++;
    }
  };

  const block = (el, t, ctx) => {
    if (/^h[1-6]$/.test(t)) {
      const text = norm(el.textContent);
      if (text && ctx.quote) blocks.push({ type: 'quote', html: `<strong>${sanitize(el, INLINE_OK)}</strong>`, text });
      else if (text) blocks.push({ type: t, html: sanitize(el, INLINE_OK), text, ...(/^gr-/.test(el.id) ? { anchor: el.id } : {}) });
    } else if (['p', 'dt', 'dd', 'figcaption', 'summary', 'address'].includes(t)) {
      if (hasBlockChild(el) && t === 'p') walk(el, ctx); else pushPara(el, ctx);
    } else if (t === 'ul' || t === 'ol') list(el, ctx, t === 'ol', 0);
    else if (t === 'li') pushPara(el, ctx, 'li');
    else if (t === 'pre') {
      const cls = `${el.className} ${el.querySelector('code')?.className || ''}`;
      if (/\b(language-)?mermaid\b/.test(cls)) pushDiagram('mermaid', el.textContent);
      else blocks.push({ type: 'code', text: el.textContent.replace(/\n+$/, ''), lang: (cls.match(/\blanguage-([\w+-]+)/) || [])[1] || '', ...(ctx.quote ? { quote: true } : {}) });
    }
    else if (t === 'blockquote') walk(el, { ...ctx, quote: true });
    else if (t === 'hr') blocks.push({ type: 'hr', text: '' });
    else if (t === 'table') blocks.push({ type: 'table', html: sanitize(el, TABLE_OK, true), text: norm(el.textContent) });
    else if (/\bmermaid\b/.test(el.className || '')) pushDiagram('mermaid', el.textContent);
    else if (hasBlockChild(el)) walk(el, ctx);
    else pushPara(el, ctx);
  };

  let buf = null;
  const flush = (ctx) => { if (buf) { const b = buf; buf = null; pushPara(b, ctx); } };
  const walk = (node, ctx) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        if (n.nodeValue.trim() || buf) (buf ??= document.createElement('div')).append(n.nodeValue);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const t = n.localName.toLowerCase();
      if (t === 'svg') { flush(ctx); pushSvg(n); continue; }
      if (isDisplayMath(n)) {
        flush(ctx);
        blocks.push({ type: 'math', html: mathNode(n).outerHTML, text: norm(n.textContent) });
        continue;
      }
      if (SKIP.has(t)) continue;
      if (t === 'img') { flush(ctx); pushImg(n); continue; }
      // Wrappers that hold blocks count as blocks too: custom elements (GitHub puts each
      // table in <markdown-accessiblity-table>), <del>/<ins> around whole paragraphs, and
      // any unknown element (a stray <thing> left open holds everything after it; read
      // as inline, the rest of the document would become one paragraph).
      const wraps = (!INLINE_OK.has(t) || t === 'del' || t === 'ins' || t === 'a') && hasBlockChild(n);
      if (!BLOCK.has(t) && !wraps) { (buf ??= document.createElement('div')).append(n.cloneNode(true)); continue; }
      flush(ctx);
      const from = blocks.length;
      block(n, t, ctx);
      const ch = changeOf(n, t);
      if (ch) for (let k = from; k < blocks.length; k++) blocks[k].change ??= ch;
    }
    flush(ctx);
  };
  walk(root, {});
  return blocks;
}

function parseHTML(text, opts) {
  const d = new DOMParser().parseFromString(text, 'text/html');
  const root = d.querySelector('article, main, [role="main"]') || d.body;
  return { title: norm(d.title), blocks: htmlToBlocks(root, opts) };
}

// ---------- Markdown ----------

// Formulas in chat Markdown: $$…$$ and \[…\] (display when on their own lines), \(…\),
// and $…$ only when it looks like maths, so prices ("$5 and $10") and shell
// variables ("$HOME/$USER") stay text. Each becomes a <gr-math> placeholder.
const mathTag = (tex, display) => `<gr-math${display ? ' data-display="1"' : ''} data-tex="${esc(tex.trim())}">${esc(tex.trim())}</gr-math>`;
const looksLikeMath = (t) => !/`|[.!?]\s+[A-Z]/.test(t) &&
  /^\s*[A-Za-z]\s*$|\\[A-Za-z{}|,;!]|[\^_={}]|[A-Za-z0-9)]\s*[-+*/<>]\s*[A-Za-z0-9(]|[A-Za-z]\(/.test(t);
const md = new Marked({
  gfm: true, async: false,
  extensions: [{
    name: 'grMathBlock', level: 'block',
    start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
    tokenizer(src) {
      const m = /^ {0,3}(\$\$|\\\[)[ \t]*\n?([\s\S]+?)\n?[ \t]*(\$\$|\\\])[ \t]*(?:\n+|$)/.exec(src);
      if (m && (m[1] === '$$') === (m[3] === '$$') && m[2].trim()) return { type: 'grMathBlock', raw: m[0], tex: m[2] };
    },
    renderer: (t) => mathTag(t.tex, true) + '\n',
  }, {
    name: 'grMath', level: 'inline',
    start: (src) => { const i = src.search(/\\?\$|\\[([]/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      let m;
      if ((m = /^\$\$(?!\$)([\s\S]+?)\$\$/.exec(src))) return { type: 'grMath', raw: m[0], tex: m[1], display: false };
      if ((m = /^\\\(([\s\S]+?)\\\)/.exec(src))) return { type: 'grMath', raw: m[0], tex: m[1], display: false };
      if ((m = /^\\\[([\s\S]+?)\\\]/.exec(src))) return { type: 'grMath', raw: m[0], tex: m[1], display: true };
      if ((m = /^\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\d$])/.exec(src)) && looksLikeMath(m[1])) {
        return { type: 'grMath', raw: m[0], tex: m[1], display: false };
      }
    },
    renderer: (t) => mathTag(t.tex, t.display),
  }],
});

function parseMarkdown(text, opts) {
  const src = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = md.parse(src);
  const d = new DOMParser().parseFromString(html, 'text/html');
  return { title: '', blocks: htmlToBlocks(d.body, opts) };
}

// ---------- DOCX ----------

async function parseDOCX(bytes) {
  await loadScript('../node_modules/mammoth/mammoth.browser.min.js');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const r = await window.mammoth.convertToHtml({ arrayBuffer: ab });
  const d = new DOMParser().parseFromString(r.value, 'text/html');
  return { title: '', blocks: htmlToBlocks(d.body) };
}

// ---------- EPUB ----------

async function parseEPUB(bytes, onProgress) {
  await loadScript('../node_modules/jszip/dist/jszip.min.js');
  const zip = await window.JSZip.loadAsync(bytes);
  const read = (p) => zip.file(p)?.async('string');
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const resolve = (dir, href) => decodeURIComponent(new URL(href.split('#')[0], 'http://x/' + dir).pathname.slice(1));
  const dirOf = (p) => p.replace(/[^/]*$/, '');

  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('Not a valid EPUB (no container.xml)');
  const opfPath = xml(container).querySelector('rootfile')?.getAttribute('full-path');
  const opf = xml(await read(opfPath));
  const title = norm(opf.getElementsByTagNameNS('*', 'title')[0]?.textContent);
  const manifest = {};
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '' };
  }
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const mimeOf = (p) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[p.split('.').pop().toLowerCase()] || 'image/png');

  const blocks = [];
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    if (!/html|xml/.test(item.type)) continue;
    const p = resolve(dirOf(opfPath), item.href);
    const src = await read(p);
    if (!src) continue;
    let d = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (d.querySelector('parsererror')) d = new DOMParser().parseFromString(src, 'text/html');
    for (const img of [...d.querySelectorAll('img, image')]) {
      const isSvg = img.localName === 'image';
      const ref = isSvg ? (img.getAttribute('xlink:href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || img.getAttribute('href')) : img.getAttribute('src');
      if (!ref) continue;
      const ip = resolve(dirOf(p), ref);
      const f = zip.file(ip);
      if (!f) continue;
      const uri = `data:${mimeOf(ip)};base64,${await f.async('base64')}`;
      if (isSvg) {
        const h = d.createElementNS('http://www.w3.org/1999/xhtml', 'img');
        h.setAttribute('src', uri);
        (img.closest('svg') || img).replaceWith(h);
      } else img.setAttribute('src', uri);
    }
    const body = d.body || d.getElementsByTagName('body')[0];
    if (!body) continue;
    const chapter = htmlToBlocks(body);
    if (chapter.length) chapter[0].chapterStart = true;
    blocks.push(...chapter);
    onProgress((i + 1) / spine.length);
  }
  return { title, blocks };
}

// ---------- Plain text ----------

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (!out) out = l;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(l)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out;
}

function parseText(text) {
  const blocks = [];
  const paras = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split(/\n[ \t]*\n+/);
  const bullet = /^\s*([•*\-–]|\d{1,3}[.)])\s+/;
  for (const para of paras) {
    const lines = para.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^ {4}/.test(l))) {
      blocks.push({ type: 'code', text: lines.map((l) => l.slice(4)).join('\n') });
      continue;
    }
    if (lines.length === 2 && /^(=+|-+)\s*$/.test(lines[1])) {
      blocks.push({ type: lines[1][0] === '=' ? 'h1' : 'h2', html: esc(lines[0].trim()), text: lines[0].trim() });
      continue;
    }
    if (lines.length > 1 && lines.every((l) => bullet.test(l))) {
      for (const l of lines) {
        const m = l.match(bullet);
        const t = l.slice(m[0].length).trim();
        blocks.push({ type: 'li', html: esc(t), text: t, marker: /\d/.test(m[1]) ? m[1].replace(')', '.') : '•', depth: 0 });
      }
      continue;
    }
    const one = lines.length === 1 ? lines[0].trim() : '';
    if (one && one.length < 80 && !/[.,;:!?"”’)]$/.test(one) &&
        (/^(chapter|part|book|section|prologue|epilogue|appendix)\b/i.test(one) || (one === one.toUpperCase() && /[A-Z]{3}/.test(one)))) {
      blocks.push({ type: 'h2', html: esc(one), text: one });
      continue;
    }
    const wrapped = lines.length > 1 && median(lines.map((l) => l.trim().length)) >= 40;
    const t = wrapped ? joinLines(lines) : lines.map((l) => l.trim()).join('\n');
    blocks.push({ type: 'p', html: wrapped ? esc(t) : lines.map((l) => esc(l.trim())).join('<br>'), text: norm(t) });
  }
  return { title: '', blocks };
}

// ---------- PDF ----------
// PDFs have no paragraphs, only positioned glyph runs. We rebuild lines, drop
// running headers/footers and page numbers, rejoin hyphenated words, and infer
// paragraphs and headings from spacing, indentation and font size.
// Figures (photos, charts, vector diagrams) are found by rendering the page,
// masking out the text, and grouping the remaining "ink" into regions, which
// are cropped out as images and placed back into the reading flow.

const { OPS } = pdfjsLib;
const PAINT_IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
  OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup]);
const PAINT_PATH = new Set([OPS.fill, OPS.stroke, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.shadingFill, OPS.constructPath]);
const FIG_SCALE = 2;

export function pageTextLines(tc, p, H) {
  const lines = [];
  let cur = null;
  const end = () => { if (cur) { cur.size = cur.sizeSum / Math.max(1, cur.len); lines.push(cur); cur = null; } };
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const [a, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > Math.abs(a) * 0.5 && a !== 0) continue; // rotated text (watermarks, margins)
    const size = Math.hypot(c, d) || it.height || 10;
    const s = it.str;
    if (!s.trim()) {
      if (cur) cur.space = true;
      if (it.hasEOL) end();
      continue;
    }
    const sameLine = cur && Math.abs(y - cur.y) < Math.max(size, cur.size0) * 0.6 &&
      x >= cur.right - size * 0.6 && x - cur.right < size * 4;
    if (sameLine) {
      const gap = x - cur.right;
      const sep = (cur.space || gap > size * 0.15) && !/\s$/.test(cur.text) && !/^\s/.test(s) ? ' ' : '';
      cur.text += sep + s;
      // A wide gap inside a line separates table cells (or columns of an equation).
      const cell = cur.cells[cur.cells.length - 1];
      if (gap > size * 1.5) cur.cells.push({ text: s, x, right: x + it.width });
      else { cell.text += sep + s; cell.right = Math.max(cell.right, x + it.width); }
      cur.right = Math.max(cur.right, x + it.width);
    } else {
      end();
      cur = { text: s, x, y, right: x + it.width, page: p, H, size0: size, sizeSum: 0, len: 0, cells: [{ text: s, x, right: x + it.width }] };
    }
    cur.sizeSum += size * s.length;
    cur.len += s.length;
    cur.space = false;
    if (it.hasEOL) end();
  }
  end();
  return lines;
}

// Tables: rows of short cells that share a baseline, stacked closely, whose cells
// line up in columns. Rebuilt as real tables instead of one paragraph per cell.
// Two-column prose has long "cells", so it isn't mistaken for a table.
export function findTables(lines) {
  const rows = [];
  for (const l of lines) {
    if (l.fig) continue;
    const r = rows.find((r) => Math.abs(r.y - l.y) < Math.max(l.size, r.size) * 0.5);
    if (r) { r.lines.push(l); r.size = Math.max(r.size, l.size); } else rows.push({ y: l.y, size: l.size, lines: [l] });
  }
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) {
    r.cells = r.lines.flatMap((l) => l.cells || [{ text: l.text, x: l.x, right: l.right }])
      .map((c) => ({ ...c, text: norm(c.text) })).filter((c) => c.text).sort((a, b) => a.x - b.x);
  }
  const short = (r) => r.cells.every((c) => c.text.length <= 60);
  const tabular = (r) => r.cells.length >= 2 && short(r);

  const tables = [];
  for (let i = 0; i < rows.length;) {
    if (!tabular(rows[i])) { i++; continue; }
    const run = [rows[i]];
    let j = i + 1;
    for (; j < rows.length; j++) {
      const prev = run[run.length - 1], r = rows[j];
      if (prev.y - r.y > Math.max(prev.size, r.size) * 3.2) break;
      if (tabular(r)) { run.push(r); continue; }
      // A wrapped cell: one short line in the same type, set close under the row above
      // and inside one of its columns. A caption spans several columns, so it ends the table.
      const next = rows[j + 1];
      const c = r.cells[0];
      const within = c && prev.cells.filter((p) => c.x < p.right && c.right > p.x).length === 1;
      if (r.cells.length === 1 && short(r) && within && Math.abs(r.size - prev.size) < prev.size * 0.15 &&
          prev.y - r.y < prev.size * 1.7 && next && tabular(next) && r.y - next.y < next.size * 3.2) { r.cont = true; run.push(r); continue; }
      break;
    }
    i = j;
    const t = buildTable(run);
    if (t) tables.push(t);
  }
  return tables;
}

function buildTable(run) {
  const real = run.filter((r) => !r.cont);
  if (real.length < 3) return null;
  const cells = real.flatMap((r) => r.cells);
  const lens = cells.map((c) => c.text.length).sort((a, b) => a - b);
  if (lens[lens.length >> 1] > 30) return null; // prose columns, not a table
  // Columns: merge the horizontal extents of body cells (the header row may span).
  const colsFrom = (rs) => {
    const iv = rs.flatMap((r) => r.cells).map((c) => [c.x, c.right]).sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of iv) {
      const last = cols[cols.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else cols.push([a, b]);
    }
    return cols;
  };
  let cols = colsFrom(real.slice(1));
  if (cols.length < 2) cols = colsFrom(real);
  if (cols.length < 2 || cols.length > 14) return null;
  const colOf = (c) => {
    const mid = (c.x + c.right) / 2;
    let best = 0, bd = Infinity;
    cols.forEach(([a, b], k) => { const d = mid < a ? a - mid : mid > b ? mid - b : 0; if (d < bd) { bd = d; best = k; } });
    return best;
  };
  const grid = [];
  for (const r of run) {
    if (r.cont && grid.length) { // wrapped text continues the cell above
      for (const c of r.cells) { const row = grid[grid.length - 1], k = colOf(c); row[k] = row[k] ? row[k] + ' ' + c.text : c.text; }
      continue;
    }
    const row = new Array(cols.length).fill('');
    for (const c of r.cells) { const k = colOf(c); row[k] = row[k] ? row[k] + ' ' + c.text : c.text; }
    grid.push(row);
  }
  // Most rows should fill most columns, or this is just aligned text.
  const filled = grid.filter((row) => row.filter(Boolean).length >= Math.min(cols.length, 2)).length;
  if (filled < grid.length * 0.7) return null;
  const lines = new Set(run.flatMap((r) => r.lines));
  const all = [...lines];
  const top = Math.max(...all.map((l) => l.y + l.size));
  const bottom = Math.min(...all.map((l) => l.y - l.size * 0.4));
  const x0 = Math.min(...all.map((l) => l.x)), x1 = Math.max(...all.map((l) => l.right));
  const td = (t, tag) => `<${tag}>${esc(t)}</${tag}>`;
  const [head, ...body] = grid;
  const html = `<table><thead><tr>${head.map((t) => td(t, 'th')).join('')}</tr></thead><tbody>${
    body.map((row) => `<tr>${row.map((t) => td(t, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
  return { lines, html, text: grid.map((row) => row.join(' ')).join(' '), box: { x0, x1, top, bottom }, rows: grid.length, cols: cols.length };
}

async function findFigures(page, lines, pageNo, masks = []) {
  const vp = page.getViewport({ scale: FIG_SCALE });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  // intent 'print': the default 'display' intent paces rendering with requestAnimationFrame,
  // which never fires while the window is hidden or unfocused, so parsing would stall.
  await page.render({ canvas, viewport: vp, background: 'rgb(255,255,255)', intent: 'print' }).promise;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, W, H).data;

  // Text boxes in canvas pixels.
  const boxes = lines.map((l) => {
    const [ax, ay] = vp.convertToViewportPoint(l.x, l.y + l.size * 0.92);
    const [bx, by] = vp.convertToViewportPoint(l.right, l.y - l.size * 0.3);
    return { x0: Math.min(ax, bx) - 3, x1: Math.max(ax, bx) + 3, y0: Math.min(ay, by) - 3, y1: Math.max(ay, by) + 3, line: l };
  });

  const CELL = 10, gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const textMask = new Uint8Array(gw * gh);
  // Tables are already rebuilt as text; their rules and shading are not figures.
  const tableBoxes = masks.map((m) => {
    const [ax, ay] = vp.convertToViewportPoint(m.x0, m.top);
    const [bx, by] = vp.convertToViewportPoint(m.x1, m.bottom);
    const pad = 14 * FIG_SCALE;
    return { x0: Math.min(ax, bx) - pad * 4, x1: Math.max(ax, bx) + pad * 4, y0: Math.min(ay, by) - pad, y1: Math.max(ay, by) + pad };
  });
  for (const b of [...boxes, ...tableBoxes]) {
    for (let gy = Math.max(0, Math.floor(b.y0 / CELL)); gy <= Math.min(gh - 1, Math.floor(b.y1 / CELL)); gy++)
      for (let gx = Math.max(0, Math.floor(b.x0 / CELL)); gx <= Math.min(gw - 1, Math.floor(b.x1 / CELL)); gx++) textMask[gy * gw + gx] = 1;
  }
  const ink = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (textMask[gy * gw + gx]) continue;
      let hit = false;
      for (let y = gy * CELL; y < Math.min(H, gy * CELL + CELL) && !hit; y += 2) {
        for (let x = gx * CELL; x < Math.min(W, gx * CELL + CELL); x += 2) {
          const i = (y * W + x) * 4;
          if (765 - px[i] - px[i + 1] - px[i + 2] > 60) { hit = true; break; }
        }
      }
      if (hit) ink[gy * gw + gx] = 1;
    }
  }
  // Dilate so the separate strokes of one drawing join up, then group.
  const R = 2, dil = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    if (!ink[gy * gw + gx]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const y = gy + dy, x = gx + dx;
      if (y >= 0 && y < gh && x >= 0 && x < gw) dil[y * gw + x] = 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const regions = [];
  for (let start = 0; start < gw * gh; start++) {
    if (!dil[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, cells = 0;
    while (stack.length) {
      const k = stack.pop();
      const x = k % gw, y = (k / gw) | 0;
      if (ink[k]) { cells++; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (dil[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    if (cells) regions.push({ x0: minx * CELL, y0: miny * CELL, x1: (maxx + 1) * CELL, y1: (maxy + 1) * CELL, cells });
  }

  const figs = [];
  for (const r of regions) {
    const wPt = (r.x1 - r.x0) / FIG_SCALE, hPt = (r.y1 - r.y0) / FIG_SCALE;
    if (wPt < 40 || hPt < 24) continue;                        // rules, bullets, underlines
    if ((r.x1 - r.x0) * (r.y1 - r.y0) < W * H * 0.004) continue; // specks
    if (r.y1 < H * 0.07 || r.y0 > H * 0.93) continue;           // header/footer ornaments
    // Pull in labels that sit inside or straddle the drawing.
    const inside = boxes.filter((b) => b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0);
    const chars = inside.reduce((n, b) => n + b.line.text.length, 0);
    if (chars > 900) continue;                                 // a shaded text panel, not a figure
    for (const b of inside) { r.x0 = Math.min(r.x0, b.x0); r.x1 = Math.max(r.x1, b.x1); r.y0 = Math.min(r.y0, b.y0); r.y1 = Math.max(r.y1, b.y1); }
    const x0 = Math.max(0, Math.floor(r.x0 - 8)), y0 = Math.max(0, Math.floor(r.y0 - 8));
    const x1 = Math.min(W, Math.ceil(r.x1 + 8)), y1 = Math.min(H, Math.ceil(r.y1 + 8));
    const cw = x1 - x0, ch = y1 - y0;
    // Mostly-white crops are line art: crisp PNG, and re-inked to match dark themes.
    let white = 0, total = 0;
    for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) {
      const i = (y * W + x) * 4; total++;
      if (px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235) white++;
    }
    const lineArt = white / Math.max(1, total) > 0.6;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    const octx = out.getContext('2d');
    octx.drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
    if (lineArt) {
      // White paper → transparent, so the drawing sits directly on the glass.
      const im = octx.getImageData(0, 0, cw, ch), d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = 255 - Math.min(d[i], d[i + 1], d[i + 2]);
        if (a === 0) { d[i + 3] = 0; continue; }
        const k = 255 / a;
        d[i] = Math.round((d[i] - (255 - a)) * k); d[i + 1] = Math.round((d[i + 1] - (255 - a)) * k); d[i + 2] = Math.round((d[i + 2] - (255 - a)) * k);
        d[i + 3] = a;
      }
      octx.putImageData(im, 0, 0);
    }
    const blob = await new Promise((res) => out.toBlob(res, lineArt ? 'image/png' : 'image/jpeg', 0.88));
    figs.push({
      fig: true, page: pageNo, top: y0, src: URL.createObjectURL(blob), ink: lineArt,
      width: Math.round(cw / FIG_SCALE * 1.35), key: [x0, y0, cw, ch].map((v) => Math.round(v / 24)).join(':'),
      inside: new Set(inside.map((b) => b.line)),
    });
  }
  return { figs, vp };
}

async function parsePDF(bytes, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  let title = '';
  try { title = norm((await pdf.getMetadata()).info?.Title); } catch { /* ignore */ }
  // Metadata titles are often junk ("Microsoft Word - draft3.docx", URLs, "untitled").
  if (title.length > 120 || /^(data:|https?:|microsoft|untitled)|\.(docx?|pdf|tex|indd)$/i.test(title)) title = '';

  const pages = pdf.numPages;
  const lines = [];
  const urls = [];
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const H = page.getViewport({ scale: 1 }).height;
    let pageLines = pageTextLines(await page.getTextContent(), p, H);
    const tables = findTables(pageLines);
    if (tables.length) {
      const inTable = new Map();
      for (const t of tables) for (const l of t.lines) inTable.set(l, t);
      const out = [];
      for (const l of pageLines) {
        const t = inTable.get(l);
        if (!t) out.push(l);
        else if (!t.placed) { t.placed = true; out.push({ table: true, html: t.html, text: t.text, x: t.box.x0, y: t.box.top, right: t.box.x1, page: p, H, size: 10 }); }
      }
      pageLines = out;
    }

    // Only pages that actually draw images or vector graphics get rendered.
    const ops = await page.getOperatorList();
    let imgs = 0, paths = 0;
    for (const f of ops.fnArray) { if (PAINT_IMG.has(f)) imgs++; else if (PAINT_PATH.has(f)) paths++; }
    if (imgs || paths > 6) {
      try {
        const { figs, vp } = await findFigures(page, pageLines.filter((l) => !l.table), p, tables.map((t) => t.box));
        if (figs.length) {
          const hidden = new Set(figs.flatMap((f) => [...f.inside]));
          pageLines = pageLines.filter((l) => !hidden.has(l));
          const vy = (l) => vp.convertToViewportPoint(l.x, l.y)[1];
          for (const f of figs.sort((a, b) => a.top - b.top)) {
            urls.push(f.src);
            const at = pageLines.findIndex((l) => !l.fig && vy(l) > f.top);
            pageLines.splice(at < 0 ? pageLines.length : at, 0, f);
          }
        }
      } catch (err) {
        console.warn('figure detection failed on page', p, err);
      }
    }
    lines.push(...pageLines);
    page.cleanup();
    onProgress(p / pages * 0.95);
  }

  // Logos and ornaments that repeat on many pages are not content.
  const figCount = new Map();
  for (const l of lines) if (l.fig) figCount.set(l.key, (figCount.get(l.key) || 0) + 1);
  const isRepeated = (l) => pages >= 3 && figCount.get(l.key) >= Math.max(3, pages * 0.35);

  const text = lines.filter((l) => !l.fig && !l.table);
  if (!text.length && !lines.some((l) => l.fig)) throw new Error('No readable text or images found in this PDF.');

  // Running headers/footers: text in the top/bottom margin that repeats on many pages.
  const inMargin = (l) => l.y > l.H * 0.9 || l.y < l.H * 0.08;
  const key = (l) => l.text.trim().toLowerCase().replace(/\d+/g, '#');
  const freq = new Map();
  for (const l of text) if (inMargin(l)) freq.set(key(l), (freq.get(key(l)) || 0) + 1);
  const pageNum = /^(page\s*)?[#\divxlc]{1,6}(\s*(of|\/)\s*#+)?$/i;
  const kept = lines.filter((l) => {
    if (l.fig) { if (isRepeated(l)) { URL.revokeObjectURL(l.src); return false; } return true; }
    if (l.table) return true;
    if (!inMargin(l)) return true;
    const k = key(l);
    if (pageNum.test(k)) return false;
    return !(pages >= 3 && freq.get(k) >= Math.max(2, pages * 0.35));
  });
  const keptText = kept.filter((l) => !l.fig && !l.table);

  // Typical body size, line spacing and line width.
  const sizeVotes = new Map();
  for (const l of keptText) { const s = Math.round(l.size * 2) / 2; sizeVotes.set(s, (sizeVotes.get(s) || 0) + l.text.length); }
  const body = [...sizeVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const isBody = (l) => Math.abs(l.size - body) <= body * 0.08;
  const gaps = [];
  for (let i = 1; i < keptText.length; i++) {
    const a = keptText[i - 1], b = keptText[i];
    if (a.page === b.page && isBody(a) && isBody(b)) { const dy = a.y - b.y; if (dy > 0 && dy < body * 3) gaps.push(dy); }
  }
  const spacing = median(gaps) || body * 1.3;
  const width = median(keptText.filter((l) => isBody(l) && l.text.length > 30).map((l) => l.right - l.x)) || 400;

  const kindOf = (l) => {
    const r = l.size / body;
    const t = l.text.trim();
    if (r >= 1.6) return 'h1';
    if (r >= 1.25) return 'h2';
    if (r >= 1.1 && t.length < 120) return 'h3';
    return 'body';
  };
  const bulletRe = /^([•◦▪●‣∙·–\-*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/;
  const terminal = /[.!?:;"”’)\]]$/;

  const blocks = [];
  let cur = null, prev = null;
  const pending = [];
  const figBlock = (f) => ({ type: 'img', src: f.src, alt: '', text: '', ink: f.ink, width: f.width });
  const push = () => {
    if (!cur) return;
    const text = norm(cur.text);
    if (text) {
      const b = { type: cur.type, text, html: esc(text) };
      if (cur.type === 'li') {
        const m = text.match(bulletRe);
        b.marker = m && /\d|[a-z]/.test(m[1]) ? m[1] : '•';
        b.text = m ? text.slice(m[0].length) : text;
        b.html = esc(b.text);
        b.depth = 0;
      }
      blocks.push(b);
    }
    cur = null;
  };
  const flushFigs = () => { while (pending.length) blocks.push(figBlock(pending.shift())); };
  const join = (t) => {
    t = t.replace(/­/g, '').trim();
    if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(t)) cur.text = cur.text.slice(0, -1) + t;
    else cur.text += ' ' + t;
  };

  for (const l of kept) {
    // A figure never splits a paragraph: it is placed after the paragraph it interrupts.
    if (l.fig) { if (cur) pending.push(l); else blocks.push(figBlock(l)); continue; }
    if (l.table) { push(); flushFigs(); blocks.push({ type: 'table', html: l.html, text: l.text }); prev = null; continue; }
    const t = l.text.replace(/­/g, '').trim();
    const kind = kindOf(l);
    const type = kind === 'body' ? (bulletRe.test(t) ? 'li' : 'p') : kind;
    if (!cur || !prev) { push(); flushFigs(); cur = { type, text: t, x: l.x }; prev = l; continue; }

    const samePage = l.page === prev.page;
    const dy = prev.y - l.y;
    const flowBreak = !samePage || dy < -spacing * 0.5 || dy > spacing * 6; // new page or new column
    let fresh;
    if (kind !== 'body' || cur.type.startsWith('h')) {
      fresh = !(cur.type === type && samePage && dy > 0 && dy < l.size * 1.8);
    } else if (type === 'li') fresh = true;
    else if (flowBreak) fresh = terminal.test(cur.text) || !/^[a-z(]/.test(t) && !/-$/.test(cur.text);
    else if (dy > spacing * 1.4) fresh = true;
    else if (cur.type === 'li') fresh = l.x < cur.x - body * 0.3; // hanging-indent continuation
    else if (l.x - prev.x > body * 0.8) fresh = true; // first-line indent
    else fresh = (prev.right - prev.x) < width * 0.75 && terminal.test(cur.text);

    if (fresh) { push(); flushFigs(); cur = { type, text: t, x: l.x }; } else join(t);
    prev = l;
  }
  push();
  flushFigs();
  onProgress(1);
  return { title, blocks, urls };
}
