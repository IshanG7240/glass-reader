#!/usr/bin/env node
// Builds dist/glass-reader.user.js: Glass Reader for Safari on iPad and iPhone (through
// the free Userscripts app), and any desktop browser with a userscript manager.
//
// It is the desktop reader itself (renderer/), bundled into one file with its styles
// and fonts, plus the chat capture from extension/browser/background.js, wrapped by
// ios/overlay.js. Rebuild after changing any of those:  npm run build:ios

'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const R = (...p) => path.join(ROOT, ...p);
const OUT = R('dist', 'glass-reader.user.js');
const pkg = require(R('package.json'));

// Every global the reader touches that belongs to a window. Rewritten to GRW.*, the
// overlay frame's window, so the reader draws into the frame and not the chat page.
const FRAME_GLOBALS = [
  'window', 'document', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener',
  'dispatchEvent', 'getSelection', 'getComputedStyle', 'matchMedia', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'Image', 'CSS', 'devicePixelRatio',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'FontFace', 'self',
];

// Things the in-page reader can't do (they need files next to the reader, workers or
// script tags, which the chat sites' security policies block). Stubbed out.
const STUBS = {
  pdfjs: {
    filter: /pdfjs-dist\/build\/pdf\.mjs$/,
    contents: `export const GlobalWorkerOptions = {};
      export const OPS = new Proxy({}, { get: () => -1 });
      export function getDocument() { throw new Error('PDFs open in the desktop app. Here, Glass Reader reads conversations.'); }`,
  },
  mermaid: {
    filter: /mermaid[^/]*\.mjs$/,
    contents: `export default { initialize() {}, async render() { throw new Error('diagrams are drawn in the desktop app'); } };`,
  },
};

async function bundleReader() {
  const res = await esbuild.build({
    entryPoints: [R('renderer', 'app.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['safari16'],
    charset: 'utf8',
    legalComments: 'none',
    minify: true,
    logLevel: 'error',
    define: {
      ...Object.fromEntries(FRAME_GLOBALS.map((g) => [g, g === 'window' || g === 'self' ? 'GRW' : `GRW.${g}`])),
      'import.meta.url': '"https://glass-reader.invalid/renderer/app.js"',
    },
    plugins: [{
      name: 'stubs',
      setup(b) {
        for (const [name, s] of Object.entries(STUBS)) {
          b.onResolve({ filter: s.filter }, () => ({ path: name, namespace: 'stub' }));
        }
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path].contents, loader: 'js' }));
      },
    }],
  });
  // Chrome refuses an extension script holding a Unicode noncharacter (one library has
  // \uFFFF in a regex, which charset: utf8 writes out raw). Escaped, it means the same.
  return res.outputFiles[0].text.replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

// index.html's stylesheets, in order, without their @font-face rules: the fonts are
// embedded and loaded with the FontFace API instead (no font requests from the page).
function stylesAndFonts() {
  const html = fs.readFileSync(R('renderer', 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  const fonts = [];
  let css = '';
  for (const href of hrefs) {
    const file = path.resolve(R('renderer'), href);
    let text = fs.readFileSync(file, 'utf8');
    text = text.replace(/@font-face\s*{[^}]*}/g, (rule) => {
      const get = (k) => (rule.match(new RegExp(`${k}\\s*:\\s*([^;}]+)`)) || [])[1]?.trim();
      const woff2 = (rule.match(/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/) || [])[1];
      if (!woff2) return '';
      // Fontsource ships one file per script; Latin covers English and the reader's UI.
      // Other scripts fall back to the system's fonts.
      if (/@fontsource/.test(file) && !/-latin-(?!ext)/.test(woff2)) return '';
      const src = path.resolve(path.dirname(file), woff2);
      fonts.push({
        family: get('font-family').replace(/^['"]|['"]$/g, ''),
        weight: get('font-weight') || '400',
        style: get('font-style') || 'normal',
        b64: fs.readFileSync(src).toString('base64'),
      });
      return '';
    });
    css += `/* ${path.relative(ROOT, file)} */\n${text}\n`;
  }
  css += fs.readFileSync(R('ios', 'overlay.css'), 'utf8');
  return { css, fonts };
}

function bodyHTML() {
  const html = fs.readFileSync(R('renderer', 'index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  return body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\n\s+/g, '\n').trim();
}

// extract() is the last function in background.js and self-contained (Chrome runs it
// inside the tab), so the userscript can run the very same code.
function extractSource() {
  const src = fs.readFileSync(R('extension', 'browser', 'background.js'), 'utf8');
  const at = src.indexOf('async function extract()');
  if (at < 0) throw new Error('extract() not found in extension/browser/background.js');
  return src.slice(at).trim();
}

// parseDiff() and diffMarkdown() from bin/read-focused.js (with their constants): a
// GitHub diff becomes the same document as on the desktop.
function diffSource() {
  const src = fs.readFileSync(R('bin', 'read-focused.js'), 'utf8');
  const a = src.indexOf('const NOISY'), b = src.indexOf('function writeDoc');
  if (a < 0 || b < a) throw new Error('parseDiff/diffMarkdown not found in bin/read-focused.js');
  return src.slice(a, b).trim();
}

// ios/overlay.js with the reader, its styles and fonts, and the capture code filled in.
async function overlay({ extension }) {
  const [bundle, { css, fonts }] = [await bundleReader(), stylesAndFonts()];
  const tpl = fs.readFileSync(R('ios', 'overlay.js'), 'utf8');
  const fill = {
    __GR_BODY__: JSON.stringify(bodyHTML()), __GR_CSS__: JSON.stringify(css), __GR_FONTS__: JSON.stringify(fonts),
    __GR_EXTENSION__: String(!!extension), __GR_BUNDLE__: bundle,
    // The extension's background does the reading; the userscript reads in the page.
    __GR_EXTRACT__: extension ? '' : extractSource(), __GR_DIFF__: diffSource(),
  };
  let out = tpl;
  for (const [k, v] of Object.entries(fill)) {
    if (!out.includes(k)) throw new Error(`${k} missing from ios/overlay.js`);
    out = out.replace(k, () => v);
  }
  return { code: out, sizes: { bundle: bundle.length, css: css.length, fonts: fonts.length, fontBytes: fonts.reduce((n, f) => n + f.b64.length, 0) } };
}

async function main() {
  const t0 = Date.now();
  const { code: out, sizes } = await overlay({ extension: false });
  const header = `// ==UserScript==
// @name         Glass Reader
// @namespace    https://github.com/glass-reader
// @version      ${pkg.version}.${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}
// @description  Read a whole ChatGPT, Claude or Gemini conversation on one calm sheet of glass.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @grant        none
// ==/UserScript==

`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + out);
  const kb = (n) => Math.round(n / 1024) + ' KB';
  console.log(`${path.relative(ROOT, OUT)}: ${kb(fs.statSync(OUT).size)} (reader ${kb(sizes.bundle)}, styles ${kb(sizes.css)}, ${sizes.fonts} fonts ${kb(sizes.fontBytes)}) in ${Date.now() - t0} ms`);
}

module.exports = { overlay, ROOT };
if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
