// Windows: the same `window.reader` API that preload.js gives the page in Electron, over
// WebView2's message channel to windows/reader.js (through host.cs). Injected by host.cs
// before the page's own scripts run.
(() => {
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.reader) return;
  let seq = 0;
  const pending = new Map();
  const handlers = {};
  const send = (ch, args = []) => wv.postMessage({ kind: 'send', ch, args });
  const invoke = (ch, ...args) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    wv.postMessage({ kind: 'invoke', id, ch, args });
  });
  const on = (ch) => (cb) => { (handlers[ch] ||= []).push(cb); };

  // Documents arrive as a URL on the reader's local server; the page wants their bytes,
  // as Electron hands them over.
  const toDoc = async (d) => {
    if (!d || !d.url) return d || null;
    const r = await fetch(d.url);
    if (!r.ok) throw new Error(`Couldn't read ${d.name}`);
    return { name: d.name, path: d.path, size: d.size, data: new Uint8Array(await r.arrayBuffer()) };
  };
  const DOCS = new Set(['open-dialog', 'read-path']);

  // Events are handled in order, even though fetching a document takes a moment.
  let chain = Promise.resolve();
  wv.addEventListener('message', (e) => {
    const m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    chain = chain.then(async () => {
      if (m.kind === 'reply') {
        const resolve = pending.get(m.id);
        pending.delete(m.id);
        let v = m.result;
        try { if (DOCS.has(m.ch)) v = await toDoc(v); } catch { v = null; }
        resolve?.(v);
      } else if (m.kind === 'event') {
        let args = m.args || [];
        if (m.ch === 'open') {
          try { args = [await toDoc(args[0])]; } catch (err) { for (const cb of handlers.error || []) cb(String(err.message || err)); return; }
        }
        for (const cb of handlers[m.ch] || []) { try { cb(...args); } catch (err) { console.error(err); } }
      }
    });
  });

  const base = location.href.replace(/\/renderer\/.*$/, '');
  window.reader = {
    isElectron: false,
    isWindowsHost: true,
    imageBase: `${base}/__img?p=`,
    openDialog: () => invoke('open-dialog'),
    readPath: (p) => invoke('read-path', p),
    wallpaper: () => invoke('wallpaper'),
    pathForFile: () => null, // WebView2 doesn't reveal where a dropped file lives
    hide: () => send('hide'),
    quit: () => send('quit'),
    ready: () => send('ready'),
    log: (...a) => send('log', a.map(String)),
    onOpen: on('open'),
    onError: on('error'),
    onShown: on('shown'),
    onRequestOpen: on('request-open'),
    onInbox: on('inbox'),
    openInbox: () => send('open-inbox'),
    claudeSessions: () => invoke('claude-sessions'),
    openClaude: (id) => invoke('claude-open', id),
    onPicker: on('picker'),
    onFetching: on('fetching'),
    onToast: on('toast'),
    onFetchingOff: on('fetching-off'),
  };
})();
