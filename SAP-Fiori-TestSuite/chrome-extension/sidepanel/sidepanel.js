/**
 * chrome-extension/sidepanel/sidepanel.js
 *
 * Controller for the docked side panel.
 * Same recording controls as the popup, plus a live scrollable request feed
 * that updates every second while recording so the user can see traffic
 * arriving in real time without leaving the SAP Fiori page.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

async function msg(payload) {
  return chrome.runtime.sendMessage(payload);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtMs(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function speedClass(ms) {
  if (ms <= 200) return 'fast';
  if (ms <= 1000) return 'mid';
  return 'slow';
}

function statusClass(s) {
  if (s >= 200 && s < 300) return 'ok';
  if (s >= 300 && s < 400) return 'redir';
  return 'err';
}

/** Shorten a URL to just the last meaningful path segment + query indicator. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const leaf  = parts[parts.length - 1] || u.hostname;
    const qs    = u.search ? '?' : '';
    // Show last 2 segments for OData paths like /sap/opu/odata/SRV/EntitySet
    const context = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : `/${leaf}`;
    return context + qs;
  } catch {
    return url.slice(0, 60);
  }
}

function showToast(text, type = '') {
  const t = document.createElement('div');
  t.className   = `toast ${type}`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ── State ────────────────────────────────────────────────────────────────────

let pollTimer        = null;
let enteringNewBlock = false;
let feedCollapsed    = false;
let lastEntryCount   = 0;   // used to detect new requests without full re-render

// ── Feed rendering ───────────────────────────────────────────────────────────

function renderFeed(entries, total) {
  const list  = $('feedList');
  const empty = $('feedEmpty');

  $('totalBadge').textContent = String(total);

  if (!entries.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  // Only re-render if entries changed (avoid scroll-jump on every poll)
  if (entries.length === lastEntryCount) return;
  lastEntryCount = entries.length;

  list.innerHTML = '';
  for (const e of entries) {
    const method  = e.request?.method ?? '?';
    const status  = e.response?.status ?? 0;
    const timeMs  = e.time ?? 0;
    const block   = e._functionalBlock ?? '';

    const row = document.createElement('div');
    row.className = 'feed-row';
    row.title     = e.request?.url ?? '';
    row.innerHTML = `
      <span class="feed-method ${escHtml(method)}">${escHtml(method)}</span>
      <span class="feed-status ${statusClass(status)}">${status || '—'}</span>
      <span class="feed-url">${escHtml(shortUrl(e.request?.url ?? ''))}</span>
      <span class="feed-time ${speedClass(timeMs)}">${fmtMs(timeMs)}</span>
      <span class="feed-block">${escHtml(block)}</span>
    `;
    list.appendChild(row);
  }

  // Auto-scroll to top (newest entry) only when user is near the top
  const wrap = $('feedWrap');
  if (wrap.scrollTop < 60) wrap.scrollTop = 0;
}

// ── Block summary ─────────────────────────────────────────────────────────────

function renderSummary(blocks, currentBlock, recording) {
  const tbody = $('summaryBody');
  tbody.innerHTML = '';

  if (!blocks.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="padding:12px">No data yet.</td></tr>';
    return;
  }

  for (const row of blocks) {
    const tr = document.createElement('tr');
    if (recording && row.block === currentBlock) tr.classList.add('active-block');

    tr.innerHTML = `
      <td class="cell-block" title="${escHtml(row.block)}">${escHtml(row.block)}</td>
      <td class="cell-num">${row.requestCount}</td>
      <td class="cell-num cell-status-ok">${row.successCount}</td>
      <td class="cell-num cell-status-err">${row.failCount > 0 ? row.failCount : '<span style="color:var(--text-dim)">0</span>'}</td>
      <td class="cell-num">${fmtMs(row.totalMs)}</td>
      <td class="cell-num ${speedClass(row.avgMs) === 'fast' ? 'cell-fast' : speedClass(row.avgMs) === 'mid' ? 'cell-mid' : 'cell-slow'}">${fmtMs(row.avgMs)}</td>
    `;
    tr.addEventListener('click', () => { $('blockFilter').value = row.block; });
    tbody.appendChild(tr);
  }
}

// ── Full render ───────────────────────────────────────────────────────────────

function renderState(state, feedData) {
  const { recording, currentBlock, blocks = [] } = state;
  const entries = feedData?.entries ?? [];
  const total   = feedData?.total   ?? state.entryCount ?? 0;

  // Header badge
  const badge = $('statusBadge');
  badge.textContent = recording ? 'Recording' : 'Idle';
  badge.className   = `status-badge ${recording ? 'recording' : 'idle'}`;

  // Block bar
  $('currentBlockBar').classList.toggle('hidden', !recording);
  $('currentBlockLabel').textContent = currentBlock ?? '—';
  $('liveCount').textContent         = total ? `${total} req` : '';

  // Buttons
  $('startBtn').classList.toggle('hidden',    recording);
  $('reloadBtn').classList.toggle('hidden',   recording);
  $('stopBtn').classList.toggle('hidden',     !recording);
  $('newBlockBtn').classList.toggle('hidden', !recording);

  // Input — leave alone while user is typing a new block name
  if (!enteringNewBlock) {
    const input = $('blockNameInput');
    if (recording) {
      input.value       = currentBlock ?? '';
      input.disabled    = true;
      input.placeholder = 'Currently recording…';
    } else {
      input.disabled    = false;
      input.placeholder = 'Block name  (e.g. Login)';
    }
  }

  // Block filter dropdown
  const sel     = $('blockFilter');
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">All blocks</option>';
  for (const row of blocks) {
    const opt       = document.createElement('option');
    opt.value       = row.block;
    opt.textContent = row.block;
    sel.appendChild(opt);
  }
  if (prevVal) sel.value = prevVal;

  // Feed + summary
  renderFeed(entries, total);
  renderSummary(feedData?.blocks ?? blocks, currentBlock, recording);
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const filters  = getFilters();
    const [state, feedData] = await Promise.all([
      msg({ type: 'GET_STATE' }),
      msg({ type: 'GET_RECENT_ENTRIES', limit: 150, filters }),
    ]);
    if (state) renderState(state, feedData);
  } catch (err) {
    console.warn('[Panel] refresh failed:', err.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 1000);   // 1 s for the live feed
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── Filters ───────────────────────────────────────────────────────────────────

const STATUS_RANGES = {
  '2xx': { min: 200, max: 299 },
  '3xx': { min: 300, max: 399 },
  '4xx': { min: 400, max: 499 },
  '5xx': { min: 500, max: 599 },
  '0xx': { min: 0,   max:   0 },
};

function getFilters() {
  const ranges = [...document.querySelectorAll('.status-cb:checked')]
    .map(cb => STATUS_RANGES[cb.value]).filter(Boolean);
  return {
    urlPattern:   $('urlFilter').value.trim() || null,
    statusRanges: ranges,
    blocks:       $('blockFilter').value ? [$('blockFilter').value] : [],
  };
}

// ── Event listeners ───────────────────────────────────────────────────────────

async function startRec(reload = false) {
  const name = $('blockNameInput').value.trim() || 'Block 1';
  lastEntryCount = 0;
  const res = await msg({ type: 'START_RECORDING', blockName: name, reload });
  if (res?.success) {
    showToast(reload ? `⟳ Reloading tab — recording "${name}"` : `Recording "${name}"`, 'success');
    startPolling();
  } else {
    showToast(res?.error ?? 'Failed to start', 'error');
  }
  await refresh();
}

$('startBtn').addEventListener('click',  () => startRec(false));
$('reloadBtn').addEventListener('click', () => startRec(true));

$('stopBtn').addEventListener('click', async () => {
  const res = await msg({ type: 'STOP_RECORDING' });
  if (res?.success) {
    showToast('Recording stopped', 'success');
    stopPolling();
  } else {
    showToast(res?.error ?? 'Failed to stop', 'error');
  }
  await refresh();
});

$('newBlockBtn').addEventListener('click', () => {
  if (enteringNewBlock) return;
  enteringNewBlock = true;
  stopPolling();

  const input       = $('blockNameInput');
  input.disabled    = false;
  input.value       = '';
  input.placeholder = 'New block name — press Enter';
  input.focus();
});

$('blockNameInput').addEventListener('keydown', async (e) => {
  if (!enteringNewBlock) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const name = $('blockNameInput').value.trim();
    if (!name) { showToast('Block name cannot be empty.', 'error'); return; }
    enteringNewBlock = false;
    const res = await msg({ type: 'NEW_BLOCK', blockName: name });
    showToast(res?.success ? `Block → "${name}"` : (res?.error ?? 'Failed'), res?.success ? 'success' : 'error');
    await refresh();
    startPolling();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    enteringNewBlock = false;
    await refresh();
    startPolling();
  }
});

$('exportBtn').addEventListener('click', async () => {
  const res = await msg({ type: 'EXPORT_HAR', filters: getFilters() });
  if (!res?.har) { showToast('Nothing to export.', 'error'); return; }
  const blob = new Blob([res.har], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `sap-recording-${Date.now()}.har` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('HAR exported', 'success');
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all recorded entries?')) return;
  lastEntryCount = 0;
  await msg({ type: 'CLEAR_ALL' });
  showToast('Cleared', '');
  await refresh();
});

// Feed collapse toggle
$('feedToggle').addEventListener('click', () => {
  feedCollapsed = !feedCollapsed;
  $('feedWrap').style.display  = feedCollapsed ? 'none' : '';
  $('feedToggle').textContent  = feedCollapsed ? '▶' : '▼';
  $('feedToggle').title        = feedCollapsed ? 'Expand feed' : 'Collapse feed';
});

// Summary collapse toggle
$('summaryToggle').addEventListener('click', () => {
  const wrap    = $('summaryWrap');
  const chevron = $('summaryChevron');
  const open    = !wrap.classList.contains('collapsed');
  wrap.classList.toggle('collapsed', open);
  chevron.textContent = open ? '▶' : '▼';
});

// Filter section toggle
$('filterToggle').addEventListener('click', () => {
  const body    = $('filterBody');
  const chevron = $('filterChevron');
  const open    = !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', open);
  chevron.textContent = open ? '▶' : '▼';
});

// Re-fetch on filter changes
document.querySelectorAll('.status-cb, #blockFilter')
  .forEach(el => el.addEventListener('change', refresh));
$('urlFilter').addEventListener('input', refresh);

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await refresh();
  const state = await msg({ type: 'GET_STATE' });
  if (state?.recording) startPolling();
})();

window.addEventListener('unload', stopPolling);
