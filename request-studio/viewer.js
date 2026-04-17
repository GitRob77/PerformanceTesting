// UiPath Request Studio — Viewer Script

// ── Dark theme (init before paint) ──
(function () {
  const saved = localStorage.getItem('rs-theme');
  if (saved === 'dark') document.body.classList.add('dark');
})();

// ── State ──
let allEntries    = [];   // full captured list
let filteredIds   = [];   // currently visible (requestId order)
let selectedId    = null; // currently selected requestId
let isCapturing   = false;

// Editor working state
let editorParams  = [];   // [{key, value, enabled}]
let editorHeaders = [];   // [{key, value, enabled}]

// Response raw data (for switching body/headers tabs)
let lastResponse  = null; // { status, statusText, headers, body, time }
let resActiveTab  = 'body';

// ── DOM refs ──
const el = id => document.getElementById(id);

const searchInput   = el('searchInput');
const methodFilter  = el('methodFilter');
const requestList   = el('requestList');
const listEmpty     = el('listEmpty');
const sidebarCount  = el('sidebarCount');
const noSelection   = el('noSelection');
const editorContent = el('editorContent');
const methodSelect  = el('methodSelect');
const urlInput      = el('urlInput');
const btnSend       = el('btnSend');
const paramsEditor  = el('paramsEditor');
const headersEditor = el('headersEditor');
const bodyTextarea  = el('bodyTextarea');
const bodyTypeSelect = el('bodyTypeSelect');
const btnFormatBody = el('btnFormatBody');
const responseBody  = el('responseBody');
const resStatusBadge = el('resStatusBadge');
const resTime       = el('resTime');
const resSize       = el('resSize');
const bottomInfo    = el('bottomInfo');
const captureDot    = el('captureDot');
const captureLabel  = el('captureLabel');
const btnCaptureStart = el('btnCaptureStart');
const btnCaptureStop  = el('btnCaptureStop');
const paramsCount   = el('paramsCount');
const headersCount  = el('headersCount');

// ── Utilities ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusClass(code) {
  if (!code) return 'status-0';
  if (code < 300) return 'status-2xx';
  if (code < 400) return 'status-3xx';
  if (code < 500) return 'status-4xx';
  return 'status-5xx';
}

function methodClass(m) {
  const map = { GET: 'method-GET', POST: 'method-POST', PUT: 'method-PUT', DELETE: 'method-DELETE', PATCH: 'method-PATCH' };
  return map[m] || 'method-OTHER';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function getPath(url) {
  try { const u = new URL(url); return u.pathname; } catch { return url; }
}

// ── JSON syntax highlighter ──
function highlightJSON(str) {
  try {
    const parsed = JSON.parse(str);
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${escHtml(match)}</span>`;
        return `<span class="json-string">${escHtml(match)}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match))       return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    });
  } catch {
    return escHtml(str);
  }
}

// ── Load entries from background ──
async function loadEntries() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getEntries' });
    allEntries = res.entries || [];
  } catch {
    allEntries = [];
  }
  renderList();
  updateBottomInfo();
}

// ── Render request list ──
function renderList() {
  const search = searchInput.value.toLowerCase();
  const mf     = methodFilter.value;

  const visible = allEntries.filter(e => {
    if (mf && e.request.method !== mf) return false;
    if (search) {
      const url = (e.request.url || '').toLowerCase();
      const method = (e.request.method || '').toLowerCase();
      if (!url.includes(search) && !method.includes(search)) return false;
    }
    return true;
  });

  filteredIds = visible.map(e => e.requestId);

  if (visible.length === 0) {
    requestList.innerHTML = '';
    listEmpty.classList.remove('hidden');
    sidebarCount.textContent = allEntries.length === 0
      ? '0 requests'
      : `0 of ${allEntries.length} requests match`;
    return;
  }

  listEmpty.classList.add('hidden');
  sidebarCount.textContent = `${visible.length} request${visible.length !== 1 ? 's' : ''}${allEntries.length !== visible.length ? ` (of ${allEntries.length})` : ''}`;

  requestList.innerHTML = visible.map(e => {
    const selected = e.requestId === selectedId ? ' selected' : '';
    const mClass   = methodClass(e.request.method);
    const status   = e.response ? e.response.status : null;
    const sClass   = statusClass(status);
    const domain   = getDomain(e.request.url);
    const path     = getPath(e.request.url);
    const time     = e.time != null ? `${e.time}ms` : '—';

    return `<div class="req-item${selected}" data-id="${escHtml(e.requestId)}">
      <div class="req-item-top">
        <span class="method-badge ${mClass}">${escHtml(e.request.method)}</span>
        <span class="req-url" title="${escHtml(e.request.url)}">${escHtml(path)}</span>
      </div>
      <div class="req-meta">
        ${status ? `<span class="status-badge ${sClass}">${status}</span>` : '<span class="status-badge status-0">pending</span>'}
        <span class="req-time">${time}</span>
        <span class="req-domain" title="${escHtml(e.request.url)}">${escHtml(domain)}</span>
      </div>
    </div>`;
  }).join('');

  // Re-attach click listeners
  requestList.querySelectorAll('.req-item').forEach(item => {
    item.addEventListener('click', () => selectEntry(item.dataset.id));
  });
}

