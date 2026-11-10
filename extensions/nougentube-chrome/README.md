# NouGenTube (Chrome, MV3)

A side panel next to the YouTube player with Transcript, Summary, Chat and Highlights. It works like the Glasp and NoteGPT summarizers, but the AI runs on your own Ollama for $0, with NVIDIA build's free tier as an option.

## Install
1. Open `chrome://extensions` and turn on Developer mode.
2. Click **Load unpacked** and choose this folder.
3. Open any YouTube video. The panel appears to the right of the player.

## Features
- **Transcript.** It reads YouTube's own transcript panel. YouTube's direct caption endpoints now require a token, and this path avoids that. You get readable paragraphs of about 20 seconds each, a highlight on the line being spoken with auto-follow, search with match highlighting, and click-to-seek. The two API tiers remain as fallbacks.
- **Summary.** Styles: Key points, Deep dive, Chapters, Mind map (a collapsible tree), Step-by-step, TL;DR, Quiz, and a custom prompt. Length can be Short, Medium or Long. Output can be in 12 languages, including Kreyòl. Every timestamp is a link that jumps the video. Each result ends with a receipt line: model, token count, and where it ran.
- **Chat.** Grounded Q&A over the transcript. One-click prompts: Takeaways, Resources, Fact-check.
- **Highlights.** Star any transcript line. Highlights are saved per video in `chrome.storage.local`.
- **Export.** Markdown (summary, highlights and transcript, with youtu.be?t= links), TXT, or SRT.
- **Models.** Every local Ollama model appears in the picker. `NVIDIA · gemma-4-31b-it` uses build.nvidia.com: click ⚙ and paste an `nvapi-…` key. The key stays in this browser.

## NouGenOpen free fleet ($0, parallel)
Run the bridge, and **NouGenOpen · free fleet** appears first in the picker:
```
cd Outpost\NouGenOpen
set PYTHONPATH=src;..\NouGen\src
python -m nougen_open.cli serve --port 8765
```
- The bridge is OpenAI-compatible and listens only on 127.0.0.1:8765. It accepts requests from extensions and local tools and returns 403 to web pages.
- It rotates across Hugging Face, OpenRouter and Ollama Cloud keys from the Keymaker.
- **Long videos (over 14k characters):** the transcript is split at natural topic breaks (a gap of 3s or more, or a phrase like "moving on"). The pieces are summarized in parallel on free lanes via `/v1/nougen/map`, then combined in your chosen style. The result's last line shows how many chunks succeeded and on which providers.
- **Measured:** a deep dive of the 28-minute OBS video took 36s, with 13 chunks.

Ideas adopted from open-source summarizers:
- Grounded "shorter is better than invented" rule: molly554 (MIT).
- Topic-boundary chunking and "recommended to watch": DevRico003 (MIT).
- Map-reduce: bskrishna2006 (Apache-2.0).
- Tube-Brief has no license, so nothing was copied from it.

## Notes
- Ollama returns 403 for `chrome-extension://` origins. `rules.json` (declarativeNetRequest) strips the Origin header on requests to localhost:11434, so you don't need to set `OLLAMA_ORIGINS`.
- YouTube renders the transcript only while the tab is visible. In a background tab the panel shows a waiting message and loads once you switch to the tab.
- The first local call can take about 2 minutes while Ollama loads the model. After that, a summary takes about 10–20 seconds on gemma4:e2b-qat.
