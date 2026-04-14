// Popup script for HAR Traffic Capturer
// Handles UI interactions and communicates with background script

document.addEventListener('DOMContentLoaded', async () => {
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnExport = document.getElementById('btnExport');
  const btnClear = document.getElementById('btnClear');
  const statusDiv = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const entryCount = document.getElementById('entryCount');

  // Get initial status
  updateStatus();

  // Start capture button
  btnStart.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'startCapture' });
      updateUI(true);
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

  // Export HAR button
  btnExport.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'exportHAR' });
      statusText.textContent = 'HAR file downloaded!';
      setTimeout(() => updateStatus(), 2000);
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
      statusDiv.classList.remove('idle');
      statusDiv.classList.add('capturing');
      statusText.textContent = '🔴 Capturing traffic...';
    } else {
      btnStart.classList.remove('hidden');
      btnStop.classList.add('hidden');
      statusDiv.classList.remove('capturing');
      statusDiv.classList.add('idle');
      statusText.textContent = 'Capture stopped';
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
