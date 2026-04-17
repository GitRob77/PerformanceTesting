// HAR Traffic Viewer - Request/Response Inspector

let allEntries = [];
let selectedIndex = null;
let tcOverrideEntry = null; // set when user clicks "Use for Export" in Test Client
let requestNames = {};      // requestId → functional name (persisted to storage)

// Load saved names from storage on startup
chrome.storage.local.get(['requestNames'], r => {
  if (r.requestNames) requestNames = r.requestNames;
});

function saveName(requestId, name) {
  if (name) requestNames[requestId] = name;
  else delete requestNames[requestId];
  chrome.storage.local.set({ requestNames });
}

function getName(entry) {
  return (entry && requestNames[entry.requestId]) || '';
}

// ── Load entries — ask background directly (most reliable) ──
async function loadEntries() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getEntries' });
    allEntries = response.entries || [];
    renderList();
  } catch (e) {
    // Background may be sleeping; fall back to storage
    try {
      const result = await chrome.storage.local.get(['capturedEntries']);
      allEntries = result.capturedEntries || [];
      renderList();
    } catch (e2) {
      console.error('Failed to load entries:', e2);
    }
  }
}

// ── Real-time updates via storage change listener ──
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.capturedEntries) {
    allEntries = changes.capturedEntries.newValue || [];
    renderList();
  }
});

// ── Selection state ──
let selectedForDelete = new Set(); // requestIds checked for deletion

function updateDeleteBar() {
  const bar  = document.getElementById('deleteBar');
  const info = document.getElementById('deleteBarInfo');
  const n    = selectedForDelete.size;
  bar.classList.toggle('visible', n > 0);
  info.textContent = `${n} request${n !== 1 ? 's' : ''} selected`;
  // Sync select-all checkbox state
  const visibleIds = getVisibleRequestIds();
  const allChk = document.getElementById('selectAll');
  if (allChk) {
    allChk.checked       = visibleIds.length > 0 && visibleIds.every(id => selectedForDelete.has(id));
    allChk.indeterminate = visibleIds.some(id => selectedForDelete.has(id)) && !allChk.checked;
  }
}

function getVisibleRequestIds() {
  return Array.from(document.querySelectorAll('.row-check')).map(c => c.dataset.rid);
}

// Select-all checkbox
document.getElementById('selectAll').addEventListener('change', e => {
  getVisibleRequestIds().forEach(id => {
    if (e.target.checked) selectedForDelete.add(id);
    else selectedForDelete.delete(id);
  });
  // Re-render checkboxes without full list re-render
  document.querySelectorAll('.row-check').forEach(c => {
    c.checked = selectedForDelete.has(c.dataset.rid);
  });
  updateDeleteBar();
});

// Deselect all
document.getElementById('btnDeselectAll').addEventListener('click', () => {
  selectedForDelete.clear();
  document.querySelectorAll('.row-check').forEach(c => { c.checked = false; });
  updateDeleteBar();
});

// Delete selected
document.getElementById('btnDeleteSelected').addEventListener('click', async () => {
  if (selectedForDelete.size === 0) return;
  const ids = Array.from(selectedForDelete);
  // Remove locally
  allEntries = allEntries.filter(e => !selectedForDelete.has(e.requestId));
  selectedForDelete.clear();
  // Remove in background
  try { await chrome.runtime.sendMessage({ action: 'deleteEntries', requestIds: ids }); } catch(e) {}
  // Clear selection if deleted entry was shown in detail
  if (selectedIndex !== null && !allEntries[selectedIndex]) {
    selectedIndex = null;
    document.getElementById('detailEmpty').style.display = 'flex';
    document.getElementById('detailContent').style.display = 'none';
  }
  renderList();
  updateDeleteBar();
});

// ── API-only filter ──
let apiOnlyActive = false;

function isApiCall(entry) {
  const url      = entry.request.url;
  const reqHdrs  = entry.request.headers  || {};
  const resMime  = entry.response ? (entry.response.mimeType || '').toLowerCase() : '';

  // Response is JSON or XML
  if (resMime.includes('json') || resMime.includes('xml')) return true;

  // Request Content-Type is JSON/XML/form-encoded (data submission)
  const ct = Object.entries(reqHdrs).find(([k]) => k.toLowerCase() === 'content-type');
  if (ct && (ct[1].includes('json') || ct[1].includes('xml') || ct[1].includes('form'))) return true;

  // Accept header explicitly wants JSON or XML
  const accept = Object.entries(reqHdrs).find(([k]) => k.toLowerCase() === 'accept');
  if (accept) {
    const av = accept[1].toLowerCase();
    if (av.includes('json') || av.includes('xml')) return true;
  }

  // URL path looks like an API endpoint
  if (/\/(api|v\d+|graphql|rest|service|services|endpoint|rpc|odata|_api|query|action)\//i.test(url)) return true;

  // Non-GET with no obvious document extension = likely XHR
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const docExt = new Set(['html','htm','php','asp','aspx','jsp','xml']);
  if (!['GET','HEAD'].includes(entry.request.method) && !docExt.has(ext)) return true;

  return false;
}

document.getElementById('btnApiOnly').addEventListener('click', () => {
  apiOnlyActive = !apiOnlyActive;
  document.getElementById('btnApiOnly').classList.toggle('active', apiOnlyActive);
  renderList();
});

// ── Shared filter — single source of truth for all views ──
function getVisibleEntries() {
  const search       = document.getElementById('searchInput').value.toLowerCase();
  const methodFilter = document.getElementById('methodFilter').value;
  const statusFilter = document.getElementById('statusFilter').value;
  return allEntries.filter(entry => {
    if (apiOnlyActive && !isApiCall(entry)) return false;
    if (search && !entry.request.url.toLowerCase().includes(search)) return false;
    if (methodFilter !== 'ALL' && entry.request.method !== methodFilter) return false;
    if (statusFilter !== 'ALL' && entry.response) {
      const s = entry.response.status;
      if (statusFilter === '2xx' && (s < 200 || s >= 300)) return false;
      if (statusFilter === '3xx' && (s < 300 || s >= 400)) return false;
      if (statusFilter === '4xx' && (s < 400 || s >= 500)) return false;
      if (statusFilter === '5xx' && s < 500) return false;
    }
    return true;
  });
}

// ── Render request list ──
function renderList() {
  const filtered = getVisibleEntries();

  document.getElementById('countBadge').textContent = `${filtered.length} request${filtered.length !== 1 ? 's' : ''}`;

  // Update left-panel counter
  const counter = document.getElementById('listCounter');
  document.getElementById('listCountVisible').textContent = filtered.length;
  document.getElementById('listCountTotal').textContent   = allEntries.length;
  counter.classList.toggle('filtered', filtered.length !== allEntries.length);

  const listEl = document.getElementById('requestList');
  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="no-requests"><div class="icon">📭</div><p>No matching requests.</p></div>';
    return;
  }

  listEl.innerHTML = filtered.map((entry) => {
    const origIndex = allEntries.indexOf(entry);
    const url = new URL(entry.request.url);
    const method = entry.request.method;
    const status = entry.response ? entry.response.status : null;
    const time = entry.time != null ? `${entry.time}ms` : '…';
    const statusClass = !status ? 'status-pending' :
      status < 300 ? 'status-2xx' : status < 400 ? 'status-3xx' : status < 500 ? 'status-4xx' : 'status-5xx';
    const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? `method-${method}` : 'method-OTHER';
    const isSelected = origIndex === selectedIndex ? 'selected' : '';

    const name = getName(entry);
    const isChecked = selectedForDelete.has(entry.requestId) ? 'checked' : '';
    return `<div class="request-item ${isSelected}" data-index="${origIndex}">` +
      `<span style="display:flex;align-items:center;justify-content:center" onclick="event.stopPropagation()">` +
        `<input type="checkbox" class="row-check" data-rid="${entry.requestId}" ${isChecked} />` +
      `</span>` +
      `<span class="method-badge ${methodClass}">${method}</span>` +
      `<div class="url-cell">` +
        (name ? `<div class="request-name-badge" title="${escapeHtml(name)}">⬡ ${escapeHtml(name)}</div>` : '') +
        `<div class="url-path" title="${entry.request.url}">${url.pathname}${url.search}</div>` +
        `<div class="url-domain">${url.hostname}</div>` +
      `</div>` +
      `<span class="status-cell ${statusClass}">${status || '—'}</span>` +
      `<span class="time-cell">${time}</span>` +
    `</div>`;
  }).join('');

  // Row click → select for detail
  listEl.querySelectorAll('.request-item').forEach(el => {
    el.addEventListener('click', () => {
      selectedIndex = parseInt(el.dataset.index);
      renderList();
      showDetail(allEntries[selectedIndex]);
      loadTestClient(allEntries[selectedIndex]);
    });
  });

  // Checkbox → mark for deletion
  listEl.querySelectorAll('.row-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) selectedForDelete.add(chk.dataset.rid);
      else selectedForDelete.delete(chk.dataset.rid);
      updateDeleteBar();
    });
  });

  updateDeleteBar();
}

// ── Show detail ──
function showDetail(entry) {
  document.getElementById('detailEmpty').style.display = 'none';
  document.getElementById('detailContent').style.display = 'flex';

  // Populate name field
  document.getElementById('requestNameInput').value = getName(entry);

  const url = entry.request.url;
  const method = entry.request.method;
  const status = entry.response ? entry.response.status : null;
  const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? `method-${method}` : 'method-OTHER';
  const statusClass = !status ? 'status-pending' :
    status < 300 ? 'status-2xx' : status < 400 ? 'status-3xx' : status < 500 ? 'status-4xx' : 'status-5xx';

  document.getElementById('detailMethod').textContent = method;
  document.getElementById('detailMethod').className = `method-badge ${methodClass}`;
  document.getElementById('detailUrl').textContent = url;
  document.getElementById('detailUrl').title = url;
  document.getElementById('detailStatus').textContent = status ? `${status} ${entry.response.statusText}` : '—';
  document.getElementById('detailStatus').className = `status-cell ${statusClass}`;
  document.getElementById('detailTime').textContent = entry.time != null ? `${entry.time}ms` : '';

  // Request headers
  renderHeaders('reqHeadersTable', entry.request.headers || {}, 'req', entry.requestId);

  // Request body
  const reqBodyEl = document.getElementById('reqBodyContent');
  if (entry.request.postData) {
    reqBodyEl.innerHTML = `<pre class="body-viewer">${highlightChainVars(formatBody(entry.request.postData, 'application/json'))}</pre>`;
  } else {
    reqBodyEl.innerHTML = '<div class="empty-body">No request body</div>';
  }

  // Response headers
  renderHeaders('resHeadersTable', entry.response ? entry.response.headers : {}, 'res', entry.requestId);

  // Response body
  const resBodyEl = document.getElementById('resBodyContent');
  if (entry.responseBody) {
    const mime = entry.response ? entry.response.mimeType : '';
    resBodyEl.innerHTML = `<pre class="body-viewer">${formatBody(entry.responseBody, mime)}</pre>`;
  } else if (entry.response) {
    resBodyEl.innerHTML = '<div class="empty-body">Response body not available</div>';
  } else {
    resBodyEl.innerHTML = '<div class="empty-body">No response received</div>';
  }
}

