/**
 * popup.js — SlopFilter popup controller
 *
 * Reads current settings from storage, syncs UI state,
 * and pushes changes to the active tab's content script.
 */
'use strict';

const $ = id => document.getElementById(id);

// ─── STATE ────────────────────────────────────────────────────────────────────

let settings = {
  enabled: true,
  modes: { slop: true, ai: true, rage: true, misinfo: true },
  siteModes: { twitter: true, linkedin: true },
  debugHighlight: false,
  debugScanAll:   false,
  replacementMode: 'off',
  factCategories: ['all'],
};

const FACT_CATEGORY_VALUES = ['all', 'science', 'space', 'animals', 'history', 'math', 'technology', 'earth'];

function normalizeFactCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return ['all'];
  const clean = categories
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => FACT_CATEGORY_VALUES.includes(v));
  if (clean.length === 0 || clean.includes('all')) return ['all'];
  return [...new Set(clean)];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function applySettingsToUI() {
  $('masterToggle').checked = settings.enabled;
  document.body.classList.toggle('disabled', !settings.enabled);

  for (const [mode, active] of Object.entries(settings.modes)) {
    const el = document.querySelector(`[data-mode="${mode}"]`);
    if (el) el.checked = active;
  }
  for (const [site, active] of Object.entries(settings.siteModes || {})) {
    const el = document.querySelector(`[data-site="${site}"]`);
    if (el) el.checked = active;
  }

  $('debugToggle').checked       = settings.debugHighlight;
  $('debugScanAllToggle').checked = settings.debugScanAll;

  const activeRadio = document.querySelector(`[name="replacementMode"][value="${settings.replacementMode || 'off'}"]`);
  if (activeRadio) activeRadio.checked = true;

  const selectedFacts = normalizeFactCategories(settings.factCategories);
  document.querySelectorAll('[data-fact-category]').forEach(el => {
    const key = el.getAttribute('data-fact-category');
    el.checked = selectedFacts.includes('all') ? key === 'all' : selectedFacts.includes(key);
  });
}

function pushSettings() {
  chrome.storage.sync.set(settings);

  // Send to active tab's content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: 'UPDATE_SETTINGS',
      settings,
    }).catch(() => {});
  });
}

// ─── STATS ────────────────────────────────────────────────────────────────────

function refreshStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATS' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res) $('removedCount').textContent = res.removedCount ?? 0;
    });
  });
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────

$('masterToggle').addEventListener('change', e => {
  settings.enabled = e.target.checked;
  document.body.classList.toggle('disabled', !settings.enabled);
  pushSettings();
});

document.querySelectorAll('[data-mode]').forEach(checkbox => {
  checkbox.addEventListener('change', e => {
    const mode = e.target.getAttribute('data-mode');
    settings.modes[mode] = e.target.checked;
    pushSettings();
  });
});

document.querySelectorAll('[data-site]').forEach(checkbox => {
  checkbox.addEventListener('change', e => {
    const site = e.target.getAttribute('data-site');
    settings.siteModes[site] = e.target.checked;
    pushSettings();
  });
});

$('debugToggle').addEventListener('change', e => {
  settings.debugHighlight = e.target.checked;
  pushSettings();
});

$('debugScanAllToggle').addEventListener('change', e => {
  settings.debugScanAll = e.target.checked;
  pushSettings();
});

document.querySelectorAll('[name="replacementMode"]').forEach(radio => {
  radio.addEventListener('change', e => {
    settings.replacementMode = e.target.value;
    pushSettings();
  });
});

document.querySelectorAll('[data-fact-category]').forEach(checkbox => {
  checkbox.addEventListener('change', e => {
    const category = e.target.getAttribute('data-fact-category');
    let current = normalizeFactCategories(settings.factCategories);

    if (category === 'all') {
      settings.factCategories = ['all'];
      applySettingsToUI();
      pushSettings();
      return;
    }

    current = current.filter(c => c !== 'all');
    if (e.target.checked) current.push(category);
    else current = current.filter(c => c !== category);

    settings.factCategories = normalizeFactCategories(current);
    applySettingsToUI();
    pushSettings();
  });
});

$('rescanBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'RESCAN' }, () => {
      if (chrome.runtime.lastError) return;
      setTimeout(refreshStats, 600);
    });
  });
});

// ─── FACT-CHECK API KEY ───────────────────────────────────────────────────────

const fcKeyInput = $('fcApiKey');
const fcKeySaved = $('fcApiKeySaved');

$('fcApiKeySave').addEventListener('click', () => {
  const key = fcKeyInput.value.trim();
  chrome.storage.sync.set({ factCheckApiKey: key }, () => {
    fcKeySaved.hidden = false;
    setTimeout(() => { fcKeySaved.hidden = true; }, 1800);
  });
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(
  { enabled: true, modes: { slop: true, ai: true, rage: true, misinfo: true }, siteModes: { twitter: true, linkedin: true }, debugHighlight: false, debugScanAll: false, factCheckApiKey: '', replacementMode: 'off', factCategories: ['all'] },
  (stored) => {
    settings = { ...settings, ...stored };
    settings.modes = { slop: true, ai: true, rage: true, misinfo: true, ...stored.modes };
    settings.siteModes = { twitter: true, linkedin: true, ...stored.siteModes };
    settings.debugScanAll    = stored.debugScanAll    ?? false;
    settings.replacementMode = stored.replacementMode === 'fun_facts' ? 'fun_facts' : 'off';
    settings.factCategories = normalizeFactCategories(stored.factCategories);
    if (fcKeyInput) fcKeyInput.value = stored.factCheckApiKey || '';
    applySettingsToUI();
    refreshStats();
  }
);
