#!/usr/bin/env node
/**
 * replay-service/runner.js
 *
 * CLI entry point for the headless SAP Fiori HTTP replay engine.
 *
 * Usage:
 *   node runner.js --har <recording.har> [options]
 *
 * Options:
 *   --iterations N          Number of iterations per virtual user  (default: 1)
 *   --vusers N              Concurrent virtual users               (default: 1)
 *   --blocks "Login,PO"     Comma-separated block names to replay  (default: all)
 *   --param key=value       {{param}} substitution (repeatable)
 *   --think-time N          Milliseconds pause between requests    (default: 0)
 *   --timeout N             Per-request timeout in ms             (default: 30000)
 *   --skip-static           Skip JS/CSS/image requests
 *   --output results.csv    Save raw results to CSV file
 *   --debug                 Verbose per-request logging
 *
 * Examples:
 *   node runner.js --har recording.har --iterations 10 --vusers 3 \
 *       --param host=https://myserver.sap.com \
 *       --param username=testuser --param password=Test1! \
 *       --output results.csv
 *
 *   node runner.js --har recording.har --blocks "Login" --iterations 5
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseHar } from '../shared/har-utils.js';
import { Replayer } from './replayer.js';
import { buildReport, printReport, toCsv } from './report.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    har:        null,
    iterations: 1,
    vusers:     1,
    blocks:     null,
    params:     {},
    thinkTime:  0,
    timeout:    30_000,
    output:     null,
    skipStatic: false,
    debug:      false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--har':          args.har        = argv[++i]; break;
      case '--iterations':   args.iterations = parseInt(argv[++i], 10); break;
      case '--vusers':       args.vusers     = parseInt(argv[++i], 10); break;
      case '--think-time':   args.thinkTime  = parseInt(argv[++i], 10); break;
      case '--timeout':      args.timeout    = parseInt(argv[++i], 10); break;
      case '--output':       args.output     = argv[++i]; break;
      case '--skip-static':  args.skipStatic = true; break;
      case '--debug':        args.debug      = true; break;
      case '--blocks':
        args.blocks = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--param': {
        const kv = argv[++i] ?? '';
        const eq = kv.indexOf('=');
        if (eq > 0) args.params[kv.slice(0, eq)] = kv.slice(eq + 1);
        else console.warn(`[warn] --param ignored (no "="): ${kv}`);
        break;
      }
      default:
        if (a.startsWith('-')) console.warn(`[warn] Unknown option: ${a}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Usage: node runner.js --har <file.har> [options]

Options:
  --iterations N        Iterations per virtual user  (default: 1)
  --vusers N            Concurrent virtual users      (default: 1)
  --blocks "A,B"        Blocks to replay (default: all)
  --param key=value     {{param}} substitution        (repeatable)
  --think-time N        ms pause between requests     (default: 0)
  --timeout N           Per-request timeout ms        (default: 30000)
  --skip-static         Skip JS/CSS/image requests
  --output results.csv  Save results to CSV
  --debug               Verbose logging
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.har) {
    printUsage();
    process.exit(1);
  }

  // Load and parse HAR
  let harText;
  try {
    harText = readFileSync(args.har, 'utf8');
  } catch (err) {
    console.error(`Error: cannot read file "${args.har}": ${err.message}`);
    process.exit(1);
  }

  let harLog;
  try {
    harLog = parseHar(harText);
  } catch (err) {
    console.error(`Error: invalid HAR file — ${err.message}`);
    process.exit(1);
  }

  // Build replayer
  const replayer = new Replayer(harLog, {
    blocks:           args.blocks,
    thinkTimeMs:      args.thinkTime,
    skipStaticAssets: args.skipStatic,
    debug:            args.debug,
    timeout:          args.timeout,
  });

  const rules = replayer.getRules();

  console.log('\n' + '─'.repeat(60));
  console.log(`  SAP Fiori HTTP Replay`);
  console.log('─'.repeat(60));
  console.log(`  HAR file    : ${args.har}`);
  console.log(`  Requests    : ${replayer.getEntryCount()} per iteration`);
  console.log(`  Virtual users: ${args.vusers}`);
  console.log(`  Iterations  : ${args.iterations} per VU`);
  console.log(`  Total runs  : ${args.vusers * args.iterations}`);
  if (args.blocks) console.log(`  Blocks      : ${args.blocks.join(', ')}`);
  if (Object.keys(args.params).length) {
    const masked = Object.entries(args.params)
      .map(([k, v]) => `${k}=${k.toLowerCase().includes('pass') ? '***' : v}`)
      .join(', ');
    console.log(`  Params      : ${masked}`);
  }
  console.log(`  Correlations: ${rules.length} rules`);
  if (args.debug && rules.length) {
    for (const r of rules) console.log(`    • [${r.type}] ${r.name}`);
  }
  console.log('─'.repeat(60) + '\n');

  // Progress tracking
  let completed = 0;
  const total   = args.vusers * args.iterations;

  function onResult(_results, _iteration, _vuId) {
    completed++;
    const pct = Math.round(completed / total * 100);
    process.stdout.write(`\r  Progress: ${completed}/${total}  (${pct}%)`);
  }

  const t0 = Date.now();
  let results;

  if (args.vusers > 1) {
    results = await replayer.runConcurrent({
      vusers:     args.vusers,
      iterations: args.iterations,
      params:     args.params,
      onResult,
    });
  } else {
    results = await replayer.run({
      iterations: args.iterations,
      params:     args.params,
      onResult,
    });
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nFinished in ${elapsedS}s — ${results.length} requests total\n`);

  // Print report
  const report = buildReport(results);
  printReport(report);

  // Optionally save CSV
  if (args.output) {
    try {
      writeFileSync(args.output, toCsv(results));
      console.log(`\nResults saved → ${args.output}`);
    } catch (err) {
      console.error(`\nWarning: could not write output file: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
