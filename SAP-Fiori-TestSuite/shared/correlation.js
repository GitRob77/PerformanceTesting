/**
 * shared/correlation.js
 *
 * SAP Fiori HTTP Correlation Engine
 *
 * Extracts dynamic values (CSRF tokens, session IDs, OData entity keys, ETags)
 * from HTTP responses and injects them into subsequent requests during replay.
 *
 * Works in both browser (Chrome extension service worker) and Node.js >= 18.
 * No external dependencies — pure ES module.
 *
 * ─── Quick usage ────────────────────────────────────────────────────────────
 *
 *   import { CorrelationEngine } from './correlation.js';
 *
 *   // 1. Analyse recorded HAR entries → detect rules
 *   const engine = new CorrelationEngine({ debug: true });
 *   const rules = engine.analyze(harEntries);
 *
 *   // 2. Create a session for replay
 *   const session = engine.createSession(rules, { username: 'u1', password: 'p1' });
 *
 *   // 3. Replay loop
 *   for (const [idx, entry] of harEntries.entries()) {
 *     const { request } = session.applyToRequest(entry.request, idx);
 *     const response = await sendRequest(request);
 *     session.processResponse(response, idx);
 *   }
 *
 *   console.log(session.getLog());
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum string length for auto-detected (generic) correlation values */
export const MIN_AUTO_CORRELATION_LENGTH = 8;

/** HTTP methods that require a CSRF token in SAP Fiori */
export const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH', 'MERGE']);

// ── Header Utilities ─────────────────────────────────────────────────────────

/**
 * Get a header value (case-insensitive) from a HAR headers array.
 * Returns undefined if not found.
 *
 * @param {Array<{name:string,value:string}>|undefined} headers
 * @param {string} name
 * @returns {string|undefined}
 */
export function getHeader(headers, name) {
  if (!Array.isArray(headers)) return undefined;
  const lower = name.toLowerCase();
  return headers.find(h => h.name.toLowerCase() === lower)?.value;
}

/**
 * Return a new headers array with the given header set (case-insensitive).
 * If the header already exists it is replaced; otherwise it is appended.
 *
 * @param {Array<{name:string,value:string}>} headers
 * @param {string} name
 * @param {string} value
 * @returns {Array<{name:string,value:string}>}
 */
export function setHeader(headers, name, value) {
  if (!Array.isArray(headers)) return [{ name, value }];
  const lower = name.toLowerCase();
  const found = headers.some(h => h.name.toLowerCase() === lower);
  if (found) {
    return headers.map(h => h.name.toLowerCase() === lower ? { name: h.name, value } : h);
  }
  return [...headers, { name, value }];
}

/**
 * Parse all Set-Cookie headers from a response headers array.
 * Returns an array of { name, value } cookie objects.
 *
 * @param {Array<{name:string,value:string}>} headers
 * @returns {Array<{name:string,value:string}>}
 */
