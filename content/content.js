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
  /** Last extracted text per scanned node; allows re-scan when virtualized nodes get new content. */
  let lastScannedText = new WeakMap();
  /** Prevent duplicate queue entries for the same element. */
  let queued = new WeakSet();
  /** Avoid re-processing the same media elements repeatedly. */
  let seenMedia = new WeakSet();

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
    replacementMode: 'off',  // 'off' | 'fun_facts'
  };

  function normalizeReplacementMode(mode) {
    return mode === 'fun_facts' ? 'fun_facts' : 'off';
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

  const LINKEDIN_POST_SELECTOR = [
    '.feed-shared-update-v2',
    '.occludable-update',
    '[data-id^="urn:li:activity"]',
    '[data-urn*="urn:li:activity"]',
    '[data-view-name*="feed-update"]',
  ].join(',');

  const LINKEDIN_TEXT_SELECTOR = [
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
    '.break-words',
  ].join(',');

  const AI_MEDIA_RE = /\b(ai[- ]?(generated|image|art)|generated\s+with|synthetic\s+media|deepfake|midjourney|dall[- ]?e|stable\s+diffusion|grok|sora|ideogram|runway|firefly|flux)\b/i;

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
    '.feed-shared-update-v2',
    '.occludable-update',
    '[data-id^="urn:li:activity"]',
    '[data-urn*="urn:li:activity"]',
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
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
      return el.closest(LINKEDIN_POST_SELECTOR) || null;
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

    const hintMatches = (fields.match(/\b(ai|generated|synthetic|midjourney|dall|grok|sora|diffusion|deepfake)\b/gi) || []).length;
    if (hintMatches >= 2) {
      score += 0.2;
      hits.push('[ai] media hints');
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
      let count = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          satSum += sat;
          if (x > 0) {
            const j = (y * w + (x - 1)) * 4;
            edgeSum += Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
          }
          count++;
        }
      }
      const satMean = satSum / Math.max(1, count);
      const edgeMean = edgeSum / Math.max(1, count);

      let score = 0;
      const hits = [];
      // Very conservative visual heuristic; only a small boost.
      if (satMean > 0.48 && edgeMean > 48) {
        score += 0.18;
        hits.push('[ai] stylized frame');
      }
      return { score: clamp01(score), hits };
    } catch {
      return { score: 0, hits: [] };
    }
  }

  function aiMediaResult(score, hits) {
    return {
      flagged: score >= 0.8,
      needsFactCheck: false,
      score: parseFloat(score.toFixed(3)),
      category: score >= 0.8 ? 'ai' : null,
      topCategory: 'ai',
      scores: { slop: 0, ai: parseFloat(score.toFixed(3)), rage: 0, misinfo: 0 },
      hits,
    };
  }

  function evaluateMediaSync(target) {
    let best = { score: 0, hits: [] };

    target.querySelectorAll('img,video').forEach((el) => {
      const attr = mediaAttrScore(el);
      let pixel = { score: 0, hits: [] };
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 32 && el.naturalHeight > 32) {
        pixel = pixelStyleScore(el);
      }
      const score = clamp01(attr.score + pixel.score);
      if (score > best.score) best = { score, hits: [...attr.hits, ...pixel.hits] };
    });

    return aiMediaResult(best.score, best.hits);
  }

  function evaluateVideoFirstFrame(target, video) {
    if (seenMedia.has(video)) return;
    seenMedia.add(video);

    const run = () => {
      if (!target.isConnected) return;
      const attr = mediaAttrScore(video);
      const pixel = pixelStyleScore(video);
      const score = clamp01(attr.score + pixel.score);
      const result = aiMediaResult(score, [...attr.hits, ...pixel.hits, '[ai] video-frame-check']);
      if (!result.flagged) return;
      clearActionState(target);
      upsertDebugEvalBadge(target, result);
      processResult(target, result);
    };

    const analyzeNow = () => {
      // Use first frame for paused videos when seek is safe; do not disrupt playback.
      if (video.paused && Number.isFinite(video.duration) && video.duration > 0.1 && video.currentTime > 0.1) {
        const onSeeked = () => run();
        video.addEventListener('seeked', onSeeked, { once: true });
        try { video.currentTime = 0; } catch { run(); }
        setTimeout(run, 700);
      } else {
        run();
      }
    };

    if (video.readyState >= 2) analyzeNow();
    else video.addEventListener('loadeddata', analyzeNow, { once: true });
  }

  // ─── REPLACEMENT FACTS DATABASE ──────────────────────────────────────────────

  const FUN_FACTS = [
      "A teaspoon of neutron star material weighs about 10 million tonnes.",
      "Honey never spoils. 3,000-year-old honey found in Egyptian tombs was still edible.",
      "The human brain uses ~20% of the body's energy despite being only 2% of its weight.",
      "Water can boil and freeze simultaneously — it's called the triple point.",
      "There are more possible chess games than atoms in the observable universe.",
      "Bananas are berries. Strawberries are not.",
      "Octopuses have three hearts, blue blood, and can edit their own RNA.",
      "Crows can recognise human faces and hold grudges across years.",
      "Tardigrades survive vacuum, radiation, and temperatures near absolute zero.",
      "Light takes 8 minutes from Sun to Earth — but ~100,000 years to escape the Sun's core.",
      "Glass is technically a supercooled liquid — old window panes are thicker at the bottom.",
      "A human sneeze travels at ~160 km/h and can project droplets up to 8 metres.",
      "The total length of DNA in one human body, if uncoiled, would reach the Sun and back 300 times.",
      "Mantis shrimps can see 16 colour channels. Humans see 3.",
      "There are more microbial cells in your body than human cells.",
      "There are more stars in the observable universe than grains of sand on all Earth's beaches.",
      "A day on Venus is longer than a year on Venus.",
      "Apollo astronaut footprints on the Moon will remain for at least 100 million years.",
      "Neutron stars can spin up to 700 times per second.",
      "The Milky Way and Andromeda galaxies will collide in about 4.5 billion years.",
      "Space is completely silent — there is no medium for sound waves.",
      "Saturn's rings span 282,000 km but are only ~10 metres thick on average.",
      "The Sun accounts for 99.86% of the mass of our entire solar system.",
      "Remove all atomic empty space from humans — all of humanity fits in a sugar cube.",
      "The James Webb Telescope is sensitive enough to detect the heat of a bumblebee on the Moon.",
      "Mars has the tallest volcano in the solar system: Olympus Mons, ~22 km high.",
      "Light from the most distant quasar takes 13 billion years to reach us.",
      "The ISS orbits Earth every 90 minutes at ~28,000 km/h.",
      "One million Earths could fit inside the Sun.",
      "Black holes don't 'suck' — objects must cross the event horizon to be captured.",
      "Elephants are the only animals known to have death rituals — they mourn their dead.",
      "A mantis shrimp punch clocks at 80 km/h — fast enough to boil water momentarily.",
      "Sea otters hold hands while sleeping so they don't drift apart.",
      "Dolphins have names for each other: unique signature whistles from birth.",
      "Pistol shrimps snap their claws faster than a bullet, creating a plasma shockwave.",
      "Sharks are older than trees — sharks 450 million years ago, trees ~350 million.",
      "Cuttlefish can change colour and pattern despite being completely colour-blind.",
      "A flock of starlings is a murmuration — each bird follows just three simple local rules.",
      "Goats have rectangular pupils giving them a near-360° field of vision.",
      "Butterflies taste with their feet.",
      "Sloths host entire ecosystems — algae, moths, and beetles — in their fur.",
      "An octopus's arms each have their own mini-brain and can act independently.",
      "Crows pass tests designed for seven-year-old children, including delayed gratification.",
      "A group of owls is called a parliament.",
      "Koko the gorilla learned over 1,000 signs in American Sign Language.",
      "The Great Fire of London (1666) only killed six people, but destroyed 13,200 houses.",
      "Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.",
      "Oxford University is older than the Aztec Empire.",
      "The shortest war in history lasted ~40 minutes: the Anglo-Zanzibar War of 1896.",
      "Napoleon was once attacked by a horde of rabbits.",
      "When the pyramids were built, woolly mammoths were still alive on Wrangel Island.",
      "Abraham Lincoln was a licensed wrestler — and nearly undefeated.",
      "The original Olympic Games lasted over 1,200 years before being abolished in 393 AD.",
      "Beethoven was almost entirely deaf when he composed his Ninth Symphony.",
      "Nintendo was founded in 1889 — as a playing-card company.",
      "The word 'salary' comes from the Latin 'salarium' — soldiers were sometimes paid in salt.",
      "In 1923, jockey Frank Hayes won a race despite dying of a heart attack mid-race.",
      "Ancient Romans used urine as mouthwash — the ammonia whitened teeth.",
      "Vikings used the mineral iolite as a polarising filter to navigate on overcast days.",
      "Hannibal crossed the Alps with 37 war elephants. Only one survived the journey.",
      "There are infinitely many infinities — and they're not all the same size.",
      "A Möbius strip has only one side and one edge.",
      "If you shuffle a deck of cards, the order has almost certainly never existed before.",
      "In a group of 23 people, there's a >50% chance two share a birthday (birthday paradox).",
      "e^(iπ) + 1 = 0 — five of maths' most fundamental constants in one equation.",
      "The number 1 is not considered prime — to preserve unique prime factorisation.",
      "Pi has been calculated to 105 trillion digits. No repeating pattern has been found.",
      "Benford's Law: ~30% of numbers in real-world data sets start with the digit 1.",
      "There exist true statements that are unprovable in any consistent formal system (Gödel).",
      "You cannot comb a hairy ball flat without a cowlick — the Hairy Ball Theorem.",
      "The Collatz conjecture is simple to state. No one has proven it in 87 years.",
      "The Monty Hall problem: you should always switch doors. Most people's instinct is wrong.",
      "1729 is the smallest number expressible as the sum of two cubes in two different ways.",
      "Every even number > 2 is the sum of two primes — probably. (Goldbach's Conjecture, unproven.)",
      "A 4-D sphere passing through 3-D space would appear as a point, grow into a sphere, then shrink back.",
  ];

  let factIndex = 0;

  function getNextFact() {
    const fact = FUN_FACTS[factIndex % FUN_FACTS.length];
    factIndex++;
    return fact;
  }

  /**
   * Replace a removed element with a fun-fact placeholder card.
   * The placeholder has the same block-level footprint so feed layout is preserved.
   */
  function injectPlaceholder(el, result) {
    if (settings.replacementMode !== 'fun_facts') { el.remove(); return; }

    const fact = getNextFact() || '…';

    const ph = document.createElement('div');
    ph.className = 'sf-placeholder';
    ph.setAttribute('data-sf-filter-category', result.category || 'unknown');
    ph.innerHTML =
      `<div class="sf-ph-header">` +
        `<span class="sf-ph-icon">✨</span>` +
        `<span class="sf-ph-label">fun fact</span>` +
        `<span class="sf-ph-tag">filtered by SlopFilter</span>` +
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
    if (!settings.enabled) return;

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
      const withinPost = Boolean(el.closest(LINKEDIN_POST_SELECTOR) || el.matches(LINKEDIN_POST_SELECTOR));
      if (!withinPost) {
        processed.add(el);
        return;
      }
      const isTextCandidate = Boolean(el.matches(LINKEDIN_TEXT_SELECTOR) || el.closest(LINKEDIN_TEXT_SELECTOR));
      const isPostContainer = el.matches(LINKEDIN_POST_SELECTOR);
      // Prefer text blocks; avoid scoring whole containers when text blocks are available.
      if (isPostContainer && el.querySelector(LINKEDIN_TEXT_SELECTOR)) {
        processed.add(el);
        return;
      }
      if (!isTextCandidate && !isPostContainer) {
        processed.add(el);
        return;
      }
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
          : settings.minTextLength);
    if (text.length < effectiveMinLength) return;

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
      scanElement(next);
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
    queued.add(el);
    pendingQueue.push(el);
    scheduleFlush();
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
    if (!settings.enabled) return;

    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const parent = mutation.target?.parentElement;
          if (!parent) continue;
          const candidate = parent.closest(CANDIDATE_SELECTOR);
          if (candidate) enqueue(candidate);
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Scan node itself if it matches
          if (node.matches && node.matches(CANDIDATE_SELECTOR)) {
            if (!inSkipZone(node)) enqueue(node);
          }

          // Directly enqueue all matching descendants.
          // Previously this called observeNewElements() which only wraps
          // elements in IntersectionObserver — IO only fires on a
          // non→intersecting TRANSITION, so elements added while already
          // visible (Twitter's virtual scroll injects nodes that are
          // immediately in the viewport) are silently skipped forever.
          // Direct enqueue catches them on the next idle tick.
          node.querySelectorAll(CANDIDATE_SELECTOR).forEach(el => {
            if (!inSkipZone(el)) enqueue(el);
          });
        }
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
      if (!settings.enabled) return;
      const isTwitter = /^(twitter|x)\.com$/.test(location.hostname);
      const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);
      const selector = isTwitter
        ? '[data-testid="tweetText"],[data-testid="tweet"]'
        : (isLinkedIn ? `${LINKEDIN_POST_SELECTOR},${LINKEDIN_TEXT_SELECTOR}` : CANDIDATE_SELECTOR);
      const vhLow  = -600;
      const vhHigh = window.innerHeight + 600;
      document.querySelectorAll(selector).forEach(el => {
        if (inSkipZone(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.bottom >= vhLow && rect.top <= vhHigh) enqueue(el);
      });
    }, 100);
  }, { passive: true });

  const AUTO_SWEEP_MS = 2000;
  let autoSweepTimer = null;

  function startAutoSweep() {
    if (autoSweepTimer) return;
    autoSweepTimer = setInterval(() => {
      if (!settings.enabled) return;
      if (/^(twitter|x)\.com$/.test(location.hostname)) {
        document.querySelectorAll('[data-testid="tweetText"],[data-testid="tweet"]').forEach(enqueue);
        return;
      }
      if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
        document.querySelectorAll(`${LINKEDIN_POST_SELECTOR},${LINKEDIN_TEXT_SELECTOR}`).forEach(enqueue);
        return;
      }
      document.querySelectorAll(CANDIDATE_SELECTOR).forEach(enqueue);
    }, AUTO_SWEEP_MS);
  }

  function enqueueVisibleFeedCandidates() {
    if (!settings.enabled) return;
    const isTwitter = /^(twitter|x)\.com$/.test(location.hostname);
    const isLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);
    const selector = isTwitter
      ? '[data-testid="tweetText"],[data-testid="tweet"]'
      : (isLinkedIn ? `${LINKEDIN_POST_SELECTOR},${LINKEDIN_TEXT_SELECTOR}` : CANDIDATE_SELECTOR);
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
        settings.replacementMode = normalizeReplacementMode(settings.replacementMode);
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
        seenMedia = new WeakSet();
        factIndex = 0;

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
      detail: {
        enabled: settings.enabled,
        debugHighlight: settings.debugHighlight,
        modes: settings.modes,
        replacementMode: settings.replacementMode,
      },
    }));
  }
  // ─── SETTINGS LOAD & BOOT ─────────────────────────────────────────────────────

  chrome.storage.sync.get(
    { enabled: true, modes: { slop: true, ai: true, rage: true, misinfo: true }, debugHighlight: false, debugScanAll: false, replacementMode: 'off' },
    (stored) => {
      settings = { ...settings, ...stored };
      settings.replacementMode = normalizeReplacementMode(stored.replacementMode);
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
