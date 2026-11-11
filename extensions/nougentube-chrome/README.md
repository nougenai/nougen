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

## Morph
The Morph tab reverses a video's intent: it asks what the video lets you build, and builds on what your vault already holds.
1. **Intents.** The model names the video's buildable ideas as short search phrases.
2. **Cross-reference.** The bridge looks each phrase up in NouGenShards (`POST /v1/nougen/recall`) and returns the matching shards. The video's own saved report is excluded.
3. **Plan.** For the target you pick (best fit, code architecture, app, website, or skill/workflow) it writes: Intent of the video, What the vault already has, Morph plan, First build steps, Gaps. Shards are cited as `[id@dbN]`.
4. **Check.** Code confirms every cited shard is one the vault returned and every timestamp is inside the video.

"Shard it" saves the plan with the tag `tube-morph:<video id>`; a later morph of the same video says it was morphed before. Morph needs the bridge running, because that is how the extension reads the vault.

## Themes
The panel and the settings page use the Mono Violet colorways from the NouGenDesigns package (`designs/mono-violet/tokens.css`): Mono Violet dark, Mono Violet light, Arcade and Hardcade. "Auto" (the default) picks dark or light to match YouTube. Change it with ◐ in the panel header or on the settings page.

## Model routes and your own keys
Open ⚙ in the panel header for the settings page.
- **Provider keys.** Claude (Anthropic), OpenAI, Google Gemini, DeepSeek, OpenRouter, NVIDIA build, or any OpenAI-compatible endpoint. Paste a key and press "Test key and load models": the key is checked against the provider and the model list comes from the provider itself, so no model name is guessed. Keys are stored in this browser only (`chrome.storage.local`) and sent only to that provider.
- **Auto** (the default route) tries each available route in order and moves on when one fails or stays silent: the NouGenOpen free fleet, local Ollama, then your keyed providers. The order can be flipped to "my keys first". The summary's last line names the route that answered and how many failed before it.
- **Claude** is called through the Messages API directly with your key. No sampling parameters are sent (current Claude models reject them), and the server-side refusal fallback is requested on models that support it.

## Intelligence report, checker and shards
- **Intelligence report** (the default summary style) follows the Media Intelligence Architect format: Executive Summary, Key Insights & Technical Milestones, Strategic Action Items, Quality Control / Fact-Check, Notable Quotes.
- **Full Transcript Archive.** "Copy report + transcript" puts the report first and the complete transcript second. The extension builds the archive from the transcript itself, so it is always complete and word for word, and the model spends no tokens repeating it.
- **Checked against the transcript.** After every summary the extension checks, in code, that each quoted passage appears in the transcript word for word and that every timestamp is inside the video. Anything that fails is listed. This checks wording and times only, not whether the speaker is right.
- **Shard.** The header button saves the video to NouGenShards through the local bridge (`POST /v1/nougen/shard`): the full transcript, plus the report and the check results if a summary exists. Tags: `nougentube`, `tube-report:<video id>`.
- **Copy prompt + transcript for another AI** copies the Architect instructions with the transcript, for pasting into Gemini, ChatGPT or Claude.

## Transcript failsafes
The transcript comes from several independent sources, tried in order, and the whole ladder runs up to 3 times before any error shows:
1. **Saved copy.** The 40 most recent transcripts are kept in the browser, so a revisit loads at once. The "saved ↻" chip fetches it from YouTube again.
2. **YouTube's transcript panel**, both the classic and the modern layout, followed live as the page renders.
3. **The player's own captions.** `inject.js` runs in the page and passes along the caption track the player downloads. This works in background tabs. If captions are off, they are switched on for a moment and then put back.
4. **YouTube's caption service** called directly (usually blocked, kept as a last resort).

The error text says which case it is: the video has no captions at all, or YouTube has them but didn't return them. If the extension is updated while a tab stays open, that tab's panel asks for a refresh instead of failing.

## Notes
- Ollama returns 403 for `chrome-extension://` origins. `rules.json` (declarativeNetRequest) strips the Origin header on requests to localhost:11434, so you don't need to set `OLLAMA_ORIGINS`.
- YouTube renders the transcript only while the tab is visible. In a background tab the panel shows a waiting message and loads once you switch to the tab.
- The first local call can take about 2 minutes while Ollama loads the model. After that, a summary takes about 10–20 seconds on gemma4:e2b-qat.
