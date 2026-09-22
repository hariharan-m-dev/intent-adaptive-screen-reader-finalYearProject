/**
 * content.js
 * Orchestrator injected into every page. Runs the pipeline:
 *   featureExtractor -> classifier -> reorderer -> speech
 * and responds to messages from the popup UI.
 *
 * Query-handoff: before running the pipeline this script asks the service
 * worker for any search query stored for this tab (captured when the tab
 * was on a SERP). That query is merged into the feature object so the
 * reorderer's keyword-overlap layer can use it even when document.referrer
 * has been stripped by the browser's Referrer-Policy.
 *
 * Jump-and-read: blocks produced by the reorderer may carry an `anchorEl`
 * DOM reference (query-match blocks only). The IASR_JUMP_AND_READ handler
 * uses that reference to scroll the page to the highest-scoring section and
 * begin speech from there. anchorEl is never sent over the message boundary.
 */

let IASR_lastResult = null;

/**
 * Ask the background service worker for the search query it stored when this
 * tab was on a SERP. Returns a promise that resolves to a string (empty
 * string if nothing is stored or the message fails).
 */
function getStoredQuery() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'IASR_GET_QUERY' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve('');
        } else {
          resolve(response.queryText || '');
        }
      });
    } catch (e) {
      resolve('');
    }
  });
}

/**
 * Merge a stored query into the features.query slot if the feature extractor
 * did not already find one from the current URL or document.referrer.
 * Preserves the existing fallback priority:
 *   1. current page URL query param  (featureExtractor, unchanged)
 *   2. document.referrer query param (featureExtractor, unchanged)
 *   3. tab-specific session storage  (this function, new)
 */
const IASR_STOPWORDS = new Set([
  'the', 'is', 'a', 'an', 'of', 'in', 'to', 'for', 'and', 'or',
  'what', 'how', 'why', 'does', 'do', 'are', 'on', 'with', 'be', 'i', 'my'
]);

function mergeStoredQuery(features, storedQueryText) {
  if (features.query.queryText || !storedQueryText) return features;
  const keywords = storedQueryText
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1 && !IASR_STOPWORDS.has(w));
  // Return a shallow copy with the query slot replaced — don't mutate.
  return Object.assign({}, features, {
    query: { queryText: storedQueryText, keywords }
  });
}

/**
 * Strip anchorEl from all blocks before they leave the content-script
 * context. DOM nodes cannot cross the message boundary (they are silently
 * dropped by the structured-clone algorithm, and in strict mode can throw).
 */
function serializableBlocks(blocks) {
  return blocks.map(b => {
    if (!b.anchorEl) return b;
    const { anchorEl, ...rest } = b; // eslint-disable-line no-unused-vars
    return rest;
  });
}

/**
 * Scroll the given DOM element into view and apply a brief yellow-outline
 * highlight so the user can see where reading will start.
 * The highlight is removed after 2 s so it doesn't linger.
 */
function scrollAndHighlight(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = el.style.outline;
  el.style.outline = '3px solid #f5a623';
  setTimeout(() => { el.style.outline = prev; }, 2000);
}

async function runPipeline() {
  // 1. Extract DOM/URL features synchronously (unchanged).
  let features = IASR_FeatureExtractor.extract();

  // 2. If no query was found by the extractor, ask the service worker.
  if (!features.query.queryText) {
    const storedQuery = await getStoredQuery();
    features = mergeStoredQuery(features, storedQuery);
  }

  const classification = IASR_Classifier.classify(features);
  // blocks may contain anchorEl references — kept in memory, stripped when
  // serialized over the message boundary.
  const blocks = IASR_Reorderer.buildOrder(classification.intent, features);

  IASR_lastResult = {
    url: window.location.href,
    intent: classification.intent,
    confidence: classification.confidence,
    scores: classification.scores,
    searchQuery: features.query.queryText || null,
    blocks  // live references preserved here; stripped on send
  };
  return IASR_lastResult;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IASR_ANALYZE') {
    runPipeline().then(result => sendResponse({
      ...result,
      blocks: serializableBlocks(result.blocks)
    }));
  }

  if (message.type === 'IASR_SPEAK') {
    const isFirstRun = !IASR_lastResult;
    const pipelinePromise = isFirstRun ? runPipeline() : Promise.resolve(IASR_lastResult);
    pipelinePromise.then(result => {
      IASR_Speech.speakOrderedBlocks(result.blocks, (progress) => {
        try {
          chrome.runtime.sendMessage({ type: 'IASR_PROGRESS', progress }).catch(() => {});
        } catch (e) { /* popup closed or context invalidated */ }
      });
      sendResponse(isFirstRun
        ? { started: true, intent: result.intent, confidence: result.confidence, searchQuery: result.searchQuery, blocks: serializableBlocks(result.blocks) }
        : { started: true, intent: result.intent }
      );
    });
  }

  if (message.type === 'IASR_JUMP_AND_READ') {
    // Ensure the pipeline has run at least once.
    const pipelinePromise = IASR_lastResult ? Promise.resolve(IASR_lastResult) : runPipeline();
    pipelinePromise.then(result => {
      // Find the first block that has a live anchorEl (top query-match hit).
      const jumpIndex = result.blocks.findIndex(b => b.anchorEl);
      const startIndex = jumpIndex >= 0 ? jumpIndex : 0;

      if (jumpIndex >= 0) {
        scrollAndHighlight(result.blocks[jumpIndex].anchorEl);
      }

      // Start speech from that block, not from index 0.
      IASR_Speech.speakOrderedBlocks(result.blocks.slice(startIndex), (progress) => {
        // Offset progress index so the popup highlights the right block.
        const offsetProgress = progress.done
          ? { done: true, index: -1 }
          : { done: false, index: progress.index + startIndex, block: progress.block };
        try {
          chrome.runtime.sendMessage({ type: 'IASR_PROGRESS', progress: offsetProgress }).catch(() => {});
        } catch (e) { /* popup closed */ }
      });

      sendResponse({
        jumped: true,
        startIndex,
        hasMatch: jumpIndex >= 0,
        blocks: serializableBlocks(result.blocks)
      });
    });
  }

  if (message.type === 'IASR_STOP') {
    IASR_Speech.stop();
    sendResponse({ stopped: true });
  }

  return true; // keep the message channel open for async sendResponse
});
