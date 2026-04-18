/**
 * chrome-extension/background.js
 *
 * Service worker background script for the SAP Fiori HTTP Recorder.
 *
 * Uses the Chrome DevTools Protocol (chrome.debugger, Network domain) to capture
 * full HTTP request and response data — including bodies — for every network call
 * made on the debugged tab.
 *
 * Recording model:
 *   - One "session" covers the entire recording.
 *   - Within a session the user defines "functional blocks" (e.g. "Login",
 *     "Create Purchase Order"). Every captured entry is tagged with the current
 *     block name via the `_functionalBlock` extension field.
 *   - Multiple blocks may be recorded sequentially without losing data; the user
 *     calls NEW_BLOCK to switch, not stop/start.
 *
 * Message API (popup → background):
 *   GET_STATE             → { recording, currentBlock, entryCount, blocks[] }
 *   START_RECORDING       { blockName }  → { success, error? }
 *   STOP_RECORDING        → { success, error? }
 *   NEW_BLOCK             { blockName }  → { success }
 *   GET_ENTRIES           { filters? }   → { entries[], blocks[] }
 *   EXPORT_HAR            { filters? }   → { har: string }
 *   CLEAR_ALL             → { success }
 */

// ── In-memory state ───────────────────────────────────────────────────────────

/**
 * Requests that have been sent but whose response body has not yet been received.
 * Keyed by CDP requestId. Cleared on each entry completion.
 * @type {Map<string, object>}
 */
const pending = new Map();

/**
 * Runtime recording state. Kept in memory for speed; persisted to storage
 * after each change so the popup and future SW activations can read it.
 */
let recording    = false;
let currentBlock = 'Block 1';
let debuggedTabId = null;

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY_STATE   = 'recorder_state';
const STORAGE_KEY_ENTRIES = 'recorder_entries';

async function saveRecordingState() {
  await chrome.storage.local.set({
    [STORAGE_KEY_STATE]: { recording, currentBlock, debuggedTabId },
  });
}

async function appendEntry(entry) {
  const { [STORAGE_KEY_ENTRIES]: existing = [] } =
    await chrome.storage.local.get(STORAGE_KEY_ENTRIES);
  entry._entryIndex = existing.length;
  existing.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY_ENTRIES]: existing });
}

async function loadEntries() {
  const { [STORAGE_KEY_ENTRIES]: entries = [] } =
    await chrome.storage.local.get(STORAGE_KEY_ENTRIES);
  return entries;
}

async function clearEntries() {
  await chrome.storage.local.remove(STORAGE_KEY_ENTRIES);
}

// Restore state on service worker startup (after being killed by Chrome)
async function restoreState() {
  const { [STORAGE_KEY_STATE]: saved } =
    await chrome.storage.local.get(STORAGE_KEY_STATE);
  if (!saved) return;

  recording    = saved.recording    ?? false;
  currentBlock = saved.currentBlock ?? 'Block 1';
  debuggedTabId = saved.debuggedTabId ?? null;

  // If we were recording when the SW was killed, the debugger may have detached.
  // Reset to a safe state — the user will need to start a new recording.
  if (recording && debuggedTabId) {
    recording     = false;
    debuggedTabId = null;
    await saveRecordingState();
  }
}

restoreState();

// ── Keep-alive alarm ─────────────────────────────────────────────────────────
// MV3 service workers are killed after ~30 s of inactivity.
// While recording, we reschedule a periodic alarm to stay alive.

const KEEPALIVE_ALARM = 'recorder_keepalive';

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && recording) {
    chrome.alarms.create(KEEPALIVE_ALARM, { delayInMinutes: 0.4 });
  }
});

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { delayInMinutes: 0.4 });
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ── CDP Network event handlers ────────────────────────────────────────────────

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (source.tabId !== debuggedTabId || !recording) return;

  switch (method) {
    case 'Network.requestWillBeSent':
      onRequestWillBeSent(params);
      break;
    case 'Network.responseReceived':
      onResponseReceived(params);
      break;
    case 'Network.loadingFinished':
      await onLoadingFinished(params);
      break;
    case 'Network.loadingFailed':
      await onLoadingFailed(params);
      break;
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  if (source.tabId === debuggedTabId) {
    recording     = false;
    debuggedTabId = null;
    pending.clear();
    stopKeepalive();
    await saveRecordingState();
  }
});

/**
 * A new request has been sent.  Create a pending entry for it.
 */
function onRequestWillBeSent({ requestId, request, timestamp, redirectResponse }) {
  const url = request.url;
  // Skip non-HTTP (chrome-extension:, data:, blob:, …)
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // If this is a redirect, finalise the previous entry for the same requestId
  if (redirectResponse && pending.has(requestId)) {
    finalizeWithResponse(requestId, redirectResponse, timestamp, null);
  }

  pending.set(requestId, {
    _functionalBlock: currentBlock,
    _startMs: timestamp * 1000,
    request: {
      method:      request.method,
      url,
      httpVersion: 'HTTP/1.1',
      headers:     objectToHarHeaders(request.headers),
      queryString: parseQueryString(url),
      postData:    request.postData
        ? { mimeType: request.headers['Content-Type'] ?? '', text: request.postData }
        : undefined,
      cookies:     [],
      headersSize: -1,
      bodySize:    request.postData ? request.postData.length : -1,
    },
    response: null,
  });
}

