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
  syncReplayBlocks(feedData?.blocks ?? blocks);
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

// ── Replay panel ──────────────────────────────────────────────────────────────

let replayJobId     = null;
let replayPollTimer = null;
let lastReplayResults = [];

// Toggle open/close
$('replayToggle').addEventListener('click', () => {
  const body    = $('replayBody');
  const chevron = $('replayChevron');
  const open    = !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', open);
  chevron.textContent = open ? '▶' : '▼';
  if (!open) pingServer();   // auto-ping when opening
});

// Ping the local server
async function pingServer() {
  const url    = $('replayServerUrl').value.trim();
  const el     = $('replayServerStatus');
  el.className = 'replay-server-status';
  el.textContent = 'Checking…';
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    el.className   = 'replay-server-status ok';
    el.textContent = `✓ Server ready  (v${data.version})`;
  } catch {
    el.className   = 'replay-server-status error';
    el.textContent = '✗ Server not reachable — run: node server.js';
  }
}

$('replayPingBtn').addEventListener('click', pingServer);

// Parse "key=value\nkey2=value2" textarea into params object
function parseParams(text) {
  const params = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) params[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return params;
}

// Run replay
$('replayRunBtn').addEventListener('click', async () => {
  const serverUrl  = $('replayServerUrl').value.trim();
  const iterations = parseInt($('replayIterations').value, 10) || 1;
  const vusers     = parseInt($('replayVus').value, 10) || 1;
  const params     = parseParams($('replayParams').value);
  const blockVal   = $('replayBlockFilter').value;
  const blocks     = blockVal ? [blockVal] : null;

  // Get all recorded entries from background
  const entryRes = await msg({ type: 'GET_ENTRIES' });
  if (!entryRes?.entries?.length) {
    showToast('No recorded entries to replay.', 'error');
    return;
  }

  // Start job
  let jobRes;
  try {
    const resp = await fetch(`${serverUrl}/replay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        entries: entryRes.entries,
        options: { iterations, vusers, params, blocks },
      }),
      signal: AbortSignal.timeout(5000),
    });
    jobRes = await resp.json();
  } catch (err) {
    showToast(`Cannot reach replay server: ${err.message}`, 'error');
    $('replayServerStatus').className   = 'replay-server-status error';
    $('replayServerStatus').textContent = '✗ Server not reachable — run: node server.js';
    return;
  }

  if (!jobRes?.jobId) {
    showToast(jobRes?.error ?? 'Failed to start replay job.', 'error');
    return;
  }

  replayJobId = jobRes.jobId;
  lastReplayResults = [];

  $('replayRunBtn').classList.add('hidden');
  $('replayCancelBtn').classList.remove('hidden');
  $('replayProgress').classList.remove('hidden');
  $('replayResults').classList.add('hidden');
  $('replayProgressFill').style.width = '0%';
  $('replayProgressLabel').textContent = `0 / ${iterations * vusers} iterations`;

  showToast(`Replay started — ${iterations} iter × ${vusers} VU(s)`, 'success');

  // Poll for status
  replayPollTimer = setInterval(() => pollReplayJob(serverUrl), 1000);
});

async function pollReplayJob(serverUrl) {
  try {
    const resp = await fetch(`${serverUrl}/status/${replayJobId}`,
      { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();

    // Update progress bar
    const { completed, total } = data.progress;
    const pct = total > 0 ? Math.round(completed / total * 100) : 0;
    $('replayProgressFill').style.width  = `${pct}%`;
    $('replayProgressLabel').textContent =
      `${completed} / ${total} iterations  (${data.elapsedMs ? (data.elapsedMs / 1000).toFixed(1) + 's' : ''})`;

    // Live-update results table as iterations complete
    if (data.results?.length !== lastReplayResults.length) {
      lastReplayResults = data.results ?? [];
      if (data.report) renderReplayReport(data.report, false);
    }

    if (data.status === 'done' || data.status === 'error') {
      clearInterval(replayPollTimer);
      replayPollTimer = null;
      replayJobId = null;

      $('replayRunBtn').classList.remove('hidden');
      $('replayCancelBtn').classList.add('hidden');
      $('replayProgressFill').style.width = '100%';

      if (data.status === 'done') {
        renderReplayReport(data.report, true);
        showToast(`Replay complete — ${data.results.length} requests`, 'success');
      } else {
        showToast(`Replay error: ${data.error}`, 'error');
      }
    }
  } catch (err) {
    console.warn('[Replay] poll failed:', err.message);
  }
}

function renderReplayReport(report, final) {
  const tbody  = $('replayResultsBody');
  const rows   = [...(report.blockStats ?? []), report.overall].filter(Boolean);
  const label  = $('replayResultsLabel');

  $('replayResults').classList.remove('hidden');
  label.textContent = final ? '✓ Results' : '⟳ In progress…';

  tbody.innerHTML = '';

  // Business-critical rows
  for (const s of rows) {
    const isTotal  = s.block === 'TOTAL';
    const errPct   = s.count > 0 ? Math.round(s.errors / s.count * 100) : 0;
    const tr       = document.createElement('tr');
    if (isTotal) tr.style.fontWeight = '600';
    if (errPct > 0) tr.classList.add('replay-err-row');

    tr.innerHTML = `
      <td class="cell-block" title="${escHtml(s.block)}">${escHtml(s.block)}</td>
      <td class="cell-num">${s.count}</td>
      <td class="cell-num">${errPct}%</td>
      <td class="cell-num ${speedClass(s.avgMs)}">${fmtMs(s.avgMs)}</td>
      <td class="cell-num ${speedClass(s.p90Ms)}">${fmtMs(s.p90Ms)}</td>
      <td class="cell-num ${speedClass(s.p95Ms)}">${fmtMs(s.p95Ms)}</td>
      <td class="cell-num ${speedClass(s.maxMs)}">${fmtMs(s.maxMs)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Excluded-from-SLA row (grayed out, clearly labelled)
  if (report.excluded) {
    const s      = report.excluded;
    const errPct = s.count > 0 ? Math.round(s.errors / s.count * 100) : 0;
    const tr     = document.createElement('tr');
    tr.style.cssText = 'opacity:0.55; font-style:italic;';
    tr.title = 'Not counted against SLA — optional/non-critical services (e.g. ESH_SEARCH_SRV)';

    tr.innerHTML = `
      <td class="cell-block">⚠ Excluded from SLA</td>
      <td class="cell-num">${s.count}</td>
      <td class="cell-num">${errPct}%</td>
      <td class="cell-num">${fmtMs(s.avgMs)}</td>
      <td class="cell-num">${fmtMs(s.p90Ms)}</td>
      <td class="cell-num">${fmtMs(s.p95Ms)}</td>
      <td class="cell-num">${fmtMs(s.maxMs)}</td>
    `;
    tbody.appendChild(tr);
  }
}

$('replayCancelBtn').addEventListener('click', () => {
  if (replayPollTimer) { clearInterval(replayPollTimer); replayPollTimer = null; }
  replayJobId = null;
  $('replayRunBtn').classList.remove('hidden');
  $('replayCancelBtn').classList.add('hidden');
  $('replayProgressLabel').textContent = 'Cancelled';
  showToast('Replay cancelled', '');
});

$('replayExportBtn').addEventListener('click', () => {
  if (!lastReplayResults.length) return;
  const cols = ['vu','iteration','seq','block','method','url','status','durationMs','success','excludedFromSla','error'];
  const rows = [cols.join(',')];
  for (const r of lastReplayResults) {
    rows.push(cols.map(c => {
      const v = String(r[c] ?? '');
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g,'""')}"` : v;
    }).join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `sap-replay-${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported', 'success');
});

// Keep replay block filter in sync with recorded blocks
function syncReplayBlocks(blocks) {
  const sel   = $('replayBlockFilter');
  const prev  = sel.value;
  sel.innerHTML = '<option value="">All blocks</option>';
  for (const row of blocks) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = row.block;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await refresh();
  const state = await msg({ type: 'GET_STATE' });
  if (state?.recording) startPolling();
})();

window.addEventListener('unload', () => {
  stopPolling();
  if (replayPollTimer) clearInterval(replayPollTimer);
});
