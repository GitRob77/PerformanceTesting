#!/usr/bin/env node
/**
 * UiPath Web Recorder - HAR Replay API Server
 *
 * Standalone API server for replaying HAR files recorded from the Chrome extension.
 * Exposes REST API for managing and replaying recordings.
 *
 * Usage:
 *   npm install express cors
 *   node replay-api-server.js [--port 3000]
 *
 * API Endpoints:
 *   POST   /api/recordings              Upload HAR file
 *   GET    /api/recordings              List all recordings
 *   GET    /api/recordings/:id          Get recording details
 *   POST   /api/recordings/:id/replay   Replay a recording
 *   DELETE /api/recordings/:id          Delete recording
 *   GET    /ui                          Web UI
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1] || '3000', 10);
const DATA_DIR = path.join(__dirname, '.har-recordings');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── In-Memory Recording Store ───────────────────────────────────────────────

const recordings = new Map(); // id -> { id, name, timestamp, har, status }

// Load existing recordings from disk
function loadRecordings() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    files.forEach(file => {
      if (file.endsWith('.har')) {
        const id = file.replace('.har', '');
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
        const har = JSON.parse(content);
        recordings.set(id, {
          id,
          name: har.log?.creator?.name || 'Unknown',
          timestamp: fs.statSync(path.join(DATA_DIR, file)).mtime.toISOString(),
          har,
          status: 'idle',
        });
      }
    });
    console.log(`Loaded ${recordings.size} recordings from disk.`);
  } catch (err) {
    console.error('Error loading recordings:', err.message);
  }
}

function saveRecording(id, har) {
  const filePath = path.join(DATA_DIR, `${id}.har`);
  fs.writeFileSync(filePath, JSON.stringify(har, null, 2));
}

// ─── Correlation Engine ──────────────────────────────────────────────────────

const CORRELATION_RULES = [
  { name: 'SAP X-CSRF-Token', extract: 'x-csrf-token', variable: '_csrf', inject: 'x-csrf-token', methods: ['POST','PUT','DELETE','PATCH','MERGE'] },
  { name: 'X-XSRF-Token', extract: 'x-xsrf-token', variable: '_xsrf', inject: 'x-xsrf-token', methods: ['POST','PUT','DELETE','PATCH'] },
  { name: 'RequestVerificationToken', extract: 'requestverificationtoken', variable: '_rvt', inject: 'requestverificationtoken', methods: ['POST','PUT','DELETE','PATCH'] },
];

const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'upgrade-insecure-requests', 'accept-encoding', 'accept-language',
]);

async function replayHar(har, options = {}) {
  const { delay = 0, baseUrl = '', filter = '', maxRequests = 0 } = options;
  const entries = har.log?.entries || [];
  const results = [];
  const vars = {};

  let processed = 0;
  for (const entry of entries) {
    if (maxRequests > 0 && processed >= maxRequests) break;

    const req = entry.request || {};
    const url_str = req.url || '';

    // Filter check
    if (filter && !new RegExp(filter, 'i').test(url_str)) {
      continue;
    }

    const method = (req.method || 'GET').toUpperCase();
    const targetUrl = baseUrl ? rewriteUrl(url_str, baseUrl) : url_str;

    // Build headers
    const headers = {};
    (req.headers || []).forEach(({ name, value }) => {
      if (!SKIP_HEADERS.has(name.toLowerCase())) {
        headers[name] = value;
      }
    });

    // Inject correlation tokens
    for (const rule of CORRELATION_RULES) {
      if (vars[rule.variable] && rule.methods.includes(method)) {
        headers[rule.inject] = vars[rule.variable];
      }
    }

    const fetchOpts = { method, headers, timeout: 30000 };
    if (!['GET', 'HEAD'].includes(method) && req.postData?.text) {
      fetchOpts.body = req.postData.text;
    }

    const t0 = Date.now();
    let result;
    try {
      const res = await fetch(targetUrl, fetchOpts);
      const body = await res.text().catch(() => '');
      const time = Date.now() - t0;

      const extractedVars = [];
      const correlationsUsed = [];

      // Extract correlation tokens
      for (const rule of CORRELATION_RULES) {
        const headerName = rule.extract.toLowerCase();
        let val = '';
        for (const [k, v] of Object.entries(res.headers.raw?.() || {})) {
          if (k.toLowerCase() === headerName) {
            val = Array.isArray(v) ? v[0] : v;
            break;
          }
        }
        if (val && !/^(fetch|required|unsafe|no-cors)$/i.test(val.trim())) {
          if (vars[rule.variable] !== val) {
            vars[rule.variable] = val;
            extractedVars.push({ rule: rule.name, value: val.slice(0, 40) });
          }
        }
        if (vars[rule.variable] && rule.methods.includes(method)) {
          correlationsUsed.push(rule.name);
        }
      }

      result = {
        ok: res.status < 400,
        url: targetUrl,
        method,
        status: res.status,
        statusText: res.statusText,
        time,
        extractedVars,
        correlationsUsed,
      };
    } catch (err) {
      result = {
        ok: false,
        url: targetUrl,
        method,
        error: err.message,
        time: Date.now() - t0,
        extractedVars: [],
        correlationsUsed: [],
      };
    }

    results.push(result);
    processed++;

    if (delay > 0 && processed < entries.length) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return { results, vars };
}

function rewriteUrl(urlStr, baseUrl) {
  if (!urlStr || !baseUrl) return urlStr;
  try {
    const orig = new URL(urlStr);
    const base = new URL(baseUrl);
    return base.origin + orig.pathname + orig.search;
  } catch (_) { return urlStr; }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function parseJson(body) {
  try { return JSON.parse(body); } catch (_) { return null; }
}

async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ─── POST /api/recordings - Upload HAR ──────────────────────────────────

  if (req.method === 'POST' && pathname === '/api/recordings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const har = parseJson(body);
      if (!har || !har.log) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid HAR format' }));
        return;
      }

      const id = generateId();
      const recording = {
        id,
        name: har.log?.creator?.name || `Recording ${id}`,
        timestamp: new Date().toISOString(),
        har,
        status: 'idle',
      };
      recordings.set(id, recording);
      saveRecording(id, har);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, name: recording.name, timestamp: recording.timestamp }));
    });
    return;
  }

  // ─── GET /api/recordings - List recordings ──────────────────────────────

  if (req.method === 'GET' && pathname === '/api/recordings') {
    const list = Array.from(recordings.values()).map(r => ({
      id: r.id,
      name: r.name,
      timestamp: r.timestamp,
      requestCount: r.har.log?.entries?.length || 0,
      status: r.status,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // ─── GET /api/recordings/:id - Get recording ────────────────────────────

  if (req.method === 'GET' && pathname.match(/^\/api\/recordings\/[a-f0-9]+$/)) {
    const id = pathname.split('/')[3];
    const rec = recordings.get(id);
    if (!rec) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: rec.id,
      name: rec.name,
      timestamp: rec.timestamp,
      requestCount: rec.har.log?.entries?.length || 0,
      status: rec.status,
    }));
    return;
  }

  // ─── POST /api/recordings/:id/replay - Replay ────────────────────────────

  if (req.method === 'POST' && pathname.match(/^\/api\/recordings\/[a-f0-9]+\/replay$/)) {
    const id = pathname.split('/')[3];
    const rec = recordings.get(id);
    if (!rec) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const opts = parseJson(body) || {};
      rec.status = 'replaying';

      try {
        const outcome = await replayHar(rec.har, opts);
        rec.status = 'idle';
        const ok = outcome.results.filter(r => r.ok).length;
        const err = outcome.results.length - ok;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok,
          failed: err,
          total: outcome.results.length,
          results: outcome.results,
          vars: outcome.vars,
        }));
      } catch (err) {
        rec.status = 'error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ─── DELETE /api/recordings/:id - Delete recording ──────────────────────

  if (req.method === 'DELETE' && pathname.match(/^\/api\/recordings\/[a-f0-9]+$/)) {
    const id = pathname.split('/')[3];
    if (!recordings.has(id)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
      return;
    }
    recordings.delete(id);
    try { fs.unlinkSync(path.join(DATA_DIR, `${id}.har`)); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'deleted' }));
    return;
  }

  // ─── GET /ui - Simple Web UI ────────────────────────────────────────────

  if (req.method === 'GET' && pathname === '/ui') {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>HAR Replay API</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; font-size: 28px; }
    h2 { color: #555; margin-top: 30px; margin-bottom: 15px; font-size: 18px; border-bottom: 2px solid #fa4616; padding-bottom: 8px; }
    .section { margin-bottom: 30px; }
    .upload-box { border: 2px dashed #ccc; border-radius: 8px; padding: 40px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .upload-box:hover { border-color: #fa4616; background: #fafafa; }
    .upload-box input { display: none; }
    .btn { background: #fa4616; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
    .btn:hover { background: #e03d10; }
    .btn-small { padding: 6px 12px; font-size: 12px; }
    .btn-danger { background: #e74c3c; }
    .btn-danger:hover { background: #c0392b; }
    .recordings-list { list-style: none; }
    .recording-item { background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 4px; padding: 15px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .recording-info h3 { color: #333; font-size: 14px; margin-bottom: 4px; }
    .recording-info p { color: #999; font-size: 12px; }
    .recording-actions { display: flex; gap: 8px; }
    .badge { display: inline-block; background: #e8f4f8; color: #0066cc; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .status { font-weight: 600; }
    .status.idle { color: #888; }
    .status.replaying { color: #fa4616; }
    .status.error { color: #e74c3c; }
    .replay-result { background: #f0f7ff; border-left: 4px solid #0066cc; padding: 15px; border-radius: 4px; margin-top: 15px; }
    .replay-result.error { background: #fff5f5; border-color: #e74c3c; }
    .replay-result h4 { margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔄 HAR Replay API</h1>

    <div class="section">
      <h2>Upload Recording</h2>
      <div class="upload-box" id="uploadBox">
        <p>Drop HAR file here or click to select</p>
        <input type="file" id="harInput" accept=".har" />
      </div>
    </div>

    <div class="section">
      <h2>Recordings</h2>
      <ul class="recordings-list" id="recordingsList">
        <li style="color: #999; padding: 15px;">No recordings yet</li>
      </ul>
    </div>
  </div>

  <script>
    const API = 'http://localhost:${PORT}/api';

    async function loadRecordings() {
      try {
        const res = await fetch(API + '/recordings');
        const data = await res.json();
        const list = document.getElementById('recordingsList');
        if (data.length === 0) {
          list.innerHTML = '<li style="color: #999; padding: 15px;">No recordings yet</li>';
          return;
        }
        list.innerHTML = data.map(r => \`
          <li class="recording-item">
            <div class="recording-info">
              <h3>\${r.name}</h3>
              <p><span class="badge">\${r.requestCount} requests</span> · \${new Date(r.timestamp).toLocaleString()}</p>
            </div>
            <div class="recording-actions">
              <button class="btn btn-small" onclick="replayRecording('\${r.id}')">▶ Replay</button>
              <button class="btn btn-small btn-danger" onclick="deleteRecording('\${r.id}')">✕</button>
            </div>
          </li>
        \`).join('');
      } catch (err) {
        alert('Error loading recordings: ' + err.message);
      }
    }

    async function replayRecording(id) {
      const delay = parseInt(prompt('Delay between requests (ms):', '0'), 10) || 0;
      try {
        const res = await fetch(API + '/recordings/' + id + '/replay', {
          method: 'POST',
          body: JSON.stringify({ delay }),
        });
        const data = await res.json();
        const html = \`
          <div class="replay-result">
            <h4>✓ Replay Complete</h4>
            <p><strong>\${data.ok}</strong> passed · <strong>\${data.failed}</strong> failed · <strong>\${data.total}</strong> total</p>
            <details>
              <summary>View Results</summary>
              <pre>\${JSON.stringify(data.results, null, 2)}</pre>
            </details>
          </div>
        \`;
        document.body.insertAdjacentHTML('beforeend', html);
      } catch (err) {
        alert('Replay failed: ' + err.message);
      }
    }

    async function deleteRecording(id) {
      if (!confirm('Delete this recording?')) return;
      try {
        await fetch(API + '/recordings/' + id, { method: 'DELETE' });
        loadRecordings();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    }

    // Upload handler
    document.getElementById('uploadBox').addEventListener('click', () => {
      document.getElementById('harInput').click();
    });

    document.getElementById('harInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const har = JSON.parse(text);
        const res = await fetch(API + '/recordings', {
          method: 'POST',
          body: JSON.stringify(har),
        });
        if (res.ok) {
          alert('Recording uploaded!');
          loadRecordings();
        } else {
          alert('Upload failed: ' + (await res.text()));
        }
      } catch (err) {
        alert('Invalid HAR file: ' + err.message);
      }
    });

    // Drag & drop
    document.getElementById('uploadBox').addEventListener('dragover', (e) => {
      e.preventDefault();
      e.currentTarget.style.borderColor = '#fa4616';
      e.currentTarget.style.background = '#fafafa';
    });
    document.getElementById('uploadBox').addEventListener('dragleave', (e) => {
      e.currentTarget.style.borderColor = '#ccc';
      e.currentTarget.style.background = '';
    });
    document.getElementById('uploadBox').addEventListener('drop', async (e) => {
      e.preventDefault();
      e.currentTarget.style.borderColor = '#ccc';
      e.currentTarget.style.background = '';
      const file = e.dataTransfer.files[0];
      if (!file?.name.endsWith('.har')) {
        alert('Please drop a .har file');
        return;
      }
      const text = await file.text();
      try {
        const har = JSON.parse(text);
        const res = await fetch(API + '/recordings', {
          method: 'POST',
          body: JSON.stringify(har),
        });
        if (res.ok) {
          alert('Recording uploaded!');
          loadRecordings();
        } else {
          alert('Upload failed');
        }
      } catch (err) {
        alert('Invalid HAR file');
      }
    });

    // Load on start
    loadRecordings();
  </script>
</body>
</html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ─── 404 ──────────────────────────────────────────────────────────────────

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─── Start Server ──────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

loadRecordings();

server.listen(PORT, () => {
  console.log(`\n🚀 HAR Replay API Server running on port ${PORT}`);
  console.log(`\n📡 API Base: http://localhost:${PORT}/api`);
  console.log(`🌐 Web UI:  http://localhost:${PORT}/ui`);
  console.log(`\n📝 API Endpoints:`);
  console.log(`   POST   /api/recordings              Upload HAR file`);
  console.log(`   GET    /api/recordings              List recordings`);
  console.log(`   POST   /api/recordings/:id/replay   Replay recording`);
  console.log(`   DELETE /api/recordings/:id          Delete recording`);
  console.log(`\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
