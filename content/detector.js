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
      { id: 's21', label: 'only X speaks truth',    re: /\bonly\s+\w+\s+(speaks?|knows?|tells?|shows?|reveals?|understands?)\s+the\s+truth\b/i, weight: 0.45 },
      { id: 's22', label: 'only truthful X',        re: /\bonly\s+(truthful|unbiased|uncensored|based)\s+(ai|source|news|information|platform|media)\b/i, weight: 0.45 },
      { id: 's23', label: 'X is the future',        re: /\b\w+\s+is\s+the\s+(only|true|real|future)\s+(path|way|truth|source|answer|solution)\b/i, weight: 0.6 },
      { id: 's24', label: 'censored/banned/silenced',re: /\b(censored|silenced|shadow.?banned|deplatformed|cancelled)\s+(for\s+)?(telling|speaking|saying|posting)?\s*(the\s+)?truth\b/i, weight: 0.75 },
      // Truth-bait / bare truth assertions (common in AI-generated image posts and propaganda)
      { id: 's25', label: 'do you want the truth',  re: /\bdo\s+you\s+want\s+(to\s+)?(know\s+)?the\s+truth\b/i, weight: 0.7 },
      { id: 's26', label: 'this/that is the truth',  re: /\b(this|that)\s+is\s+the\s+(?:real\s+|whole\s+)?truth\b/i, weight: 0.65 },
      { id: 's27', label: 'truth/reality bomb',      re: /\bthe\s+truth\s+(is|will|always|never|shall)\b[^.!?]{0,60}[.!?]/i, weight: 0.5 },
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
      // AI image/content attribution lines — explicit signals of generated content
      { id: 'a19', label: 'AI image attribution',   re: /\b(made|created|generated|imagined|designed|built)\s+(by|with|using)\s+(grok|dall[- ]?e|midjourney|stable\s+diffusion|firefly|ideogram|sora|openai|gemini|claude|copilot|kling|runway)\b/i, weight: 0.9 },
      { id: 'a20', label: 'Grok Imagine tag',       re: /\bgrok\s+imagine\b|@grok\s+imagine\b/i, weight: 0.85 },
      { id: 'a21', label: 'AI edited/enhanced media',re: /\b(edited|enhanced|upscaled|restored|retouched|remixed)\s+(by|with|using)\s+(ai|grok|dall[- ]?e|midjourney|stable\s+diffusion|runway|firefly|ideogram|flux|kling)\b/i, weight: 0.85 },
      { id: 'a22', label: 'deepfake/faceswap marker',re: /\b(deepfake|face\s*swap|faceswap|synthetic\s+video)\b/i, weight: 0.9 },
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
      // Dehumanising language applied to groups (nearly always political rage-bait)
      { id: 'r18', label: 'dehumanize parasitic/vermin', re: /\b(parasitic|verminous?|subhuman|cockroach|locust|infestation|plague)\b/i, weight: 0.9 },
      // Binary-choice political propaganda  "you will have 2 choices" / "2 options remain"
      { id: 'r19', label: 'binary choice propaganda',    re: /\b(you\s+(will\s+)?have\s+(only\s+)?\d\s+choices?|two\s+choices?\s+(remain|only|left))\b/i, weight: 0.85 },
      // Ethnonationalist replacement / extinction rhetoric
      { id: 'r20', label: 'replacement rhetoric',        re: /\b(great\s+replacement|demographic\s+replacement|population\s+replacement|white\s+genocide|ethnic\s+replacement)\b/i, weight: 0.95 },
      { id: 'r21', label: 'extinction/end of a people',  re: /\b(extinction|erasure|end|death)\s+(of|as)\s+(a\s+|the\s+)?(race|people|native|culture|civilis|nation)|\b(native\s+peoples?|rightful\s+heirs?|stewards?\s+(of\s+)?our\s+(homeland|land|country))\b/i, weight: 0.9 },
      // UK far-right rage-bait framing
      { id: 'r22', label: 'two-tier policing',           re: /\btwo[- ]tier\s+polic(ing|e|ed)\b/i, weight: 0.8 },
      { id: 'r23', label: 'stop the boats',              re: /\bstop\s+the\s+boats\b/i, weight: 0.7 },
      { id: 'r24', label: 'send them back',              re: /\bsend\s+them\s+back\b/i, weight: 0.75 },
      { id: 'r25', label: 'mass migration panic',        re: /\b(mass\s+migration|invasion)\b/i, weight: 0.7 },
      { id: 'r26', label: 'grooming gangs cover-up',     re: /\bgrooming\s+gangs?\b.{0,40}\b(cover.?up|hidden|suppressed)\b/i, weight: 0.8 },
      // Weaponized vagueness / plausible-deniability framing
      { id: 'r27', label: 'just asking questions',       re: /\b(just|only)\s+asking\s+questions?\b/i, weight: 0.75 },
      { id: 'r28', label: 'many are saying',             re: /\b(many|lots\s+of)\s+(people\s+)?(are\s+)?saying\b/i, weight: 0.65 },
      { id: 'r29', label: 'not racist but',              re: /\b(i['\u2019]?m|im|we['\u2019]?re|were)?\s*not\s+(racist|xenophobic)\s+but\b/i, weight: 0.95 },
      { id: 'r30', label: 'they do not belong here',     re: /\b(they|these\s+people)\s+(do\s+not|don['\u2019]?t)\s+belong\s+(here|in\s+our\s+country|in\s+our\s+society)\b/i, weight: 0.95 },
      { id: 'r31', label: 'protect from them',           re: /\b(protect|save)\s+(our\s+)?(kids|children|women|country|culture)\s+from\s+(them|those\s+people)\b/i, weight: 0.9 },
      { id: 'r32', label: 'illegal invaders',            re: /\b(illegal\s+invaders?|invading\s+hordes?)\b/i, weight: 0.9 },
      { id: 'r33', label: 'engagement outrage bait',     re: /\b(retweet|share|repost)\s+if\s+you\s+(agree|care|support)|\bif\s+you\s+agree\s+(share|retweet|repost)\b/i, weight: 0.85 },
      { id: 'r34', label: 'absolute condemnation',       re: /\b(always|never|everyone|no\s+one)\b.{0,35}\b(liar|evil|traitor|disgusting|corrupt)\b/i, weight: 0.75 },
      { id: 'r35', label: 'enemy outgroup framing',      re: /\b(us\s+vs\s+them|enemy\s+within|traitors?\s+among\s+us|they\s+are\s+coming\s+for)\b/i, weight: 0.8 },
      { id: 'r36', label: 'boycott/punish command',      re: /\b(boycott|punish|expose|shame)\s+(them|these\s+people|anyone\s+who)\b/i, weight: 0.75 },
      { id: 'r37', label: 'question trap outrage',       re: /\bwhy\s+is\s+nobody\s+talking\s+about\b|\bwhat\s+are\s+they\s+hiding\b/i, weight: 0.8 },
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
      { id: 'mi16', label: 'unnamed insiders',          re: /\b(insiders?|sources?|experts?)\s+(say|said|confirm|confirmed)\b.{0,40}\b(won['\u2019]?t|cannot|can['\u2019]?t)\s+(say|name|be\s+named)\b/i, weight: 0.75 },
      { id: 'mi17', label: 'everyone knows truth',      re: /\b(everyone\s+knows|it['\u2019]?s\s+obvious)\b.{0,40}\b(they\s+lie|media\s+lies|cover.?up)\b/i, weight: 0.7 },
      { id: 'mi18', label: 'heard it from',             re: /\b(i\s+heard|we\s+heard|rumor\s+has\s+it)\b.{0,45}\b(therefore|so)\b/i, weight: 0.6 },
    ],
  };

  const VAGUE_HEDGE_RE = /\b(apparently|allegedly|supposedly|rumou?r|rumor|maybe|might|could|perhaps|i\s+heard|many\s+are\s+saying|people\s+are\s+saying|i['\u2019]?m\s+just\s+asking)\b/gi;
  const TARGET_GROUP_RE = /\b(immigrants?|migrants?|muslims?|jews?|trans\s+people|gay\s+people|leftists?|liberals?|conservatives?|refugees?|foreigners?|minorities?|those\s+people|they)\b/gi;
  const HARMS_RE = /\b(replace|ruin|destroy|infest|poison|steal|control|corrupt|invade|groom|brainwash|pollute|breed)\b/gi;
  const OUTRAGE_MORAL_RE = /\b(evil|disgusting|traitor|traitorous|corrupt|sickening|vile|shameful|depraved)\b/gi;
  const ABSOLUTIST_RE = /\b(always|never|everyone|nobody|all\s+of\s+them|none\s+of\s+them)\b/gi;
  const MOBILIZE_RE = /\b(share|retweet|repost|boycott|fight\s+back|wake\s+up|stand\s+up)\b/gi;
  const TOKEN_RE = /[a-z][a-z0-9_'-]{1,20}/g;

  // Lightweight in-memory multinomial Naive Bayes token models.
  // These are intentionally small and fast; they provide softer probability
  // signals to complement regex patterns rather than replacing them.
  const NB_MODELS = {
    rage: {
      prior: 0.08,
      pos: {
        truth: 40, wake: 40, elite: 8, sheeple: 18, globalists: 17, invasion: 21,
        migrants: 12, immigrants: 13, media: 12, corrupt: 14, rigged: 15,
        replacement: 23, genocide: 20, parasitic: 14, vermin: 14, belong: 16,
        destroyed: 10, censored: 15, traitors: 13, patriots: 11, hoax: 14,
        lying: 12, stolen: 16, agenda: 14, cover: 10, secret: 12
      },
      neg: {
        update: 14, report: 12, data: 18, study: 17, analysis: 17, source: 12,
        methodology: 8, evidence: 14, meeting: 9, project: 9, product: 8,
        roadmap: 8, interview: 6, tutorial: 7, learning: 8, research: 14,
        documentation: 11, changelog: 6, release: 7, summary: 10
      },
    },
    ai: {
      prior: 0.1,
      pos: {
        important: 40, ensure: 40, overall: 40, additionally: 40, provide: 40,
        consider: 40, however: 40, provides: 40, summary: 24, therefore: 24,
        comprehensive: 18, clarify: 17, navigate: 13, explore: 12, assist: 11,
        insights: 10, landscape: 8, prompt: 8, model: 28, synthetic: 7,
        robust: 8, conclusion: 6, certainly: 6, generated: 14, delve: 9,
        midjourney: 12, dalle: 12, diffusion: 12, deepfake: 11
      },
      neg: {
        maybe: 20, probably: 20, basically: 20, "isn't": 20, "aren't": 16,
        "wouldn't": 15, welcome: 18, thanks: 18, thank: 16, really: 18,
        "didn't": 18, obviously: 12, meanwhile: 8, bug: 12, fix: 12, stack: 10,
        crash: 9, repro: 10, commit: 9, benchmark: 12, cpu: 8, memory: 8,
        latency: 9, docs: 8, npm: 7, build: 8, deploy: 7
      },
    },
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
   * or "If you do not want X... If you do not want Y... If you do not want Z..."
   *
   * Returns { score, category } so the caller can add to the right bucket:
   *   - "if / we / they / our / never" openers → political mobilisation → rage
   *   - everything else (only / this / the / ...) → filler/slop propaganda → slop
   */
  function anaphoraScore(text) {
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 5);
    if (sentences.length < 3) return { score: 0, category: 'slop' };

    // Count leading words
    const leadCounts = {};
    for (const s of sentences) {
      const first = (s.match(/^\s*(\w+)/)?.[1] || '').toLowerCase();
      if (first) leadCounts[first] = (leadCounts[first] || 0) + 1;
    }

    const [maxWord, maxRepeat] = Object.entries(leadCounts)
      .reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);

    // Us-vs-them / conditional-threat openers signal political rage-bait,
    // not generic AI filler.
    const RAGE_LEADERS = new Set(['if', 'we', 'they', 'our', 'never', 'you', 'not']);
    const category = RAGE_LEADERS.has(maxWord) ? 'rage' : 'slop';

    if (maxRepeat >= 3 && sentences.length <= 8) return { score: 0.7, category };
    if (maxRepeat >= 4) return { score: 0.85, category };
    return { score: 0, category: 'slop' };
  }

  /**
   * Detect "vague but harmful" framing:
   * - lots of hedging/unnamed claims ("people are saying", "allegedly")
   * - group-targeted accusations without concrete evidence
   *
   * Returns additive boosts for rage + misinfo channels.
   */
  function vagueSmearScore(text) {
    const words = text.trim().split(/\s+/).length;
    if (words < 18) return { rage: 0, misinfo: 0 };

    const hedgeCount = (text.match(VAGUE_HEDGE_RE) || []).length;
    const groupCount = (text.match(TARGET_GROUP_RE) || []).length;
    const harmCount = (text.match(HARMS_RE) || []).length;
    const numberCount = (text.match(/\b\d[\d.,]*\b/g) || []).length;
    const hasLink = /https?:\/\//i.test(text);

    let rage = 0;
    let misinfo = 0;

    if (hedgeCount >= 2 && groupCount >= 1) {
      rage += 0.35;
      misinfo += 0.35;
    }
    if (hedgeCount >= 1 && groupCount >= 1 && harmCount >= 1) {
      rage += 0.45;
      misinfo += 0.25;
    }
    // No concrete markers (numbers/links) but strong accusatory framing.
    if (groupCount >= 1 && harmCount >= 1 && numberCount === 0 && !hasLink && words > 28) {
      rage += 0.25;
      misinfo += 0.25;
    }

    return {
      rage: Math.min(0.8, rage),
      misinfo: Math.min(0.8, misinfo),
    };
  }

  function inflammatoryStyleScore(text) {
    const words = text.trim().split(/\s+/).length;
    if (words < 10) return 0;

    const outrage = (text.match(OUTRAGE_MORAL_RE) || []).length;
    const absolutes = (text.match(ABSOLUTIST_RE) || []).length;
    const mobilize = (text.match(MOBILIZE_RE) || []).length;
    const excl = (text.match(/!/g) || []).length;
    const qmarks = (text.match(/\?/g) || []).length;

    let score = 0;
    if (outrage >= 1 && absolutes >= 1) score += 0.25;
    if (outrage >= 1 && /\b(immigrants?|migrants?|muslims?|jews?|trans\s+people|gay\s+people|leftists?|liberals?|conservatives?|refugees?|foreigners?|minorities?|those\s+people|they)\b/i.test(text)) score += 0.3;
    if (mobilize >= 1 && (outrage >= 1 || absolutes >= 1)) score += 0.25;
    if (excl >= 3 || qmarks >= 3) score += 0.12;
    return Math.min(0.65, score);
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function tokenizeLower(text) {
    const tokens = text.toLowerCase().match(TOKEN_RE);
    return tokens || [];
  }

  function naiveBayesProb(text, model) {
    const tokens = tokenizeLower(text);
    if (tokens.length === 0) return 0;

    const posCounts = model.pos;
    const negCounts = model.neg;
    const vocab = new Set([...Object.keys(posCounts), ...Object.keys(negCounts)]);
    const v = Math.max(1, vocab.size);
    const posTotal = Object.values(posCounts).reduce((a, b) => a + b, 0);
    const negTotal = Object.values(negCounts).reduce((a, b) => a + b, 0);
    let llr = Math.log((model.prior || 0.1) / (1 - (model.prior || 0.1)));

    // Use unique tokens to reduce over-weighting repeated slogans.
    const uniq = new Set(tokens);
    for (const t of uniq) {
      const cp = (posCounts[t] || 0) + 1;
      const cn = (negCounts[t] || 0) + 1;
      llr += Math.log(cp / (posTotal + v)) - Math.log(cn / (negTotal + v));
    }
    return sigmoid(llr);
  }

  function bayesBoost(prob, low = 0.62, high = 0.86) {
    if (prob < low) return 0;
    if (prob >= high) return 0.6;
    return 0.2 + ((prob - low) / (high - low)) * 0.4;
  }

  // ─── CORE DETECTION FUNCTION ──────────────────────────────────────────────────

  /**
   * Analyse a plain-text string for unwanted content signals.
   *
   * @param {string} text   - Extracted plain text of a DOM element.
   * @param {object} modes  - Which categories to check: { slop, ai, rage }
   * @returns {{
   *   flagged:  boolean,
   *   score:    number,       // 0–1 (dominant category score)
   *   category: string|null, // dominant category
   *   topCategory: string,   // dominant category even below threshold
   *   scores:   object,      // per-category scores
   *   hits:     string[],    // matched pattern labels
   * }}
   */
  function detect(text, modes = { slop: true, ai: true, rage: true, misinfo: true }) {
    if (!text || text.trim().length < 30) {
      return {
        flagged: false,
        needsFactCheck: false,
        score: 0,
        category: null,
        topCategory: 'none',
        scores: { slop: 0, ai: 0, rage: 0, misinfo: 0 },
        hits: [],
      };
    }

    const scores = { slop: 0, ai: 0, rage: 0, misinfo: 0 };
    const hitCounts = { slop: 0, ai: 0, rage: 0, misinfo: 0 };
    const hits = [];

    for (const [category, patterns] of Object.entries(PATTERNS)) {
      if (!modes[category]) continue;

      for (const p of patterns) {
        if (p.re.test(text)) {
          scores[category] = Math.min(1, scores[category] + p.weight);
          hitCounts[category] += 1;
          hits.push(`[${category}] ${p.label}`);
        }
      }
    }

    // Add density bonus to slop score
    if (modes.slop) {
      scores.slop = Math.min(1, scores.slop + densityScore(text));
    }
    // Anaphora: route to slop or rage depending on the dominant lead word
    if (modes.slop || modes.rage) {
      const anaphora = anaphoraScore(text);
      if (anaphora.score > 0) {
        const target = (anaphora.category === 'rage' && modes.rage) ? 'rage' : 'slop';
        if (modes[target]) scores[target] = Math.min(1, scores[target] + anaphora.score);
      }
    }
    // Vague smear rhetoric often mixes disinformation and hateful targeting.
    if (modes.rage || modes.misinfo) {
      const vague = vagueSmearScore(text);
      if (modes.rage && vague.rage > 0) {
        scores.rage = Math.min(1, scores.rage + vague.rage);
      }
      if (modes.misinfo && vague.misinfo > 0) {
        scores.misinfo = Math.min(1, scores.misinfo + vague.misinfo);
      }
    }
    if (modes.rage) {
      const infScore = inflammatoryStyleScore(text);
      if (infScore > 0) {
        scores.rage = Math.min(1, scores.rage + infScore);
      }
    }
    // Naive Bayes probabilities (token model) provide softer signals than regex.
    if (modes.rage) {
      const rageProb = naiveBayesProb(text, NB_MODELS.rage);
      const boost = bayesBoost(rageProb, 0.64, 0.9);
      if (boost > 0) {
        scores.rage = Math.min(1, scores.rage + boost);
        hits.push(`[rage] nb:${rageProb.toFixed(2)}`);
      }
    }
    if (modes.ai) {
      const aiProb = naiveBayesProb(text, NB_MODELS.ai);
      const boost = bayesBoost(aiProb, 0.66, 0.9);
      if (boost > 0) {
        scores.ai = Math.min(1, scores.ai + boost);
        hits.push(`[ai] nb:${aiProb.toFixed(2)}`);
      }
    }

    // Pick dominant category
    const dominant = Object.entries(scores).reduce(
      (a, b) => (b[1] > a[1] ? b : a), ['none', 0]
    );

    const topScore = dominant[1];
    const wordCount = text.trim().split(/\s+/).length;
    const THRESHOLD = 0.6;
    const effectiveThreshold =
      (dominant[0] === 'rage' && wordCount < 14) ? 0.72 : THRESHOLD;

    let dominantCategory = topScore >= effectiveThreshold ? dominant[0] : null;
    // Rage/slop arbitration: if rage is close and has stronger signal count,
    // prefer rage classification to avoid political rage-bait being labelled slop.
    if (dominantCategory && dominantCategory !== 'rage' && modes.rage) {
      if (scores.rage >= THRESHOLD && (scores.rage + 0.05 >= scores.slop || hitCounts.rage > hitCounts.slop)) {
        dominantCategory = 'rage';
      }
    }
    const roundedScores = {
      slop: parseFloat(scores.slop.toFixed(3)),
      ai: parseFloat(scores.ai.toFixed(3)),
      rage: parseFloat(scores.rage.toFixed(3)),
      misinfo: parseFloat(scores.misinfo.toFixed(3)),
    };

    return {
      flagged:        topScore >= effectiveThreshold,
      // misinfo items are dimmed + fact-checked, not removed — signal this to content.js
      needsFactCheck: dominantCategory === 'misinfo',
      score:          parseFloat(topScore.toFixed(3)),
      category:       dominantCategory,
      topCategory:    dominant[0],
      scores:         roundedScores,
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
