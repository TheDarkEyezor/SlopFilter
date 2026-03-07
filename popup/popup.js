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
  debugHighlight: false,
  debugScanAll:   false,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function applySettingsToUI() {
  $('masterToggle').checked = settings.enabled;
  document.body.classList.toggle('disabled', !settings.enabled);

  for (const [mode, active] of Object.entries(settings.modes)) {
    const el = document.querySelector(`[data-mode="${mode}"]`);
    if (el) el.checked = active;
  }

  $('debugToggle').checked       = settings.debugHighlight;
  $('debugScanAllToggle').checked = settings.debugScanAll;
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

$('debugToggle').addEventListener('change', e => {
  settings.debugHighlight = e.target.checked;
  pushSettings();
});

$('debugScanAllToggle').addEventListener('change', e => {
  settings.debugScanAll = e.target.checked;
  pushSettings();
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
  { enabled: true, modes: { slop: true, ai: true, rage: true, misinfo: true }, debugHighlight: false, debugScanAll: false, factCheckApiKey: '' },
  (stored) => {
    settings = { ...settings, ...stored };
    settings.modes = { slop: true, ai: true, rage: true, misinfo: true, ...stored.modes };
    settings.debugScanAll = stored.debugScanAll ?? false;
    if (fcKeyInput) fcKeyInput.value = stored.factCheckApiKey || '';
    applySettingsToUI();
    refreshStats();
  }
);
