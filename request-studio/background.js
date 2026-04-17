// UiPath Request Studio — Background Service Worker

let isCapturing = false;
let capturedEntries = [];
let startTime = null;
let activeTabId = null;

const RESOURCE_EXTENSIONS = ['.jpg','.jpeg','.png','.gif','.css','.svg','.woff','.woff2','.ttf','.eot','.ico','.mp4','.webm','.mp3'];

// ── Restore state from storage when service worker wakes up ──
// activeTabId MUST be restored — MV3 SWs are killed after ~30s idle and
// restarted on the next event.  Without it, all debugger events are dropped.
chrome.storage.local.get(['capturedEntries', 'isCapturing', 'activeTabId'], (result) => {
  if (result.capturedEntries) capturedEntries = result.capturedEntries;
  if (result.isCapturing !== undefined) isCapturing = result.isCapturing;
  if (result.activeTabId)    activeTabId = result.activeTabId;
});

// ── Persist entries (strip response bodies to stay within 5MB quota) ──
function persist() {
  const slim = capturedEntries.map(e => ({
    requestId:       e.requestId,
    startedDateTime: e.startedDateTime,
    startTimestamp:  e.startTimestamp,
    request:         e.request,
    response:        e.response,
    responseBody:    null,
    time:            e.time
  }));
  chrome.storage.local.set({ capturedEntries: slim, isCapturing, activeTabId }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[RS] persist skipped:', chrome.runtime.lastError.message);
    }
  });
}

// ── Debugger event listener ──
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!activeTabId || source.tabId !== activeTabId) return;

  if (method === 'Network.requestWillBeSent') {
    const url = params.request.url;
    if (url.startsWith('chrome-extension://')) return;
    const lower = url.toLowerCase().split('?')[0];
    if (RESOURCE_EXTENSIONS.some(ext => lower.endsWith(ext))) return;

    capturedEntries.push({
      requestId:       params.requestId,
      startedDateTime: new Date(params.timestamp * 1000).toISOString(),
      startTimestamp:  params.timestamp,
      request: {
        method:   params.request.method,
        url:      url,
        headers:  params.request.headers,
        postData: params.request.postData || null
      },
      response:     null,
      responseBody: null,
      time:         null
    });
    persist();

  } else if (method === 'Network.responseReceived') {
    const entry = capturedEntries.find(e => e.requestId === params.requestId);
    if (entry) {
      entry.response = {
        status:     params.response.status,
        statusText: params.response.statusText,
        headers:    params.response.headers,
        mimeType:   params.response.mimeType
      };
      persist();
    }

  } else if (method === 'Network.loadingFinished') {
    const entry = capturedEntries.find(e => e.requestId === params.requestId);
    if (entry) {
      if (entry.startTimestamp) {
        entry.time = Math.round((params.timestamp - entry.startTimestamp) * 1000);
      }
      if (activeTabId && entry.response) {
        chrome.debugger.sendCommand({ tabId: activeTabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then(r => { entry.responseBody = r.body || null; persist(); })
          .catch(() => persist());
      } else {
        persist();
      }
    }
  }
});

// ── Message handlers ──
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'startCapture') {
    startCapture(request.tabId).then(result => sendResponse(result));
    return true;

  } else if (request.action === 'stopCapture') {
    stopCapture().then(() => sendResponse({ status: 'stopped' }));
    return true;

  } else if (request.action === 'getStatus') {
    sendResponse({ isCapturing, entryCount: capturedEntries.length });

  } else if (request.action === 'getEntries') {
    sendResponse({ entries: capturedEntries });

  } else if (request.action === 'importEntry') {
    capturedEntries.push(request.entry);
    persist();
    sendResponse({ status: 'imported', total: capturedEntries.length });

  } else if (request.action === 'deleteEntries') {
    const ids = new Set(request.requestIds || []);
    capturedEntries = capturedEntries.filter(e => !ids.has(e.requestId));
    persist();
    sendResponse({ status: 'deleted', remaining: capturedEntries.length });

  } else if (request.action === 'clearCapture') {
    capturedEntries = [];
    chrome.storage.local.remove(['capturedEntries', 'isCapturing', 'activeTabId']);
    sendResponse({ status: 'cleared' });

  } else if (request.action === 'exportHAR') {
    const har = buildHAR();
    sendResponse({ status: 'ok', har });

  } else if (request.action === 'executeRequest') {
    // Proxy the request through the SW to avoid CORS issues from extension pages
    doFetch(request).then(result => sendResponse(result));
    return true;
  }

  return true;
});

