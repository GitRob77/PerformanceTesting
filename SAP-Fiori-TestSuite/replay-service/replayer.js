/**
 * replay-service/replayer.js
 *
 * Core replay engine: loads a HAR log, detects correlation rules, then drives
 * sequential or concurrent virtual-user iterations against the live server.
 *
 * Works with Node.js >= 18 (uses built-in fetch + performance).
 * No external dependencies.
 *
 * Usage:
 *   import { Replayer } from './replayer.js';
 *   const replayer = new Replayer(harLog, { debug: true });
 *   const results  = await replayer.run({ iterations: 5, params: { host: 'https://…' } });
 */

import { CorrelationEngine } from '../shared/correlation.js';
import { filterByBlock } from '../shared/har-utils.js';

// ── HTTP headers the browser manages automatically — must not be sent manually ──
const SKIP_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer',
  'cookie',   // managed by CookieStore below
]);

// ── CookieStore ───────────────────────────────────────────────────────────────
/**
 * Simple in-memory cookie jar (domain-keyed).
 * No external deps — handles name=value pairs, domain matching.
 * Does NOT enforce Secure/HttpOnly/SameSite (irrelevant for controlled tests).
 */
class CookieStore {
  constructor() {
    /** @type {Map<string, Map<string, string>>}  domain → (name → value) */
    this._store = new Map();
  }

  /**
   * Parse Set-Cookie headers from a live fetch Response and store the cookies.
   *
   * @param {string}  urlStr   Request URL (used to derive domain)
   * @param {Headers} headers  Fetch response Headers object
   */
  processResponse(urlStr, headers) {
    const domain = this._domain(urlStr);
    if (!domain) return;
    if (!this._store.has(domain)) this._store.set(domain, new Map());
    const jar = this._store.get(domain);

    for (const raw of this._getSetCookies(headers)) {
      const semi = raw.indexOf(';');
      const pair = semi === -1 ? raw : raw.slice(0, semi);
      const eq   = pair.indexOf('=');
      if (eq < 1) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * Build a Cookie header value for the given URL.
   *
   * @param {string} urlStr
   * @returns {string}  e.g. "name1=val1; name2=val2"
   */
  getCookieHeader(urlStr) {
    const domain = this._domain(urlStr);
    if (!domain) return '';
    const parts = [];
    for (const [storedDomain, jar] of this._store) {
      if (domain === storedDomain || domain.endsWith(`.${storedDomain}`)) {
        for (const [name, value] of jar) parts.push(`${name}=${value}`);
      }
    }
    return parts.join('; ');
  }

  clear() { this._store.clear(); }

  _domain(urlStr) {
    try { return new URL(urlStr).hostname; } catch { return ''; }
  }

  _getSetCookies(headers) {
    // Node 18.14+ exposes getSetCookie(); fall back to forEach for older builds
    if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
    const values = [];
    if (typeof headers?.forEach === 'function') {
      headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') values.push(value);
      });
    }
    return values;
  }
}

// ── Replayer ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ReplayResult
 * @property {number}  vu           Virtual user ID (1-based)
 * @property {number}  iteration    Iteration number (1-based)
 * @property {number}  seq          Position within this iteration (0-based)
 * @property {number}  entryIndex   Original index in the HAR entries array
 * @property {string}  block        Functional block name
 * @property {string}  method       HTTP method
 * @property {string}  url          Request URL (after param substitution)
 * @property {number}  status       HTTP status code (0 = network error)
 * @property {number}  durationMs   Round-trip time in milliseconds
 * @property {boolean} success          true if status 2xx–3xx and no network error
 * @property {boolean} excludedFromSla  true if URL matched an excludeFromSla pattern
 * @property {string|null} error        Error message for network failures
 */

