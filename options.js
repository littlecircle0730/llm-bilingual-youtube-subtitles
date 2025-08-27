// (MV3-safe; no inline code, no eval)

const $ = (s) => document.querySelector(s);
const keyInput = $('#key');
const modelInput = $('#model');
const saveBtn = $('#save');
const testBtn = $('#test');
const msgEl = $('#msg');
const master = $('#master');

// Load existing settings
(async () => {
  if (!chrome?.storage?.local) {
    msgEl.textContent = '⚠ Unable to access chrome.storage. Please open this page from the extension "Options" menu.';
    return;
  }

  // Retrieve all required keys at once (including ytbc_masterEnabled)
  const cfg = await chrome.storage.local.get(['openai_key', 'openai_model', 'ytbc_masterEnabled']);

  // Master switch: default ON if not set
  master.checked = cfg.ytbc_masterEnabled ?? true;

  master.addEventListener('change', async () => {
    await chrome.storage.local.set({ ytbc_masterEnabled: master.checked });
  });

  if (cfg.openai_key) keyInput.value = cfg.openai_key;
  modelInput.value = cfg.openai_model || 'gpt-4o';
})();

// Save
saveBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    openai_key: keyInput.value.trim(),
    openai_model: modelInput.value.trim() || 'gpt-4o',
  });
  msgEl.textContent = 'Saved';
});

// Test translation (calls bg.js onMessage listener)
testBtn.addEventListener('click', async () => {
  msgEl.textContent = '⏳ Testing…';
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      texts: ['Hello world!', 'You have successfully link to the LLM.'],
      targetLang: 'zh-TW'
    });
    if (r?.ok) {
      msgEl.textContent = 'OK ' + JSON.stringify(r.translations);
    } else {
      msgEl.textContent = 'ERR ' + (r?.error || 'Unknown error');
    }
  } catch (e) {
    msgEl.textContent = 'ERR ' + (e?.message || String(e));
  }
});