export function parseSetCookies(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter(h => h.name.toLowerCase() === 'set-cookie')
    .map(h => {
      const semi = h.value.indexOf(';');
      const pair = semi === -1 ? h.value : h.value.slice(0, semi);
      const eq = pair.indexOf('=');
      if (eq < 1) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}

/**
 * Replace a specific cookie's value inside the Cookie request header.
 * Returns a new headers array.
 *
 * @param {Array<{name:string,value:string}>} headers
 * @param {string} cookieName
 * @param {string} newValue
 * @returns {Array<{name:string,value:string}>}
 */
export function replaceCookieInHeader(headers, cookieName, newValue) {
  if (!Array.isArray(headers)) return headers;
  return headers.map(h => {
    if (h.name.toLowerCase() !== 'cookie') return h;
    const updated = h.value.replace(
      new RegExp(`((?:^|;\\s*)${escapeRegExp(cookieName)}=)[^;]*`, 'i'),
      `$1${newValue}`
    );
    return { name: h.name, value: updated };
  });
}

// ── JSON Utilities ───────────────────────────────────────────────────────────

/**
 * Safely parse JSON text. Returns null on any parse error.
 *
 * @param {string|null|undefined} text
 * @returns {*|null}
 */
export function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Resolve a simplified dot-notation JSON path in an object.
 * Supports array indices: 'd.results[0].ID', '$.d.__metadata.uri'
 *
 * @param {*} obj
 * @param {string} path
 * @returns {*}
 */
export function resolveJsonPath(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = path
    .replace(/^\$\.?/, '')        // strip leading $.
    .split(/[\.\[\]]+/)           // split on . and []
    .filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const idx = Number(part);
    cur = Number.isNaN(idx) ? cur[part] : cur[idx];
  }
  return cur;
}

/**
 * Flatten a JSON object into an array of { path, value } string pairs.
 * Only includes string/number leaf values of at least MIN_AUTO_CORRELATION_LENGTH chars.
 *
 * @param {*} obj
 * @param {string} [prefix='']
 * @param {number} [maxDepth=5]
 * @returns {Array<{path:string,value:string}>}
 */
export function flattenJson(obj, prefix = '', maxDepth = 5) {
  if (maxDepth <= 0 || obj == null) return [];
  const t = typeof obj;
  if (t === 'string' || t === 'number') {
    const str = String(obj);
    return str.length >= MIN_AUTO_CORRELATION_LENGTH ? [{ path: prefix, value: str }] : [];
  }
  if (Array.isArray(obj)) {
    return obj
      .slice(0, 20)  // cap at 20 items to avoid blowing up on huge arrays
      .flatMap((v, i) => flattenJson(v, `${prefix}[${i}]`, maxDepth - 1));
  }
  if (t === 'object') {
    return Object.entries(obj).flatMap(([k, v]) =>
      flattenJson(v, prefix ? `${prefix}.${k}` : k, maxDepth - 1)
    );
  }
  return [];
}

// ── Parameter Substitution ───────────────────────────────────────────────────

/**
 * Replace {{paramName}} placeholders in a string using a parameters object.
 * Unmatched placeholders are left as-is.
 *
 * @param {string} text
 * @param {object} parameters
 * @returns {string}
 */
export function substituteParams(text, parameters) {
  if (!text || !parameters || typeof text !== 'string') return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(parameters, name)
      ? String(parameters[name])
      : match
  );
}

// ── HAR Body Accessors ───────────────────────────────────────────────────────

/** @param {{content?:{text?:string}}} response */
export function getResponseBodyText(response) {
  return response?.content?.text ?? '';
}

/** @param {{postData?:{text?:string}}} request */
export function getRequestBodyText(request) {
  return request?.postData?.text ?? '';
}

// ── Private Helpers ──────────────────────────────────────────────────────────

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a value from a response according to an extract descriptor.
 *
 * @param {{extract:{from:string,...}}} rule
 * @param {object} response  HAR response object
 * @returns {string|null}
 */
function runExtract(extract, response) {
  if (!extract || !response) return null;

  switch (extract.from) {
    case 'response_header': {
      const v = getHeader(response.headers, extract.headerKey);
      if (!v) return null;
      if (extract.filterNot && extract.filterNot.includes(v.toLowerCase())) return null;
      if (v.length < (extract.minLength ?? 1)) return null;
      return v;
    }

    case 'response_body_json': {
      const body = getResponseBodyText(response);
      const json = parseJsonSafe(body);
      if (!json) return null;
      const v = resolveJsonPath(json, extract.jsonPath);
      return v != null ? String(v) : null;
    }

    case 'response_body_regex': {
      const body = getResponseBodyText(response);
      const rx = new RegExp(extract.regex);
      const m = rx.exec(body);
      return m ? (m[extract.regexGroup ?? 1] ?? m[0]) : null;
    }

    case 'response_cookie': {
      const cookies = parseSetCookies(response.headers);
      let cookie;
      if (extract.cookieNamePattern) {
        const rx = new RegExp(extract.cookieNamePattern, 'i');
        cookie = cookies.find(c => rx.test(c.name));
      } else {
        const lower = (extract.cookieName ?? '').toLowerCase();
        cookie = cookies.find(c => c.name.toLowerCase() === lower);
      }
      return cookie ? `${cookie.name}=${cookie.value}` : null;
    }

    default:
      return null;
  }
}

/**
 * Apply an inject descriptor to a request, replacing recordedValue with currentValue.
 * Returns a new request object (does not mutate).
 *
 * @param {object} inject
 * @param {object} request  HAR request object
 * @param {string} currentValue
 * @param {string|undefined} recordedValue  original value to search for in URL/body
 * @returns {object}
 */
