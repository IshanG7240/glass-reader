#!/usr/bin/env node
// Builds the Android app → dist/glass-reader.apk, and installs it when a phone is
// connected over USB (`--install`). Uses ~/Android/jdk and ~/Android/Sdk unless
// JAVA_HOME / ANDROID_HOME say otherwise.
'use strict';
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const home = (p) => path.join(os.homedir(), p);
const env = { ...process.env };
if (!env.JAVA_HOME && fs.existsSync(home('Android/jdk'))) env.JAVA_HOME = home('Android/jdk');
if (!env.ANDROID_HOME && fs.existsSync(home('Android/Sdk'))) env.ANDROID_HOME = home('Android/Sdk');
// Windows: Android Studio's own Java and SDK, where it puts them.
if (process.platform === 'win32') {
  const studioJbr = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Android/Android Studio/jbr');
  const winSdk = path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk');
  if (!env.JAVA_HOME && fs.existsSync(studioJbr)) env.JAVA_HOME = studioJbr;
  if (!env.ANDROID_HOME && fs.existsSync(winSdk)) env.ANDROID_HOME = winSdk;
}
if (!fs.existsSync(path.join(root, 'node_modules/katex'))) {
  console.error('Run npm install first: the app bundles fonts and libraries from node_modules.');
  process.exit(1);
}

const gradlew = path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
// Node runs a .bat only through the shell (and refuses to otherwise, with EINVAL).
const gradleOpts = { cwd: path.join(root, 'android'), env, stdio: 'inherit' };
if (process.platform === 'win32') execSync(`"${gradlew}" -q assembleDebug`, gradleOpts);
else execFileSync(gradlew, ['-q', 'assembleDebug'], gradleOpts);
const apk = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist/glass-reader.apk');
fs.copyFileSync(apk, out);
console.log(`→ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);

if (process.argv.includes('--install')) {
  const adb = env.ANDROID_HOME ? path.join(env.ANDROID_HOME, 'platform-tools/adb') : 'adb';
  execFileSync(adb, ['install', '-r', out], { stdio: 'inherit' });
  // The quiet way (android/.../Quiet.kt): the Read button as an ordinary overlay, and the
  // accessibility service on only while a chat is read, so payment apps keep working.
  // These three can only be given from a computer.
  const sh = (...a) => execFileSync(adb, ['shell', ...a], { stdio: 'inherit' });
  const ours = 'dev.glassreader/.CaptureService';
  const now = execFileSync(adb, ['shell', 'settings', 'get', 'secure', 'enabled_accessibility_services']).toString().trim();
  const list = now && now !== 'null' ? now.split(':').filter((s) => s && s !== ours && s !== 'dev.glassreader/dev.glassreader.CaptureService') : [];
  const put = (l) => (l.length
    ? sh('settings', 'put', 'secure', 'enabled_accessibility_services', l.join(':'))
    : sh('settings', 'delete', 'secure', 'enabled_accessibility_services'));
  try {
    sh('pm', 'grant', 'dev.glassreader', 'android.permission.WRITE_SECURE_SETTINGS');
    sh('appops', 'set', 'dev.glassreader', 'SYSTEM_ALERT_WINDOW', 'allow');
    sh('appops', 'set', 'dev.glassreader', 'GET_USAGE_STATS', 'allow');
    put(list); // the service stays off until a chat is read
    sh('am', 'start', '-n', 'dev.glassreader/.ReaderActivity'); // opening the app starts the button
    console.log('Installed; the Read button is on, and Accessibility only while a chat is read.');
  } catch (e) {
    // Reinstalling turns the accessibility service off; turn it back on, keeping any other
    // accessibility services that are on.
    put([...list, ours]);
    console.log('Installed; reading from the screen is on (the quiet way could not be set up).');
  }
}
