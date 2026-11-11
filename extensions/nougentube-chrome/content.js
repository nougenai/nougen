// NouGenTube content script: panel injected beside the YouTube player.
(() => {
  const S = { vid: null, lines: [], title: "", tab: "transcript", follow: true, summary: "", chat: [], hl: {}, port: null };
  const fmt = s => { s = Math.floor(s); const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const parseTs = t => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  const esc = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const video = () => document.querySelector("video.html5-main-video, video");
  const seek = t => { const v = video(); if (v) { v.currentTime = t; v.play(); } };

  // ---------- transcript fetch (two tiers) ----------
  async function playerResponse(vid) {
    const html = await (await fetch("/watch?v=" + vid, { credentials: "include" })).text();
    const grab = k => { const i = html.indexOf(k + " = {"); if (i < 0) return null; let d = 0, s = html.indexOf("{", i);
      for (let j = s; j < html.length; j++) { const c = html[j]; if (c === "{") d++; else if (c === "}" && --d === 0) return JSON.parse(html.slice(s, j + 1)); } };
    return { pr: grab("ytInitialPlayerResponse"), data: grab("ytInitialData"), key: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1],
             ver: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] };
  }
  async function viaTimedtext(pr) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;
    const pref = await chrome.storage.sync.get("lang"); const want = pref.lang || "en";
    const t = tracks.find(t => t.languageCode === want && t.kind !== "asr") || tracks.find(t => t.languageCode === want) || tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
    const r = await fetch(t.baseUrl + "&fmt=json3"); const txt = await r.text(); if (!txt) return null;
    const j = JSON.parse(txt);
    const out = (j.events || []).filter(e => e.segs).map(e => ({ t: e.tStartMs / 1000, text: e.segs.map(s => s.utf8).join("").replace(/\s+/g, " ").trim() })).filter(l => l.text);
    return out.length ? { lines: out, lang: t.name?.simpleText || t.languageCode } : null;
  }
  async function viaInnertube(p) {
    const s = JSON.stringify(p.data || {}); const params = (s.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/) || [])[1];
    if (!params || !p.key) return null;
    const r = await fetch("/youtubei/v1/get_transcript?key=" + p.key, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: p.ver || "2.20250101" } }, params }) });
    const j = await r.json(); const segs = JSON.stringify(j).match(/"transcriptSegmentRenderer":\{.*?"startMs":"\d+".*?\}\}\]\}/g) || [];
    const out = [];
    const walk = o => { if (!o || typeof o !== "object") return; if (o.transcriptSegmentRenderer) { const x = o.transcriptSegmentRenderer;
      const text = (x.snippet?.runs || []).map(r => r.text).join("").trim(); if (text) out.push({ t: +x.startMs / 1000, text }); return; }
      for (const k in o) walk(o[k]); };
    walk(j); return out.length ? { lines: out, lang: "auto" } : null;
  }
  // Tier 0: YouTube's own transcript panel (carries the player's PO token, so it survives API gating).
  // Resolved at page runtime: a MutationObserver follows YouTube as it renders, clicks
  // "Show transcript" whenever that button exists for the current video, and reads the rows
  // once their count holds still. No fixed waits, so in-app navigation can't race it.
  // Handles both layouts: classic (ytd-transcript-segment-renderer, target-id*=transcript)
  // and modern (transcript-segment-view-model, often no target-id).
  const EP = "ytd-engagement-panel-section-list-renderer";
  const PANELS = [`${EP}[target-id*=transcript]`, `${EP}:has(transcript-segment-view-model)`,
    `${EP}:has(ytd-transcript-segment-renderer)`, `${EP}:has(textarea[placeholder*="ranscript"])`].join(",");
  const SEGS = "ytd-transcript-segment-renderer, transcript-segment-view-model";
  const BTN = "ytd-video-description-transcript-section-renderer button";
  let lastFirst = "";   // first row of the previous video, so a stale list is never read as the new one
  // Some pages hold BOTH layouts at once. Reading both doubled the transcript, so use one:
  // whichever has more rows.
  const oneLayout = () => { const a = document.querySelectorAll("ytd-transcript-segment-renderer"), b = document.querySelectorAll("transcript-segment-view-model");
    return [...(a.length >= b.length ? a : b)]; };
  // Transcript times only move forward. If they jump back by more than a minute, what follows
  // is a second copy (older saved transcripts can contain one): keep the first.
  const monotonic = lines => { for (let i = 1; i < lines.length; i++) if (lines[i].t < lines[i - 1].t - 60) return lines.slice(0, i); return lines; };
  const readRows = () => oneLayout().map(s => {
    const [ts, tx] = s.tagName === "YTD-TRANSCRIPT-SEGMENT-RENDERER"
      ? [s.querySelector(".segment-timestamp")?.textContent, s.querySelector(".segment-text")?.textContent]
      : [s.querySelector(".ytwTranscriptSegmentViewModelTimestamp")?.textContent, s.querySelector(".ytAttributedStringHost, span")?.textContent];
    return { t: parseTs((ts || "0").trim()), text: (tx || "").replace(/\s+/g, " ").trim() };
  }).filter(l => l.text);

  // False once the extension has been reloaded under this tab (the old copy is orphaned).
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // ---- Player tier: inject.js (page world) forwards the caption track the player itself
  // downloads. Works in background tabs and when YouTube's transcript panel misbehaves.
  const TT = {};   // video id -> raw caption track body
  window.addEventListener("message", e => {
    if (e.source !== window || e.data?.__ngt !== "timedtext") return;
    try { const v = new URL(e.data.url, location.origin).searchParams.get("v");
      if (v && (!TT[v] || e.data.body.length > TT[v].length)) TT[v] = e.data.body; } catch {}
  });
  function pageInfo() {   // which caption tracks does the player say this video has?
    return new Promise(res => { const id = Math.random().toString(36).slice(2);
      const on = e => { if (e.source === window && e.data?.__ngt === "info" && e.data.id === id) { window.removeEventListener("message", on); res(e.data); } };
      window.addEventListener("message", on); window.postMessage({ __ngt: "info?", id }, location.origin);
      setTimeout(() => { window.removeEventListener("message", on); res(null); }, 1200); });
  }
  function parseTrack(body) {
    const clean = t => t.replace(/\s+/g, " ").trim();
    if (body.trim().startsWith("{")) {   // json3
      return (JSON.parse(body).events || []).filter(ev => ev.segs)
        .map(ev => ({ t: (ev.tStartMs || 0) / 1000, text: clean(ev.segs.map(x => x.utf8 || "").join("")) })).filter(l => l.text);
    }
    const doc = new DOMParser().parseFromString(body, "text/xml");   // srv1 <text start=> / srv3 <p t=>
    return [...doc.querySelectorAll("text, p")].map(n => ({
      t: n.hasAttribute("start") ? parseFloat(n.getAttribute("start")) : (parseInt(n.getAttribute("t"), 10) || 0) / 1000,
      text: clean(n.textContent) })).filter(l => l.text);
  }
  // The track the player has already downloaded for this video, if any (no clicks needed).
  const captured = vid => { try { const l = TT[vid] && parseTrack(TT[vid]); return l && l.length ? { lines: l, lang: "YouTube captions" } : null; } catch { return null; } };
  async function viaPlayer(vid) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const got = () => captured(vid);
    let r = got(); if (r) return r;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc || cc.getAttribute("aria-disabled") === "true" || getComputedStyle(cc).display === "none") return null;
    // Switching captions on makes the player download the track; put the button back afterwards.
    const wasOn = cc.getAttribute("aria-pressed") === "true";
    if (wasOn) { cc.click(); await wait(250); }
    cc.click();
    for (let i = 0; i < 40 && !(r = got()); i++) await wait(200);
    if (!wasOn && cc.getAttribute("aria-pressed") === "true") cc.click();
    return r;
  }

  // ---- Saved transcripts: the 40 most recent videos, so a revisit is instant and offline-safe.
  const cacheGet = async vid => { const k = "t:" + vid, v = (await chrome.storage.local.get(k))[k];
    return v?.lines?.length ? { lines: v.lines, lang: "saved" } : null; };
  async function cachePut(vid, r) {
    try {
      const { tIdx = [] } = await chrome.storage.local.get("tIdx");
      const idx = [vid, ...tIdx.filter(x => x !== vid)], drop = idx.splice(40);
      await chrome.storage.local.set({ ["t:" + vid]: { lines: r.lines, at: Date.now() }, tIdx: idx });
      if (drop.length) await chrome.storage.local.remove(drop.map(x => "t:" + x));
    } catch (e) { console.warn("[NouGenTube] could not save transcript", e); }
  }

  function viaPanel(vid, limitMs = 45000) {
    const curVid = () => new URLSearchParams(location.search).get("v");
    document.querySelectorAll("style[data-nougentube]").forEach(x => x.remove());
    const userOpen = !!document.querySelector(SEGS) && [...document.querySelectorAll(PANELS)].some(p => p.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    const style = document.createElement("style"); style.dataset.nougentube = "1";
    style.textContent = `${PANELS}{opacity:0!important;pointer-events:none!important}`;
    if (!userOpen) document.head.append(style);
    return new Promise(resolve => {
      let clickedAt = 0, lastCount = -1, stableSince = 0, done = false, raf = 0; const t0 = performance.now();
      const finish = rows => {
        if (done) return; done = true; obs.disconnect(); clearInterval(tick); clearTimeout(limit);
        if (!userOpen) {
          document.querySelector(`${PANELS.split(",")[0]} #visibility-button button`)?.click();
          style.textContent = `${PANELS}{display:none!important}`;   // newer panels render even when "HIDDEN"
          const release = e => { if (e.isTrusted && e.target.closest?.("ytd-video-description-transcript-section-renderer")) { style.remove(); document.removeEventListener("click", release, true); } };
          document.addEventListener("click", release, true);
          document.addEventListener("yt-navigate-start", () => { style.remove(); document.removeEventListener("click", release, true); }, { once: true });
        }
        if (rows?.length) lastFirst = rows[0].text;
        resolve(rows?.length ? { lines: rows, lang: "YouTube" } : null);
      };
      const step = () => {
        raf = 0;
        if (done) return;
        if (curVid() !== vid) return finish(null);           // viewer moved on
        if (document.hidden) return setStage("Waiting for this tab to be visible");   // YouTube renders nothing off-screen
        const rows = readRows();
        const fresh = rows.length && rows[0].text !== lastFirst;
        if (fresh) {
          setStage(`Reading ${rows.length} lines`);
          if (rows.length !== lastCount) { lastCount = rows.length; stableSince = performance.now(); }
          else if (performance.now() - stableSince > 500) return finish(rows);
          return;
        }
        const b = document.querySelector(BTN);
        if (b && performance.now() - clickedAt > 4000) { clickedAt = performance.now(); b.click(); setStage("Opening YouTube's transcript"); }
        else if (!b) { setStage("Waiting for YouTube's page");
          // No transcript button after 6s, or the player already has the captions: let the next source answer.
          if (performance.now() - t0 > 6000 || (performance.now() - t0 > 1500 && captured(vid))) return finish(null); }
      };
      const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
      const obs = new MutationObserver(kick);
      obs.observe(document.body, { childList: true, subtree: true });
      const tick = setInterval(kick, 600);                    // also re-check when the DOM is quiet
      document.addEventListener("visibilitychange", kick);
      const limit = setTimeout(() => finish(null), document.hidden ? 864e5 : limitMs);
      kick();
    });
  }
  // merge tiny caption events into readable ~20s paragraphs
  function paragraphs(lines) {
    const out = []; let cur = null;
    for (const l of lines) { if (!cur || l.t - cur.t > 20 || cur.text.length > 320) { cur = { t: l.t, text: l.text }; out.push(cur); } else cur.text += " " + l.text; }
    return out;
  }

  // ---------- UI ----------
  let host, root;
  const CSS = `
  :host{all:initial} *{box-sizing:border-box}
  .p{--bg:#0f0f12;--card:#17171c;--ln:#2a2a33;--tx:#e9e9ee;--mu:#9a9aa8;--ac:#7c5cff;--ac2:#22d3ee;
     font:14px/1.5 "Roboto",system-ui,sans-serif;color:var(--tx);background:var(--bg);border:1px solid var(--ln);border-radius:14px;margin:0 0 12px;overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 140px)}
  @media (prefers-color-scheme:light){.p{--bg:#fff;--card:#f5f5f8;--ln:#e3e3ea;--tx:#141418;--mu:#5e5e6b}}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ln)}
  .lg{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--ac),var(--ac2));display:grid;place-items:center;font-weight:800;color:#fff;font-size:13px}
  .ti{font-weight:700;font-size:15px;flex:1}.ti small{color:var(--mu);font-weight:400;font-size:11px;margin-left:6px}
  button,select,input{font:inherit;color:inherit}
  .ib{background:none;border:0;cursor:pointer;color:var(--mu);padding:4px 6px;border-radius:6px}.ib:hover{background:var(--card);color:var(--tx)}
  .tabs{display:flex;border-bottom:1px solid var(--ln)}.tabs button{flex:1;background:none;border:0;padding:10px 0;cursor:pointer;color:var(--mu);font-weight:600;border-bottom:2px solid transparent}
  .tabs button.on{color:var(--tx);border-color:var(--ac)}
  .tb{display:flex;gap:6px;padding:8px 12px;align-items:center;border-bottom:1px solid var(--ln)}
  .tb input{flex:1;background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:6px 10px}
  .tb select{background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:5px;max-width:150px}
  .chip{background:var(--card);border:1px solid var(--ln);border-radius:999px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}.chip.on{border-color:var(--ac);color:var(--ac)}
  .bd{overflow-y:auto;overscroll-behavior:contain;flex:1 1 auto;min-height:0;padding:6px 4px 12px;scrollbar-width:thin}
  #wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}#wrap[hidden]{display:none}
  .p{height:calc(100vh - 140px);min-height:360px}
  .ln{display:flex;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer;position:relative}
  .ln:hover{background:var(--card)}.ln.now{background:color-mix(in srgb,var(--ac) 16%,transparent)}
  .ln.hl{box-shadow:inset 3px 0 var(--ac2)}
  .ts{color:var(--ac2);font-variant-numeric:tabular-nums;font-size:12px;min-width:42px;padding-top:2px;cursor:pointer;background:none;border:0;text-align:left}
  .st{position:absolute;right:6px;top:6px;opacity:0}.ln:hover .st{opacity:1}
  mark{background:#facc15;color:#000;border-radius:2px}
  .md{padding:8px 14px}
  .mm{margin-left:calc(var(--d) * 14px);border-left:2px solid color-mix(in srgb,var(--ac) 45%,transparent);padding:2px 0 2px 10px}
  .mm>summary{cursor:pointer;font-weight:600;list-style:none}.mm>summary::before{content:"▸ ";color:var(--ac)}.mm[open]>summary::before{content:"▾ "}
  .mm.leaf{font-weight:400}.mmw>details[style*="--d:0"]>summary{font-size:15px;color:var(--ac2)}
  .menu{position:absolute;right:10px;top:44px;background:var(--card);border:1px solid var(--ln);border-radius:10px;padding:4px;z-index:9;display:flex;flex-direction:column;min-width:170px}
  .menu[hidden]{display:none}.menu button{background:none;border:0;text-align:left;padding:7px 10px;border-radius:6px;cursor:pointer}.menu button:hover{background:var(--bg)}
  .hd{position:relative}.md h3{font-size:14px;margin:12px 0 4px}.md ul{padding-left:18px;margin:4px 0}.md li{margin:3px 0}
  .md a.t{color:var(--ac2);cursor:pointer;text-decoration:none;font-variant-numeric:tabular-nums}
  .mu{color:var(--mu);font-size:12px;padding:10px 14px}
  .go{background:linear-gradient(135deg,var(--ac),#5b8cff);color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font-weight:600}
  .ld{padding:12px 14px}
  .lst{display:flex;align-items:center;gap:8px;color:var(--mu);font-size:12.5px}.lst b{color:var(--tx);font-weight:600}
  .lst .el{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--mu)}
  .bar{height:3px;border-radius:3px;background:var(--ln);overflow:hidden;position:relative;margin:10px 0 6px}
  .bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;background:linear-gradient(90deg,transparent,var(--ac),var(--ac2),transparent);animation:ngt-slide 1.2s ease-in-out infinite}
  @keyframes ngt-slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
  .spin{width:14px;height:14px;flex:none;border:2px solid color-mix(in srgb,var(--ac) 30%,transparent);border-top-color:var(--ac);border-radius:50%;animation:ngt-rot .8s linear infinite;display:inline-block;vertical-align:-2px}
  .go .spin{border-color:rgba(255,255,255,.35);border-top-color:#fff;margin-right:6px}
  @keyframes ngt-rot{to{transform:rotate(360deg)}}
  .skel{height:11px;border-radius:6px;margin:12px 14px;background:linear-gradient(90deg,var(--card) 0%,var(--ln) 50%,var(--card) 100%);background-size:200% 100%;animation:ngt-sh 1.3s linear infinite}
  .skel.ts{width:38px;display:inline-block;margin:0 0 0 14px}
  @keyframes ngt-sh{to{background-position:-200% 0}}
  .dots span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:var(--mu);animation:ngt-bo 1s infinite}
  .dots span:nth-child(2){animation-delay:.15s}.dots span:nth-child(3){animation-delay:.3s}
  @keyframes ngt-bo{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
  .tail{padding:2px 14px 10px}
  @media (prefers-reduced-motion:reduce){.bar::after,.spin,.skel,.dots span{animation:none}}
  .note{padding:7px 12px;font-size:12.5px;border-bottom:1px solid var(--ln);color:#34d399}.note.bad{color:#fbbf24}.note[hidden]{display:none}
  .hd .chip{font:inherit;font-size:12px;color:var(--tx)}
  .acts{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 2px}
  .vf{margin:6px 12px 12px;padding:10px 12px;border:1px solid var(--ln);border-radius:10px;background:var(--card);font-size:12.5px}
  .vh{font-weight:700;margin-bottom:6px}.vr{display:flex;gap:8px;padding:2px 0}.vok{color:#34d399;font-weight:700}.vno{color:#fbbf24;font-weight:700}
  .md table{border-collapse:collapse;margin:6px 0;font-size:12.5px}.md td,.md th{border:1px solid var(--ln);padding:4px 6px;text-align:left}
  .msg{margin:8px 12px;padding:8px 12px;border-radius:10px;background:var(--card)}.msg.u{background:color-mix(in srgb,var(--ac) 20%,transparent);margin-left:40px}
  .ft{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--ln)}.ft input{flex:1;background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:7px 10px}
  .err{color:#f87171}`;

  function mount() {
    if (host?.isConnected) return true;
    const sec = document.querySelector("#secondary-inner, #secondary"); if (!sec) return false;
    host = document.createElement("div"); host.id = "nougentube"; host.style.cssText = "position:sticky;top:72px;z-index:5;display:block"; sec.prepend(host);
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="p">
      <div class="hd"><div class="lg">N</div><div class="ti">NouGenTube<small id="mdl"></small></div>
        <button class="chip" id="hs" title="Save this video to NouGenShards: the full transcript, plus the summary if you have made one">Shard</button><button class="ib" id="key" title="Settings: provider keys and routes">⚙</button><button class="ib" id="cp" title="Copy transcript">⧉</button><button class="ib" id="dl" title="Export">⤓</button><div class="menu" id="menu" hidden><button data-x="md">Markdown (everything)</button><button data-x="txt">Transcript .txt</button><button data-x="srt">Subtitles .srt</button></div>
        <button class="ib" id="col" title="Collapse">▾</button></div>
      <div class="note" id="note" hidden></div><div id="wrap"><div class="tabs"><button data-t="transcript">Transcript</button><button data-t="summary">Summary</button><button data-t="chat">Chat</button><button data-t="highlights">Highlights</button></div>
      <div class="tb" id="tb"></div><div class="bd" id="bd"></div><div id="ft"></div></div></div>`;
    root.querySelector(".tabs").onclick = e => { const t = e.target.dataset.t; if (t) { S.tab = t; render(); } };
    root.getElementById("col").onclick = () => { const w = root.getElementById("wrap"); w.hidden = !w.hidden; root.querySelector(".p").style.height = w.hidden ? "auto" : ""; };
    root.getElementById("cp").onclick = () => navigator.clipboard.writeText(copyText()).then(() => { const b = root.getElementById("cp"); b.textContent = "✓"; setTimeout(() => b.textContent = "⧉", 1200); });
    root.getElementById("dl").onclick = e => { e.stopPropagation(); const m = root.getElementById("menu"); m.hidden = !m.hidden; };
    root.getElementById("menu").onclick = e => { const x = e.target.dataset.x; if (x) { root.getElementById("menu").hidden = true; download(x); } };
    root.getElementById("hs").onclick = () => shardIt("hs");
    root.getElementById("key").onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
    root.addEventListener("click", e => { const a = e.target.closest("[data-seek]"); if (a) { e.stopPropagation(); seek(+a.dataset.seek); } });
    chrome.runtime.sendMessage({ type: "models" }, r => { if (r?.ok) { S.models = r.models; S.model = r.current; S.labels = r.labels || {}; S.bridge = r.nougenopen; S.ollamaErr = r.ollamaErr; } root.getElementById("mdl").textContent = "· " + label(S.model || ""); render(); });
    return true;
  }
  const $ = id => root.getElementById(id);

  // timestamps like [12:34] in model output -> clickable seek links
  function md(t) {
    let h = esc(t).replace(/\[?\b(\d{1,2}:\d{2}(?::\d{2})?)\b(?:,\s*)?\]?/g, (m, ts) => `<a class="t" data-seek="${parseTs(ts)}">${ts}</a>${/,/.test(m) ? " " : ""}`)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#{1,4} (.+)$/gm, "<h3>$1</h3>");
    h = h.replace(/(?:^[-*] .+(?:\n|$))+/gm, b => "<ul>" + b.trim().split("\n").map(l => "<li>" + l.slice(2) + "</li>").join("") + "</ul>");
    return h.replace(/\n{2,}/g, "<br><br>");
  }

  // mind map: indented bullet outline -> collapsible tree
  function tree(t) {
    const rows = t.split("\n").filter(l => /^\s*[-*] /.test(l)).map(l => ({ d: (l.match(/^\s*/)[0].length / 2) | 0, x: l.replace(/^\s*[-*] /, "") }));
    if (rows.length < 3) return null; let h = "", st = [];
    rows.forEach((r, i) => { const kids = rows[i + 1] && rows[i + 1].d > r.d;
      while (st.length && st[st.length - 1] >= r.d) { h += "</details>"; st.pop(); }
      if (kids) { h += `<details open class="mm" style="--d:${r.d}"><summary>${md(r.x)}</summary>`; st.push(r.d); } else h += `<div class="mm leaf" style="--d:${r.d}">${md(r.x)}</div>`; });
    return h + "</details>".repeat(st.length);
  }
  function show(t) { const m = S.sty === "mindmap" && tree(t); const foot = (t.match(/\n\n— .+$/) || [""])[0];
    return m ? `<div class="md mmw">${m}<div class="mu">${esc(foot)}</div></div>` : `<div class="md">${md(t)}</div>`; }
  function prefs() { chrome.storage.sync.set({ sty: S.sty, len: S.len, lng: S.lng, custom: S.custom }); }

  // Honest progress: a real stage name plus elapsed seconds, never a made-up percentage.
  function loader(stage, sub = "", t0 = Date.now()) {
    return `<div class="ld"><div class="lst"><span class="spin"></span><b>${esc(stage)}</b><span class="el" data-t0="${t0}">0s</span></div>
      <div class="bar"></div>${sub ? `<div class="mu" style="padding:0">${esc(sub)}</div>` : ""}</div>`;
  }
  const DOTS = '<span class="dots" aria-label="Thinking"><span></span><span></span><span></span></span>';
  const WRITING = '<div class="tail lst"><span class="spin"></span>Writing…</div>';
  setInterval(() => { if (root && !alive() && !S.dead) { S.dead = true; render(); } }, 2000);
  setInterval(() => { if (!root) return; root.querySelectorAll(".el[data-t0]").forEach(e => {
    const s = Math.max(0, Math.round((Date.now() - +e.dataset.t0) / 1000)); e.textContent = s < 60 ? s + "s" : (s / 60 | 0) + "m " + (s % 60) + "s"; }); }, 500);
  function transcriptLoading() {
    const skel = [92, 78, 85, 64, 88, 70].map(w => `<div><span class="skel ts"></span><div class="skel" style="width:calc(${w}% - 80px);margin-left:66px;margin-top:-11px"></div></div>`).join("");
    const stage = document.hidden ? "Waiting for this tab to be visible" : (S.tStage || "Loading transcript");
    const sub = document.hidden ? "YouTube only builds the transcript while the tab is on screen." : "";
    return loader(stage, sub, S.tT0) + skel;
  }
  function setStage(stage) {
    if (S.tStage === stage) return; S.tStage = stage;
    if (root && !S.lines.length && !S.err && S.tab === "transcript") { const bd = $("bd"); if (bd) bd.innerHTML = transcriptLoading(); }
  }

  function render() {
    if (!root) return;
    root.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === S.tab));
    const tb = $("tb"), bd = $("bd"), ft = $("ft"); ft.innerHTML = ""; tb.innerHTML = ""; tb.hidden = false;
    // The extension was updated or reloaded while this tab stayed open: this copy can no longer
    // reach its background page, so say so instead of failing in confusing ways.
    if (!alive()) { bd.innerHTML = `<div class="mu">NouGenTube was updated. Refresh this tab to keep using it.</div><div class="mu"><button class="go" id="rf">Refresh tab</button></div>`; $("rf").onclick = () => location.reload(); return; }
    if (S.err) { bd.innerHTML = `<div class="mu err">${esc(S.err)}</div><div class="mu"><button class="go" id="rt">Try again</button></div>`; $("rt").onclick = () => { S.vid = null; S.fresh = true; load(); }; return; }
    if (!S.lines.length) { bd.innerHTML = transcriptLoading(); return; }
    if (S.tab === "transcript") {
      tb.innerHTML = `<input id="q" placeholder="Search transcript…" value="${esc(S.q || "")}"><span class="chip ${S.follow ? "on" : ""}" id="fl" title="Auto-scroll with the video">Follow</span>${S.lang === "saved" ? `<span class="chip" id="rl" title="This transcript was saved from an earlier visit. Click to fetch it from YouTube again.">saved ↻</span>` : `<span class="mu" style="padding:0">${S.lang || ""}</span>`}`;
      if ($("rl")) $("rl").onclick = () => { S.vid = null; S.fresh = true; load(); };
      $("q").oninput = e => { S.q = e.target.value; drawLines(); }; $("fl").onclick = () => { S.follow = !S.follow; render(); };
      drawLines();
    } else if (S.tab === "summary") {
      tb.style.flexWrap = "wrap";
      tb.innerHTML = modelPicker() + `<select id="sty">${Object.entries(STYN).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <select id="len" title="Length"><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select>
        <select id="lng" title="Output language">${LANGS.map(l => `<option>${l}</option>`).join("")}</select>
        <button class="go" id="gen">${S.summary ? "Regenerate" : "Summarize"}</button>
        ${(S.sty || "intel") === "custom" ? `<input id="cp2" style="flex-basis:100%" placeholder="Your own prompt, e.g. Write a LinkedIn post from this video" value="${esc(S.custom || "")}">` : ""}`;
      wirePicker(); $("sty").value = S.sty || "intel"; $("len").value = S.len || "medium"; $("lng").value = S.lng || "Auto";
      $("sty").onchange = e => { S.sty = e.target.value; prefs(); render(); }; $("len").onchange = e => { S.len = e.target.value; prefs(); }; $("lng").onchange = e => { S.lng = e.target.value; prefs(); };
      if ($("cp2")) $("cp2").oninput = e => { S.custom = e.target.value; prefs(); };
      $("gen").onclick = summarize;
      const canShard = (S.models || []).includes("nougenopen:auto");
      const failed = S.summary.trim().startsWith("⚠");
      bd.innerHTML = failed ? `<div class="mu err">${esc(S.summary.trim())}</div><div class="mu">Nothing was written. Pick another model above or press Regenerate.</div>` : S.summary
        ? `<div class="acts"><span class="chip on" id="cAll" title="Report, then the full transcript, ready to paste anywhere">Copy report + transcript</span><span class="chip" id="cRep">Copy report</span>${canShard ? `<span class="chip" id="shd" title="Save the report and the full transcript to NouGenShards">Shard it</span>` : ""}</div>` + show(S.summary) + checkCard(S.summary)
        : `<div class="mu">Summaries run on your own models. Timestamps in the result jump the video. The Intelligence report ends with the full transcript when you copy or shard it.</div><div class="acts"><span class="chip" id="cAI" title="Copies the Media Intelligence Architect instructions plus this transcript, to paste into Gemini, ChatGPT or Claude">Copy prompt + transcript for another AI</span></div>`;
      const flash = (id, text) => navigator.clipboard.writeText(text).then(() => { const e = $(id), o = e.textContent; e.textContent = "Copied ✓"; setTimeout(() => { if (e.isConnected) e.textContent = o; }, 1300); });
      if ($("cAll")) $("cAll").onclick = () => flash("cAll", reportDoc());
      if ($("cRep")) $("cRep").onclick = () => flash("cRep", S.summary);
      if ($("cAI")) $("cAI").onclick = () => flash("cAI", ARCHITECT + "\n\n---\n\n" + copyText());
      if ($("shd")) $("shd").onclick = shardIt;
    } else if (S.tab === "chat") {
      tb.innerHTML = modelPicker() + `<span class="chip" data-p="What are the main takeaways?">Takeaways</span><span class="chip" data-p="List every tool, product or resource mentioned, with timestamps.">Resources</span><span class="chip" data-p="What claims here might be wrong or need checking?">Fact-check</span>`;
      wirePicker(); tb.querySelectorAll("[data-p]").forEach(c => c.onclick = () => ask(c.dataset.p));
      bd.innerHTML = S.chat.map(m => `<div class="msg ${m.role === "user" ? "u" : ""}">${m.role === "user" ? esc(m.content) : (m.content ? md(m.content) : DOTS)}</div>`).join("") || `<div class="mu">Ask anything about this video. Answers cite timestamps.</div>`;
      ft.innerHTML = `<div class="ft"><input id="ci" placeholder="Ask about this video…"><button class="go" id="cs">Send</button></div>`;
      const go = () => { const v = $("ci").value.trim(); if (v) ask(v); }; $("cs").onclick = go; $("ci").onkeydown = e => e.key === "Enter" && go();
      bd.scrollTop = bd.scrollHeight;
    } else {
      const ks = Object.keys(S.hl).map(Number).sort((a, b) => a - b);
      tb.innerHTML = `<span class="mu" style="padding:0;flex:1">${ks.length} highlight${ks.length === 1 ? "" : "s"} · click ☆ on a transcript line</span><button class="ib" id="hc">Copy</button>`;
      $("hc").onclick = () => navigator.clipboard.writeText(ks.map(k => `[${fmt(k)}] ${S.hl[k]}`).join("\n"));
      bd.innerHTML = ks.map(k => `<div class="ln hl" data-seek="${k}"><span class="ts">${fmt(k)}</span><span style="flex:1">${esc(S.hl[k])}</span><button class="ib" data-del="${k}">✕</button></div>`).join("") || `<div class="mu">No highlights yet.</div>`;
      bd.querySelectorAll("[data-del]").forEach(b => b.onclick = e => { e.stopPropagation(); delete S.hl[b.dataset.del]; saveHl(); render(); });
    }
  }
  function label(m) { return (S.labels && S.labels[m]) || (m === "nougenopen:auto" ? "NouGenOpen · free fleet" : m); }
  const kindOf = m => m === "auto" ? "auto" : m.startsWith("nougenopen:") ? "bridge" : m.startsWith("prov:") ? "key" : "local";
  function modelPicker() { return S.models ? `<select id="mp" title="Model route">${S.models.map(m => `<option value="${esc(m)}" ${m === S.model ? "selected" : ""}>${esc(label(m))}${kindOf(m) === "bridge" ? " ($0, parallel)" : kindOf(m) === "local" ? " (local)" : ""}</option>`).join("")}</select>` : ""; }
  function wirePicker() { const p = $("mp"); if (p) p.onchange = e => { S.model = e.target.value;
    chrome.storage.sync.set(kindOf(S.model) === "local" ? { model: S.model, localModel: S.model } : { model: S.model }); $("mdl").textContent = "· " + label(S.model); }; }

  function drawLines() {
    const bd = $("bd"), q = (S.q || "").toLowerCase();
    const rows = S.paras.map((l, i) => ({ l, i })).filter(({ l }) => !q || l.text.toLowerCase().includes(q));
    bd.innerHTML = rows.map(({ l, i }) => {
      let t = esc(l.text); if (q) t = t.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `<mark>${m}</mark>`);
      return `<div class="ln ${S.hl[l.t] ? "hl" : ""}" data-i="${i}" data-seek="${l.t}"><span class="ts">${fmt(l.t)}</span><span style="flex:1">${t}</span><button class="ib st" data-star="${i}" title="Highlight">${S.hl[l.t] ? "★" : "☆"}</button></div>`;
    }).join("") || `<div class="mu">No matches.</div>`;
    bd.querySelectorAll("[data-star]").forEach(b => b.onclick = e => { e.stopPropagation(); const p = S.paras[b.dataset.star];
      if (S.hl[p.t]) delete S.hl[p.t]; else S.hl[p.t] = p.text; saveHl(); drawLines(); });
    S.cur = -1; tick();
  }
  function tick() {
    if (!root || S.tab !== "transcript" || !S.paras) return; const v = video(); if (!v) return;
    let i = 0; while (i + 1 < S.paras.length && S.paras[i + 1].t <= v.currentTime + 0.3) i++;
    if (i === S.cur) return; S.cur = i;
    root.querySelectorAll(".ln.now").forEach(e => e.classList.remove("now"));
    const el = root.querySelector(`.ln[data-i="${i}"]`); if (el) { el.classList.add("now"); if (S.follow && !S.q) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  setInterval(tick, 500);

  // ---------- AI ----------
  const tx = (max = 48000) => { let s = S.paras.map(l => `[${fmt(l.t)}] ${l.text}`).join("\n"); return s.length > max ? s.slice(0, max) + "\n[…truncated]" : s; };
  const SYS = () => `You are NouGenTube, analysing the YouTube video "${vtitle()}". Ground every statement in the transcript: state only what the speaker actually says, never outside knowledge; if a point has no basis in the transcript, drop it (shorter is better than invented). Cite moments as [m:ss] or [h:mm:ss] timestamps copied from the transcript. Be concise. Markdown only.\n\nTRANSCRIPT:\n${tx()}`;
  const STYN = { intel: "Intelligence report", brief: "Key points", deep: "Deep dive", chapters: "Chapters", mindmap: "Mind map", steps: "Step-by-step", tldr: "TL;DR", quiz: "Quiz", custom: "Custom prompt…" };
  const LANGS = ["Auto", "English", "Español", "Français", "Kreyòl ayisyen", "Português", "Deutsch", "Italiano", "日本語", "한국어", "中文", "العربية", "हिन्दी"];
  const LEN = { short: "Keep it tight: about 120 words.", medium: "About 300 words.", long: "Thorough: up to 800 words." };
  // Media Intelligence Architect report. The model writes the five analysis sections only; the
  // extension appends the full transcript archive itself, so the archive is always complete
  // and verbatim and costs no tokens.
  const INTEL = "Write an intelligence report with exactly these five sections, in this order, using these exact headings. No intro or outro.\n" +
    "### Executive Summary\n2-3 dense sentences: the video's main value and core thesis.\n" +
    "### Key Insights & Technical Milestones\nBullets, each with its [m:ss] timestamp. Cover what matters, how it works (mechanics, step-by-step logic), why it matters, and specifics: processes, tools, examples, numbers, claims, frameworks. Bold key terms. Use a table when several options or tools are compared.\n" +
    "### Strategic Action Items\nConcrete next steps a professional could take immediately, based only on the transcript.\n" +
    "### Quality Control / Fact-Check\nFlag unsupported or weak claims, missing proof, logical gaps, contradictions, missing context, and anything needing outside verification. Never call something verified when the transcript alone does not prove it.\n" +
    "### Notable Quotes\n2-3 short quotes copied word for word from the transcript, in double quotes, each with its [m:ss].\n" +
    "Do not reproduce the transcript; the full transcript archive is attached after your report automatically.";
  const STY = { intel: INTEL, chapters: "Split the whole video into 5-12 chapters in order. For each: a line \"[m:ss] **Chapter title**\" then one sentence on what it covers.",
    mindmap: "Produce a mind map as a nested markdown bullet outline (2-space indents, max 4 levels). Root = the video topic. Branches = main themes in order, leaves = concrete details with [m:ss]. Output ONLY the outline.",
    quiz: "Write 5 multiple-choice questions testing the key ideas. Each: question, options A-D, then \"Answer: X — [m:ss]\".",
    custom: "", brief: "Give a one-line gist, then 5-8 key points as bullets, each with its timestamp.", deep: "Give a sectioned deep-dive: ### headings per topic in order, bullets under each with timestamps, then 'Recommended to watch' (the 3 most valuable moments as [m:ss] links with why), 'Notable quotes' and 'Action items'.", steps: "Extract the procedure as numbered steps with timestamps, plus prerequisites and gotchas.", tldr: "Three sentences max, plus the single most important timestamp." };
  function stream(messages, onDelta, onDone) {
    if (S.port) { try { S.port.disconnect(); } catch {} }
    const port = S.port = chrome.runtime.connect({ name: "chat" }); let fin = false;
    // Chrome stops an idle background page after ~30s even mid-request; a message every 15s keeps it up.
    const ka = setInterval(() => { try { port.postMessage({ ping: 1 }); } catch {} }, 15000);
    const end = (e, m) => { if (fin) return; fin = true; clearInterval(ka); onDone(e, m); };
    port.onMessage.addListener(m => { if (m.stage && S.onStage) S.onStage(m.stage); if (m.reset && S.onReset) S.onReset(); if (m.delta) onDelta(m.delta); if (m.error) end("\n\n⚠ " + m.error); if (m.done) end("", m); });
    port.onDisconnect.addListener(() => end("\n\n⚠ The extension's background page stopped before the answer arrived. Press Regenerate."));
    port.postMessage({ messages });
  }
  // Split on topic boundaries: a >=3s silence gap or a transition phrase, near a target size.
  const TRANS = /\b(moving on|let'?s talk about|next up|now let'?s|the next (thing|step|part)|another thing|so that'?s it|in conclusion|to sum up|first of all|secondly|finally)\b/i;
  function chunks(lines, target = 9000, hard = 12000) {
    const out = []; let cur = [], len = 0;
    lines.forEach((l, i) => {
      const prev = lines[i - 1], gap = prev ? l.t - prev.t : 0;
      const boundary = len > target * 0.6 && (gap >= 3 || TRANS.test(l.text));
      if (cur.length && (boundary || len > hard)) { out.push(cur); cur = []; len = 0; }
      cur.push(l); len += l.text.length + 8;
    });
    if (cur.length) out.push(cur);
    return out.map(c => ({ from: c[0].t, to: c[c.length - 1].t, text: c.map(l => `[${fmt(l.t)}] ${l.text}`).join("\n") }));
  }
  const fullLen = () => S.lines.reduce((a, l) => a + l.text.length + 8, 0);

  // Long video: map chunk notes in parallel across the free fleet, then reduce with the chosen style.
  async function mapNotes(bd) {
    const cs = chunks(S.lines);
    bd.innerHTML = loader(`Mapping ${cs.length} topic chunks in parallel`, "Long video: each part is summarized on a free-fleet lane, then combined.", S.sT0);
    const sys = `You take grounded notes on one part of the YouTube video "${vtitle()}". Only facts the speaker states. Keep every useful [m:ss] timestamp.`;
    const prompts = cs.map((c, i) => `Part ${i + 1}/${cs.length} (${fmt(c.from)}-${fmt(c.to)}). Write 4-8 terse bullet notes, each ending with its [m:ss]. Then add one line starting with QUOTE: holding one short passage copied word for word from this part, in double quotes, followed by its [m:ss].\n\n${c.text}`);
    const r = await new Promise(res => { const p = chrome.runtime.connect({ name: "map" }); const ka = setInterval(() => { try { p.postMessage({ ping: 1 }); } catch {} }, 15000);
      p.onMessage.addListener(m => { clearInterval(ka); res(m); p.disconnect(); }); p.onDisconnect.addListener(() => { clearInterval(ka); res({ ok: false, error: "background stopped" }); }); p.postMessage({ prompts, system: sys }); });
    if (!r?.ok) throw new Error(r?.error || "map failed");
    const ok = r.results.filter(x => x.ok).length;
    S.mapInfo = `${ok}/${cs.length} chunks via ${[...new Set(r.results.filter(x => x.ok).map(x => x.provider))].join(", ")}`;
    return r.results.map((x, i) => `### Part ${i + 1} (${fmt(cs[i].from)}-${fmt(cs[i].to)})\n${x.ok ? x.content : "(chunk failed: " + x.error + ")"}`).join("\n\n");
  }

  // ---- Checker pass. A second look at the model's work, done by code so it cannot be talked
  // round: every quoted passage must appear in the transcript, every timestamp must be real.
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function check(text) {
    const hay = norm(S.lines.map(l => l.text).join(" ")), end = (S.lines[S.lines.length - 1]?.t || 0) + 30;
    const quotes = [...text.matchAll(/["“]([^"”\n]{15,400})["”]/g)].map(m => m[1].trim());
    const q = quotes.map(x => ({ x, ok: hay.includes(norm(x)) }));
    const ts = [...text.replace(/\n\n— .+$/, "").matchAll(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g)].map(m => m[1]);
    return { q, ts: ts.length, bad: ts.filter(t => parseTs(t) > end) };
  }
  function checkCard(text) {
    const c = check(text), okQ = c.q.filter(x => x.ok).length, missed = c.q.filter(x => !x.ok);
    const row = (ok, t) => `<div class="vr"><span class="${ok ? "vok" : "vno"}">${ok ? "✓" : "!"}</span><span>${t}</span></div>`;
    return `<div class="vf"><div class="vh">Checked against the transcript</div>` +
      (c.q.length ? row(!missed.length, `${okQ} of ${c.q.length} quoted passages appear word for word`) : row(S.sty !== "intel", S.sty === "intel" ? "The report contains no quoted passages, although the format asks for 2-3" : "No quoted passages to check")) +
      missed.map(m => row(false, `Not in the transcript as written: “${esc(m.x.slice(0, 110))}${m.x.length > 110 ? "…" : ""}”`)).join("") +
      row(!c.bad.length && (c.ts > 0 || S.sty !== "intel"), c.bad.length ? `${c.bad.length} of ${c.ts} timestamps fall outside the video: ${esc(c.bad.join(", "))}` : (c.ts ? `${c.ts} timestamps cited, all inside the video` : "No timestamps cited, so nothing can be traced back to the video")) +
      `<div class="mu" style="padding:6px 0 0">This checks wording and times only. Whether the speaker's claims are true still needs outside sources.</div></div>`;
  }
  function checkText(text) {
    const c = check(text), missed = c.q.filter(x => !x.ok);
    return `### Automatic check against the transcript\n- Quoted passages found word for word: ${c.q.length - missed.length} of ${c.q.length}\n` +
      missed.map(m => `- NOT found as written: "${m.x}"\n`).join("") +
      `- Timestamps cited: ${c.ts}; outside the video: ${c.bad.length ? c.bad.join(", ") : "none"}\n`;
  }
  // Report first, full transcript archive second. The archive is built here from the
  // transcript itself, never by the model, so it is always complete and word for word.
  const reportDoc = () => `${vtitle()} - YouTube\nhttps://www.youtube.com/watch?v=${S.vid}\n\n${S.summary.trim()}\n\n${checkText(S.summary)}\n---\n\n### Full Transcript Archive\n\n` +
    S.paras.map(l => `(${pad(l.t)}) ${l.text}`).join("\n") + "\n";
  // For pasting into another assistant: the operator's Media Intelligence Architect instructions.
  const ARCHITECT = "You are the Media Intelligence Architect. Analyze the FULL transcript below and include the FULL transcript in your final output. Treat the transcript as the primary source of truth. Output zero intro or outro filler; start with the first heading.\n\n" +
    "Required output, in this exact order:\n\n### Executive Summary\n2-3 dense sentences on the video's main value and core thesis.\n\n" +
    "### Key Insights & Technical Milestones\nBullets with timestamps. What matters, how it works, why it matters, and specifics: processes, tools, examples, numbers, claims, frameworks. Use a table when comparing options.\n\n" +
    "### Strategic Action Items\nPractical, concrete next steps a professional could take immediately.\n\n" +
    "### Quality Control / Fact-Check\nFlag unsupported or weak claims, missing proof, logical gaps, contradictions, missing context, and claims needing outside verification. Do not pretend something is verified if the transcript alone does not prove it.\n\n" +
    "### Notable Quotes\n2-3 short verbatim quotes with timestamps.\n\n---\n\n### Full Transcript Archive\nThe complete transcript exactly as provided: keep timestamps, speaker names, order and wording; do not paraphrase, shorten or omit anything, including sponsor reads. " +
    "If it does not fit in one response, end with the exact line \"Transcript continues in next part.\" and resume from that point in the next response. If only part of a transcript was provided, title the section \"### Partial Transcript Archive\". If no transcript is provided, give a troubleshooting guide for obtaining one instead of a report.";
  function note() { const n = root.getElementById("note"); if (!n) return; n.textContent = S.shardMsg || ""; n.hidden = !S.shardMsg; n.className = "note" + (/^(Could not|Nothing)/.test(S.shardMsg || "") ? " bad" : ""); }
  async function shardIt(id) {
    const b = $(typeof id === "string" ? id : "shd"); if (!b || b.dataset.busy) return;
    if (!S.lines.length) { S.shardMsg = "Nothing to save yet: the transcript has not loaded."; return note(); }
    const label = b.textContent; b.dataset.busy = "1"; b.innerHTML = '<span class="spin"></span> Saving';
    const has = !!S.summary.trim();
    const doc = {
      title: `${vtitle()} — NouGenTube ${has ? (STYN[S.sty] || "summary") : "transcript"}`.slice(0, 190), content: has ? reportDoc() : copyText(),
      tags: ["nougentube", "tube-report:" + S.vid, has ? (S.sty || "summary") : "transcript"], source_uri: "https://www.youtube.com/watch?v=" + S.vid };
    // Saving can take a while; use a kept-alive connection and retry once. A repeat is safe:
    // the vault recognises identical content and does not store it twice.
    const once = () => new Promise(res => { const p = chrome.runtime.connect({ name: "shard" }); const ka = setInterval(() => { try { p.postMessage({ ping: 1 }); } catch {} }, 15000);
      const fin = v => { clearInterval(ka); res(v); try { p.disconnect(); } catch {} };
      p.onMessage.addListener(fin); p.onDisconnect.addListener(() => fin(null)); p.postMessage({ doc }); });
    let r = await once(); if (!r) r = await once();
    S.shardMsg = r?.ok ? `Saved to NouGenShards: ${r.parts.length} shard${r.parts.length === 1 ? "" : "s"} (${r.parts.map(p => p.shard_id != null ? `${p.shard_id}@db${p.db_index}` : (p.captured ? "new" : "already stored")).join(", ")}).`
      : `Could not save to NouGenShards: ${r?.error || "the local bridge did not answer"}`;
    delete b.dataset.busy; b.textContent = label; save(); render(); note();
  }

  async function summarize() {
    S.summary = ""; S.shardMsg = ""; S.sty = $("sty").value; S.len = $("len").value; S.lng = $("lng").value;
    if (S.sty === "custom" && !(S.custom || "").trim()) return $("cp2")?.focus();
    const task = (S.sty === "custom" ? S.custom : STY[S.sty]) + " " + (S.sty === "mindmap" || S.sty === "chapters" || S.sty === "intel" ? "" : LEN[S.len]) + (S.lng !== "Auto" ? ` Write the answer in ${S.lng}.` : ""); render(); const bd = $("bd"), b = $("gen"); b.disabled = true; b.innerHTML = '<span class="spin"></span>Working'; S.sT0 = Date.now();
    const m = S.model || "";
    const k = kindOf(m);
    bd.innerHTML = k === "auto" ? loader("Finding the best available route", "Tries each route in order and moves on if one fails.", S.sT0)
      : k === "bridge" ? loader("Asking the NouGenOpen free fleet", "", S.sT0)
      : k === "key" ? loader("Asking " + label(m), "", S.sT0)
      : loader(`Running locally on ${m}`, "The first request after a while also loads the model into memory.", S.sT0);
    S.onStage = t => { if (!S.summary && S.tab === "summary") bd.innerHTML = loader(t, "", S.sT0); };
    S.onReset = () => { S.summary = ""; };
    let sys = SYS(); S.mapInfo = "";
    if ((S.model === "nougenopen:auto" || (S.model === "auto" && S.bridge)) && fullLen() > 14000) {
      try { const notes = await mapNotes(bd);
        bd.innerHTML = loader("Combining the notes into your summary", S.mapInfo, S.sT0);
        sys = `You are NouGenTube, writing about the YouTube video "${vtitle()}". Below are grounded, timestamped notes covering the whole video in order. Use only these notes; keep [m:ss] timestamps. When you quote, use only passages that appear inside double quotes on the QUOTE: lines, exactly as written. Markdown only.\n\nNOTES:\n${notes}`;
      } catch (e) { if (S.model === "auto") { sys = SYS(); S.mapInfo = ""; bd.innerHTML = loader("Finding the best available route", "", S.sT0); } else { S.summary = "⚠ " + e.message; b.disabled = false; b.textContent = "Regenerate"; return render(); } } }
    stream([{ role: "system", content: sys }, { role: "user", content: task }], d => { S.summary += d; if (S.tab === "summary") bd.innerHTML = show(S.summary) + WRITING; },
      (e, fin) => { S.summary += e; if (fin) S.summary += `\n\n— ${fin.model}, ${fin.tokens} tokens, ${Math.round((Date.now() - S.sT0) / 1000)}s, ${fin.where}${S.mapInfo ? " · map: " + S.mapInfo : ""}${fin.failed && fin.failed.length ? ` · after ${fin.failed.length} failed route${fin.failed.length === 1 ? "" : "s"}` : ""}`; save(); render(); });
  }
  function ask(q) {
    S.chat.push({ role: "user", content: q }, { role: "assistant", content: "" }); render(); const a = S.chat[S.chat.length - 1];
    S.onStage = null; S.onReset = () => { a.content = ""; };
    stream([{ role: "system", content: SYS() + (S.lng && S.lng !== "Auto" ? `\nAlways answer in ${S.lng}.` : "") }, ...S.chat.slice(0, -1).slice(-10)], d => { a.content += d; if (S.tab === "chat") { const ms = $("bd").querySelectorAll(".msg"); ms[ms.length - 1].innerHTML = md(a.content); $("bd").scrollTop = 1e9; } },
      e => { a.content += e; save(); render(); });
  }

  // ---------- persistence / export ----------
  const key = () => "v:" + S.vid;
  function save() { chrome.storage.local.set({ [key()]: { summary: S.summary, chat: S.chat, hl: S.hl, shardMsg: S.shardMsg || "" } }); }
  const saveHl = save;
  // Copy format: "<title> - YouTube\n<url>\n\nTranscript:\n(mm:ss) paragraph"
  const pad = t => { t = Math.floor(t); const h = t / 3600 | 0, m = String((t % 3600) / 60 | 0).padStart(2, "0"), x = String(t % 60).padStart(2, "0"); return h ? `${h}:${m}:${x}` : `${m}:${x}`; };
  const vtitle = () => (S.title = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata")?.textContent.trim() || (S.title !== "YouTube" && S.title) || document.title.replace(/ - YouTube$/, ""));
  const copyText = () => `${vtitle()} - YouTube\nhttps://www.youtube.com/watch?v=${S.vid}\n\nTranscript:\n` + S.paras.map(l => `(${pad(l.t)}) ${l.text}`).join("\n");
  function srtTime(t) { const ms = Math.round(t * 1000), h = ms / 3600000 | 0, m = (ms % 3600000) / 60000 | 0, s = (ms % 60000) / 1000 | 0;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0"); }
  function save2(ext, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = (S.title || S.vid).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) + ext; a.click(); }
  function download(kind = "md") {
    if (kind === "txt") return save2(".txt", copyText() + "\n", "text/plain");
    if (kind === "srt") return save2(".srt", S.lines.map((l, i) => `${i + 1}\n${srtTime(l.t)} --> ${srtTime(S.lines[i + 1] ? Math.min(S.lines[i + 1].t, l.t + 7) : l.t + 4)}\n${l.text}\n`).join("\n"), "application/x-subrip");
    const hk = Object.keys(S.hl).map(Number).sort((a, b) => a - b);
    const out = `# ${S.title}\nhttps://www.youtube.com/watch?v=${S.vid}\n\n` + (S.summary ? `## Summary\n${S.summary}\n\n` : "") +
      (hk.length ? `## Highlights\n${hk.map(k => `- [${fmt(k)}](https://youtu.be/${S.vid}?t=${k | 0}) ${S.hl[k]}`).join("\n")}\n\n` : "") +
      `## Transcript\n${S.paras.map(l => `[${fmt(l.t)}] ${l.text}`).join("\n\n")}\n`;
    save2(".md", out, "text/markdown");
  }

  // ---------- lifecycle (YouTube is an SPA) ----------
  async function load() {
    const vid = new URLSearchParams(location.search).get("v");
    if (location.pathname !== "/watch" || !vid) { host?.remove(); host = null; return; }
    if (!mount()) return setTimeout(load, 500);
    if (!alive()) return render();
    if (vid === S.vid) return;
    Object.assign(S, { vid, lines: [], paras: [], err: null, summary: "", chat: [], hl: {}, q: "", tT0: Date.now(), tStage: "", shardMsg: "" }); render();
    const st = (await chrome.storage.local.get(key()))[key()]; if (st) Object.assign(S, st);
    Object.assign(S, await chrome.storage.sync.get(["sty", "len", "lng", "custom"])); render(); note();
    try {
      const to = (pr, ms) => Promise.race([Promise.resolve(pr).catch(e => (console.warn("[NouGenTube]", e), null)), new Promise(r => setTimeout(() => r(null), ms))]);
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const gone = () => vid !== S.vid || !alive();
      S.title = document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");

      // 0. Saved copy from an earlier visit: instant, and immune to YouTube having a bad moment.
      let r = S.fresh ? null : await to(cacheGet(vid), 1500);
      S.fresh = false;

      // 1-4. Independent ways to get the transcript, tried in order, the whole ladder up to 3
      // times. One source failing never ends in an error while another can still answer.
      const TRIES = 3; let info = null;
      for (let n = 1; n <= TRIES && !r && !gone(); n++) {
        if (n > 1) { setStage(`Trying again (${n} of ${TRIES})`); await wait(1200 * n); if (gone()) return; }
        // A background tab can't render YouTube's panel, but the player still serves captions.
        if (document.hidden) r = await to(viaPlayer(vid), 12000);
        if (!r && n > 1) r = captured(vid);
        if (!r && !gone()) r = await to(viaPanel(vid, 18000), document.hidden ? 864e5 : 20000);
        if (!r && !gone()) { setStage("Asking the video player for its captions"); r = await to(viaPlayer(vid), 12000); }
        if (!r && !gone()) { setStage("Trying YouTube's caption service");
          const p = await to(playerResponse(vid), 10000);
          if (p) { S.title = p.pr?.videoDetails?.title || S.title; r = (await to(viaTimedtext(p.pr), 8000)) || (await to(viaInnertube(p), 8000)); } }
        if (!r && !gone()) {   // stop early only when YouTube itself says there is nothing to get
          info = await pageInfo();
          if (info && info.vid === vid && !info.tracks.length && !document.querySelector(BTN)) break;
        }
      }
      if (gone()) return;
      if (r) { r.lines = monotonic(r.lines); S.lines = r.lines; S.lang = r.lang; S.paras = paragraphs(r.lines); if (r.lang !== "saved") cachePut(vid, r); }
      else S.err = (info && info.vid === vid && !info.tracks.length && !document.querySelector(BTN))
        ? "This video has no captions, so there is no transcript to read."
        : "YouTube has captions for this video but didn't return them after 3 tries.";
    } catch (e) { S.err = "Transcript fetch failed: " + e.message; }
    render();
  }
  document.addEventListener("yt-navigate-finish", load);
  load();
})();
