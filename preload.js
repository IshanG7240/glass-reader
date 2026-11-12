'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  isElectron: true,
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
