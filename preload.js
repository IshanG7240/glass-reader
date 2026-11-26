'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Settings and notes live in files (bin/shared-store.js): into localStorage before the
// page reads it; anything only localStorage has (from before there were files) goes to them.
let dataDir = '';
try {
  const { dir, values } = ipcRenderer.sendSync('shared-load');
  dataDir = dir || '';
  for (const k of ['gr:settings', 'gr:notes', 'gr:notes-ui', 'gr:history']) {
    if (values && k in values) localStorage.setItem(k, JSON.stringify(values[k]));
    else if (localStorage.getItem(k) != null) ipcRenderer.send('persist', k, JSON.parse(localStorage.getItem(k)));
  }
} catch (err) { console.warn('settings files unavailable:', err); }

contextBridge.exposeInMainWorld('reader', {
  isElectron: true,
  dataDir,
  persist: (k, v) => ipcRenderer.send('persist', k, v),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readPath: (p) => ipcRenderer.invoke('read-path', p),
  wallpaper: () => ipcRenderer.invoke('wallpaper'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f) || null; } catch { return null; } },
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  ready: () => ipcRenderer.send('ready'),
  log: (...a) => ipcRenderer.send('log', ...a),
  onOpen: (cb) => ipcRenderer.on('open', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('error', (_e, m) => cb(m)),
  onShown: (cb) => ipcRenderer.on('shown', () => cb()),
  onRequestOpen: (cb) => ipcRenderer.on('request-open', () => cb()),
  onInbox: (cb) => ipcRenderer.on('inbox', (_e, name) => cb(name)),
  openInbox: () => ipcRenderer.send('open-inbox'),
  claudeSessions: () => ipcRenderer.invoke('claude-sessions'),
  openClaude: (id) => ipcRenderer.invoke('claude-open', id),
  onPicker: (cb) => ipcRenderer.on('picker', (_e, list) => cb(list)),
  onFetching: (cb) => ipcRenderer.on('fetching', () => cb()),
  onToast: (cb) => ipcRenderer.on('toast', (_e, msg) => cb(msg)),
  onFetchingOff: (cb) => ipcRenderer.on('fetching-off', () => cb()),
});
