/**
 * replay-service/report.js
 *
 * Statistics computation and output formatting for replay results.
 *
 * Exports:
 *   buildReport(results)   → { blockStats[], overall }
 *   printReport(report)    → console table
 *   toCsv(results)         → CSV string
 */

// ── Statistics ────────────────────────────────────────────────────────────────

/**
 * Compute per-block and overall statistics from a flat array of ReplayResults.
 *
 * Business-critical requests (not excluded from SLA) are reported separately
 * from excluded requests (e.g. optional SAP services like ESH_SEARCH_SRV).
 *
 * @param {import('./replayer.js').ReplayResult[]} results
 * @returns {{ blockStats: object[], overall: object, excluded: object|null, excludedCount: number }}
 */
export function buildReport(results) {
  const businessCritical = results.filter(r => !r.excludedFromSla);
  const excludedResults  = results.filter(r =>  r.excludedFromSla);

  // Per-block stats (business-critical only)
  const byBlock = new Map();
  for (const r of businessCritical) {
    const key = r.block ?? '(unassigned)';
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(r);
  }
  const blockStats = [...byBlock.entries()].map(([block, rows]) =>
    _stats(block, rows)
  );

  return {
    blockStats,
    overall:      _stats('TOTAL', businessCritical),
    excluded:     excludedResults.length > 0 ? _stats('Excluded from SLA', excludedResults) : null,
    excludedCount: excludedResults.length,
  };
}

function _stats(label, rows) {
  const n      = rows.length;
  const errors = rows.filter(r => !r.success).length;
  const sorted = rows.map(r => r.durationMs).sort((a, b) => a - b);
  const total  = sorted.reduce((a, b) => a + b, 0);

  return {
    block:       label,
    count:       n,
    errors,
    successRate: n > 0 ? Math.round((n - errors) / n * 100) : 0,
    avgMs:       n > 0 ? Math.round(total / n) : 0,
    minMs:       sorted[0] ?? 0,
    maxMs:       sorted[n - 1] ?? 0,
    p50Ms:       _pct(sorted, 0.50),
    p90Ms:       _pct(sorted, 0.90),
    p95Ms:       _pct(sorted, 0.95),
    p99Ms:       _pct(sorted, 0.99),
  };
}

function _pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)] ?? 0;
}

// ── Console output ─────────────────────────────────────────────────────────────

const COL_WIDTHS = [24, 6, 6, 8, 8, 8, 8, 8];
const COL_HEADS  = ['Block', 'Reqs', 'Err%', 'Avg', 'Min', 'P90', 'P95', 'Max'];
const W = COL_WIDTHS.reduce((a, b) => a + b, 0);

/**
 * Print a formatted summary table to stdout.
 * @param {{ blockStats: object[], overall: object, excluded: object|null }} report
 */
export function printReport(report) {
  console.log('─'.repeat(W));
  console.log(_row(COL_HEADS));
  console.log('─'.repeat(W));

  for (const s of report.blockStats) {
    console.log(_row(_formatRow(s)));
  }

  console.log('─'.repeat(W));
  console.log(_row(_formatRow(report.overall)));
  console.log('─'.repeat(W));

  if (report.excluded) {
    console.log('');
    console.log('  ⚠ Excluded from SLA (optional/non-critical services):');
    console.log('─'.repeat(W));
    console.log(_row(_formatRow(report.excluded)));
    console.log('─'.repeat(W));
    console.log(
      `  These ${report.excludedCount} request(s) were replayed but not counted against SLA.\n` +
      '  Failures here are expected and documented as acceptable.'
    );
  }
}

function _formatRow(s) {
  const errPct = s.count > 0 ? `${Math.round(s.errors / s.count * 100)}%` : '0%';
  return [
    s.block,
    String(s.count),
    errPct,
    `${s.avgMs}ms`,
    `${s.minMs}ms`,
    `${s.p90Ms}ms`,
    `${s.p95Ms}ms`,
    `${s.maxMs}ms`,
  ];
}

function _row(cells) {
  return cells.map((c, i) => _pad(String(c).slice(0, COL_WIDTHS[i]), COL_WIDTHS[i])).join('');
}

function _pad(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

// ── CSV export ─────────────────────────────────────────────────────────────────

const CSV_COLS = [
  'vu', 'iteration', 'seq', 'block', 'method', 'url',
  'status', 'durationMs', 'success', 'excludedFromSla', 'error',
];

/**
 * Serialise results to a CSV string (with header row).
 * @param {import('./replayer.js').ReplayResult[]} results
 * @returns {string}
 */
export function toCsv(results) {
  const rows = [CSV_COLS.join(',')];
  for (const r of results) {
    rows.push(
      CSV_COLS.map(col => {
        const v = r[col] ?? '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      }).join(',')
    );
  }
  return rows.join('\n') + '\n';
}
