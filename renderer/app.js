// Glass Reader — renderer.
// One document model, five ways to read it. Position is tracked as a block
// index so switching layouts (or settings) never loses your place.

import { parseDocument, esc } from './parsers.js';

const $ = (s) => document.querySelector(s);
const api = window.reader || null;
const body = document.body;
const stage = $('#stage');

const FONTS = {
  serif: ['"Literata", Georgia, serif', 'Serif'],
  sans: ['"Inter Variable", Inter, system-ui, sans-serif', 'Sans'],
  mono: ['"JetBrains Mono", ui-monospace, monospace', 'Mono'],
};
const THEMES = {
  glass: 'Glass', studio: 'Studio', frost: 'Frost', clear: 'Clear',
  daylight: 'Daylight', paper: 'Paper', lamp: 'Lamp', dusk: 'Dusk', night: 'Night', lightsout: 'Lights out',
};
// The room each one is made for, shown when you switch (see the notes in styles.css).
const THEME_ROOM = {
  daylight: 'bright room or sunlight', paper: 'well-lit room', lamp: 'evening, lamp-lit room',
  dusk: 'dim room', night: 'dark room', lightsout: 'dark room, before sleep · dim the screen too',
};
const FULL = 160; // measure value meaning "use the full screen width"
const DEFAULTS = { mode: 'column', font: 'sans', size: 20, measure: 76, leadAdj: 0, theme: 'studio', align: 'left', para: 'space', wpm: 240, hud: false };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const S = { ...DEFAULTS, ...store.get('gr:settings', {}) };
const saveSettings = () => store.set('gr:settings', S);

const st = { doc: null, file: null, prevFile: null, inbox: false, key: null, pos: 0, html: '', chunks: [], chunk: 0, cum: [], total: 1, heads: [], playing: false };
let mode = null;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- typography: line height follows size and width ----------

function charsPerLine() {
  if (S.measure < FULL) return S.measure;
  return Math.round((innerWidth - 96) / (S.size * 0.5));
}
function autoLead() {
  const cpl = Math.min(charsPerLine(), 140);
  let lh = 1.5 + (cpl - 65) * 0.0045 - (S.size - 20) * 0.007;
  if (S.font === 'sans') lh += 0.04;
  if (S.font === 'mono') lh += 0.06;
  return clamp(lh + S.leadAdj, 1.15, 2.1);
}
const chCache = {};
function chPx() {
  const k = S.font + S.size;
  if (chCache[k]) return chCache[k];
  const probe = document.createElement('span');
  probe.className = 'doc';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
  probe.textContent = '0'.repeat(50);
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  return (chCache[k] = w || S.size * 0.55);
}

function applyVars() {
  const r = document.documentElement.style;
  r.setProperty('--font', FONTS[S.font][0]);
  r.setProperty('--size', S.size + 'px');
  r.setProperty('--m', S.measure >= FULL ? 999 : S.measure);
  r.setProperty('--lead', autoLead().toFixed(2));
  r.setProperty('--align', S.align === 'justify' ? 'justify' : 'left');
  body.dataset.theme = S.theme;
  body.classList.toggle('dark', isDark());
  body.classList.toggle('light', !isDark());
  body.classList.toggle('indent', S.para === 'indent');
  applyHud();
  updateHud();
}

// ---------- blocks & chunks ----------

// Diffs: tint added and removed lines, dim the @@ hunk markers.
function codeHTML(b) {
  if (b.lang !== 'diff') return esc(b.text);
  return b.text.split('\n').map((l) => {
    const c = l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : '';
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  }).join('\n');
}

function blockHTML(b, i) {
  const cls = b.chapterStart && i > 0 ? ['chapter'] : [];
  if (b.anchor?.startsWith('gr-turn')) cls.push('turn'); // a prompt in a Claude conversation
  if (b.anchor?.startsWith('gr-turn') && b.anchor.endsWith('-auto')) cls.push('auto'); // …or an update nobody prompted
  if (b.hasPrompt) cls.push('has-prompt'); // …whose full text follows as a quote (see tidyTurns)
  if (b.pq) cls.push('pq', 'pq-' + b.pq);
  if (b.meta) cls.push('meta');
  if (b.change) cls.push('chg-' + b.change); // removed / added, in a rendered diff
  const attrs = (extra = []) => {
    const c = [...extra, ...cls];
    return `data-b="${i}"${c.length ? ` class="${c.join(' ')}"` : ''}`;
  };
  switch (b.type) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      // "2. The Magic Number" / "Step 3:" — the number gets its own colour.
      const html = b.anchor ? b.html : b.html.replace(/^((?:\d+(?:\.\d+)*|[IVX]+|[A-Z])[.):]|(?:Step|Part|Module|Chapter|Phase|Week|Day) \d+[.:]?)\s+(?=\S)/, '<span class="hn">$1</span> ');
      return `<${b.type} ${attrs()}>${html}</${b.type}>`;
    }
    case 'quote': return `<blockquote ${attrs()}>${b.html}</blockquote>`;
    case 'li': return `<div ${attrs(['li'])} style="--depth:${b.depth || 0}"><span class="mk">${esc(b.marker || '•')}</span><div>${b.html}</div></div>`;
    case 'code': return `<pre ${attrs()}><code>${codeHTML(b)}</code></pre>`;
    case 'table': return `<div ${attrs(['tbl'])}>${b.html}</div>`;
    case 'img': return `<figure ${attrs()}>${imgHTML(b)}${caption(b)}</figure>`;
    case 'diagram': return `<figure ${attrs(['diagram'])}>${diagramHTML(b)}</figure>`;
    case 'math': return `<div ${attrs(['math'])}>${b.html}</div>`;
    case 'hr': return `<hr ${attrs()}>`;
    default: return `<p ${attrs()}>${b.html}</p>`;
  }
}

function imgHTML(b) {
  const style = b.width ? ` style="width:${b.width}px"` : '';
  return `<img${b.ink ? ' class="ink"' : ''} src="${esc(b.src)}" alt="${esc(b.alt || '')}"${style}>`;
}
function caption(b) {
  const a = b.alt || '';
  return a.length > 3 && !/\.(png|jpe?g|gif|svg|webp)$/i.test(a) ? `<figcaption>${esc(a)}</figcaption>` : '';
}
function diagramHTML(b) {
  if (b.svg) return b.svg;
  return `<pre><code>${esc(b.text)}</code></pre>${b.error ? `<figcaption>Diagram could not be drawn: ${esc(b.error)}</figcaption>` : ''}`;
}