function renderHeaders(tableId, headers, mode, requestId) {
  const table = document.getElementById(tableId);
  if (!headers || Object.keys(headers).length === 0) {
    table.innerHTML = '<tr><td colspan="3" class="empty-body">No headers</td></tr>';
    return;
  }
  const cfg = (requestId && chainConfig[requestId] && chainConfig[requestId][mode]) || {};

  table.innerHTML = Object.entries(headers).map(([name, value]) => {
    const lname = name.toLowerCase();
    const chainVal = cfg[lname]; // e.g. '{{XSRFToken}}' for req, or '{{XSRFToken}}' for res
    let displayValue = escapeHtml(value);
    // If this header has a chain rule, show the {{VarName}} token prominently
    if (chainVal) {
      displayValue = `<span class="chain-var-token">${escapeHtml(chainVal)}</span> <span class="chain-var-orig" title="${escapeHtml(value)}">(${mode === 'req' ? 'will be replaced' : 'stored as var'})</span>`;
    }
    const chainBtn = requestId
      ? `<td class="header-chain-cell"><button class="chain-rule-btn ${chainVal ? 'active' : ''}" title="${chainVal ? 'Edit chain rule' : 'Add chain rule'}" data-mode="${mode}" data-reqid="${escapeHtml(requestId)}" data-header="${escapeHtml(lname)}" data-value="${escapeHtml(value)}">${chainVal ? '⛓' : '+'}</button></td>`
      : '';
    return `<tr><td class="header-name">${escapeHtml(name)}</td><td class="header-value">${displayValue}</td>${chainBtn}</tr>`;
  }).join('');

  // Attach chain rule button click handlers
  if (requestId) {
    table.querySelectorAll('.chain-rule-btn').forEach(btn => {
      btn.addEventListener('click', () => openChainRuleDialog(
        btn.dataset.mode, btn.dataset.reqid, btn.dataset.header, btn.dataset.value
      ));
    });
  }
}

// ── Chain Rule inline dialog ──
// Opens a small inline dialog to set/clear a {{VarName}} rule on a header
function openChainRuleDialog(mode, requestId, headerName, headerValue) {
  // Remove any existing dialog
  document.querySelectorAll('.chain-rule-dialog').forEach(d => d.remove());

  initChainEntry(requestId);
  const existing = chainConfig[requestId][mode][headerName] || '';
  // Extract just the var name from {{VarName}} or empty
  const existingVar = existing.replace(/^\{\{|\}\}$/g, '');

  // Suggest a variable name from the header
  let suggested = existingVar || headerName.replace(/^x-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  suggested = suggested.charAt(0).toUpperCase() + suggested.slice(1);

  const modeLabel = mode === 'res'
    ? 'Store response header value into variable:'
    : 'Replace request header value with variable:';

  const dialog = document.createElement('div');
  dialog.className = 'chain-rule-dialog';
  dialog.innerHTML =
    `<div class="crd-title">${mode === 'res' ? '⛓ Extract → Variable' : '⛓ Inject Variable'}</div>` +
    `<div class="crd-label">${modeLabel}</div>` +
    `<div class="crd-header-name"><code>${escapeHtml(headerName)}</code></div>` +
    `<div class="crd-input-row">` +
      `<span class="crd-braces">{{</span>` +
      `<input class="crd-var-input" id="crdVarInput" value="${escapeHtml(existingVar || suggested)}" placeholder="VariableName" />` +
      `<span class="crd-braces">}}</span>` +
    `</div>` +
    `<div class="crd-hint">${mode === 'res' ? 'During Run All, this header\'s value will be stored.' : 'During Run All, {{VarName}} will be replaced with the stored value.'}</div>` +
    `<div class="crd-actions">` +
      `<button class="btn crd-btn-save">✓ Save</button>` +
      (existingVar ? `<button class="btn crd-btn-clear">✕ Remove</button>` : '') +
      `<button class="btn crd-btn-cancel" style="background:none;color:#888">Cancel</button>` +
    `</div>`;

  // Position near the button that was clicked
  const activeBtn = document.querySelector(`.chain-rule-btn[data-reqid="${requestId}"][data-header="${headerName}"]`);
  document.body.appendChild(dialog);
  if (activeBtn) {
    const rect = activeBtn.getBoundingClientRect();
    const dw = dialog.offsetWidth || 280;
    let left = rect.right - dw;
    if (left < 8) left = 8;
    dialog.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    dialog.style.left = left + 'px';
  } else {
    dialog.style.top  = '50%';
    dialog.style.left = '50%';
    dialog.style.transform = 'translate(-50%,-50%)';
  }

  const input = dialog.querySelector('#crdVarInput');
  input.focus();
  input.select();

  dialog.querySelector('.crd-btn-save').addEventListener('click', () => {
    const varName = input.value.trim().replace(/\W/g, '');
    if (!varName) { input.focus(); return; }
    chainConfig[requestId][mode][headerName] = `{{${varName}}}`;
    saveChainConfig();
    dialog.remove();
    // Re-render the affected header table
    const entry = allEntries.find(e => e.requestId === requestId);
    if (entry) {
      if (mode === 'req') renderHeaders('reqHeadersTable', entry.request.headers || {}, 'req', requestId);
      else renderHeaders('resHeadersTable', entry.response ? entry.response.headers : {}, 'res', requestId);
    }
    updateChainBadge();
  });

  const clearBtn = dialog.querySelector('.crd-btn-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      delete chainConfig[requestId][mode][headerName];
      saveChainConfig();
      dialog.remove();
      const entry = allEntries.find(e => e.requestId === requestId);
      if (entry) {
        if (mode === 'req') renderHeaders('reqHeadersTable', entry.request.headers || {}, 'req', requestId);
        else renderHeaders('resHeadersTable', entry.response ? entry.response.headers : {}, 'res', requestId);
      }
      updateChainBadge();
    });
  }

  dialog.querySelector('.crd-btn-cancel').addEventListener('click', () => dialog.remove());

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!dialog.contains(e.target)) { dialog.remove(); document.removeEventListener('click', handler); }
    });
  }, 10);
}

// Update the chain variable badge on the Variables button
function updateChainBadge() {
  const totalRules = Object.values(chainConfig).reduce((n, cfg) => {
    return n + Object.keys(cfg.req || {}).length + Object.keys(cfg.res || {}).length;
  }, 0);
  const btn = document.getElementById('btnVariables');
  btn.querySelectorAll('.chain-badge').forEach(b => b.remove());
  if (totalRules > 0) {
    const badge = document.createElement('span');
    badge.className = 'chain-badge';
    badge.title = `${totalRules} chain rule${totalRules !== 1 ? 's' : ''} active`;
    badge.textContent = '⛓';
    btn.appendChild(badge);
  }
}

function formatBody(body, mimeType) {
  if (!body) return '';
  if (mimeType.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      return escapeHtml(JSON.stringify(JSON.parse(body), null, 2));
    } catch (e) {}
  }
  return escapeHtml(body);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Tab switching (Captured panel) ──
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const targetTab = tab.dataset.tab;
  tab.closest('.panel').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  tab.closest('.panel').querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(targetTab).classList.add('active');
});

// ── Functional name input ──
const nameInput = document.getElementById('requestNameInput');
nameInput.addEventListener('input', () => {
  if (selectedIndex === null) return;
  const entry = allEntries[selectedIndex];
  if (!entry) return;
  saveName(entry.requestId, nameInput.value.trim());
  renderList(); // refresh badge in list
});
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') nameInput.blur();
});

// ── Detail view switcher (Captured / Test Client) ──
document.addEventListener('click', e => {
  const dvt = e.target.closest('.detail-view-tab');
  if (!dvt) return;
  document.querySelectorAll('.detail-view-tab').forEach(t => t.classList.remove('active'));
  dvt.classList.add('active');
  const view = dvt.dataset.view;
  document.getElementById('viewCaptured').style.display   = view === 'captured'   ? '' : 'none';
  document.getElementById('viewTestClient').style.display = view === 'testclient' ? '' : 'none';
});

// ── TC Override: "Use for Export" ──
function buildTcEntry() {
  // Build a synthetic entry from the current Test Client state
  const headers = {};
  tcHeaders.forEach(h => { if (h.key.trim()) headers[h.key.trim()] = h.value; });
  return {
    requestId: 'tc-override',
    startedDateTime: new Date().toISOString(),
    startTimestamp: null,
    request: {
      method:   document.getElementById('tcMethod').value,
      url:      document.getElementById('tcUrl').value.trim(),
      headers:  headers,
      postData: document.getElementById('tcBody').value || null
    },
    response: null,
    responseBody: null,
    time: null
  };
}

// Returns the entry to use for single-request exports (Copy cURL, etc.)
function getExportEntry() {
  return tcOverrideEntry || (selectedIndex !== null ? allEntries[selectedIndex] : null);
}

// Returns the list to use for bulk exports — TC override replaces the selected entry
function getExportList(visibleEntries) {
  if (!tcOverrideEntry || selectedIndex === null) return visibleEntries;
  return visibleEntries.map(e => (e === allEntries[selectedIndex] ? tcOverrideEntry : e));
}

function setTcOverride(entry) {
  tcOverrideEntry = entry;
  const ind = document.getElementById('promoteIndicator');
  const btn = document.getElementById('btnPromote');
  if (entry) {
    ind.style.display = 'block';
    btn.classList.add('active');
    btn.textContent = '📤 Exported ✓';
  } else {
    ind.style.display = 'none';
    btn.classList.remove('active');
    btn.textContent = '📤 Use for Export';
  }
}

document.getElementById('btnPromote').addEventListener('click', () => {
  setTcOverride(buildTcEntry());
});

document.getElementById('clearPromote').addEventListener('click', () => {
  setTcOverride(null);
});

// ── Test Client ──
let tcHeaders = []; // [{key, value, enabled}]

function loadTestClient(entry) {
  // Method & URL
  const methodSel = document.getElementById('tcMethod');
  methodSel.value = entry.request.method;
  document.getElementById('tcUrl').value = entry.request.url;

  // Headers — skip pseudo-headers and content-length
  const skipTc = new Set([':method',':path',':scheme',':authority','content-length','accept-encoding','connection','host']);
  tcHeaders = Object.entries(entry.request.headers || {})
    .filter(([k]) => !skipTc.has(k.toLowerCase()))
    .map(([key, value]) => ({ key, value, enabled: true }));
  renderTcHeaders();

  // Body
  document.getElementById('tcBody').value = entry.request.postData || '';

  // Reset response panel
  document.getElementById('tcResponseContent').innerHTML =
    '<div style="color:#555;font-size:13px;padding:20px;text-align:center">Hit ▶ Send to see the response</div>';
}

function renderTcHeaders() {
  const list = document.getElementById('tcHeadersList');
  list.innerHTML = '';
  tcHeaders.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'tc-header-row';
    row.innerHTML =
      `<input class="header-name"  value="${escapeHtml(h.key)}"   placeholder="Header name"  data-i="${i}" data-field="key" />` +
      `<input class="header-value" value="${escapeHtml(h.value)}" placeholder="Value"        data-i="${i}" data-field="value" />` +
      `<button class="tc-del-btn" data-i="${i}" title="Remove">✕</button>`;
    list.appendChild(row);
  });
  document.getElementById('tcHeaderCount').textContent = tcHeaders.length ? `(${tcHeaders.length})` : '';
}

document.getElementById('tcHeadersList').addEventListener('input', e => {
  const inp = e.target.closest('input');
  if (!inp) return;
  const i = parseInt(inp.dataset.i);
  tcHeaders[i][inp.dataset.field] = inp.value;
});

document.getElementById('tcHeadersList').addEventListener('click', e => {
  const btn = e.target.closest('.tc-del-btn');
  if (!btn) return;
  tcHeaders.splice(parseInt(btn.dataset.i), 1);
  renderTcHeaders();
});