// ── Select an entry ──
function selectEntry(requestId) {
  selectedId = requestId;
  const entry = allEntries.find(e => e.requestId === requestId);
  if (!entry) return;

  // Re-render list to update selection highlight
  renderList();

  // Show editor
  noSelection.classList.add('hidden');
  editorContent.classList.remove('hidden');
  editorContent.style.display = 'flex';

  // Populate URL and method
  methodSelect.value = entry.request.method || 'GET';
  urlInput.value     = entry.request.url || '';

  // Parse params from URL
  editorParams = [];
  try {
    const u = new URL(entry.request.url);
    u.searchParams.forEach((v, k) => {
      editorParams.push({ key: k, value: v, enabled: true });
    });
  } catch {}

  // Populate headers (filter out common noise headers the user doesn't usually need to edit)
  const skipHeaders = new Set(['host', 'content-length', 'connection', 'accept-encoding', ':method', ':path', ':scheme', ':authority']);
  editorHeaders = [];
  if (entry.request.headers) {
    Object.entries(entry.request.headers).forEach(([k, v]) => {
      if (!skipHeaders.has(k.toLowerCase())) {
        editorHeaders.push({ key: k, value: v, enabled: true });
      }
    });
  }

  // Populate body — only pretty-print if it's actually valid JSON;
  // for form-encoded / XML / raw data, use the string as-is (no JSON.stringify wrapping)
  if (entry.request.postData) {
    const parsed = tryParseJSON(entry.request.postData);
    if (parsed !== null) {
      bodyTextarea.value = JSON.stringify(parsed, null, 2);
      bodyTypeSelect.value = 'json';
    } else if (entry.request.postData.includes('=') && !entry.request.postData.trimStart().startsWith('<')) {
      bodyTextarea.value = entry.request.postData;
      bodyTypeSelect.value = 'form';
    } else if (entry.request.postData.trimStart().startsWith('<')) {
      bodyTextarea.value = entry.request.postData;
      bodyTypeSelect.value = 'xml';
    } else {
      bodyTextarea.value = entry.request.postData;
      bodyTypeSelect.value = 'raw';
    }
  } else {
    bodyTextarea.value = '';
    bodyTypeSelect.value = 'raw';
  }

  // Reset response area
  lastResponse = null;
  resStatusBadge.textContent = '';
  resStatusBadge.className = 'response-status-badge';
  resTime.textContent = '';
  resSize.textContent = '';
  responseBody.className = 'response-body empty';
  responseBody.innerHTML = 'Hit <strong>Send</strong> to see the response.';

  renderParamsEditor();
  renderHeadersEditor();
  updateTabBadges();

  // Auto-switch to appropriate tab
  if (entry.request.postData) activateReqTab('body');
  else activateReqTab('params');
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ── KV editor rendering ──
function renderKVEditor(container, rows, onUpdate) {
  container.innerHTML = '';

  rows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'kv-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'kv-check';
    check.checked = row.enabled !== false;
    check.addEventListener('change', () => { rows[i].enabled = check.checked; onUpdate(); });

    const keyIn = document.createElement('input');
    keyIn.type = 'text';
    keyIn.className = 'kv-key';
    keyIn.placeholder = 'Key';
    keyIn.value = row.key || '';
    keyIn.addEventListener('input', () => { rows[i].key = keyIn.value; onUpdate(); });

    const valIn = document.createElement('input');
    valIn.type = 'text';
    valIn.className = 'kv-val';
    valIn.placeholder = 'Value';
    valIn.value = row.value || '';
    valIn.addEventListener('input', () => { rows[i].value = valIn.value; onUpdate(); });

    const del = document.createElement('button');
    del.className = 'kv-del';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', () => { rows.splice(i, 1); renderKVEditor(container, rows, onUpdate); onUpdate(); });

    div.append(check, keyIn, valIn, del);
    container.appendChild(div);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'kv-add-btn';
  addBtn.textContent = '+ Add row';
  addBtn.addEventListener('click', () => {
    rows.push({ key: '', value: '', enabled: true });
    renderKVEditor(container, rows, onUpdate);
    // Focus the new key input
    const inputs = container.querySelectorAll('.kv-key');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  container.appendChild(addBtn);
}

function renderParamsEditor() {
  renderKVEditor(paramsEditor, editorParams, syncParamsToURL);
}

function renderHeadersEditor() {
  renderKVEditor(headersEditor, editorHeaders, () => updateTabBadges());
}

// ── Sync params → URL ──
function syncParamsToURL() {
  updateTabBadges();
  try {
    const u = new URL(urlInput.value);
    u.search = '';
    editorParams.filter(p => p.enabled && p.key).forEach(p => {
      u.searchParams.append(p.key, p.value);
    });
    urlInput.value = u.toString();
  } catch {
    // Invalid URL — leave as is
  }
}

// ── URL change → sync params ──
urlInput.addEventListener('change', () => {
  // Re-parse params from updated URL
  editorParams = [];
  try {
    const u = new URL(urlInput.value);
    u.searchParams.forEach((v, k) => {
      editorParams.push({ key: k, value: v, enabled: true });
    });
  } catch {}
  renderParamsEditor();
  updateTabBadges();
});

function updateTabBadges() {
  const pc = editorParams.filter(p => p.enabled && p.key).length;
  const hc = editorHeaders.filter(h => h.enabled && h.key).length;
  paramsCount.textContent  = pc;
  headersCount.textContent = hc;
}

// ── Request tab switching ──
function activateReqTab(name) {
  document.querySelectorAll('#reqTabBar .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('#reqTabPanels .tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${name}`);
  });
}

document.querySelectorAll('#reqTabBar .tab').forEach(tab => {
  tab.addEventListener('click', () => activateReqTab(tab.dataset.tab));
});

// ── Response tab switching ──
document.querySelectorAll('.res-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    resActiveTab = tab.dataset.resTab;
    document.querySelectorAll('.res-tab').forEach(t => t.classList.toggle('active', t.dataset.resTab === resActiveTab));
    renderResponseTab();
  });
});