// ---------- Mermaid diagrams (drawn in the reader's own colours) ----------

const DARK_THEMES = new Set(['glass', 'studio', 'clear', 'night', 'dusk', 'lightsout']);
const isDark = () => DARK_THEMES.has(S.theme);
let mermaidP = null;
async function renderDiagrams(doc) {
  const list = doc.blocks.filter((b) => b.type === 'diagram');
  const tone = isDark() ? 'dark' : 'light';
  if (!list.length || doc.diagramTone === tone) return false;
  mermaidP ??= import('../node_modules/mermaid/dist/mermaid.esm.min.mjs').then((m) => m.default);
  const mermaid = await mermaidP;
  const dark = tone === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
    themeVariables: dark ? {
      darkMode: true, background: 'transparent', fontSize: '15px',
      primaryColor: '#2c2e35', primaryTextColor: '#ececf0', primaryBorderColor: '#70768a',
      secondaryColor: '#33363f', tertiaryColor: '#25272d', lineColor: '#9aa1b2', textColor: '#e2e3e8',
      noteBkgColor: '#3a3628', noteTextColor: '#ece6d2', noteBorderColor: '#7d7354',
      actorBkg: '#2c2e35', actorBorder: '#70768a', actorTextColor: '#ececf0', signalColor: '#c9ccd6', signalTextColor: '#e2e3e8',
      clusterBkg: 'rgba(255,255,255,0.04)', clusterBorder: '#5b6070', edgeLabelBackground: '#24262c',
    } : {
      background: 'transparent', fontSize: '15px',
      primaryColor: '#f3f3f6', primaryTextColor: '#1b1c20', primaryBorderColor: '#8a8f9c',
      secondaryColor: '#ebecf0', tertiaryColor: '#fafafb', lineColor: '#5d6270', textColor: '#1b1c20',
      clusterBkg: 'rgba(0,0,0,0.03)', clusterBorder: '#a3a7b2', edgeLabelBackground: '#ffffff',
    },
  });
  let n = 0;
  for (const b of list) {
    try {
      const { svg } = await mermaid.render(`gr-mmd-${Date.now()}-${n++}`, b.text);
      b.svg = svg;
      b.error = null;
    } catch (err) {
      b.svg = null;
      b.error = String(err?.message || err).split('\n')[0].slice(0, 160);
    }
  }
  doc.diagramTone = tone;
  return true;
}

// Chat prompts: the quoted full prompt under each "You" heading becomes part of one
// prompt card. Copies that only repeat the prompt are dropped (Gemini's page holds each
// prompt twice: once whole, once line by line), and the "21:07 · 1,571 words" line
// under it is marked as metadata.
function tidyTurns(doc) {
  const flat = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const bs = doc.blocks;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    out.push(b);
    if (!b.anchor?.startsWith('gr-turn')) continue;
    let j = i + 1;
    const qs = [];
    while (bs[j]?.type === 'quote') qs.push(bs[j++]);
    // Drop a paragraph that is just the paragraphs after it run together, and repeats.
    for (let k = 0; k < qs.length; k++) {
      const rest = flat(qs.slice(k + 1).map((q) => q.text).join(' '));
      if (rest && flat(qs[k].text) === rest) { qs.splice(k, 1); k--; }
    }
    for (let k = 1; k < qs.length; k++) if (flat(qs[k].text) === flat(qs[k - 1].text)) qs.splice(k--, 1);
    // The heading is the prompt's first line; the card shows it once, then the rest.
    if (qs[0]?.html?.startsWith(b.html) && flat(qs[0].text).length > flat(b.text).length) {
      qs[0].html = qs[0].html.slice(b.html.length).replace(/^(\s|<br>)+/, '');
      qs[0].text = qs[0].text.trim().slice(b.text.trim().length).trim();
    }
    const all = flat(qs.map((q) => q.text).join(' '));
    const keep = all && all !== flat(b.text) ? qs : [];
    keep.forEach((q, k) => { q.pq = k === keep.length - 1 ? 'end' : 'mid'; out.push(q); });
    if (keep.length) b.hasPrompt = true;
    i = j - 1;
    const m = bs[j];
    if (m?.type === 'p' && /^<em>[^<]*<\/em>$/.test(m.html || '') && /(\bwords|\d:\d\d)$/.test(flat(m.text))) m.meta = true;
  }
  doc.blocks = out;
}

function buildDoc() {
  const doc = st.doc;
  st.html = doc.blocks.map(blockHTML).join('');
  st.chunks = makeChunks(doc.blocks);
}

