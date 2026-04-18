#!/usr/bin/env node
/**
 * replay-service/server.js
 *
 * Local HTTP API server that the Chrome extension side panel talks to.
 * Runs replay jobs and streams progress so the panel can show live results.
 *
 * Endpoints:
 *   GET  /health            → { status, version, jobs }
 *   POST /replay            → { jobId }   (starts async job)
 *   GET  /status/:jobId     → { status, progress, results[], report, error }
 *
 * Usage:
 *   node server.js            (default port 7331)
 *   PORT=8080 node server.js
 */

import { createServer } from 'node:http';
import { Replayer }     from './replayer.js';
import { buildReport }  from './report.js';

const PORT = parseInt(process.env.PORT ?? '7331', 10);
const VERSION = '0.1.0';

// ── Job store ─────────────────────────────────────────────────────────────────

let _jobId = 0;
/** @type {Map<string, Job>} */
const jobs = new Map();

/**
 * @typedef {object} Job
 * @property {string}   id
 * @property {'running'|'done'|'error'} status
 * @property {{ completed: number, total: number }} progress
 * @property {object[]} results
 * @property {object|null} report
 * @property {string|null} error
 * @property {number} startedAt  unix ms
 */

function createJob(total) {
  const id  = String(++_jobId);
  /** @type {Job} */
  const job = {
    id,
    status:    'running',
    progress:  { completed: 0, total },
    results:   [],
    report:    null,
    error:     null,
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  // Auto-cleanup after 10 minutes
  setTimeout(() => jobs.delete(id), 10 * 60_000);
  return job;
}

// ── Replay runner ─────────────────────────────────────────────────────────────

async function runJob(job, entries, options) {
  const harLog  = { entries };
  const replayer = new Replayer(harLog, {
    blocks:           options.blocks      ?? null,
    thinkTimeMs:      options.thinkTimeMs ?? 0,
    skipStaticAssets: options.skipStaticAssets ?? false,
    debug:            false,
    timeout:          options.timeout     ?? 30_000,
  });

  function onResult(iterResults) {
    job.results.push(...iterResults);
    job.progress.completed++;
  }

  const vusers     = Math.max(1, options.vusers     ?? 1);
  const iterations = Math.max(1, options.iterations ?? 1);
  const params     = options.params ?? {};

  const allResults = vusers > 1
    ? await replayer.runConcurrent({ vusers, iterations, params, onResult })
    : await replayer.run({ iterations, params, onResult });

  job.report = buildReport(allResults);
  job.status = 'done';
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, code, body) {
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── Request router ────────────────────────────────────────────────────────────

function router(req, res) {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      status:  'ok',
      version: VERSION,
      jobs:    { running: [...jobs.values()].filter(j => j.status === 'running').length },
    });
    return;
  }

  // POST /replay  — body: { entries[], options }
  if (req.method === 'POST' && req.url === '/replay') {
    readBody(req).then(raw => {
      let body;
      try { body = JSON.parse(raw); }
      catch { json(res, 400, { error: 'Invalid JSON body' }); return; }

      const { entries, options = {} } = body;
      if (!Array.isArray(entries) || entries.length === 0) {
        json(res, 400, { error: 'entries must be a non-empty array' });
        return;
      }

      const vusers     = Math.max(1, options.vusers     ?? 1);
      const iterations = Math.max(1, options.iterations ?? 1);
      const job = createJob(vusers * iterations);

      console.log(
        `[Job ${job.id}] Starting: ${entries.length} entries × ` +
        `${iterations} iter × ${vusers} VU(s)`
      );

      runJob(job, entries, options).catch(err => {
        job.status = 'error';
        job.error  = err.message;
        console.error(`[Job ${job.id}] Error:`, err.message);
      });

      json(res, 202, { jobId: job.id });
    }).catch(err => json(res, 500, { error: err.message }));
    return;
  }

  // GET /status/:jobId
  const statusMatch = req.url?.match(/^\/status\/(\d+)$/);
  if (req.method === 'GET' && statusMatch) {
    const job = jobs.get(statusMatch[1]);
    if (!job) { json(res, 404, { error: 'Job not found' }); return; }

    json(res, 200, {
      status:   job.status,
      progress: job.progress,
      results:  job.results,
      report:   job.report,
      error:    job.error,
      elapsedMs: Date.now() - job.startedAt,
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end('Not found');
}

// ── Start ─────────────────────────────────────────────────────────────────────

createServer(router).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  SAP Fiori Replay Server');
  console.log('  ─────────────────────────────────────');
  console.log(`  Listening on  http://localhost:${PORT}`);
  console.log(`  Health check  http://localhost:${PORT}/health`);
  console.log('');
  console.log('  Waiting for replay requests from the Chrome extension…');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
