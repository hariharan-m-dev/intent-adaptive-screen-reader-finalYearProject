/**
 * classifier.js
 * Heuristic intent classifier — v1 prototype implementation.
 *
 * NOTE (for report / future work): this replaces the planned
 * MiniLM-embedding + Logistic Regression/XGBoost classifier trained on
 * ~200-300 labeled pages, which was scoped but not feasible within the
 * 2-day prototype window. This scoring model is a stand-in that captures
 * the same signal categories (structure + keywords + URL pattern) the
 * trained classifier would have used as input features, so swapping in
 * the trained model later is a drop-in replacement — same feature
 * extractor, same intent output shape, different scoring function.
 */

const IASR_Classifier = (() => {

  const INTENTS = ['shopping', 'shopping_listing', 'job_search', 'news', 'form_filling', 'qa_reference', 'search_results', 'unknown'];

  function scoreShopping(f) {
    let score = 0;
    if (f.url.hasShoppingPath) score += 3;
    score += Math.min(f.price.priceCount, 5) * 1.5;
    score += (f.shoppingKeywords['add to cart'] || 0) * 4;
    score += (f.shoppingKeywords['buy now'] || 0) * 4;
    score += (f.shoppingKeywords['in stock'] || 0) * 2;
    score += (f.shoppingKeywords['rating'] || 0) * 1;
    score += (f.shoppingKeywords['reviews'] || 0) * 1;
    return score;
  }

  function scoreJob(f) {
    let score = 0;
    if (f.url.hasJobPath) score += 3;
    score += (f.jobKeywords['salary'] || 0) * 3;
    score += (f.jobKeywords['apply now'] || 0) * 4;
    score += (f.jobKeywords['job description'] || 0) * 3;
    score += (f.jobKeywords['responsibilities'] || 0) * 2;
    score += (f.jobKeywords['qualifications'] || 0) * 2;
    score += (f.jobKeywords['deadline'] || 0) * 2;
    score += (f.jobKeywords['full-time'] || 0) * 1;
    score += (f.jobKeywords['remote'] || 0) * 1;
    return score;
  }

  function scoreNews(f) {
    let score = 0;
    if (f.url.hasNewsPath) score += 3;
    score += (f.newsKeywords['published'] || 0) * 2;
    score += (f.newsKeywords['byline'] || 0) * 2;
    score += (f.newsKeywords['author'] || 0) * 2;
    score += (f.newsKeywords['breaking'] || 0) * 3;
    score += (f.newsKeywords['reporter'] || 0) * 2;
    score += (f.newsKeywords['update'] || 0) * 1;
    // Long-form single-article body text with few forms is news-ish
    if (f.forms.formCount === 0 && f.bodyTextLength > 3000) score += 2;
    return score;
  }

  function scoreFormFilling(f) {
    let score = 0;
    // inputCount/formCount are now scoped to main content and filtered to
    // fillable field types only (see featureExtractor.getFormSignals),
    // so scattered vote/share/search widgets no longer inflate this.
    score += Math.min(f.forms.inputCount, 10) * 1.5;
    score += f.forms.formCount * 2;
    if (f.aria.hasFormRole) score += 2;
    // A handful of real fields close together is the actual signal for
    // "this page wants you to fill something out" — a single stray field
    // (e.g. a comment box) shouldn't be enough on its own.
    if (f.forms.inputCount < 2) score = Math.max(0, score - 2);
    return score;
  }

  function scoreQaReference(f) {
    let score = 0;
    if (f.qa.isQuestionHeading) score += 3;
    score += Math.min(f.qa.codeBlockCount, 5) * 1.5;
    score += (f.qaKeywords['asked'] || 0) * 3;
    score += (f.qaKeywords['answers'] || 0) * 3;
    score += (f.qaKeywords['answer'] || 0) * 1;
    score += (f.qaKeywords['votes'] || 0) * 2;
    score += (f.qaKeywords['viewed'] || 0) * 2;
    score += (f.qaKeywords['modified'] || 0) * 1;
    score += (f.qaKeywords['accepted'] || 0) * 2;
    return score;
  }

  function classify(features) {
    // Deterministic short-circuit: a known search-engine results page
    // doesn't need to compete in the heuristic scoring race below.
    if (features.searchEngine && features.searchEngine.isSearchResultsPage) {
      return {
        intent: 'search_results',
        scores: { search_results: 100 },
        confidence: 100
      };
    }

    // Structured-data short-circuits (schema.org JSON-LD / Open Graph):
    // protocol-based, not site-based, so these generalize across any site
    // that follows SEO conventions rather than needing per-site tuning.
    // Checked before the DOM heuristics below, which stay as a fallback
    // for sites that don't emit structured data.
    const structured = features.structured;
    if (structured) {
      if (structured.listing && structured.listing.items.length >= 2) {
        return { intent: 'shopping_listing', scores: { shopping_listing: 100 }, confidence: 100 };
      }
      if (structured.product) {
        return { intent: 'shopping', scores: { shopping: 100 }, confidence: 100 };
      }
      if (structured.job) {
        return { intent: 'job_search', scores: { job_search: 100 }, confidence: 100 };
      }
      if (structured.article) {
        return { intent: 'news', scores: { news: 100 }, confidence: 100 };
      }
    }

    // Deterministic short-circuit: a product LISTING page (many product
    // cards, e.g. a Flipkart/Amazon search) is not a single-product page —
    // the single-product reordering rules (first h1/price on the page)
    // don't apply and previously grabbed arbitrary unrelated content.
    // Fallback for sites without structured data.
    if (features.listing && features.listing.isProductListing) {
      return {
        intent: 'shopping_listing',
        scores: { shopping_listing: 100 },
        confidence: 100
      };
    }

    const scores = {
      shopping: scoreShopping(features),
      job_search: scoreJob(features),
      news: scoreNews(features),
      form_filling: scoreFormFilling(features),
      qa_reference: scoreQaReference(features)
    };

    let best = 'unknown';
    let bestScore = 0;
    for (const [intent, score] of Object.entries(scores)) {
      if (score > bestScore) {
        best = intent;
        bestScore = score;
      }
    }

    // Confidence threshold — below this, fall back to unknown/linear reading
    const CONFIDENCE_THRESHOLD = 3;
    if (bestScore < CONFIDENCE_THRESHOLD) {
      best = 'unknown';
    }

    return {
      intent: best,
      scores,
      confidence: bestScore
    };
  }

  return { classify, INTENTS };
})();
