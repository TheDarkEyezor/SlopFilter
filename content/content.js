/**
 * content.js — SlopFilter DOM scanner
 *
 * Pipeline:
 *   1. Initial scan of all candidate elements at document_idle.
 *   2. IntersectionObserver → pre-scan elements 300px before they enter the viewport.
 *   3. MutationObserver     → catch dynamically injected nodes (SPAs, infinite scroll).
 *   4. Detection via SlopDetector.detect() — synchronous heuristics, < 1ms per element.
 *   5a. slop/ai/rage: removed from DOM immediately (O(1) .remove() call).
 *   5b. misinfo: dimmed in-place + async fact-check via background.js, then annotated.
 *   6. Stats reported back to popup via chrome.runtime.sendMessage.
 */
(() => {
  'use strict';

  // ─── GUARD: injected twice? bail. ─────────────────────────────────────────────
  if (window.__slopFilterActive) return;
  window.__slopFilterActive = true;

  // ─── STATE ─────────────────────────────────────────────────────────────────────

  /** Elements already processed (WeakSet → no memory leaks). Using let so RESCAN can reassign. */
  let processed = new WeakSet();

  /** Removed element count, for popup badge (DOM-layer + network-layer combined). */
  let removedCount = 0;

  /** Pending fact-check requests: fcId → element. Cleaned up when result arrives. */
  const pendingFactChecks = new Map();
  let fcIdCounter = 0;

  /** User settings — loaded once then cached. */
  let settings = {
    enabled: true,
    modes: { slop: true, ai: true, rage: true, misinfo: true },
    debugHighlight: false,   // highlight flagged elements instead of removing
    debugScanAll:   false,   // outline EVERY scanned element (even if not flagged)
    minTextLength: 40,       // ignore elements shorter than this
  };

  // ─── TWITTER SKIP ZONES ──────────────────────────────────────────────────────
  // Elements whose subtree we never want to scan on Twitter/X.
  // Checked via el.closest() — if the element is inside one of these containers
  // it is excluded before any text extraction or detection runs.
  // Keeps the scanner focused on the feed and avoids noisy false positives from
  // trending topics, hashtag pills, "Who to follow", ads, and nav elements.
  const TWITTER_SKIP_SELECTOR = [
    '[data-testid="sidebarColumn"]',        // entire right-hand sidebar
    '[data-testid="trend"]',                // individual trending topic row
    '[aria-label="Timeline: Trending now"]',// trending panel
    '[data-testid="UserCell"]',             // "Who to follow" cards
    '[aria-label="Who to follow"]',
    '[data-testid="placementTracking"]',    // promoted / ad tweets
    '[data-testid="promoted-tweet"]',
    'nav',                                  // left-hand navigation
    'header',
    '[role="banner"]',
    '[data-testid="TopNavBar"]',
  ].join(',');

  /** Returns true if this element lives inside a skip zone on Twitter. */
  function inSkipZone(el) {
    // Only apply skip zones on Twitter — other sites don't have these selectors.
    if (!/^(twitter|x)\.com$/.test(location.hostname)) return false;
    return Boolean(el.closest(TWITTER_SKIP_SELECTOR));
  }

  // ─── CSS SELECTORS FOR CANDIDATE ELEMENTS ─────────────────────────────────────
  // Platform-specific selectors come FIRST so they are matched before the
  // generic ones, letting actionTarget() steer the act-on element correctly.
  //
  // [data-testid="tweetText"]  — Twitter/X: the exact rendered tweet text node.
  //   Twitter only inserts this element AFTER React has fully hydrated the tweet,
  //   so it is a reliable signal that real text is present (avoids the empty-shell
  //   timing race with generic `article`).  We detect here, act on closest article.
  // [data-testid="tweet"]      — whole tweet card (fallback / for very short posts).
  const CANDIDATE_SELECTOR = [
    '[data-testid="tweetText"]',
    '[data-testid="tweet"]',
    'article', 'section', 'main',
    'p', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '[class*="post"]', '[class*="content"]', '[class*="article"]',
    '[class*="feed"]',  '[class*="card"]',
    '[class*="story"]', '[class*="summary"]',
    '[class*="description"]', '[class*="excerpt"]',
    '[class*="caption"]',
    'li',
  ].join(',');

  // ─── TEXT EXTRACTION + PLATFORM HELPERS ──────────────────────────────────────

  /**
   * Extract clean plain text from an element.
   *
   * For Twitter tweetText nodes: return their own textContent directly.
   * The element contains only the tweet body — no username, timestamp, or
   * metric numbers — so no cleaning needed and no clone overhead.
   *
   * For everything else: clone, strip noise elements, collapse whitespace.
   */
  function extractText(el) {
    if (el.dataset?.testid === 'tweetText') {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Return the element to act on (remove / blur) for a given scanned candidate.
   *
   * For Twitter tweetText: walk to the OUTERMOST [data-testid="tweet"] ancestor.
   * This is critical for retweets/reposts and quote tweets, where the DOM is:
   *
   *   article[data-testid="tweet"]          ← outer: the repost/quote card
   *     div "X reposted" / "X quoted"       ← repost header
   *     article[data-testid="tweet"]         ← inner: the quoted/original card
   *       div[data-testid="tweetText"]       ← this is what we scanned
   *
   * el.closest("article") would return the inner card, leaving the outer repost
   * wrapper intact on screen.  Outermost-walk fixes that.
   *
   * For everything else: act on the element itself.
   */
  function actionTarget(el) {
    if (el.dataset?.testid === 'tweetText') {
      // Walk upward collecting every [data-testid="tweet"] ancestor.
      // The last one found is the outermost tweet card on screen.
      let node = el.parentElement;
      let outermost = null;
      while (node) {
        if (node.dataset?.testid === 'tweet') outermost = node;
        node = node.parentElement;
      }
      const card = outermost || el.closest('article') || el;
      processed.add(card); // prevent double-scan via generic article selector
      return card;
    }
    return el;
  }

  // ─── MISINFO: BLUR + BADGE INJECTION ────────────────────────────────────────

  /**
   * Dim a misinfo element and inject a fact-check badge over it.
   * Returns the badge element so it can be updated when the result arrives.
   */
  function applyMisinfoState(el, fcId, score) {
    el.style.position = 'relative';    // badge needs a positioned ancestor
    el.setAttribute('data-slopfilter', 'misinfo');
    el.setAttribute('data-slopfilter-score', score);
    el.setAttribute('data-slopfilter-fc-id', fcId);
    el.classList.add('slopfilter-flagged', 'slopfilter-misinfo', 'slopfilter-fc-pending');

    const badge = document.createElement('div');
    badge.className = 'sf-fc-badge';
    badge.setAttribute('data-fc-id', fcId);
    badge.innerHTML =
      `<span class="sf-fc-spinner"></span>` +
      `<span>Checking claims… <a class="sf-fc-show" data-fc-show="${fcId}">show anyway</a></span>`;
    el.appendChild(badge);
    return badge;
  }

  /**
   * Update an existing badge with the fact-check result.
   * Removes the blur state; shows verdict + expandable summary.
   */
  function applyFactCheckResult(el, badge, result) {
    el.classList.remove('slopfilter-fc-pending');

    const verdictIcon = {
      'FALSE': '❌', 'Pants on Fire': '🔥', 'Mostly False': '⚠️',
      'Half-True': '⚠️', 'Mostly True': '✅', 'TRUE': '✅',
      'context': 'ℹ️', 'unverified': '❓',
    }[result.verdict] || '❓';

    const sourceHtml = result.sourceUrl
      ? ` <a class="sf-fc-source-link" href="${result.sourceUrl}" target="_blank" rel="noopener">${result.source}</a>`
      : ` <span style="color:#999;font-size:10px">${result.source}</span>`;

    badge.setAttribute('data-verdict', result.verdict);
    badge.innerHTML =
      `<span>${verdictIcon} <strong>${result.verdict}</strong> ·${sourceHtml}` +
      `<a class="sf-fc-show" data-fc-show="${badge.dataset.fcId || ''}">hide post</a></span>` +
      `<div class="sf-fc-summary">${result.summary.slice(0, 280)}</div>`;
  }

  // Delegated click handler for "show anyway" / "hide post" links
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-fc-show]');
    if (!link) return;
    e.stopPropagation();
    e.preventDefault();
    const fcId = link.getAttribute('data-fc-show');
    const el = document.querySelector(`[data-slopfilter-fc-id="${fcId}"]`);
    if (!el) return;
    const isRevealed = el.classList.contains('slopfilter-fc-revealed');
    el.classList.toggle('slopfilter-fc-pending', false);
    el.classList.toggle('slopfilter-fc-revealed', !isRevealed);
    // Update link text
    const badge = el.querySelector('.sf-fc-badge');
    const showLink = badge?.querySelector('[data-fc-show]');
    if (showLink) showLink.textContent = isRevealed ? 'hide post' : 'show anyway';
  }, true);

  // ─── ELEMENT REMOVAL / HIGHLIGHTING ──────────────────────────────────────

  function processResult(el, result) {
    if (!result.flagged) return;

    // ── MISINFO: dim + async fact-check (never delete) ──────────────────────
    if (result.needsFactCheck) {
      const fcId = `sf_${++fcIdCounter}`;
      applyMisinfoState(el, fcId, result.score);
      pendingFactChecks.set(fcId, el);

      const text = extractText(el).slice(0, 500);
      chrome.runtime.sendMessage({
        type: 'FACT_CHECK_REQUEST',
        id:   fcId,
        text,
      }).catch(() => {});

      removedCount++;
      chrome.runtime.sendMessage({ type: 'STATS_UPDATE', removedCount }).catch(() => {});
      return;
    }

    // ── SLOP / AI / RAGE ────────────────────────────────────────────────────
    if (settings.debugHighlight) {
      // Dev mode: visually flag but don't remove
      el.setAttribute('data-slopfilter', result.category);
      el.setAttribute('data-slopfilter-score', result.score);
      el.setAttribute('title', `SlopFilter [${result.category} ${result.score}]\n${result.hits.join(', ')}`);
      el.classList.add('slopfilter-flagged', `slopfilter-${result.category}`);
    } else {
      // Production: O(1) removal, gone from layout immediately
      el.remove();
    }

    removedCount++;
    chrome.runtime.sendMessage({ type: 'STATS_UPDATE', removedCount }).catch(() => {});
  }

  // ─── CORE SCAN FUNCTION ───────────────────────────────────────────────────────

  function scanElement(el) {
    if (!settings.enabled) return;
    if (processed.has(el)) return;

    // Skip invisible or already-removed elements
    if (!el.isConnected) return;
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return;

    // Skip Twitter sidebar / trending / who-to-follow / nav zones
    if (inSkipZone(el)) {
      processed.add(el); // don't re-visit
      return;
    }

    const text = extractText(el);

    // ─── KEY FIX: do NOT stamp as processed if text is empty ────────────────
    // React SPAs (Twitter, LinkedIn) add the container element to the DOM
    // first, then populate text in a subsequent reconcile pass.  If we mark
    // the element as processed while text is still empty, the real content is
    // silently skipped forever.  By returning without marking, we allow the
    // MutationObserver to re-enqueue the element once its text node is added.
    if (!text) return;

    // Commit: element has real content, mark it to prevent re-scanning.
    processed.add(el);

    // debugScanAll: outline every element the scanner touches, even if not
    // flagged. Useful for verifying the selector is hitting real tweet cards.
    if (settings.debugScanAll) {
      const target = actionTarget(el);
      target.setAttribute('data-slopfilter-scanned', 'true');
    }

    if (text.length < settings.minTextLength) return;

    const result = window.SlopDetector.detect(text, settings.modes);
    processResult(actionTarget(el), result);
  }

  // ─── BATCH SCAN (main-thread friendly using requestIdleCallback) ───────────────

  let pendingQueue = [];
  let idleScheduled = false;

  function flushQueue(deadline) {
    while (pendingQueue.length > 0) {
      // Yield to browser if we're running low on idle time
      if (deadline && deadline.timeRemaining() < 2) {
        scheduleFlush(); // re-schedule remaining work
        return;
      }
      scanElement(pendingQueue.shift());
    }
    idleScheduled = false;
  }

  function scheduleFlush() {
    if (idleScheduled) return;
    idleScheduled = true;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(flushQueue, { timeout: 1500 });
    } else {
      setTimeout(() => flushQueue(null), 0);
    }
  }

  function enqueue(el) {
    if (!processed.has(el)) {
      pendingQueue.push(el);
      scheduleFlush();
    }
  }

  // ─── INITIAL SCAN ─────────────────────────────────────────────────────────────

  function initialScan() {
    const candidates = document.querySelectorAll(CANDIDATE_SELECTOR);
    candidates.forEach(enqueue);
  }

  // ─── INTERSECTION OBSERVER: scroll-ahead scanning ─────────────────────────────
  // Fires when an element enters the viewport (+ 300px margin above).
  // This ensures content loaded just-in-time by lazy loaders is caught.

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          intersectionObserver.unobserve(entry.target); // only need to scan once
          enqueue(entry.target);
        }
      });
    },
    { rootMargin: '300px 0px 300px 0px', threshold: 0 }
  );

  function observeNewElements(root) {
    root.querySelectorAll(CANDIDATE_SELECTOR).forEach(el => {
      if (!processed.has(el) && !inSkipZone(el)) {
        intersectionObserver.observe(el);
      }
    });
  }

  // ─── MUTATION OBSERVER: dynamic content (SPAs, infinite scroll) ───────────────

  // Debounce helper — avoids thrashing on rapid re-renders (React, Vue, etc.)
  let mutationTimer = null;
  const MUTATION_DEBOUNCE_MS = 120;

  const mutationObserver = new MutationObserver((mutations) => {
    if (!settings.enabled) return;

    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Scan node itself if it matches
          if (node.matches && node.matches(CANDIDATE_SELECTOR)) {
            enqueue(node);
          }

          // Scan any candidate descendants
          observeNewElements(node);
        }
      }
    }, MUTATION_DEBOUNCE_MS);
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ─── MESSAGES FROM POPUP / BACKGROUND ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'GET_STATS':
        sendResponse({ removedCount });
        break;

      case 'UPDATE_SETTINGS':
        settings = { ...settings, ...msg.settings };
        // If scanAll was just turned on, mark already-processed elements too
        if (settings.debugScanAll) {
          document.querySelectorAll('[data-slopfilter]').forEach(el => {
            el.setAttribute('data-slopfilter-scanned', 'true');
          });
        }
        syncSettingsToInterceptor();
        sendResponse({ ok: true });
        break;

      case 'FACT_CHECK_RESULT': {
        const el = pendingFactChecks.get(msg.id);
        if (el && el.isConnected) {
          const badge = el.querySelector(`[data-fc-id="${msg.id}"]`);
          if (badge) applyFactCheckResult(el, badge, msg);
        }
        pendingFactChecks.delete(msg.id);
        break;
      }

      case 'RESCAN': {
        // WeakSet has no .clear() — must reassign to a fresh instance.
        // Also strip any highlight/scan attributes left by the previous pass
        // so previously-flagged elements don't keep their badges on re-scan.
        document.querySelectorAll(
          '[data-slopfilter],[data-slopfilter-scanned]'
        ).forEach(el => {
          el.removeAttribute('data-slopfilter');
          el.removeAttribute('data-slopfilter-score');
          el.removeAttribute('data-slopfilter-fc-id');
          el.removeAttribute('data-slopfilter-scanned');
          el.classList.remove(
            'slopfilter-flagged','slopfilter-slop','slopfilter-ai',
            'slopfilter-rage','slopfilter-misinfo',
            'slopfilter-fc-pending','slopfilter-fc-revealed'
          );
          el.querySelectorAll('.sf-fc-badge').forEach(b => b.remove());
        });

        // Reassign WeakSet — all previously-processed elements are now eligible
        // to be scanned again.  (WeakSet has no .clear(); reassignment is the
        // only correct approach.  The old set is GC'd naturally.)
        processed = new WeakSet();

        pendingQueue.length = 0;    // drop any in-flight queue
        removedCount = 0;

        // Re-enqueue synchronously, then flush immediately (don't wait for idle)
        document.querySelectorAll(CANDIDATE_SELECTOR).forEach(el => {
          if (!inSkipZone(el)) pendingQueue.push(el);
        });
        flushQueue(null); // null deadline = run without yielding
        sendResponse({ ok: true });
        break;
      }
    }
    return true; // keep channel open for async response
  });
  // ─── MAIN-WORLD NETWORK INTERCEPTOR BRIDGE ────────────────────────────────
  // interceptor.js runs in MAIN world so chrome.* is unavailable there.
  // Stats flow: MAIN world → CustomEvent → here → chrome.runtime.sendMessage.
  // Settings flow: here → CustomEvent → MAIN world.

  window.addEventListener('slopfilter:network-removed', (e) => {
    const count = e?.detail?.count;
    if (typeof count === 'number' && count > 0) {
      removedCount += count;
      chrome.runtime.sendMessage({ type: 'STATS_UPDATE', removedCount }).catch(() => {});
    }
  });

  /** Push current enabled state to the MAIN-world interceptor. */
  function syncSettingsToInterceptor() {
    window.dispatchEvent(new CustomEvent('slopfilter:update-settings', {
      detail: { enabled: settings.enabled },
    }));
  }
  // ─── SETTINGS LOAD & BOOT ─────────────────────────────────────────────────────

  chrome.storage.sync.get(
    { enabled: true, modes: { slop: true, ai: true, rage: true, misinfo: true }, debugHighlight: false, debugScanAll: false },
    (stored) => {
      settings = { ...settings, ...stored };
      if (settings.enabled) {
        // Immediately observe all current candidates for intersection
        observeNewElements(document);
        // Also eagerly scan the above-fold content without waiting for scroll
        initialScan();
      }
      // Always relay enabled state to MAIN-world interceptor
      syncSettingsToInterceptor();
    }
  );

})();
