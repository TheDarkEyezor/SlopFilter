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
  if (!/^(twitter|x)\.com$/.test(location.hostname) && !/(^|\.)linkedin\.com$/.test(location.hostname)) return;

  // ─── STATE ─────────────────────────────────────────────────────────────────────

  /** Elements already processed (WeakSet → no memory leaks). Using let so RESCAN can reassign. */
  let processed = new WeakSet();
  /** Last extracted text per scanned node; allows re-scan when virtualized nodes get new content. */
  let lastScannedText = new WeakMap();
  /** Prevent duplicate queue entries for the same element. */
  let queued = new WeakSet();
  /** Media scan state to support retries for videos as frames load over time. */
  let mediaScanState = new WeakMap();
  /** Prevent repeated delayed video probe loops per target. */
  const mediaProbeState = new WeakMap();

  /** Removed element count, for popup badge (DOM-layer + network-layer combined). */
  let removedCount = 0;

  /** Pending fact-check requests: fcId → element. Cleaned up when result arrives. */
  const pendingFactChecks = new Map();
  let fcIdCounter = 0;
  /** Placeholder restore map for undo action. */
  const placeholderRestore = new Map();
  let placeholderIdCounter = 0;

  /** User settings — loaded once then cached. */
  let settings = {
    enabled: true,
    modes: { slop: true, ai: true, rage: true, misinfo: true },
    siteModes: { twitter: true, linkedin: true },
    debugHighlight: false,   // highlight flagged elements instead of removing
    debugScanAll:   false,   // outline EVERY scanned element (even if not flagged)
    minTextLength: 40,       // ignore elements shorter than this
    replacementMode: 'off',  // 'off' | 'fun_facts'
    factCategories: ['all'],
  };

  function normalizeReplacementMode(mode) {
    return mode === 'fun_facts' ? 'fun_facts' : 'off';
  }

  const FACT_CATEGORIES = ['science', 'space', 'animals', 'history', 'math', 'technology', 'earth'];
  const MAX_VIDEO_SAMPLE_ATTEMPTS = 4;
  const MAX_VIDEO_PROBE_TICKS = 5;
  function normalizeFactCategories(categories) {
    if (!Array.isArray(categories) || categories.length === 0) return ['all'];
    const cleaned = categories
      .map(c => String(c || '').trim().toLowerCase())
      .filter(c => c === 'all' || FACT_CATEGORIES.includes(c));
    if (cleaned.length === 0) return ['all'];
    if (cleaned.includes('all')) return ['all'];
    return Array.from(new Set(cleaned));
  }

  function currentSiteKey() {
    if (/^(twitter|x)\.com$/.test(location.hostname)) return 'twitter';
    if (/(^|\.)linkedin\.com$/.test(location.hostname)) return 'linkedin';
    return null;
  }

  function isCurrentSiteEnabled() {
    const key = currentSiteKey();
    if (!key) return false;
    return settings.siteModes?.[key] !== false;
  }

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

  // LinkedIn: primary selector targets stable data-urn / data-id attributes set by LinkedIn's
  // own infrastructure. These survive class-name obfuscation across deploys.
  // Class names (.feed-shared-update-v2 etc.) are kept as fallbacks but are secondary.
  const LINKEDIN_POST_SELECTOR = [
    '[data-urn*="urn:li:activity"]',      // most common: feed post containers
    '[data-urn*="urn:li:aggregate"]',     // aggregated / reshared posts
    '[data-id^="urn:li:activity"]',        // alternate attribute form
    '[data-id*="urn:li:activity"]',
    '[data-activity-urn]',
    '.feed-shared-update-v2',              // legacy class fallback
    '.occludable-update',
  ].join(',');

  // LinkedIn text: class-based best-effort. Used only for text extraction priority,
  // NOT for filtering which posts to scan.
  const LINKEDIN_TEXT_SELECTOR = [
    '[class*="update-components-text"]',
    '[class*="feed-shared-inline-show-more-text"]',
    '[class*="commentary"]',
    '.break-words',
    'span[dir="ltr"]',
  ].join(',');

  // What we ask the DOM to give us: the POST CONTAINERS (like Twitter's tweet card).
  // We scan the container, extract text from within it — same model as Twitter.
  const LINKEDIN_FEED_SCAN_SELECTOR = LINKEDIN_POST_SELECTOR;

  function activeCandidateSelector() {
    if (/^(twitter|x)\.com$/.test(location.hostname)) {
      return '[data-testid="tweetText"],[data-testid="tweet"]';
    }
    if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
      return LINKEDIN_FEED_SCAN_SELECTOR;
    }
    return CANDIDATE_SELECTOR;
  }

  const LINKEDIN_SKIP_SELECTOR = [
    'header',
    'nav',
    'aside',
    '.global-nav',
    '.global-nav__content',
    '.global-footer',
    '.scaffold-layout__header',
    '.scaffold-layout__aside',
    '.scaffold-layout-toolbar',
    '.feed-identity-module',
    '.ad-banner-container',
    '.msg-overlay-list-bubble',
  ].join(',');

  const AI_MEDIA_RE = /\b(ai[- ]?(generated|image|art|modified|enhanced|edited)|generated\s+with|edited\s+with|enhanced\s+with|synthetic\s+media|deepfake|midjourney|dall[- ]?e|stable\s+diffusion|grok|sora|ideogram|runway|firefly|flux|faceswap|face\s*swap)\b/i;
  const AI_MODEL_TOKEN_RE = /\b(midjourney|dall[- ]?e|stable\s+diffusion|sdxl|flux|grok|sora|ideogram|runway|firefly|kling|gen[- ]?ai|deepfake)\b/gi;
  const AI_PROMPT_TOKEN_RE = /\b(prompt|negative\s+prompt|cfg|seed|sampler|steps|stylize|ar|aspect\s+ratio)\b|--(ar|v|stylize|seed)\b/gi;
  const AI_WATERMARK_RE = /\b(midjourney|dall[- ]?e|stable\s*diffusion|sdxl|grok|ideogram|runway|firefly|flux|faceswap)\b/i;

  /** Returns true if this element lives inside a skip zone on Twitter. */
  function inSkipZone(el) {
    if (/^(twitter|x)\.com$/.test(location.hostname)) {
      return Boolean(el.closest(TWITTER_SKIP_SELECTOR));
    }
    if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
      return Boolean(el.closest(LINKEDIN_SKIP_SELECTOR));
    }
    return false;
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
    '.feed-shared-update-v2',
    '.occludable-update',
    '[data-id^="urn:li:activity"]',
    '[data-urn*="urn:li:activity"]',
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
    '.msg-s-message-list__event',
    '.msg-s-event-listitem',
    '.msg-s-event-listitem__body',
    '.comments-comment-item',
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
   * For LinkedIn: prefer extracting from inner text containers to avoid metadata noise.
   *
   * For everything else: clone, strip noise elements, collapse whitespace.
   */
  function extractText(el) {
    if (el.dataset?.testid === 'tweetText') {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);
    if (isLinkedIn) {
      // Mirror Twitter: we receive the POST CONTAINER. Extract text from the
      // best text-bearing child, stripping chrome (reactions, timestamps, author metadata).
      const clone = el.cloneNode(true);
      // Strip non-content chrome
      clone.querySelectorAll(
        'script, style, noscript, iframe, button, svg, img, video,' +
        '[class*="social-action"], [class*="reactions"], [class*="social-count"],' +
        '[class*="actor"], [class*="attribution"], [class*="timestamp"],' +
        'time, [aria-label*="Like"], [aria-label*="Comment"], [aria-label*="Repost"], [aria-label*="Send"]'
      ).forEach(n => n.remove());
      // Try to find the narrowest text element first
      const textEl = clone.querySelector(LINKEDIN_TEXT_SELECTOR);
      if (textEl) {
        return (textEl.textContent || '').replace(/\s+/g, ' ').trim();
      }
      // Fall back to cleaned container text
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
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
    const isTwitter = /^(twitter|x)\.com$/.test(location.hostname);
    const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);

    if (el.dataset?.testid === 'tweetText') {
      // Always act on the nearest tweet card, never on broad page containers.
      const card = el.closest('[data-testid="tweet"]') || null;
      if (!card) return null;
      processed.add(card); // prevent double-scan via generic article selector
      return card;
    }

    // On Twitter/X, never act on generic containers like main/section/list.
    if (isTwitter) {
      if (el.dataset?.testid === 'tweet') return el;
      return el.closest('[data-testid="tweet"]') || null;
    }

    if (isLinkedIn) {
      // We scan the POST CONTAINER directly (same as Twitter scanning the tweet card).
      // The element itself IS the action target. But if we were handed a child element,
      // walk up to the nearest post container.
      if (el.matches(LINKEDIN_POST_SELECTOR)) return el;
      const container = el.closest(LINKEDIN_POST_SELECTOR);
      if (container) return container;
      // Last resort: walk up looking for any element with an activity URN attribute
      let node = el.parentElement;
      while (node && node !== document.body) {
        const urn = node.getAttribute('data-urn') || node.getAttribute('data-id') || node.getAttribute('data-activity-urn');
        if (urn && (urn.includes('activity') || urn.includes('urn:li:'))) return node;
        if (node.matches('main,[role="main"],.scaffold-finite-scroll__content')) break;
        node = node.parentElement;
      }
      return null;
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
    const undo = e.target.closest('[data-sf-undo]');
    if (undo) {
      e.stopPropagation();
      e.preventDefault();
      const id = undo.getAttribute('data-sf-undo');
      const entry = placeholderRestore.get(id);
      const ph = document.querySelector(`.sf-placeholder[data-sf-id="${id}"]`);
      if (entry?.original && ph && ph.isConnected) {
        ph.replaceWith(entry.original);
        placeholderRestore.delete(id);
        removedCount = Math.max(0, removedCount - 1);
        chrome.runtime.sendMessage({ type: 'STATS_UPDATE', removedCount }).catch(() => {});
      }
      return;
    }

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

  function upsertDebugEvalBadge(el, result) {
    if (!settings.debugHighlight) return;

    const score = typeof result.score === 'number' ? result.score.toFixed(3) : '0.000';
    const topCategory = result.category || result.topCategory || 'none';
    const s = result.scores || { slop: 0, ai: 0, rage: 0, misinfo: 0 };

    let badge = el.querySelector('.sf-eval-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'sf-eval-badge';
      el.appendChild(badge);
    }
    badge.textContent = `${topCategory} ${score} | s:${s.slop} a:${s.ai} r:${s.rage} m:${s.misinfo}`;

    if (getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
  }

  function clearActionState(el) {
    if (!el) return;
    el.removeAttribute('data-slopfilter');
    el.removeAttribute('data-slopfilter-score');
    el.removeAttribute('data-slopfilter-fc-id');
    el.classList.remove(
      'slopfilter-flagged',
      'slopfilter-slop',
      'slopfilter-ai',
      'slopfilter-rage',
      'slopfilter-misinfo',
      'slopfilter-fc-pending',
      'slopfilter-fc-revealed'
    );
    el.querySelectorAll('.sf-fc-badge').forEach(b => b.remove());
    if (!settings.debugHighlight) {
      el.querySelectorAll('.sf-eval-badge').forEach(b => b.remove());
    }
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function mediaAttrScore(el) {
    let score = 0;
    const hits = [];

    const fields = [
      el.getAttribute('alt'),
      el.getAttribute('title'),
      el.getAttribute('aria-label'),
      el.getAttribute('src'),
      el.getAttribute('currentSrc'),
      el.getAttribute('poster'),
    ]
      .filter(Boolean)
      .join(' ');

    if (!fields) return { score: 0, hits };

    if (AI_MEDIA_RE.test(fields)) {
      score += 0.85;
      hits.push('[ai] media marker');
    }

    if (/(generated[-_ ]?by|ai[-_ ]?art|ai[-_ ]?generated|midjourney|dall[-_ ]?e|stable[-_ ]?diffusion|faceswap|deepfake)/i.test(fields)) {
      score += 0.25;
      hits.push('[ai] source watermark');
    }

    const hintMatches = (fields.match(/\b(ai|generated|synthetic|midjourney|dall|grok|sora|diffusion|deepfake)\b/gi) || []).length;
    if (hintMatches >= 2) {
      score += 0.2;
      hits.push('[ai] media hints');
    }

    return { score: clamp01(score), hits };
  }

  function mediaContextScore(target, el) {
    let score = 0;
    const hits = [];

    const nearby = [
      target.getAttribute('aria-label'),
      target.getAttribute('title'),
      el.closest('figure,article,section,div')?.textContent,
      target.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 1800);

    if (!nearby) return { score: 0, hits };

    if (AI_MEDIA_RE.test(nearby)) {
      score += 0.5;
      hits.push('[ai] context marker');
    }

    const modelMatches = (nearby.match(AI_MODEL_TOKEN_RE) || []).length;
    if (modelMatches >= 1) {
      score += 0.2;
      hits.push('[ai] model token');
    }
    if (modelMatches >= 2) {
      score += 0.15;
      hits.push('[ai] multi-model token');
    }

    if (AI_WATERMARK_RE.test(nearby) && /\b(edited|enhanced|upscaled|restored|faceswap|remixed)\b/i.test(nearby)) {
      score += 0.25;
      hits.push('[ai] modified media');
    }

    const promptMatches = (nearby.match(AI_PROMPT_TOKEN_RE) || []).length;
    if (promptMatches >= 2) {
      score += 0.25;
      hits.push('[ai] prompt syntax');
    }

    return { score: clamp01(score), hits };
  }

  function pixelStyleScore(drawable) {
    try {
      const w = 64;
      const h = 64;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { score: 0, hits: [] };
      ctx.drawImage(drawable, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);

      let satSum = 0;
      let edgeSum = 0;
      let clipped = 0;
      const bins = new Set();
      let blockBoundaryDiff = 0;
      let nonBoundaryDiff = 0;
      let boundaryCount = 0;
      let nonBoundaryCount = 0;
      let rgNum = 0;
      let rbNum = 0;
      let gNum = 0;
      let rNum = 0;
      let bNum = 0;
      let ggNum = 0;
      let rrNum = 0;
      let bbNum = 0;
      let count = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          satSum += sat;
          if (r <= 2 || r >= 253 || g <= 2 || g >= 253 || b <= 2 || b >= 253) clipped++;

          rgNum += r * g;
          rbNum += r * b;
          rNum += r;
          gNum += g;
          bNum += b;
          rrNum += r * r;
          ggNum += g * g;
          bbNum += b * b;

          if (x > 0) {
            const j = (y * w + (x - 1)) * 4;
            const diff = Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
            edgeSum += diff;
            if (x % 8 === 0) {
              blockBoundaryDiff += diff;
              boundaryCount++;
            } else {
              nonBoundaryDiff += diff;
              nonBoundaryCount++;
            }
          }
          // 4-bit quantized colour bins (4096 max) as a crude palette-complexity proxy.
          bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
          count++;
        }
      }
      const satMean = satSum / Math.max(1, count);
      const edgeMean = edgeSum / Math.max(1, count);
      const paletteComplexity = bins.size;
      const clippedRatio = clipped / Math.max(1, count);
      const boundaryMean = blockBoundaryDiff / Math.max(1, boundaryCount);
      const nonBoundaryMean = nonBoundaryDiff / Math.max(1, nonBoundaryCount);
      const blockiness = boundaryMean > 0 ? Math.max(0, (boundaryMean - nonBoundaryMean) / boundaryMean) : 0;
      const rgCorr = (rgNum - (rNum * gNum / count)) /
        Math.sqrt(Math.max(1e-6, (rrNum - (rNum * rNum / count)) * (ggNum - (gNum * gNum / count))));
      const rbCorr = (rbNum - (rNum * bNum / count)) /
        Math.sqrt(Math.max(1e-6, (rrNum - (rNum * rNum / count)) * (bbNum - (bNum * bNum / count))));
      const channelCorr = Math.max(rgCorr, rbCorr);

      let score = 0;
      const hits = [];
      // Very conservative visual heuristic; only a small boost.
      if (satMean > 0.48 && edgeMean > 48) {
        score += 0.18;
        hits.push('[ai] stylized frame');
      }
      if (paletteComplexity < 190 && edgeMean > 36) {
        score += 0.14;
        hits.push('[ai] quantized palette');
      }
      if (blockiness > 0.22) {
        score += 0.2;
        hits.push('[ai] compression-like blockiness');
      }
      if (clippedRatio > 0.24 && satMean > 0.35) {
        score += 0.12;
        hits.push('[ai] clipped color channels');
      }
      if (channelCorr > 0.97 && edgeMean > 34) {
        score += 0.16;
        hits.push('[ai] high channel correlation');
      }

      // Fast probabilistic blending from pixel features.
      const z =
        (satMean - 0.44) * 2.8 +
        (edgeMean - 42) * 0.025 +
        (0.22 - Math.min(0.22, paletteComplexity / 1000)) * 2.2 +
        blockiness * 2.4 +
        clippedRatio * 1.6 +
        Math.max(0, channelCorr - 0.94) * 6.5 -
        1.95;
      const p = 1 / (1 + Math.exp(-z));
      if (p >= 0.72) {
        score += Math.min(0.26, (p - 0.72) * 0.55);
        hits.push(`[ai] pixel-prob:${p.toFixed(2)}`);
      }

      return { score: clamp01(score), hits };
    } catch {
      return { score: 0, hits: [] };
    }
  }

  function aiMediaResult(score, hits) {
    return {
      flagged: score >= 0.78,
      needsFactCheck: false,
      score: parseFloat(score.toFixed(3)),
      category: score >= 0.78 ? 'ai' : null,
      topCategory: 'ai',
      scores: { slop: 0, ai: parseFloat(score.toFixed(3)), rage: 0, misinfo: 0 },
      hits,
    };
  }

  function evaluateMediaSync(target) {
    let best = { score: 0, hits: [] };

    target.querySelectorAll('img,video').forEach((el) => {
      const attr = mediaAttrScore(el);
      const ctx = mediaContextScore(target, el);
      let pixel = { score: 0, hits: [] };
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 32 && el.naturalHeight > 32) {
        pixel = pixelStyleScore(el);
      }
      const score = clamp01(attr.score + ctx.score + pixel.score);
      if (score > best.score) best = { score, hits: [...attr.hits, ...ctx.hits, ...pixel.hits] };
    });

    return aiMediaResult(best.score, best.hits);
  }

  function mediaState(el) {
    const current = mediaScanState.get(el) || { attempts: 0, done: false };
    mediaScanState.set(el, current);
    return current;
  }

  function evaluateVideoFirstFrame(target, video) {
    const state = mediaState(video);
    if (state.done || state.attempts >= MAX_VIDEO_SAMPLE_ATTEMPTS) return;
    state.attempts += 1;

    const samples = [];
    const sample = (tag) => {
      const attr = mediaAttrScore(video);
      const ctx = mediaContextScore(target, video);
      const pixel = pixelStyleScore(video);
      const score = clamp01(attr.score + ctx.score + pixel.score);
      samples.push({ score, hits: [...attr.hits, ...ctx.hits, ...pixel.hits, tag] });
    };

    const finalize = () => {
      if (!target.isConnected) return;
      const best = samples.reduce((a, b) => (b.score > a.score ? b : a), { score: 0, hits: [] });
      const result = aiMediaResult(best.score, best.hits);
      if (result.flagged) {
        state.done = true;
        clearActionState(target);
        upsertDebugEvalBadge(target, result);
        processResult(target, result);
        return;
      }
      // Retry later when more frames/metadata become available.
      if (state.attempts < MAX_VIDEO_SAMPLE_ATTEMPTS) {
        setTimeout(() => evaluateVideoFirstFrame(target, video), 1200);
      }
    };

    const sampleCurrent = () => sample('[ai] video-frame');

    const analyzeNow = () => {
      sampleCurrent();

      // If paused, try a deterministic first-frame sample too.
      if (video.paused && Number.isFinite(video.duration) && video.duration > 0.1 && video.currentTime > 0.1) {
        const originalTime = video.currentTime;
        const onSeeked = () => {
          sample('[ai] video-first-frame');
          try { video.currentTime = originalTime; } catch {}
          finalize();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        try {
          video.currentTime = 0;
          setTimeout(finalize, 800);
          return;
        } catch {
          // fallback to current-frame only
        }
      }

      // If playing, sample one more near-term frame if supported.
      if (!video.paused && typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => {
          sample('[ai] video-next-frame');
          finalize();
        });
        return;
      }

      finalize();
    };

    if (video.readyState >= 2) analyzeNow();
    else video.addEventListener('loadeddata', analyzeNow, { once: true });
  }

  function scheduleVideoProbes(target) {
    const st = mediaProbeState.get(target);
    if (st?.active) return;
    mediaProbeState.set(target, { active: true, remaining: MAX_VIDEO_PROBE_TICKS });

    const tick = () => {
      const cur = mediaProbeState.get(target);
      if (!cur || !target.isConnected || cur.remaining <= 0) {
        mediaProbeState.delete(target);
        return;
      }
      cur.remaining -= 1;
      target.querySelectorAll('video').forEach(v => evaluateVideoFirstFrame(target, v));
      setTimeout(tick, 900);
    };
    setTimeout(tick, 120);
  }

  // ─── REPLACEMENT FACTS DATABASE ──────────────────────────────────────────────
  const FALLBACK_FACTS = {
    science: [
      "Honey never spoils; archaeologists found edible honey in ancient tombs.",
      "The human brain uses around 20% of the body's energy.",
      "Water can boil and freeze at the same time at the triple point.",
      "Tardigrades can survive vacuum, radiation, and extreme temperatures.",
    ],
    space: [
      "Light from the Sun takes about 8 minutes to reach Earth.",
      "A day on Venus is longer than a Venus year.",
      "The ISS circles Earth roughly every 90 minutes.",
      "One million Earths could fit inside the Sun.",
    ],
    animals: [
      "Octopuses have three hearts and can edit their own RNA.",
      "Sea otters hold hands while sleeping so they do not drift apart.",
      "Butterflies taste with their feet.",
      "A group of owls is called a parliament.",
    ],
    history: [
      "Cleopatra lived closer to the Moon landing than to the Great Pyramid era.",
      "Oxford University predates the Aztec Empire.",
      "Nintendo started in 1889 as a playing-card company.",
      "The shortest recorded war lasted about 40 minutes.",
    ],
    math: [
      "If you shuffle a deck of cards, that exact order is likely brand new.",
      "In a group of 23 people, two sharing a birthday is more likely than not.",
      "A Mobius strip has one side and one edge.",
      "1729 is the smallest number expressible as two sums of two cubes.",
    ],
    technology: [
      "The first computer bug was a real moth found in a relay.",
      "The Apollo Guidance Computer had less memory than a modern calculator.",
      "The first 1 GB hard drive weighed over 500 pounds.",
      "Email predates the World Wide Web by about two decades.",
    ],
    earth: [
      "Earth's tectonic plates move about as fast as fingernails grow.",
      "More freshwater is locked in glaciers than in all rivers and lakes combined.",
      "The Amazon rainforest helps generate much of its own rainfall.",
      "The deepest ocean trench is deeper than Mount Everest is tall.",
    ],
  };

  let factBank = { ...FALLBACK_FACTS };
  let factPool = [];
  let factIndex = 0;

  function rebuildFactPool() {
    const selected = normalizeFactCategories(settings.factCategories);
    if (selected.includes('all')) {
      factPool = Object.values(factBank).flat();
      return;
    }
    factPool = selected.flatMap(c => factBank[c] || []);
    if (factPool.length === 0) factPool = Object.values(factBank).flat();
  }

  async function loadFactBank() {
    try {
      const url = chrome.runtime.getURL('content/facts.json');
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object') return;
      const next = {};
      for (const c of FACT_CATEGORIES) {
        if (Array.isArray(data[c])) {
          next[c] = data[c].map(v => String(v || '').trim()).filter(Boolean);
        }
      }
      if (Object.values(next).some(arr => arr.length > 0)) {
        factBank = { ...FALLBACK_FACTS, ...next };
        rebuildFactPool();
      }
    } catch {
      // keep fallback facts
    }
  }

  function getNextFact() {
    if (factPool.length === 0) rebuildFactPool();
    const fact = factPool[factIndex % Math.max(1, factPool.length)];
    factIndex++;
    return fact || 'Did you know? Curiosity compounds faster than certainty.';
  }

  /**
   * Replace a removed element with a fun-fact placeholder card.
   * The placeholder has the same block-level footprint so feed layout is preserved.
   */
  function injectPlaceholder(el, result) {
    if (settings.replacementMode !== 'fun_facts') { el.remove(); return; }

    const fact = getNextFact() || '…';
    const placeholderId = `sf_ph_${++placeholderIdCounter}`;
    placeholderRestore.set(placeholderId, { original: el, ts: Date.now() });

    const ph = document.createElement('div');
    ph.className = 'sf-placeholder';
    ph.setAttribute('data-sf-id', placeholderId);
    ph.setAttribute('data-sf-filter-category', result.category || 'unknown');
    ph.innerHTML =
      `<div class="sf-ph-header">` +
        `<span class="sf-ph-icon">✨</span>` +
        `<span class="sf-ph-label">fun fact</span>` +
        `<span class="sf-ph-tag">filtered by SlopFilter <button class="sf-ph-undo" data-sf-undo="${placeholderId}" type="button">undo</button></span>` +
      `</div>` +
      `<p class="sf-ph-fact">${fact}</p>`;

    el.replaceWith(ph);
  }

  function processResult(el, result) {
    if (!el) return;
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
      // Production: replace with fun-fact placeholder (or just remove if mode is 'off')
      injectPlaceholder(el, result);
    }

    removedCount++;
    chrome.runtime.sendMessage({ type: 'STATS_UPDATE', removedCount }).catch(() => {});
  }

  // ─── CORE SCAN FUNCTION ───────────────────────────────────────────────────────

  function scanElement(el) {
    if (!settings.enabled || !isCurrentSiteEnabled()) return;

    // Skip invisible or already-removed elements
    if (!el.isConnected) return;
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return;

    const isTwitter = /^(twitter|x)\.com$/.test(location.hostname);
    const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);
    if (isTwitter) {
      const testId = el.dataset?.testid;
      const isTweetText = testId === 'tweetText';
      const isTweetCard = testId === 'tweet';

      // Restrict Twitter scanning to tweet text/cards only.
      if (!isTweetText && !isTweetCard) {
        processed.add(el);
        return;
      }

      // If a tweet card has a dedicated tweetText node, let that node drive
      // scoring so we don't score the entire card chrome (buttons/metadata).
      if (isTweetCard && el.querySelector('[data-testid="tweetText"]')) {
        processed.add(el);
        return;
      }
    }

    if (isLinkedIn) {
      // Mirror Twitter: we only accept the POST CONTAINER (identified by stable
      // data attributes). Anything that isn't itself a post container is skipped.
      // actionTarget() handles the rare case where a child was enqueued.
      if (inSkipZone(el)) { processed.add(el); return; }
      const isPostContainer = el.matches(LINKEDIN_POST_SELECTOR);
      if (!isPostContainer) { processed.add(el); return; }
    }

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

    const previousText = lastScannedText.get(el);
    if (previousText === text) return;
    lastScannedText.set(el, text);

    // Commit: element has real content, mark it to prevent re-scanning.
    processed.add(el);

    const target = actionTarget(el);
    if (!target) return;

    // debugScanAll: outline every element the scanner touches, even if not
    // flagged. Useful for verifying the selector is hitting real tweet cards.
    if (settings.debugScanAll) {
      target.setAttribute('data-slopfilter-scanned', 'true');
    }

    // In debug mode, score everything non-empty so newly loaded posts always
    // show a classification badge. In production, keep normal thresholds.
    const effectiveMinLength = settings.debugHighlight
      ? 1
      : (el.dataset?.testid === 'tweetText'
          ? Math.min(settings.minTextLength, 20)
          : (isLinkedIn ? Math.min(settings.minTextLength, 24) : settings.minTextLength));
    const hasMedia = Boolean(target.querySelector('img,video'));
    if (text.length < effectiveMinLength) {
      if (settings.modes.ai && hasMedia && target.isConnected) {
        const mediaResult = evaluateMediaSync(target);
        if (mediaResult.flagged) {
          clearActionState(target);
          upsertDebugEvalBadge(target, mediaResult);
          processResult(target, mediaResult);
        } else {
          scheduleVideoProbes(target);
        }
      }
      return;
    }

    const result = window.SlopDetector.detect(text, settings.modes);
    clearActionState(target);
    upsertDebugEvalBadge(target, result);
    processResult(target, result);

    if (settings.modes.ai && target.isConnected) {
      const mediaResult = evaluateMediaSync(target);
      if (mediaResult.flagged) {
        clearActionState(target);
        upsertDebugEvalBadge(target, mediaResult);
        processResult(target, mediaResult);
      } else {
        target.querySelectorAll('video').forEach(v => evaluateVideoFirstFrame(target, v));
        scheduleVideoProbes(target);
      }
    }
  }

  // ─── BATCH SCAN (main-thread friendly using requestIdleCallback) ───────────────

  let pendingQueue = [];
  let idleScheduled = false;

  function flushQueue(deadline) {
    while (pendingQueue.length > 0) {
      // Yield to browser if we're running low on idle time
      if (deadline && deadline.timeRemaining() < 2) {
        // Prevent scheduler deadlock: scheduleFlush() is a no-op while
        // idleScheduled is true, so clear first before re-scheduling.
        idleScheduled = false;
        scheduleFlush(); // re-schedule remaining work
        return;
      }
      const next = pendingQueue.shift();
      queued.delete(next);
      const t0 = settings.debugScanAll ? performance.now() : 0;
      scanElement(next);
      if (settings.debugScanAll) {
        const dt = performance.now() - t0;
        if (dt > 12) console.debug('[SlopFilter] slow-scan', dt.toFixed(1), next?.tagName || 'node');
      }
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
    if (queued.has(el)) return;
    if (pendingQueue.length > 2500) {
      pendingQueue.shift();
    }
    queued.add(el);
    pendingQueue.push(el);
    scheduleFlush();
  }

  // ─── INITIAL SCAN ─────────────────────────────────────────────────────────────

  function initialScan() {
    const candidates = document.querySelectorAll(activeCandidateSelector());
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
    root.querySelectorAll(activeCandidateSelector()).forEach(el => {
      if (!inSkipZone(el)) {
        intersectionObserver.observe(el);
      }
    });
  }

  // ─── MUTATION OBSERVER: dynamic content (SPAs, infinite scroll) ───────────────

  // Debounce helper — avoids thrashing on rapid re-renders (React, Vue, etc.)
  let mutationTimer = null;
  const MUTATION_DEBOUNCE_MS = 120;

  const mutationObserver = new MutationObserver((mutations) => {
    if (!settings.enabled || document.visibilityState !== 'visible') return;

    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (!settings.enabled || document.visibilityState !== 'visible') return;
      const selector = activeCandidateSelector();
      let addedBudget = 1200;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const parent = mutation.target?.parentElement;
          if (!parent) continue;
          const candidate = parent.closest(selector);
          if (candidate) enqueue(candidate);
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Scan node itself if it matches
          if (node.matches && node.matches(selector)) {
            if (!inSkipZone(node)) enqueue(node);
            addedBudget--;
            if (addedBudget <= 0) break;
          }

          // Directly enqueue all matching descendants.
          // Previously this called observeNewElements() which only wraps
          // elements in IntersectionObserver — IO only fires on a
          // non→intersecting TRANSITION, so elements added while already
          // visible (Twitter's virtual scroll injects nodes that are
          // immediately in the viewport) are silently skipped forever.
          // Direct enqueue catches them on the next idle tick.
          node.querySelectorAll(selector).forEach(el => {
            if (!inSkipZone(el)) enqueue(el);
            addedBudget--;
          });
          if (addedBudget <= 0) break;
        }
        if (addedBudget <= 0) break;
      }
    }, MUTATION_DEBOUNCE_MS);
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // ─── SCROLL LISTENER: scan viewport on user scroll ───────────────────────────
  // Belt-and-suspenders for content that was already in the DOM when first
  // observed (IO miss) or that slipped past the mutation debounce window.
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!settings.enabled || document.visibilityState !== 'visible') return;
      const selector = activeCandidateSelector();
      const vhLow  = -600;
      const vhHigh = window.innerHeight + 600;
      document.querySelectorAll(selector).forEach(el => {
        if (inSkipZone(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom >= vhLow && rect.top <= vhHigh) enqueue(el);
      });
    }, 100);
  }, { passive: true });

  const AUTO_SWEEP_MS = 7000;
  let autoSweepTimer = null;

  function startAutoSweep() {
    if (autoSweepTimer) return;
    autoSweepTimer = setInterval(() => {
      if (!settings.enabled || document.visibilityState !== 'visible') return;
      document.querySelectorAll(activeCandidateSelector()).forEach(enqueue);
    }, AUTO_SWEEP_MS);
  }

  function enqueueVisibleFeedCandidates() {
    if (!settings.enabled || document.visibilityState !== 'visible') return;
    const selector = activeCandidateSelector();
    const vhLow = -1000;
    const vhHigh = window.innerHeight + 1000;
    document.querySelectorAll(selector).forEach(el => {
      if (inSkipZone(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= vhLow && rect.top <= vhHigh) enqueue(el);
    });
  }

  // MAIN-world interceptor emits this after every matched feed JSON response.
  // Use staggered retries to catch framework hydration that lands a bit later.
  window.addEventListener('slopfilter:feed-seen', () => {
    enqueueVisibleFeedCandidates();
    setTimeout(enqueueVisibleFeedCandidates, 120);
    setTimeout(enqueueVisibleFeedCandidates, 450);
  });

  // ─── MESSAGES FROM POPUP / BACKGROUND ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'GET_STATS':
        sendResponse({ removedCount });
        break;

      case 'UPDATE_SETTINGS':
        settings = { ...settings, ...msg.settings };
        settings.siteModes = { twitter: true, linkedin: true, ...(settings.siteModes || {}) };
        settings.replacementMode = normalizeReplacementMode(settings.replacementMode);
        settings.factCategories = normalizeFactCategories(settings.factCategories);
        rebuildFactPool();
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
          el.querySelectorAll('.sf-eval-badge').forEach(b => b.remove());
          el.querySelectorAll('.sf-fc-badge').forEach(b => b.remove());
        });

        // Reassign WeakSet — all previously-processed elements are now eligible
        // to be scanned again.  (WeakSet has no .clear(); reassignment is the
        // only correct approach.  The old set is GC'd naturally.)
        processed = new WeakSet();
        lastScannedText = new WeakMap();
        queued = new WeakSet();
        mediaScanState = new WeakMap();
        factIndex = 0;
        rebuildFactPool();

        pendingQueue.length = 0;    // drop any in-flight queue
        removedCount = 0;
        placeholderRestore.clear();

        // Re-enqueue synchronously, then flush immediately (don't wait for idle)
        const selector = activeCandidateSelector();
        document.querySelectorAll(selector).forEach(el => {
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
      detail: {
        enabled: settings.enabled,
        debugHighlight: settings.debugHighlight,
        modes: settings.modes,
        siteModes: settings.siteModes,
        replacementMode: settings.replacementMode,
      },
    }));
  }
  // ─── SETTINGS LOAD & BOOT ─────────────────────────────────────────────────────

  chrome.storage.sync.get(
    { enabled: true, modes: { slop: true, ai: true, rage: true, misinfo: true }, siteModes: { twitter: true, linkedin: true }, debugHighlight: false, debugScanAll: false, replacementMode: 'off', factCategories: ['all'] },
    (stored) => {
      settings = { ...settings, ...stored };
      settings.siteModes = { twitter: true, linkedin: true, ...(stored.siteModes || {}) };
      settings.replacementMode = normalizeReplacementMode(stored.replacementMode);
      settings.factCategories = normalizeFactCategories(stored.factCategories);
      rebuildFactPool();
      loadFactBank();
      if (settings.enabled) {
        // Immediately observe all current candidates for intersection
        observeNewElements(document);
        // Also eagerly scan the above-fold content without waiting for scroll
        initialScan();
      }
      startAutoSweep();
      // Always relay enabled state to MAIN-world interceptor
      syncSettingsToInterceptor();
    }
  );

})();