const ABBR = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|cf|Fig|No|Vol|pp|approx|Inc|Ltd|Co)\.$/i;
function sentences(text) {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [text];
  const out = [];
  for (const p of parts) {
    const prev = out.length ? out[out.length - 1].trim() : '';
    if (prev && (ABBR.test(prev) || /\b[A-Z]\.$/.test(prev) || (/\d\.$/.test(prev) && /^\d/.test(p)))) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
const MAXC = 210;
function pieces(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (s.length <= MAXC * 1.6) { out.push(s); continue; }
    let cur = '';
    for (const part of s.split(/(?<=[,;:—])\s+/)) {
      if (cur && cur.length + part.length > MAXC) { out.push(cur); cur = part; } else cur = cur ? cur + ' ' + part : part;
    }
    if (cur) out.push(cur);
  }
  return out;
}
function makeChunks(blocks) {
  const out = [];
  blocks.forEach((b, i) => {
    if (b.type === 'hr') return;
    if (b.type === 'code') return out.push({ block: i, kind: 'code', html: `<pre><code>${codeHTML(b)}</code></pre>`, text: b.text, ps: true });
    if (b.type === 'table') return out.push({ block: i, kind: 'table', html: b.html, text: b.text, ps: true });
    if (b.type === 'img') return out.push({ block: i, kind: 'img', html: imgHTML(b) + caption(b), text: b.alt || '', ps: true });
    if (b.type === 'diagram') return out.push({ block: i, kind: 'diagram', html: diagramHTML(b), text: '', ps: true });
    if (b.type === 'math') return out.push({ block: i, kind: 'math', html: b.html, text: b.text, ps: true });
    if (/^h\d$/.test(b.type)) return out.push({ block: i, kind: 'h', level: +b.type[1], html: b.html, text: b.text, ps: true });
    const kind = b.type === 'li' ? 'li' : b.type === 'quote' ? 'q' : 'p';
    const mk = kind === 'li' ? `<span class="mk">${esc(b.marker || '•')}</span>` : '';
    if (b.text.length <= MAXC * 1.25) return out.push({ block: i, kind, html: mk + b.html, text: b.text, ps: true });
    let first = true;
    for (const part of splitHTML(b.html)) { out.push({ block: i, kind, html: (first ? mk : '') + part.html, text: part.text, ps: first }); first = false; }
  });
  return out;
}
// A long paragraph's HTML in reading-sized parts, cut between sentences, keeping its
// formatting: bold, links and formulas stay whole (a formula is never cut in two).
function splitHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const atoms = []; // { html, text, cut: may end a part here }
  for (const n of tpl.content.childNodes) {
    if (n.nodeType === 3) {
      const v = n.nodeValue, ps = pieces(v);
      if (!ps.length) { if (v) atoms.push({ html: ' ', text: ' ', cut: false }); continue; }
      ps.forEach((p, k) => {
        const last = k === ps.length - 1;
        const lead = k === 0 && /^\s/.test(v) ? ' ' : '', trail = !last || /\s$/.test(v) ? ' ' : '';
        atoms.push({ html: lead + esc(p) + trail, text: lead + p + trail, cut: !last || /[.!?…;:]["'”’)\]]*\s*$/.test(v) });
      });
    } else if (n.nodeType === 1) atoms.push({ html: n.outerHTML, text: n.textContent, cut: false });
  }
  // Runs that can't be cut inside (up to the next sentence or clause end), then packed.
  const runs = [];
  let run = null;
  for (const a of atoms) {
    run = run ? { html: run.html + a.html, text: run.text + a.text } : { html: a.html, text: a.text };
    if (a.cut) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  const parts = [];
  let cur = null;
  for (const r of runs) {
    const len = cur ? cur.text.trim().length : 0;
    if (cur && len > 50 && len + r.text.length > MAXC) { parts.push(cur); cur = null; }
    cur = cur ? { html: cur.html + r.html, text: cur.text + r.text } : { ...r };
  }
  if (cur) parts.push(cur);
  return parts.map((p) => ({ html: p.html.trim(), text: p.text.replace(/\s+/g, ' ').trim() })).filter((p) => p.text);
}
function chunkForBlock(p) {
  const c = st.chunks;
  let lo = 0, hi = c.length - 1, ans = c.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].block >= p) { ans = m; hi = m - 1; } else lo = m + 1; }
  return Math.max(0, ans);
}

// ---------- position, progress ----------

let saveT = 0;
function setPos(p) {
  if (!st.doc) return;
  st.pos = clamp(p | 0, 0, st.doc.blocks.length - 1);
  updateProgress();
  clearTimeout(saveT);
  saveT = setTimeout(savePos, 400);
}
function savePos() {
  if (!st.key) return;
  store.set('gr:pos:' + st.key, st.pos);
  const rec = store.get('gr:recents', []);
  const r = rec.find((x) => x.key === st.key);
  if (r) { r.pct = Math.round(st.cum[st.pos] / st.total * 100); store.set('gr:recents', rec); }
}
function fmtMins(m) {
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function updateProgress() {
  if (!st.doc) return;
  const f = st.cum[st.pos] / st.total;
  $('#progress i').style.width = (f * 100).toFixed(2) + '%';
  const mins = Math.round((st.total - st.cum[st.pos]) / 5.7 / 230);
  $('#v-stat').textContent = `${Math.round(f * 100)}% · ${fmtMins(mins)} left`;
  let h = -1;
  for (const i of st.heads) { if (i <= st.pos) h = i; else break; }
  $('#section').textContent = h >= 0 ? st.doc.blocks[h].text : st.doc.title;
}

const blockEl = (p) => stage.querySelector(`[data-b="${p}"]`);
let syncRaf = 0, lockUntil = 0;
function probeBlock(y) {
  const x = innerWidth / 2;
  for (let k = 0; k < 10; k++) {
    const el = document.elementFromPoint(x, y + k * 14)?.closest('[data-b]');
    if (el) return +el.dataset.b;
  }
  return null;
}
function scrollSync(m) {
  if (performance.now() < lockUntil || syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    const p = probeBlock(m.readY());
    if (p != null && p !== st.pos) setPos(p);
  });
}
function scrollKeys(sc, e) {
  const line = S.size * autoLead();
  const page = innerHeight * 0.82;
  const by = (top) => sc.scrollBy({ top, behavior: 'smooth' });
  switch (e.key) {
    case 'ArrowDown': case 'j': by(line * 3); return true;
    case 'ArrowUp': case 'k': by(-line * 3); return true;
    case ' ': by(e.shiftKey ? -page : page); return true;
    case 'PageDown': by(page); return true;
    case 'PageUp': by(-page); return true;
    case 'Home': sc.scrollTo({ top: 0, behavior: 'smooth' }); return true;
    case 'End': sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }); return true;
  }
  return false;
}

// ---------- karaoke & word reveal ----------

function wrapWords(el) {
  if (!el.dataset.wrapped) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (n.parentElement.closest('pre, table, .mk, .gr-math, math')) continue;
      const parts = n.nodeValue.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const p of parts) {
        if (!p) continue;
        if (/^\s+$/.test(p)) frag.append(p);
        else { const s = document.createElement('span'); s.className = 'w'; s.textContent = p; frag.append(s); }
      }
      n.replaceWith(frag);
    }
    el.dataset.wrapped = '1';
  }
  return [...el.querySelectorAll('.w')];
}
function startKaraoke(el, ms) {
  const words = wrapWords(el);
  const total = words.reduce((a, w) => a + w.textContent.length + 1, 0) || 1;
  let t = 0;
  for (const w of words) { w.style.animationDelay = Math.round(t / total * ms * 0.94) + 'ms'; t += w.textContent.length + 1; }
  el.classList.remove('reveal', 'karaoke');
  void el.offsetWidth;
  el.classList.add('karaoke');
}
const wrappable = (c) => !['code', 'table', 'img', 'diagram', 'math'].includes(c.kind);

// ---------- auto-play (Focus & Cinema step chunks; Prompter scrolls) ----------