/**
 * Response headers have been received.
 */
function onResponseReceived({ requestId, response }) {
  const entry = pending.get(requestId);
  if (!entry) return;

  entry.response = {
    status:      response.status,
    statusText:  response.statusText,
    httpVersion: 'HTTP/1.1',
    headers:     objectToHarHeaders(response.headers),
    cookies:     [],
    content: {
      size:     response.encodedDataLength ?? 0,
      mimeType: response.mimeType ?? 'application/octet-stream',
      text:     '',
    },
    redirectURL: response.headers?.Location ?? '',
    headersSize: -1,
    bodySize:    -1,
  };
}

/**
 * The response body has finished loading — fetch the body and save the entry.
 */
async function onLoadingFinished({ requestId, timestamp }) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);

  entry.time            = Math.round(timestamp * 1000 - entry._startMs);
  entry.startedDateTime = new Date(entry._startMs).toISOString();

  if (!entry.response) {
    // No response received (e.g. request cancelled before any headers)
    entry.response = emptyErrorResponse('No response received');
  }

  // Try to retrieve the response body from the CDP buffer
  try {
    const body = await chrome.debugger.sendCommand(
      { tabId: debuggedTabId },
      'Network.getResponseBody',
      { requestId }
    );
    if (body?.body) {
      entry.response.content.text = body.base64Encoded
        ? decodeBase64Safe(body.body)
        : body.body;
      entry.response.content.size = entry.response.content.text.length;
    }
  } catch {
    // Body unavailable: redirect, binary, or buffer evicted — leave text: ''
  }

  await appendEntry(toHarEntry(entry));
}

/**
 * The request failed at network level.
 */
async function onLoadingFailed({ requestId, timestamp, errorText, canceled }) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);

  entry.time            = Math.round(timestamp * 1000 - entry._startMs);
  entry.startedDateTime = new Date(entry._startMs).toISOString();

  if (!entry.response) {
    entry.response = emptyErrorResponse(canceled ? 'Canceled' : (errorText ?? 'Network error'));
  }

  await appendEntry(toHarEntry(entry));
}

/**
 * Finalise a redirect entry immediately (before the new request is stored).
 */
function finalizeWithResponse(requestId, response, timestamp, bodyText) {
  const entry = pending.get(requestId);
  if (!entry) return;

  entry.time            = Math.round(timestamp * 1000 - entry._startMs);
  entry.startedDateTime = new Date(entry._startMs).toISOString();
  entry.response = {
    status:      response.status,
    statusText:  response.statusText,
    httpVersion: 'HTTP/1.1',
    headers:     objectToHarHeaders(response.headers),
    cookies:     [],
    content:     { size: 0, mimeType: '', text: bodyText ?? '' },
    redirectURL: response.headers?.Location ?? '',
    headersSize: -1,
    bodySize:    -1,
  };

  // Persist async without awaiting — redirect entries are low-priority
  appendEntry(toHarEntry(entry));
  pending.delete(requestId);
}

// ── Recording control ────────────────────────────────────────────────────────

async function startRecording(blockName, reloadTab = false) {
  if (recording) return { success: false, error: 'Already recording. Stop the current session first.' };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) return { success: false, error: 'No active tab found. Open a browser tab and try again.' };

  const tabId = tabs[0].id;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    return { success: false, error: `Could not attach debugger: ${err.message}. Is DevTools already open on this tab?` };
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize:    100 * 1024 * 1024,  // 100 MB
      maxResourceBufferSize:  50 * 1024 * 1024,  //  50 MB
    });
  } catch (err) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return { success: false, error: `Could not enable Network domain: ${err.message}` };
  }

  recording      = true;
  currentBlock   = (blockName?.trim()) || 'Block 1';
  debuggedTabId  = tabId;
  pending.clear();

  await saveRecordingState();
  startKeepalive();

  // Reload the tab so the full page-load traffic is captured from the very first request
  if (reloadTab) {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});
    await chrome.tabs.reload(tabId);
  }

  return { success: true };
}

async function stopRecording() {
  if (!recording) return { success: false, error: 'Not currently recording.' };

  try {
    await chrome.debugger.detach({ tabId: debuggedTabId });
  } catch {
    // Tab may have been closed — ignore detach errors
  }

  recording     = false;
  debuggedTabId = null;
  pending.clear();
  stopKeepalive();

  await saveRecordingState();
  return { success: true };
}

function switchBlock(blockName) {
  if (!recording) return { success: false, error: 'Not currently recording.' };
  const name = blockName?.trim();
  if (!name) return { success: false, error: 'Block name cannot be empty.' };
  currentBlock = name;
  return { success: true };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  dispatch(message)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // keep channel open for async response
});

