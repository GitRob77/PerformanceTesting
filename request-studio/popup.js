// UiPath Request Studio — Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const btnStart   = document.getElementById('btnStart');
  const btnStop    = document.getElementById('btnStop');
  const btnViewer  = document.getElementById('btnViewer');
  const btnClear   = document.getElementById('btnClear');
  const statusDot  = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const entryCount = document.getElementById('entryCount');

  updateStatus();

  // ── Start capture ──
  btnStart.addEventListener('click', async () => {
    try {
      let tabId = null;
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeReal = activeTabs.find(t => t.url && !t.url.startsWith('chrome'));
      if (activeReal) {
        tabId = activeReal.id;
      } else {
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const realTabs = allTabs.filter(t => t.url && !t.url.startsWith('chrome'));
        if (realTabs.length > 0) {
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
    } catch (err) {
      alert('Failed to start capture. Make sure you have the required permissions.');
    }
  });

  // ── Stop capture ──
  btnStop.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'stopCapture' });
      updateUI(false);
      updateStatus();
    } catch (err) {
      console.error('Failed to stop capture:', err);
    }
  });

  // ── Open viewer ──
  btnViewer.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  });

  // ── Clear data ──
  btnClear.addEventListener('click', async () => {
    if (confirm('Clear all captured requests?')) {
      try {
        await chrome.runtime.sendMessage({ action: 'clearCapture' });
        updateCount(0);
        statusText.textContent = 'Cleared';
        setTimeout(updateStatus, 1800);
      } catch (err) {
        console.error('Failed to clear:', err);
      }
    }
  });

  function updateUI(capturing) {
    if (capturing) {
      btnStart.classList.add('hidden');
      btnStop.classList.remove('hidden');
      statusDot.classList.add('active');
      statusText.textContent = 'Capturing traffic…';
    } else {
      btnStart.classList.remove('hidden');
      btnStop.classList.add('hidden');
      statusDot.classList.remove('active');
      statusText.textContent = 'Ready to capture';
    }
  }

  function updateCount(count) {
    entryCount.textContent = `${count} request${count !== 1 ? 's' : ''} captured`;
  }

  async function updateStatus() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getStatus' });
      updateUI(res.isCapturing);
      updateCount(res.entryCount);
    } catch (err) {
      statusText.textContent = 'Extension not ready';
    }
  }
});