function renderResponseTab() {
  if (!lastResponse) return;
  if (resActiveTab === 'body') {
    const body = lastResponse.body || '';
    if (!body) {
      responseBody.className = 'response-body empty';
      responseBody.textContent = '(empty body)';
      return;
    }
    const ct = (lastResponse.headers['content-type'] || '').toLowerCase();
    if (ct.includes('json') || (body.trimStart().startsWith('{') || body.trimStart().startsWith('['))) {
      responseBody.className = 'response-body';
      responseBody.innerHTML = highlightJSON(body);
    } else {
      responseBody.className = 'response-body';
      responseBody.textContent = body;
    }
  } else {
    // Headers
    const lines = Object.entries(lastResponse.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    responseBody.className = 'response-body';
    responseBody.textContent = lines || '(no headers)';
  }
}

// ── Format body button ──
btnFormatBody.addEventListener('click', () => {
  const raw = bodyTextarea.value.trim();
  if (!raw) return;
  if (bodyTypeSelect.value === 'json' || raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = tryParseJSON(raw);
    if (parsed !== null) bodyTextarea.value = JSON.stringify(parsed, null, 2);
  }
});

// ── Send request ──
btnSend.addEventListener('click', sendRequest);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendRequest(); });

async function sendRequest() {
  const url = urlInput.value.trim();
  if (!url) { urlInput.focus(); return; }

  btnSend.disabled = true;
  btnSend.textContent = '…';

  // Build headers — skip forbidden fetch headers that the browser sets automatically
  const FORBIDDEN = new Set([
    'host', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'upgrade', 'te', 'trailer',
    ':method', ':path', ':scheme', ':authority'
  ]);
  const headers = {};
  editorHeaders.forEach(h => {
    const k = (h.key || '').trim();
    if (h.enabled && k && !FORBIDDEN.has(k.toLowerCase())) {
      headers[k] = h.value;
    }
  });

  // Auto content-type when not already set
  const body = bodyTextarea.value.trim() || null;
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    if (bodyTypeSelect.value === 'json' || (body.startsWith('{') || body.startsWith('['))) {
      headers['Content-Type'] = 'application/json';
    } else if (bodyTypeSelect.value === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  const method = methodSelect.value;
  const start  = Date.now();

  try {
    // Fetch directly from the extension page rather than via the service worker.
    // Extension pages with host_permissions bypass CORS and share the browser's
    // certificate trust store (including any "Proceed anyway" overrides the user
    // accepted for internal HTTPS servers like SAP).
    const opts = { method, headers };
    if (body && !['GET', 'HEAD'].includes(method)) opts.body = body;

    const res     = await fetch(url, opts);
    const elapsed = Date.now() - start;

    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    let resBody = '';
    try { resBody = await res.text(); } catch (_) {}

    lastResponse = {
      status:     res.status,
      statusText: res.statusText,
      headers:    resHeaders,
      body:       resBody,
      time:       elapsed
    };

    const sClass = statusClass(res.status);
    resStatusBadge.className = `response-status-badge status-badge ${sClass}`;
    resStatusBadge.textContent = `${res.status} ${res.statusText}`;
    resTime.textContent  = `${elapsed}ms`;
    resSize.textContent  = resBody ? formatBytes(resBody.length) : '';
    renderResponseTab();

  } catch (err) {
    // Provide a more actionable error message
    let msg = err.message || 'Request failed';
    if (msg.toLowerCase().includes('failed to fetch')) {
      msg = 'Failed to fetch — possible causes:\n'
          + '• Self-signed / untrusted certificate: open the URL in a browser tab first and accept the cert warning\n'
          + '• Server is unreachable from this machine\n'
          + '• Network / firewall is blocking the request';
    }
    showResponseError(msg);
  }

  btnSend.disabled = false;
  btnSend.textContent = 'Send';
}

function showResponseError(msg) {
  lastResponse = null;
  resStatusBadge.className = 'response-status-badge status-badge status-4xx';
  resStatusBadge.textContent = 'Error';
  resTime.textContent = '';
  resSize.textContent = '';
  responseBody.className = 'response-body empty';
  responseBody.textContent = msg || 'Request failed';
}

// ── Capture controls ──
btnCaptureStart.addEventListener('click', async () => {
  try {
    // The viewer itself is a chrome-extension:// tab, so "active tab" is always us.
    // Strategy: prefer the most-recently-accessed non-chrome tab across all windows.
    let tabId = null;
    const allTabs  = await chrome.tabs.query({});
    const realTabs = allTabs.filter(t => t.url && !t.url.startsWith('chrome'));
    if (realTabs.length > 0) {
      // Sort by lastAccessed desc — grab the most recently used real page
      realTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tabId = realTabs[0].id;
    } else {
      // Absolute fallback: whatever the active tab is
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = activeTabs[0]?.id;
    }
    const res = await chrome.runtime.sendMessage({ action: 'startCapture', tabId });
    if (res && res.status === 'error') {
      alert('Could not start capture:\n' + res.message);
    } else {
      setCapturing(true);
    }
  } catch (err) {
    alert('Failed to start capture.');
  }
});

btnCaptureStop.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ action: 'stopCapture' });
    setCapturing(false);
    loadEntries();
  } catch (err) {}
});