let playRaf = 0, playLast = 0, playElapsed = 0, playDur = 0, karaokeChunk = -1;
function chunkMs(c) {
  const words = Math.max(1, (c.text || '').split(/\s+/).length);
  let ms = words / S.wpm * 60000;
  if (c.kind === 'h') ms += 500;
  if (!wrappable(c)) ms = Math.max(ms, 4500);
  return Math.max(900, ms) + (c.ps ? 380 : 140);
}
function armChunk() { playElapsed = 0; playDur = chunkMs(st.chunks[st.chunk]); karaokeChunk = st.chunk; }
function playTick(t) {
  if (!st.playing) return;
  playElapsed += Math.min(200, t - playLast);
  playLast = t;
  if (playElapsed >= playDur) {
    if (st.chunk >= st.chunks.length - 1) return pause();
    stepChunk(1);
  }
  playRaf = requestAnimationFrame(playTick);
}
function play() {
  if (!mode?.canPlay || st.playing) return;
  st.playing = true;
  body.classList.remove('paused');
  if (mode === Prompter) Prompter.play();
  else {
    if (karaokeChunk !== st.chunk || playElapsed === 0) { armChunk(); mode.karaoke(); }
    playLast = performance.now();
    playRaf = requestAnimationFrame(playTick);
  }
  updateHud();
}
function pause() {
  if (!st.playing) return;
  st.playing = false;
  cancelAnimationFrame(playRaf);
  body.classList.add('paused');
  Prompter.pause();
  updateHud();
}
const togglePlay = () => (st.playing ? pause() : play());

function stepChunk(d) {
  const n = clamp(st.chunk + d, 0, st.chunks.length - 1);
  if (n === st.chunk) return;
  st.chunk = n;
  if (st.playing) armChunk(); else { karaokeChunk = -1; playElapsed = 0; }
  mode.render(d);
  setPos(st.chunks[n].block);
}
function jumpChunk(n) { stepChunk(n - st.chunk); }

// ---------- modes ----------

const Column = {
  readY: () => innerHeight * 0.16,
  mount() {
    stage.innerHTML = `<div class="scroller"><article class="doc">${st.html}</article></div>`;
    this.sc = stage.firstChild;
    this.sc.addEventListener('scroll', () => scrollSync(this), { passive: true });
  },
  goTo(p) {
    const el = blockEl(p);
    lockUntil = performance.now() + 160;
    if (el) this.sc.scrollTop = el.offsetTop - this.readY() + 4;
  },
  relayout() { this.goTo(st.pos); },
  key(e) { return scrollKeys(this.sc, e); },
};