export class Replayer {
  /**
   * @param {object}   harLog              Parsed HAR log object (from parseHar())
   * @param {object}   [options]
   * @param {string[]} [options.blocks]        Only replay entries in these block names
   * @param {number}   [options.thinkTimeMs=0] Pause between requests (ms)
   * @param {boolean}  [options.skipStaticAssets=false]
   * @param {boolean}  [options.debug=false]   Verbose per-request logging
   * @param {number}   [options.timeout=30000] Per-request timeout (ms)
   */
  constructor(harLog, options = {}) {
    this._options = {
      blocks:            options.blocks           ?? null,
      thinkTimeMs:       options.thinkTimeMs      ?? 0,
      skipStaticAssets:  options.skipStaticAssets ?? false,
      excludeFromSla:    options.excludeFromSla   ?? [],
      debug:             options.debug            ?? false,
      timeout:           options.timeout          ?? 30_000,
    };

    // Pre-compile excludeFromSla patterns once
    this._excludePatterns = this._options.excludeFromSla.map(p => new RegExp(p));

    // Filter entries
    let entries = harLog.entries ?? [];
    if (this._options.blocks?.length) {
      entries = filterByBlock(entries, this._options.blocks);
    }
    if (this._options.skipStaticAssets) {
      entries = entries.filter(e => !_isStaticAsset(e));
    }
    this._entries = entries;

    // Analyze and cache correlation rules (done once, reused per iteration)
    this._engine = new CorrelationEngine({
      debug:          this._options.debug,
      includeBuiltin: true,
      includeAuto:    true,
    });
    this._rules = this._engine.analyze(this._entries);

    if (this._options.debug) {
      console.log(
        `[Replayer] ${this._entries.length} entries, ` +
        `${this._rules.length} correlation rules`
      );
    }
  }

  /** Number of requests that will be replayed per iteration. */
  getEntryCount() { return this._entries.length; }

  /** Detected correlation rules (JSON-serialisable). */
  getRules() { return this._rules; }

  // ── Single iteration ───────────────────────────────────────────────────────