function runInject(inject, request, currentValue, recordedValue) {
  if (!inject || !request || !currentValue) return request;

  switch (inject.into) {
    case 'request_header': {
      if (inject.condition && !inject.condition(request)) return request;
      return { ...request, headers: setHeader(request.headers, inject.headerKey, currentValue) };
    }

    case 'request_cookie': {
      const cookieName = inject.cookieName
        ?? (recordedValue?.includes('=') ? recordedValue.split('=')[0] : undefined);
      if (!cookieName) return request;
      const cookieVal = currentValue.includes('=')
        ? currentValue.split('=').slice(1).join('=')
        : currentValue;
      return { ...request, headers: replaceCookieInHeader(request.headers, cookieName, cookieVal) };
    }

    case 'request_url': {
      const placeholder = inject.placeholder ?? recordedValue;
      if (!placeholder || !request.url?.includes(placeholder)) return request;
      return { ...request, url: request.url.split(placeholder).join(currentValue) };
    }

    case 'request_body_literal': {
      const placeholder = inject.placeholder ?? recordedValue;
      if (!placeholder) return request;
      const body = getRequestBodyText(request);
      if (!body.includes(placeholder)) return request;
      return {
        ...request,
        postData: { ...request.postData, text: body.split(placeholder).join(currentValue) },
      };
    }

    case 'request_header_value': {
      // Replace literal placeholder anywhere in header values (not a named header)
      const placeholder = inject.placeholder ?? recordedValue;
      if (!placeholder || !Array.isArray(request.headers)) return request;
      const headers = request.headers.map(h =>
        h.value?.includes(placeholder)
          ? { name: h.name, value: h.value.split(placeholder).join(currentValue) }
          : h
      );
      return { ...request, headers };
    }

    default:
      return request;
  }
}

// ── Built-in SAP Fiori Rule Definitions ─────────────────────────────────────

/**
 * Built-in rule definitions for the most common SAP Fiori correlation patterns.
 * Each definition drives both detection (during analyze()) and runtime injection.
 *
 * Properties:
 *   id          — stable identifier used to look up the def at runtime
 *   name        — human-readable label shown in logs
 *   description — one-line explanation
 *   extract     — descriptor passed to runExtract()
 *   inject      — descriptor passed to runInject()
 *   injectIf    — optional function(request) → bool; skips injection when false
 */
export const BUILTIN_RULE_DEFS = [
  {
    id: 'sap_csrf_token',
    name: 'SAP CSRF Token',
    description: 'x-csrf-token from response header → injected into POST/PUT/DELETE/PATCH/MERGE',
    extract: {
      from: 'response_header',
      headerKey: 'x-csrf-token',
      filterNot: ['required', 'fetch'],
      minLength: 4,
    },
    inject: {
      into: 'request_header',
      headerKey: 'x-csrf-token',
    },
    injectIf(request) {
      if (!CSRF_METHODS.has(request.method?.toUpperCase())) return false;
      const v = getHeader(request.headers, 'x-csrf-token');
      return !!v && v.toLowerCase() !== 'fetch';
    },
  },

  {
    id: 'sap_etag_if_match',
    name: 'ETag → If-Match',
    description: 'ETag from response header → If-Match on subsequent PUT/PATCH/DELETE',
    extract: {
      from: 'response_header',
      headerKey: 'etag',
      minLength: 2,
    },
    inject: {
      into: 'request_header',
      headerKey: 'if-match',
    },
    injectIf(request) {
      const v = getHeader(request.headers, 'if-match');
      return !!v && v !== '*';
    },
  },

  {
    id: 'sap_context_id',
    name: 'SAP Context ID Cookie',
    description: 'sap-contextid Set-Cookie value correlated across requests',
    extract: {
      from: 'response_cookie',
      cookieName: 'sap-contextid',
    },
    inject: {
      into: 'request_cookie',
      cookieName: 'sap-contextid',
    },
    injectIf(request) {
      const cookie = getHeader(request.headers, 'cookie') ?? '';
      return /sap-contextid/i.test(cookie);
    },
  },

  {
    id: 'sap_session_id',
    name: 'SAP Session ID Cookie',
    description: 'SAP_SESSIONID_* cookie correlated across requests',
    extract: {
      from: 'response_cookie',
      cookieNamePattern: '^SAP_SESSIONID_',
    },
    inject: {
      into: 'request_cookie',
    },
    injectIf(request) {
      const cookie = getHeader(request.headers, 'cookie') ?? '';
      return /SAP_SESSIONID_/i.test(cookie);
    },
  },

  {
    id: 'mysapsso2',
    name: 'MYSAPSSO2 SSO Token',
    description: 'MYSAPSSO2 SAP SSO cookie tracked across the session',
    extract: {
      from: 'response_cookie',
      cookieName: 'MYSAPSSO2',
    },
    inject: {
      into: 'request_cookie',
      cookieName: 'MYSAPSSO2',
    },
    injectIf(request) {
      const cookie = getHeader(request.headers, 'cookie') ?? '';
      return /MYSAPSSO2/i.test(cookie);
    },
  },
];

