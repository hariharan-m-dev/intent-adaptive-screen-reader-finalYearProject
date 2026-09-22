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
    const match = firstMatchEl(selectors, root);
    return match ? match.text : null;
  }

  // Same as firstMatch but also returns the live element, so callers can
  // attach it as a block's anchorEl for scroll-and-highlight while reading.
  function firstMatchEl(selectors, root) {
    const scope = root || getRoot();
    for (const sel of selectors) {
      const el = scope.querySelector(sel);
      const text = textOf(el);
      if (text) return { el, text };
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
    const title = firstMatchEl(['h1', '[class*="product-title" i]', '[id*="title" i]']);
    if (title) blocks.push({ label: 'Product', text: title.text, anchorEl: title.el });

    const price = firstMatchEl(['[class*="price" i]', '[itemprop="price"]']);
    if (price) blocks.push({ label: 'Price', text: price.text, anchorEl: price.el });
    else {
      const fallbackPrice = firstPriceOnPage();
      if (fallbackPrice) blocks.push({ label: 'Price', text: fallbackPrice });
    }

    const buyButton = firstMatchEl(['button[class*="buy" i]', 'button[class*="cart" i]', 'input[value*="Buy" i]', 'a[class*="buy" i]']);
    blocks.push({ label: 'Action', text: buyButton ? `Buy button available: ${buyButton.text}` : 'Add to cart / buy option on page', anchorEl: buyButton ? buyButton.el : null });

    const rating = firstMatchEl(['[class*="rating" i]', '[class*="stars" i]', '[itemprop="ratingValue"]']);
    if (rating) blocks.push({ label: 'Rating', text: rating.text, anchorEl: rating.el });

    const availability = firstMatchEl(['[class*="stock" i]', '[itemprop="availability"]']);
    if (availability) blocks.push({ label: 'Availability', text: availability.text, anchorEl: availability.el });

    return blocks;
  }

  // Sourced from schema.org JSON-LD/Open Graph (see featureExtractor) instead
  // of guessing at DOM selectors — reliable regardless of the site's markup.
  function buildShoppingOrderFromStructured(product) {
    const blocks = [];
    if (product.name) blocks.push({ label: 'Product', text: product.name });
    if (product.price) blocks.push({ label: 'Price', text: product.price });
    blocks.push({ label: 'Action', text: product.availability ? `Availability: ${product.availability}` : 'Add to cart / buy option on page' });
    if (product.rating) blocks.push({ label: 'Rating', text: product.rating });
    return blocks;
  }

  // Builds a product-listing reading order directly from the DOM, in the
  // page's actual visual/DOM order — this matters because JSON-LD ItemList
  // data (when present) commonly reflects only ORGANIC search ranking and
  // silently excludes sponsored placements that still appear first on
  // screen, so relying on it for ORDER would skip exactly what a sighted
  // user sees at the top. JSON-LD is instead used only as a name lookup
  // (matched by URL) to clean up titles, since real product cards often
  // split the title and price into separate sibling <a> tags sharing the
  // same href, which a single-anchor text scan would miss entirely.
  function buildShoppingListingOrder(features) {
    const blocks = [];
    const query = features && features.query ? features.query.queryText : '';
    if (query) blocks.push({ label: 'Search', text: `Showing results for: ${query}` });

    const structuredListing = features && features.structured && features.structured.listing;
    const nameByPath = new Map();
    if (structuredListing && structuredListing.items) {
      structuredListing.items.forEach(item => {
        if (!item.url || !item.name) return;
        try { nameByPath.set(new URL(item.url, window.location.href).pathname, item.name); } catch (e) { /* ignore */ }
      });
    }

    const root = getRoot();
    const priceRe = /[$₹€£]\s?\d[\d,]*(\.\d{2})?/;
    const anchors = Array.from(root.querySelectorAll('a[href]'));
    const groups = new Map(); // pathname -> { titleParts, priceText, order, el }
    let order = 0;
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href) continue;
      let path;
      try { path = new URL(href, window.location.href).pathname; } catch (e) { path = href; }
      const text = textOf(a);
      if (!text) continue;
      if (!groups.has(path)) groups.set(path, { titleParts: [], priceText: '', order: order++, el: a });
      const group = groups.get(path);
      const priceMatch = text.match(priceRe);
      if (priceMatch) {
        if (!group.priceText) group.priceText = priceMatch[0];
        // Whole-card anchor (title + price together, common on ad/sponsored
        // cards) — pull a title guess from the text before the price.
        if (!group.titleParts.length) {
          const guess = text.slice(0, priceMatch.index).trim();
          if (guess.length >= 10) group.titleParts.push(guess);
        }
      } else if (text.length >= 10 && text.length <= 200) {
        group.titleParts.push(text);
      }
    }

    const results = [];
    for (const [path, group] of Array.from(groups.entries()).sort((a, b) => a[1].order - b[1].order)) {
      if (results.length >= 5) break;
      if (!group.priceText) continue; // no price anywhere under this link = not a product card
      const domTitle = group.titleParts.sort((a, b) => b.length - a.length)[0] || '';
      const title = nameByPath.get(path) || domTitle;
      if (!title) continue;
      results.push({ title: title.length > 100 ? title.slice(0, 100) + '…' : title, price: group.priceText, anchorEl: group.el });
    }

    if (!results.length) {
      blocks.push({ label: 'Results', text: 'No product listings were detected on this page.' });
      return blocks;
    }

    results.forEach((r, i) => blocks.push({ label: `Result ${i + 1}`, text: `${r.title} — ${r.price}`, anchorEl: r.anchorEl }));
    return blocks;
  }

  function buildJobOrder() {
    const blocks = [];
    const title = firstMatchEl(['h1', '[class*="job-title" i]']);
    if (title) blocks.push({ label: 'Job title', text: title.text, anchorEl: title.el });

    const salary = firstMatchEl(['[class*="salary" i]', '[class*="compensation" i]']);
    if (salary) blocks.push({ label: 'Salary', text: salary.text, anchorEl: salary.el });

    const deadline = firstMatchEl(['[class*="deadline" i]', '[class*="closing-date" i]']);
    if (deadline) blocks.push({ label: 'Deadline', text: deadline.text, anchorEl: deadline.el });

    const applyButton = firstMatchEl(['button[class*="apply" i]', 'a[class*="apply" i]']);
    blocks.push({ label: 'Action', text: applyButton ? `Apply option available: ${applyButton.text}` : 'Apply option on page', anchorEl: applyButton ? applyButton.el : null });

    const location = firstMatchEl(['[class*="location" i]']);
    if (location) blocks.push({ label: 'Location', text: location.text, anchorEl: location.el });

    return blocks;
  }

  // Sourced from schema.org JobPosting JSON-LD.
  function buildJobOrderFromStructured(job) {
    const blocks = [];
    if (job.title) blocks.push({ label: 'Job title', text: job.title });
    if (job.salary) blocks.push({ label: 'Salary', text: job.salary });
    if (job.deadline) blocks.push({ label: 'Deadline', text: job.deadline });
    blocks.push({ label: 'Action', text: 'Apply option on page' });
    return blocks;
  }

  function buildNewsOrder() {
    const blocks = [];
    const headline = firstMatchEl(['h1']);
    if (headline) blocks.push({ label: 'Headline', text: headline.text, anchorEl: headline.el });

    const byline = firstMatchEl(['[class*="byline" i]', '[class*="author" i]', '[rel="author"]']);
    if (byline) blocks.push({ label: 'Author', text: byline.text, anchorEl: byline.el });

    const dateline = firstMatchEl(['time', '[class*="date" i]', '[class*="published" i]']);
    if (dateline) blocks.push({ label: 'Published', text: dateline.text, anchorEl: dateline.el });

    const firstPara = firstMatchEl(['article p', 'main p', 'p']);
    if (firstPara) blocks.push({ label: 'Summary', text: firstPara.text, anchorEl: firstPara.el });

    return blocks;
  }

  // Sourced from schema.org NewsArticle/Article JSON-LD; body paragraph
  // still comes from the DOM since JSON-LD rarely embeds full article text.
  function buildNewsOrderFromStructured(article) {
    const blocks = [];
    if (article.headline) blocks.push({ label: 'Headline', text: article.headline });
    if (article.author) blocks.push({ label: 'Author', text: article.author });
    if (article.datePublished) blocks.push({ label: 'Published', text: article.datePublished });
    const firstPara = firstMatchEl(['article p', 'main p', 'p']);
    if (firstPara) blocks.push({ label: 'Summary', text: firstPara.text, anchorEl: firstPara.el });
    return blocks;
  }

  function buildFormOrder() {
    const blocks = [];
    const root = getRoot();
    const labelEls = Array.from(root.querySelectorAll('label')).filter(l => textOf(l));
    const labels = labelEls.map(l => textOf(l));
    const requiredFields = Array.from(root.querySelectorAll('[required], [aria-required="true"]'))
      .map(el => el.getAttribute('name') || el.getAttribute('id') || el.type)
      .filter(Boolean);

    if (labels.length) {
      blocks.push({ label: 'Form fields', text: `This form has ${labels.length} fields: ${labels.slice(0, 8).join(', ')}`, anchorEl: labelEls[0] });
    }
    if (requiredFields.length) {
      blocks.push({ label: 'Required', text: `Required: ${requiredFields.slice(0, 8).join(', ')}` });
    }
    const submit = firstMatchEl(['button[type="submit"]', 'input[type="submit"]']);
    if (submit) blocks.push({ label: 'Submit', text: submit.text, anchorEl: submit.el });

    return blocks;
  }

  function buildQaReferenceOrder() {
    const blocks = [];
    const question = firstMatchEl(['h1']);
    if (question) blocks.push({ label: 'Question', text: question.text, anchorEl: question.el });

    // First real paragraph of question body (skip nav/meta text)
    const questionBody = firstMatchEl(['.question p', '[class*="question" i] p', 'article p', 'main p']);
    if (questionBody) blocks.push({ label: 'Details', text: questionBody.text, anchorEl: questionBody.el });

    // Common accepted/top-answer selectors (Stack Overflow-style pages);
    // falls back to "second big block of text" if the site doesn't match.
    const topAnswer = firstMatchEl(['.accepted-answer', '[class*="accepted" i]', '.answer', '[class*="answer" i]']);
    if (topAnswer) blocks.push({ label: 'Top answer', text: topAnswer.text, anchorEl: topAnswer.el });

    const codeBlock = firstMatchEl(['pre', 'code']);
    if (codeBlock) blocks.push({ label: 'Code', text: codeBlock.text.slice(0, 300), anchorEl: codeBlock.el });

    return blocks;
  }

  function buildLinearFallback() {
    // Default / "unknown" intent behavior: linear reading, capped.
    const root = getRoot();
    const blocks = [];
    const h1 = firstMatchEl(['h1'], root);
    if (h1) blocks.push({ label: 'Heading', text: h1.text, anchorEl: h1.el });
    const paraEls = Array.from(root.querySelectorAll('p'))
      .filter(p => textOf(p).length > 40)
      .slice(0, 3);
    paraEls.forEach((p, i) => blocks.push({ label: `Paragraph ${i + 1}`, text: textOf(p), anchorEl: p }));
    return blocks;
  }

  /**
   * Search-query match block (lightweight v1, no embeddings): scores each
   * candidate heading/paragraph/list-item in the main content by how many
   * of the user's search keywords it contains, and surfaces the best
   * match(es) FIRST, ahead of the normal intent-based order. This is what
   * makes reordering respect "what you were actually looking for" instead
   * of just "what kind of page this is."
   *
   * Each returned block carries an `anchorEl` property — the live DOM node
   * that scored highest. This lets content.js scroll the page to that
   * element and begin reading from there. anchorEl is a DOM reference and
   * must be stripped before sending any block over a message boundary.
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
      return hits > 0 ? { el, text, hits } : null;
    }).filter(Boolean);

    if (!scored.length) return [];

    scored.sort((a, b) => b.hits - a.hits);
    return scored.slice(0, 2).map((s, i) => ({
      label: 'Matches your search',
      text: s.text.length > 220 ? s.text.slice(0, 220) + '…' : s.text,
      // anchorEl is only meaningful in the content-script context.
      // Strip it before serializing over chrome.runtime.sendMessage.
      anchorEl: i === 0 ? s.el : null
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
      results.push({ title, hrefHost, anchorEl: a });
    }

    if (!results.length) {
      blocks.push({ label: 'Results', text: 'No organic result links were detected on this page.' });
      return blocks;
    }

    results.forEach((r, i) => {
      blocks.push({ label: `Result ${i + 1}`, text: `${r.title} — from ${r.hrefHost}`, anchorEl: r.anchorEl });
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

    // Product listing pages: same reasoning as search_results above — the
    // whole page IS a list of results, so build it directly rather than
    // running the generic query-match layer over it. Always DOM-ordered
    // (see buildShoppingListingOrder) so reading order matches what's
    // actually visible on screen, including sponsored placements that
    // structured data commonly omits.
    if (intent === 'shopping_listing') {
      return buildShoppingListingOrder(features);
    }

    const structured = features && features.structured;
    const queryBlocks = features && features.query ? buildQueryMatchBlocks(features.query.keywords) : [];

    let intentBlocks;
    switch (intent) {
      case 'shopping':
        intentBlocks = (structured && structured.product) ? buildShoppingOrderFromStructured(structured.product) : buildShoppingOrder();
        break;
      case 'job_search':
        intentBlocks = (structured && structured.job) ? buildJobOrderFromStructured(structured.job) : buildJobOrder();
        break;
      case 'news':
        intentBlocks = (structured && structured.article) ? buildNewsOrderFromStructured(structured.article) : buildNewsOrder();
        break;
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
