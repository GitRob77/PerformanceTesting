# SAP Fiori HTTP Performance Testing Suite

A three-layer tool for recording, replaying, and load-testing SAP Fiori HTTP traffic.

## Architecture

| Layer | Location | Purpose |
|---|---|---|
| Chrome Extension | `chrome-extension/` | Record traffic + interactive replay with correlation |
| Headless Replay Service | `replay-service/` | Scalable load test execution (N virtual users) |
| Shared Correlation Engine | `shared/` | CSRF tokens, session IDs, OData keys — used by both layers |

## Quick Start (Recording)

1. Load `chrome-extension/` as an unpacked extension in Chrome or Edge
2. Click the extension icon, name your first functional block (e.g. `Login`)
3. Click **Start Recording**, perform your SAP Fiori actions, click **Stop**
4. Repeat for each block (`Create Purchase Order`, `Logout`, …)
5. Click **Export** to save the annotated HAR + correlation rules

## Quick Start (Load Test)

```bash
cd replay-service
npm install
node run-test.js --flow exported-flow.json --users 50 --ramp-up 30s --duration 5m --params users.csv
```

## Project Structure

```
SAP-Fiori-TestSuite/
├── chrome-extension/        # Manifest V3 Chrome/Edge extension
│   ├── manifest.json
│   ├── background.js        # Service worker: recording via chrome.debugger
│   ├── popup/               # Popup UI (record, filter, replay)
│   └── replay/              # Interactive replay logic
├── replay-service/          # Node.js headless replay engine
│   ├── run-test.js          # CLI entry point
│   ├── executor.js          # Virtual user orchestration
│   ├── report.js            # CSV report generator
│   └── playwright-executor.js  # Playwright PoC
├── shared/                  # Shared modules (extension + service)
│   ├── correlation.js       # Correlation engine
│   ├── har-utils.js         # HAR read/write helpers
│   └── correlation.test.js  # Unit tests
└── docs/
    ├── architecture.md
    ├── usage-guide.md
    └── sap-correlation-reference.md
```

## Implementation Status

- [ ] Step 1 — `shared/correlation.js` (correlation engine + unit tests)
- [ ] Step 2 — `chrome-extension/` recording with functional blocks + filtering
- [ ] Step 3 — `chrome-extension/` interactive replay with correlation
- [ ] Step 4 — Export format + export from extension
- [ ] Step 5 — `replay-service/` headless execution engine
- [ ] Step 6 — `replay-service/report.js` CSV reporting
- [ ] Step 7 — `replay-service/playwright-executor.js` Playwright PoC
- [ ] Step 8 — `docs/` architecture, usage guide, SAP correlation reference