async function dispatch(msg) {
  switch (msg.type) {

    case 'GET_STATE': {
      const entries = await loadEntries();
      return {
        recording,
        currentBlock,
        entryCount: entries.length,
        blocks:     blockSummary(entries),
      };
    }

    case 'START_RECORDING':
      return startRecording(msg.blockName, msg.reload ?? false);

    case 'STOP_RECORDING':
      return stopRecording();

    case 'NEW_BLOCK':
      return switchBlock(msg.blockName);

    case 'GET_ENTRIES': {
      const entries  = await loadEntries();
      const filtered = msg.filters ? applyFilters(entries, msg.filters) : entries;
      return { entries: filtered, blocks: blockSummary(entries) };
    }

    // Returns the most recent N entries (newest first) for the live feed
    case 'GET_RECENT_ENTRIES': {
      const entries  = await loadEntries();
      const filtered = msg.filters ? applyFilters(entries, msg.filters) : entries;
      const limit    = msg.limit ?? 100;
      return {
        entries: filtered.slice(-limit).reverse(),
        total:   filtered.length,
        blocks:  blockSummary(entries),
      };
    }

    case 'EXPORT_HAR': {
      const entries = await loadEntries();
      return { har: buildHar(entries, msg.filters ?? null) };
    }

    case 'CLEAR_ALL':
      pending.clear();
      await clearEntries();
      return { success: true };

    default:
      return { success: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ── HAR assembly ─────────────────────────────────────────────────────────────

function toHarEntry(raw) {
  return {
    _functionalBlock: raw._functionalBlock,
    _entryIndex:      raw._entryIndex ?? -1,
    startedDateTime:  raw.startedDateTime,
    time:             raw.time ?? 0,
    request:          raw.request,
    response:         raw.response,
    timings:          { send: 0, wait: raw.time ?? 0, receive: 0 },
    cache:            {},
  };
}

function buildHar(entries, filters) {
  const out = filters ? applyFilters(entries, filters) : entries;
  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'SAP Fiori HTTP Recorder', version: '0.2.0' },
      pages:   buildPages(entries),
      entries: out,
    },
  }, null, 2);
}

function buildPages(entries) {
  const seen = new Set();
  return entries
    .filter(e => { const b = e._functionalBlock; if (!b || seen.has(b)) return false; seen.add(b); return true; })
    .map((e, i) => ({
      id:               `page_${i + 1}`,
      startedDateTime:  e.startedDateTime,
      title:            e._functionalBlock,
      pageTimings:      {},
    }));
}

// ── Filtering ─────────────────────────────────────────────────────────────────

const STATUS_RANGES = {
  '2xx': { min: 200, max: 299 },
  '3xx': { min: 300, max: 399 },
  '4xx': { min: 400, max: 499 },
  '5xx': { min: 500, max: 599 },
  '0xx': { min: 0,   max:   0 },  // network errors
};

function applyFilters(entries, filters) {
  let out = entries;

  if (filters.urlPattern) {
    const rx = patternToRegex(filters.urlPattern);
    out = out.filter(e => rx.test(e.request?.url ?? ''));
  }

  if (filters.statusRanges?.length > 0) {
    out = out.filter(e => {
      const s = e.response?.status ?? 0;
      return filters.statusRanges.some(r => s >= r.min && s <= r.max);
    });
  }

  if (filters.blocks?.length > 0) {
    const set = new Set(filters.blocks);
    out = out.filter(e => set.has(e._functionalBlock));
  }

  return out;
}

// ── Summary ──────────────────────────────────────────────────────────────────

function blockSummary(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e._functionalBlock ?? '(unassigned)';
    if (!map.has(key)) map.set(key, { block: key, requestCount: 0, totalMs: 0, avgMs: 0, successCount: 0, failCount: 0 });
    const s = map.get(key);
    s.requestCount++;
    s.totalMs += e.time ?? 0;
    s.avgMs    = Math.round(s.totalMs / s.requestCount);
    const status = e.response?.status ?? 0;
    if (status >= 200 && status < 400) s.successCount++; else s.failCount++;
  }
  return [...map.values()];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function objectToHarHeaders(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

function parseQueryString(url) {
  try {
    const params = [];
    new URL(url).searchParams.forEach((value, name) => params.push({ name, value }));
    return params;
  } catch { return []; }
}

function decodeBase64Safe(b64) {
  try { return atob(b64); } catch { return b64; }
}

function emptyErrorResponse(statusText) {
  return {
    status: 0, statusText,
    httpVersion: 'HTTP/1.1',
    headers: [], cookies: [],
    content: { size: 0, mimeType: 'text/plain', text: statusText },
    redirectURL: '', headersSize: -1, bodySize: -1,
  };
}

function patternToRegex(pattern) {
  if (!pattern) return /.*/;
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last  = pattern.lastIndexOf('/');
    const body  = pattern.slice(1, last);
    const flags = pattern.slice(last + 1);
    try { return new RegExp(body, flags); } catch { /* fall through */ }
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// ── Side Panel ────────────────────────────────────────────────────────────────

// Make the extension icon click open the side panel directly (Chrome 114+)
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Older Chrome without sidePanel API — silently ignore
  });
});
