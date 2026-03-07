/**
 * detector.js — SlopFilter heuristic detection engine
 *
 * Pure functions only. No side effects, no DOM access.
 * All patterns are pre-compiled at module load time (O(1) per check per pattern).
 *
 * Exports: window.SlopDetector
 */
(() => {
  'use strict';

  // ─── PATTERN LIBRARY ──────────────────────────────────────────────────────────
  // Each entry: { id, label, re, weight }
  // 'weight' contributes to the overall score (0–1 normalised).

  const PATTERNS = {
    // ── SLOP / CORPORATE FILLER ─────────────────────────────────────────────────
    slop: [
      { id: 's01', label: 'fast-paced world',     re: /\bin\s+today['']s?\s+(fast[- ]paced|digital|ever[- ]changing|modern)\s+world\b/i, weight: 0.9 },
      { id: 's02', label: 'delve into',            re: /\bdelve\s+into\b/i, weight: 0.85 },
      { id: 's03', label: 'game changer',          re: /\bgame[- ]?changer\b/i, weight: 0.5 },
      { id: 's04', label: 'paradigm shift',        re: /\bparadigm\s+shift\b/i, weight: 0.6 },
      { id: 's05', label: 'unlock the power',      re: /\bunlock\s+the\s+(power|potential|full\s+potential)\b/i, weight: 0.8 },
      { id: 's06', label: 'thought leader',        re: /\bthought\s+leader(s|ship)?\b/i, weight: 0.65 },
      { id: 's07', label: 'disruptive innovation', re: /\bdisruptive\s+innovat/i, weight: 0.65 },
      { id: 's08', label: 'synergy',               re: /\bsynerg(y|ies|istic)\b/i, weight: 0.5 },
      { id: 's09', label: 'moving forward',        re: /\bmoving\s+forward\b/i, weight: 0.45 },
      { id: 's10', label: 'at the end of the day', re: /\bat\s+the\s+end\s+of\s+the\s+day\b/i, weight: 0.45 },
      { id: 's11', label: 'leverage',              re: /\bleverage\s+(your|the|our|this)\b/i, weight: 0.55 },
      { id: 's12', label: 'holistic approach',     re: /\bholistic\s+(approach|solution|view)\b/i, weight: 0.55 },
      { id: 's13', label: 'revolutionize',         re: /\brevolution[ia]z(e|ing)\b/i, weight: 0.55 },
      { id: 's14', label: 'seamlessly',            re: /\bseamlessly\b/i, weight: 0.4 },
      { id: 's15', label: 'robust solution',       re: /\brobust\s+(solution|ecosystem|platform|framework)\b/i, weight: 0.5 },
      { id: 's16', label: 'value proposition',     re: /\bvalue\s+proposition\b/i, weight: 0.55 },
      { id: 's17', label: 'proactive approach',    re: /\bproactive(ly)?\b/i, weight: 0.4 },
      { id: 's18', label: 'best practices',        re: /\bbest\s+practices\b/i, weight: 0.35 },
      { id: 's19', label: 'actionable insights',   re: /\bactionable\s+insight/i, weight: 0.65 },
      { id: 's20', label: 'deep dive',             re: /\bdeep\s+dive\b/i, weight: 0.5 },
      // Platform propaganda / absolute-truth claims (common in AI product promotion)
      { id: 's21', label: 'only X speaks truth',    re: /\bonly\s+\w+\s+(speaks?|knows?|tells?|shows?|reveals?|understands?)\s+the\s+truth\b/i, weight: 0.85 },
      { id: 's22', label: 'only truthful X',        re: /\bonly\s+(truthful|unbiased|uncensored|based)\s+(ai|source|news|information|platform|media)\b/i, weight: 0.8 },
      { id: 's23', label: 'X is the future',        re: /\b\w+\s+is\s+the\s+(only|true|real|future)\s+(path|way|truth|source|answer|solution)\b/i, weight: 0.6 },
      { id: 's24', label: 'censored/banned/silenced',re: /\b(censored|silenced|shadow.?banned|deplatformed|cancelled)\s+(for\s+)?(telling|speaking|saying|posting)?\s*(the\s+)?truth\b/i, weight: 0.75 },
    ],

    // ── AI-GENERATED MARKERS ────────────────────────────────────────────────────
    ai: [
      { id: 'a01', label: 'AI model disclaimer',   re: /\bas\s+an\s+ai\s+(language\s+)?model\b/i, weight: 1.0 },
      { id: 'a02', label: 'happy to help',         re: /\bi(\'d|['\u2019]d)?\s+(would\s+be\s+)?happy\s+to\s+help\b/i, weight: 0.75 },
      { id: 'a03', label: 'certainly here is',     re: /\b(certainly|absolutely|of\s+course)[!,]?\s+here['\s]s?\b/i, weight: 0.85 },
      { id: 'a04', label: 'I hope this helps',     re: /\bi\s+hope\s+this\s+(helps|clarifies|answers)\b/i, weight: 0.8 },
      { id: 'a05', label: 'it is important to note', re: /\bit['\s]s?\s+(important|worth\s+noting|crucial)\s+to\s+note\b/i, weight: 0.75 },
      { id: 'a06', label: 'in this article we',    re: /\bin\s+this\s+(article|post|piece|guide)\s+we\s+will\b/i, weight: 0.6 },
      { id: 'a07', label: 'firstly secondly',      re: /\b(firstly|secondly|thirdly|lastly)\b.*\b(firstly|secondly|thirdly|lastly)\b/is, weight: 0.65 },
      { id: 'a08', label: 'in conclusion',         re: /\bin\s+conclusion\b/i, weight: 0.45 },
      { id: 'a09', label: 'furthermore moreover',  re: /\b(furthermore|moreover|additionally)\b.*\b(furthermore|moreover|additionally)\b/is, weight: 0.55 },
      { id: 'a10', label: 'exceedingly comprehensive', re: /\b(comprehensive(ly)?|extensively|exceedingly|meticulously)\b/i, weight: 0.4 },
      { id: 'a11', label: 'em-dash overuse',       re: /—[^—]{0,120}—[^—]{0,120}—/u, weight: 0.5 },
      { id: 'a12', label: 'tapestry/realm',        re: /\b(tapestry|realm|mosaic)\s+of\b/i, weight: 0.7 },
      { id: 'a13', label: 'foster and nurture',    re: /\b(foster|nurture)\s+(a\s+)?(sense|culture|environment)\b/i, weight: 0.65 },
      { id: 'a14', label: 'navigate the landscape',re: /\bnavigate\s+the\s+(complex\s+)?(landscape|terrain|world)\b/i, weight: 0.7 },
      { id: 'a15', label: 'bustling hub',          re: /\bbustling\s+(hub|city|centre|center|metropolis)\b/i, weight: 0.7 },
      { id: 'a16', label: 'in summary it is clear',re: /\bin\s+summary[,.]?\s+it\s+is\s+(clear|evident|apparent)\b/i, weight: 0.8 },
      { id: 'a17', label: 'let us explore',        re: /\b(let['\s]s?|let\s+us)\s+explore\b/i, weight: 0.55 },
      { id: 'a18', label: 'dive into the world',   re: /\bdive\s+into\s+the\s+world\s+of\b/i, weight: 0.75 },
    ],

    // ── RAGE-BAIT ───────────────────────────────────────────────────────────────
    rage: [
      { id: 'r01', label: "won't believe",         re: /\byou\s+won['ʼ\u2019]?t\s+(believe|guess)\b/i, weight: 0.85 },
      { id: 'r02', label: 'SHOCKED/OUTRAGED',      re: /\b(shocked|outraged|furious|enraged|livid)\b/i, weight: 0.6 },
      { id: 'r03', label: 'DESTROYED',             re: /\b(destroyed?|obliterated?|decimated?|annihilated?|demolished?)\b\s+(by|over|with)\b/i, weight: 0.7 },
      { id: 'r04', label: 'SECRET they hide',      re: /\b(secret|what\s+they\s+don['\u2019]?t\s+want\s+you\s+to\s+know)\b/i, weight: 0.7 },
      { id: 'r05', label: 'share before deleted',  re: /\bshare\s+(this\s+)?(before\s+(it['\u2019]?s?\s+)?(deleted|taken\s+down|removed)|now!)/i, weight: 0.95 },
      { id: 'r06', label: 'BREAKING overuse',      re: /\bBREAKING\b.*\bBREAKING\b|\[BREAKING\]/g, weight: 0.6 },
      { id: 'r07', label: 'all-caps headline',     re: /\b[A-Z]{4,}\b[^a-z]{0,60}\b[A-Z]{4,}\b[^a-z]{0,60}\b[A-Z]{4,}\b/, weight: 0.5 },
      { id: 'r08', label: 'triggered/snowflake',   re: /\b(triggered|snowflake|libtard|sheeple)\b/i, weight: 0.65 },
      { id: 'r09', label: 'MSM/mainstream media',  re: /\b(mainstream\s+media|MSM|fake\s+news)\b/i, weight: 0.55 },
      { id: 'r10', label: "they don't want you",   re: /\bthey\s+(don['\u2019]?t|do\s+not)\s+want\s+you\s+to\b/i, weight: 0.8 },
      { id: 'r11', label: 'wake up sheeple',       re: /\bwake\s+up\b.*\b(sheeple|people|everyone)\b/i, weight: 0.8 },
      { id: 'r12', label: 'elites globalists',       re: /\b(global\s*ist|global\s+elite|deep\s+state|new\s+world\s+order)\b/i, weight: 0.7 },
      // Hypothetical moral traps / binary dilemmas (common rage-bait format on Twitter)
      { id: 'r13', label: 'hypothetical dilemma',     re: /\bif\s+the\s+only\s+way\s+to\b.{0,80}\bwould\s+you\b/i, weight: 0.85 },
      { id: 'r14', label: 'single word answer trap',  re: /\b(single\s+word|one\s+word|yes\s+or\s+no)[^.!?]{0,40}(answer|reply|respond)/i, weight: 0.75 },
      { id: 'r15', label: 'this is what they want',   re: /\bthis\s+is\s+(exactly\s+)?what\s+(they|the\s+(left|right|media|elites?|woke))\s+(want|were|needed)\b/i, weight: 0.8 },
      { id: 'r16', label: 'name one time',             re: /\bname\s+(one|a\s+single)\s+time\s+when\b/i, weight: 0.7 },
      { id: 'r17', label: 'ratio / L / W comment',    re: /^\s*(ratio|massive\s+[lw]|take\s+the\s+[lw]|[lw]\s*\+\s*ratio)\s*[.!]?\s*$/i, weight: 0.65 },
    ],

    // ── MISINFORMATION SIGNALS ──────────────────────────────────────────────────
    // These do NOT cause removal — they trigger the blur → async fact-check flow.
    // Threshold for this category is intentionally 0.6 (same as others), but since
    // items are dimmed rather than deleted, false-positive cost is low.
    misinfo: [
      // Hard hoax / conspiracy claims (single match is enough)
      { id: 'mi01', label: 'event faked/staged',        re: /\b(covid|vaccine|election|shooting|attack|pandemic|9\/11|911)\s+(was\s+)?(faked|staged|hoax|false\s+flag|fabricated)\b/i, weight: 0.95 },
      { id: 'mi02', label: 'flat earth',                re: /\b(flat\s+earth|the\s+earth\s+is\s+flat|globe\s+(is\s+)?(a\s+)?(lie|fake))\b/i, weight: 0.95 },
      { id: 'mi03', label: 'moon landing hoax',         re: /\b(moon\s+landing|apollo\s+\d+)\s+(was\s+)?(faked|staged|fake|hoax|never\s+happened)\b/i, weight: 0.95 },
      { id: 'mi04', label: 'miracle cure claim',        re: /\b(cures?|eliminates?|reverses?)\s+(cancer|diabetes|autism|hiv|aids|alzheimer|covid)\s+(in\s+\d|naturally|completely|permanently)\b/i, weight: 0.9 },
      { id: 'mi05', label: 'chemtrail/5G/chip',         re: /\b(chemtrail|5g\s+(caus|spread|kill|activat)|microchip\s+(in|inside|via)\s+(vaccine|food)|nanobot)\b/i, weight: 0.9 },
      { id: 'mi06', label: 'depopulation agenda',       re: /\b(depopulation|population\s+reduction)\s+(agenda|plan|plot|conspiracy)\b/i, weight: 0.9 },
      { id: 'mi07', label: 'adrenochrome/satanic cabal',re: /\b(adrenochrome|satanic\s+(cabal|elite|ritual|panic)|pizzagate)\b/i, weight: 0.95 },
      { id: 'mi08', label: 'deep state is real/controls',re: /\bnew\s+world\s+order\s+(is|are)\s+(real|behind|controlling)\b/i, weight: 0.85 },
      // Contamination / suppression claims
      { id: 'mi09', label: 'poisoned supply',           re: /\b(poison(ing|ed)?|toxin|chemical)s?\s+(in|added\s+to)\s+(the\s+)?(water\s+supply|tap\s+water|food\s+supply|vaccines?)\b/i, weight: 0.85 },
      { id: 'mi10', label: 'doctors hiding cures',      re: /\b(doctors?|big\s+pharma|fda)\s+(don[\u2019']?t|won[\u2019']?t|are\s+hiding)\s+(want\s+you\s+to\s+know|tell\s+you|this|the\s+truth)\b/i, weight: 0.85 },
      { id: 'mi11', label: 'media suppression',         re: /\b(media|press|news)\s+(is\s+)?(suppressing|hiding|burying|covering\s+up)\s+(this|it|the\s+truth|the\s+story)\b/i, weight: 0.75 },
      { id: 'mi12', label: 'celebrity control claim',   re: /\b(bill\s+gates|george\s+soros|rothschild|wef)\b.{0,60}\b(control|fund|own|behind)\b.{0,60}\b(government|media|world|pandemic)\b/i, weight: 0.8 },
      // Softer signals — require stacking to hit threshold
      { id: 'mi13', label: 'do your own research',      re: /\bdo\s+your\s+(own\s+)?research\b/i, weight: 0.5 },
      { id: 'mi14', label: 'real truth/hidden reason',  re: /\bthe\s+real\s+(truth|reason|story|cause|agenda)\s+(is|they|behind)\b/i, weight: 0.55 },
      { id: 'mi15', label: 'sovereign citizen theory',  re: /\b(sovereign\s+citizen|strawman\s+(theory|account)|ucc\s+\d+\s+filing)\b/i, weight: 0.8 },
    ],
  };

  // ─── DENSITY CHECKS (structural heuristics, not pattern-based) ────────────────

  /**
   * Returns a 0–1 score for "wall of text with zero data density".
   * High density of abstract nouns, low density of numbers/proper nouns = likely slop.
   */
  function densityScore(text) {
    const words = text.trim().split(/\s+/).length;
    if (words < 40) return 0; // too short to judge

    const numberCount = (text.match(/\b\d[\d.,]*\b/g) || []).length;
    const dataRatio = numberCount / words;

    // Very long, no numbers, no links implied → possible filler
    if (words > 200 && dataRatio < 0.005) return 0.35;
    if (words > 400 && dataRatio < 0.003) return 0.5;
    return 0;
  }

  /**
   * Detects anaphora propaganda: ≥3 short sentences starting with the same word.
   * Catches patterns like "Only Grok speaks truth. Only truthful AI is safe. Only truth..."
   * or "This is war. This is tyranny. This is what they wanted."
   * Returns 0–0.9 score.
   */
  function anaphoraScore(text) {
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 5);
    if (sentences.length < 3) return 0;

    // Count leading words
    const leadCounts = {};
    for (const s of sentences) {
      const first = (s.match(/^\s*(\w+)/)?.[1] || '').toLowerCase();
      if (first) leadCounts[first] = (leadCounts[first] || 0) + 1;
    }
    const maxRepeat = Math.max(...Object.values(leadCounts));

    // 3 sentences with same opener in a short post = propaganda anaphora
    if (maxRepeat >= 3 && sentences.length <= 6) return 0.7;
    if (maxRepeat >= 4) return 0.85;
    return 0;
  }

  // ─── CORE DETECTION FUNCTION ──────────────────────────────────────────────────

  /**
   * Analyse a plain-text string for unwanted content signals.
   *
   * @param {string} text   - Extracted plain text of a DOM element.
   * @param {object} modes  - Which categories to check: { slop, ai, rage }
   * @returns {{
   *   flagged:  boolean,
   *   score:    number,       // 0–1
   *   category: string|null, // dominant category
   *   hits:     string[],    // matched pattern labels
   * }}
   */
  function detect(text, modes = { slop: true, ai: true, rage: true, misinfo: true }) {
    if (!text || text.trim().length < 30) {
      return { flagged: false, needsFactCheck: false, score: 0, category: null, hits: [] };
    }

    const scores = { slop: 0, ai: 0, rage: 0, misinfo: 0 };
    const hits = [];

    for (const [category, patterns] of Object.entries(PATTERNS)) {
      if (!modes[category]) continue;

      for (const p of patterns) {
        if (p.re.test(text)) {
          scores[category] = Math.min(1, scores[category] + p.weight);
          hits.push(`[${category}] ${p.label}`);
        }
      }
    }

    // Add density bonus to slop score
    if (modes.slop) {
      scores.slop = Math.min(1, scores.slop + densityScore(text));
      // Anaphora check: short posts with repetitive sentence-openers (propaganda style)
      scores.slop = Math.min(1, scores.slop + anaphoraScore(text));
    }

    // Pick dominant category
    const dominant = Object.entries(scores).reduce(
      (a, b) => (b[1] > a[1] ? b : a), ['none', 0]
    );

    const topScore = dominant[1];
    const THRESHOLD = 0.6;

    const dominantCategory = topScore >= THRESHOLD ? dominant[0] : null;

    return {
      flagged:        topScore >= THRESHOLD,
      // misinfo items are dimmed + fact-checked, not removed — signal this to content.js
      needsFactCheck: dominantCategory === 'misinfo',
      score:          parseFloat(topScore.toFixed(3)),
      category:       dominantCategory,
      hits,
    };
  }

  // ─── EXPORT ───────────────────────────────────────────────────────────────────

  // ─── PHASE 3 HOOK (ML escalation) ──────────────────────────────────────────
  // TODO(Phase 3): If result.flagged && result.score < 0.85, forward to the
  // SharedWorker running the quantized 4-class distilbert ONNX model for
  // confirmation before acting. The worker communicates back via MessageChannel.
  // Only ~5–15% of posts are expected to reach this stage.

  window.SlopDetector = { detect };

})();
