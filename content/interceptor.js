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
    // ── Dehumanising / ethnonationalist rhetoric ─────────────────────────────
    { re: /\b(parasitic|verminous?|subhuman|cockroach|locust|infestation)\b/i,                  w: 0.9  }, // r18
    { re: /\b(great\s+replacement|demographic\s+replacement|white\s+genocide|ethnic\s+replacement)\b/i, w: 0.95 }, // r20
    { re: /\b(extinction|erasure|end)\s+(of|as)\s+(a\s+|the\s+)?(race|people|native|culture)|\b(native\s+peoples?|rightful\s+heirs?)\b/i, w: 0.9 }, // r21
    { re: /\b(just|only)\s+asking\s+questions?\b/i,                                             w: 0.75 }, // r27
    { re: /\b(i['\u2019]?m|im|we['\u2019]?re|were)?\s*not\s+(racist|xenophobic)\s+but\b/i,      w: 0.95 }, // r29
    { re: /\b(they|these\s+people)\s+(do\s+not|don['\u2019]?t)\s+belong\s+(here|in\s+our\s+country|in\s+our\s+society)\b/i, w: 0.95 }, // r30
    { re: /\b(illegal\s+invaders?|invading\s+hordes?)\b/i,                                       w: 0.9 }, // r32
    { re: /\b(retweet|share|repost)\s+if\s+you\s+(agree|care|support)|\bif\s+you\s+agree\s+(share|retweet|repost)\b/i, w: 0.85 }, // r33
    { re: /\b(always|never|everyone|no\s+one)\b.{0,35}\b(liar|evil|traitor|disgusting|corrupt)\b/i, w: 0.75 }, // r34
    { re: /\b(us\s+vs\s+them|enemy\s+within|traitors?\s+among\s+us|they\s+are\s+coming\s+for)\b/i, w: 0.8 }, // r35
    { re: /\bwhy\s+is\s+nobody\s+talking\s+about\b|\bwhat\s+are\s+they\s+hiding\b/i,             w: 0.8 }, // r37
    // ── Platform propaganda / absolute truth claims ───────────────────────────
    { re: /\bonly\s+\w+\s+(speaks?|knows?|tells?|shows?|reveals?|understands?)\s+the\s+truth\b/i, w: 0.85 }, // s21
    { re: /\bonly\s+(truthful|unbiased|uncensored|based)\s+(ai|source|news|information|platform|media)\b/i, w: 0.8 }, // s22
    // ── Truth-bait assertions ─────────────────────────────────────────────────
    { re: /\bdo\s+you\s+want\s+(to\s+)?(know\s+)?the\s+truth\b/i,                                 w: 0.7  }, // s25
    { re: /\b(this|that)\s+is\s+the\s+(?:real\s+|whole\s+)?truth\b/i,                             w: 0.65 }, // s26
    { re: /\b(insiders?|sources?|experts?)\s+(say|said|confirm|confirmed)\b.{0,40}\b(won['\u2019]?t|cannot|can['\u2019]?t)\s+(say|name|be\s+named)\b/i, w: 0.75 }, // mi16
    // ── AI-generated image attribution (Grok, Midjourney, DALL-E, etc.) ──────
    { re: /\b(made|created|generated|imagined|designed|built)\s+(by|with|using)\s+(grok|dall[- ]?e|midjourney|stable\s+diffusion|firefly|ideogram|sora|openai|gemini|claude|copilot|kling|runway)\b/i, w: 0.9 }, // a19
    { re: /\bgrok\s+imagine\b|@grok\s+imagine\b/i,                                                 w: 0.85 }, // a20
    { re: /\b(edited|enhanced|upscaled|restored|retouched|remixed)\s+(by|with|using)\s+(ai|grok|dall[- ]?e|midjourney|stable\s+diffusion|runway|firefly|ideogram|flux|kling)\b/i, w: 0.85 }, // a21
    { re: /\b(deepfake|face\s*swap|faceswap|synthetic\s+video)\b/i,                                w: 0.9 }, // a22
  ];

  // Threshold: weighted score must exceed this to be filtered at the network layer.
  // Deliberately higher than the DOM-layer threshold (0.6) to minimise false
  // positives — the DOM scanner catches borderline cases after the fact.
  const LITE_SCORE_THRESHOLD = 0.75;
  const LITE_TOKEN_RE = /[a-z][a-z0-9_'-]{1,20}/g;
  const LITE_NB = {
    rage: {
      prior: 0.08,
      pos: { truth: 26, wake: 26, sheeple: 14, elite: 10, elites: 10, globalists: 12, invasion: 16, replacement: 18, censored: 12, rigged: 11, corrupt: 11, belong: 14, patriots: 10, lying: 10, media: 10 },
      neg: { update: 12, report: 10, data: 14, study: 12, analysis: 12, source: 9, docs: 9, meeting: 8, project: 8 }
    },
    ai: {
      prior: 0.1,
      pos: { important: 22, ensure: 20, overall: 18, additionally: 16, provide: 18, consider: 18, however: 16, summary: 14, therefore: 14, comprehensive: 12, clarify: 12, model: 14, generated: 12, prompt: 8, deepfake: 10, delve: 9 },
      neg: { maybe: 14, probably: 14, basically: 12, thanks: 11, thank: 10, really: 10, bug: 11, fix: 10, stack: 8, crash: 8, benchmark: 10, latency: 8, deploy: 7, release: 7 }
    }
  };

  /** Returns true if the text is confidently slop. */
  function liteDetect(text) {
    if (!text || text.length < 24) return false;
    let score = 0;
    for (const { re, w } of LITE_PATTERNS) {
      if (re.test(text)) {
        score += w;
        if (score >= LITE_SCORE_THRESHOLD) return true;
      }
    }
    const rageProb = liteNbProb(text, LITE_NB.rage);
    const aiProb = liteNbProb(text, LITE_NB.ai);
    if (rageProb >= 0.87 || aiProb >= 0.89) return true;
    if ((rageProb >= 0.8 || aiProb >= 0.82) && score >= 0.45) return true;
    return false;
  }

  function liteNbProb(text, model) {
    const tokens = (text.toLowerCase().match(LITE_TOKEN_RE) || []);
    if (tokens.length === 0) return 0;

    const pos = model.pos;
    const neg = model.neg;
    const vocab = new Set([...Object.keys(pos), ...Object.keys(neg)]);
    const v = Math.max(1, vocab.size);
    const posTotal = Object.values(pos).reduce((a, b) => a + b, 0);
    const negTotal = Object.values(neg).reduce((a, b) => a + b, 0);
    let llr = Math.log((model.prior || 0.1) / (1 - (model.prior || 0.1)));

    for (const t of new Set(tokens)) {
      const cp = (pos[t] || 0) + 1;
      const cn = (neg[t] || 0) + 1;
      llr += Math.log(cp / (posTotal + v)) - Math.log(cn / (negTotal + v));
    }
    return 1 / (1 + Math.exp(-llr));
  }

  // ─── STATE ────────────────────────────────────────────────────────────────────
  let interceptorSettings = {
    enabled: true,
    debugHighlight: false,
    modes: { slop: true, ai: true, rage: true, misinfo: true },
    siteModes: { twitter: true, linkedin: true },
    replacementMode: 'off',
  };

  function currentSiteKey() {
    if (/^(twitter|x)\.com$/.test(location.hostname)) return 'twitter';
    if (/(^|\.)linkedin\.com$/.test(location.hostname)) return 'linkedin';
    return null;
  }

  function isInterceptorActive() {
    if (!interceptorSettings.enabled) return false;
    const siteKey = currentSiteKey();
    if (!siteKey || interceptorSettings.siteModes?.[siteKey] === false) return false;
    // In debug highlight mode we keep payloads intact so DOM-layer highlighting
    // can show exactly what would have been removed.
    if (interceptorSettings.debugHighlight) return false;
    // When replacement placeholders are enabled, keep feed items in DOM so they
    // can be replaced in-place by content.js.
    if (interceptorSettings.replacementMode === 'fun_facts') return false;
    // If all modes are off, interception should be off too.
    return Object.values(interceptorSettings.modes || {}).some(Boolean);
  }

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
      // Voyager feed, dashes (home feed), search results, messaging
      test: url => /linkedin\.com\/voyager\/api\/(feed|dashes|search|updates|messaging)/i.test(url),
      filter: filterLinkedIn,
    },
  ];

  // ─── TWITTER ADAPTER ─────────────────────────────────────────────────────────

  function textFromTweetResult(tweetResult) {
    return tweetResult?.legacy?.full_text
        || tweetResult?.tweet?.legacy?.full_text
        || null;
  }

  /** Extract tweet text from a single-tweet timeline entry object. */
  function twitterTextFromEntry(entry) {
    try {
      const itemContent = entry?.content?.itemContent;
      const tweetResult = itemContent?.tweet_results?.result;
      return textFromTweetResult(tweetResult);
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
        instruction.entries = instruction.entries.filter(entry => {
          // Multi-item timeline modules: remove matching items, keep module if any remain.
          if (Array.isArray(entry?.content?.items)) {
            entry.content.items = entry.content.items.filter(item => {
              const r = item?.item?.itemContent?.tweet_results?.result;
              const text = textFromTweetResult(r);
              if (text && liteDetect(text)) { removed++; return false; }
              return true;
            });
            return entry.content.items.length > 0;
          }

          // Standard single-tweet entries.
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

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function extractLinkedInTextDeep(node, depth = 0, out = []) {
    if (!node || depth > 4 || out.length >= 12) return out;
    if (typeof node === 'string') {
      const t = normalizeText(node);
      if (t.length >= 24) out.push(t);
      return out;
    }
    if (Array.isArray(node)) {
      for (const item of node) extractLinkedInTextDeep(item, depth + 1, out);
      return out;
    }
    if (typeof node !== 'object') return out;

    // Prefer fields commonly carrying visible text in Voyager payloads.
    const candidateKeys = ['text', 'commentary', 'body', 'message', 'title', 'subtitle', 'description'];
    for (const key of candidateKeys) {
      if (node[key] != null) extractLinkedInTextDeep(node[key], depth + 1, out);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') extractLinkedInTextDeep(value, depth + 1, out);
    }
    return out;
  }

  /** Extract the visible text from a LinkedIn feed/messaging element. */
  function linkedInTextFromElement(el) {
    try {
      const quick =
        el?.commentary?.text?.text ||
        el?.actor?.description?.text ||
        el?.header?.text?.text ||
        el?.message?.body ||
        el?.body?.text ||
        el?.value?.com?.linkedin?.voyager?.feed?.render?.updateV2?.commentary?.text?.text ||
        '';
      const quickNorm = normalizeText(quick);
      if (quickNorm.length >= 24) return quickNorm;

      const deep = extractLinkedInTextDeep(el);
      if (deep.length === 0) return null;
      return normalizeText(deep.join(' ')).slice(0, 2000);
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
      // Some Voyager payloads nest additional elements arrays.
      (function walk(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 5) return;
        if (Array.isArray(obj)) {
          for (const item of obj) walk(item, depth + 1);
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'elements' && Array.isArray(v)) obj[k] = filterArr(v);
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      })(json, 0);
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

  function notifyFeedSeen(adapterName) {
    window.dispatchEvent(new CustomEvent('slopfilter:feed-seen', {
      detail: { source: adapterName, ts: Date.now() },
    }));
  }

  // ─── CORE PROCESSOR ──────────────────────────────────────────────────────────

  function getAdapterForUrl(url) {
    return ADAPTERS.find(a => a.test(url)) || null;
  }

  function processJson(url, json) {
    const adapter = getAdapterForUrl(url);
    if (!adapter) return json;

    // Always emit feed-seen for matched feed responses, even when filtering
    // is disabled (debug highlight / replacement modes).
    notifyFeedSeen(adapter.name);

    if (!isInterceptorActive()) return json;
    const removed = adapter.filter(json);
    if (removed > 0) notifyRemoved(removed, adapter.name);
    return json; // mutated in-place
  }

  function shouldIntercept(url) {
    return isInterceptorActive() && Boolean(getAdapterForUrl(url));
  }

  function shouldWatchFeed(url) {
    return Boolean(getAdapterForUrl(url));
  }

  // ─── FETCH PATCH ─────────────────────────────────────────────────────────────

  const _nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req
              : req instanceof Request  ? req.url
              : '';

    const response = await _nativeFetch.apply(this, args);

    const intercept = shouldIntercept(url);
    if (!intercept) {
      if (shouldWatchFeed(url)) notifyFeedSeen(getAdapterForUrl(url).name);
      return response;
    }
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

  // Grab the prototype-level descriptors so we can call the real getters.
  // Using these instead of this.prop bypasses any Proxy/instrumentation layer
  // that Twitter or another extension may have placed on the XHR instance,
  // which is the root cause of the "Maximum call stack size exceeded" error.
  const _rtDesc           = Object.getOwnPropertyDescriptor(_xhrProto, 'responseText');
  const _rDesc            = Object.getOwnPropertyDescriptor(_xhrProto, 'response');
  const _readyStateDesc   = Object.getOwnPropertyDescriptor(_xhrProto, 'readyState');
  const _responseTypeDesc = Object.getOwnPropertyDescriptor(_xhrProto, 'responseType');

  _xhrProto.open = function (method, url, ...rest) {
    this.__slopUrl = String(url || '');
    this.__slopFiltered = undefined; // lazy cache
    this.__slopFeedSeen = false;
    this.__slopAdapter = getAdapterForUrl(this.__slopUrl);

    if (this.__slopAdapter && !this.__slopFeedSeen) {
      this.__slopFeedSeen = true;
      notifyFeedSeen(this.__slopAdapter.name);
    }

    if (shouldIntercept(this.__slopUrl)) {
      // Override the responseText getter on this instance.
      const self = this;

      function getFiltered() {
        // Short-circuit: already computed.
        if (self.__slopFiltered !== undefined) return self.__slopFiltered;

        // Re-entrancy guard: if Twitter's instrumentation (or another extension's
        // XHR proxy) reads xhr.responseText WHILE we're inside this getter, we'd
        // recurse infinitely because __slopFiltered is still undefined at that
        // point and the guard above would pass.  Detect the cycle and fall back
        // to the native prototype getter immediately.
        if (self.__slopRtLock) {
          return _rtDesc ? _rtDesc.get.call(self) : '';
        }
        self.__slopRtLock = true;
        try {
          // Read the real underlying text via the prototype descriptor — bypasses
          // our own instance-level getter so there is no self-referential loop.
          const raw = _rtDesc.get.call(self);
          if (!raw) { self.__slopFiltered = raw; return raw; }
          try {
            const json = JSON.parse(raw);
            processJson(self.__slopUrl, json);
            self.__slopFiltered = JSON.stringify(json);
          } catch {
            self.__slopFiltered = raw; // parse failed — pass through unchanged
          }
          return self.__slopFiltered;
        } finally {
          self.__slopRtLock = false;
        }
      }

      Object.defineProperty(this, 'responseText', {
        get: getFiltered,
        configurable: true,
        enumerable: true,
      });

      // Also override 'response', which may be the parsed JSON object when
      // responseType === "json".
      // Re-entrancy guard: if Twitter's instrumentation (or another extension's
      // XHR proxy) reads xhr.response WHILE our getter is already running we'd
      // get infinite recursion.  The __slopRespLock flag breaks the cycle and
      // delegates to the native prototype getter instead.
      Object.defineProperty(this, 'response', {
        get: function () {
          if (self.__slopRespLock) {
            // Already inside this getter — return native value to break the cycle.
            return _rDesc ? _rDesc.get.call(self) : null;
          }
          self.__slopRespLock = true;
          try {
            // Read readyState / responseType via native prototype getters to
            // avoid any intermediate proxy that could re-trigger this getter.
            const readyState   = _readyStateDesc   ? _readyStateDesc.get.call(self)   : self.readyState;
            const responseType = _responseTypeDesc ? _responseTypeDesc.get.call(self) : self.responseType;
            if (readyState < 4) return null;
            if (responseType === 'json') {
              const text = getFiltered();
              try { return JSON.parse(text); } catch { return null; }
            }
            return getFiltered();
          } finally {
            self.__slopRespLock = false;
          }
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
    const detail = e?.detail || {};
    if (typeof detail.enabled === 'boolean') {
      interceptorSettings.enabled = detail.enabled;
    }
    if (typeof detail.debugHighlight === 'boolean') {
      interceptorSettings.debugHighlight = detail.debugHighlight;
    }
    if (detail.modes && typeof detail.modes === 'object') {
      interceptorSettings.modes = {
        slop: true,
        ai: true,
        rage: true,
        misinfo: true,
        ...detail.modes,
      };
    }
    if (detail.siteModes && typeof detail.siteModes === 'object') {
      interceptorSettings.siteModes = {
        twitter: true,
        linkedin: true,
        ...detail.siteModes,
      };
    }
    if (typeof detail.replacementMode === 'string') {
      interceptorSettings.replacementMode = detail.replacementMode === 'fun_facts' ? 'fun_facts' : 'off';
    }
  });

})();
