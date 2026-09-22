/**
 * background.js  —  Manifest V3 service worker
 *
 * Solves the cross-origin referrer problem: when a user navigates from a
 * search-engine results page to a destination site, the browser strips the
 * query string from the Referer header (Referrer-Policy: strict-origin or
 * strict-origin-when-cross-origin). The destination content script therefore
 * cannot recover the original search query from document.referrer.
 *
 * Fix: this service worker watches every top-level navigation via
 * webNavigation.onCommitted. When it sees a tab commit to a known search-
 * engine SERP URL it extracts the query and stores it in
 * chrome.storage.session keyed by tabId. Content scripts ask for it via
 * the IASR_GET_QUERY message. Session storage is cleared automatically
 * when the browser session ends, so queries never persist across restarts.
 *
 * Engine coverage: Google, Bing, DuckDuckGo, Brave Search, Yahoo —
 * the same five engines already recognised by featureExtractor.js.
 */

// ---------------------------------------------------------------------------
// Query-param extraction — mirrors the logic in featureExtractor.js so the
// two files stay in sync without creating a shared module (no bundler).
// ---------------------------------------------------------------------------
const IASR_BG_QUERY_PARAM_KEYS = ['q', 'query', 'search', 'wd', 'p'];

function bgExtractQueryParam(urlString) {
  try {
    const u = new URL(urlString);
    const params = new URLSearchParams(u.search);
    for (const key of IASR_BG_QUERY_PARAM_KEYS) {
      const val = params.get(key);
      if (val) return val;
    }
  } catch (e) { /* malformed URL */ }
  return '';
}

// ---------------------------------------------------------------------------
// Search-engine SERP detection — same five patterns as featureExtractor.js.
// ---------------------------------------------------------------------------
function bgIsSearchEnginePage(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (/(^|\.)google\.[a-z.]+$/.test(host) && path === '/search') return true;
    if (/(^|\.)bing\.com$/.test(host) && path === '/search') return true;
    if (/(^|\.)duckduckgo\.com$/.test(host)) return true;
    if (/(^|\.)search\.brave\.com$/.test(host) && path === '/search') return true;
    if (/(^|\.)search\.yahoo\.com$/.test(host)) return true;
  } catch (e) { /* ignore */ }
  return false;
}

// ---------------------------------------------------------------------------
// webNavigation listener — fires for every committed top-level navigation.
// Only act when the URL is a known SERP so we don't overwrite a valid stored
// query when the user browses around on the destination site.
// ---------------------------------------------------------------------------
chrome.webNavigation.onCommitted.addListener((details) => {
  // frameId 0 = the top-level document; skip iframes.
  if (details.frameId !== 0) return;

  if (!bgIsSearchEnginePage(details.url)) return;

  const query = bgExtractQueryParam(details.url);
  if (!query) return;

  // Overwrite any previous query for this tab. The next page the user opens
  // from this SERP will pick up this fresh value.
  chrome.storage.session.set({ [`iasr_query_${details.tabId}`]: query });
});

// Clean up when a tab is closed so session storage doesn't accumulate
// entries for tabs that no longer exist.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`iasr_query_${tabId}`);
});

// ---------------------------------------------------------------------------
// Message handler — content scripts call this to retrieve the stored query
// for their own tab without needing direct storage access.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IASR_GET_QUERY') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId === null) {
      sendResponse({ queryText: '' });
      return true;
    }
    chrome.storage.session.get(`iasr_query_${tabId}`).then((stored) => {
      sendResponse({ queryText: stored[`iasr_query_${tabId}`] || '' });
    }).catch(() => sendResponse({ queryText: '' }));
    return true; // keep channel open for async response
  }
  // IASR_PROGRESS messages from content scripts are forwarded to open
  // extension pages (popup) automatically by the Chrome runtime — no
  // explicit forwarding needed here.
});
