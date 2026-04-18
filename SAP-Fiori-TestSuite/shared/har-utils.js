/**
 * shared/har-utils.js
 *
 * Utilities for reading, writing, filtering, and summarising HAR files
 * extended with the custom `_functionalBlock` field used by this suite.
 *
 * Works in both browser (Chrome extension) and Node.js >= 18.
 *
 * HAR extension fields added by this suite:
 *   entry._functionalBlock  {string}  Name of the functional block this entry belongs to
 *   entry._entryIndex       {number}  Original position in the full entry list
 */

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a HAR JSON string and return the log object.
 * Throws a descriptive error if the input is not a valid HAR.
 *
 * @param {string} text  Raw JSON text
 * @returns {{ version:string, creator:object, entries:object[], pages?:object[] }}
 */
export function parseHar(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`HAR parse failed: invalid JSON — ${err.message}`);
  }

  if (!parsed?.log) {
    throw new Error('HAR parse failed: missing "log" key. Is this a valid HAR file?');
  }
  if (!Array.isArray(parsed.log.entries)) {
    throw new Error('HAR parse failed: log.entries is not an array.');
  }

  // Stamp each entry with its original index for correlation engine use
  parsed.log.entries.forEach((e, i) => { e._entryIndex = i; });

  return parsed.log;
}

/**
 * Serialise a HAR log object back to a JSON string.
 * Preserves `_functionalBlock` and `_entryIndex` extension fields.
 *
 * @param {{ version:string, creator:object, entries:object[], pages?:object[] }} log
 * @param {number} [indent=2]
 * @returns {string}
 */
export function serializeHar(log, indent = 2) {
  return JSON.stringify({ log }, null, indent);
}

// ── Functional Blocks ────────────────────────────────────────────────────────

/**
 * Return an alphabetically sorted list of unique functional block names
 * found in the entries.
 *
 * @param {object[]} entries
 * @returns {string[]}
 */
export function getBlockNames(entries) {
  const names = new Set(entries.map(e => e._functionalBlock).filter(Boolean));
  return [...names].sort();
}

/**
 * Group entries by their `_functionalBlock` field.
 * Entries without a block are grouped under the key `'(unassigned)'`.
 *
 * @param {object[]} entries
 * @returns {Map<string, object[]>}
 */
export function groupByBlock(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry._functionalBlock ?? '(unassigned)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Filter entries whose URL matches a pattern (substring or regex string).
 *
 * @param {object[]} entries
 * @param {string}   pattern  Substring or /regex/ string (with leading/trailing slash)
 * @returns {object[]}
 */
export function filterByUrl(entries, pattern) {
  if (!pattern) return entries;
  const rx = toRegex(pattern);
  return entries.filter(e => rx.test(e.request?.url ?? ''));
}

/**
 * Filter entries whose HTTP status code falls within the given ranges.
 * Ranges is an array of objects like { min: 200, max: 299 }.
 *
 * @param {object[]} entries
 * @param {Array<{min:number,max:number}>} ranges
 * @returns {object[]}
 */
export function filterByStatus(entries, ranges) {
  if (!ranges || ranges.length === 0) return entries;
  return entries.filter(e => {
    const status = e.response?.status ?? 0;
    return ranges.some(r => status >= r.min && status <= r.max);
  });
}

/**
 * Filter entries belonging to specific functional block names.
 *
 * @param {object[]} entries
 * @param {string[]} blockNames
 * @returns {object[]}
 */
export function filterByBlock(entries, blockNames) {
  if (!blockNames || blockNames.length === 0) return entries;
  const set = new Set(blockNames);
  return entries.filter(e => set.has(e._functionalBlock));
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Build a summary table (array of rows) for the given entries, grouped by block.
 *
 * Each row: { block, requestCount, totalMs, avgMs }
 *
 * @param {object[]} entries
 * @returns {Array<{block:string, requestCount:number, totalMs:number, avgMs:number}>}
 */
export function summarizeBlocks(entries) {
  const groups = groupByBlock(entries);
  const rows = [];

  for (const [block, blockEntries] of groups) {
    const times = blockEntries.map(e => e.time ?? 0);
    const totalMs = times.reduce((a, b) => a + b, 0);
    rows.push({
      block,
      requestCount: blockEntries.length,
      totalMs: Math.round(totalMs),
      avgMs: blockEntries.length > 0 ? Math.round(totalMs / blockEntries.length) : 0,
    });
  }

  return rows;
}

/**
 * Build a flat summary of a single block or all entries.
 *
 * Returns { requestCount, successCount, failCount, totalMs, avgMs, minMs, maxMs }
 *
 * @param {object[]} entries
 * @returns {object}
 */
export function summarizeEntries(entries) {
  let successCount = 0;
  let failCount = 0;
  let totalMs = 0;
  let minMs = Infinity;
  let maxMs = 0;

  for (const e of entries) {
    const status = e.response?.status ?? 0;
    const t = e.time ?? 0;
    if (status >= 200 && status < 400) successCount++;
    else failCount++;
    totalMs += t;
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }

  return {
    requestCount: entries.length,
    successCount,
    failCount,
    totalMs: Math.round(totalMs),
    avgMs: entries.length > 0 ? Math.round(totalMs / entries.length) : 0,
    minMs: entries.length > 0 ? Math.round(minMs) : 0,
    maxMs: Math.round(maxMs),
  };
}

// ── HAR Entry Helpers ────────────────────────────────────────────────────────

/**
 * Get the full URL from a HAR request object, including query string.
 *
 * @param {object} request  HAR request
 * @returns {string}
 */
export function getFullUrl(request) {
  if (!request) return '';
  if (!request.queryString?.length) return request.url ?? '';
  const qs = request.queryString
    .map(q => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value)}`)
    .join('&');
  return request.url.includes('?')
    ? `${request.url}&${qs}`
    : `${request.url}?${qs}`;
}

/**
 * Build a fetch-compatible Headers object from a HAR headers array.
 * Skips headers that browsers manage automatically (Host, Content-Length, etc.).
 *
 * @param {Array<{name:string,value:string}>} harHeaders
 * @param {string[]} [skipHeaders]
 * @returns {object}  Plain object suitable for use as fetch headers
 */
export function harHeadersToFetch(harHeaders, skipHeaders = []) {
  const skip = new Set([
    'host', 'content-length', 'transfer-encoding', 'connection',
    ...skipHeaders.map(s => s.toLowerCase()),
  ]);
  const result = {};
  for (const h of (harHeaders ?? [])) {
    if (!skip.has(h.name.toLowerCase())) {
      result[h.name] = h.value;
    }
  }
  return result;
}

/**
 * Build a plain object representing a fetch RequestInit from a HAR request.
 *
 * @param {object} harRequest
 * @param {string[]} [skipHeaders]
 * @returns {{ method:string, headers:object, body:string|undefined }}
 */
export function harRequestToFetch(harRequest, skipHeaders = []) {
  return {
    method: harRequest.method,
    headers: harHeadersToFetch(harRequest.headers, skipHeaders),
    body: harRequest.postData?.text ?? undefined,
  };
}

// ── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Convert a string to a RegExp.
 * Strings enclosed in /.../ are treated as regex; others as literal substrings.
 */
function toRegex(pattern) {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    return new RegExp(body, flags);
  }
  return new RegExp(escapeRegExp(pattern), 'i');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
