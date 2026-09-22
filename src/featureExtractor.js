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

  /**
   * Detects a product LISTING/search-results page (e.g. a Flipkart/Amazon
   * "?q=camera" search), as opposed to a single-product detail page.
   * Class-name-independent on purpose: e-commerce sites use hashed/obfuscated
   * class names, so instead of matching selectors we look for the structural
   * fingerprint of a product grid — multiple distinct anchors that each
   * contain both descriptive text and a price. This matters because the
   * single-product reordering rules (first h1 / first price on the page)
   * are meaningless on a listing page with dozens of products, and previously
   * picked up arbitrary unrelated page text (filters, footer, etc.).
   */
  const LISTING_PRICE_RE = /[$₹€£]\s?\d[\d,]*(\.\d{2})?/;
  function getListingSignals() {
    const root = getMainContentRoot();
    const anchors = Array.from(root.querySelectorAll('a[href]'));
    const seen = new Set();
    let cardCount = 0;
    for (const a of anchors) {
      const text = (a.innerText || '').trim();
      if (!text || text.length < 10 || text.length > 300) continue;
      if (!LISTING_PRICE_RE.test(text)) continue;
      const href = a.getAttribute('href');
      if (!href || seen.has(href)) continue;
      seen.add(href);
      cardCount += 1;
    }
    return { cardCount, isProductListing: cardCount >= 4 };
  }

  function getMeta(property) {
    const el = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
    return el ? el.getAttribute('content') : null;
  }

  function normalizeTypes(t) {
    if (!t) return [];
    return (Array.isArray(t) ? t : [t]).map(x => String(x).toLowerCase());
  }

  // Recursively flattens JSON-LD (handles @graph wrappers and arrays) into
  // a flat list of typed objects.
  function flattenJsonLd(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => flattenJsonLd(n, out)); return; }
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
    if (node['@type']) out.push(node);
  }

  function extractProduct(obj) {
    let price = '';
    let availability = '';
    const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
    if (offer) {
      const rawPrice = offer.price || (offer.priceSpecification && offer.priceSpecification.price) || '';
      price = rawPrice ? `${offer.priceCurrency || ''} ${rawPrice}`.trim() : '';
      availability = (offer.availability || '').split('/').pop() || '';
    }
    let rating = '';
    if (obj.aggregateRating) {
      const r = obj.aggregateRating;
      rating = `${r.ratingValue || ''}${r.reviewCount ? ` (${r.reviewCount} reviews)` : ''}`.trim();
    }
    return { name: obj.name || '', price, rating, availability };
  }

  function extractItemList(obj) {
    const elements = Array.isArray(obj.itemListElement) ? obj.itemListElement : [];
    // Not capped to a handful — this is used as a name lookup dictionary
    // matched against DOM hrefs, not the final displayed list, and sites
    // commonly list 20-40+ organic entries here (which also often excludes
    // sponsored placements, so it's unsafe to use for reading ORDER).
    const items = elements.slice(0, 50).map(el => {
      const item = el.item || el;
      const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      return { name: item.name || el.name || '', url: item.url || el.url || '', price: offer && offer.price ? offer.price : '' };
    }).filter(i => i.name);
    return { count: items.length, items };
  }

  function extractArticle(obj) {
    let author = '';
    if (obj.author) {
      const a = Array.isArray(obj.author) ? obj.author[0] : obj.author;
      author = (a && a.name) || (typeof a === 'string' ? a : '') || '';
    }
    return { headline: obj.headline || obj.name || '', author, datePublished: obj.datePublished || '' };
  }

  function extractJob(obj) {
    let salary = '';
    if (obj.baseSalary && obj.baseSalary.value) {
      const v = obj.baseSalary.value;
      salary = `${v.minValue || v.value || ''}${v.maxValue ? '-' + v.maxValue : ''} ${obj.baseSalary.currency || ''}`.trim();
    }
    return { title: obj.title || '', salary, deadline: obj.validThrough || '' };
  }

  /**
   * Reads schema.org structured data (JSON-LD) and Open Graph meta tags.
   * Unlike DOM/class-name heuristics, this is protocol-based: any site that
   * follows SEO conventions (most real e-commerce/news/job sites do, for
   * Google rich snippets) exposes it the same way regardless of its visual
   * markup or hashed class names, so this generalizes across sites rather
   * than needing per-site tuning. Falls back to null fields when absent —
   * callers should fall back to the DOM heuristics in that case.
   */
  function getStructuredDataSignals() {
    const result = { product: null, listing: null, article: null, job: null };
    const items = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { flattenJsonLd(JSON.parse(s.textContent), items); } catch (e) { /* malformed JSON-LD, skip */ }
    });

    for (const obj of items) {
      const types = normalizeTypes(obj['@type']);
      if (!result.product && types.includes('product')) result.product = extractProduct(obj);
      if (!result.listing && types.includes('itemlist')) result.listing = extractItemList(obj);
      if (!result.article && types.some(t => ['newsarticle', 'article', 'blogposting'].includes(t))) result.article = extractArticle(obj);
      if (!result.job && types.includes('jobposting')) result.job = extractJob(obj);
    }

    // Some sites emit several standalone Product entries instead of one
    // ItemList wrapper — that's still a listing signal.
    if (!result.listing) {
      const products = items.filter(o => normalizeTypes(o['@type']).includes('product'));
      if (products.length >= 2) {
        result.listing = {
          count: products.length,
          items: products.slice(0, 5).map(p => {
            const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
            return { name: p.name || '', price: offer && offer.price ? offer.price : '' };
          })
        };
      }
    }

    // Open Graph fallback for a single product when no JSON-LD is present.
    if (!result.product) {
      const ogType = getMeta('og:type');
      if (ogType && /product/i.test(ogType)) {
        const name = getMeta('og:title') || (document.querySelector('h1') ? document.querySelector('h1').innerText : '');
        const rawPrice = getMeta('product:price:amount') || getMeta('og:price:amount');
        const currency = getMeta('product:price:currency') || getMeta('og:price:currency') || '';
        if (name || rawPrice) {
          result.product = { name, price: rawPrice ? `${currency} ${rawPrice}`.trim() : '', rating: '', availability: getMeta('product:availability') || '' };
        }
      }
    }

    return result;
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
      listing: getListingSignals(),
      structured: getStructuredDataSignals(),
      bodyTextLength: bodyText.length
    };
  }

  return { extract, getMainContentRoot };
})();