  /**
   * Execute one full pass through all replay entries.
   *
   * @param {number} vuId       Virtual user ID
   * @param {number} iteration  Iteration counter
   * @param {object} [params]   {{param}} substitution values
   * @returns {Promise<ReplayResult[]>}
   */
  async runIteration(vuId, iteration, params = {}) {
    const session = this._engine.createSession(this._rules, params);
    const cookies = new CookieStore();
    const results = [];

    for (let seq = 0; seq < this._entries.length; seq++) {
      const harEntry   = this._entries[seq];
      const entryIndex = harEntry._entryIndex ?? seq;

      // Apply correlation + param substitution
      const { request: req } = session.applyToRequest(harEntry.request, entryIndex);

      // Build fetch headers (skip browser-managed ones; cookies come from jar)
      const headers = {};
      for (const h of req.headers ?? []) {
        if (!SKIP_HEADERS.has(h.name.toLowerCase())) headers[h.name] = h.value;
      }
      const cookieHeader = cookies.getCookieHeader(req.url);
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      // Generate HTTP Basic Authentication header for OData/API requests
      // (Skip for login form POSTs which use form-based credentials)
      const isLoginFormPost = req.method === 'POST' && req.url?.includes('FioriLaunchpad.html');
      if (!isLoginFormPost && !headers['Authorization'] && params.username && params.password) {
        const credentials = `${params.username}:${params.password}`;
        headers['Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
      }

      const fetchOpts = {
        method:   req.method,
        headers,
        body:     req.postData?.text ?? undefined,
        redirect: 'follow',
        signal:   AbortSignal.timeout(this._options.timeout),
      };

      const t0 = performance.now();
      let status    = 0;
      let error     = null;
      let liveResp  = null;

      try {
        const resp = await fetch(req.url, fetchOpts);
        status = resp.status;

        // Must consume the body to release the connection
        const bodyText = await resp.text().catch(() => '');

        // HAR-compatible response shape for correlation extraction
        liveResp = {
          status,
          statusText:  resp.statusText,
          headers:     [...resp.headers.entries()].map(([name, value]) => ({ name, value })),
          content:     { text: bodyText, mimeType: resp.headers.get('content-type') ?? '' },
        };

        cookies.processResponse(req.url, resp.headers);

      } catch (err) {
        error = err.name === 'TimeoutError'
          ? `Timeout after ${this._options.timeout}ms`
          : err.message;
      }

      const durationMs = Math.round(performance.now() - t0);

      if (liveResp) session.processResponse(liveResp, entryIndex);

      const excludedFromSla = this._excludePatterns.some(re => re.test(req.url));

      const result = {
        vu:         vuId,
        iteration,
        seq,
        entryIndex,
        block:      harEntry._functionalBlock ?? '(unassigned)',
        method:     req.method,
        url:        req.url,
        status,
        durationMs,
        success:    status >= 200 && status < 400 && !error,
        excludedFromSla,
        error,
      };

      results.push(result);

      if (this._options.debug) {
        const s = status ? String(status) : 'ERR';
        const e = error ? `  ← ${error}` : '';
        console.log(
          `  [VU${vuId}|iter${iteration}] ` +
          `${req.method} ${req.url.slice(0, 80)} → ${s} (${durationMs}ms)${e}`
        );
      }

      if (this._options.thinkTimeMs > 0) await _sleep(this._options.thinkTimeMs);
    }

    return results;
  }

  // ── Sequential multi-iteration ─────────────────────────────────────────────

  /**
   * Run N sequential iterations with a single virtual user.
   *
   * @param {object}   [options]
   * @param {number}   [options.iterations=1]
   * @param {object}   [options.params={}]
   * @param {Function} [options.onResult]   Called after each iteration: (results, iteration)
   * @returns {Promise<ReplayResult[]>}     Flat array of all results
   */
  async run({ iterations = 1, params = {}, onResult } = {}) {
    // Auto-extract login credentials from HAR if not explicitly provided
    const mergedParams = {
      ...(_extractLoginCredentialsFromHar(this._entries) || {}),
      ...params
    };

    const all = [];
    for (let i = 1; i <= iterations; i++) {
      const results = await this.runIteration(1, i, mergedParams);
      all.push(...results);
      if (onResult) onResult(results, i, 1);
    }
    return all;
  }

  // ── Concurrent virtual users ───────────────────────────────────────────────

  /**
   * Run iterations across multiple concurrent virtual users.
   * Each VU runs its own independent cookie jar and correlation session.
   *
   * @param {object}   [options]
   * @param {number}   [options.vusers=1]
   * @param {number}   [options.iterations=1]
   * @param {object}   [options.params={}]
   * @param {Function} [options.onResult]   Called after each VU iteration: (results, iteration, vuId)
   * @returns {Promise<ReplayResult[]>}
   */
  async runConcurrent({ vusers = 1, iterations = 1, params = {}, onResult } = {}) {
    // Auto-extract login credentials from HAR if not explicitly provided
    const mergedParams = {
      ...(_extractLoginCredentialsFromHar(this._entries) || {}),
      ...params
    };

    const work = [];
    for (let vu = 1; vu <= vusers; vu++) {
      work.push(this._runVu(vu, iterations, mergedParams, onResult));
    }
    return (await Promise.all(work)).flat();
  }

  async _runVu(vuId, iterations, params, onResult) {
    const results = [];
    for (let i = 1; i <= iterations; i++) {
      const r = await this.runIteration(vuId, i, params);
      results.push(...r);
      if (onResult) onResult(r, i, vuId);
    }
    return results;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _extractLoginCredentialsFromHar(entries) {
  // Find the LAST successful login POST (most recent attempt, likely correct credentials)
  let lastValidParams = null;

  for (const entry of entries ?? []) {
    const body = entry.request?.postData?.text ?? '';
    if (!body.includes('sap-user=') && !body.includes('sap-logonname=')) continue;

    // Parse form data using URLSearchParams to handle encoding correctly
    const params = {};
    try {
      const sp = new URLSearchParams(body);
      if (sp.has('sap-user')) params.username = sp.get('sap-user');
      if (sp.has('sap-logonname')) params.username = sp.get('sap-logonname');
      if (sp.has('sap-password')) params.password = sp.get('sap-password');
    } catch (e) {
      // Fallback to manual parsing if URLSearchParams fails
      for (const pair of body.split('&')) {
        const [key, value] = pair.split('=');
        if (!key) continue;
        const decodedKey = decodeURIComponent(key);
        const decodedValue = decodeURIComponent(value || '');

        if (decodedKey === 'sap-user' || decodedKey === 'sap-logonname') {
          params.username = decodedValue;
        } else if (decodedKey === 'sap-password') {
          params.password = decodedValue;
        }
      }
    }

    if (params.username && params.password) {
      lastValidParams = params;  // Keep updating to get the last one
    }
  }

  return lastValidParams || {};
}

function _isStaticAsset(entry) {
  const url  = entry.request?.url ?? '';
  const mime = entry.response?.content?.mimeType ?? '';
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)(\?|$)/i.test(url)) return true;
  if (/^(text\/css|text\/javascript|application\/javascript|image\/|font\/)/.test(mime)) return true;
  return false;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