const Prompter = {
  canPlay: true,
  readY: () => innerHeight * 0.4,
  mount() {
    stage.innerHTML = `<div class="guide"></div><div class="scroller"><article class="doc">${st.html}</article></div>`;
    this.sc = stage.querySelector('.scroller');
    this.y = 0;
    this.sc.addEventListener('scroll', () => {
      if (Math.abs(this.sc.scrollTop - this.y) > 3) this.y = this.sc.scrollTop; // manual scroll while playing
      scrollSync(this);
    }, { passive: true });
  },
  goTo(p) {
    const el = blockEl(p);
    lockUntil = performance.now() + 160;
    if (el) this.sc.scrollTop = this.y = el.offsetTop - this.readY() + 2;
  },
  relayout() { this.goTo(st.pos); },
  speed() {
    const wordsPerLine = Math.min(charsPerLine(), 120) / 5.8;
    const linePx = S.size * 1.45 * autoLead();
    return (S.wpm / 60) / wordsPerLine * linePx;
  },
  play() {
    let last = performance.now();
    this.y = this.sc.scrollTop;
    const tick = (t) => {
      if (!st.playing || mode !== Prompter) return;
      this.y += this.speed() * Math.min(0.1, (t - last) / 1000);
      last = t;
      this.sc.scrollTop = this.y;
      if (this.sc.scrollTop + this.sc.clientHeight >= this.sc.scrollHeight - 2) return pause();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  pause() { cancelAnimationFrame(this.raf); },
  key(e) {
    if (e.key === ' ') { togglePlay(); return true; }
    if (st.playing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { changeWpm(e.key === 'ArrowUp' ? 10 : -10); return true; }
    return scrollKeys(this.sc, e);
  },
};

const Book = {
  mount() {
    stage.innerHTML = `<div class="book-view"><div class="book-pages"><article class="doc">${st.html}</article><div class="book-gutter"></div></div></div><div class="folio"></div>`;
    this.pagesEl = stage.querySelector('.book-pages');
    this.art = stage.querySelector('.doc');
    this.gutter = stage.querySelector('.book-gutter');
    this.folio = stage.querySelector('.folio');
    this.page = 0;
    this.layout();
  },
  layout() {
    const gap = Math.round(Math.max(56, S.size * 3.2));
    const avail = innerWidth - 120;
    // Prefer a two-page spread: narrow each page down to the space available,
    // as long as a page still holds ~42 characters per line.
    const half = Math.floor((avail - gap) / 2);
    const want = S.measure >= FULL ? half : S.measure * chPx();
    const cols = half >= 42 * chPx() ? 2 : 1;
    const colW = Math.round(Math.min(want, cols === 2 ? half : avail));
    const w = cols * colW + (cols - 1) * gap;
    const h = Math.floor(innerHeight * 0.8);
    Object.assign(this.pagesEl.style, { width: w + 'px', height: h + 'px' });
    Object.assign(this.art.style, { width: w + 'px', height: h + 'px', columnCount: cols, columnWidth: 'auto', columnGap: gap + 'px' });
    this.gutter.style.display = cols === 2 ? '' : 'none';
    this.gutter.style.left = colW + gap / 2 + 'px';
    this.step = w + gap;
    this.cols = cols;
    const last = this.art.lastElementChild;
    const base = this.art.getBoundingClientRect().left;
    const rects = last ? last.getClientRects() : [];
    const lastLeft = rects.length ? rects[rects.length - 1].left - base : 0;
    this.pages = Math.max(1, Math.floor((lastLeft + 2) / this.step) + 1);
  },
  show(anim = true) {
    this.page = clamp(this.page, 0, this.pages - 1);
    const a = this.art;
    if (!anim) a.style.transition = 'none';
    a.style.transform = `translateX(${-this.page * this.step}px)`;
    if (!anim) { void a.offsetWidth; a.style.transition = ''; }
    const p = this.page;
    this.folio.textContent = this.cols === 2
      ? `${p * 2 + 1}–${p * 2 + 2}  /  ${this.pages * 2}`
      : `${p + 1}  /  ${this.pages}`;
  },
  readPos() {
    const kids = this.art.children;
    const base = this.art.getBoundingClientRect().left;
    const target = this.page * this.step + 2;
    let lo = 0, hi = kids.length - 1, ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (kids[m].getBoundingClientRect().left - base <= target) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return +kids[ans].dataset.b;
  },
  goTo(p) {
    const el = blockEl(p);
    if (!el) return;
    const off = el.getBoundingClientRect().left - this.art.getBoundingClientRect().left;
    this.page = Math.floor((off + 2) / this.step);
    this.show(false);
  },
  turn(d) {
    const n = clamp(this.page + d, 0, this.pages - 1);
    if (n === this.page) return;
    this.page = n;
    this.show();
    setPos(this.readPos());
  },
  relayout() { this.layout(); this.goTo(st.pos); },
  wheel(d) { this.turn(d); },
  click(e) {
    if (e.clientX < innerWidth * 0.22) this.turn(-1);
    else if (e.clientX > innerWidth * 0.78) this.turn(1);
  },
  key(e) {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'j': this.turn(1); return true;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'k': this.turn(-1); return true;
      case ' ': this.turn(e.shiftKey ? -1 : 1); return true;
      case 'Home': this.turn(-this.page); return true;
      case 'End': this.turn(this.pages); return true;
    }
    return false;
  },
};

function chunkKeys(e) {
  switch (e.key) {
    case 'ArrowDown': case 'ArrowRight': case 'PageDown': case 'Enter': case 'j': stepChunk(1); return true;
    case 'ArrowUp': case 'ArrowLeft': case 'PageUp': case 'k': stepChunk(-1); return true;
    case ' ': stepChunk(e.shiftKey ? -1 : 1); return true;
    case 'Home': jumpChunk(0); return true;
    case 'End': jumpChunk(st.chunks.length - 1); return true;
  }
  return false;
}

const Focus = {
  canPlay: true,
  mount() {
    stage.innerHTML = '<div class="focus-view"><div class="focus-track"></div></div>';
    this.track = stage.querySelector('.focus-track');
    this.range = [-1, -1];
    this.last = null;
    this.track.addEventListener('click', (e) => {
      const c = e.target.closest('.chunk');
      if (c && !e.target.closest('a') && +c.dataset.c !== st.chunk) jumpChunk(+c.dataset.c);
    });
  },
  chunkDiv(c, i, d) {
    const cls = ['chunk'];
    if (c.kind === 'h') cls.push('h', 'h' + c.level);
    if (c.kind === 'q') cls.push('q');
    if (c.ps && i > 0) cls.push('ps');
    return `<div class="${cls.join(' ')}" data-c="${i}" data-d="${d}">${c.html}</div>`;
  },
  goTo(p) { st.chunk = chunkForBlock(p); this.render(0, true); },
  relayout() { this.render(0, true); },
  render(dir, force = false) {
    const c = st.chunk, N = st.chunks.length;
    let rebuilt = false;
    if (force || c < this.range[0] + 8 || c > this.range[1] - 8) {
      const s = Math.max(0, c - 24), e = Math.min(N, c + 25);
      const ref = this.last ?? c;
      this.range = [s, e - 1];
      this.track.innerHTML = st.chunks.slice(s, e).map((ch, j) => this.chunkDiv(ch, s + j, Math.min(4, Math.abs(s + j - ref)))).join('');
      rebuilt = true;
    }
    const center = (x) => innerHeight * 0.44 - (x.offsetTop + x.offsetHeight / 2);
    const prevEl = dir && this.last != null ? this.track.querySelector(`[data-c="${this.last}"]`) : null;
    if (rebuilt && prevEl) this.setY(center(prevEl), false);
    for (const x of this.track.querySelectorAll('.karaoke')) x.classList.remove('karaoke');
    for (const x of this.track.children) x.dataset.d = Math.min(4, Math.abs(+x.dataset.c - c));
    const el = this.track.querySelector(`[data-c="${c}"]`);
    if (el) this.setY(center(el), !!dir);
    this.last = c;
    if (st.playing) this.karaoke();
  },
  karaoke() {
    const el = this.track.querySelector(`[data-c="${st.chunk}"]`);
    const c = st.chunks[st.chunk];
    if (el && wrappable(c)) startKaraoke(el, playDur);
  },
  setY(y, anim) {
    const t = this.track;
    if (!anim) t.style.transition = 'none';
    t.style.transform = `translateY(${Math.round(y)}px)`;
    if (!anim) { void t.offsetWidth; t.style.transition = ''; }
  },
  wheel(d) { stepChunk(d); },
  key: chunkKeys,
};

const Cinema = {
  canPlay: true,
  mount() {
    stage.innerHTML = '<div class="cinema-view"><div class="cine-stage"></div></div><div class="cine-count"></div>';
    this.box = stage.querySelector('.cine-stage');
    this.count = stage.querySelector('.cine-count');
  },
  goTo(p) { st.chunk = chunkForBlock(p); this.render(0); },
  relayout() { this.render(0); },
  fit(c) {
    const b = S.size;
    if (!wrappable(c)) return c.kind === 'img' || c.kind === 'diagram' ? b : c.kind === 'math' ? b * 1.6 : b * 1.9;
    const len = Math.max(30, c.text.length);
    let f = b * 2.3 * Math.pow(150 / len, 0.33);
    if (c.kind === 'h') f *= 1.15;
    return clamp(f, b * 1.35, b * 3.4);
  },
  render(dir) {
    const c = st.chunks[st.chunk];
    for (const old of this.box.querySelectorAll('.cine-card:not(.leave)')) {
      if (!dir) { old.remove(); continue; }
      old.classList.add('leave');
      if (dir < 0) old.classList.add('back');
      setTimeout(() => old.remove(), 650);
    }
    const el = document.createElement('div');
    el.className = 'cine-card';
    if (c.kind === 'h') el.classList.add('h');
    if (c.kind === 'q') el.classList.add('q');
    if (c.text.length > 230 || c.kind === 'li') el.classList.add('left');
    el.innerHTML = c.html;
    el.style.fontSize = this.fit(c).toFixed(1) + 'px';
    if (wrappable(c) && !st.playing) {
      el.classList.add('reveal');
      wrapWords(el).forEach((w, i) => { w.style.animationDelay = Math.min(i * 24, 900) + 'ms'; });
    }
    if (dir) el.classList.add('enter', ...(dir < 0 ? ['back'] : []));
    this.box.append(el);
    if (dir) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter', 'back')));
    this.el = el;
    this.count.textContent = `${(st.chunk + 1).toLocaleString()}  /  ${st.chunks.length.toLocaleString()}`;
    if (st.playing) this.karaoke();
  },
  karaoke() {
    const c = st.chunks[st.chunk];
    if (this.el && wrappable(c)) startKaraoke(this.el, playDur);
  },
  wheel(d) { stepChunk(d); },
  click(e) { if (!e.target.closest('a')) stepChunk(e.clientX < innerWidth * 0.3 ? -1 : 1); },
  key: chunkKeys,
};

const MODES = { column: Column, book: Book, focus: Focus, cinema: Cinema, prompter: Prompter };
const MODE_NAMES = Object.keys(MODES);

function setMode(name) {
  if (!MODES[name]) return;
  S.mode = name;
  saveSettings();
  if (!st.doc) return updateHud();
  pause();
  body.classList.remove('paused');
  karaokeChunk = -1;
  mode = MODES[name];
  stage.className = 'mode-' + name;
  stage.innerHTML = '';
  body.classList.toggle('can-play', !!mode.canPlay);
  mode.mount();
  mode.goTo(st.pos);
  updateHud();
  updateProgress();
}

// ---------- HUD, toast, settings ----------

let toastT = 0;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), err ? 4200 : msg.length > 40 ? 3800 : 1700);
}

