/**
 * shared/correlation.test.js
 *
 * Unit tests for the SAP Fiori correlation engine.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 *
 * Run:
 *   node --test shared/correlation.test.js
 *
 * Or from the shared/ directory:
 *   node --test correlation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CorrelationEngine,
  CorrelationSession,
  getHeader,
  setHeader,
  parseSetCookies,
  replaceCookieInHeader,
  parseJsonSafe,
  resolveJsonPath,
  flattenJson,
  substituteParams,
  getResponseBodyText,
  getRequestBodyText,
  BUILTIN_RULE_DEFS,
} from './correlation.js';

// ── Helpers for building fake HAR entries ────────────────────────────────────

function makeEntry({ method = 'GET', url = 'https://example.com/', reqHeaders = [], reqBody = null,
  status = 200, resHeaders = [], resBody = null, time = 100, block = undefined } = {}) {
  return {
    _functionalBlock: block,
    time,
    request: {
      method,
      url,
      headers: reqHeaders,
      postData: reqBody ? { text: reqBody } : undefined,
    },
    response: {
      status,
      headers: resHeaders,
      content: { text: resBody ?? '' },
    },
  };
}

function h(name, value) { return { name, value }; }

// ── Utility function tests ───────────────────────────────────────────────────

describe('getHeader', () => {
  it('returns the header value (case-insensitive)', () => {
    const headers = [h('X-CSRF-Token', 'tok123'), h('Content-Type', 'application/json')];
    assert.equal(getHeader(headers, 'x-csrf-token'), 'tok123');
    assert.equal(getHeader(headers, 'content-type'), 'application/json');
  });

  it('returns undefined when header is absent', () => {
    assert.equal(getHeader([h('foo', 'bar')], 'missing'), undefined);
  });

  it('handles undefined/null headers gracefully', () => {
    assert.equal(getHeader(undefined, 'x'), undefined);
    assert.equal(getHeader(null, 'x'), undefined);
  });
});

describe('setHeader', () => {
  it('replaces an existing header (case-insensitive)', () => {
    const headers = [h('X-Csrf-Token', 'old')];
    const result = setHeader(headers, 'x-csrf-token', 'new');
    assert.equal(getHeader(result, 'x-csrf-token'), 'new');
    assert.equal(result.length, 1);
  });

  it('appends a new header when not present', () => {
    const headers = [h('Accept', '*/*')];
    const result = setHeader(headers, 'X-Custom', 'value');
    assert.equal(result.length, 2);
    assert.equal(getHeader(result, 'x-custom'), 'value');
  });

  it('does not mutate the original array', () => {
    const headers = [h('Accept', '*/*')];
    setHeader(headers, 'Accept', 'text/html');
    assert.equal(headers[0].value, '*/*');
  });
});

describe('parseSetCookies', () => {
  it('parses a single Set-Cookie header', () => {
    const headers = [h('Set-Cookie', 'SAP_SESSIONID_X=abc123; Path=/; HttpOnly')];
    const cookies = parseSetCookies(headers);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'SAP_SESSIONID_X');
    assert.equal(cookies[0].value, 'abc123');
  });

  it('parses multiple Set-Cookie headers', () => {
    const headers = [
      h('Set-Cookie', 'sap-contextid=ctx456; Path=/'),
      h('Set-Cookie', 'MYSAPSSO2=sso789; Path=/; Secure'),
    ];
    const cookies = parseSetCookies(headers);
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0].name, 'sap-contextid');
    assert.equal(cookies[1].name, 'MYSAPSSO2');
  });

  it('returns empty array for no Set-Cookie headers', () => {
    assert.deepEqual(parseSetCookies([h('Content-Type', 'text/html')]), []);
    assert.deepEqual(parseSetCookies([]), []);
  });
});

describe('replaceCookieInHeader', () => {
  it('replaces a named cookie value in the Cookie header', () => {
    const headers = [h('Cookie', 'sap-contextid=old; other=keep')];
    const result = replaceCookieInHeader(headers, 'sap-contextid', 'new123');
    assert.equal(getHeader(result, 'cookie'), 'sap-contextid=new123; other=keep');
  });

  it('leaves other headers untouched', () => {
    const headers = [h('Accept', 'json'), h('Cookie', 'SAP_SESSIONID_EX=oldval')];
    const result = replaceCookieInHeader(headers, 'SAP_SESSIONID_EX', 'newval');
    assert.equal(getHeader(result, 'accept'), 'json');
    assert.ok(getHeader(result, 'cookie').includes('newval'));
  });
});