/** Fast lookup map: id → def */
const BUILTIN_DEF_BY_ID = Object.fromEntries(BUILTIN_RULE_DEFS.map(d => [d.id, d]));

// ── CorrelationEngine ────────────────────────────────────────────────────────

/**
 * Analyzes HAR entries to detect correlation rules, and creates replay sessions.
 *
 * @example
 * const engine = new CorrelationEngine({ debug: true });
 * const rules   = engine.analyze(entries);
 * const session = engine.createSession(rules, { username: 'demo', password: 'Demo1!' });
 */
export class CorrelationEngine {
  /**
   * @param {object}  [options]
   * @param {boolean} [options.debug=false]          Verbose console output
   * @param {number}  [options.minAutoLength=8]      Min value length for auto-correlation
   * @param {boolean} [options.includeBuiltin=true]  Run built-in SAP rule detection
   * @param {boolean} [options.includeAuto=true]     Run generic left-right correlation
   */
  constructor(options = {}) {
    this.debug = options.debug ?? false;
    this.minAutoLength = options.minAutoLength ?? MIN_AUTO_CORRELATION_LENGTH;
    this.includeBuiltin = options.includeBuiltin ?? true;
    this.includeAuto = options.includeAuto ?? true;
  }

  /**
   * Analyze a list of HAR entries and return an array of correlation rules.
   * Rules are plain JSON-serialisable objects (no functions).
   * Built-in rules carry a `_defId` field used at runtime to look up the logic.
   *
   * @param {object[]} entries  HAR log.entries array
   * @returns {object[]}        Correlation rules
   */
  analyze(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const rules = [];
    let autoCounter = 0;

    // ── 1. Built-in SAP rules ────────────────────────────────────────────────
    if (this.includeBuiltin) {
      for (const def of BUILTIN_RULE_DEFS) {
        const extractFrom = [];
        const injectInto = [];
        let firstRecordedValue = null;

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const val = runExtract(def.extract, entry.response);
          if (val != null) {
            extractFrom.push(i);
            if (firstRecordedValue == null) firstRecordedValue = val;
          }
        }

        if (extractFrom.length === 0) continue;

        for (let i = 0; i < entries.length; i++) {
          if (extractFrom.every(x => x >= i)) continue; // no extraction before this index
          const req = entries[i].request;
          if (def.injectIf && def.injectIf(req)) {
            injectInto.push(i);
          }
        }

        if (injectInto.length === 0) continue;

        const rule = {
          id: def.id,
          name: def.name,
          type: 'builtin',
          enabled: true,
          description: def.description,
          _defId: def.id,
          extractFromIndices: extractFrom,
          injectIntoIndices: injectInto,
          recordedValue: firstRecordedValue,
        };
        rules.push(rule);

        if (this.debug) {
          console.log(
            `[Correlation] Builtin: "${def.name}" ` +
            `extract[${extractFrom}] → inject[${injectInto}] ` +
            `recorded="${String(firstRecordedValue).slice(0, 30)}"`
          );
        }
      }
    }

