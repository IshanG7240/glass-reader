// Draws the extension's toolbar icons (extension/standalone/icons/*.png): the READ
// tab's blue-violet glass with three lines of text. Run once after changing the look:
//   npx electron scripts/make-icons.js
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const draw = (n) => {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const s = n / 128;
  const r = 30 * s, m = n <= 16 ? 0 : 4 * s, w = n - 2 * m;
  const grad = g.createLinearGradient(m, m, m + w, m + w);
  grad.addColorStop(0, '#5d7bff');
  grad.addColorStop(1, '#8b5cf6');
  g.fillStyle = grad;
  g.beginPath(); g.roundRect(m, m, w, w, r); g.fill();
  // a sheen across the top, like glass
  const sheen = g.createLinearGradient(0, m, 0, m + w * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,255,0.28)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.beginPath(); g.roundRect(m, m, w, w * 0.55, [r, r, 0, 0]); g.fill();
  // three lines, shorter and fainter as they go
  const lines = n <= 16 ? [[1, 1], [0.7, 0.75]] : [[1, 1], [0.72, 0.7], [0.48, 0.45]];
  const lh = Math.max(2, Math.round(11 * s)), gap = Math.max(2, Math.round(13 * s)), x = Math.round(30 * s), full = n - 2 * x;
  let y = Math.round((n - (lines.length * lh + (lines.length - 1) * gap)) / 2);
  for (const [len, a] of lines) {
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath(); g.roundRect(x, y, Math.round(full * len), lh, lh / 2); g.fill();
    y += lh + gap;
  }
  return c.toDataURL('image/png');
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body></body>');
  const dir = path.join(__dirname, '..', 'extension', 'standalone', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [16, 32, 48, 128]) {
    const url = await win.webContents.executeJavaScript(`(${draw})(${n})`);
    fs.writeFileSync(path.join(dir, `${n}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log('icons written to', path.relative(process.cwd(), dir));
  app.exit(0);
});
