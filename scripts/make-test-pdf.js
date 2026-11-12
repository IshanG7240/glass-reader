// Dev helper: renders samples/guide.md-like prose plus a vector diagram and a
// raster chart into a multi-page PDF with running headers and page numbers, to
// exercise the PDF cleaner and figure extraction.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const md = fs.readFileSync(path.join(__dirname, '../samples/guide.md'), 'utf8');
const paras = md.split(/\n\n+/).filter((p) => !/^(\||```|>|\d\.)/.test(p)).map((p) => p.startsWith('#')
  ? `<h${p.match(/^#+/)[0].length}>${p.replace(/^#+\s*/, '')}</h${p.match(/^#+/)[0].length}>`
  : `<p>${p.replace(/\*\*/g, '')}</p>`).join('\n');
const svg = fs.readFileSync(path.join(__dirname, '../samples/assets/pipeline.svg'), 'utf8').replace(/width="640" height="200"/, 'width="100%"');
const figures = `<h2>Figures</h2><p>A vector diagram with text labels follows, then a raster chart.</p>
<div style="margin:1em 0">${svg}</div><p style="font-size:9pt;text-align:center">Figure 1. The reading pipeline.</p>
<p>Between the two figures sits an ordinary paragraph of body text, which should stay as text and keep its place between them in the reading order.</p>
<canvas id="c" width="600" height="300" style="width:100%"></canvas><p style="font-size:9pt;text-align:center">Figure 2. Pages read per day.</p>
<p>After the figures the text carries on as usual, and nothing from inside the figures should leak into this paragraph.</p>
<h2>Tables</h2><p>A ruled table like a Google Docs export follows; it should come back as a real table, not as one line per cell or as a picture.</p>
<table style="width:100%;border-collapse:collapse;font-size:10pt;text-align:center;margin:1em 0">
<tr style="border-top:1.5px solid #000;border-bottom:1px solid #000"><th>2θ (°)</th><th>θ (°)</th><th>M</th><th>(hkl)</th><th>d (Å)</th><th>a (Å)</th></tr>
<tr style="border-bottom:0.5px solid #888"><td>44.9146</td><td>22.457</td><td>2</td><td>(110)</td><td>2.0165</td><td>2.8518</td></tr>
<tr style="border-bottom:0.5px solid #888"><td>65.2572</td><td>32.629</td><td>4</td><td>(200)</td><td>1.4286</td><td>2.8572</td></tr>
<tr style="border-bottom:0.5px solid #888"><td>82.5617</td><td>41.281</td><td>6</td><td>(211)</td><td>1.1676</td><td>2.8599</td></tr>
<tr style="border-bottom:1.5px solid #000"><td>99.1627</td><td>49.581</td><td>8</td><td>(220)</td><td>1.0118</td><td>2.8618</td></tr>
</table><p style="font-size:9pt;text-align:center;font-style:italic">Table 1. Indexing on a cubic cell.</p>
<table style="width:70%;margin:1em auto;border-collapse:collapse;font-size:10pt">
<tr style="background:#eee"><th style="border:1px solid #999;padding:3px">Item</th><th style="border:1px solid #999;padding:3px">Answer</th></tr>
<tr><td style="border:1px solid #999;padding:3px">Location</td><td style="border:1px solid #999;padding:3px">Lab 2</td></tr>
<tr><td style="border:1px solid #999;padding:3px">Make and model</td><td style="border:1px solid #999;padding:3px">Benchtop diffractometer</td></tr>
<tr><td style="border:1px solid #999;padding:3px">Contact</td><td style="border:1px solid #999;padding:3px">Lab technician</td></tr>
</table>
<p>The text after the tables continues as ordinary prose and must not be swallowed into either table above it.</p>
<script>const g=document.getElementById('c').getContext('2d');const v=[3,7,4,9,12,8,15];v.forEach((h,i)=>{g.fillStyle='hsl('+(220+i*12)+',70%,55%)';g.fillRect(40+i*80,280-h*16,56,h*16)});g.strokeStyle='#333';g.beginPath();g.moveTo(30,10);g.lineTo(30,280);g.lineTo(590,280);g.stroke();</script>`;
const html = `<html lang="en"><style>body{font:11pt/1.45 Georgia,serif;margin:0} p{margin:0;text-indent:1.5em;text-align:justify;hyphens:auto} h1{font-size:22pt} h2{font-size:15pt;margin-top:1.4em}</style><body>${paras}${figures}${paras}</body></html>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdf = await w.webContents.printToPDF({
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center">Reading on Glass — A Field Guide</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span></div>',
    pageSize: 'A5', margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },
  });
  fs.writeFileSync(path.join(__dirname, '../samples/test-figures.pdf'), pdf);
  console.log('wrote', pdf.length, 'bytes');
  app.quit();
});
