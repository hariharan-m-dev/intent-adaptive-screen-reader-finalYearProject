const intentArea = document.getElementById('intentArea');
const blocksArea = document.getElementById('blocksArea');
const analyzeBtn = document.getElementById('analyzeBtn');
const jumpBtn = document.getElementById('jumpBtn');
const speakBtn = document.getElementById('speakBtn');
const stopBtn = document.getElementById('stopBtn');

let lastBlocks = [];

function renderIntent(result) {
  const badgeClass = result.intent === 'unknown' ? 'intent-badge unknown' : 'intent-badge';
  const queryLine = result.searchQuery
    ? `<div class="confidence">detected search: "${result.searchQuery}"</div>`
    : '';
  const scoreLabel = (result.intent === 'search_results' || result.intent === 'shopping_listing') ? '' :
    `<div class="confidence">intent score: ${result.confidence.toFixed(1)}</div>`;
  intentArea.innerHTML = `
    <div class="${badgeClass}">${result.intent.replace('_', ' ')}</div>
    ${scoreLabel}
    ${queryLine}
  `;
}

function renderBlocks(blocks, activeIndex = -1) {
  lastBlocks = blocks;
  if (!blocks.length) {
    blocksArea.innerHTML = '<div class="empty">No content extracted yet. Click "Analyze this page".</div>';
    jumpBtn.style.display = 'none';
    return;
  }
  // Show the jump button only when at least one query-match block exists.
  const hasMatch = blocks.some(b => b.label === 'Matches your search');
  jumpBtn.style.display = hasMatch ? 'block' : 'none';

  blocksArea.innerHTML = blocks.map((b, i) => `
    <div class="block ${i === activeIndex ? 'active' : ''}">
      <span class="label">${b.label}</span>
      <span class="text">${b.text}</span>
    </div>
  `).join('');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

analyzeBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'IASR_ANALYZE' }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      renderIntent(result);
      renderBlocks(result.blocks);
    });
  } catch (e) { /* restricted page or content script not ready */ }
});

jumpBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'IASR_JUMP_AND_READ' }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      // Update block list to show which block is now active (startIndex).
      renderBlocks(result.blocks, result.startIndex);
    });
  } catch (e) { /* restricted page or content script not ready */ }
});

speakBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'IASR_SPEAK' }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      // If this was the first run (speak before analyze), populate the UI now.
      if (result.blocks && result.blocks.length) {
        renderIntent(result);
        renderBlocks(result.blocks);
      }
    });
  } catch (e) { /* restricted page or content script not ready */ }
});

stopBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'IASR_STOP' }, () => {});
  } catch (e) { /* restricted page or content script not ready */ }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'IASR_PROGRESS') {
    const { done, index } = message.progress;
    renderBlocks(lastBlocks, done ? -1 : index);
  }
});

// Auto-analyze on popup open
(async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'IASR_ANALYZE' }, (result) => {
      if (chrome.runtime.lastError || !result) {
        blocksArea.innerHTML = '<div class="empty">Reload the page after installing the extension, then try again.</div>';
        return;
      }
      renderIntent(result);
      renderBlocks(result.blocks);
    });
  } catch (e) {
    blocksArea.innerHTML = '<div class="empty">Reload the page after installing the extension, then try again.</div>';
  }
})();
