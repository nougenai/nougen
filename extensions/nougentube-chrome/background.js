// NouGenTube background: streams chat from local Ollama or NVIDIA build (OpenAI-compatible) to the panel.
const DEF = { host: "http://localhost:11434", model: "gemma4:e2b-qat" };
const NGO = "http://127.0.0.1:8765"; // nougen-open serve (free fleet bridge)
const NV = { url: "https://integrate.api.nvidia.com/v1/chat/completions", models: ["google/gemma-4-31b-it"] };
const cfg = async () => ({ ...DEF, ...(await chrome.storage.sync.get(["host", "model"])), ...(await chrome.storage.local.get(["nvKey"])) });

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === "models") {
    cfg().then(async c => {
      let local = [], err = null, ngo = false;
      try { ngo = (await fetch(NGO + "/health", { signal: AbortSignal.timeout(1500) })).ok; } catch {}
      try { local = (await (await fetch(c.host + "/api/tags")).json()).models.map(m => m.name); } catch (e) { err = String(e); }
      reply({ ok: true, models: [...(ngo ? ["nougenopen:auto"] : []), ...NV.models.map(m => "nvidia:" + m), ...local], nougenopen: ngo, current: c.model, nvKey: !!c.nvKey, ollamaErr: err });
    });
    return true;
  }
  if (msg.type === "shard") {
    fetch(NGO + "/v1/nougen/shard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg.doc) })
      .then(async r => { const j = await r.json(); reply(r.ok ? { ok: !!j.ok, parts: j.parts || [] } : { ok: false, error: j.error?.message || ("bridge said " + r.status) }); })
      .catch(() => reply({ ok: false, error: "the NouGenOpen bridge is not running (nougen-open serve)" }));
    return true;
  }
  if (msg.type === "map") {
    fetch(NGO + "/v1/nougen/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: msg.prompts, system: msg.system, max_tokens: 1200 }) })
      .then(r => r.json()).then(j => reply({ ok: true, results: j.results })).catch(e => reply({ ok: false, error: String(e) }));
    return true;
  }
});

async function* lines(r) {
  const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
    const ls = buf.split("\n"); buf = ls.pop(); for (const l of ls) if (l.trim()) yield l.trim(); }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === "map") {
    port.onMessage.addListener(async msg => {
      if (msg.ping) return;   // keepalive: each message resets the service worker idle timer
      try { const r = await fetch(NGO + "/v1/nougen/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: msg.prompts, system: msg.system, max_tokens: 1500 }) });
        const j = await r.json(); port.postMessage(r.ok ? { ok: true, results: j.results } : { ok: false, error: j.error?.message || String(r.status) });
      } catch (e) { port.postMessage({ ok: false, error: String(e) }); }
    });
    return;
  }
  if (port.name !== "chat") return;
  let ctrl;
  port.onDisconnect.addListener(() => { port._closed = true; ctrl && ctrl.abort(); });
  port.onMessage.addListener(async ({ messages, ping }) => {
    if (ping) return;   // keepalive only
    const c = await cfg(); ctrl = new AbortController(); const signal = ctrl.signal;
    try {
      if (c.model.startsWith("nougenopen:")) {
        const r = await fetch(NGO + "/v1/chat/completions", { method: "POST", signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "nougenopen/auto", messages, max_tokens: 3000, temperature: 0.3 }) });
        const j = await r.json(); if (!r.ok) throw new Error("NouGenOpen " + r.status + " " + (j.error?.message || "").slice(0, 200));
        port.postMessage({ delta: j.choices[0].message.content });
        port.postMessage({ done: true, model: j.model, tokens: j.usage?.completion_tokens || "?", where: "NouGenOpen free fleet via " + (j.nougen?.provider || "?") });
        return;
      }
      if (c.model.startsWith("nvidia:")) {
        if (!c.nvKey) throw new Error("Add your NVIDIA API key (⚙ in the panel header). Get one free at build.nvidia.com.");
        const model = c.model.slice(7);
        let slow = false; const tm = setTimeout(() => { slow = true; ctrl.abort(); }, 90000);
        const r = await fetch(NV.url, { method: "POST", signal, headers: { "content-type": "application/json", authorization: "Bearer " + c.nvKey, accept: "text/event-stream" },
          body: JSON.stringify({ model, messages, stream: true, max_tokens: 4096, temperature: 0.3, top_p: 0.95 }) });
        clearTimeout(tm);
        if (!r.ok) throw new Error("NVIDIA " + r.status + " " + (await r.text()).slice(0, 200));
        let toks = 0;
        for await (const l of lines(r)) { if (!l.startsWith("data:")) continue; const d = l.slice(5).trim(); if (d === "[DONE]") break;
          const j = JSON.parse(d); const t = j.choices?.[0]?.delta?.content; if (t) port.postMessage({ delta: t }); if (j.usage) toks = j.usage.completion_tokens; }
        port.postMessage({ done: true, model, tokens: toks || "?", where: "NVIDIA" });
        return;
      }
      const body = think => JSON.stringify({ model: c.model, messages, stream: true, ...(think === false ? { think: false } : {}), options: { num_ctx: 16384, temperature: 0.3 } });
      let r = await fetch(c.host + "/api/chat", { method: "POST", body: body(false), signal });
      if (!r.ok) r = await fetch(c.host + "/api/chat", { method: "POST", body: body(), signal });
      if (!r.ok) throw new Error("Ollama " + r.status + " " + (await r.text()).slice(0, 200));
      for await (const l of lines(r)) { const j = JSON.parse(l); if (j.message?.content) port.postMessage({ delta: j.message.content });
        if (j.done) port.postMessage({ done: true, model: j.model, tokens: j.eval_count, where: "local" }); }
    } catch (e) {
      if (e.name !== "AbortError") port.postMessage({ error: String(e.message || e) });
      else if (c.model.startsWith("nvidia:") && signal.aborted && !port._closed) port.postMessage({ error: "NVIDIA free endpoint did not answer within 90s (queued upstream). Try again, or switch to NouGenOpen / local." });
    }
  });
});
