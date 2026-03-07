# SlopFilter

Real-time detection and removal of slop, rage-bait, AI-generated filler, and misinformation from Twitter/X and LinkedIn.

Filtered posts are replaced with a fun fact from science, space, animals, history, or maths — your choice.

---

## What it filters

| Category | Examples |
|---|---|
| **Slop & Corporate Filler** | "In today's fast-paced world…", "delve into", LinkedIn buzzword soup |
| **AI-Generated Copy** | "As an AI language model…", em-dash overuse, "certainly, here's…" |
| **Rage-bait & Outrage** | Hypothetical dilemmas, dehumanising language, binary-choice propaganda |
| **Misinformation** | Conspiracy claims, suppression rhetoric, miracle cure claims (dimmed + fact-checked) |

---

## Installation (Chrome / Arc / Edge — no store required)

### 1. Download the ZIP

Go to the [Releases page](../../releases) and download the latest `SlopFilter-x.x.x.zip`.

### 2. Unpack it

Unzip the file anywhere permanent on your computer — the browser loads the extension **live from that folder**, so don't delete it after installing.

```
unzip SlopFilter-0.1.0.zip -d SlopFilter
```

Or just double-click the ZIP in Finder.

### 3. Open the extensions page

| Browser | URL to open |
|---|---|
| Chrome | `chrome://extensions` |
| Arc | `arc://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |

### 4. Enable Developer Mode

Toggle **Developer mode** on — it's in the top-right corner of the extensions page.

![Developer mode toggle](https://i.imgur.com/placeholder.png)

### 5. Load the unpacked extension

Click **Load unpacked** → select the folder you unzipped in step 2 (the one that contains `manifest.json`).

SlopFilter will appear in your extension list and the ◉ icon will show in your toolbar.

### 6. Pin it (optional but recommended)

Click the puzzle-piece icon in the Chrome toolbar → click the pin next to SlopFilter so the popup is always one click away.

---

## Usage

Click the **◉ SlopFilter** icon in the toolbar to open the popup.

- **Detection modes** — toggle Slop, AI, Rage-bait, and Misinformation on or off independently.
- **Replace filtered posts with** — choose a fun-fact category (Science, Space, Animals, History, Maths) or leave on *Remove* to delete posts silently.
- **Highlight instead of remove** — dev mode: colours flagged posts instead of removing them, and shows the score.
- **Show all scanned tweets** — outlines every element the scanner touches (useful for debugging).
- **↺ Re-scan page** — force a fresh pass of the current page.

### Misinformation fact-checking (optional)

For claim verdicts from PolitiFact, Snopes, AFP, and Reuters, get a free [Google Fact Check Tools API key](https://developers.google.com/fact-check/tools/api/reference/rest) and paste it into the **Fact-check API** box in the popup.

Without a key, the extension falls back to Wikipedia context only.

---

## Updating

When a new release is available:

1. Download the new ZIP from the Releases page.
2. Unzip it, **replacing the existing folder** (same location).
3. Go to `chrome://extensions` and click the **↺ refresh** icon on the SlopFilter card.

---

## Uninstalling

Go to `chrome://extensions`, find SlopFilter, and click **Remove**. You can then delete the unzipped folder.

---

## Privacy

- No data is sent to any server controlled by this extension.
- Detection runs entirely on-device.
- The only outbound request is to the **Google Fact Check Tools API** — and only when you provide your own API key and a post is flagged as potential misinformation.
- Settings are stored locally via `chrome.storage.sync` (synced across your own Chrome profile).

---

## Contributing / building from source

```bash
git clone https://github.com/YOUR_USERNAME/SlopFilter.git
cd SlopFilter
# No build step — plain JS, load unpacked directly
```

To package a release ZIP:

```bash
zip -r ../SlopFilter-$(grep '"version"' manifest.json | grep -o '[0-9.]*').zip . \
  --exclude "*.git*" --exclude "*.DS_Store" --exclude "gen_icons.py"
```