    // ── 2. Generic left-right (auto) correlation ─────────────────────────────
    if (this.includeAuto) {
      // Values already handled by built-in rules — skip re-correlating them
      const knownValues = new Set(rules.map(r => r.recordedValue).filter(Boolean));

      for (let srcIdx = 0; srcIdx < entries.length - 1; srcIdx++) {
        const srcResponse = entries[srcIdx].response;
        if (!srcResponse) continue;

        // Collect candidate values: response headers + JSON body leaves
        const candidates = new Map(); // value → sourcePath string

        for (const h of srcResponse.headers ?? []) {
          const v = h.value;
          if (v && v.length >= this.minAutoLength && !knownValues.has(v)) {
            candidates.set(v, `header:${h.name}`);
          }
        }

        const bodyJson = parseJsonSafe(getResponseBodyText(srcResponse));
        if (bodyJson) {
          for (const { path, value } of flattenJson(bodyJson)) {
            if (!knownValues.has(value) && !candidates.has(value)) {
              candidates.set(value, `body:${path}`);
            }
          }
        }

        // For each candidate, find all subsequent requests where it appears
        for (const [value, sourcePath] of candidates) {
          const injectInto = [];
          let injectTargetType = null;

          for (let tgtIdx = srcIdx + 1; tgtIdx < entries.length; tgtIdx++) {
            const req = entries[tgtIdx].request;
            const inUrl = req.url?.includes(value);
            const inBody = getRequestBodyText(req).includes(value);
            const inHeaders = (req.headers ?? []).some(h => h.value?.includes(value));

            if (inUrl || inBody || inHeaders) {
              injectInto.push(tgtIdx);
              if (!injectTargetType) {
                injectTargetType = inUrl ? 'request_url'
                  : inBody ? 'request_body_literal'
                  : 'request_header_value';
              }
            }
          }

          if (injectInto.length === 0) continue;

          // Prevent duplicates from future source entries
          knownValues.add(value);
          autoCounter++;

          const ruleId = `auto_${String(autoCounter).padStart(3, '0')}`;
          const rule = {
            id: ruleId,
            name: `Auto: ${sourcePath}`,
            type: 'auto',
            enabled: true,
            extract: sourcePath.startsWith('header:')
              ? { from: 'response_header', headerKey: sourcePath.slice(7) }
              : { from: 'response_body_json', jsonPath: sourcePath.slice(5) },
            inject: {
              into: injectTargetType,
              placeholder: value,
            },
            extractFromIndices: [srcIdx],
            injectIntoIndices: injectInto,
            recordedValue: value,
          };
          rules.push(rule);

          if (this.debug) {
            console.log(
              `[Correlation] Auto: "${String(value).slice(0, 30)}" ` +
              `from entry ${srcIdx} (${sourcePath}) → inject[${injectInto}]`
            );
          }
        }
      }
    }

    return rules;
  }

  /**
   * Create a CorrelationSession for a replay run.
   *
   * @param {object[]} rules        Rules from analyze() or user-defined
   * @param {object}   [parameters] {{paramName}} substitution values
   * @returns {CorrelationSession}
   */
  createSession(rules, parameters = {}) {
    return new CorrelationSession(rules, parameters, { debug: this.debug });
  }
}

// ── CorrelationSession ───────────────────────────────────────────────────────

/**
 * Runtime state for a single replay execution.
 * Holds current dynamic variable values and the full extraction/injection log.
 *
 * Created by CorrelationEngine.createSession().
 */
export class CorrelationSession {
  /**
   * @param {object[]} rules
   * @param {object}   parameters
   * @param {object}   [options]
   * @param {boolean}  [options.debug=false]
   */
  constructor(rules, parameters = {}, options = {}) {
    this.rules = (rules ?? []).filter(r => r.enabled !== false);
    this.parameters = parameters;
    this.debug = options.debug ?? false;

    /** @type {Map<string, string>}  ruleId → current extracted value */
    this.variables = new Map();

    /** @type {object[]} */
    this._log = [];
  }