el('btnClear').addEventListener('click', async () => {
  if (confirm('Clear all captured requests?')) {
    await chrome.runtime.sendMessage({ action: 'clearCapture' });
    allEntries = [];
    selectedId = null;
    renderList();
    updateBottomInfo();
    noSelection.classList.remove('hidden');
    editorContent.classList.add('hidden');
  }
});

function setCapturing(on) {
  isCapturing = on;
  captureDot.classList.toggle('active', on);
  captureLabel.textContent = on ? 'Capturing…' : 'Not capturing';
  btnCaptureStart.classList.toggle('hidden', on);
  btnCaptureStop.classList.toggle('hidden', !on);
  if (on) {
    // Poll for new entries while capturing
    startPolling();
  } else {
    stopPolling();
  }
}

// ── Polling while capturing ──
let pollInterval = null;
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    if (!isCapturing) { stopPolling(); return; }
    const res = await chrome.runtime.sendMessage({ action: 'getEntries' });
    const newEntries = res.entries || [];
    if (newEntries.length !== allEntries.length) {
      allEntries = newEntries;
      renderList();
      updateBottomInfo();
    }
  }, 800);
}
function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function updateBottomInfo() {
  bottomInfo.textContent = `${allEntries.length} request${allEntries.length !== 1 ? 's' : ''}`;
}

