# HAR Traffic Capturer - Chrome Extension

A Chrome extension that captures HTTP/HTTPS network traffic and exports it in HAR (HTTP Archive) format for analysis.

## Features

- 🔴 **Live Capture**: Capture all network requests from the current tab
- 💾 **HAR Export**: Export captured traffic in standard HAR format
- 🗑 **Data Management**: Clear captured data when needed
- 📊 **Request Count**: Real-time count of captured requests

## Installation

### Developer Mode (Unpacked Extension)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `chrome-har-capturer` folder from this repository
5. The extension icon will appear in your Chrome toolbar

## Usage

1. **Start Capture**: Click the extension icon, then click "▶ Start Capture"
2. **Browse**: Navigate to websites - all HTTP traffic will be captured
3. **Stop Capture**: Click "⏹ Stop Capture" when done
4. **Export**: Click "💾 Export HAR" to download the `.har` file
5. **Analyze**: Open the HAR file in Chrome DevTools, HAR Analyzer tools, or other analysis software

## File Structure

```
chrome-har-capturer/
├── manifest.json      # Extension configuration
├── background.js      # Background service worker (captures network traffic)
├── popup.html         # Extension popup UI
├── popup.js           # Popup interaction logic
└── icon*.png          # Extension icons (to be added)
```

## Permissions

The extension requires these permissions:
- `webRequest`: Monitor network requests
- `debugger`: Use Chrome DevTools Protocol for detailed capture
- `storage`: Store captured data
- `activeTab`: Access current tab information
- `downloads`: Export HAR files

## HAR Format

HAR (HTTP Archive) is a JSON-based file format used by HTTP tracking tools to export data. It contains:
- Request/response headers
- Timing information
- Status codes
- Content metadata

Compatible with:
- Chrome DevTools Network panel
- Fiddler
- Charles Proxy
- Online HAR analyzers

## Development

### To-Do

- [ ] Add extension icons (16x16, 48x48, 128x128 PNG)
- [ ] Improve HAR data accuracy (full request/response bodies)
- [ ] Add filtering options (by domain, content type, etc.)
- [ ] Add pause/resume functionality
- [ ] Add automatic capture on specific URLs

## License

MIT License