document.getElementById('tcAddHeader').addEventListener('click', () => {
  tcHeaders.push({ key: '', value: '', enabled: true });
  renderTcHeaders();
  // Focus the new key input
  const inputs = document.getElementById('tcHeadersList').querySelectorAll('.header-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

document.getElementById('tcSend').addEventListener('click', async () => {
  const method  = document.getElementById('tcMethod').value;
  const url     = document.getElementById('tcUrl').value.trim();
  const bodyVal = document.getElementById('tcBody').value;
  const btn     = document.getElementById('tcSend');

  if (!url) { alert('Please enter a URL.'); return; }

  // Build headers object
  const headers = {};
  tcHeaders.forEach(h => {
    if (h.key.trim()) headers[h.key.trim()] = h.value;
  });

  btn.disabled = true;
  btn.textContent = '⏳ Sending…';
  document.getElementById('tcResponseContent').innerHTML =
    '<div class="tc-sending">⏳ Sending request…</div>';

  const start = Date.now();
  try {
    const fetchOpts = { method, headers };
    if (bodyVal && !['GET','HEAD'].includes(method)) fetchOpts.body = bodyVal;

    const res      = await fetch(url, fetchOpts);
    const elapsed  = Date.now() - start;
    const resText  = await res.text();
    const resHdrs  = {};
    res.headers.forEach((v, k) => { resHdrs[k] = v; });

    renderTcResponse({ status: res.status, statusText: res.statusText, headers: resHdrs, body: resText, time: elapsed });
  } catch (err) {
    renderTcResponseError(err.message, Date.now() - start);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Send';
  }
});

function renderTcResponse({ status, statusText, headers, body, time }) {
  const statusClass = status < 300 ? 'status-2xx' : status < 400 ? 'status-3xx' : status < 500 ? 'status-4xx' : 'status-5xx';
  const size        = new Blob([body]).size;
  const sizeStr     = size > 1024 ? `${(size/1024).toFixed(1)} KB` : `${size} B`;

  // Pretty-print if JSON
  let displayBody = body;
  try { displayBody = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}

  const hdrRows = Object.entries(headers)
    .map(([k,v]) => `<tr><td class="header-name">${escapeHtml(k)}</td><td class="header-value">${escapeHtml(v)}</td></tr>`)
    .join('');

  document.getElementById('tcResponseContent').innerHTML = `
    <div class="tc-response-bar">
      <span class="tc-res-status ${statusClass}">${status} ${escapeHtml(statusText)}</span>
      <span class="tc-res-time">⏱ ${time}ms</span>
      <span class="tc-res-size">📦 ${sizeStr}</span>
    </div>
    <div class="tabs" style="background:#2d2d2d;border-bottom:1px solid #3e3e3e;flex-shrink:0">
      <div class="tab active" data-panel="tcr" data-tab="tcr-body">Body</div>
      <div class="tab" data-panel="tcr" data-tab="tcr-headers">Headers</div>
    </div>
    <div class="tab-content active" id="tcr-body" style="flex:1;overflow:auto">
      <pre class="body-viewer">${escapeHtml(displayBody)}</pre>
    </div>
    <div class="tab-content" id="tcr-headers" style="flex:1;overflow:auto">
      <table class="headers-table">${hdrRows}</table>
    </div>`;
}

function renderTcResponseError(message, time) {
  document.getElementById('tcResponseContent').innerHTML = `
    <div class="tc-response-bar error-bar">
      <span class="tc-res-status status-5xx">Error</span>
      <span class="tc-res-time">⏱ ${time}ms</span>
    </div>
    <div style="padding:16px;color:#e05050;font-size:13px">
      <strong>Request failed:</strong><br>${escapeHtml(message)}<br><br>
      <span style="color:#777;font-size:12px">This may be a CORS restriction. Try adding the required Origin header, or check that the server allows cross-origin requests.</span>
    </div>`;
}

// ── cURL generation ──
function generateCurl(entry) {
  const lines = [];
  const method = entry.request.method;
  const url = entry.request.url;

  // Skip headers that browsers auto-generate and that curl handles itself
  const skipHeaders = new Set([
    'content-length', ':method', ':path', ':scheme', ':authority',
    'accept-encoding', 'connection'
  ]);

  lines.push(`curl -X ${method} '${url.replace(/'/g, "'\\''")}'`);

  const headers = entry.request.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    if (skipHeaders.has(name.toLowerCase())) continue;
    const safeName  = name.replace(/'/g, "'\\''");
    const safeValue = value.replace(/'/g, "'\\''");
    lines.push(`  -H '${safeName}: ${safeValue}'`);
  }

  if (entry.request.postData) {
    const safeBody = entry.request.postData.replace(/'/g, "'\\''");
    lines.push(`  --data-raw '${safeBody}'`);
  }

  return lines.join(' \\\n');
}

// ── UiPath XAML + Project generation ──
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const SKIP_HEADERS_XAML = new Set([
  'content-length', ':method', ':path', ':scheme', ':authority',
  'accept-encoding', 'connection', 'host'
]);

function tryShortUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).substring(0, 60) || url.substring(0, 60);
  } catch (e) { return url.substring(0, 60); }
}

function generateMainXaml(entries, lang) {
  const isCSharp = lang !== 'VisualBasic';

  const activities = entries.map((entry, i) => {
    const method = entry.request.method;
    const url    = entry.request.url;
    const name   = getName(entry);
    const label  = escapeXml(name ? `${name} (${method} ${tryShortUrl(url)})` : `${method} ${tryShortUrl(url)}`);

    const headers = Object.entries(entry.request.headers || {})
      .filter(([name]) => !SKIP_HEADERS_XAML.has(name.toLowerCase()));

    // Build inline C# or VB code using System.Net.Http.HttpClient
    let code;
    if (isCSharp) {
      const headerLines = headers.map(([k, v]) =>
        `    client.DefaultRequestHeaders.TryAddWithoutValidation("${k.replace(/"/g, '\\"')}", "${v.replace(/"/g, '\\"')}");`
      ).join('\n');

      const bodyLine = entry.request.postData
        ? `    var content = new System.Net.Http.StringContent("${entry.request.postData.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}", System.Text.Encoding.UTF8, "application/json");\n    var response = client.${method === 'GET' || method === 'DELETE' ? `SendAsync(new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.${method[0] + method.slice(1).toLowerCase()}, url) { Content = content }).GetAwaiter().GetResult()` : `PostAsync(url, content).GetAwaiter().GetResult()`};`
        : `    var response = client.${method === 'POST' ? 'PostAsync(url, null)' : method === 'PUT' ? 'PutAsync(url, null)' : method === 'DELETE' ? 'DeleteAsync(url)' : 'GetAsync(url)'}.GetAwaiter().GetResult();`;

      code = [
        `var url = "${url.replace(/"/g, '\\"')}";`,
        `using (var client = new System.Net.Http.HttpClient()) {`,
        headerLines,
        bodyLine,
        `    Console.WriteLine($"Response: {(int)response.StatusCode} {response.ReasonPhrase}");`,
        `}`
      ].filter(Boolean).join('\n');
    } else {
      const headerLines = headers.map(([k, v]) =>
        `    client.DefaultRequestHeaders.TryAddWithoutValidation("${k.replace(/"/g, '""')}", "${v.replace(/"/g, '""')}")`
      ).join('\n');

      code = [
        `Dim url As String = "${url.replace(/"/g, '""')}"`,
        `Using client As New System.Net.Http.HttpClient()`,
        headerLines,
        `    Dim response = client.GetAsync(url).GetAwaiter().GetResult()`,
        `    Console.WriteLine($"Response: {CInt(response.StatusCode)} {response.ReasonPhrase}")`,
        `End Using`
      ].filter(Boolean).join('\n');
    }

    // Escape for XML CDATA — CDATA cannot contain ]]> so split if needed
    const safeCode = code.replace(/]]>/g, ']]]]><![CDATA[>');

    return [
      `    <!-- Request ${i + 1}: ${label} -->`,
      `    <InvokeCode DisplayName="${label}">`,
      `      <InvokeCode.Script>`,
      `        <![CDATA[`,
      safeCode,
      `        ]]>`,
      `      </InvokeCode.Script>`,
      `    </InvokeCode>`
    ].join('\n');
  }).join('\n\n');

  // Language-specific namespace and settings
  const langNs   = isCSharp ? '' : '\n  xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities"';
  const langSettings = isCSharp ? '' : `
  <mva:VisualBasic.Settings>
    <mva:VisualBasicSettings>
      <mva:VisualBasicSettings.ImportedNamespaces>
        <mva:VisualBasicImportReference Assembly="mscorlib" Import="System" />
        <mva:VisualBasicImportReference Assembly="System" Import="System.Net.Http" />
      </mva:VisualBasicSettings.ImportedNamespaces>
    </mva:VisualBasicSettings>
  </mva:VisualBasic.Settings>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010 sads" x:Class="Main"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"${langNs}
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:sads="http://schemas.microsoft.com/netfx/2010/xaml/activities/debugger"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">${langSettings}
  <Sequence DisplayName="Captured HTTP Traffic" sap2010:WorkflowViewState.IdRef="Sequence_1">
${activities}
  </Sequence>
</Activity>`;
}

function generateProjectJson(lang) {
  return JSON.stringify({
    name: 'CapturedTraffic',
    description: 'HTTP traffic captured and exported by HAR Traffic Capturer',
    projectVersion: '1.0.0',
    schemaVersion: '4.0',
    studioVersion: '26.0.0.0',
    main: 'Main.xaml',
    dependencies: {
      'UiPath.System.Activities': '25.10.3'
    },
    webSettings: {},
    targetFramework: 'Windows',
    languageVersion: '',
    expressionLanguage: lang,
    runtimeOptions: {
      autoDispose: false,
      isPausable: true,
      requiresUserInteraction: true,
      supportsPersistence: false,
      workflowSerialization: 'DataContract'
    },
    designOptions: { autoSaveOption: 'Off' },
    entryPoints: [{ filePath: 'Main.xaml' }],
    filesToPublish: []
  }, null, 2);
}

// ── Minimal ZIP builder (no compression, pure JS) ──
function buildZip(files) {
  // files: [{name: string, content: string}]
  const enc  = new TextEncoder();
  const u16  = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32  = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

  // CRC-32 table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) >>> 0;
  const dosDate = ((((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate())) >>> 0;

  const localParts  = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data      = enc.encode(file.content);
    const crc       = crc32(data);
    const size      = data.length;

    const lh = new Uint8Array([
      0x50,0x4b,0x03,0x04,  // local file header sig
      0x14,0x00,            // version needed (2.0)
      0x00,0x00,            // flags
      0x00,0x00,            // compression: stored
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc),
      ...u32(size), ...u32(size),
      ...u16(nameBytes.length),
      0x00,0x00             // extra length
    ]);
    localParts.push(lh, nameBytes, data);

    const cd = new Uint8Array([
      0x50,0x4b,0x01,0x02,  // central dir sig
      0x14,0x00,            // version made by
      0x14,0x00,            // version needed
      0x00,0x00,            // flags
      0x00,0x00,            // compression: stored
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc),
      ...u32(size), ...u32(size),
      ...u16(nameBytes.length),
      0x00,0x00,            // extra length
      0x00,0x00,            // comment length
      0x00,0x00,            // disk number start
      0x00,0x00,            // internal attrs
      0x00,0x00,0x00,0x00,  // external attrs
      ...u32(offset)
    ]);
    centralParts.push(cd, nameBytes);
    offset += lh.length + nameBytes.length + size;
  }

  const cdSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = new Uint8Array([
    0x50,0x4b,0x05,0x06,
    0x00,0x00, 0x00,0x00,
    ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(offset),
    0x00,0x00
  ]);

  const all = [...localParts, ...centralParts, eocd];
  const total = all.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of all) { out.set(b, pos); pos += b.length; }
  return out;
}

