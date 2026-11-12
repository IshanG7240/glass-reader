#!/usr/bin/env node
// Builds the standalone browser extension, for sharing:
//
//   dist/glass-reader-extension/      load it unpacked (chrome://extensions → Developer
//                                     mode → Load unpacked), or…
//   dist/glass-reader-extension.zip   …send this, or upload it to the Chrome Web Store.
//
// reader.js is the same in-page reader as the iPad userscript (ios/overlay.js, built
// with extension: true); background.js is extension/standalone/background.js plus the
// page capture from extension/browser/background.js.   npm run build:extension

'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { overlay, ROOT } = require('./build-userscript.js');

const R = (...p) => path.join(ROOT, ...p);
const OUT = R('dist', 'glass-reader-extension');
const pkg = require(R('package.json'));

function manifest() {
  const icons = Object.fromEntries([16, 32, 48, 128].map((n) => [n, `icons/${n}.png`]));
  return {
    manifest_version: 3,
    name: 'Glass Reader',
    version: pkg.version,
    description: 'Read any page on a calm sheet of glass: articles, GitHub, Google Docs, and whole ChatGPT, Claude and Gemini chats.',
    permissions: ['activeTab', 'scripting'],
    background: { service_worker: 'background.js' },
    action: { default_title: 'Read this page in Glass Reader (Alt+Shift+R)', default_icon: icons },
    icons,
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+R' }, description: 'Read this page in Glass Reader' } },
    minimum_chrome_version: '110',
  };
}

// captureTab() and everything after it in the companion's background.js.
function captureSource() {
  const src = fs.readFileSync(R('extension', 'browser', 'background.js'), 'utf8');
  const at = src.indexOf('async function captureTab(');
  if (at < 0) throw new Error('captureTab() not found in extension/browser/background.js');
  return src.slice(at);
}

async function main() {
  const t0 = Date.now();
  const { code } = await overlay({ extension: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
  const files = {
    'manifest.json': JSON.stringify(manifest(), null, 2) + '\n',
    'background.js': fs.readFileSync(R('extension', 'standalone', 'background.js'), 'utf8') + '\n' + captureSource(),
    'reader.js': code,
    'Readability.js': fs.readFileSync(R('extension', 'browser', 'Readability.js')),
    'Readability-LICENSE.md': fs.readFileSync(R('extension', 'browser', 'Readability-LICENSE.md')),
  };
  for (const n of [16, 32, 48, 128]) files[`icons/${n}.png`] = fs.readFileSync(R('extension', 'standalone', 'icons', `${n}.png`));
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), data);
    zip.file(name, data);
  }
  const zipPath = OUT + '.zip';
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const kb = (n) => Math.round(n / 1024) + ' KB';
  console.log(`${path.relative(ROOT, OUT)}/ and ${path.basename(zipPath)} (${kb(fs.statSync(zipPath).size)}) in ${Date.now() - t0} ms`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
