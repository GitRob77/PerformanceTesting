// Background script for HAR Traffic Capturer
// Captures network requests and stores them for HAR export

let isCapturing = false;
let capturedEntries = [];
let startTime = null;

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
  }
  return true;
});

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
        time: null
      };
      capturedEntries.push(entry);
      break;
      
    case 'Network.responseReceived':
      // Update entry with response info
      const existingEntry = capturedEntries.find(e => e.requestId === params.requestId);
      if (existingEntry) {
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
      entries: capturedEntries.map(entry => ({
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
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'exportHAR') {
    const har = generateHAR();
    const harJson = JSON.stringify(har, null, 2);
    const blob = new Blob([harJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: url,
      filename: `har-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.har`
    });
    
    sendResponse({ status: 'exported' });
  }
  return true;
});