function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Controls ──
document.getElementById('btnRefresh').addEventListener('click', loadEntries);

// Export all visible requests as cURL commands (one per request, separated by blank lines)
document.getElementById('btnExportCurl').addEventListener('click', () => {
  const exportList = getExportList(getVisibleEntries());
  if (exportList.length === 0) { alert('No requests to export.'); return; }

  const content = exportList.map((e, i) => {
    const name = getName(e);
    const label = name ? `${name} — ${e.request.method} ${e.request.url}` : `${e.request.method} ${e.request.url}`;
    return `# Request ${i + 1}: ${label}\n${generateCurl(e)}`;
  }).join('\n\n');

  downloadTextFile(content, `curl-export-${Date.now()}.sh`);
});

// Export all visible requests as a UiPath project ZIP
document.getElementById('btnExportXaml').addEventListener('click', () => {
  const exportList = getExportList(getVisibleEntries());
  if (exportList.length === 0) { alert('No requests to export.'); return; }

  const lang = document.getElementById('xamlLang').value; // 'CSharp' or 'VisualBasic'

  // Build a complete UiPath project (project.json + Main.xaml) as a ZIP
  const zipBytes = buildZip([
    { name: 'project.json', content: generateProjectJson(lang) },
    { name: 'Main.xaml',    content: generateMainXaml(exportList, lang) }
  ]);

  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `CapturedTraffic_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(url);
});

// Export XAML file only (for dropping into an existing UiPath project folder)
document.getElementById('btnExportXamlOnly').addEventListener('click', () => {
  const exportList = getExportList(getVisibleEntries());
  if (exportList.length === 0) { alert('No requests to export.'); return; }

  const lang = document.getElementById('xamlLang').value;
  downloadTextFile(generateMainXaml(exportList, lang), 'CapturedTraffic.xaml');
});

// Copy cURL for the currently selected request (or TC override)
document.getElementById('btnCopyCurl').addEventListener('click', () => {
  const entry = getExportEntry();
  if (!entry) return;
  const curl = generateCurl(entry);
  navigator.clipboard.writeText(curl).then(() => {
    const btn = document.getElementById('btnCopyCurl');
    const original = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  });
});

document.getElementById('btnClear').addEventListener('click', async () => {
  if (confirm('Clear all captured requests?')) {
    await chrome.runtime.sendMessage({ action: 'clearCapture' });
    allEntries = [];
    selectedIndex = null;
    requestNames = {};
    chrome.storage.local.remove(['requestNames']);
    document.getElementById('detailEmpty').style.display = 'flex';
    document.getElementById('detailContent').style.display = 'none';
    renderList();
  }
});
document.getElementById('searchInput').addEventListener('input', renderList);
document.getElementById('methodFilter').addEventListener('change', renderList);
document.getElementById('statusFilter').addEventListener('change', renderList);

// ── Resizable panels ──
function makeResizable(handle, getPrev, getNext, direction = 'horizontal') {
  let dragging = false, startX, startY, startPrevSize, startNextSize;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const prev = getPrev();
    const next = getNext();
    startPrevSize = direction === 'horizontal' ? prev.getBoundingClientRect().width : prev.getBoundingClientRect().height;
    startNextSize = direction === 'horizontal' ? next.getBoundingClientRect().width : next.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = direction === 'horizontal' ? e.clientX - startX : e.clientY - startY;
    const prev = getPrev();
    const next = getNext();
    const newPrev = Math.max(80, startPrevSize + delta);
    const newNext = Math.max(80, startNextSize - delta);
    if (newPrev > 80 && newNext > 80) {
      prev.style.flex = 'none';
      prev.style.width = newPrev + 'px';
      next.style.flex = '1';
      next.style.minWidth = Math.max(80, newNext) + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// Main: request list ↔ detail panel
makeResizable(
  document.getElementById('mainResize'),
  () => document.querySelector('.request-list'),
  () => document.getElementById('detailPanel')
);

// Test Client: headers ↔ body
makeResizable(
  document.getElementById('tcResize1'),
  () => document.getElementById('tcResize1').previousElementSibling,
  () => document.getElementById('tcResize1').nextElementSibling
);

// Test Client: body ↔ response
makeResizable(
  document.getElementById('tcResize2'),
  () => document.getElementById('tcResize2').previousElementSibling,
  () => document.getElementById('tcResize2').nextElementSibling
);

// ── cURL Import ──

function tokenizeCurl(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i++;
    if (i >= str.length) break;
    let token = '';
    if (str[i] === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') i++;
        token += str[i++];
      }
      i++;
    } else if (str[i] === "'") {
      i++;
      while (i < str.length) {
        // bash single-quote escape: '\'' ends quote, adds literal ', restarts quote
        if (str[i] === "'" && str.slice(i, i+4) === "'\\''") {
          token += "'"; i += 4; continue;
        }
        if (str[i] === "'") break;
        token += str[i++];
      }
      i++;
    } else {
      while (i < str.length && !/[\s]/.test(str[i])) token += str[i++];
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

function parseCurl(raw) {
  // Normalise line continuations and collapse whitespace
  const str = raw.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  const tokens = tokenizeCurl(str);
  if (!tokens.length || tokens[0].toLowerCase() !== 'curl') return { error: 'Command must start with "curl"' };

  let method = null;
  let url    = null;
  const headers = {};
  let body = null;

  let i = 1; // skip 'curl'
  while (i < tokens.length) {
    const t = tokens[i];
    // Flags that consume the next token
    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const h = tokens[++i] || '';
      const colon = h.indexOf(':');
      if (colon > 0) headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
    } else if (['-d','--data','--data-raw','--data-binary','--data-urlencode'].includes(t)) {
      body = tokens[++i] || null;
    } else if (t === '--json') {
      body = tokens[++i] || null;
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Accept']       = headers['Accept']       || 'application/json';
    } else if (t === '--form' || t === '-F') {
      body = (body ? body + '&' : '') + (tokens[++i] || '');
      headers['Content-Type'] = headers['Content-Type'] || 'multipart/form-data';
    } else if (t === '--user' || t === '-u') {
      const creds = tokens[++i] || '';
      headers['Authorization'] = 'Basic ' + btoa(creds);
    } else if (t === '--compressed' || t === '-L' || t === '--location'
            || t === '-s' || t === '--silent' || t === '-k' || t === '--insecure'
            || t === '-v' || t === '--verbose' || t === '-i' || t === '--include'
            || t === '-g' || t === '--globoff') {
      // known flags with no value — ignore
    } else if (t.startsWith('-')) {
      // Unknown flag — try to skip its value only if next token doesn't look like a flag or URL
      if (tokens[i+1] && !tokens[i+1].startsWith('-') && !tokens[i+1].startsWith('http')) i++;
    } else if (!url) {
      url = t;
    }
    i++;
  }

  if (!url) return { error: 'Could not find a URL in the cURL command.' };

  // Infer method
  if (!method) method = body ? 'POST' : 'GET';

  return { method, url, headers, body };
}

let parsedCurlEntry = null;

document.getElementById('btnImportCurl').addEventListener('click', () => {
  parsedCurlEntry = null;
  document.getElementById('curlInput').value = '';
  document.getElementById('curlPreview').classList.remove('visible');
  document.getElementById('btnDoImport').disabled = true;
  document.getElementById('curlImportOverlay').classList.add('open');
  setTimeout(() => document.getElementById('curlInput').focus(), 50);
});

['btnCurlImportClose','btnCurlImportCancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('curlImportOverlay').classList.remove('open');
  });
});

document.getElementById('btnParseCurl').addEventListener('click', () => {
  const raw = document.getElementById('curlInput').value.trim();
  if (!raw) return;

  const result = parseCurl(raw);
  const preview = document.getElementById('curlPreview');
  const errEl   = document.getElementById('curlParseError');
  const rowsEl  = document.getElementById('curlPreviewRows');
  preview.classList.add('visible');

  if (result.error) {
    errEl.textContent = '✗ ' + result.error;
    errEl.style.display = '';
    rowsEl.innerHTML = '';
    document.getElementById('btnDoImport').disabled = true;
    parsedCurlEntry = null;
    return;
  }

  errEl.style.display = 'none';
  const hdrHtml = Object.entries(result.headers).map(([k, v]) =>
    `<div class="curl-hdr-item"><span class="curl-hdr-name">${escapeHtml(k)}:</span><span class="curl-hdr-val">${escapeHtml(v)}</span></div>`
  ).join('');

  rowsEl.innerHTML =
    `<div class="curl-preview-row"><span class="curl-preview-label">Method</span><span class="curl-preview-value"><strong>${escapeHtml(result.method)}</strong></span></div>` +
    `<div class="curl-preview-row"><span class="curl-preview-label">URL</span><span class="curl-preview-value">${escapeHtml(result.url)}</span></div>` +
    (Object.keys(result.headers).length
      ? `<div class="curl-preview-row"><span class="curl-preview-label">Headers</span><div class="curl-hdr-list">${hdrHtml}</div></div>`
      : '') +
    (result.body
      ? `<div class="curl-preview-row"><span class="curl-preview-label">Body</span><span class="curl-preview-value body-val">${escapeHtml(result.body.length > 300 ? result.body.slice(0,300)+'…' : result.body)}</span></div>`
      : '');

  // Build synthetic entry
  parsedCurlEntry = {
    requestId:       'import-' + Date.now(),
    startedDateTime: new Date().toISOString(),
    startTimestamp:  null,
    request: { method: result.method, url: result.url, headers: result.headers, postData: result.body },
    response:     null,
    responseBody: null,
    time:         null
  };
  document.getElementById('btnDoImport').disabled = false;
});

// Allow Parse on Ctrl+Enter in textarea
document.getElementById('curlInput').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') document.getElementById('btnParseCurl').click();
});

document.getElementById('btnDoImport').addEventListener('click', async () => {
  if (!parsedCurlEntry) return;
  // Add locally
  allEntries.push(parsedCurlEntry);
  // Persist to background
  try { await chrome.runtime.sendMessage({ action: 'importEntry', entry: parsedCurlEntry }); } catch(e) {}
  // Select and show it
  selectedIndex = allEntries.length - 1;
  renderList();
  showDetail(parsedCurlEntry);
  loadTestClient(parsedCurlEntry);
  // Close modal
  document.getElementById('curlImportOverlay').classList.remove('open');
  // Switch to Test Client tab
  document.querySelectorAll('.detail-view-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.detail-view-tab[data-view="testclient"]').classList.add('active');
  document.getElementById('viewCaptured').style.display   = 'none';
  document.getElementById('viewTestClient').style.display = '';
});

// ── Chain Variables ──────────────────────────────────────────────────────────
// chainConfig: per-entry rules stored in chrome.storage
//   req: { headerName: '{{VarName}}' }  → replace this header value at send time
//   res: { headerName: '{{VarName}}' }  → extract this response header into VarName
let chainConfig   = {};   // { requestId: { req:{}, res:{} } }
let chainVarStore = {};   // runtime: { varName: { value, source } } — reset each run

chrome.storage.local.get(['chainConfig'], r => {
  if (r.chainConfig) chainConfig = r.chainConfig;
});

function saveChainConfig() {
  chrome.storage.local.set({ chainConfig });
}

function initChainEntry(requestId) {
  if (!chainConfig[requestId]) chainConfig[requestId] = { req: {}, res: {} };
  if (!chainConfig[requestId].req) chainConfig[requestId].req = {};
  if (!chainConfig[requestId].res) chainConfig[requestId].res = {};
}

// Replace {{VarName}} in any string using chainVarStore, then fall back to manual variables
function applyChainVars(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (chainVarStore[name] !== undefined) return chainVarStore[name].value;
    const v = variables.find(v2 => v2.varName === name && v2.enabled && v2.newValue.trim());
    if (v) return (v.displayPrefix || '') + v.newValue.trim();
    return match; // keep placeholder if still unresolved
  });
}

// Highlight {{VarName}} tokens inside an HTML-escaped string
function highlightChainVars(escapedStr) {
  return escapedStr.replace(/\{\{(\w+)\}\}/g,
    (m) => `<span class="chain-var-token">${m}</span>`);
}

// Collect every {{VarName}} used across all entries (for the live table)
function getAllChainVarNames() {
  const names = new Set();
  allEntries.forEach(e => {
    const scan = str => { if (str) [...String(str).matchAll(/\{\{(\w+)\}\}/g)].forEach(m => names.add(m[1])); };
    scan(e.request.url);
    scan(e.request.postData);
    Object.values(e.request.headers || {}).forEach(scan);
    const cfg = chainConfig[e.requestId];
    if (cfg) {
      Object.values(cfg.req || {}).forEach(scan);
      Object.values(cfg.res || {}).forEach(v => { const m = v.match(/^\{\{(\w+)\}\}$/); if (m) names.add(m[1]); });
    }
  });
  return [...names].sort();
}

// ── Token Variables ──
let variables = []; // [{id, headerName, tokenType, originalValue, varName, newValue, enabled, count}]

const TOKEN_HEADERS = new Set([
  'authorization','x-xsrf-token','x-csrf-token','x-csrf','x-auth-token',
  'x-api-key','x-access-token','x-request-token','x-session-token',
  'x-client-id','x-client-secret','x-app-token','x-user-token'
]);

function detectTokens() {
  const valueCounts = {}; // `${lname}|||${value}` -> Set of requestIds

  allEntries.forEach(entry => {
    const headers = entry.request.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (!value || value.length < 6) return;
      const lname = name.toLowerCase();
      const relevant = TOKEN_HEADERS.has(lname)
        || lname.includes('token') || lname.includes('xsrf') || lname.includes('csrf')
        || (lname.includes('auth') && !lname.includes('method'))
        || (lname === 'cookie' && value.includes('session'));
      if (!relevant) return;
      const k = `${lname}|||${value}`;
      if (!valueCounts[k]) valueCounts[k] = new Set();
      valueCounts[k].add(entry.requestId);
    });
  });

  return Object.entries(valueCounts)
    .filter(([, ids]) => ids.size >= 1)
    .map(([key, ids]) => {
      const sep = key.indexOf('|||');
      const headerName   = key.substring(0, sep);
      const originalValue = key.substring(sep + 3);

      // Determine token type & suggest variable name
      let tokenType = 'Custom';
      let varName   = headerName.replace(/^x-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let displayPrefix = '';
      let displayToken  = originalValue;

      if (headerName === 'authorization') {
        const m = originalValue.match(/^(Bearer|Basic|Token|ApiKey|Api-Key)\s+(.+)$/i);
        if (m) {
          tokenType    = m[1];
          varName      = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + 'Token';
          displayPrefix = m[1] + ' ';
          displayToken  = m[2];
        } else {
          tokenType = 'Auth'; varName = 'authToken';
        }
      } else if (headerName.includes('xsrf') || headerName.includes('csrf')) {
        tokenType = 'XSRF/CSRF'; varName = 'csrfToken';
      } else if (headerName.includes('api') && headerName.includes('key')) {
        tokenType = 'API Key'; varName = 'apiKey';
      } else if (headerName === 'cookie') {
        tokenType = 'Cookie'; varName = 'sessionCookie';
      }

      // Restore existing variable config if re-scanning
      const existing = variables.find(v => v.id === key);

      return {
        id: key,
        headerName,
        tokenType,
        originalValue,
        displayPrefix,  // e.g. "Bearer " — kept when substituting
        displayToken,   // the part after the prefix
        varName:   existing ? existing.varName   : varName,
        newValue:  existing ? existing.newValue  : '',
        enabled:   existing ? existing.enabled   : true,
        count: ids.size
      };
    })
    .sort((a, b) => b.count - a.count);
}

function renderVarsPanel() {
  const body  = document.getElementById('varsBody');
  const empty = document.getElementById('varsEmpty');

  if (variables.length === 0) {
    empty.style.display = '';
    body.querySelectorAll('.var-row').forEach(r => r.remove());
    document.getElementById('varsSummary').textContent = '';
    updateVarsBadge();
    return;
  }

  empty.style.display = 'none';

  // Remove old rows and re-render
  body.querySelectorAll('.var-row').forEach(r => r.remove());

  variables.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'var-row';
    row.dataset.i = i;

    const truncOrig = v.displayToken.length > 52
      ? v.displayToken.substring(0, 22) + '…' + v.displayToken.slice(-18)
      : v.displayToken;

    row.innerHTML =
      `<div class="var-check-cell">` +
        `<input type="checkbox" ${v.enabled ? 'checked' : ''} data-i="${i}" class="var-en-check" />` +
      `</div>` +
      `<div class="var-info-cell">` +
        `<span class="var-header-name">${escapeHtml(v.headerName)}</span>` +
        `<span class="var-token-type">${escapeHtml(v.tokenType)}</span>` +
        `<span class="var-count">Used in ${v.count} request${v.count !== 1 ? 's' : ''}</span>` +
      `</div>` +
      `<div class="var-original-cell">` +
        `<span class="var-original-label">Captured value${v.displayPrefix ? ' (token part)' : ''}</span>` +
        `<span class="var-original-val" title="${escapeHtml(v.displayToken)}">${escapeHtml(v.displayPrefix)}${escapeHtml(truncOrig)}</span>` +
      `</div>` +
      `<div class="var-override-cell">` +
        `<div class="var-name-row">` +
          `<span class="var-name-prefix">$</span>` +
          `<input class="var-name-input" data-i="${i}" data-field="varName" value="${escapeHtml(v.varName)}" placeholder="variableName" />` +
        `</div>` +
        `<input class="var-value-input" data-i="${i}" data-field="newValue"` +
          ` value="${escapeHtml(v.newValue)}"` +
          ` placeholder="New ${v.tokenType} value to inject…" />` +
      `</div>`;

    body.appendChild(row);
  });

  // Event listeners
  body.querySelectorAll('.var-en-check').forEach(chk => {
    chk.addEventListener('change', () => {
      variables[parseInt(chk.dataset.i)].enabled = chk.checked;
      updateVarsSummary();
    });
  });
  body.querySelectorAll('.var-name-input, .var-value-input').forEach(inp => {
    inp.addEventListener('input', () => {
      variables[parseInt(inp.dataset.i)][inp.dataset.field] = inp.value;
      updateVarsSummary();
    });
  });

  updateVarsSummary();
  updateVarsBadge();
}

function updateVarsSummary() {
  const active = variables.filter(v => v.enabled && v.newValue.trim());
  document.getElementById('varsSummary').textContent =
    active.length > 0
      ? `${active.length} variable${active.length !== 1 ? 's' : ''} will be substituted in Run All`
      : 'Fill in new values below to override tokens during Run All';
}

// ── Chain Rules panel (inside Variables overlay) ──
function renderChainRulesPanel() {
  const container = document.getElementById('chainRulesBody');
  if (!container) return;

  // Collect all rules across all entries
  const rows = [];
  allEntries.forEach(entry => {
    const cfg = chainConfig[entry.requestId];
    if (!cfg) return;
    const name = getName(entry) || (() => { try { return new URL(entry.request.url).pathname; } catch(e) { return entry.request.url; } })();

    Object.entries(cfg.req || {}).forEach(([header, chainExpr]) => {
      const m = chainExpr.match(/^\{\{(\w+)\}\}$/);
      rows.push({ requestId: entry.requestId, mode: 'req', header, varName: m ? m[1] : chainExpr, reqName: name, method: entry.request.method });
    });
    Object.entries(cfg.res || {}).forEach(([header, chainExpr]) => {
      const m = chainExpr.match(/^\{\{(\w+)\}\}$/);
      rows.push({ requestId: entry.requestId, mode: 'res', header, varName: m ? m[1] : chainExpr, reqName: name, method: entry.request.method });
    });
  });

  if (rows.length === 0) {
    container.innerHTML = '<div class="chain-rules-empty">No chain rules defined yet.<br><span style="color:#555;font-size:12px">Click the <strong>+</strong> button next to any request/response header in the detail panel to create a rule.</span></div>';
    return;
  }

  container.innerHTML = rows.map((row, i) => {
    const modeLabel = row.mode === 'res'
      ? `<span class="chain-mode-badge chain-mode-res">EXTRACT</span>`
      : `<span class="chain-mode-badge chain-mode-req">INJECT</span>`;
    const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(row.method) ? `method-${row.method}` : 'method-OTHER';
    return `<div class="chain-rule-row" data-i="${i}">` +
      `<div class="chain-rule-left">` +
        `${modeLabel}` +
        `<span class="chain-rule-header"><code>${escapeHtml(row.header)}</code></span>` +
        `<span class="chain-rule-arrow">${row.mode === 'res' ? '→' : '←'}</span>` +
        `<span class="chain-var-token">{{${escapeHtml(row.varName)}}}</span>` +
      `</div>` +
      `<div class="chain-rule-right">` +
        `<span class="method-badge ${methodClass}" style="font-size:10px;padding:2px 4px">${escapeHtml(row.method)}</span>` +
        `<span class="chain-rule-req-name" title="${escapeHtml(row.reqName)}">${escapeHtml(row.reqName.length > 40 ? row.reqName.substring(0, 38) + '…' : row.reqName)}</span>` +
        `<button class="btn chain-rule-del" data-ri="${escapeHtml(row.requestId)}" data-mode="${row.mode}" data-hdr="${escapeHtml(row.header)}" title="Delete rule">✕</button>` +
      `</div>` +
    `</div>`;
  }).join('');

  container.querySelectorAll('.chain-rule-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid  = btn.dataset.ri;
      const mode = btn.dataset.mode;
      const hdr  = btn.dataset.hdr;
      if (chainConfig[rid] && chainConfig[rid][mode]) {
        delete chainConfig[rid][mode][hdr];
        saveChainConfig();
        renderChainRulesPanel();
        updateChainBadge();
      }
    });
  });
}

// ── Live Variables table ──
function renderLiveVarsTable() {
  const container = document.getElementById('liveVarsBody');
  if (!container) return;

  const varNames = getAllChainVarNames();
  if (varNames.length === 0) {
    container.innerHTML = '<div class="chain-rules-empty">No {{VarName}} tokens found.<br><span style="color:#555;font-size:12px">Define chain rules on response headers to populate this table during Run All.</span></div>';
    return;
  }

  container.innerHTML = `
    <table class="live-vars-table">
      <thead><tr><th>Variable</th><th>Current Value</th><th>Source</th></tr></thead>
      <tbody>${varNames.map(name => {
        const stored = chainVarStore[name];
        // Also check manual variables
        const manual = variables.find(v => v.varName === name && v.enabled && v.newValue.trim());
        let valueHtml, sourceHtml;
        if (stored) {
          valueHtml  = `<span class="live-var-value">${escapeHtml(stored.value.length > 60 ? stored.value.substring(0, 58) + '…' : stored.value)}</span>`;
          sourceHtml = `<span class="live-var-source" title="${escapeHtml(stored.source)}">Response header</span>`;
        } else if (manual) {
          valueHtml  = `<span class="live-var-value" style="color:#888">${escapeHtml((manual.displayPrefix||'') + manual.newValue.trim())}</span>`;
          sourceHtml = `<span class="live-var-source">Manual variable</span>`;
        } else {
          valueHtml  = `<span class="live-var-unset">— not yet set —</span>`;
          sourceHtml = `<span class="live-var-source" style="color:#555">Awaiting Run All</span>`;
        }
        return `<tr><td><span class="chain-var-token">{{${escapeHtml(name)}}}</span></td><td>${valueHtml}</td><td>${sourceHtml}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
}

function updateVarsBadge() {
  const btn = document.getElementById('btnVariables');
  const active = variables.filter(v => v.enabled && v.newValue.trim()).length;
  // Remove old badge
  btn.querySelectorAll('.var-badge').forEach(b => b.remove());
  if (active > 0) {
    const badge = document.createElement('span');
    badge.className = 'var-badge';
    badge.textContent = active;
    btn.appendChild(badge);
    btn.classList.add('has-vars');
  } else {
    btn.classList.remove('has-vars');
  }
}

// Apply variable substitutions to a headers object before sending
function applyVariables(headers) {
  const activeVars = variables.filter(v => v.enabled && v.newValue.trim());
  if (activeVars.length === 0) return headers;

  const result = {};
  Object.entries(headers).forEach(([name, value]) => {
    const lname = name.toLowerCase();
    const match = activeVars.find(v => v.headerName === lname && v.originalValue === value);
    if (match) {
      // Restore prefix (e.g. "Bearer ") + use new value
      result[name] = match.displayPrefix + match.newValue.trim();
    } else {
      result[name] = value;
    }
  });
  return result;
}

document.getElementById('btnVariables').addEventListener('click', () => {
  document.getElementById('varsOverlay').classList.add('open');
  renderVarsPanel();
  renderChainRulesPanel();
  renderLiveVarsTable();
});

// Vars overlay tab switching
document.querySelectorAll('.vars-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.vars-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.vars-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('vtab-' + tab.dataset.vtab).classList.add('active');
    // Refresh active tab content
    if (tab.dataset.vtab === 'chain') renderChainRulesPanel();
    if (tab.dataset.vtab === 'live')  renderLiveVarsTable();
  });
});

document.getElementById('btnVarsClose').addEventListener('click', () => {
  document.getElementById('varsOverlay').classList.remove('open');
  updateVarsBadge();
});

document.getElementById('btnVarsApply').addEventListener('click', () => {
  document.getElementById('varsOverlay').classList.remove('open');
  updateVarsBadge();
});

document.getElementById('btnScanTokens').addEventListener('click', () => {
  if (allEntries.length === 0) { alert('No captured requests to scan.'); return; }
  variables = detectTokens();
  renderVarsPanel();
  if (variables.length === 0) {
    document.getElementById('varsEmpty').innerHTML =
      '<strong style="color:#888">No auth tokens detected.</strong><br><span style="color:#555;font-size:12px">Make sure your flow includes a login request that returns an Authorization or XSRF token, and that subsequent requests send it in headers.</span>';
    document.getElementById('varsEmpty').style.display = '';
  }
});

// ── URL picker dropdown ──
const urlPickerBtn      = document.getElementById('btnUrlPicker');
const urlPickerDropdown = document.getElementById('urlPickerDropdown');
const urlPickerList     = document.getElementById('urlPickerList');

function openUrlPicker(anchorEl) {
  anchorEl = anchorEl || urlPickerBtn;
  // Build list from allEntries
  if (allEntries.length === 0) {
    urlPickerList.innerHTML = '<div class="url-picker-empty">No captured requests yet.</div>';
  } else {
    urlPickerList.innerHTML = allEntries.map((entry, i) => {
      const method = entry.request.method;
      const url    = entry.request.url;
      const name   = getName(entry);
      const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? `method-${method}` : 'method-OTHER';
      let shortUrl;
      try { const u = new URL(url); shortUrl = u.hostname + u.pathname + u.search; } catch(e) { shortUrl = url; }
      return `<div class="url-picker-item" data-index="${i}">` +
        `<span class="method-badge ${methodClass}" style="font-size:10px;padding:2px 5px">${method}</span>` +
        (name ? `<span class="url-picker-name" title="${escapeHtml(name)}">⬡ ${escapeHtml(name)}</span>` : '') +
        `<span class="url-picker-url" title="${escapeHtml(url)}">${escapeHtml(shortUrl)}</span>` +
      `</div>`;
    }).join('');

    // Click handler for each item
    urlPickerList.querySelectorAll('.url-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        const entry = allEntries[idx];
        // Load into Test Client
        loadTestClient(entry);
        // Also select it in the main list
        selectedIndex = idx;
        showDetail(entry);
        renderList();
        // Switch to Test Client tab
        document.querySelectorAll('.detail-view-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.detail-view-tab[data-view="testclient"]').classList.add('active');
        document.getElementById('viewCaptured').style.display   = 'none';
        document.getElementById('viewTestClient').style.display = '';
        closeUrlPicker();
      });
    });
  }

  // Position dropdown below the button
  const rect = anchorEl.getBoundingClientRect();
  urlPickerDropdown.style.top  = (rect.bottom + 4) + 'px';
  urlPickerDropdown.style.left = Math.max(8, rect.right - 500) + 'px';
  urlPickerDropdown.classList.add('open');
}

function closeUrlPicker() {
  urlPickerDropdown.classList.remove('open');
}

function urlPickerToggle(e) {
  e.stopPropagation();
  if (urlPickerDropdown.classList.contains('open')) {
    closeUrlPicker();
  } else {
    openUrlPicker(e.currentTarget);
  }
}

urlPickerBtn.addEventListener('click', urlPickerToggle);
document.getElementById('btnUrlPickerTop').addEventListener('click', urlPickerToggle);

// Close on outside click
document.addEventListener('click', e => {
  const topBtn = document.getElementById('btnUrlPickerTop');
  if (!urlPickerDropdown.contains(e.target) && e.target !== urlPickerBtn && e.target !== topBtn) {
    closeUrlPicker();
  }
});

// ── Run All ──
let runAllAbort = false;

let pendingRunEntries = [];

document.getElementById('btnRunAll').addEventListener('click', () => {
  const toRun = getVisibleEntries();
  if (toRun.length === 0) { alert('No requests to run.'); return; }
  pendingRunEntries = toRun;
  openRunPanel(toRun);
});

document.getElementById('btnRunStart').addEventListener('click', () => {
  if (pendingRunEntries.length === 0) return;
  const vuCount = Math.max(1, Math.min(100, parseInt(document.getElementById('runVuCount').value) || 1));

  // Hide config, show progress
  document.getElementById('runConfigBar').classList.add('hidden');
  document.getElementById('runProgressWrap').style.display = '';
  document.getElementById('runProgressText').style.display = '';
  document.getElementById('btnRunStart').disabled = true;
  document.getElementById('btnRunStop').style.display = '';
  document.getElementById('btnRunAll').disabled = true;
  // Rebuild rows for multi-user layout if needed
  const multiUser = vuCount > 1;
  const list = document.getElementById('runAllList');
  list.classList.toggle('multi-user', multiUser);
  if (multiUser) {
    list.innerHTML = pendingRunEntries.map((entry, i) => {
      const method = entry.request.method;
      const name   = getName(entry);
      const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? `method-${method}` : 'method-OTHER';
      let shortUrl;
      try { const u = new URL(entry.request.url); shortUrl = u.hostname + u.pathname; } catch(e) { shortUrl = entry.request.url; }
      const label = name ? `⬡ ${name}  ${shortUrl}` : shortUrl;
      return `<div class="run-item" id="run-item-${i}">
        <span class="run-item-num">#${i + 1}</span>
        <span class="method-badge ${methodClass}" style="font-size:10px;padding:2px 5px">${method}</span>
        <span class="run-item-url" title="${escapeHtml(entry.request.url)}">${escapeHtml(label)}</span>
        <span class="run-item-passes" id="run-passes-${i}"><span class="run-icon-pending">○ 0/${vuCount}</span></span>
        <span class="run-item-time" id="run-time-${i}" title="avg response">—</span>
        <span class="run-item-minmax" id="run-minmax-${i}">—</span>
      </div>`;
    }).join('');
  }

  // Update summary line
  const totalOps = pendingRunEntries.length * vuCount;
  const vuLabel = multiUser ? ` · ${vuCount} virtual users` : '';
  const activeVarCount = variables.filter(v => v.enabled && v.newValue.trim()).length;
  const varLabel = activeVarCount > 0 ? ` · ${activeVarCount} var${activeVarCount !== 1 ? 's' : ''}` : '';
  document.getElementById('runAllTitle').textContent = `▶ Running…${vuLabel}${varLabel}`;
  document.getElementById('runStatTotal').textContent =
    multiUser ? `${pendingRunEntries.length} requests × ${vuCount} VUs = ${totalOps} total` : `${pendingRunEntries.length} requests`;
  document.getElementById('runProgressBar').style.width = '0%';
  document.getElementById('runProgressText').textContent = `0 / ${totalOps}`;
  document.getElementById('runMetricsBar').style.display = 'none';

  runAllAbort = false;
  executeRunAll(pendingRunEntries, vuCount);
});

// Show the panel in config state (before run starts)
function openRunPanel(entries) {
  document.getElementById('runConfigBar').classList.remove('hidden');
  document.getElementById('runProgressWrap').style.display = 'none';
  document.getElementById('runProgressText').style.display = 'none';
  document.getElementById('btnRunStart').disabled = false;
  document.getElementById('runAllTitle').textContent = '▶ Run All Requests';
  document.getElementById('runStatTotal').textContent = `${entries.length} request${entries.length !== 1 ? 's' : ''} ready`;
  document.getElementById('runStatPass').style.display = 'none';
  document.getElementById('runStatFail').style.display = 'none';
  document.getElementById('runMetricsBar').style.display = 'none';
  document.getElementById('btnRunStop').style.display = 'none';
  document.getElementById('btnRunAll').disabled = false;
  document.getElementById('runAllList').innerHTML =
    entries.map((entry, i) => {
      const method = entry.request.method;
      const name   = getName(entry);
      const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? `method-${method}` : 'method-OTHER';
      let shortUrl;
      try { const u = new URL(entry.request.url); shortUrl = u.hostname + u.pathname; } catch(e) { shortUrl = entry.request.url; }
      const label = name ? `⬡ ${name}  ${shortUrl}` : shortUrl;
      return `<div class="run-item" id="run-item-${i}">
        <span class="run-item-num">#${i + 1}</span>
        <span class="method-badge ${methodClass}" style="font-size:10px;padding:2px 5px">${method}</span>
        <span class="run-item-url" title="${escapeHtml(entry.request.url)}">${escapeHtml(label)}</span>
        <span class="run-item-status"><span class="run-icon-pending">○</span></span>
        <span class="run-item-time" id="run-time-${i}">—</span>
      </div>`;
    }).join('');
  document.getElementById('runAllOverlay').classList.add('open');
}


function updateRunMetrics(times) {
  if (times.length === 0) return;
  document.getElementById('runMetricsBar').style.display = '';
  const avg   = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min   = Math.min(...times);
  const max   = Math.max(...times);
  const total = times.reduce((a, b) => a + b, 0);
  const sorted = [...times].sort((a, b) => a - b);
  const p95   = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  const fmt   = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
  document.getElementById('metricAvg').textContent   = fmt(avg);
  document.getElementById('metricMin').textContent   = fmt(min);
  document.getElementById('metricMax').textContent   = fmt(max);
  document.getElementById('metricTotal').textContent = fmt(total);
  document.getElementById('metricP95').textContent   = fmt(p95);
}


async function executeRunAll(entries, vuCount) {
  const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
  const multiUser = vuCount > 1;
  const skipHeaders = new Set(['content-length', ':method', ':path', ':scheme', ':authority', 'host', 'connection', 'transfer-encoding']);

  // Per-request aggregates (used in multi-user mode)
  const reqStats = entries.map(() => ({ times: [], passed: 0, failed: 0 }));
  // All times across every VU + request (used for global metrics)
  const allTimes = [];
  let totalDone = 0, totalPassed = 0, totalFailed = 0;
  const totalOps = entries.length * vuCount;

  function refreshProgress() {
    document.getElementById('runProgressBar').style.width = `${(totalDone / totalOps) * 100}%`;
    document.getElementById('runProgressText').textContent = `${totalDone} / ${totalOps}`;
    if (totalPassed > 0) {
      document.getElementById('runStatPass').style.display = '';
      document.getElementById('runStatPass').textContent = `✓ ${totalPassed} passed`;
    }
    if (totalFailed > 0) {
      document.getElementById('runStatFail').style.display = '';
      document.getElementById('runStatFail').textContent = `✗ ${totalFailed} failed`;
    }
    updateRunMetrics(allTimes);
  }

  function refreshRow(i) {
    if (!multiUser) return; // single-user rows use setRunItemStatus directly
    const s = reqStats[i];
    if (s.times.length === 0) return;
    const avg = Math.round(s.times.reduce((a, b) => a + b, 0) / s.times.length);
    const min = Math.min(...s.times);
    const max = Math.max(...s.times);
    const done = s.passed + s.failed;
    const passHtml = `<span class="run-icon-pass">✓ ${s.passed}</span>`;
    const failHtml = s.failed > 0 ? ` <span class="run-icon-fail">✗ ${s.failed}</span>` : '';
    const el = document.getElementById(`run-passes-${i}`);
    const te = document.getElementById(`run-time-${i}`);
    const me = document.getElementById(`run-minmax-${i}`);
    if (el) el.innerHTML = `${passHtml}${failHtml}<span style="color:#555"> /${done}</span>`;
    if (te) te.textContent = `~${fmt(avg)}`;
    if (me) me.textContent = `${fmt(min)} – ${fmt(max)}`;
  }

  // Reset chain var store at run start (so each Run All starts fresh)
  chainVarStore = {};

  // Single virtual user worker — runs all entries in sequence
  async function runVU(vuIdx) {
    for (let i = 0; i < entries.length; i++) {
      if (runAllAbort) break;

      if (!multiUser) setRunItemStatus(i, 'running', '⟳', null);

      const entry = entries[i];
      const method = entry.request.method;

      // Apply chain vars to URL (token variables don't touch URLs, only headers)
      const url = applyChainVars(entry.request.url);

      // Build headers, skipping pseudo-headers, then apply token vars, then chain vars
      let headers = {};
      Object.entries(entry.request.headers || {}).forEach(([k, v]) => {
        if (!skipHeaders.has(k.toLowerCase())) headers[k] = v;
      });
      headers = applyVariables(headers);

      // Apply req-side chain rules: replace header values marked with {{VarName}}
      const reqCfg = (chainConfig[entry.requestId] && chainConfig[entry.requestId].req) || {};
      Object.entries(reqCfg).forEach(([headerName, chainExpr]) => {
        // Find matching header (case-insensitive)
        const matchKey = Object.keys(headers).find(k => k.toLowerCase() === headerName);
        if (matchKey) {
          headers[matchKey] = applyChainVars(chainExpr);
        }
      });

      // Apply chain vars inside header values
      Object.keys(headers).forEach(k => {
        headers[k] = applyChainVars(headers[k]);
      });

      // Apply chain vars to body
      let body = entry.request.postData || null;
      if (body) body = applyChainVars(body);

      const start = Date.now();
      try {
        const fetchOpts = { method, headers };
        if (body && !['GET','HEAD'].includes(method)) fetchOpts.body = body;
        const res     = await fetch(url, fetchOpts);
        const elapsed = Date.now() - start;
        const ok = res.status < 400;
        reqStats[i].times.push(elapsed);
        if (ok) { reqStats[i].passed++; totalPassed++; } else { reqStats[i].failed++; totalFailed++; }
        allTimes.push(elapsed);

        // Extract res-side chain rules: store response header values into chainVarStore
        const resCfg = (chainConfig[entry.requestId] && chainConfig[entry.requestId].res) || {};
        Object.entries(resCfg).forEach(([headerName, chainExpr]) => {
          const m = chainExpr.match(/^\{\{(\w+)\}\}$/);
          if (!m) return;
          const varName = m[1];
          // res.headers from fetch uses lowercase keys
          const val = res.headers.get(headerName);
          if (val !== null) {
            chainVarStore[varName] = { value: val, source: entry.request.url };
            renderLiveVarsTable(); // update live table in real time
          }
        });

        if (!multiUser) {
          const sc = res.status < 300 ? 'status-2xx' : res.status < 500 ? 'status-4xx' : 'status-5xx';
          setRunItemStatus(i, ok ? 'pass' : 'fail', `<span class="${sc}">${res.status}</span>`, elapsed);
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        reqStats[i].times.push(elapsed);
        reqStats[i].failed++; totalFailed++;
        allTimes.push(elapsed);
        if (!multiUser) setRunItemStatus(i, 'fail', `<span class="run-icon-fail" title="${err.message}">Err</span>`, elapsed);
      }

      totalDone++;
      refreshRow(i);
      refreshProgress();
      if (!multiUser) document.getElementById(`run-item-${i}`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  // Launch all VUs concurrently
  await Promise.all(Array.from({ length: vuCount }, (_, idx) => runVU(idx)));

  const stopped = runAllAbort;
  const vuLabel = multiUser ? ` · ${vuCount} VUs` : '';
  document.getElementById('runAllTitle').textContent = stopped ? '■ Stopped' : `✓ Finished${vuLabel}`;
  document.getElementById('btnRunStop').style.display = 'none';
  document.getElementById('btnRunAll').disabled = false;
}

function setRunItemStatus(i, state, statusHtml, timeMs) {
  const item = document.getElementById(`run-item-${i}`);
  if (!item) return;
  const iconMap = { running: '<span class="run-icon-running">⟳</span>', pass: '<span class="run-icon-pass">✓</span>', fail: '<span class="run-icon-fail">✗</span>' };
  item.querySelector('.run-item-status').innerHTML = iconMap[state] || statusHtml;
  // For pass/fail also show the HTTP status separately
  if (state !== 'running') {
    item.querySelector('.run-item-status').innerHTML = statusHtml;
  }
  if (timeMs !== null) {
    document.getElementById(`run-time-${i}`).textContent = `${timeMs}ms`;
  }
}

document.getElementById('btnRunStop').addEventListener('click', () => {
  runAllAbort = true;
});

document.getElementById('btnRunClose').addEventListener('click', () => {
  runAllAbort = true;
  document.getElementById('runAllOverlay').classList.remove('open');
  document.getElementById('btnRunAll').disabled = false;
  document.getElementById('btnRunStart').disabled = false;
  document.getElementById('runConfigBar').classList.remove('hidden');
});

// ── Dark / Light theme toggle ──
(function initTheme() {
  const STORAGE_KEY = 'uip_theme';
  const btn = document.getElementById('btnThemeToggle');

  function applyTheme(dark) {
    if (dark) {
      document.body.classList.add('dark');
      btn.textContent = '☀️';
      btn.title = 'Switch to light theme';
    } else {
      document.body.classList.remove('dark');
      btn.textContent = '🌙';
      btn.title = 'Switch to dark theme';
    }
  }

  // Restore from storage (use chrome.storage so it persists across extension reloads)
  chrome.storage.local.get([STORAGE_KEY], (r) => {
    applyTheme(r[STORAGE_KEY] === 'dark');
  });

  btn.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark');
    const next = !isDark;
    applyTheme(next);
    chrome.storage.local.set({ [STORAGE_KEY]: next ? 'dark' : 'light' });
  });
})();

// ── Swagger / OpenAPI Importer ────────────────────────────────────────────────

let swaggerParsedEndpoints = []; // array of { method, path, url, summary, tags, headers, body, operationId }

// ── Open / Close ──
document.getElementById('btnImportSwagger').addEventListener('click', () => {
  document.getElementById('swaggerImportOverlay').classList.add('open');
  resetSwaggerUI();
});
document.getElementById('btnSwaggerClose').addEventListener('click', closeSwaggerOverlay);
document.getElementById('btnSwaggerCancel').addEventListener('click', closeSwaggerOverlay);

function closeSwaggerOverlay() {
  document.getElementById('swaggerImportOverlay').classList.remove('open');
}

function resetSwaggerUI() {
  swaggerParsedEndpoints = [];
  document.getElementById('swaggerDropzone').style.display = '';
  document.getElementById('swaggerInfoBar').style.display = 'none';
  document.getElementById('swaggerToolbar').style.display = 'none';
  document.getElementById('swaggerEndpointList').innerHTML = '';
  document.getElementById('swaggerError').style.display = 'none';
  document.getElementById('btnDoSwaggerImport').disabled = true;
  document.getElementById('swaggerFooterHint').textContent = '';
}

// ── File picking ──
document.getElementById('btnSwaggerBrowse').addEventListener('click', () => {
  document.getElementById('swaggerFileInput').click();
});

document.getElementById('swaggerFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleSwaggerFile(file);
  e.target.value = ''; // reset so same file can be re-picked
});

// ── Drag & drop ──
const dropzone = document.getElementById('swaggerDropzone');
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleSwaggerFile(file);
});
dropzone.addEventListener('click', e => {
  if (e.target.id === 'btnSwaggerBrowse') return;
  document.getElementById('swaggerFileInput').click();
});

// ── Read + parse file ──
function handleSwaggerFile(file) {
  const reader = new FileReader();
  reader.onload = evt => {
    const text = evt.target.result;
    let spec;
    try {
      if (file.name.endsWith('.yaml') || file.name.endsWith('.yml')) {
        // js-yaml loaded from CDN; fall back to JSON parse if not available
        spec = (typeof jsyaml !== 'undefined') ? jsyaml.load(text) : JSON.parse(text);
      } else {
        spec = JSON.parse(text);
      }
    } catch (err) {
      showSwaggerError(`Could not parse file: ${err.message}`);
      return;
    }
    parseSwaggerSpec(spec, file.name);
  };
  reader.readAsText(file);
}

// ── Core spec parser ──
function parseSwaggerSpec(spec, filename) {
  document.getElementById('swaggerError').style.display = 'none';

  // Detect version
  const isV3 = !!spec.openapi; // "3.x.x"
  const isV2 = !!spec.swagger; // "2.x"
  if (!isV3 && !isV2) {
    showSwaggerError('Not a recognised OpenAPI/Swagger document (missing "openapi" or "swagger" field).');
    return;
  }

  // Base URL
  let baseUrl = '';
  if (isV3) {
    const servers = spec.servers || [];
    baseUrl = servers.length > 0 ? servers[0].url.replace(/\/$/, '') : '';
    // Resolve relative server URLs
    if (baseUrl.startsWith('/')) baseUrl = window.location.origin + baseUrl;
  } else {
    const scheme  = (spec.schemes && spec.schemes[0]) || 'https';
    const host    = spec.host || 'localhost';
    const base    = (spec.basePath || '/').replace(/\/$/, '');
    baseUrl = `${scheme}://${host}${base}`;
  }

  const title   = (spec.info && spec.info.title)   || filename;
  const version = (spec.info && spec.info.version) || '';
  const paths   = spec.paths || {};

  swaggerParsedEndpoints = [];

  Object.entries(paths).forEach(([path, pathItem]) => {
    const HTTP_METHODS = ['get','post','put','patch','delete','head','options'];
    HTTP_METHODS.forEach(method => {
      const op = pathItem[method];
      if (!op) return;

      const url        = baseUrl + path;
      const summary    = op.summary || op.description || '';
      const tags       = op.tags || [];
      const operationId = op.operationId || '';

      // Build default request headers
      const headers = { 'Accept': 'application/json' };

      // Determine content-type & body
      let body = null;
      if (isV3) {
        const rb = op.requestBody;
        if (rb && rb.content) {
          const jsonContent = rb.content['application/json'];
          const formContent = rb.content['application/x-www-form-urlencoded'];
          if (jsonContent) {
            headers['Content-Type'] = 'application/json';
            const schema = jsonContent.schema || (jsonContent.schema && jsonContent.schema['$ref'] ? resolveRef(spec, jsonContent.schema['$ref']) : null);
            body = schema ? JSON.stringify(sampleFromSchema(spec, schema), null, 2) : '{}';
          } else if (formContent) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            const schema = formContent.schema;
            body = schema ? buildFormBody(spec, schema) : '';
          }
        }
      } else {
        // v2: body param
        const params = op.parameters || pathItem.parameters || [];
        const bodyParam = params.find(p => p.in === 'body');
        const formParams = params.filter(p => p.in === 'formData');
        const consumes = op.consumes || spec.consumes || ['application/json'];
        if (bodyParam) {
          headers['Content-Type'] = consumes[0] || 'application/json';
          const schema = bodyParam.schema || {};
          body = JSON.stringify(sampleFromSchema(spec, schema), null, 2);
        } else if (formParams.length > 0) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = formParams.map(p => `${encodeURIComponent(p.name)}=${encodeURIComponent(p['x-example'] || p.default || '')}`).join('&');
        }
      }

      // Add security headers as placeholders
      const secReqs = op.security || spec.security || [];
      secReqs.forEach(secReq => {
        Object.keys(secReq).forEach(schemeName => {
          const secDefs = isV3
            ? (spec.components && spec.components.securitySchemes && spec.components.securitySchemes[schemeName])
            : (spec.securityDefinitions && spec.securityDefinitions[schemeName]);
          if (!secDefs) return;
          if (secDefs.type === 'apiKey' && secDefs.in === 'header') {
            headers[secDefs.name] = `{{${schemeName}}}`;
          } else if (secDefs.type === 'http' && secDefs.scheme === 'bearer') {
            headers['Authorization'] = `{{${schemeName}}}`;
          } else if (secDefs.type === 'oauth2' || secDefs.type === 'apiKey') {
            headers['Authorization'] = `{{${schemeName}}}`;
          }
        });
      });

      swaggerParsedEndpoints.push({ method: method.toUpperCase(), path, url, summary, tags, headers, body, operationId });
    });
  });

  if (swaggerParsedEndpoints.length === 0) {
    showSwaggerError('No operations found in this spec.');
    return;
  }

  // Show info bar
  document.getElementById('swaggerDropzone').style.display = 'none';
  const infoBar = document.getElementById('swaggerInfoBar');
  infoBar.style.display = 'flex';
  document.getElementById('swaggerInfoTitle').textContent = title;
  document.getElementById('swaggerInfoVersion').textContent = `v${version}`;
  document.getElementById('swaggerInfoBase').textContent = baseUrl || '(relative)';
  document.getElementById('swaggerInfoCount').textContent = `${swaggerParsedEndpoints.length} endpoint${swaggerParsedEndpoints.length !== 1 ? 's' : ''}`;

  document.getElementById('swaggerToolbar').style.display = 'flex';
  document.getElementById('swaggerSearch').value = '';
  document.getElementById('swaggerMethodFilter').value = '';
  renderSwaggerEndpoints();
}

// ── Render endpoint checkboxes ──
function renderSwaggerEndpoints() {
  const list   = document.getElementById('swaggerEndpointList');
  const search = document.getElementById('swaggerSearch').value.toLowerCase();
  const mf     = document.getElementById('swaggerMethodFilter').value;

  list.innerHTML = swaggerParsedEndpoints.map((ep, i) => {
    const hidden = (mf && ep.method !== mf) || (search && !(ep.path.toLowerCase().includes(search) || ep.summary.toLowerCase().includes(search) || ep.tags.some(t => t.toLowerCase().includes(search))));
    const methodClass = ['GET','POST','PUT','DELETE','PATCH'].includes(ep.method) ? `method-${ep.method}` : 'method-OTHER';
    const bodyHint = ep.body ? `<div class="swagger-ep-body-hint">✚ request body generated</div>` : '';
    const tagsHtml = ep.tags.length ? `<div class="swagger-ep-tags">${ep.tags.map(t => `<span class="swagger-ep-tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
    return `<div class="swagger-ep-row ${hidden ? 'ep-hidden' : ''}" data-i="${i}">` +
      `<input type="checkbox" class="swagger-ep-check" data-i="${i}" checked />` +
      `<div class="swagger-ep-left">` +
        `<div><span class="method-badge ${methodClass}" style="font-size:10px;padding:2px 5px;margin-right:6px">${ep.method}</span>` +
        `<span class="swagger-ep-path">${escapeHtml(ep.path)}</span></div>` +
        (ep.summary ? `<div class="swagger-ep-summary">${escapeHtml(ep.summary)}</div>` : '') +
        tagsHtml +
        bodyHint +
      `</div>` +
    `</div>`;
  }).join('');

  // Row click toggles checkbox
  list.querySelectorAll('.swagger-ep-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('swagger-ep-check')) return;
      const chk = row.querySelector('.swagger-ep-check');
      chk.checked = !chk.checked;
      updateSwaggerFooter();
    });
  });
  list.querySelectorAll('.swagger-ep-check').forEach(chk => {
    chk.addEventListener('change', updateSwaggerFooter);
  });

  updateSwaggerFooter();
  updateSwaggerSelectAll();
}

