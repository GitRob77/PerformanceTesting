// Popup script for HAR Traffic Capturer
// Handles UI interactions and communicates with background script

document.addEventListener('DOMContentLoaded', async () => {
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnExport = document.getElementById('btnExport');
  const btnClear = document.getElementById('btnClear');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const entryCount = document.getElementById('entryCount');

  // Get initial status
  updateStatus();

  // Start capture button
  btnStart.addEventListener('click', async () => {
    try {
      // Find the best tab to capture: prefer the active non-extension tab,
      // otherwise pick the most recently used non-chrome tab in the window
      let tabId = null;
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeReal = activeTabs.find(t => t.url && !t.url.startsWith('chrome'));
      if (activeReal) {
        tabId = activeReal.id;
      } else {
        // Active tab is a chrome/extension page — find the last-accessed real tab
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const realTabs = allTabs.filter(t => t.url && !t.url.startsWith('chrome'));
        if (realTabs.length > 0) {
          // Sort by lastAccessed descending (most recent first)
          realTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          tabId = realTabs[0].id;
        } else {
          tabId = activeTabs[0]?.id;
        }
      }
      const result = await chrome.runtime.sendMessage({ action: 'startCapture', tabId });
      if (result && result.status === 'error') {
        alert('Could not start capture:\n' + result.message);
      } else {
        updateUI(true);
      }
    } catch (error) {
      console.error('Failed to start capture:', error);
      alert('Failed to start capture. Make sure you have the required permissions.');
    }
  });

  // Stop capture button
  btnStop.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'stopCapture' });
      updateUI(false);
      updateEntryCount(response.entries ? response.entries.length : 0);
    } catch (error) {
      console.error('Failed to stop capture:', error);
    }
  });

  // View Requests button — opens the viewer in a new tab
  const btnViewer = document.getElementById('btnViewer');
  btnViewer.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  });

  // Export HAR button
  // The service worker cannot use URL.createObjectURL, so we receive the HAR
  // data here in the popup and trigger the download from this context instead.
  btnExport.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'exportHAR' });
      if (response.status === 'ok' && response.har) {
        const json = JSON.stringify(response.har, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `har-${Date.now()}.har`;
        a.click();
        URL.revokeObjectURL(url);
        statusText.textContent = 'HAR file downloaded!';
        setTimeout(() => updateStatus(), 2000);
      }
    } catch (error) {
      console.error('Failed to export HAR:', error);
      alert('Failed to export HAR file.');
    }
  });

  // Clear data button
  btnClear.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all captured data?')) {
      try {
        await chrome.runtime.sendMessage({ action: 'clearCapture' });
        updateEntryCount(0);
        statusText.textContent = 'Data cleared';
        setTimeout(() => updateStatus(), 2000);
      } catch (error) {
        console.error('Failed to clear data:', error);
      }
    }
  });

  // Update UI based on capture state
  function updateUI(isCapturing) {
    if (isCapturing) {
      btnStart.classList.add('hidden');
      btnStop.classList.remove('hidden');
      if (statusDot) { statusDot.classList.add('active'); }
      statusText.textContent = 'Capturing traffic...';
    } else {
      btnStart.classList.remove('hidden');
      btnStop.classList.add('hidden');
      if (statusDot) { statusDot.classList.remove('active'); }
      statusText.textContent = 'Ready to capture';
    }
  }

  // Update entry count display
  function updateEntryCount(count) {
    entryCount.textContent = `${count} request${count !== 1 ? 's' : ''} captured`;
  }

  // Get and display current status
  async function updateStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
      updateUI(response.isCapturing);
      updateEntryCount(response.entryCount);
    } catch (error) {
      console.error('Failed to get status:', error);
      statusText.textContent = 'Extension not ready';
    }
  }
});
