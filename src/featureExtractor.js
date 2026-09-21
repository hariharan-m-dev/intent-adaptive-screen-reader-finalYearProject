/**
 * featureExtractor.js
 * Pulls structural + textual signals from the DOM, URL, and ARIA landmarks.
 * No ML here — pure heuristics over what's actually on the page.
 * These features feed the classifier in classifier.js.
 */

const IASR_FeatureExtractor = (() => {

  /**
   * Scopes analysis to the real content area, excluding nav/header/footer/
   * sidebar chrome. This matters because raw page-wide form/input counts
   * pick up unrelated widgets (search bars, vote buttons, comment boxes,
   * follow/share popovers) and previously caused false "form_filling"
   * classifications on sites like Stack Overflow.
   */
  function getMainContentRoot() {
    const candidates = ['main', 'article', '[role="main"]', '#content', '.content'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function getUrlSignals() {
    const url = window.location.href.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    return {
      url,
      hasShoppingPath: /\/(product|item|shop|store|cart|checkout|dp\/)/.test(path),
      hasJobPath: /\/(job|jobs|career|careers|vacancy|posting)/.test(path),
      hasNewsPath: /\/(news|article|story|blog|post)/.test(path),
      hostname: window.location.hostname
    };
  }

  function getHeadingSignals() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(h => h.innerText.trim())
      .filter(Boolean);
    return {
      headings,
      headingText: headings.join(' ').toLowerCase()
    };
  }

  function getAriaSignals() {
    const landmarks = Array.from(document.querySelectorAll('[role]'))
      .map(el => el.getAttribute('role'));
    return {
      landmarks,
      hasFormRole: landmarks.includes('form'),
      hasMainRole: landmarks.includes('main')
    };
  }

  // Input types that represent an actual fillable field. Buttons, submits
  // and hidden inputs don't count — they're what inflated form_filling
  // scores on pages full of vote/follow/share widgets.
  const FILLABLE_TYPES = new Set(['text', 'email', 'password', 'number', 'tel', 'url', 'date', 'search', 'textarea', 'select-one', 'select-multiple', 'checkbox', 'radio']);

  function getFormSignals() {
    const root = getMainContentRoot();
    const forms = Array.from(root.querySelectorAll('form'));
    const allInputs = Array.from(root.querySelectorAll('input, select, textarea'));
    const fillableInputs = allInputs.filter(i => FILLABLE_TYPES.has((i.type || i.tagName.toLowerCase())));
    return {
      formCount: forms.length,
      inputCount: fillableInputs.length,
      inputTypes: fillableInputs.map(i => i.type || i.tagName.toLowerCase())
    };
  }

  function getQaSignals() {
    const root = getMainContentRoot();
    const codeBlockCount = root.querySelectorAll('pre, code').length;
    const h1Text = (document.querySelector('h1') ? document.querySelector('h1').innerText : '').toLowerCase();
    const isQuestionHeading = /\?|^(how|why|what|when|is|does|can|should)\b/.test(h1Text.trim());
    return { codeBlockCount, isQuestionHeading };
  }

  /**
   * Search-query capture (lightweight v1): pulls the user's search terms
   * from the current URL's query string, or failing that, from the
   * referrer (the search engine results page that sent them here).
   * Used by the reorderer to surface page sections matching what the
   * person actually searched for, via plain keyword overlap — no
   * embeddings/cosine similarity in this pass.
   */
  const QUERY_PARAM_KEYS = ['q', 'query', 'search', 'wd', 'p'];
  const STOPWORDS = new Set(['the', 'is', 'a', 'an', 'of', 'in', 'to', 'for', 'and', 'or', 'what', 'how', 'why', 'does', 'do', 'are', 'on', 'with', 'be', 'i', 'my']);

  function extractQueryParam(urlString) {
    try {
      const u = new URL(urlString);
      const params = new URLSearchParams(u.search);
      for (const key of QUERY_PARAM_KEYS) {
        const val = params.get(key);
        if (val) return val;
      }
    } catch (e) { /* invalid URL, ignore */ }
    return '';
  }

  function getQuerySignals() {
    let queryText = extractQueryParam(window.location.href);
    if (!queryText && document.referrer) {
      queryText = extractQueryParam(document.referrer);
    }
    const keywords = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOPWORDS.has(w));
    return { queryText, keywords };
  }

  function getLinkSignals() {
    const links = Array.from(document.querySelectorAll('a'))
      .map(a => (a.innerText || '').trim().toLowerCase())
      .filter(Boolean);
    return {
      linkCount: links.length,
      linkText: links.join(' | ')
    };
  }

  function getBodyText() {
    // Capped to avoid processing huge pages
    return (document.body.innerText || '').slice(0, 20000).toLowerCase();
  }

  function getPriceSignals(bodyText) {
    const priceMatches = bodyText.match(/[$₹€£]\s?\d[\d,]*(\.\d{2})?/g) || [];
    return {
      priceCount: priceMatches.length,
      samplePrices: priceMatches.slice(0, 3)
    };
  }

  function getKeywordCounts(bodyText, keywords) {
    return keywords.reduce((acc, kw) => {
      const re = new RegExp(`\\b${kw}\\b`, 'g');
      acc[kw] = (bodyText.match(re) || []).length;
      return acc;
    }, {});
  }

  /**
   * Detects known search-engine results pages via URL host+path pattern.
   * This is a deterministic check, not a heuristic score — a Google/Bing/
   * Brave/DuckDuckGo results page is identifiable with near-certainty from
   * the URL alone, so there's no need to run it through the generic
   * intent-scoring race (which is exactly what let an AI-overview box
   * outscore everything else previously).
   */
  const SEARCH_ENGINE_PATTERNS = [
    { engine: 'Google', test: (host, path) => /(^|\.)google\.[a-z.]+$/.test(host) && path === '/search' },
    { engine: 'Bing', test: (host, path) => /(^|\.)bing\.com$/.test(host) && path === '/search' },
    { engine: 'DuckDuckGo', test: (host) => /(^|\.)duckduckgo\.com$/.test(host) },
    { engine: 'Brave Search', test: (host, path) => /(^|\.)search\.brave\.com$/.test(host) && path === '/search' },
    { engine: 'Yahoo', test: (host, path) => /(^|\.)search\.yahoo\.com$/.test(host) }
  ];

  function getSearchEngineSignals() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    for (const p of SEARCH_ENGINE_PATTERNS) {
      if (p.test(host, path)) return { isSearchResultsPage: true, engine: p.engine };
    }
    return { isSearchResultsPage: false, engine: null };
  }

  function extract() {
    const bodyText = getBodyText();
    return {
      url: getUrlSignals(),
      headings: getHeadingSignals(),
      aria: getAriaSignals(),
      forms: getFormSignals(),
      links: getLinkSignals(),
      price: getPriceSignals(bodyText),
      shoppingKeywords: getKeywordCounts(bodyText, ['add to cart', 'buy now', 'in stock', 'free shipping', 'rating', 'reviews']),
      jobKeywords: getKeywordCounts(bodyText, ['salary', 'apply now', 'job description', 'responsibilities', 'qualifications', 'deadline', 'full-time', 'remote']),
      newsKeywords: getKeywordCounts(bodyText, ['published', 'byline', 'author', 'breaking', 'reporter', 'update']),
      qaKeywords: getKeywordCounts(bodyText, ['asked', 'answers', 'answer', 'solution', 'viewed', 'votes', 'modified', 'accepted']),
      qa: getQaSignals(),
      query: getQuerySignals(),
      searchEngine: getSearchEngineSignals(),
      bodyTextLength: bodyText.length
    };
  }

  return { extract, getMainContentRoot };
})();
