#!/usr/bin/env python3
"""
Train lightweight token Naive Bayes models for SlopFilter.

Outputs:
  - models/nb_models.json

Datasets used (downloaded automatically):
  - Davidson hate/offensive language (rage proxy)
  - HC3 human-vs-ChatGPT answers (AI-text proxy)
"""
from __future__ import annotations

import csv
import io
import json
import math
import pathlib
import random
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "nb_train"
MODEL_PATH = ROOT / "models" / "nb_models.json"

TOKEN_RE = re.compile(r"[a-z][a-z0-9_'-]{1,20}")
RAGE_CUE_RE = re.compile(
    r"\b(truth|wake|sheeple|globalists?|elites?|invasion|replacement|rigged|censored|destroyed?|hoax|traitors?|patriots?|they)\b",
    re.I,
)

DAVIDSON_CSV_URL = (
    "https://raw.githubusercontent.com/t-davidson/"
    "hate-speech-and-offensive-language/master/data/labeled_data.csv"
)
HF_TREE_URL = "https://huggingface.co/api/datasets/Hello-SimpleAI/HC3/tree/main"

BLOCK_TOKENS = {
    "nigga", "niggas", "nigger", "niggers", "bitch", "bitches", "fuck", "fucking",
    "fuckin", "pussy", "dick", "hoes", "hoe", "ass", "shit",
}
STOP_TOKENS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
    "were", "was", "are", "you", "your", "our", "they", "them", "their", "it's",
    "its", "there", "these", "those", "into", "about", "what", "when", "where",
    "why", "which", "who", "would", "could", "should", "than",
}
RAGE_ALLOW = {
    "truth", "wake", "sheeple", "globalists", "globalist", "elite", "elites",
    "invasion", "replacement", "rigged", "censored", "agenda", "media", "patriot",
    "patriots", "traitor", "traitors", "corrupt", "secret", "outrage", "outraged",
    "furious", "destroyed", "hoax", "coverup", "cover", "lies", "lying", "stolen",
    "propaganda", "invaders", "invader", "belong", "silenced", "suppressed",
}
AI_ALLOW = {
    "certainly", "however", "therefore", "moreover", "furthermore", "additionally",
    "overall", "conclusion", "summary", "important", "notably", "comprehensive",
    "explore", "landscape", "insights", "consider", "ensure", "provides", "provide",
    "assist", "clarify", "generated", "model", "prompt", "synthetic", "deepfake",
    "dive", "delve", "navigate", "robust", "holistic", "seamlessly", "meanwhile",
    "basically", "probably", "maybe", "isn't", "aren't", "wouldn't", "didn't",
    "thanks", "thank", "welcome", "obviously", "really",
}


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "SlopFilter-Trainer/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def cached_fetch(url: str, path: pathlib.Path) -> bytes:
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = fetch_bytes(url)
    path.write_bytes(data)
    return data


def clean_text(text: str) -> str:
    return (
        (text or "")
        .replace("\\n", " ")
        .replace("\\r", " ")
        .replace("\\t", " ")
        .replace("\n", " ")
        .replace("\r", " ")
        .replace("\t", " ")
    )


def tokenize(text: str, allowed: set[str] | None = None) -> set[str]:
    toks = set(TOKEN_RE.findall(clean_text(text).lower()))
    out = set()
    for t in toks:
        if len(t) < 3:
            continue
        if t in STOP_TOKENS or t in BLOCK_TOKENS:
            continue
        if allowed is not None and t not in allowed:
            continue
        out.add(t)
    return out


def load_davidson() -> tuple[list[str], list[str]]:
    cache_path = DATA_DIR / "davidson_labeled_data.csv"
    raw = cached_fetch(DAVIDSON_CSV_URL, cache_path)
    pos: list[str] = []
    neg: list[str] = []

    with io.StringIO(raw.decode("utf-8", errors="ignore")) as f:
        reader = csv.DictReader(f)
        for row in reader:
            tweet = (row.get("tweet") or "").strip()
            if len(tweet) < 12:
                continue
            try:
                label = int(row.get("class", ""))
            except ValueError:
                continue

            if label in (0, 1):
                # Keep higher-rage subset to reduce "generic profanity" bias.
                if RAGE_CUE_RE.search(tweet):
                    pos.append(tweet)
            elif label == 2:
                neg.append(tweet)

    return pos, neg


def list_hc3_json_urls(max_files: int = 16) -> list[str]:
    cache_path = DATA_DIR / "hc3_tree.json"
    raw = cached_fetch(HF_TREE_URL, cache_path)
    tree = json.loads(raw.decode("utf-8", errors="ignore"))
    urls: list[str] = []
    for item in tree:
        path = item.get("path", "")
        size = int(item.get("size") or 0)
        # Prioritize parseable text files and avoid huge blobs.
        if not (path.endswith(".json") or path.endswith(".jsonl")):
            continue
        if size <= 0 or size > 20_000_000:
            continue
        quoted = urllib.parse.quote(path)
        urls.append(f"https://huggingface.co/datasets/Hello-SimpleAI/HC3/resolve/main/{quoted}")
    return urls[:max_files]


def maybe_collect_text(v, out: list[str]) -> None:
    if isinstance(v, str):
        t = v.strip()
        if len(t) >= 20:
            out.append(t)
        return
    if isinstance(v, list):
        for x in v:
            if isinstance(x, str):
                t = x.strip()
                if len(t) >= 20:
                    out.append(t)


