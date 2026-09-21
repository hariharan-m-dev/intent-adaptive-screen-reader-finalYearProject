const intentArea = document.getElementById('intentArea');
const blocksArea = document.getElementById('blocksArea');
const analyzeBtn = document.getElementById('analyzeBtn');
const speakBtn = document.getElementById('speakBtn');
const stopBtn = document.getElementById('stopBtn');

let lastBlocks = [];

function renderIntent(result) {
  const badgeClass = result.intent === 'unknown' ? 'intent-badge unknown' : 'intent-badge';
  const queryLine = result.searchQuery
    ? `<div class="confidence">detected search: "${result.searchQuery}"</div>`
    : '';
  intentArea.innerHTML = `
    <div class="${badgeClass}">${result.intent.replace('_', ' ')}</div>
    <div class="confidence">confidence score: ${result.confidence.toFixed(1)}</div>
    ${queryLine}
  `;
}

function renderBlocks(blocks, activeIndex = -1) {
  lastBlocks = blocks;
  if (!blocks.length) {
    blocksArea.innerHTML = '<div class="empty">No content extracted yet. Click "Analyze this page".</div>';
    return;
  }
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
  chrome.tabs.sendMessage(tab.id, { type: 'IASR_ANALYZE' }, (result) => {
    if (!result) return;
    renderIntent(result);
    renderBlocks(result.blocks);
  });
});

speakBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'IASR_SPEAK' }, () => {});
});

stopBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'IASR_STOP' }, () => {});
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
  chrome.tabs.sendMessage(tab.id, { type: 'IASR_ANALYZE' }, (result) => {
    if (chrome.runtime.lastError || !result) {
      blocksArea.innerHTML = '<div class="empty">Reload the page after installing the extension, then try again.</div>';
      return;
    }
    renderIntent(result);
    renderBlocks(result.blocks);
  });
})();
