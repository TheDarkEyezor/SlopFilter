/**
 * background.js — SlopFilter service worker
 *
 * Responsibilities:
 *  - Sync settings to storage on write.
 *  - Relay RESCAN commands to the active tab's content script.
 *  - Update extension badge with per-tab removed counts.
 *  - Fact-check dispatcher: receives FACT_CHECK_REQUEST from content.js,
 *    queries Wikipedia (always) + Google Fact Check Tools API (optional,
 *    requires user-provided free API key), relays results back to the tab.
 */
'use strict';

// ─── PER-TAB STATS ────────────────────────────────────────────────────────────

const tabStats = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STATS_UPDATE' && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    tabStats[tabId] = msg.removedCount;

    chrome.action.setBadgeText({
      tabId,
      text: msg.removedCount > 0 ? String(msg.removedCount) : '',
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStats[tabId];
});

// ─── SETTINGS RELAY ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'POPUP_SETTINGS_CHANGE') {
    chrome.storage.sync.set(msg.settings, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'UPDATE_SETTINGS',
          settings: msg.settings,
        }).catch(() => {});
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});

// ─── FACT-CHECK DISPATCHER ────────────────────────────────────────────────────
//
// Queue design:
//   - Max 2 concurrent outbound requests (avoids hammering APIs on busy feeds).
//   - Min 350 ms between queue drains (rate-limit courtesy).
//   - Each request tries Google FCT API first (if key configured), then falls
//     back to Wikipedia extract for topic context.
//
// Message flow:
//   content.js  →  FACT_CHECK_REQUEST { id, text }
//   background  →  (async fetch)
//   background  →  FACT_CHECK_RESULT  { id, verdict, summary, source, sourceUrl }

const fcQueue   = [];   // { id, text, tabId }
let   fcActive  = 0;
const FC_MAX    = 2;    // max concurrent fetches
const FC_DELAY  = 350;  // ms between drain cycles

function enqueueFc(item) {
  fcQueue.push(item);
  drainFcQueue();
}

async function drainFcQueue() {
  if (fcActive >= FC_MAX || fcQueue.length === 0) return;
  fcActive++;
  const item = fcQueue.shift();

  try {
    const result = await runFactCheck(item.text);
    chrome.tabs.sendMessage(item.tabId, {
      type: 'FACT_CHECK_RESULT',
      id:   item.id,
      ...result,
    }).catch(() => {});
  } catch {
    // Silently swallow — content.js badge stays in pending state
  } finally {
    fcActive--;
    setTimeout(drainFcQueue, FC_DELAY);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FACT_CHECK_REQUEST' && sender.tab?.id != null) {
    enqueueFc({ id: msg.id, text: msg.text, tabId: sender.tab.id });
    sendResponse({ queued: true });
    return true;
  }
});

// ─── FACT-CHECK LOGIC ─────────────────────────────────────────────────────────

async function runFactCheck(text) {
  // 1. Try Google Fact Check Tools API if the user has configured a key
  const { factCheckApiKey } = await chrome.storage.sync.get({ factCheckApiKey: '' });
  if (factCheckApiKey) {
    const r = await googleFactCheck(text, factCheckApiKey).catch(() => null);
    if (r) return r;
  }

  // 2. Fall back to Wikipedia topic context (always available, no key needed)
  const r = await wikiContext(text).catch(() => null);
  if (r) return r;

  // 3. Last resort
  return {
    verdict:   'unverified',
    summary:   'No fact-check or reference found for this claim.',
    source:    'SlopFilter',
    sourceUrl: '',
  };
}

// ── Google Fact Check Tools API ───────────────────────────────────────────────
// Free API, requires a key from console.cloud.google.com (Fact Check Tools API).
// Returns matched claims from PolitiFact, Snopes, AFP Factcheck, Reuters, etc.

async function googleFactCheck(text, apiKey) {
  const query = encodeURIComponent(text.slice(0, 250));
  const url   = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${query}&key=${apiKey}&pageSize=1`;

  const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const data  = await res.json();
  const claim = data?.claims?.[0];
  if (!claim) return null;

  const review = claim.claimReview?.[0];
  if (!review) return null;

  return {
    verdict:   review.textualRating || 'Reviewed',
    summary:   `Claim: "${(claim.text || '').slice(0, 160)}"\n\nRating: ${review.textualRating}`,
    source:    review.publisher?.name || 'Fact Check',
    sourceUrl: review.url || '',
  };
}

// ── Wikipedia context ─────────────────────────────────────────────────────────
// Extracts the strongest content words from the text, searches Wikipedia,
// and returns the lead paragraph of the most relevant article.
// Requires no API key; CORS-safe from a service worker.

const STOP_WORDS = new Set([
  'about','after','again','all','also','another','any','are','been','before',
  'being','between','both','but','came','can','come','could','did','does',
  'each','for','from','get','got','had','has','have','here','him','his',
  'how','into','its','just','like','make','many','more','most','much',
  'need','new','not','now','off','one','only','other','our','out','over',
  'per','said','same','she','should','since','some','still','such','take',
  'than','that','the','their','them','then','there','these','they','this',
  'those','through','time','too','under','until','very','was','way','well',
  'were','what','when','where','which','while','who','will','with','would',
  'you','your',
]);

function extractKeyTerms(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')         // strip URLs
    .replace(/[^\w\s]/g, ' ')               // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w.toLowerCase()))
    // Weight longer, capitalised words (likely proper nouns / key terms)
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
    .join(' ');
}

async function wikiContext(text) {
  const terms = extractKeyTerms(text);
  if (!terms) return null;

  // 1. Search for an article
  const searchUrl = new URL('https://en.wikipedia.org/w/api.php');
  searchUrl.search = new URLSearchParams({
    action:   'query',
    list:     'search',
    srsearch: terms,
    utf8:     '',
    format:   'json',
    origin:   '*',
    srlimit:  '1',
  }).toString();

  const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
  if (!searchRes.ok) return null;

  const searchData = await searchRes.json();
  const firstHit   = searchData?.query?.search?.[0];
  if (!firstHit) return null;

  // 2. Fetch lead paragraph via the REST summary endpoint
  const title      = encodeURIComponent(firstHit.title.replace(/ /g, '_'));
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const summaryRes  = await fetch(summaryUrl, { signal: AbortSignal.timeout(5000) });
  if (!summaryRes.ok) return null;

  const summaryData = await summaryRes.json();
  const extract     = summaryData?.extract;
  if (!extract) return null;

  return {
    verdict:   'context',
    summary:   extract.slice(0, 320),
    source:    'Wikipedia',
    sourceUrl: summaryData?.content_urls?.desktop?.page
               || `https://en.wikipedia.org/wiki/${title}`,
  };
}
