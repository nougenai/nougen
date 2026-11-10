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
  async function viaPanel() {
    const wait = ms => new Promise(r => setTimeout(r, ms)); let b;
    if (document.hidden) await new Promise(r => document.addEventListener("visibilitychange", function f() { if (!document.hidden) { document.removeEventListener("visibilitychange", f); r(); } }));
    for (let i = 0; i < 40 && !(b = document.querySelector("ytd-video-description-transcript-section-renderer button")); i++) await wait(250);
    if (!b) return null;
    const panel = () => document.querySelector("ytd-engagement-panel-section-list-renderer[target-id*=transcript]");
    const wasOpen = panel()?.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    const style = document.createElement("style"); style.textContent = "ytd-engagement-panel-section-list-renderer[target-id*=transcript]{opacity:0!important;pointer-events:none!important}";
    if (!wasOpen) document.head.append(style);
    b.click(); let segs = [];
    for (let i = 0; i < 60 && !(segs = document.querySelectorAll("ytd-transcript-segment-renderer")).length; i++) await wait(250);
    const out = [...segs].map(s => ({ t: parseTs((s.querySelector(".segment-timestamp")?.textContent || "0").trim()),
      text: (s.querySelector(".segment-text")?.textContent || "").replace(/\s+/g, " ").trim() })).filter(l => l.text);
    if (!wasOpen) { panel()?.querySelector("#visibility-button button")?.click(); await wait(300); style.remove(); }
    return out.length ? { lines: out, lang: "YouTube" } : null;
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
        <button class="ib" id="key" title="NVIDIA API key">⚙</button><button class="ib" id="cp" title="Copy transcript">⧉</button><button class="ib" id="dl" title="Export">⤓</button><div class="menu" id="menu" hidden><button data-x="md">Markdown (everything)</button><button data-x="txt">Transcript .txt</button><button data-x="srt">Subtitles .srt</button></div>
        <button class="ib" id="col" title="Collapse">▾</button></div>
      <div id="wrap"><div class="tabs"><button data-t="transcript">Transcript</button><button data-t="summary">Summary</button><button data-t="chat">Chat</button><button data-t="highlights">Highlights</button></div>
      <div class="tb" id="tb"></div><div class="bd" id="bd"></div><div id="ft"></div></div></div>`;
    root.querySelector(".tabs").onclick = e => { const t = e.target.dataset.t; if (t) { S.tab = t; render(); } };
    root.getElementById("col").onclick = () => { const w = root.getElementById("wrap"); w.hidden = !w.hidden; root.querySelector(".p").style.height = w.hidden ? "auto" : ""; };
    root.getElementById("cp").onclick = () => navigator.clipboard.writeText(copyText()).then(() => { const b = root.getElementById("cp"); b.textContent = "✓"; setTimeout(() => b.textContent = "⧉", 1200); });
    root.getElementById("dl").onclick = e => { e.stopPropagation(); const m = root.getElementById("menu"); m.hidden = !m.hidden; };
    root.getElementById("menu").onclick = e => { const x = e.target.dataset.x; if (x) { root.getElementById("menu").hidden = true; download(x); } };
    root.getElementById("key").onclick = () => { const k = prompt("NVIDIA API key (nvapi-…) from build.nvidia.com — stored only in this browser. Leave empty to remove."); if (k === null) return;
      if (k.trim()) chrome.storage.local.set({ nvKey: k.trim() }); else chrome.storage.local.remove("nvKey"); S.nvKey = !!k.trim(); render(); };
    root.addEventListener("click", e => { const a = e.target.closest("[data-seek]"); if (a) { e.stopPropagation(); seek(+a.dataset.seek); } });
    chrome.runtime.sendMessage({ type: "models" }, r => { if (r?.ok) { S.models = r.models; S.model = r.current; S.nvKey = r.nvKey; S.ollamaErr = r.ollamaErr; } root.getElementById("mdl").textContent = "· " + label(S.model || ""); render(); });
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

  function render() {
    if (!root) return;
    root.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === S.tab));
    const tb = $("tb"), bd = $("bd"), ft = $("ft"); ft.innerHTML = ""; tb.innerHTML = ""; tb.hidden = false;
    if (S.err) { bd.innerHTML = `<div class="mu err">${esc(S.err)}</div><div class="mu"><button class="go" id="rt">Retry</button></div>`; $("rt").onclick = () => { S.vid = null; load(); }; return; }
    if (!S.lines.length) { bd.innerHTML = `<div class="mu">${document.hidden ? "Waiting for this tab to be visible (YouTube only renders transcripts on screen)…" : "Loading transcript…"}</div>`; return; }
    if (S.tab === "transcript") {
      tb.innerHTML = `<input id="q" placeholder="Search transcript…" value="${esc(S.q || "")}"><span class="chip ${S.follow ? "on" : ""}" id="fl" title="Auto-scroll with the video">Follow</span><span class="mu" style="padding:0">${S.lang || ""}</span>`;
      $("q").oninput = e => { S.q = e.target.value; drawLines(); }; $("fl").onclick = () => { S.follow = !S.follow; render(); };
      drawLines();
    } else if (S.tab === "summary") {
      tb.style.flexWrap = "wrap";
      tb.innerHTML = modelPicker() + `<select id="sty">${Object.entries(STYN).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <select id="len" title="Length"><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select>
        <select id="lng" title="Output language">${LANGS.map(l => `<option>${l}</option>`).join("")}</select>
        <button class="go" id="gen">${S.summary ? "Regenerate" : "Summarize"}</button>
        ${(S.sty || "brief") === "custom" ? `<input id="cp2" style="flex-basis:100%" placeholder="Your own prompt, e.g. Write a LinkedIn post from this video" value="${esc(S.custom || "")}">` : ""}`;
      wirePicker(); $("sty").value = S.sty || "brief"; $("len").value = S.len || "medium"; $("lng").value = S.lng || "Auto";
      $("sty").onchange = e => { S.sty = e.target.value; prefs(); render(); }; $("len").onchange = e => { S.len = e.target.value; prefs(); }; $("lng").onchange = e => { S.lng = e.target.value; prefs(); };
      if ($("cp2")) $("cp2").oninput = e => { S.custom = e.target.value; prefs(); };
      $("gen").onclick = summarize;
      bd.innerHTML = S.summary ? show(S.summary) : `<div class="mu">Summaries run on your local Ollama — nothing leaves this machine. Timestamps in the result jump the video.</div>`;
    } else if (S.tab === "chat") {
      tb.innerHTML = modelPicker() + `<span class="chip" data-p="What are the main takeaways?">Takeaways</span><span class="chip" data-p="List every tool, product or resource mentioned, with timestamps.">Resources</span><span class="chip" data-p="What claims here might be wrong or need checking?">Fact-check</span>`;
      wirePicker(); tb.querySelectorAll("[data-p]").forEach(c => c.onclick = () => ask(c.dataset.p));
      bd.innerHTML = S.chat.map(m => `<div class="msg ${m.role === "user" ? "u" : ""}">${m.role === "user" ? esc(m.content) : md(m.content)}</div>`).join("") || `<div class="mu">Ask anything about this video. Answers cite timestamps.</div>`;
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
  function label(m) { return m === "nougenopen:auto" ? "NouGenOpen · free fleet" : m.startsWith("nvidia:") ? "NVIDIA · " + m.split("/").pop() : m; }
  function modelPicker() { return S.models ? `<select id="mp" title="Model">${S.models.map(m => `<option value="${esc(m)}" ${m === S.model ? "selected" : ""}>${esc(label(m))}${m.startsWith("nougenopen:") ? " ($0, parallel)" : m.startsWith("nvidia:") ? (S.nvKey ? "" : " (needs key)") : " (local)"}</option>`).join("")}</select>` : ""; }
  function wirePicker() { const p = $("mp"); if (p) p.onchange = e => { S.model = e.target.value; chrome.storage.sync.set({ model: S.model }); $("mdl").textContent = "· " + label(S.model); }; }

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
  const STYN = { brief: "Key points", deep: "Deep dive", chapters: "Chapters", mindmap: "Mind map", steps: "Step-by-step", tldr: "TL;DR", quiz: "Quiz", custom: "Custom prompt…" };
  const LANGS = ["Auto", "English", "Español", "Français", "Kreyòl ayisyen", "Português", "Deutsch", "Italiano", "日本語", "한국어", "中文", "العربية", "हिन्दी"];
  const LEN = { short: "Keep it tight: about 120 words.", medium: "About 300 words.", long: "Thorough: up to 800 words." };
  const STY = { chapters: "Split the whole video into 5-12 chapters in order. For each: a line \"[m:ss] **Chapter title**\" then one sentence on what it covers.",
    mindmap: "Produce a mind map as a nested markdown bullet outline (2-space indents, max 4 levels). Root = the video topic. Branches = main themes in order, leaves = concrete details with [m:ss]. Output ONLY the outline.",
    quiz: "Write 5 multiple-choice questions testing the key ideas. Each: question, options A-D, then \"Answer: X — [m:ss]\".",
    custom: "", brief: "Give a one-line gist, then 5-8 key points as bullets, each with its timestamp.", deep: "Give a sectioned deep-dive: ### headings per topic in order, bullets under each with timestamps, then 'Recommended to watch' (the 3 most valuable moments as [m:ss] links with why), 'Notable quotes' and 'Action items'.", steps: "Extract the procedure as numbered steps with timestamps, plus prerequisites and gotchas.", tldr: "Three sentences max, plus the single most important timestamp." };
  function stream(messages, onDelta, onDone) {
    if (S.port) S.port.disconnect(); const port = S.port = chrome.runtime.connect({ name: "chat" });
    port.onMessage.addListener(m => { if (m.delta) onDelta(m.delta); if (m.error) onDone("\n\n⚠ " + m.error); if (m.done) onDone("", m); });
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
    bd.innerHTML = `<div class="mu">Long video: mapping ${cs.length} topic chunks across the NouGenOpen free fleet in parallel…</div>`;
    const sys = `You take grounded notes on one part of the YouTube video "${vtitle()}". Only facts the speaker states. Keep every useful [m:ss] timestamp.`;
    const prompts = cs.map((c, i) => `Part ${i + 1}/${cs.length} (${fmt(c.from)}-${fmt(c.to)}). Write 4-8 terse bullet notes, each ending with its [m:ss].\n\n${c.text}`);
    const r = await new Promise(res => { const p = chrome.runtime.connect({ name: "map" }); const ka = setInterval(() => { try { p.postMessage({ ping: 1 }); } catch {} }, 15000);
      p.onMessage.addListener(m => { clearInterval(ka); res(m); p.disconnect(); }); p.onDisconnect.addListener(() => { clearInterval(ka); res({ ok: false, error: "background stopped" }); }); p.postMessage({ prompts, system: sys }); });
    if (!r?.ok) throw new Error(r?.error || "map failed");
    const ok = r.results.filter(x => x.ok).length;
    S.mapInfo = `${ok}/${cs.length} chunks via ${[...new Set(r.results.filter(x => x.ok).map(x => x.provider))].join(", ")}`;
    return r.results.map((x, i) => `### Part ${i + 1} (${fmt(cs[i].from)}-${fmt(cs[i].to)})\n${x.ok ? x.content : "(chunk failed: " + x.error + ")"}`).join("\n\n");
  }

  async function summarize() {
    S.summary = ""; S.sty = $("sty").value; S.len = $("len").value; S.lng = $("lng").value;
    if (S.sty === "custom" && !(S.custom || "").trim()) return $("cp2")?.focus();
    const task = (S.sty === "custom" ? S.custom : STY[S.sty]) + " " + (S.sty === "mindmap" || S.sty === "chapters" ? "" : LEN[S.len]) + (S.lng !== "Auto" ? ` Write the answer in ${S.lng}.` : ""); render(); const bd = $("bd"), b = $("gen"); b.disabled = true; b.textContent = "Thinking…";
    let sys = SYS(); S.mapInfo = "";
    if (S.model === "nougenopen:auto" && fullLen() > 14000) {
      try { const notes = await mapNotes(bd);
        sys = `You are NouGenTube, writing about the YouTube video "${vtitle()}". Below are grounded, timestamped notes covering the whole video in order. Use only these notes; keep [m:ss] timestamps. Markdown only.\n\nNOTES:\n${notes}`;
      } catch (e) { S.summary = "⚠ " + e.message; b.disabled = false; b.textContent = "Regenerate"; return render(); } }
    stream([{ role: "system", content: sys }, { role: "user", content: task }], d => { S.summary += d; if (S.tab === "summary") bd.innerHTML = show(S.summary); },
      (e, fin) => { S.summary += e; if (fin) S.summary += `\n\n— ${fin.model}, ${fin.tokens} tokens, ${fin.where}${S.mapInfo ? " · map: " + S.mapInfo : ""}`; save(); render(); });
  }
  function ask(q) {
    S.chat.push({ role: "user", content: q }, { role: "assistant", content: "" }); render(); const a = S.chat[S.chat.length - 1];
    stream([{ role: "system", content: SYS() + (S.lng && S.lng !== "Auto" ? `\nAlways answer in ${S.lng}.` : "") }, ...S.chat.slice(0, -1).slice(-10)], d => { a.content += d; if (S.tab === "chat") { const ms = $("bd").querySelectorAll(".msg"); ms[ms.length - 1].innerHTML = md(a.content); $("bd").scrollTop = 1e9; } },
      e => { a.content += e; save(); render(); });
  }

  // ---------- persistence / export ----------
  const key = () => "v:" + S.vid;
  function save() { chrome.storage.local.set({ [key()]: { summary: S.summary, chat: S.chat, hl: S.hl } }); }
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
    if (vid === S.vid) return;
    Object.assign(S, { vid, lines: [], paras: [], err: null, summary: "", chat: [], hl: {}, q: "" }); render();
    const st = (await chrome.storage.local.get(key()))[key()]; if (st) Object.assign(S, st);
    Object.assign(S, await chrome.storage.sync.get(["sty", "len", "lng", "custom"])); render();
    try {
      const to = (pr, ms) => Promise.race([pr.catch(e => (console.warn("[NouGenTube]", e), null)), new Promise(r => setTimeout(() => r(null), ms))]);
      S.title = document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
      let r = await to(viaPanel(), document.hidden ? 864e5 : 25000); console.debug("[NouGenTube] panel tier:", r?.lines.length);
      if (!r) { const p = await to(playerResponse(vid), 10000);
        if (p) { S.title = p.pr?.videoDetails?.title || S.title; r = (await to(viaTimedtext(p.pr), 8000)) || (await to(viaInnertube(p), 8000)); } }
      if (vid !== S.vid) return;
      if (!r) S.err = "No captions available for this video."; else { S.lines = r.lines; S.lang = r.lang; S.paras = paragraphs(r.lines); }
    } catch (e) { S.err = "Transcript fetch failed: " + e.message; }
    render();
  }
  document.addEventListener("yt-navigate-finish", load);
  load();
})();
