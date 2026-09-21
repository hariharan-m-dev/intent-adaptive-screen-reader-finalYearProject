/**
 * content.js
 * Orchestrator injected into every page. Runs the pipeline:
 *   featureExtractor -> classifier -> reorderer -> speech
 * and responds to messages from the popup UI.
 */

let IASR_lastResult = null;

function runPipeline() {
  const features = IASR_FeatureExtractor.extract();
  const classification = IASR_Classifier.classify(features);
  const blocks = IASR_Reorderer.buildOrder(classification.intent, features);

  IASR_lastResult = {
    url: window.location.href,
    intent: classification.intent,
    confidence: classification.confidence,
    scores: classification.scores,
    searchQuery: features.query.queryText || null,
    blocks
  };
  return IASR_lastResult;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IASR_ANALYZE') {
    const result = runPipeline();
    sendResponse(result);
  }

  if (message.type === 'IASR_SPEAK') {
    const result = IASR_lastResult || runPipeline();
    IASR_Speech.speakOrderedBlocks(result.blocks, (progress) => {
      chrome.runtime.sendMessage({ type: 'IASR_PROGRESS', progress }).catch(() => {});
    });
    sendResponse({ started: true, intent: result.intent });
  }

  if (message.type === 'IASR_STOP') {
    IASR_Speech.stop();
    sendResponse({ stopped: true });
  }

  return true; // keep the message channel open for async sendResponse
});
