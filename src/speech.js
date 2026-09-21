/**
 * speech.js
 * Thin wrapper around the Web Speech API (SpeechSynthesis) that speaks
 * an ordered list of {label, text} blocks in sequence, and reports
 * progress back to the caller (used to highlight/update the popup UI).
 */

const IASR_Speech = (() => {
  let queue = [];
  let currentIndex = -1;
  let onProgress = null;
  let cancelled = false;

  function speakBlock(index) {
    if (cancelled || index >= queue.length) {
      if (onProgress) onProgress({ done: true, index: -1 });
      return;
    }
    currentIndex = index;
    const block = queue[index];
    const utterance = new SpeechSynthesisUtterance(`${block.label}. ${block.text}`);
    utterance.rate = 1.0;
    utterance.onend = () => speakBlock(index + 1);
    utterance.onerror = () => speakBlock(index + 1);
    if (onProgress) onProgress({ done: false, index, block });
    window.speechSynthesis.speak(utterance);
  }

  function speakOrderedBlocks(blocks, progressCallback) {
    stop();
    cancelled = false;
    queue = blocks;
    onProgress = progressCallback || null;
    if (!blocks.length) {
      if (onProgress) onProgress({ done: true, index: -1 });
      return;
    }
    speakBlock(0);
  }

  function stop() {
    cancelled = true;
    window.speechSynthesis.cancel();
    currentIndex = -1;
  }

  return { speakOrderedBlocks, stop };
})();
