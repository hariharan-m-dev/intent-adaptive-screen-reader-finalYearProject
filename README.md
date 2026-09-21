# Intent-Adaptive Screen Reader — Prototype

Browser extension that predicts a webpage's task-type (shopping, job search,
news, form-filling) from its DOM structure and content, then reorders the
audio output via the Web Speech API to surface what matters most for that
task first — instead of reading linearly or using a generic importance score.

## Architecture

```
featureExtractor.js  -> pulls DOM/URL/ARIA/keyword signals, scoped to main
                          content (no ML); also captures the user's search
                          query from the URL/referrer
classifier.js         -> heuristic scoring per intent (v1 stand-in for the
                          planned MiniLM + Logistic Regression/XGBoost model)
                          intents: shopping, job_search, news, form_filling,
                          qa_reference
reorderer.js           -> CORE NOVELTY: rule-based per-intent priority config
                          deciding what gets said first, PLUS a search-query
                          match layer (keyword overlap, prepended first)
speech.js               -> Web Speech API wrapper, speaks blocks in order
content.js               -> orchestrates the pipeline, runs on every page
popup.html/popup.js       -> demo UI: shows detected intent, search query,
                          and reading order
```

## Two-layer reordering (secondary novelty)

1. **Search-query match** (if you arrived via a search engine or the URL has
   a `?q=`/`?query=`/`?search=` param): scores headings/paragraphs/list
   items in the main content by keyword overlap with your search terms and
   reads the best match(es) FIRST. Plain keyword overlap, not cosine
   similarity/embeddings — that's flagged as future work below.
2. **Intent-based order**: the rest of the content, ordered by the
   per-intent rules in `reorderer.js`.

This directly targets the case where the same URL/page serves different
intents depending on what the user was originally looking for.

## Search-results pages (bonus, beyond the 3 demo intents)

Discovered during testing: visiting a page via a search engine meant the
extension sometimes landed on the search-results page itself and picked up
an AI-generated overview/answer box instead of the actual list of results —
not useful for a blind user trying to choose which result to open. Fixed by
adding a `search_results` intent:
- Detected deterministically via known search-engine URL patterns (Google,
  Bing, DuckDuckGo, Brave Search, Yahoo) — bypasses the heuristic scoring
  race entirely, since the URL alone is a reliable signal here.
- Reorders to: your search query, then up to 5 organic result titles + source
  domains, explicitly skipping anything inside an AI-overview/answer-box
  style container.

This wasn't one of the 3 originally scoped demo intents (shopping/job/news)
— it came out of real testing and was added because it directly strengthens
the "reordering respects what the user is actually trying to do" claim.

## Q&A / reference pages (Stack Overflow, technical docs, etc.)

Added after testing surfaced a bug: raw page-wide form/input counts were
falsely triggering `form_filling` on pages like Stack Overflow, which are
full of small unrelated widgets (search bar, vote buttons, comment boxes,
follow/share popovers) that aren't "forms" in the sense we mean. Fixed by:
- Scoping form/input counting to the main content area only
- Counting only genuinely fillable input types (not buttons/submits)
- Adding a dedicated `qa_reference` intent (question heading, code blocks,
  "asked"/"answers"/"votes" keywords) that reorders to Question → Details →
  Top answer → Code, instead of falling back to a form or reading linearly

## Install (for local testing / demo)

1. Open Chrome -> `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" -> select this folder
4. Pin the extension icon for quick access

## Demo script (3 page types, one continuous run)

1. Open a real shopping product page -> click the extension icon
   - "Analyze this page" shows intent badge: `shopping`
   - "Read (task-prioritized order)" speaks: Product -> Price -> Action (buy) -> Rating
2. Navigate to a job listing page -> click icon again
   - Intent badge: `job_search`
   - Speaks: Job title -> Salary -> Deadline -> Apply -> Location
3. Navigate to a news article -> click icon again
   - Intent badge: `news`
   - Speaks: Headline -> Author -> Published -> Summary paragraph

Narrate the contrast each time: a normal screen reader would read the nav
bar, ads, and boilerplate first. This reorders to the task-relevant content
immediately.

## Known limitations (state these plainly in the report)

- Classifier is a hand-tuned heuristic scoring model, not the trained
  MiniLM-embedding + Logistic Regression/XGBoost classifier originally
  scoped. Same feature inputs are extracted either way, so the trained
  model is a drop-in replacement for `classifier.js` later.
- No labeled training dataset was collected in this prototype phase.
- Search-query matching uses plain keyword overlap, not the originally
  scoped cosine-similarity-over-embeddings approach — a simplification made
  under the 2-day timeline, same drop-in-replacement logic applies.
- Reordering rules (both per-intent and Q&A-specific selectors like
  `.accepted-answer`) are authored for common page layouts and may miss
  unusual DOM structures on other sites.
- Search-results-page detection covers 5 major engines by URL pattern;
  organic-result extraction uses generic link heuristics (not per-engine
  markup), so snippet text isn't captured, only titles + source domains.
- AI-overview/answer-box suppression is class/attribute-name matching
  (e.g. `class*="ai-overview"`), so an engine using different markup
  conventions could still leak through.
- Tested against a small, curated set of real pages for the demo, not a
  broad benchmark.

## Future work

- Collect the ~200-300 labeled page dataset and train the intent
  classifier as originally scoped (MiniLM embeddings + Logistic
  Regression/XGBoost), export via ONNX.js/TF.js for in-browser inference.
- Replace keyword-overlap query matching with embedding-based cosine
  similarity as originally scoped.
- Expand reordering rules to more intents and edge-case layouts.
- User study with actual screen-reader users to validate the reordering
  actually helps task completion time / satisfaction.