// ── Export: HAR ──
el('btnExportHAR').addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'exportHAR' });
    if (res.status === 'ok') {
      downloadJSON(res.har, `request-studio-${Date.now()}.har`);
    }
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
});

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Export: CSV ──
el('btnExportCSV').addEventListener('click', () => {
  if (allEntries.length === 0) { alert('No requests to export.'); return; }

  const headers = ['Method', 'URL', 'Status', 'Time (ms)', 'Content-Type', 'Request Body', 'Started'];
  const rows = allEntries.map(e => [
    e.request.method || '',
    e.request.url || '',
    e.response ? e.response.status : '',
    e.time != null ? e.time : '',
    e.response ? (e.response.mimeType || e.response.headers?.['content-type'] || '') : '',
    (e.request.postData || '').replace(/\n/g, ' ').substring(0, 500),
    e.startedDateTime || ''
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `request-studio-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ── Copy as cURL ──
el('btnCopyCURL').addEventListener('click', () => {
  const url    = urlInput.value.trim() || (selectedId && allEntries.find(e => e.requestId === selectedId)?.request.url) || '';
  const method = methodSelect.value || 'GET';
  if (!url) { alert('Select a request first.'); return; }

  let curl = `curl -X ${method} \\\n  '${url}'`;

  editorHeaders.forEach(h => {
    if (h.enabled && h.key.trim()) {
      curl += ` \\\n  -H '${h.key}: ${h.value.replace(/'/g, "\\'")}'`;
    }
  });

  const body = bodyTextarea.value.trim();
  if (body && !['GET', 'HEAD'].includes(method)) {
    curl += ` \\\n  -d '${body.replace(/'/g, "\\'")}'`;
  }

  navigator.clipboard.writeText(curl).then(() => {
    const btn = el('btnCopyCURL');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1800);
  }).catch(() => {
    alert('Could not copy to clipboard.');
  });
});

// ── Dark theme toggle ──
el('themeToggle').addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  localStorage.setItem('rs-theme', dark ? 'dark' : 'light');
  el('themeToggle').textContent = dark ? '☀️' : '🌙';
});

// Update icon on load
(function () {
  const saved = localStorage.getItem('rs-theme');
  if (saved === 'dark') el('themeToggle').textContent = '☀️';
})();

// ── Sidebar resize ──
(function () {
  const handle  = el('resizeHandle');
  const sidebar = el('sidebar');
  let dragging  = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(600, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Horizontal resize (request/response split) ──
(function () {
  const divider      = el('horizDivider');
  const resPanel     = el('responsePanel');
  const editorWrap   = el('editorContent');
  let dragging = false, startY = 0, startH = 0;

  divider.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startH = resPanel.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newH = Math.max(60, Math.min(600, startH + (startY - e.clientY)));
    resPanel.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Filter controls ──
searchInput.addEventListener('input', renderList);
methodFilter.addEventListener('change', renderList);

// ── Init ──
async function init() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (status.isCapturing) setCapturing(true);
  } catch {}
  loadEntries();
}

init();