// ── Start / Stop capture ──
async function startCapture(requestedTabId) {
  if (activeTabId) {
    try { await chrome.debugger.detach({ tabId: activeTabId }); } catch (e) {}
    activeTabId = null;
  }

  capturedEntries = [];
  startTime = Date.now();
  isCapturing = true;

  let tabId = requestedTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const realTab = tabs.find(t => t.url && !t.url.startsWith('chrome'));
    tabId = realTab ? realTab.id : tabs[0]?.id;
  }

  if (!tabId) { isCapturing = false; return { status: 'error', message: 'No suitable tab found' }; }
  activeTabId = tabId;

  try {
    await chrome.debugger.attach({ tabId: activeTabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId: activeTabId }, 'Network.enable');
    persist();
    return { status: 'started' };
  } catch (err) {
    const msg = err.message || String(err);
    isCapturing = false;
    activeTabId = null;
    persist();
    if (msg.includes('Another debugger')) {
      return { status: 'error', message: 'DevTools is open on that tab. Close DevTools and try again.' };
    }
    return { status: 'error', message: msg };
  }
}

async function stopCapture() {
  isCapturing = false;
  if (activeTabId) {
    try { await chrome.debugger.detach({ tabId: activeTabId }); } catch (e) {}
    activeTabId = null;
  }
  chrome.storage.local.remove('activeTabId');
  persist();
}

// ── Request executor (proxy fetch from SW context) ──
async function doFetch({ method, url, headers, body }) {
  const start = Date.now();
  try {
    const opts = { method: method || 'GET', headers: {} };

    // Copy provided headers, skip empty keys
    if (headers && typeof headers === 'object') {
      Object.entries(headers).forEach(([k, v]) => {
        if (k && k.trim()) opts.headers[k.trim()] = v;
      });
    }

    // Attach body for non-GET methods
    if (body && !['GET', 'HEAD'].includes((method || '').toUpperCase())) {
      opts.body = body;
    }

    const res = await fetch(url, opts);
    const elapsed = Date.now() - start;

    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    let resBody = '';
    try { resBody = await res.text(); } catch (e) {}

    return {
      ok:         true,
      status:     res.status,
      statusText: res.statusText,
      headers:    resHeaders,
      body:       resBody,
      time:       elapsed
    };
  } catch (err) {
    return { ok: false, error: err.message, fetchFailed: true, time: Date.now() - start };
  }
}

// ── HAR builder ──
function buildHAR() {
  return {
    log: {
      version: '1.2',
      creator: { name: 'UiPath Request Studio', version: '1.0' },
      pages: [{
        startedDateTime: new Date(startTime || Date.now()).toISOString(),
        id: 'page_1', title: 'Captured Traffic', pageTimings: {}
      }],
      entries: capturedEntries.map(e => ({
        startedDateTime: e.startedDateTime,
        time: e.time || 0,
        request: {
          method: e.request.method, url: e.request.url, httpVersion: 'HTTP/1.1',
          headers: Object.entries(e.request.headers || {}).map(([name, value]) => ({ name, value })),
          queryString: [], cookies: [], headersSize: -1,
          bodySize: e.request.postData ? e.request.postData.length : 0,
          ...(e.request.postData ? { postData: { mimeType: 'application/json', text: e.request.postData } } : {})
        },
        response: {
          status: e.response ? e.response.status : 0,
          statusText: e.response ? e.response.statusText : '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(e.response ? e.response.headers : {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            size: e.responseBody ? e.responseBody.length : 0,
            mimeType: e.response ? e.response.mimeType : 'text/plain',
            text: e.responseBody || ''
          },
          redirectURL: '', headersSize: -1, bodySize: -1
        },
        cache: {},
        timings: { send: 0, wait: e.time || 0, receive: 0 },
        pageref: 'page_1'
      }))
    }
  };
}
