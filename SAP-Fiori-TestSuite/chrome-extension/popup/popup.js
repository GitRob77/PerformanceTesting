/**
 * chrome-extension/popup/popup.js
 *
 * Popup controller for the SAP Fiori HTTP Recorder.
 *
 * Communicates with background.js via chrome.runtime.sendMessage.
 * Polls the background every 2 s while recording to show live updates.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

async function msg(payload) {
  return chrome.runtime.sendMessage(payload);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Return CSS class name based on avg response time thresholds. */
function speedClass(ms) {
  if (ms <= 200) return 'cell-fast';
  if (ms <= 1000) return 'cell-mid';
  return 'cell-slow';
}

function showToast(text, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ── State ────────────────────────────────────────────────────────────────────

let pollTimer        = null;
let enteringNewBlock = false;  // true while user is typing a new block name

// ── Render ───────────────────────────────────────────────────────────────────

function renderState(state) {
  const { recording, currentBlock, entryCount, blocks = [] } = state;

  // Status badge
  const badge = $('statusBadge');
  badge.textContent = recording ? 'Recording' : 'Idle';
  badge.className   = `status-badge ${recording ? 'recording' : 'idle'}`;

  // Current-block bar
  $('currentBlockBar').classList.toggle('hidden', !recording);
  $('currentBlockLabel').textContent = currentBlock ?? '—';

  // Button visibility
  $('startBtn').classList.toggle('hidden',    recording);
  $('stopBtn').classList.toggle('hidden',     !recording);
  $('newBlockBtn').classList.toggle('hidden', !recording);

  // Block name input — leave it alone while the user is entering a new block name
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

  // Total requests badge
  $('totalBadge').textContent = `${entryCount ?? 0} request${entryCount === 1 ? '' : 's'}`;

  // Block filter dropdown — preserve current selection
  const sel      = $('blockFilter');
  const prevVal  = sel.value;
  sel.innerHTML  = '<option value="">All blocks</option>';
  for (const row of blocks) {
    const opt = document.createElement('option');
    opt.value       = row.block;
    opt.textContent = row.block;
    sel.appendChild(opt);
  }
  if (prevVal) sel.value = prevVal;

  // Summary table
  renderTable(blocks, currentBlock, recording);
}

function renderTable(blocks, currentBlock, recording) {
  const empty    = $('emptyState');
  const tableWrap = $('tableWrap');
  const tbody    = $('summaryBody');

  if (!blocks.length) {
    empty.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  tableWrap.classList.remove('hidden');

  tbody.innerHTML = '';

  for (const row of blocks) {
    const tr = document.createElement('tr');

    // Highlight the currently-active recording block
    if (recording && row.block === currentBlock) {
      tr.classList.add('active-block');
    }

    const avgClass = speedClass(row.avgMs);

    tr.innerHTML = `
      <td class="cell-block" title="${escHtml(row.block)}">${escHtml(row.block)}</td>
      <td class="cell-num">${row.requestCount}</td>
      <td class="cell-num cell-status-ok">${row.successCount}</td>
      <td class="cell-num cell-status-err">${row.failCount > 0 ? row.failCount : '<span style="color:var(--text-dim)">0</span>'}</td>
      <td class="cell-num">${fmtMs(row.totalMs)}</td>
      <td class="cell-num ${avgClass}">${fmtMs(row.avgMs)}</td>
    `;

    // Click a row to filter by that block
    tr.addEventListener('click', () => {
      $('blockFilter').value = row.block;
    });

    tbody.appendChild(tr);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const state = await msg({ type: 'GET_STATE' });
    if (state) renderState(state);
  } catch (err) {
    // Background may not be ready yet on first open
    console.warn('[Popup] GET_STATE failed:', err.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 2000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── Filters ──────────────────────────────────────────────────────────────────

const STATUS_RANGES = {
  '2xx': { min: 200, max: 299 },
  '3xx': { min: 300, max: 399 },
  '4xx': { min: 400, max: 499 },
  '5xx': { min: 500, max: 599 },
  '0xx': { min: 0,   max:   0 },
};

function getFilters() {
  const checkedRanges = [...document.querySelectorAll('.status-cb:checked')]
    .map(cb => STATUS_RANGES[cb.value])
    .filter(Boolean);

  return {
    urlPattern:   $('urlFilter').value.trim() || null,
    statusRanges: checkedRanges,
    blocks:       $('blockFilter').value ? [$('blockFilter').value] : [],
  };
}

// ── Event listeners ───────────────────────────────────────────────────────────

$('startBtn').addEventListener('click', async () => {
  const blockName = $('blockNameInput').value.trim() || 'Block 1';
  const res = await msg({ type: 'START_RECORDING', blockName });
  if (res?.success) {
    showToast(`Recording "${blockName}"`, 'success');
    startPolling();
  } else {
    showToast(res?.error ?? 'Failed to start', 'error');
  }
  await refresh();
});

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
  if (enteringNewBlock) return;          // already waiting for input
  enteringNewBlock = true;
  stopPolling();                         // prevent renderState from re-disabling the field

  const input = $('blockNameInput');
  input.disabled    = false;
  input.value       = '';
  input.placeholder = 'New block name — press Enter';
  input.focus();
});

// Single permanent keydown handler on the input for new-block entry mode
$('blockNameInput').addEventListener('keydown', async (e) => {
  if (!enteringNewBlock) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    const name = $('blockNameInput').value.trim();
    if (!name) {
      showToast('Block name cannot be empty.', 'error');
      return;
    }
    enteringNewBlock = false;
    const res = await msg({ type: 'NEW_BLOCK', blockName: name });
    if (res?.success) {
      showToast(`Block → "${name}"`, 'success');
    } else {
      showToast(res?.error ?? 'Failed to switch block', 'error');
    }
    await refresh();
    startPolling();

  } else if (e.key === 'Escape') {
    e.preventDefault();
    enteringNewBlock = false;
    await refresh();    // restores input to disabled + current block name
    startPolling();
  }
});

$('exportBtn').addEventListener('click', async () => {
  const filters = getFilters();
  const res     = await msg({ type: 'EXPORT_HAR', filters });
  if (!res?.har) {
    showToast('Nothing to export.', 'error');
    return;
  }
  const blob = new Blob([res.har], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sap-recording-${Date.now()}.har`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('HAR exported', 'success');
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all recorded entries?')) return;
  await msg({ type: 'CLEAR_ALL' });
  showToast('Cleared', '');
  await refresh();
});

// Filter toggle (collapsed by default — saves vertical space)
$('filterToggle').addEventListener('click', () => {
  const body    = $('filterBody');
  const chevron = $('filterChevron');
  const open    = !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', open);
  chevron.textContent = open ? '▶' : '▼';
});

// Re-render table immediately on filter change (no network — just visual)
document.querySelectorAll('.status-cb, #urlFilter, #blockFilter')
  .forEach(el => el.addEventListener('change', refresh));
$('urlFilter').addEventListener('input', refresh);

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await refresh();

  // If already recording when the popup opens, start polling immediately
  const state = await msg({ type: 'GET_STATE' });
  if (state?.recording) startPolling();
})();

window.addEventListener('unload', stopPolling);
