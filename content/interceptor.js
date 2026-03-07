/**
 * interceptor.js — SlopFilter network-layer interceptor
 *
 * Runs in MAIN world at document_start — BEFORE the page's own JS executes.
 * Patches window.fetch and XMLHttpRequest so that JSON feed payloads from
 * Twitter/X and LinkedIn are filtered BEFORE the framework (React/Ember) ever
 * sees them. Items are spliced out of the response arrays; the framework then
 * renders a clean feed natively with zero DOM fighting and zero flicker.
 *
 * Architecture notes:
 *  - MAIN world: no chrome.* APIs. Stats are relayed to the isolated-world
 *    content.js via CustomEvent('slopfilter:network-removed').
 *  - SlopDetector (isolated world) is unavailable here.  A self-contained
 *    LiteDetector is inlined below using only the highest-precision patterns.
 *  - XHR override uses instance-level Object.defineProperty on responseText /
 *    response so the getter is intercepted before any framework callback fires.
 *  - document_start guarantees the patches exist before any <script> runs.
 */
(() => {
  'use strict';

  // ─── GUARD ────────────────────────────────────────────────────────────────────
  if (window.__slopInterceptorActive) return;
  window.__slopInterceptorActive = true;

  // ─── LITE DETECTOR ────────────────────────────────────────────────────────────
  // Subset of highest-precision patterns (weight ≥ 0.75 in detector.js).
  // Weighted scoring with a configurable threshold — same concept as the full
  // engine, tuned for short social-media text where one strong hit is enough.
  //
  // IMPORTANT: keep this list in sync with PATTERNS in detector.js when adding
  // new high-confidence signals (marker comment: "INTERCEPTOR_PATTERN").

  const LITE_PATTERNS = [
    // ── AI markers ──────────────────────────────────────────────────────────────
    { re: /\bas\s+an\s+ai\s+(language\s+)?model\b/i,                                           w: 1.0  }, // a01
    { re: /\b(certainly|absolutely|of\s+course)[!,]?\s+here['''\u2019]s?\b/i,                   w: 0.85 }, // a03
    { re: /\bi\s+hope\s+this\s+(helps|clarifies|answers)\b/i,                                  w: 0.8  }, // a04
    { re: /\bin\s+summary[,.]?\s+it\s+is\s+(clear|evident|apparent)\b/i,                       w: 0.8  }, // a16
    { re: /\b(tapestry|realm|mosaic)\s+of\b/i,                                                  w: 0.7  }, // a12
    { re: /\bnavigate\s+the\s+(complex\s+)?(landscape|terrain|world)\b/i,                       w: 0.7  }, // a14
    { re: /\bbustling\s+(hub|city|centre|center|metropolis)\b/i,                                w: 0.7  }, // a15
    { re: /\bdive\s+into\s+the\s+world\s+of\b/i,                                               w: 0.75 }, // a18
    { re: /\bdelve\s+into\b/i,                                                                  w: 0.85 }, // s02
    { re: /—[^—]{0,120}—[^—]{0,120}—/u,                                                        w: 0.5  }, // a11 (em-dash overuse)

    // ── Slop / LinkedIn filler ───────────────────────────────────────────────────
    { re: /\bin\s+today['''\u2019]?s?\s+(fast[- ]paced|digital|ever[- ]changing|modern)\s+world\b/i, w: 0.9 }, // s01
    { re: /\bunlock\s+the\s+(power|potential|full\s+potential)\b/i,                             w: 0.8  }, // s05
    { re: /\bactionable\s+insight/i,                                                            w: 0.65 }, // s19
    { re: /\bthought\s+leader(s|ship)?\b/i,                                                    w: 0.65 }, // s06
    { re: /\bfoster\s+(a\s+)?(sense|culture|environment)\b/i,                                  w: 0.65 }, // a13

    // ── Rage-bait ────────────────────────────────────────────────────────────────
    { re: /\byou\s+won['''\u2019ʼ]?t\s+(believe|guess)\b/i,                                     w: 0.85 }, // r01
    { re: /\bshare\s+(this\s+)?(before\s+(it['''\u2019]?s?\s+)?(deleted|taken\s+down|removed)|now!)/i, w: 0.95 }, // r05
    { re: /\bthey\s+(don['''\u2019]?t|do\s+not)\s+want\s+you\s+to\b/i,                         w: 0.8  }, // r10
    { re: /\bif\s+the\s+only\s+way\s+to\b.{0,80}\bwould\s+you\b/i,                             w: 0.85 }, // r13
    // ── Platform propaganda / absolute truth claims ───────────────────────────
    { re: /\bonly\s+\w+\s+(speaks?|knows?|tells?|shows?|reveals?|understands?)\s+the\s+truth\b/i, w: 0.85 }, // s21
    { re: /\bonly\s+(truthful|unbiased|uncensored|based)\s+(ai|source|news|information|platform|media)\b/i, w: 0.8 }, // s22
  ];

  // Threshold: weighted score must exceed this to be filtered at the network layer.
  // Deliberately higher than the DOM-layer threshold (0.6) to minimise false
  // positives — the DOM scanner catches borderline cases after the fact.
  const LITE_SCORE_THRESHOLD = 0.75;

  /** Returns true if the text is confidently slop. */
  function liteDetect(text) {
    if (!text || text.length < 40) return false;
    let score = 0;
    for (const { re, w } of LITE_PATTERNS) {
      if (re.test(text)) {
        score += w;
        if (score >= LITE_SCORE_THRESHOLD) return true;
      }
    }
    return false;
  }

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let interceptorEnabled = true;

  // ─── SITE ADAPTERS ────────────────────────────────────────────────────────────
  // Each adapter: { test(url): boolean, filter(json): number }
  // filter() mutates json in-place and returns the number of items removed.

  const ADAPTERS = [
    {
      name: 'twitter',
      // All known tweet-bearing GraphQL endpoints:
      //   Home/Following feeds, profile Tweets tab (UserTweets), Tweets+Replies,
      //   tweet detail, search, lists, bookmarks, likes, notifications, communities.
      test: url => /(?:twitter|x)\.com/.test(url) && /\/graphql\//i.test(url) &&
                   /Timeline|TweetsAndReplies|SearchResults|Feed|UserTweets|TweetDetail|Bookmarks|FavoritedBy|ListLatest|CommunityTweets/i.test(url),
      filter: filterTwitter,
    },
    {
      name: 'linkedin',
      // Voyager feed, dashes (home feed), search results
      test: url => /linkedin\.com\/voyager\/api\/(feed|dashes|search|updates)/i.test(url),
      filter: filterLinkedIn,
    },
  ];

  // ─── TWITTER ADAPTER ─────────────────────────────────────────────────────────

  /** Extract tweet text from a timeline entry object (handles various shapes). */
  function twitterTextFromEntry(entry) {
    try {
      // Standard single-tweet entry
      const itemContent = entry?.content?.itemContent;
      const tweetResult = itemContent?.tweet_results?.result;
      if (tweetResult) {
        return tweetResult.legacy?.full_text
            || tweetResult.tweet?.legacy?.full_text
            || null;
      }
      // TimelineTimelineModule (multi-item rows, e.g. "who to follow")
      const items = entry?.content?.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const r = item?.item?.itemContent?.tweet_results?.result;
          const t = r?.legacy?.full_text || r?.tweet?.legacy?.full_text;
          if (t) return t;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Walk the GraphQL JSON tree and strip flagged timeline entries. */
  function filterTwitter(json) {
    let removed = 0;

    function walkInstructions(instructions) {
      if (!Array.isArray(instructions)) return;
      for (const instruction of instructions) {
        if (!Array.isArray(instruction?.entries)) continue;
        const before = instruction.entries.length;
        instruction.entries = instruction.entries.filter(entry => {
          const text = twitterTextFromEntry(entry);
          if (text && liteDetect(text)) {
            removed++;
            return false;
          }
          return true;
        });
        // Some paths also expose a 'items' array at the instruction level
        if (Array.isArray(instruction?.moduleItems)) {
          instruction.moduleItems = instruction.moduleItems.filter(item => {
            const r = item?.item?.itemContent?.tweet_results?.result;
            const text = r?.legacy?.full_text || r?.tweet?.legacy?.full_text || null;
            if (text && liteDetect(text)) { removed++; return false; }
            return true;
          });
        }
      }
    }

    // GraphQL responses have a deeply-nested data tree — walk it recursively
    // looking for 'instructions' arrays without caring about the exact path.
    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 12) return;
      if (Array.isArray(obj)) {
        obj.forEach(o => walk(o, depth + 1));
        return;
      }
      if (Array.isArray(obj.instructions)) {
        walkInstructions(obj.instructions);
      } else {
        for (const val of Object.values(obj)) {
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      }
    }

    try { walk(json, 0); } catch { /* never break the page */ }
    return removed;
  }

  // ─── LINKEDIN ADAPTER ────────────────────────────────────────────────────────

  /** Extract the visible text from a LinkedIn feed element. */
  function linkedInTextFromElement(el) {
    try {
      // dashes/home-feed elements
      return el?.commentary?.text?.text
          || el?.actor?.description?.text
          || el?.header?.text?.text
          // search / updates V2
          || el?.value?.com?.linkedin?.voyager?.feed?.render?.updateV2?.commentary?.text?.text
          || null;
    } catch { return null; }
  }

  /** Strip flagged items from LinkedIn Voyager response arrays. */
  function filterLinkedIn(json) {
    let removed = 0;

    function filterArr(arr) {
      if (!Array.isArray(arr)) return arr;
      return arr.filter(el => {
        const text = linkedInTextFromElement(el);
        if (text && liteDetect(text)) { removed++; return false; }
        return true;
      });
    }

    try {
      if (Array.isArray(json?.elements))         json.elements         = filterArr(json.elements);
      if (Array.isArray(json?.data?.elements))   json.data.elements    = filterArr(json.data.elements);
      if (Array.isArray(json?.included))         json.included         = filterArr(json.included);
    } catch { /* never break the page */ }
    return removed;
  }

  // ─── STATS RELAY ──────────────────────────────────────────────────────────────
  // MAIN world → isolated world (content.js) via CustomEvent.

  function notifyRemoved(count, adapterName) {
    if (count <= 0) return;
    window.dispatchEvent(new CustomEvent('slopfilter:network-removed', {
      detail: { count, source: adapterName },
    }));
  }

  // ─── CORE PROCESSOR ──────────────────────────────────────────────────────────

  function processJson(url, json) {
    if (!interceptorEnabled) return json;
    for (const adapter of ADAPTERS) {
      if (adapter.test(url)) {
        const removed = adapter.filter(json);
        if (removed > 0) notifyRemoved(removed, adapter.name);
        break; // at most one adapter per URL
      }
    }
    return json; // mutated in-place
  }

  function shouldIntercept(url) {
    return interceptorEnabled && ADAPTERS.some(a => a.test(url));
  }

  // ─── FETCH PATCH ─────────────────────────────────────────────────────────────

  const _nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req
              : req instanceof Request  ? req.url
              : '';

    const response = await _nativeFetch.apply(this, args);

    if (!shouldIntercept(url)) return response;
    if (!(response.headers.get('content-type') || '').includes('application/json')) return response;

    try {
      const json = await response.clone().json();
      processJson(url, json); // mutates json

      // Rebuild a synthetic Response so the framework receives the filtered body.
      // Copy all headers except content-length (body size has changed).
      const newHeaders = new Headers(response.headers);
      newHeaders.delete('content-length');

      return new Response(JSON.stringify(json), {
        status:     response.status,
        statusText: response.statusText,
        headers:    newHeaders,
      });
    } catch {
      // If anything breaks, return original response — never crash the page.
      return response;
    }
  };

  // Expose the real fetch for code that needs to bypass (e.g. chrome internals).
  window.fetch.__slopNative = _nativeFetch;

  // ─── XHR PATCH ───────────────────────────────────────────────────────────────
  // Strategy: override responseText / response getters at the INSTANCE level
  // inside open(), so that ALL callers (including the framework's own callbacks
  // which may be registered before send()) always read the filtered text.

  const _xhrProto = XMLHttpRequest.prototype;
  const _nativeOpen = _xhrProto.open;
  const _nativeSend = _xhrProto.send;

  // Grab the prototype-level descriptor so we can call the real getter.
  const _rtDesc = Object.getOwnPropertyDescriptor(_xhrProto, 'responseText');
  const _rDesc  = Object.getOwnPropertyDescriptor(_xhrProto, 'response');

  _xhrProto.open = function (method, url, ...rest) {
    this.__slopUrl = String(url || '');
    this.__slopFiltered = undefined; // lazy cache

    if (shouldIntercept(this.__slopUrl)) {
      // Override the responseText getter on this instance.
      const self = this;

      function getFiltered() {
        if (self.__slopFiltered !== undefined) return self.__slopFiltered;
        // Read the real underlying text via the prototype descriptor.
        const raw = _rtDesc.get.call(self);
        if (!raw) return raw;
        try {
          const json = JSON.parse(raw);
          processJson(self.__slopUrl, json);
          self.__slopFiltered = JSON.stringify(json);
        } catch {
          self.__slopFiltered = raw; // parse failed — pass through
        }
        return self.__slopFiltered;
      }

      Object.defineProperty(this, 'responseText', {
        get: getFiltered,
        configurable: true,
        enumerable: true,
      });

      // Also override 'response', which may be the parsed JSON object when
      // responseType === "json".
      Object.defineProperty(this, 'response', {
        get: function () {
          if (self.readyState < 4) return null;
          if (self.responseType === 'json') {
            const text = getFiltered();
            try { return JSON.parse(text); } catch { return null; }
          }
          return getFiltered();
        },
        configurable: true,
        enumerable: true,
      });
    }

    return _nativeOpen.call(this, method, url, ...rest);
  };

  // ─── SETTINGS SYNC ────────────────────────────────────────────────────────────
  // content.js (isolated world) broadcasts settings here via CustomEvent.

  window.addEventListener('slopfilter:update-settings', (e) => {
    if (e?.detail?.enabled === false) {
      interceptorEnabled = false;
    } else if (e?.detail?.enabled === true) {
      interceptorEnabled = true;
    }
  });

})();
