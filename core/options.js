// options.js (MV3-safe)

const $ = (s) => document.querySelector(s);
const keyInput = $('#key');
const modelInput = $('#model');
const saveBtn = $('#save');
const testBtn = $('#test');
const msgEl = $('#msg');
const master = $('#master');

// ---- i18n helpers ----
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const txt = chrome.i18n?.getMessage(key) || el.textContent;
    if (txt) el.textContent = txt;
  });
  // placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const txt = chrome.i18n?.getMessage(key);
    if (txt) el.setAttribute('placeholder', txt);
  });
}

function i18n(key, fallback = '') {
  return chrome.i18n?.getMessage(key) || fallback;
}

applyI18n();

// ---- load & wire options ----
(async () => {
  if (!chrome?.storage?.local) {
    msgEl.textContent = i18n('msg_no_storage', 'Unable to access chrome.storage. Please open this page from the extension Options menu.');
    return;
  }

  const cfg = await chrome.storage.local.get(['openai_key', 'openai_model', 'ytbc_masterEnabled']);

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
  msgEl.textContent = i18n('msg_saved', 'Saved');
});

// Test translation (calls bg.js onMessage listener)
testBtn.addEventListener('click', async () => {
  msgEl.textContent = i18n('msg_testing', 'Testing…');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      texts: ['Hello world!', 'How are you?'],
      targetLang: 'zh-TW'
    });
    if (r?.ok) {
      msgEl.textContent = 'OK ' + JSON.stringify(r.translations);
    } else {
      msgEl.textContent = 'ERR ' + (r?.error || i18n('msg_unknown_error', 'Unknown error'));
    }
  } catch (e) {
    msgEl.textContent = 'ERR ' + (e?.message || i18n('msg_unknown_error', 'Unknown error'));
  }
});