function updateSwaggerFooter() {
  const checked = document.querySelectorAll('.swagger-ep-check:checked').length;
  document.getElementById('swaggerFooterHint').textContent = `${checked} endpoint${checked !== 1 ? 's' : ''} selected`;
  document.getElementById('btnDoSwaggerImport').disabled = checked === 0;
  updateSwaggerSelectAll();
}

function updateSwaggerSelectAll() {
  const all     = document.querySelectorAll('.swagger-ep-check');
  const checked = document.querySelectorAll('.swagger-ep-check:checked');
  const sa = document.getElementById('swaggerSelectAll');
  sa.checked       = all.length > 0 && checked.length === all.length;
  sa.indeterminate = checked.length > 0 && checked.length < all.length;
}

// Select-all checkbox
document.getElementById('swaggerSelectAll').addEventListener('change', e => {
  document.querySelectorAll('.swagger-ep-check').forEach(c => { c.checked = e.target.checked; });
  updateSwaggerFooter();
});

// Search + method filter
document.getElementById('swaggerSearch').addEventListener('input', renderSwaggerEndpoints);
document.getElementById('swaggerMethodFilter').addEventListener('change', renderSwaggerEndpoints);

// ── Import selected ──
document.getElementById('btnDoSwaggerImport').addEventListener('click', async () => {
  const checkedIdxs = [...document.querySelectorAll('.swagger-ep-check:checked')].map(c => parseInt(c.dataset.i));
  if (checkedIdxs.length === 0) return;

  const now = Date.now();
  const newEntries = checkedIdxs.map((idx, i) => {
    const ep = swaggerParsedEndpoints[idx];
    return {
      requestId:       `swagger-${now}-${i}`,
      startedDateTime: new Date().toISOString(),
      startTimestamp:  null,
      request: {
        method:   ep.method,
        url:      ep.url,
        headers:  ep.headers,
        postData: ep.body || null
      },
      response:     null,
      responseBody: null,
      time:         null
    };
  });

  // Name the imported entries with operationId or path+method
  newEntries.forEach((entry, i) => {
    const ep = swaggerParsedEndpoints[checkedIdxs[i]];
    const name = ep.operationId || `${ep.method} ${ep.path}`;
    saveName(entry.requestId, name);
  });

  // Add to local list and persist
  for (const entry of newEntries) {
    allEntries.push(entry);
    try { await chrome.runtime.sendMessage({ action: 'importEntry', entry }); } catch(e) {}
  }

  renderList();
  selectedIndex = allEntries.length - 1;
  showDetail(allEntries[allEntries.length - 1]);
  closeSwaggerOverlay();
});

