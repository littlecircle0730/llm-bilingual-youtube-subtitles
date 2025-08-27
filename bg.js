// bg.js (MV3 Service Worker) — CLEAN VERSION
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, ms = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// The one and only callOpenAI function
async function callOpenAI({ key, model, texts, targetLang }) {
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a professional translation engine. Output ONLY a JSON object with this exact schema: " +
          "{\"translations\":[\"string\"]}. Keep 1-to-1 alignment with the input array."
      },
      { role: "user", content: JSON.stringify({ targetLang, texts }) }
    ],
    response_format: { type: "json_object" },
    temperature: 0.2
  };

  let resp;
  try {
    resp = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, 45000);
  } catch (e) {
    if (e?.name === 'AbortError' || String(e?.message).includes('timeout')) {
      throw new Error('openai-timeout');
    }
    throw e;
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => String(resp.status));
    throw new Error(`OpenAI HTTP ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Model did not output valid JSON: " + content.slice(0, 200));
  }

  const arr = Array.isArray(parsed?.translations) ? parsed.translations : [];
  // Align array length to avoid crash
  while (arr.length < texts.length) arr.push("");
  if (arr.length > texts.length) arr.length = texts.length;
  return arr;
}

async function translateBatch({
  key,
  model = "gpt-4o",
  texts,
  targetLang,
  batchSize = 8,
  concurrency = 2
}) {
  const chunks = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    chunks.push(texts.slice(i, i + batchSize));
  }

  const results = new Array(texts.length).fill('');
  let cursor = 0;

  async function worker() {
    while (true) {
      const myIndex = cursor++;
      if (myIndex >= chunks.length) break;

      const part = chunks[myIndex];
      let out = [];
      for (let tries = 0; tries < 4; tries++) {
        try {
          out = await callOpenAI({ key, model, texts: part, targetLang });
          break; // Exit retry loop if successful
        } catch (e) {
          if (tries === 3) throw e; // Throw error if final attempt fails
          await sleep(600 * Math.pow(2, tries)); // 600, 1200, 2400
        }
      }

      const offset = myIndex * batchSize;
      out.forEach((t, i) => (results[offset + i] = t || ""));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// === Single onMessage handler: always responds; return true keeps the channel open ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'PING') {
    sendResponse({ ok: true, pong: true });
    return; // Synchronous reply, no need to return true
  }

  if (msg.type === 'TRANSLATE') {
    (async () => {
      try {
        const {
          openai_key,
          openai_model = 'gpt-4o',
          ytbc_batchSize = 8,
          ytbc_concurrency = 2
        } = await chrome.storage.local.get([
          'openai_key', 'openai_model', 'ytbc_batchSize', 'ytbc_concurrency'
        ]);

        if (!openai_key) {
          sendResponse({ ok: false, error: 'OpenAI API Key not set (go to extension menu → Options).' });
          return;
        }

        const texts = Array.isArray(msg.texts) ? msg.texts : [];
        const targetLang = msg.targetLang || 'zh-TW';

        const translations = await translateBatch({
          key: openai_key,
          model: openai_model,
          texts,
          targetLang,
          batchSize: ytbc_batchSize || 8,
          concurrency: ytbc_concurrency || 2
        });
        console.log('[bg] TRANSLATE message received:', msg); 
        sendResponse({ ok: true, translations });
      } catch (e) {
        // Convert Abort/timeout into consistent string for frontend handling
        const em = String(e && e.message || e);
        if (em === 'openai-timeout') {
          sendResponse({ ok: false, error: 'openai-timeout' });
        } else {
          sendResponse({ ok: false, error: em });
        }
      }
    })();
    return true; // Asynchronous reply
  }
});