let hudPeek = false, idleT = 0;
function applyHud() { body.classList.toggle('hud-off', !S.hud && !hudPeek); }
function poke() {
  body.classList.remove('idle');
  if (!hudPeek) { hudPeek = true; applyHud(); }
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    if ($('#hud').matches(':hover')) return poke();
    hudPeek = false;
    applyHud();
    if (st.doc) body.classList.add('idle');
  }, 2200);
}

function updateHud() {
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === S.mode);
  $('#v-size').textContent = S.size;
  $('#v-measure').textContent = S.measure >= FULL ? 'Full' : S.measure + 'ch';
  $('#v-lead').textContent = autoLead().toFixed(2);
  $('#v-font').textContent = FONTS[S.font][1];
  $('#v-theme').textContent = THEMES[S.theme];
  $('#v-align').textContent = S.align === 'justify' ? 'Justified' : 'Ragged';
  const p = $('#v-play');
  p.textContent = `${st.playing ? '❚❚' : '▶'}  ${S.wpm} wpm`;
  p.classList.toggle('on', st.playing);
}

function change(fn, msg, relayout = true) {
  fn();
  applyVars();
  saveSettings();
  if (relayout && mode) mode.relayout();
  if (msg) toast(msg());
}
const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];
const leadMsg = () => `Line height ${autoLead().toFixed(2)}${S.leadAdj ? ` (auto ${S.leadAdj > 0 ? '+' : ''}${S.leadAdj.toFixed(2)})` : ' (auto)'}`;
const measureMsg = () => (S.measure >= FULL ? 'Full width' : `~${S.measure} characters per line${S.measure < 45 ? ' · short' : S.measure > 90 ? ' · long lines' : ''}`) + ` · line height ${autoLead().toFixed(2)}`;
function changeWpm(d) {
  S.wpm = clamp(S.wpm + d, 80, 900);
  saveSettings();
  if (st.playing && mode !== Prompter) playDur = chunkMs(st.chunks[st.chunk]);
  updateHud();
  toast(`${S.wpm} words per minute`);
}

const ACT = {
  'size-': () => change(() => { S.size = clamp(S.size - 1, 12, 48); }, () => `Text ${S.size}px · line height ${autoLead().toFixed(2)}`),
  'size+': () => change(() => { S.size = clamp(S.size + 1, 12, 48); }, () => `Text ${S.size}px · line height ${autoLead().toFixed(2)}`),
  'measure-': () => change(() => { S.measure = S.measure >= FULL ? 120 : clamp(S.measure - 4, 36, 120); }, measureMsg),
  'measure+': () => change(() => { S.measure = S.measure >= 120 ? FULL : clamp(S.measure + 4, 36, 120); }, measureMsg),
  'lead-': () => change(() => { S.leadAdj = clamp(+(S.leadAdj - 0.05).toFixed(2), -0.5, 0.7); }, leadMsg),
  'lead+': () => change(() => { S.leadAdj = clamp(+(S.leadAdj + 0.05).toFixed(2), -0.5, 0.7); }, leadMsg),
  font: () => change(() => { S.font = cycle(Object.keys(FONTS), S.font); }, () => FONTS[S.font][1]),
  theme: async () => {
    change(() => { S.theme = cycle(Object.keys(THEMES), S.theme); }, () => THEMES[S.theme] + (THEME_ROOM[S.theme] ? ` · ${THEME_ROOM[S.theme]}` : ''), false);
    if (st.doc && await renderDiagrams(st.doc)) { buildDoc(); setMode(S.mode); }
  },
  align: () => change(() => { S.align = S.align === 'justify' ? 'left' : 'justify'; }, () => (S.align === 'justify' ? 'Justified' : 'Ragged right')),
  para: () => change(() => { S.para = S.para === 'indent' ? 'space' : 'indent'; }, () => (S.para === 'indent' ? 'Book indents' : 'Paragraph spacing')),
  hud: () => change(() => { S.hud = !S.hud; }, () => (S.hud ? 'Controls pinned' : 'Controls auto-hide'), false),
  play: togglePlay,
  open: () => pickFile(),
  sample: () => openSample(),
  help: () => { $('#help').hidden = !$('#help').hidden; },
  hide: () => (api ? api.hide() : toast('Esc hides the overlay in the desktop app')),
};

// ---------- opening documents ----------

function setLoading(on, text = 'Reading…') {
  $('#loading').hidden = !on;
  $('#loading span').textContent = text;
}

// Ctrl+Alt+C: the reader comes up at once with a blank page while the app hands over
// its content, so the previous document never shows in the meantime.
let fetchTimer = 0;
function setFetching(on) {
  clearTimeout(fetchTimer);
  document.body.classList.toggle('fetching', on);
  if (on) { setLoading(true, 'Getting the page…'); fetchTimer = setTimeout(() => setFetching(false), 25000); }
  else if (!$('#loading span').textContent.startsWith('Reading')) setLoading(false);
}

