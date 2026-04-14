// Background script for HAR Traffic Capturer with Filtering
// Captures network requests and stores them for HAR export with filtering support

let isCapturing = false;
let capturedEntries = [];
let startTime = null;

// Filter settings
let filterSettings = {
  enabled: false,
  urlPattern: '',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  statusCodes: [],
  excludeResources: true, // Exclude images, CSS, JS by default
  captureApiOnly: false
};

// Common API indicators
const API_INDICATORS = ['/api/', '/v1/', '/v2/', '/graphql', '/rest/', '/service/', '/endpoint/'];

// Resource types to exclude when excludeResources is enabled
const RESOURCE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.css', '.js', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.mp4', '.webm', '.mp3'];

// Load filter settings from storage
chrome.storage.local.get(['filterSettings'], (result) => {
  if (result.filterSettings) {
    filterSettings = { ...filterSettings, ...result.filterSettings };
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startCapture') {
    startCapture();
    sendResponse({ status: 'started' });
  } else if (request.action === 'stopCapture') {
    stopCapture();
    sendResponse({ status: 'stopped', entries: capturedEntries });
  } else if (request.action === 'getStatus') {
    sendResponse({ isCapturing, entryCount: capturedEntries.length });
  } else if (request.action === 'clearCapture') {
    capturedEntries = [];
    sendResponse({ status: 'cleared' });
  } else if (request.action === 'updateFilters') {
    filterSettings = { ...filterSettings, ...request.filters };
    chrome.storage.local.set({ filterSettings });
    sendResponse({ status: 'filters updated', filters: filterSettings });
  } else if (request.action === 'getFilters') {
    sendResponse({ filters: filterSettings });
  } else if (request.action === 'exportHAR') {
    exportHAR();
    sendResponse({ status: 'exported' });
  }
  return true;
});

// Check if URL matches filter criteria
function shouldCaptureRequest(url, method) {
  // If filters are disabled, capture everything
  if (!filterSettings.enabled) {
    return !shouldExcludeResource(url);
  }

  // Check URL pattern
  if (filterSettings.urlPattern) {
    try {
      const regex = new RegExp(filterSettings.urlPattern, 'i');
      if (!regex.test(url)) {
        return false;
      }
    } catch (e) {
      // If invalid regex, do simple string matching
      if (!url.toLowerCase().includes(filterSettings.urlPattern.toLowerCase())) {
        return false;
      }
    }
  }

  // Check HTTP method
  if (filterSettings.methods && filterSettings.methods.length > 0) {
    if (!filterSettings.methods.includes(method)) {
      return false;
    }
  }

  // Check if API-only mode is enabled
  if (filterSettings.captureApiOnly) {
    const isApiCall = API_INDICATORS.some(indicator => 
      url.toLowerCase().includes(indicator.toLowerCase())
    );
    if (!isApiCall) {
      return false;
    }
  }

  // Exclude resource files if enabled
  if (filterSettings.excludeResources) {
    if (shouldExcludeResource(url)) {
      return false;
    }
  }

  return true;
}

// Check if URL is a resource file (images, CSS, JS, etc.)
function shouldExcludeResource(url) {
  const lowerUrl = url.toLowerCase();
  return RESOURCE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext));
}

// Check if response status matches filter
function shouldIncludeResponse(status) {
  if (!filterSettings.enabled || !filterSettings.statusCodes || filterSettings.statusCodes.length === 0) {
    return true;
  }
  return filterSettings.statusCodes.includes(status.toString());
}

// Use chrome.debugger API to capture network traffic
async function startCapture() {
  if (isCapturing) return;
  
  isCapturing = true;
  capturedEntries = [];
  startTime = Date.now();
  
  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  
  const tabId = tab.id;
  
  try {
    // Attach debugger
    await chrome.debugger.attach({ tabId }, '1.3');
    
    // Enable network domain
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    
    // Listen for network events
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== tabId) return;
      
      handleNetworkEvent(method, params);
    });
    
  } catch (error) {
    console.error('Failed to attach debugger:', error);
    isCapturing = false;
  }
}

async function stopCapture() {
  if (!isCapturing) return;
  
  isCapturing = false;
  
  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch (e) {
      // Ignore detach errors
    }
  }
}

function handleNetworkEvent(method, params) {
  switch (method) {
    case 'Network.requestWillBeSent':
      // Check if request matches filters before storing
      if (!shouldCaptureRequest(params.request.url, params.request.method)) {
        return;
      }
      
      // Store request info
      const entry = {
        requestId: params.requestId,
        startedDateTime: new Date(params.timestamp * 1000).toISOString(),
        request: {
          method: params.request.method,
          url: params.request.url,
          headers: params.request.headers,
          postData: params.request.postData
        },
        response: null,
        time: null,
        filtered: false
      };
      capturedEntries.push(entry);
      break;
      
    case 'Network.responseReceived':
      // Update entry with response info
      const existingEntry = capturedEntries.find(e => e.requestId === params.requestId);
      if (existingEntry) {
        // Check if response status matches filters
        if (!shouldIncludeResponse(params.response.status)) {
          // Mark for filtering but keep for now (will be filtered during export)
          existingEntry.filtered = true;
        }
        
        existingEntry.response = {
          status: params.response.status,
          statusText: params.response.statusText,
          headers: params.response.headers,
          mimeType: params.response.mimeType
        };
      }
      break;
      
    case 'Network.loadingFinished':
      // Calculate timing
      const finishedEntry = capturedEntries.find(e => e.requestId === params.requestId);
      if (finishedEntry && finishedEntry.startedDateTime) {
        const start = new Date(finishedEntry.startedDateTime).getTime();
        finishedEntry.time = (params.timestamp * 1000) - start;
      }
      break;
  }
}

// Generate HAR format data
function generateHAR() {
  // Filter out entries marked as filtered
  const entriesToExport = capturedEntries.filter(entry => !entry.filtered);
  
  const har = {
    log: {
      version: '1.2',
      creator: {
        name: 'HAR Traffic Capturer',
        version: '1.0'
      },
      pages: [{
        startedDateTime: new Date(startTime).toISOString(),
        id: 'page_1',
        title: 'Captured Traffic',
        pageTimings: {
          onContentLoad: -1,
          onLoad: -1
        }
      }],
      entries: entriesToExport.map(entry => ({
        startedDateTime: entry.startedDateTime,
        time: entry.time || 0,
        request: {
          method: entry.request.method,
          url: entry.request.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.request.headers || {}).map(([name, value]) => ({ name, value })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: entry.request.postData ? entry.request.postData.length : 0
        },
        response: {
          status: entry.response?.status || 0,
          statusText: entry.response?.statusText || '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(entry.response?.headers || {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            size: 0,
            mimeType: entry.response?.mimeType || 'text/plain'
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: -1,
          wait: -1,
          receive: -1,
          ssl: -1
        },
        connection: '',
        pageref: 'page_1'
      }))
    }
  };
  
  return har;
}

// Export HAR to file
function exportHAR() {
  const har = generateHAR();
  const harJson = JSON.stringify(har, null, 2);
  const blob = new Blob([harJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  // Build filename with filter info
  let filename = 'har-capture';
  if (filterSettings.enabled) {
    if (filterSettings.captureApiOnly) filename += '-api';
    if (filterSettings.urlPattern) filename += '-filtered';
  }
  filename += `-${new Date().toISOString().replace(/[:.]/g, '-')}.har`;
  
  chrome.downloads.download({
    url: url,
    filename: filename
  });
}
