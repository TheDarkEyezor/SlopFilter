#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const detectorPath = path.join(root, 'content', 'detector.js');
const fixturesPath = path.join(root, 'tests', 'fixtures', 'detector_cases.json');

const sandbox = {
  window: {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(detectorPath, 'utf8'), sandbox, { filename: 'detector.js' });

if (!sandbox.window.SlopDetector || typeof sandbox.window.SlopDetector.detect !== 'function') {
  console.error('Detector did not export window.SlopDetector.detect');
  process.exit(1);
}

const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
let failed = 0;

for (const tc of fixtures) {
  const r = sandbox.window.SlopDetector.detect(tc.text, tc.modes);
  let ok = true;

  if (Object.prototype.hasOwnProperty.call(tc, 'expect_flagged')) {
    ok = ok && (r.flagged === tc.expect_flagged);
  }
  if (tc.expect_category) {
    ok = ok && (r.category === tc.expect_category);
  }
  if (tc.expect_category_not) {
    ok = ok && (r.category !== tc.expect_category_not);
  }

  if (!ok) {
    failed++;
    console.error(`FAIL: ${tc.name}`);
    console.error(`  result: ${JSON.stringify(r)}`);
  } else {
    console.log(`PASS: ${tc.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} detector fixture(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${fixtures.length} detector fixtures passed`);
