#!/usr/bin/env node
// Builds the Android app → dist/glass-reader.apk, and installs it when a phone is
// connected over USB (`--install`). Uses ~/Android/jdk and ~/Android/Sdk unless
// JAVA_HOME / ANDROID_HOME say otherwise.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const home = (p) => path.join(os.homedir(), p);
const env = { ...process.env };
if (!env.JAVA_HOME && fs.existsSync(home('Android/jdk'))) env.JAVA_HOME = home('Android/jdk');
if (!env.ANDROID_HOME && fs.existsSync(home('Android/Sdk'))) env.ANDROID_HOME = home('Android/Sdk');
if (!fs.existsSync(path.join(root, 'node_modules/katex'))) {
  console.error('Run npm install first: the app bundles fonts and libraries from node_modules.');
  process.exit(1);
}

const gradlew = path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['-q', 'assembleDebug'], { cwd: path.join(root, 'android'), env, stdio: 'inherit' });
const apk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist/glass-reader.apk');
fs.copyFileSync(apk, out);
console.log(`→ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);

if (process.argv.includes('--install')) {
  const adb = env.ANDROID_HOME ? path.join(env.ANDROID_HOME, 'platform-tools/adb') : 'adb';
  execFileSync(adb, ['install', '-r', out], { stdio: 'inherit' });
  // Reinstalling turns the accessibility service off; turn it back on, keeping any other
  // accessibility services that are on.
  const ours = 'dev.glassreader/.CaptureService';
  const now = execFileSync(adb, ['shell', 'settings', 'get', 'secure', 'enabled_accessibility_services']).toString().trim();
  const list = now && now !== 'null' ? now.split(':').filter((s) => s && s !== ours) : [];
  execFileSync(adb, ['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', [...list, ours].join(':')], { stdio: 'inherit' });
  console.log('Installed; reading from the screen is on.');
}