async function openFile(f) {
  clearTimeout(fetchTimer);
  setLoading(true);
  try {
    const doc = await parseDocument(f, (p) => setLoading(true, `Reading… ${Math.round(p * 100)}%`), { resolveImage: imageResolver(f.path) });
    if (doc.blocks.some((b) => b.type === 'diagram')) { setLoading(true, 'Drawing diagrams…'); await renderDiagrams(doc); }
    if (!doc.blocks.length) throw new Error('No readable text found in this file.');
    await loadDoc(doc, f);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  } finally {
    setLoading(false);
    document.body.classList.remove('fetching');
  }
}

// Relative image paths (./img/fig.png) are resolved next to the document and
// served by the main process. Only possible when we know where the file lives.
function imageResolver(path) {
  if (!api || !path) return null;
  const base = 'file://' + path.split('/').map(encodeURIComponent).join('/');
  return (src) => {
    try {
      const u = new URL(src, base);
      return u.protocol === 'file:' ? 'app://local/__img?p=' + encodeURIComponent(decodeURIComponent(u.pathname)) : null;
    } catch { return null; }
  };
}

async function loadDoc(doc, f) {
  pause();
  for (const u of st.doc?.urls || []) URL.revokeObjectURL(u);
  if (st.file && st.file.path !== f.path) st.prevFile = st.file;
  st.file = f;
  tidyTurns(doc);
  st.doc = doc;
  st.key =`${f.name}:${f.data.byteLength ?? f.data.length}`;
  buildDoc();
  let acc = 0;
  st.cum = doc.blocks.map((b) => { const v = acc; acc += (b.text || '').length; return v; });
  st.total = acc || 1;
  st.heads = doc.blocks.flatMap((b, i) => (/^h[1-3]$/.test(b.type) ? [i] : []));
  st.pos = clamp(store.get('gr:pos:' + st.key, 0), 0, doc.blocks.length - 1);
  const fromClaude = /\/glass-reader\/claude\//.test(f.path || '');
  // A Claude conversation opens at its latest prompt; earlier turns are above it.
  // So does a chat captured from the browser (ChatGPT, Claude, Gemini).
  const isChat = fromClaude || (/\/glass-reader\/captures\//.test(f.path || '') && doc.blocks.some((b) => b.anchor?.startsWith('gr-turn')));
  const lastTurn = isChat ? doc.blocks.findLastIndex((b) => b.anchor?.startsWith('gr-turn')) : -1;
  if (lastTurn >= 0) st.pos = lastTurn;
  body.classList.remove('no-doc');
  $('#welcome').hidden = true;
  $('#help').hidden = true;
  $('#v-title').textContent = doc.title;
  document.title = `${doc.title} — Glass Reader`;
  if (f.path && !fromClaude && !/\/glass-reader\/captures\//.test(f.path)) addRecent({ title: doc.title, path: f.path, key: st.key });
  await document.fonts.ready;
  setMode(S.mode);
  console.info(`opened "${doc.title}": ${doc.blocks.length} blocks, ${st.chunks.length} chunks, mode ${S.mode}, at block ${st.pos}, ${doc.blocks.filter((b) => b.type === 'table').length} tables, ${doc.blocks.filter((b) => b.type === 'img').length} images`);
  if (isChat) {
    const n = doc.blocks.filter((b) => b.anchor?.startsWith('gr-turn')).length;
    toast(n > 1 ? `Latest answer · ${n - 1} earlier above${st.prevFile ? ' · Backspace goes back' : ''}`
      : st.prevFile ? `${fromClaude ? 'Claude’s answer' : 'The answer'} · Backspace returns to what you were reading` : fromClaude ? 'Claude’s answer' : 'The answer');
  }
  else if (st.pos > 0) toast(`Resumed at ${Math.round(st.cum[st.pos] / st.total * 100)}%`);
}

function addRecent(r) {
  const rec = store.get('gr:recents', []).filter((x) => x.path !== r.path);
  const pct = Math.round(st.cum[st.pos] / st.total * 100);
  rec.unshift({ ...r, pct });
  store.set('gr:recents', rec.slice(0, 8));
}
function renderRecents() {
  const box = $('#recents');
  const rec = api ? store.get('gr:recents', []) : [];
  box.innerHTML = rec.length ? '<h3>Continue reading</h3>' : '';
  for (const r of rec.slice(0, 5)) {
    const b = document.createElement('button');
    b.innerHTML = `<span>${esc(r.title)}</span><span>${r.pct || 0}%</span>`;
    b.onclick = async () => {
      const d = await api.readPath(r.path);
      if (d) openFile(d); else toast('That file has moved or was deleted.', true);
    };
    box.append(b);
  }
}

async function pickFile() {
  if (api) {
    const d = await api.openDialog();
    if (d) openFile(d);
  } else $('#file').click();
}
async function openSample() {
  const res = await fetch(new URL('../samples/guide.md', import.meta.url));
  openFile({ name: 'guide.md', data: new Uint8Array(await res.arrayBuffer()) });
}
function showWelcome() {
  renderRecents();
  $('#welcome').hidden = false;
}

// ---------- Claude session picker ----------

const picker = { list: [], sel: 0 };
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (!t) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
function showPicker(list) {
  picker.list = list || [];
  picker.sel = 0;
  const box = $('#picker-list');
  box.innerHTML = '';
  if (!picker.list.length) box.innerHTML = '<p class="empty">No Claude Code sessions are running.</p>';
  picker.list.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'sess' + (s.words ? '' : ' none');
    const meta = [s.project !== s.name && s.project, s.where, s.status === 'busy' ? 'working…' : '', ago(s.at)].filter(Boolean).join(' · ');
    b.innerHTML = `<span class="num">${i < 9 ? i + 1 : ''}</span>
      <span class="main"><span class="name">${esc(s.name)}</span><span class="meta">${esc(meta)}</span>
      <span class="prompt">${s.prompt ? esc(s.prompt) : s.words ? 'Claude’s answer' : 'No answers yet'}</span></span>
      <span class="words">${s.words ? s.words.toLocaleString() + ' words' : ''}</span>`;
    b.onclick = () => pickSession(i);
    b.onmousemove = () => { if (picker.sel !== i) { picker.sel = i; markPicker(); } };
    box.append(b);
  });
  $('#picker').hidden = false;
  markPicker();
  console.debug(`picker: ${picker.list.length} sessions: ${picker.list.map((x) => x.name).join(' | ')}`);
}
function markPicker() {
  [...document.querySelectorAll('#picker-list .sess')].forEach((b, i) => b.classList.toggle('sel', i === picker.sel));
  document.querySelectorAll('#picker-list .sess')[picker.sel]?.scrollIntoView({ block: 'nearest' });
}
const pickerOpen = () => !$('#picker').hidden;
function closePicker() { $('#picker').hidden = true; }
async function pickSession(i) {
  const s = picker.list[i];
  if (!s) return;
  if (!s.words) return toast('That session has no answers yet.', true);
  closePicker();
  const err = await api.openClaude(s.sessionId);
  if (err) toast(err, true);
}
async function openPicker() {
  if (!api) return;
  showPicker(await api.claudeSessions());
}
function pickerKey(e) {
  const k = e.key;
  const n = picker.list.length;
  if (k === 'Escape' || k === 'c' || k === 'C') { closePicker(); if (!st.doc && k === 'Escape') ACT.hide(); return; }
  if (k === 'ArrowDown' || k === 'j' || k === 'Tab') { picker.sel = (picker.sel + 1) % Math.max(1, n); markPicker(); }
  else if (k === 'ArrowUp' || k === 'k') { picker.sel = (picker.sel - 1 + n) % Math.max(1, n); markPicker(); }
  else if (k === 'Enter') pickSession(picker.sel);
  else if (/^[1-9]$/.test(k)) pickSession(+k - 1);
  else return;
  e.preventDefault();
}