def parse_hc3_file(raw: bytes) -> tuple[list[str], list[str]]:
    ai: list[str] = []
    human: list[str] = []
    text = raw.decode("utf-8", errors="ignore").strip()
    if not text:
        return ai, human

    def process_obj(obj: dict) -> None:
        maybe_collect_text(obj.get("chatgpt_answers"), ai)
        maybe_collect_text(obj.get("chatgpt_answer"), ai)
        maybe_collect_text(obj.get("gpt_answers"), ai)
        maybe_collect_text(obj.get("human_answers"), human)
        maybe_collect_text(obj.get("human_answer"), human)
        maybe_collect_text(obj.get("human"), human)

    if text[0] == "[":
        try:
            arr = json.loads(text)
            if isinstance(arr, list):
                for obj in arr:
                    if isinstance(obj, dict):
                        process_obj(obj)
        except json.JSONDecodeError:
            return ai, human
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                process_obj(obj)
    return ai, human


def load_hc3() -> tuple[list[str], list[str]]:
    ai: list[str] = []
    human: list[str] = []
    urls = list_hc3_json_urls()
    for i, url in enumerate(urls, 1):
        name = f"hc3_{i}.jsonl"
        cache_path = DATA_DIR / name
        try:
            raw = cached_fetch(url, cache_path)
        except Exception:
            continue
        a, h = parse_hc3_file(raw)
        ai.extend(a)
        human.extend(h)
        if len(ai) >= 35_000 and len(human) >= 35_000:
            break
    return ai, human


def downsample_to_match(a: list[str], b: list[str], seed: int = 7) -> tuple[list[str], list[str]]:
    rng = random.Random(seed)
    n = min(len(a), len(b))
    if len(a) > n:
        a = rng.sample(a, n)
    if len(b) > n:
        b = rng.sample(b, n)
    return a, b


def train_nb(
    pos_docs: list[str],
    neg_docs: list[str],
    top_k: int = 36,
    allowed: set[str] | None = None,
) -> dict:
    pos_docs, neg_docs = downsample_to_match(pos_docs, neg_docs)
    if not pos_docs or not neg_docs:
        raise RuntimeError("Not enough docs for training.")

    pos_counts = Counter()
    neg_counts = Counter()
    for d in pos_docs:
        pos_counts.update(tokenize(d, allowed))
    for d in neg_docs:
        neg_counts.update(tokenize(d, allowed))

    npos = len(pos_docs)
    nneg = len(neg_docs)
    all_tokens = set(pos_counts) | set(neg_counts)
    scored: list[tuple[str, float]] = []
    for t in all_tokens:
        # log-odds on document frequencies with simple Laplace smoothing
        p_pos = (pos_counts[t] + 1) / (npos + 2)
        p_neg = (neg_counts[t] + 1) / (nneg + 2)
        score = math.log(p_pos / p_neg)
        if abs(score) > 0.12:
            scored.append((t, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    pos_tokens = scored[:top_k]
    pos_set = {t for t, _ in pos_tokens}
    neg_tokens = []
    for t, s in sorted(scored, key=lambda x: x[1]):
        if t in pos_set:
            continue
        neg_tokens.append((t, s))
        if len(neg_tokens) >= top_k:
            break

    pos = {t: int(max(1, min(40, round((pos_counts[t] / npos) * 2000)))) for t, _ in pos_tokens}
    neg = {t: int(max(1, min(40, round((neg_counts[t] / nneg) * 2000)))) for t, _ in neg_tokens}

    return {
        "prior": round(npos / (npos + nneg), 4),
        "pos": pos,
        "neg": neg,
        "meta": {
            "npos": npos,
            "nneg": nneg,
            "top_k": top_k,
        },
    }


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)

    print("Downloading/loading Davidson dataset...")
    rage_pos, rage_neg = load_davidson()
    print(f"Rage docs: pos={len(rage_pos)} neg={len(rage_neg)}")

    print("Downloading/loading HC3 dataset...")
    ai_pos, ai_neg = load_hc3()
    print(f"AI docs: pos={len(ai_pos)} neg={len(ai_neg)}")

    if len(rage_pos) < 500 or len(rage_neg) < 500:
        raise RuntimeError("Insufficient rage training docs after filtering.")
    if len(ai_pos) < 1000 or len(ai_neg) < 1000:
        raise RuntimeError("Insufficient AI training docs after parsing HC3.")

    rage_model = train_nb(rage_pos, rage_neg, top_k=22, allowed=RAGE_ALLOW)
    ai_model = train_nb(ai_pos, ai_neg, top_k=26, allowed=AI_ALLOW)

    artifact = {
        "version": 1,
        "sources": {
            "rage": "Davidson hate/offensive language",
            "ai": "HC3 human-vs-chatgpt",
        },
        "models": {
            "rage": {"prior": rage_model["prior"], "pos": rage_model["pos"], "neg": rage_model["neg"]},
            "ai": {"prior": ai_model["prior"], "pos": ai_model["pos"], "neg": ai_model["neg"]},
        },
        "stats": {
            "rage": rage_model["meta"],
            "ai": ai_model["meta"],
        },
    }
    MODEL_PATH.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {MODEL_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
