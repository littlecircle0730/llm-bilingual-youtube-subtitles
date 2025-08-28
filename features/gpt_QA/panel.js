const DEBUG_MAX = 600;

async function renderMarkdownInto(el, mdText) {
  try {
    if (!window.marked || !window.DOMPurify) {
      throw new Error('Markdown libs not loaded');
    }
    const html = window.marked.parse(mdText || '');
    el.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch (err) {
    el.textContent = mdText || '';
  }
}

(() => {
  if (window.__gl_sidebar_injected__) return;
  window.__gl_sidebar_injected__ = true;

  // --- selection cache to avoid losing selection when clicking the sidebar
  let lastSelectionText = '';
  document.addEventListener('selectionchange', () => {
    const s = (window.getSelection()?.toString() || '').trim();
    if (s) lastSelectionText = s;
  });

  // --- create sidebar root (keep id = gl-panel to match CSS)
  const root = document.createElement('aside');
  root.id = 'gl-panel';
  document.documentElement.appendChild(root);

  // --- build UI once
  root.innerHTML = `
    <div class="gl-tab">Q&A</div>
    <div class="gl-wrap">
      <header>Page Q&A</header>

      <div class="gl-row">
        <div class="gl-small">Select text on the page, or click "Scan visible content".</div>
        <div class="gl-btns" style="margin-top:6px;">
          <button id="gl-btn-sel">Use Selection</button>
          <button id="gl-btn-scan">Scan Visible</button>
          <button id="gl-btn-clear">Clear</button>
        </div>
      </div>

      <div class="gl-row">
        <label class="gl-small">Context</label>
        <textarea id="gl-context" class="gl-ctx" placeholder="Your selected or scanned content will appear here"></textarea>
      </div>

      <div class="gl-row">
        <label class="gl-small" for="gl-lang">Answer Language</label>
        <select id="gl-lang" class="gl-input">
          <option value="zh-TW">繁體中文</option>
          <option value="en">English</option>
        </select>
        <div class="gl-small" style="margin-top:4px;">
          Default to the selected language unless the question explicitly asks for a different language.
        </div>
      </div>

      <div class="gl-row">
        <label class="gl-small">Question</label>
        <input id="gl-question" class="gl-input" placeholder="What would you like to ask?">
      </div>

      <div class="gl-row gl-btns">
        <button id="gl-ask">Ask</button>
        <span id="gl-status" class="gl-small" aria-live="polite"></span>
      </div>

      <div class="gl-answer" id="gl-answer"><div class="gl-small">Answer will appear here.</div></div>
    </div>
  `;


  // --- helpers
  const $ = (sel) => root.querySelector(sel);

  // tab toggle open/close & shift when open
  const panel = document.getElementById("gl-panel");
  const tab   = panel.querySelector(".gl-tab");
  tab.addEventListener("click", () => {
    panel.classList.toggle("open");
    document.body.classList.toggle("panel-open"); 
  });

  // refs
  const ctxEl = $('#gl-context');
  const qEl = $('#gl-question');
  const langEl = $('#gl-lang');
  const ansEl = $('#gl-answer');
  const statusEl = $('#gl-status');

  // Use Selection (prefer cache to avoid losing when clicking)
  $('#gl-btn-sel').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const live = (window.getSelection()?.toString() || '').trim();
    const best = live || lastSelectionText || '';
    ctxEl.value = best;
    console.debug('[gpt_QA] use selection:', {
      from: live ? 'live' : (lastSelectionText ? 'cache' : 'empty'),
      preview: best.slice(0, 200),
      len: best.length
    });
  });

  // Scan Visible (conservative walker)
  $('#gl-btn-scan').addEventListener('click', () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const s = n.textContent.replace(/\s+/g, ' ').trim();
        if (!s) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];
    let node, total = 0, MAX = 5000;
    while ((node = walker.nextNode()) && total < MAX) {
      let s = node.textContent.replace(/\s+/g, ' ').trim();
      if (s.length > MAX - total) s = s.slice(0, MAX - total);
      parts.push(s);
      total += s.length + 1;
    }
    ctxEl.value = parts.join('\n');
    console.debug('[gpt_QA] scan visible:', { preview: ctxEl.value.slice(0, 200), len: ctxEl.value.length });
  });

  // Clear
  $('#gl-btn-clear').addEventListener('click', () => {
    ctxEl.value = '';
    qEl.value = '';
    ansEl.innerHTML = '<div class="gl-small">Cleared.</div>';
  });

  // Ask
  $('#gl-ask').addEventListener('click', async () => {
    const context = ctxEl.value.trim();
    const question = qEl.value.trim();
    const preferredLang = langEl.value || 'zh-TW';
    if (!question) { qEl.focus(); return; }

    const payload = { type: 'ASK_PAGE_QA', context, question, preferredLang };

    console.debug('[gpt_QA] outbound payload', {
      keys: Object.keys(payload),
      preferredLang,
      contextLen: context.length,
      contextPreview: context.slice(0, 200),
      questionPreview: question.slice(0, 200),
    });

    statusEl.textContent = 'Thinking…';
    ansEl.textContent = '';

    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (r) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(r);
        });
      });

      console.debug('[gpt_QA] inbound response:', {
        ok: resp?.ok,
        answerPreview: (resp?.answer || '').slice(0, DEBUG_MAX),
        error: resp?.error
      });

      if (resp?.ok) {
        await renderMarkdownInto(ansEl, resp.answer || ''); // in Markdown format
      } else {
        ansEl.textContent = 'Error: ' + (resp?.error || 'unknown');
      }
    } catch (e) {
      ansEl.textContent = 'Error: ' + (e?.message || e);
    } finally {
      statusEl.textContent = '';
    }
  });

  // optional: Alt+G to toggle
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'g') root.classList.toggle('open');
  });
})();