// ── Schema sample generator ──
function resolveRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return {};
  const parts = ref.replace('#/', '').split('/');
  let node = spec;
  for (const p of parts) { node = node && node[p]; }
  return node || {};
}

function sampleFromSchema(spec, schema, depth = 0) {
  if (!schema || depth > 4) return null;
  // Resolve $ref
  if (schema['$ref']) schema = resolveRef(spec, schema['$ref']);

  const type = schema.type || (schema.properties ? 'object' : schema.items ? 'array' : null);

  if (schema.example !== undefined) return schema.example;
  if (schema.default  !== undefined) return schema.default;
  if (schema.enum     && schema.enum.length > 0) return schema.enum[0];

  switch (type) {
    case 'object': {
      const obj = {};
      const props = schema.properties || {};
      Object.entries(props).forEach(([k, v]) => { obj[k] = sampleFromSchema(spec, v, depth + 1); });
      if (schema.additionalProperties && Object.keys(obj).length === 0) obj['key'] = 'value';
      return obj;
    }
    case 'array': {
      const item = sampleFromSchema(spec, schema.items || {}, depth + 1);
      return item !== null ? [item] : [];
    }
    case 'integer':
    case 'number':  return 0;
    case 'boolean': return false;
    case 'string': {
      const fmt = schema.format;
      if (fmt === 'date-time') return new Date().toISOString();
      if (fmt === 'date')      return new Date().toISOString().split('T')[0];
      if (fmt === 'uuid')      return '00000000-0000-0000-0000-000000000000';
      if (fmt === 'email')     return 'user@example.com';
      if (fmt === 'uri')       return 'https://example.com';
      if (schema.minLength)    return 'a'.repeat(schema.minLength);
      return 'string';
    }
    default: return null;
  }
}

function buildFormBody(spec, schema) {
  const sample = sampleFromSchema(spec, schema) || {};
  return Object.entries(sample).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function showSwaggerError(msg) {
  const el = document.getElementById('swaggerError');
  el.textContent = msg;
  el.style.display = '';
  document.getElementById('btnDoSwaggerImport').disabled = true;
}

// Initial load + periodic refresh
loadEntries();
setInterval(loadEntries, 3000);