describe('parseJsonSafe', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseJsonSafe('not json'), null);
    assert.equal(parseJsonSafe(''), null);
    assert.equal(parseJsonSafe(null), null);
    assert.equal(parseJsonSafe(undefined), null);
  });
});

describe('resolveJsonPath', () => {
  const obj = { d: { OrderID: 'ORD-001', results: [{ ID: 'R1', meta: { uri: '/Orders(1)' } }] } };

  it('resolves simple dot path', () => {
    assert.equal(resolveJsonPath(obj, 'd.OrderID'), 'ORD-001');
  });

  it('resolves path with array index', () => {
    assert.equal(resolveJsonPath(obj, 'd.results[0].ID'), 'R1');
  });

  it('resolves deep nested path', () => {
    assert.equal(resolveJsonPath(obj, 'd.results[0].meta.uri'), '/Orders(1)');
  });

  it('handles $. prefix', () => {
    assert.equal(resolveJsonPath(obj, '$.d.OrderID'), 'ORD-001');
  });

  it('returns undefined for missing path', () => {
    assert.equal(resolveJsonPath(obj, 'd.missing.key'), undefined);
  });

  it('handles null/undefined input gracefully', () => {
    assert.equal(resolveJsonPath(null, 'd.x'), undefined);
    assert.equal(resolveJsonPath(obj, null), undefined);
  });
});

describe('flattenJson', () => {
  it('returns leaf values that meet minimum length', () => {
    const obj = { id: 'SHORTID1234', tiny: 'hi', nested: { val: 'LONGENOUGHVALUE' } };
    const flat = flattenJson(obj);
    const values = flat.map(x => x.value);
    assert.ok(values.includes('SHORTID1234'));
    assert.ok(values.includes('LONGENOUGHVALUE'));
    assert.ok(!values.includes('hi'), 'short values should be excluded');
  });

  it('includes array items with paths', () => {
    const obj = { items: [{ id: 'ITEM00001111' }] };
    const flat = flattenJson(obj);
    assert.ok(flat.some(x => x.path === 'items[0].id'));
  });

  it('respects maxDepth', () => {
    const obj = { a: { b: { c: { d: 'DEEPVALUE12345' } } } };
    const shallow = flattenJson(obj, '', 2);
    const values = shallow.map(x => x.value);
    assert.ok(!values.includes('DEEPVALUE12345'), 'deep value should not appear at maxDepth=2');
  });
});

describe('substituteParams', () => {
  it('replaces {{param}} placeholders', () => {
    const result = substituteParams('Hello {{name}}, your pass is {{pass}}', { name: 'alice', pass: 'S3cret!' });
    assert.equal(result, 'Hello alice, your pass is S3cret!');
  });

  it('leaves unmatched placeholders unchanged', () => {
    const result = substituteParams('Host: {{host}}', { user: 'bob' });
    assert.equal(result, 'Host: {{host}}');
  });

  it('handles null/empty input gracefully', () => {
    assert.equal(substituteParams(null, {}), null);
    assert.equal(substituteParams('', {}), '');
    assert.equal(substituteParams('abc', null), 'abc');
  });
});

// ── Built-in CSRF Token Rule ─────────────────────────────────────────────────

