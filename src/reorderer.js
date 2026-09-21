/**
 * reorderer.js
 * THIS IS THE CORE NOVELTY of the project: given a classified intent,
 * builds an ordered list of "speech blocks" that surfaces the
 * task-relevant content first, instead of reading the page linearly
 * top-to-bottom or using a generic importance score.
 *
 * Each intent has its own rule-based priority config — this is
 * intentionally NOT ML. The classifier decides "what kind of page is
 * this", and this module decides "given that, what should be said
 * first" via hand-authored, per-intent selector priority lists.
 */

const IASR_Reorderer = (() => {

  function textOf(el) {
    return el ? el.innerText.trim().replace(/\s+/g, ' ') : '';
  }

  // All lookups below are scoped to the main content area (getMainContentRoot),
  // not the whole document — otherwise selectors like 'pre, code' or generic
  // class-name matches can grab nav/header/footer/theme chrome (icons,
  // breadcrumbs, unrelated widgets) instead of actual article content.
  function getRoot() {
    return (typeof IASR_FeatureExtractor !== 'undefined')
      ? IASR_FeatureExtractor.getMainContentRoot()
      : document.body;
  }

  function firstMatch(selectors, root) {
    const scope = root || getRoot();
    for (const sel of selectors) {
      const el = scope.querySelector(sel);
      const text = textOf(el);
      if (text) return text;
    }
    return null;
  }

  function firstPriceOnPage(root) {
    const scope = root || getRoot();
    const bodyText = scope.innerText || '';
    const match = bodyText.match(/[$₹€£]\s?\d[\d,]*(\.\d{2})?/);
    return match ? match[0] : null;
  }

  function buildShoppingOrder() {
    const blocks = [];
    const title = firstMatch(['h1', '[class*="product-title" i]', '[id*="title" i]']);
    if (title) blocks.push({ label: 'Product', text: title });

    const price = firstMatch(['[class*="price" i]', '[itemprop="price"]']) || firstPriceOnPage();
    if (price) blocks.push({ label: 'Price', text: price });

    const buyButton = firstMatch(['button[class*="buy" i]', 'button[class*="cart" i]', 'input[value*="Buy" i]', 'a[class*="buy" i]']);
    blocks.push({ label: 'Action', text: buyButton ? `Buy button available: ${buyButton}` : 'Add to cart / buy option on page' });

    const rating = firstMatch(['[class*="rating" i]', '[class*="stars" i]', '[itemprop="ratingValue"]']);
    if (rating) blocks.push({ label: 'Rating', text: rating });

    const availability = firstMatch(['[class*="stock" i]', '[itemprop="availability"]']);
    if (availability) blocks.push({ label: 'Availability', text: availability });

    return blocks;
  }

  function buildJobOrder() {
    const blocks = [];
    const title = firstMatch(['h1', '[class*="job-title" i]']);
    if (title) blocks.push({ label: 'Job title', text: title });

    const salary = firstMatch(['[class*="salary" i]', '[class*="compensation" i]']);
    if (salary) blocks.push({ label: 'Salary', text: salary });

    const deadline = firstMatch(['[class*="deadline" i]', '[class*="closing-date" i]']);
    if (deadline) blocks.push({ label: 'Deadline', text: deadline });

    const applyButton = firstMatch(['button[class*="apply" i]', 'a[class*="apply" i]']);
    blocks.push({ label: 'Action', text: applyButton ? `Apply option available: ${applyButton}` : 'Apply option on page' });

    const location = firstMatch(['[class*="location" i]']);
    if (location) blocks.push({ label: 'Location', text: location });

    return blocks;
  }

  function buildNewsOrder() {
    const blocks = [];
    const headline = firstMatch(['h1']);
    if (headline) blocks.push({ label: 'Headline', text: headline });

    const byline = firstMatch(['[class*="byline" i]', '[class*="author" i]', '[rel="author"]']);
    if (byline) blocks.push({ label: 'Author', text: byline });

    const dateline = firstMatch(['time', '[class*="date" i]', '[class*="published" i]']);
    if (dateline) blocks.push({ label: 'Published', text: dateline });

    const firstPara = firstMatch(['article p', 'main p', 'p']);
    if (firstPara) blocks.push({ label: 'Summary', text: firstPara });

    return blocks;
  }

  function buildFormOrder() {
    const blocks = [];
    const labels = Array.from(document.querySelectorAll('label'))
      .map(l => textOf(l))
      .filter(Boolean);
    const requiredFields = Array.from(document.querySelectorAll('[required], [aria-required="true"]'))
      .map(el => el.getAttribute('name') || el.getAttribute('id') || el.type)
      .filter(Boolean);

    if (labels.length) {
      blocks.push({ label: 'Form fields', text: `This form has ${labels.length} fields: ${labels.slice(0, 8).join(', ')}` });
    }
    if (requiredFields.length) {
      blocks.push({ label: 'Required', text: `Required: ${requiredFields.slice(0, 8).join(', ')}` });
    }
    const submit = firstMatch(['button[type="submit"]', 'input[type="submit"]']);
    if (submit) blocks.push({ label: 'Submit', text: submit });

    return blocks;
  }

  function buildQaReferenceOrder() {
    const blocks = [];
    const question = firstMatch(['h1']);
    if (question) blocks.push({ label: 'Question', text: question });

    // First real paragraph of question body (skip nav/meta text)
    const questionBody = firstMatch(['.question p', '[class*="question" i] p', 'article p', 'main p']);
    if (questionBody) blocks.push({ label: 'Details', text: questionBody });

    // Common accepted/top-answer selectors (Stack Overflow-style pages);
    // falls back to "second big block of text" if the site doesn't match.
    const topAnswer = firstMatch(['.accepted-answer', '[class*="accepted" i]', '.answer', '[class*="answer" i]']);
    if (topAnswer) blocks.push({ label: 'Top answer', text: topAnswer });

    const codeBlock = firstMatch(['pre', 'code']);
    if (codeBlock) blocks.push({ label: 'Code', text: codeBlock.slice(0, 300) });

    return blocks;
  }

  function buildLinearFallback() {
    // Default / "unknown" intent behavior: linear reading, capped.
    const root = getRoot();
    const blocks = [];
    const h1 = firstMatch(['h1'], root);
    if (h1) blocks.push({ label: 'Heading', text: h1 });
    const paras = Array.from(root.querySelectorAll('p'))
      .map(p => textOf(p))
      .filter(t => t.length > 40)
      .slice(0, 3);
    paras.forEach((p, i) => blocks.push({ label: `Paragraph ${i + 1}`, text: p }));
    return blocks;
  }

  /**
   * Search-query match block (lightweight v1, no embeddings): scores each
   * candidate heading/paragraph/list-item in the main content by how many
   * of the user's search keywords it contains, and surfaces the best
   * match(es) FIRST, ahead of the normal intent-based order. This is what
   * makes reordering respect "what you were actually looking for" instead
   * of just "what kind of page this is."
   */
  function buildQueryMatchBlocks(keywords) {
    if (!keywords || !keywords.length) return [];
    const root = (typeof IASR_FeatureExtractor !== 'undefined') ? IASR_FeatureExtractor.getMainContentRoot() : document.body;
    const candidates = Array.from(root.querySelectorAll('h1, h2, h3, p, li'));

    const scored = candidates.map(el => {
      const text = textOf(el);
      if (!text || text.length < 15) return null;
      const lower = text.toLowerCase();
      let hits = 0;
      keywords.forEach(kw => {
        if (lower.includes(kw)) hits += 1;
      });
      return hits > 0 ? { text, hits } : null;
    }).filter(Boolean);

    if (!scored.length) return [];

    scored.sort((a, b) => b.hits - a.hits);
    return scored.slice(0, 2).map(s => ({
      label: 'Matches your search',
      text: s.text.length > 220 ? s.text.slice(0, 220) + '…' : s.text
    }));
  }

  // Common markup patterns for AI-generated overview/answer boxes across
  // search engines — result links found inside these are skipped, since
  // they're not organic results and the point of this intent is to read
  // the actual result list, not a generated summary.
  const AI_BOX_SELECTOR = '[class*="ai-overview" i], [class*="answer-box" i], [class*="featured-snippet" i], [class*="knowledge-panel" i], [class*="quick-answer" i], [aria-label*="AI" i], [data-testid*="ai" i]';

  function buildSearchResultsOrder(features) {
    const blocks = [];
    const query = features && features.query ? features.query.queryText : '';
    if (query) blocks.push({ label: 'Search', text: `Showing results for: ${query}` });

    const currentHost = window.location.hostname.replace(/^www\./, '');
    const anchors = Array.from(document.querySelectorAll('a[href^="http"]'));
    const seen = new Set();
    const results = [];

    for (const a of anchors) {
      if (results.length >= 5) break;
      if (a.closest(AI_BOX_SELECTOR)) continue; // skip AI-overview/answer boxes

      let hrefHost;
      try { hrefHost = new URL(a.href).hostname.replace(/^www\./, ''); } catch (e) { continue; }
      if (hrefHost === currentHost) continue; // skip links back to the search engine itself

      const title = textOf(a);
      if (!title || title.length < 15) continue; // skip icon/nav links with no real title
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      results.push({ title, hrefHost });
    }

    if (!results.length) {
      blocks.push({ label: 'Results', text: 'No organic result links were detected on this page.' });
      return blocks;
    }

    results.forEach((r, i) => {
      blocks.push({ label: `Result ${i + 1}`, text: `${r.title} — from ${r.hrefHost}` });
    });
    return blocks;
  }

  function buildOrder(intent, features) {
    // Search-results pages skip the generic query-match layer entirely —
    // the whole page IS the response to the query, so listing organic
    // results directly is more useful than keyword-matching page text
    // (which is what previously surfaced the AI-overview box instead).
    if (intent === 'search_results') {
      return buildSearchResultsOrder(features);
    }

    const queryBlocks = features && features.query ? buildQueryMatchBlocks(features.query.keywords) : [];

    let intentBlocks;
    switch (intent) {
      case 'shopping': intentBlocks = buildShoppingOrder(); break;
      case 'job_search': intentBlocks = buildJobOrder(); break;
      case 'news': intentBlocks = buildNewsOrder(); break;
      case 'form_filling': intentBlocks = buildFormOrder(); break;
      case 'qa_reference': intentBlocks = buildQaReferenceOrder(); break;
      default: intentBlocks = buildLinearFallback();
    }

    // De-dupe: don't repeat a block whose text is already covered by a
    // query-match block. Query-match text may be truncated with '…', so
    // compare on a shared prefix rather than exact equality.
    const queryPrefixes = queryBlocks.map(b => b.text.replace('…', '').slice(0, 60));
    const filteredIntentBlocks = intentBlocks.filter(b =>
      !queryPrefixes.some(prefix => b.text.slice(0, 60) === prefix)
    );

    return [...queryBlocks, ...filteredIntentBlocks];
  }

  return { buildOrder };
})();