  /**
   * Process a live response: run all extraction rules for this entry index.
   * Call AFTER receiving the response.
   *
   * @param {object} response   HAR response object (or compatible shape)
   * @param {number} entryIndex Index of this entry in the flow
   * @returns {object[]}        Extraction log entries added this call
   */
  processResponse(response, entryIndex) {
    if (!response) return [];
    const added = [];

    for (const rule of this.rules) {
      if (!rule.extractFromIndices?.includes(entryIndex)) continue;

      let value = null;
      if (rule.type === 'builtin') {
        const def = BUILTIN_DEF_BY_ID[rule._defId ?? rule.id];
        if (def) value = runExtract(def.extract, response);
      } else {
        value = runExtract(rule.extract, response);
      }

      if (value == null) {
        if (this.debug) {
          console.warn(
            `[Correlation] WARN: rule "${rule.name}" matched entry ${entryIndex} ` +
            `for extraction but found no value — response may have changed`
          );
        }
        continue;
      }

      const prev = this.variables.get(rule.id);
      this.variables.set(rule.id, value);

      const entry = {
        phase: 'extract',
        ruleId: rule.id,
        ruleName: rule.name,
        entryIndex,
        value,
        changed: prev !== value,
        previous: prev,
      };
      this._log.push(entry);
      added.push(entry);

      if (this.debug) {
        const snippet = String(value).slice(0, 50);
        console.log(
          `[Correlation] Extracted [${rule.name}] = "${snippet}"${value.length > 50 ? '…' : ''} ` +
          `(entry ${entryIndex}${prev && prev !== value ? ', value changed' : ''})`
        );
      }
    }

    return added;
  }

  /**
   * Apply all correlations and parameter substitutions to a request.
   * Call BEFORE sending the request.
   *
   * @param {object} request    HAR request object (not mutated)
   * @param {number} entryIndex Index of this entry in the flow
   * @returns {{ request: object, injections: object[] }}
   */
  applyToRequest(request, entryIndex) {
    if (!request) return { request, injections: [] };

    let current = request;
    const injections = [];

    // ── Parameter substitution ───────────────────────────────────────────────
    if (Object.keys(this.parameters).length > 0) {
      current = this._substituteParams(current);
    }

    // ── Correlation injection ────────────────────────────────────────────────
    for (const rule of this.rules) {
      if (!rule.injectIntoIndices?.includes(entryIndex)) continue;

      const currentValue = this.variables.get(rule.id);
      if (!currentValue) {
        if (this.debug) {
          console.warn(
            `[Correlation] WARN: rule "${rule.name}" targets entry ${entryIndex} ` +
            `but no value has been extracted yet — skipping injection. ` +
            `Check that extraction entry comes before injection entry.`
          );
        }
        continue;
      }

      const recordedValue = rule.recordedValue;
      let next;

      if (rule.type === 'builtin') {
        const def = BUILTIN_DEF_BY_ID[rule._defId ?? rule.id];
        if (!def) continue;
        const shouldInject = def.injectIf ? def.injectIf(current) : true;
        if (!shouldInject) continue;
        next = runInject(def.inject, current, currentValue, recordedValue);
      } else {
        next = runInject(rule.inject, current, currentValue, recordedValue);
      }

      if (next !== current) {
        const logEntry = {
          phase: 'inject',
          ruleId: rule.id,
          ruleName: rule.name,
          entryIndex,
          recordedValue: String(recordedValue ?? '').slice(0, 60),
          injectedValue: String(currentValue).slice(0, 60),
        };
        this._log.push(logEntry);
        injections.push(logEntry);

        if (this.debug) {
          console.log(
            `[Correlation] Injected [${rule.name}]: ` +
            `"${String(recordedValue ?? '').slice(0, 25)}…" → ` +
            `"${String(currentValue).slice(0, 25)}…" (entry ${entryIndex})`
          );
        }

        current = next;
      }
    }

    return { request: current, injections };
  }

  /**
   * Current variable snapshot. Useful for debugging and log output.
   * @returns {object}  Plain object: { ruleId: currentValue }
   */
  getVariables() {
    return Object.fromEntries(this.variables);
  }

  /**
   * Full log of all extraction and injection events in this session.
   * @returns {object[]}
   */
  getLog() {
    return [...this._log];
  }

  /**
   * Clear all extracted values and log. Use between iterations in a load test.
   */
  reset() {
    this.variables.clear();
    this._log = [];
  }

  /** @private Substitute {{param}} placeholders throughout a request. */
  _substituteParams(request) {
    const p = this.parameters;
    const r = { ...request };
    if (r.url) r.url = substituteParams(r.url, p);
    if (Array.isArray(r.headers)) {
      r.headers = r.headers.map(h => ({ name: h.name, value: substituteParams(h.value, p) }));
    }
    if (r.postData?.text) {
      r.postData = { ...r.postData, text: substituteParams(r.postData.text, p) };
    }
    return r;
  }
}
