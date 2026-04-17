# HAR Replay API Server

A standalone HTTP server for replaying HAR (HTTP Archive) files recorded from the UiPath Web Recorder Chrome extension. Works on any OS with Node.js installed.

## Features

- 📡 **REST API** for uploading and replaying HAR recordings
- 🔗 **Push from plugin** - Upload recordings directly from Chrome extension
- 🎯 **SAP CSRF token correlation** - Automatic token extraction and injection
- 📊 **Web UI** - Simple interface to manage and replay recordings
- ⚙️ **CLI options** - Customize replay behavior (delay, base URL, filtering)
- 💾 **Persistent storage** - Recordings stored on disk in `.har-recordings/`
- 🔄 **Cross-platform** - Windows, macOS, Linux

## Installation

```bash
# No npm dependencies needed! Just Node.js 14+
node replay-api-server.js
```

Or with port customization:

```bash
node replay-api-server.js --port 8080
```

## Usage

### From Chrome Extension

1. Record traffic in the extension
2. Click **Export** → **Push to Replay API**
3. Enter API endpoint (e.g., `http://localhost:3000`)
4. Recording is uploaded and you get a recording ID

### Web UI

Open `http://localhost:3000/ui` to:

- Upload HAR files (drag & drop supported)
- View all stored recordings
- Replay recordings with custom options
- Delete recordings

### REST API

**Upload a HAR file:**
```bash
curl -X POST http://localhost:3000/api/recordings \
  -H "Content-Type: application/json" \
  -d @recording.har
```

Response:
```json
{
  "id": "abc123def456",
  "name": "My Recording",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

**List all recordings:**
```bash
curl http://localhost:3000/api/recordings
```

**Replay a recording:**
```bash
curl -X POST http://localhost:3000/api/recordings/abc123def456/replay \
  -H "Content-Type: application/json" \
  -d '{"delay": 500, "baseUrl": "https://app.example.com", "filter": "/api"}'
```

Options:
- `delay` (ms) - Wait between requests
- `baseUrl` - Override target URL
- `filter` - Regex pattern to filter requests
- `maxRequests` - Limit number of requests

Response:
```json
{
  "ok": 15,
  "failed": 2,
  "total": 17,
  "results": [
    {
      "ok": true,
      "url": "https://api.example.com/users",
      "method": "GET",
      "status": 200,
      "time": 125,
      "extractedVars": [
        {"rule": "SAP X-CSRF-Token", "value": "abc123..."}
      ],
      "correlationsUsed": ["SAP X-CSRF-Token"]
    }
  ],
  "vars": {
    "_csrf": "abc123xyz789",
    "_xsrf": "def456"
  }
}
```

**Get recording details:**
```bash
curl http://localhost:3000/api/recordings/abc123def456
```

**Delete a recording:**
```bash
curl -X DELETE http://localhost:3000/api/recordings/abc123def456
```

## Correlation Engine

Automatically extracts and injects tokens:

- **SAP X-CSRF-Token** - Standard SAP Fiori CSRF protection
- **X-XSRF-Token** - Common XSRF token header
- **RequestVerificationToken** - .NET request verification

Tokens are extracted from responses and automatically injected into subsequent requests.

## Storage

Recordings are stored in the `.har-recordings/` directory:

```
.har-recordings/
├── abc123def456.har
├── def456ghi789.har
└── ...
```

Each file contains a complete HAR object that can be:
- Imported into Postman
- Used with k6 or JMeter
- Shared with teammates
- Replayed with the Node.js script

## Examples

### Basic replay with 1-second delay between requests:
```bash
curl -X POST http://localhost:3000/api/recordings/abc123/replay \
  -H "Content-Type: application/json" \
  -d '{"delay": 1000}'
```

### Replay only API requests against a different server:
```bash
curl -X POST http://localhost:3000/api/recordings/abc123/replay \
  -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://staging.example.com",
    "filter": "/api",
    "delay": 500
  }'
```

### Integrate with CI/CD (using bash):
```bash
#!/bin/bash
REC_ID="abc123def456"
API="http://localhost:3000/api"

# Replay
RESULT=$(curl -s -X POST $API/recordings/$REC_ID/replay \
  -H "Content-Type: application/json" \
  -d '{"delay": 200}')

PASSED=$(echo $RESULT | grep -o '"ok":[0-9]*' | grep -o '[0-9]*')
FAILED=$(echo $RESULT | grep -o '"failed":[0-9]*' | grep -o '[0-9]*')

echo "Replay complete: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
```

## Docker (Optional)

To create a Docker image:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY replay-api-server.js .
EXPOSE 3000
CMD ["node", "replay-api-server.js"]
```

Build and run:
```bash
docker build -t har-replay .
docker run -p 3000:3000 -v $(pwd)/.har-recordings:/app/.har-recordings har-replay
```

## Troubleshooting

### Port already in use
```bash
# Use a different port
node replay-api-server.js --port 8080
```

### CORS errors when pushing from Chrome
The server allows cross-origin requests from any origin. If you still get CORS errors:
- Ensure the API endpoint URL is correct (no trailing slash)
- Check that the server is running and accessible
- Try adding `--port 3000` explicitly

### Recordings not persisting
Recordings are saved to `.har-recordings/` directory. Ensure:
- The directory exists and has write permissions
- The server doesn't crash during upload
- Use `--port` argument to persist configuration

## Advanced

### Programmatic use

```javascript
const http = require('http');

async function uploadAndReplay(har, endpoint) {
  // Upload
  const uploadRes = await fetch(`${endpoint}/api/recordings`, {
    method: 'POST',
    body: JSON.stringify(har),
    headers: { 'Content-Type': 'application/json' }
  });
  const { id } = await uploadRes.json();

  // Replay
  const replayRes = await fetch(`${endpoint}/api/recordings/${id}/replay`, {
    method: 'POST',
    body: JSON.stringify({ delay: 500 }),
    headers: { 'Content-Type': 'application/json' }
  });
  const results = await replayRes.json();
  
  console.log(`${results.ok} passed, ${results.failed} failed`);
  return results;
}
```

## License

Part of UiPath Web Recorder project.