describe('CorrelationEngine — CSRF token (builtin)', () => {
  it('detects and applies x-csrf-token correlation', () => {
    const entries = [
      // Entry 0: CSRF fetch
      makeEntry({
        method: 'GET', url: 'https://sap.example.com/sap/bc/ui5_ui5/',
        reqHeaders: [h('x-csrf-token', 'Fetch')],
        resHeaders: [h('x-csrf-token', 'TOKEN-ABC-999')],
      }),
      // Entry 1: POST that should carry the token
      makeEntry({
        method: 'POST', url: 'https://sap.example.com/sap/opu/odata/ORDER',
        reqHeaders: [h('x-csrf-token', 'TOKEN-ORIGINAL-RECORDED'), h('Content-Type', 'application/json')],
        resHeaders: [],
        resBody: '{"d":{"OrderID":"ORD-001"}}',
      }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);

    const csrfRule = rules.find(r => r.id === 'sap_csrf_token');
    assert.ok(csrfRule, 'CSRF rule should be detected');
    assert.ok(csrfRule.extractFromIndices.includes(0), 'should extract from entry 0');
    assert.ok(csrfRule.injectIntoIndices.includes(1), 'should inject into entry 1');
    assert.equal(csrfRule.recordedValue, 'TOKEN-ABC-999');

    // Replay simulation
    const session = engine.createSession(rules);

    // Step 1: send entry 0 request (no injection needed — it's the token fetch)
    const { request: req0 } = session.applyToRequest(entries[0].request, 0);
    assert.equal(getHeader(req0.headers, 'x-csrf-token'), 'Fetch', 'Fetch header should be unchanged');

    // Step 2: process entry 0 response → extracts TOKEN-ABC-999
    const extracted = session.processResponse(entries[0].response, 0);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].value, 'TOKEN-ABC-999');

    // Step 3: apply to entry 1 request → injects live token
    const liveToken = 'TOKEN-LIVE-777';
    session.variables.set('sap_csrf_token', liveToken); // simulate live token received
    const { request: req1, injections } = session.applyToRequest(entries[1].request, 1);
    assert.equal(injections.length, 1, 'one injection should occur');
    assert.equal(getHeader(req1.headers, 'x-csrf-token'), liveToken);
  });

  it('does not inject CSRF into GET requests', () => {
    const entries = [
      makeEntry({ resHeaders: [h('x-csrf-token', 'TOK-123456')] }),
      makeEntry({ method: 'GET', reqHeaders: [h('x-csrf-token', 'TOK-RECORDED')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const csrfRule = rules.find(r => r.id === 'sap_csrf_token');
    // GET does not need CSRF injection — injectIntoIndices should exclude entry 1
    if (csrfRule) {
      assert.ok(!csrfRule.injectIntoIndices.includes(1), 'should not inject into GET request');
    }
  });

  it('ignores x-csrf-token: Required in responses', () => {
    const entries = [
      makeEntry({ resHeaders: [h('x-csrf-token', 'Required')] }),
      makeEntry({ method: 'POST', reqHeaders: [h('x-csrf-token', 'somevalue')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const csrfRule = rules.find(r => r.id === 'sap_csrf_token');
    assert.ok(!csrfRule, '"Required" should not be treated as a real token');
  });
});

// ── ETag → If-Match ──────────────────────────────────────────────────────────

describe('CorrelationEngine — ETag/If-Match (builtin)', () => {
  it('correlates ETag to If-Match header', () => {
    const entries = [
      makeEntry({
        method: 'GET', url: 'https://sap.example.com/sap/opu/odata/Orders(1)',
        resHeaders: [h('ETag', 'W/"abc123def456"')],
      }),
      makeEntry({
        method: 'PUT', url: 'https://sap.example.com/sap/opu/odata/Orders(1)',
        reqHeaders: [h('If-Match', 'W/"RECORDED_ETAG_VALUE"')],
      }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const etagRule = rules.find(r => r.id === 'sap_etag_if_match');

    assert.ok(etagRule, 'ETag rule should be detected');
    assert.equal(etagRule.recordedValue, 'W/"abc123def456"');
    assert.ok(etagRule.injectIntoIndices.includes(1));

    const session = engine.createSession(rules);
    session.processResponse(entries[0].response, 0);

    const liveEtag = 'W/"live-etag-789"';
    session.variables.set('sap_etag_if_match', liveEtag);
    const { request: req1 } = session.applyToRequest(entries[1].request, 1);
    assert.equal(getHeader(req1.headers, 'if-match'), liveEtag);
  });

  it('does not inject when If-Match is *', () => {
    const entries = [
      makeEntry({ resHeaders: [h('ETag', 'W/"etag12345678"')] }),
      makeEntry({ method: 'DELETE', reqHeaders: [h('If-Match', '*')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const etagRule = rules.find(r => r.id === 'sap_etag_if_match');
    if (etagRule) {
      assert.ok(!etagRule.injectIntoIndices.includes(1), 'If-Match: * should not be correlated');
    }
  });
});

// ── Session Cookie Correlation ───────────────────────────────────────────────

describe('CorrelationEngine — SAP session cookies (builtin)', () => {
  it('correlates sap-contextid cookie', () => {
    const entries = [
      makeEntry({
        resHeaders: [h('Set-Cookie', 'sap-contextid=CTX-LIVE-VALUE; Path=/')],
      }),
      makeEntry({
        reqHeaders: [h('Cookie', 'sap-contextid=CTX-RECORDED; other=keep')],
      }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const ctxRule = rules.find(r => r.id === 'sap_context_id');

    assert.ok(ctxRule, 'sap-contextid rule should be detected');
    assert.ok(ctxRule.injectIntoIndices.includes(1));

    const session = engine.createSession(rules);
    session.processResponse(entries[0].response, 0);

    session.variables.set('sap_context_id', 'sap-contextid=CTX-NEW-LIVE');
    const { request: req1 } = session.applyToRequest(entries[1].request, 1);
    const cookie = getHeader(req1.headers, 'cookie');
    assert.ok(cookie.includes('CTX-NEW-LIVE'), `cookie should contain new value, got: ${cookie}`);
    assert.ok(cookie.includes('other=keep'), 'other cookies should be preserved');
  });

  it('correlates SAP_SESSIONID_* cookie', () => {
    const entries = [
      makeEntry({ resHeaders: [h('Set-Cookie', 'SAP_SESSIONID_EX_001=SESSVAL123; Path=/')] }),
      makeEntry({ reqHeaders: [h('Cookie', 'SAP_SESSIONID_EX_001=OLDSESS; foo=bar')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const sessRule = rules.find(r => r.id === 'sap_session_id');

    assert.ok(sessRule, 'SAP_SESSIONID rule should be detected');
    assert.ok(sessRule.injectIntoIndices.includes(1));
  });
});

// ── Generic (Auto) Correlation ───────────────────────────────────────────────

describe('CorrelationEngine — generic auto correlation', () => {
  it('detects value from JSON response body in subsequent URL', () => {
    const entries = [
      makeEntry({
        resBody: JSON.stringify({ d: { PurchaseOrderID: 'PO-2024-XYZ-001' } }),
      }),
      makeEntry({
        url: 'https://sap.example.com/sap/opu/odata/PurchaseOrders(\'PO-2024-XYZ-001\')',
        resBody: '',
      }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const autoRule = rules.find(r => r.type === 'auto' && r.recordedValue === 'PO-2024-XYZ-001');

    assert.ok(autoRule, 'auto rule should be detected for PurchaseOrderID in URL');
    assert.ok(autoRule.injectIntoIndices.includes(1));
    assert.equal(autoRule.inject.into, 'request_url');
    assert.equal(autoRule.inject.placeholder, 'PO-2024-XYZ-001');
  });

  it('detects value from JSON body in subsequent request body', () => {
    const orderKey = 'ORDERKEY-789-ABC-XYZ';
    const entries = [
      makeEntry({ resBody: JSON.stringify({ d: { InternalKey: orderKey } }) }),
      makeEntry({ method: 'POST', reqBody: JSON.stringify({ Key: orderKey, Amount: 100 }) }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const autoRule = rules.find(r => r.type === 'auto' && r.recordedValue === orderKey);

    assert.ok(autoRule, 'auto rule should detect key in POST body');
    assert.equal(autoRule.inject.into, 'request_body_literal');
  });

  it('applies auto injection: replaces placeholder with live value in URL', () => {
    const recorded = 'RECORDED-ORDER-0001';
    const live = 'LIVE-ORDER-0002';

    const entries = [
      makeEntry({ resBody: JSON.stringify({ d: { OrderRef: recorded } }) }),
      makeEntry({ url: `https://sap.example.com/Orders('${recorded}')` }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const session = engine.createSession(rules);

    session.processResponse(entries[0].response, 0);
    session.variables.set(rules.find(r => r.recordedValue === recorded).id, live);

    const { request: req1, injections } = session.applyToRequest(entries[1].request, 1);
    assert.ok(injections.length > 0, 'injection should occur');
    assert.ok(req1.url.includes(live), `URL should contain live value, got: ${req1.url}`);
    assert.ok(!req1.url.includes(recorded), 'URL should not contain recorded value');
  });

  it('does not create auto rules for values shorter than MIN_AUTO_CORRELATION_LENGTH', () => {
    const entries = [
      makeEntry({ resBody: JSON.stringify({ d: { TinyID: 'ABC' } }) }),
      makeEntry({ url: 'https://example.com/ABC' }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const shortRule = rules.find(r => r.recordedValue === 'ABC');
    assert.ok(!shortRule, 'short values should not generate auto rules');
  });
});

// ── Parameter Substitution ───────────────────────────────────────────────────

describe('CorrelationSession — parameter substitution', () => {
  it('substitutes {{username}} and {{password}} in request headers', () => {
    const entries = [
      makeEntry({
        method: 'POST',
        url: 'https://sap.example.com/sap/bc/sec/oauth2/token',
        reqHeaders: [
          h('Authorization', 'Basic {{b64creds}}'),
          h('Content-Type', 'application/x-www-form-urlencoded'),
        ],
        reqBody: 'grant_type=password&username={{username}}&password={{password}}',
      }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const session = engine.createSession(rules, {
      username: 'testuser01',
      password: 'TestPass!99',
      b64creds: 'dGVzdHVzZXIwMTpUZXN0UGFzcyE5OQ==',
    });

    const { request } = session.applyToRequest(entries[0].request, 0);
    assert.ok(request.postData.text.includes('testuser01'));
    assert.ok(request.postData.text.includes('TestPass!99'));
    assert.equal(
      getHeader(request.headers, 'Authorization'),
      'Basic dGVzdHVzZXIwMTpUZXN0UGFzcyE5OQ=='
    );
  });

  it('substitutes {{host}} in URL', () => {
    const entries = [makeEntry({ url: 'https://{{host}}/sap/opu/odata/ORDERS' })];
    const engine = new CorrelationEngine();
    const session = engine.createSession([], { host: 'staging.sap.example.com' });
    const { request } = session.applyToRequest(entries[0].request, 0);
    assert.equal(request.url, 'https://staging.sap.example.com/sap/opu/odata/ORDERS');
  });
});

// ── Session Reset ────────────────────────────────────────────────────────────

describe('CorrelationSession — reset', () => {
  it('clears variables and log on reset()', () => {
    const entries = [
      makeEntry({ resHeaders: [h('x-csrf-token', 'TOK-RESETTEST1')] }),
      makeEntry({ method: 'POST', reqHeaders: [h('x-csrf-token', 'TOK-RECORDED')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const session = engine.createSession(rules);

    session.processResponse(entries[0].response, 0);
    assert.ok(session.variables.size > 0);
    assert.ok(session.getLog().length > 0);

    session.reset();
    assert.equal(session.variables.size, 0);
    assert.equal(session.getLog().length, 0);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('CorrelationEngine — edge cases', () => {
  it('handles empty entries array without throwing', () => {
    const engine = new CorrelationEngine();
    const rules = engine.analyze([]);
    assert.deepEqual(rules, []);
  });

  it('handles entries with null/missing response gracefully', () => {
    const entries = [
      { request: { method: 'GET', url: 'https://example.com', headers: [] }, response: null },
    ];
    const engine = new CorrelationEngine();
    assert.doesNotThrow(() => engine.analyze(entries));
  });

  it('session.applyToRequest returns original request when no rules match', () => {
    const req = { method: 'GET', url: 'https://example.com', headers: [] };
    const session = new CorrelationSession([], {});
    const { request, injections } = session.applyToRequest(req, 0);
    assert.equal(request, req);
    assert.deepEqual(injections, []);
  });

  it('session.processResponse returns empty array for null response', () => {
    const session = new CorrelationSession([], {});
    const result = session.processResponse(null, 0);
    assert.deepEqual(result, []);
  });

  it('does not mutate the original request object', () => {
    const entries = [
      makeEntry({ resHeaders: [h('x-csrf-token', 'ORIGTOKEN1234')] }),
      makeEntry({ method: 'POST', reqHeaders: [h('x-csrf-token', 'OLD')] }),
    ];

    const engine = new CorrelationEngine();
    const rules = engine.analyze(entries);
    const session = engine.createSession(rules);
    session.processResponse(entries[0].response, 0);
    session.variables.set('sap_csrf_token', 'NEWTOKEN5678');

    const originalRequest = entries[1].request;
    const originalValue = getHeader(originalRequest.headers, 'x-csrf-token');

    session.applyToRequest(originalRequest, 1);

    assert.equal(
      getHeader(originalRequest.headers, 'x-csrf-token'),
      originalValue,
      'original request headers must not be mutated'
    );
  });

  it('getVariables returns a snapshot of current values', () => {
    const session = new CorrelationSession([], {});
    session.variables.set('rule_a', 'val1');
    session.variables.set('rule_b', 'val2');
    const vars = session.getVariables();
    assert.equal(vars.rule_a, 'val1');
    assert.equal(vars.rule_b, 'val2');
  });
});

// ── har-utils smoke tests ─────────────────────────────────────────────────────

import { parseHar, filterByUrl, filterByStatus, filterByBlock, groupByBlock, summarizeBlocks } from './har-utils.js';

describe('har-utils', () => {
  const sampleHar = JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'test', version: '1' },
      entries: [
        { time: 120, _functionalBlock: 'Login', request: { method: 'GET', url: 'https://sap.example.com/sap/bc/ui5', headers: [] }, response: { status: 200, headers: [], content: { text: '' } } },
        { time: 300, _functionalBlock: 'Login', request: { method: 'POST', url: 'https://sap.example.com/sap/opu/odata/ORDERS', headers: [] }, response: { status: 201, headers: [], content: { text: '' } } },
        { time: 80,  _functionalBlock: 'Logout', request: { method: 'GET', url: 'https://sap.example.com/sap/bc/logout', headers: [] }, response: { status: 302, headers: [], content: { text: '' } } },
        { time: 50,  _functionalBlock: 'Login', request: { method: 'GET', url: 'https://other.example.com/api', headers: [] }, response: { status: 500, headers: [], content: { text: '' } } },
      ],
    },
  });

  it('parseHar stamps _entryIndex on each entry', () => {
    const log = parseHar(sampleHar);
    assert.equal(log.entries[0]._entryIndex, 0);
    assert.equal(log.entries[3]._entryIndex, 3);
  });

  it('parseHar throws on invalid input', () => {
    assert.throws(() => parseHar('not json'), /HAR parse failed/);
    assert.throws(() => parseHar('{}'), /HAR parse failed/);
  });

  it('filterByUrl filters by substring', () => {
    const log = parseHar(sampleHar);
    const filtered = filterByUrl(log.entries, '/sap/opu/odata/');
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].request.url.includes('/sap/opu/odata/'));
  });

  it('filterByUrl filters by regex string', () => {
    const log = parseHar(sampleHar);
    const filtered = filterByUrl(log.entries, '/sap\\.example\\.com\\/sap\\/bc\\//');
    assert.ok(filtered.length >= 2);
  });

  it('filterByStatus filters by status range', () => {
    const log = parseHar(sampleHar);
    const success = filterByStatus(log.entries, [{ min: 200, max: 299 }]);
    assert.equal(success.length, 2);
    const errors = filterByStatus(log.entries, [{ min: 500, max: 599 }]);
    assert.equal(errors.length, 1);
  });

  it('filterByBlock filters by block name', () => {
    const log = parseHar(sampleHar);
    const loginEntries = filterByBlock(log.entries, ['Login']);
    assert.equal(loginEntries.length, 3);
    const logoutEntries = filterByBlock(log.entries, ['Logout']);
    assert.equal(logoutEntries.length, 1);
  });

  it('summarizeBlocks returns per-block summary', () => {
    const log = parseHar(sampleHar);
    const summary = summarizeBlocks(log.entries);
    const login = summary.find(r => r.block === 'Login');
    const logout = summary.find(r => r.block === 'Logout');
    assert.ok(login, 'Login block should be in summary');
    assert.equal(login.requestCount, 3);
    assert.equal(login.totalMs, 470);
    assert.ok(logout, 'Logout block should be in summary');
    assert.equal(logout.requestCount, 1);
  });
});
