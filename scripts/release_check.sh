#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] JS syntax checks"
node --check content/detector.js
node --check content/content.js
node --check content/interceptor.js
node --check popup/popup.js
node --check background.js
node --check scripts/test_detector.js

echo "[2/4] JSON validation"
python3 -m json.tool manifest.json >/dev/null
python3 -m json.tool content/facts.json >/dev/null
python3 -m json.tool tests/fixtures/detector_cases.json >/dev/null

echo "[3/4] Detector fixtures"
node scripts/test_detector.js

echo "[4/4] Python scripts compile"
python3 -m py_compile scripts/train_nb.py

echo "Release checks passed"
