# Changelog

## 0.2.0 - 2026-03-08

- Added per-site toggles (`twitter`, `linkedin`) and global kill-switch behavior.
- Added schema-safe settings migration with defaults in background service worker.
- Restricted scanning/filtering to supported sites only.
- Added performance guardrails (queue cap, mutation budget, bounded video probes, debug slow-scan logs).
- Improved video attachment detection for short-text posts with delayed first-frame probes.
- Added undo action for replaced posts (`fun facts` placeholders).
- Added stricter short-text rage threshold to reduce false positives.
- Expanded rage/inflammatory heuristics in DOM + network detector paths.
- Moved replacement facts to `content/facts.json` and added category selection in popup.
- Added detector fixture tests and release check script.
