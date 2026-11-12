// Glass Reader, the standalone browser extension (Chrome, Edge, Brave and other
// Chromium browsers). Needs no desktop app: its toolbar button, or Alt+Shift+R, lays
// the reader over the page you're on, with that page in it.
//
// Asks for as little as it can: "activeTab" (the tab you clicked it on, until you
// leave that page) and "scripting" (to run the reader there). Nothing is sent anywhere.
//
// scripts/build-extension.js appends the capture code (captureTab() onwards) from
// extension/browser/background.js, the desktop companion's, so both read pages alike.

chrome.action.onClicked.addListener((tab) => openIn(tab));

// Puts the reader in the tab (once per page load), then shows or hides it. The reader
// asks for the page itself (below) once it's up, showing that it's working meanwhile.
async function openIn(tab) {
  const target = { tabId: tab.id };
  try {
    const [{ result: there } = {}] = await chrome.scripting.executeScript({ target, func: () => typeof window.__glassReaderToggle === 'function' });
    if (!there) await chrome.scripting.executeScript({ target, files: ['reader.js'] });
    await chrome.scripting.executeScript({ target, func: () => window.__glassReaderToggle() });
  } catch (e) {
    // chrome:// pages, the Web Store, the PDF viewer and other extensions' pages are
    // closed to every extension.
    console.warn('Glass Reader:', e?.message || e);
    flash(tab.id, /^https?:/.test(tab.url || '') || !tab.url
      ? 'Glass Reader can’t run on this page (still loading, or the browser keeps it closed to extensions).'
      : 'Glass Reader reads web pages; this one is closed to extensions.');
  }
}

// A short "!" on the button, with the reason as its tooltip.
function flash(tabId, why) {
  chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6', tabId }).catch(() => {});
  chrome.action.setBadgeText({ text: '!', tabId }).catch(() => {});
  chrome.action.setTitle({ title: why, tabId }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: '', tabId }).catch(() => {}); // back to the default
  }, 6000);
}

// The reader in the tab asks for the page: on opening, and on C to read it again.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'capture' || !sender.tab) return false;
  const t0 = Date.now(), debug = {};
  captureTab({ ...sender.tab, url: sender.tab.url || sender.url }, debug)
    .catch((e) => ({ error: String(e?.message || e) }))
    .then((page) => {
      page = page || { error: 'Nothing to read on this tab.' };
      if (page.error && /Cannot access|permission/i.test(page.error)) page.error = 'Click the Glass Reader button again to read this page (the browser asks for that each time you change pages).';
      page.debug = { v: chrome.runtime.getManifest().version, ...debug, ms: Date.now() - t0 };
      reply(page);
    });
  return true; // answering later
});