// ---------- input ----------

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  if (e.ctrlKey && lower === 'q') { e.preventDefault(); return api ? api.quit() : undefined; }
  if (e.ctrlKey && lower === 'o') { e.preventDefault(); return pickFile(); }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (pickerOpen()) return pickerKey(e);
  if (lower === 'c' && api) return openPicker();
  if (k === 'Escape') {
    if (!$('#help').hidden) { $('#help').hidden = true; return; }
    if (st.playing) return pause();
    return ACT.hide();
  }
  if (k === '?') return ACT.help();
  if (lower === 'n' && st.inbox && api) { st.inbox = false; return api.openInbox(); }
  if (k === 'Backspace' && st.prevFile) { e.preventDefault(); return openFile(st.prevFile); }
  if (lower === 'o') return pickFile();
  if (!st.doc) return;
  const map = {
    '-': 'size-', _: 'size-', '=': 'size+', '+': 'size+', '[': 'measure-', ']': 'measure+',
    f: 'font', t: 'theme', a: 'align', i: 'para', h: 'hud', p: 'play',
  };
  if (/^[1-5]$/.test(k)) { setMode(MODE_NAMES[+k - 1]); toast(MODE_NAMES[+k - 1][0].toUpperCase() + MODE_NAMES[+k - 1].slice(1)); return; }
  if (lower === 'l') { e.preventDefault(); return e.shiftKey ? ACT['lead-']() : ACT['lead+'](); }
  if (k === ',' || k === '<') return changeWpm(-10);
  if (k === '.' || k === '>') return changeWpm(10);
  if (map[k] || map[lower]) { e.preventDefault(); return ACT[map[k] || map[lower]](); }
  if (mode?.key(e)) e.preventDefault();
});

let wheelAcc = 0, wheelT = 0, wheelCool = 0;
stage.addEventListener('wheel', (e) => {
  if (!mode?.wheel) return;
  e.preventDefault();
  const now = performance.now();
  if (now - wheelT > 350) wheelAcc = 0;
  wheelT = now;
  if (now < wheelCool) return;
  wheelAcc += e.deltaY || e.deltaX;
  if (Math.abs(wheelAcc) >= 60) {
    mode.wheel(Math.sign(wheelAcc));
    wheelAcc = 0;
    wheelCool = now + 240;
  }
}, { passive: false });

stage.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
  if (getSelection().toString()) return;
  mode?.click?.(e);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act], [data-mode]');
  if (!b) {
    if (e.target.id === 'help') $('#help').hidden = true;
    if (e.target.id === 'picker') closePicker();
    return;
  }
  if (b.dataset.mode) setMode(b.dataset.mode);
  else ACT[b.dataset.act]?.();
});

addEventListener('mousemove', poke, { passive: true });

// Image diagnostics (visible with GR_DEBUG=1).
document.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG') return;
  console.warn('image failed to load:', e.target.src.slice(0, 140));
  // A picture that won't load (an expired or blocked link): its caption stays, the broken box goes.
  if (e.target.closest('figure, .chunk, .cine-card')) e.target.style.display = 'none';
}, true);
document.addEventListener('load', (e) => {
  if (e.target.tagName === 'IMG') console.debug('image loaded:', e.target.src.slice(0, 80), e.target.naturalWidth + 'x' + e.target.naturalHeight);
}, true);

let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { applyVars(); mode?.relayout(); }, 150);
});

// drag & drop
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropzone').hidden = false; });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  openFile({ name: file.name, data: new Uint8Array(await file.arrayBuffer()), path: api?.pathForFile(file) || null });
});

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) openFile({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  e.target.value = '';
});

// ---------- boot ----------

body.classList.add('no-doc');
applyVars();
showWelcome();
poke();

if (api) {
  api.onOpen((d) => openFile(d));
  api.onError((m) => toast(m, true));
  api.onShown(() => {
    poke();
    setTimeout(() => console.debug(`shown: focus=${document.hasFocus()} size=${innerWidth}x${innerHeight}`), 500);
  });
  api.onRequestOpen(() => pickFile());
  api.onPicker((list) => { setFetching(false); showPicker(list); });
  api.onFetching?.(() => setFetching(true));
  api.onFetchingOff?.(() => setFetching(false));
  api.onToast?.((m) => toast(m));
  api.onInbox(() => { st.inbox = true; toast('Claude finished a new answer · press N to read it'); });
  api.wallpaper().then((url) => {
    if (!url) return;
    const img = $('#wall');
    img.onload = () => $('#bg').classList.add('has-wall');
    img.src = url;
  });
  api.ready();
}

// expose for debugging in devtools
window.__gr = { st, S, setMode, openSample, openFile, showPicker };
