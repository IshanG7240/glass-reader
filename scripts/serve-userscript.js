#!/usr/bin/env node
// Hands dist/glass-reader.user.js to an iPad or iPhone on the same Wi-Fi: open the
// printed address in Safari there and the Userscripts app offers to install it.
// Serves only that one file, and stops on Ctrl+C.   npm run serve:ios

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(__dirname, '..', 'dist', 'glass-reader.user.js');
const PORT = +process.env.PORT || 8765;
if (!fs.existsSync(FILE)) { console.error('Build it first: npm run build:ios'); process.exit(1); }

http.createServer((req, res) => {
  if (req.url.split('?')[0] !== '/glass-reader.user.js') { res.writeHead(404).end('Only /glass-reader.user.js is here.'); return; }
  console.log(`${new Date().toLocaleTimeString()}  sent to ${req.socket.remoteAddress}`);
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(FILE).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('On your iPad or iPhone (same Wi-Fi), open in Safari:\n');
  for (const ip of ips) console.log(`   http://${ip}:${PORT}/glass-reader.user.js`);
  console.log('\nThe Userscripts app then offers to install it. Ctrl+C here when done.');
  console.log('"Couldn\'t connect to the server" there: the Wi-Fi keeps devices apart (common on campus,');
  console.log('office and guest networks). Send yourself dist/glass-reader.user.js instead (Drive, email)');
  console.log('and move it into the Userscripts folder in the Files app.');
});
