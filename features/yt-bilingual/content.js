// content.js
(function inject() {
  if (window !== window.top) return;
  if (!chrome.runtime?.id) return;

  const id = 'yt-bc-inject';
  if (!document.getElementById(id)) {
    const url = chrome.runtime.getURL('features/yt-bilingual/inject.js');
    const s = document.createElement('script');
    s.id = id;
    s.src = url;
    s.onload = () => { console.log('[content] inject.js loaded'); s.remove(); };
    (document.head || document.documentElement).appendChild(s);
    console.log('[content] inject.js appended:', url);
  }

  if (!document.getElementById('yt-bc-style')) {
    const link = document.createElement('link');
    link.id = 'yt-bc-style';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('features/yt-bilingual/overlay.css');
    document.documentElement.appendChild(link);
  }
})();

// ---------- helpers ----------
function parseXmlTimedText(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, 'text/xml');
  const nodes = Array.from(dom.getElementsByTagName('text'));
  return nodes.map(n => {
    const start = Math.round(parseFloat(n.getAttribute('start') || '0') * 1000);
    const dur   = Math.round(parseFloat(n.getAttribute('dur') || '0') * 1000);
    const raw = n.textContent || '';
    const text = raw.replace(/\s+/g, ' ').trim();
    return { startMs: start, endMs: dur ? start + dur : start + 3000, text };
  });
}

async function fetchTimedText(url) {
  const r = await fetch(url, { credentials: 'include', mode: 'cors' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const body = await r.text();

  if (ct.includes('application/json')) {
    return parseJson3(JSON.parse(body));
  }
  if (ct.includes('text/xml') || ct.includes('application/xml')) {
    return parseXmlTimedText(body);
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return parseJson3(JSON.parse(trimmed));
  if (trimmed.startsWith('<')) return parseXmlTimedText(trimmed);
  throw new Error('non-timedtext-response');
}

function setNativeCCHidden(hide) {
  let st = document.getElementById('yt-bc-hide-native');
  if (hide) {
    if (!st) {
      st = document.createElement('style');
      st.id = 'yt-bc-hide-native';
      st.textContent = `.ytp-caption-window-container,.caption-window{display:none!important}`;
      document.documentElement.appendChild(st);
    } else st.disabled = false;
  } else {
    if (st) st.remove();
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseJson3(data){
  const ev = data?.events || [];
  const lines = ev
    .filter(e => e.segs && e.segs.length)
    .map(e => {
      const start = e.tStartMs ?? 0;
      const dur = e.dDurationMs ?? e.d ?? 0;
      const text = e.segs.map(s=>s.utf8).join('').replace(/\n/g,' ').trim();
      return { startMs: start, durMs: dur, text };
    });
  for (let i = 0; i < lines.length; i++) {
    const nextStart = i < lines.length - 1 ? lines[i+1].startMs : null;
    let end = lines[i].durMs ? lines[i].startMs + lines[i].durMs
             : nextStart ? nextStart
             : lines[i].startMs + 3000;
    lines[i].endMs = end;
    delete lines[i].durMs;
  }
  return lines;
}

function ensureOverlay(){
  let overlay = document.querySelector('.yt-bc-overlay');
  const player = document.querySelector('#movie_player, .html5-video-player, ytd-player');
  if (!player) return null;

  if (!overlay) {
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
    overlay = document.createElement('div');
    overlay.className = 'yt-bc-overlay';
    overlay.innerHTML = `
      <span style="display:inline-block;background:rgba(0,0,0,0.6);padding:6px 10px;border-radius:6px">
        <span class="yt-bc-original yt-bc-line yt-bc-original"></span>
        <span class="yt-bc-translated yt-bc-line yt-bc-translated"></span>
      </span>`;
    player.appendChild(overlay);
  }
  return overlay;
}

function activeText(segs, tMs){
  if (!Array.isArray(segs)) return '';
  for (const s of segs) if (tMs >= s.startMs && tMs < s.endMs) return s.text;
  return '';
}

async function waitForVideo(timeoutMs = 8000) {
  const t0 = performance.now();
  let v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  while (!v && performance.now() - t0 < timeoutMs) {
    await sleep(100);
    v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  }
  return v || null;
}

function setParam(u, k, v){
  try {
    const url = new URL(u);
    url.searchParams.set(k, v);
    return url.toString();
  } catch { 
    return u + (u.includes('?')?'&':'?') + `${k}=${encodeURIComponent(v)}`; 
  }
}
function removeParam(u, k){
  try {
    const url = new URL(u);
    url.searchParams.delete(k);
    return url.toString();
  } catch { 
    return u.replace(new RegExp(`([?&])${k}=[^&]*(&?)`,'i'), (m, p1, p2) => p2 ? p1 : ''); 
  }
}
function getVolumeControl() {
  return document.querySelector(
    '#movie_player .ytp-volume-panel,' +
    '.html5-video-player .ytp-volume-panel,' +
    'ytd-player .ytp-volume-panel,' +
    '#movie_player .ytp-mute-button,' +
    '.html5-video-player .ytp-mute-button,' +
    'ytd-player .ytp-mute-button'
  );
}


// ---------- state ----------
let pageUrl = location.href;
let controlsObserver = null;
let lastTimedTextBaseUrl = null;
let gSegsOrig = [];
let gSegsTran = [];
let rafId = null;
let isRunning = false;
let targetLang = 'zh-TW';
let useCustomAPI = true;
let translationEpoch = 0; // bump this on lang/source changes

// ====== Chunked translation manager ======
const CHUNK_MS = 45000;   // Each chunk is 45s
const OVERLAP_MS = 1500;  // 1.5s overlap to preserve context
let chunks = [];          // [{id,startMs,endMs,idxStart,idxEnd}]
const doneChunks = new Set();
const inflightChunks = new Set();

// chrome.storage.local.get(['ytbc_autoStart'], (cfg) => {
//   if (cfg.ytbc_autoStart) { isRunning = true; window.isRunning = true; startRender(); }
// });

chrome.storage?.local.get(['ytbc_targetLang', 'ytbc_useCustomAPI'], (cfg) => {
  if (cfg?.ytbc_targetLang) targetLang = cfg.ytbc_targetLang;
  if (typeof cfg?.ytbc_useCustomAPI === 'boolean') useCustomAPI = cfg.ytbc_useCustomAPI;
  mountControls();
});


// Split gSegsOrig into chunks by time; record covered subtitle index range
function buildChunks(lines){
  chunks = [];
  if (!lines?.length) return;
  let curStart = lines[0].startMs;
  let curEnd = curStart + CHUNK_MS;
  let idxStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    const segEnd = s.endMs;
    if (segEnd > curEnd && i > idxStart) {
      chunks.push({
        id: `${curStart}-${curEnd}`,
        startMs: Math.max(0, curStart - OVERLAP_MS),
        endMs: curEnd + OVERLAP_MS,
        idxStart,
        idxEnd: i - 1
      });
      // Start new chunk
      curStart = s.startMs;
      curEnd = curStart + CHUNK_MS;
      idxStart = i;
    }
  }
  // Last chunk
  chunks.push({
    id: `${curStart}-${curEnd}`,
    startMs: Math.max(0, curStart - OVERLAP_MS),
    endMs: (lines[lines.length-1].endMs ?? curEnd) + OVERLAP_MS,
    idxStart,
    idxEnd: lines.length - 1
  });
}

// Binary search: find chunk containing nowMs (return null if none)
function findChunkByTime(nowMs){
  let lo = 0, hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (nowMs < c.startMs) hi = mid - 1;
    else if (nowMs >= c.endMs) lo = mid + 1;
    else return c;
  }
  return null;
}

// Write translated subarray back to global gSegsTran (aligned by index)
function writeChunkIntoTranslated(chunk, translatedLines){
  // Note: translatedLines length should equal (idxEnd-idxStart+1)
  for (let i = chunk.idxStart, j = 0; i <= chunk.idxEnd && j < translatedLines.length; i++, j++) {
    const t = translatedLines[j];
    // Keep original timestamps, replace text
    gSegsTran[i] = { startMs: gSegsOrig[i].startMs, endMs: gSegsOrig[i].endMs, text: t.text ?? t };
  }
  window.gSegsTran = gSegsTran; // Update renderLoop in real time
}

// Translate only the chunk where current time belongs (if not already translated or in-flight)
async function ensureChunkTranslated(nowMs){
  if (!gSegsOrig.length || !chunks.length) return;
  const localEpoch = translationEpoch;              // ← capture

  const c = findChunkByTime(nowMs);
  if (!c) return;
  if (doneChunks.has(c.id) || inflightChunks.has(c.id)) return;

  inflightChunks.add(c.id);
  try {
    const subset = gSegsOrig.slice(c.idxStart, c.idxEnd + 1);
    let translatedSubset = [];

    if (useCustomAPI) {
      translatedSubset = await window.translateWithAPI(subset, targetLang);
    } else if (lastTimedTextBaseUrl) {
      translatedSubset = subset.map(s => ({ ...s })); // placeholder
    } else {
      translatedSubset = subset.map(s => ({ ...s }));
    }
    if (!Array.isArray(translatedSubset) || !translatedSubset.length) {
      translatedSubset = subset.map(s => ({ ...s }));
    }

    if (localEpoch !== translationEpoch) return;    // ← drop UI write if settings changed
    writeChunkIntoTranslated(c, translatedSubset);
    doneChunks.add(c.id);

    const nextIdx = chunks.findIndex(x => x.id === c.id) + 1;
    const next = chunks[nextIdx];
    if (next && !doneChunks.has(next.id) && !inflightChunks.has(next.id)) {
      ensureChunkTranslated(next.startMs + 1);
    }
  } catch (err) {
    console.warn('[chunk] translate failed', err);
  } finally {
    inflightChunks.delete(c.id);
  }
}

// Throttle: avoid triggering ensureChunkTranslated every frame
let lastCheck = 0;
function maybeEnsureByVideoTime(nowMs){
  const t = performance.now();
  if (t - lastCheck > 350) { // Check every 0.35s
    lastCheck = t;
    ensureChunkTranslated(nowMs);
  }
}


// ---------- UI ----------
function fallbackMount() {
  if (document.getElementById('yt-bc-ctrl')) return;

  const host = document.querySelector('#movie_player, .html5-video-player, ytd-player') || document.body;
  if (!host) {
    console.log("[yt-bc] host not ready, retry fallback in 500ms");
    setTimeout(fallbackMount, 500);
    return;
  }

  const box = document.createElement('div');
  box.id = 'yt-bc-ctrl';
  box.style.cssText = `
    position:absolute; right:12px; bottom:56px; z-index:999999;
    display:flex; gap:8px; align-items:center;
    background:rgba(0,0,0,.5); padding:6px 8px; border-radius:8px;
  `;
  box.appendChild(buildLangSelect());
  box.appendChild(buildSourceToggle());
  box.appendChild(buildToggleBtn());

  host.appendChild(box);
  ensureControlsMounted(true);
}

async function mountControls(){
  // If already exists, do not create again
  if (document.getElementById('yt-bc-ctrl')) return;

  const wrap = document.createElement('div');
  wrap.id = 'yt-bc-ctrl';
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '6px';
  wrap.style.marginLeft = '6px';
  wrap.style.fontSize = '11px';

  wrap.appendChild(buildLangSelect());    // Language select
  wrap.appendChild(buildSourceToggle());  // Source select
  wrap.appendChild(buildToggleBtn());     // Toggle button

  // 1. Next to volume button
  const volCtrl = getVolumeControl();
  if (volCtrl && volCtrl.parentNode) {
    volCtrl.parentNode.insertBefore(wrap, volCtrl.nextSibling);
    ensureControlsMounted(false);
    console.log("[yt-bc] Controls mounted next to volume button");
    return;
  }

  // 2. Next to time display
  const timeDisp = document.querySelector(
    '#movie_player .ytp-time-display,' +
    '.html5-video-player .ytp-time-display,' +
    'ytd-player .ytp-time-display'
  );
  if (timeDisp && timeDisp.parentNode) {
    timeDisp.parentNode.insertBefore(wrap, timeDisp.nextSibling);
    ensureControlsMounted(false);
    console.log("[yt-bc] Controls mounted next to time display");
    return;
  }

  // 3. Bottom-right floating box
  fallbackMount();
  console.log("[yt-bc] Controls mounted in bottom-right floating box");
}

function ensureControlsMounted(isFallback) {
  if (controlsObserver) { try { controlsObserver.disconnect(); } catch {} controlsObserver = null; }
  const host = document.querySelector('#movie_player, .html5-video-player, ytd-player') || document.body;
  const volCtrl = getVolumeControl();
  const target = (!isFallback && volCtrl?.parentNode) ? volCtrl.parentNode : host;

  controlsObserver = new MutationObserver(() => {
    const ctrl = document.getElementById('yt-bc-ctrl');
    const stillNextToVolume = ctrl && volCtrl && volCtrl.parentNode && volCtrl.parentNode.contains(ctrl);
    const attachedInHost = ctrl && host.contains(ctrl);
    if (!ctrl || (!isFallback && !stillNextToVolume) || (isFallback && !attachedInHost)) {
      mountControls();
    }
  });
  controlsObserver.observe(target, { childList: true, subtree: true });
}

function buildToggleBtn(){
  const btn = document.createElement('button');
  btn.className = 'ytp-button';
  btn.title = 'Bilingual Subtitles On/Off';
  btn.style.width = 'auto';
  btn.style.padding = '4px 8px';
  setBtnLabel(btn);

  btn.addEventListener('click', async () => {
    isRunning = !isRunning;
    window.isRunning = isRunning;
    setBtnLabel(btn);
    if (isRunning) {
      if (gSegsOrig.length || gSegsTran.length) startRender();
    } else {
      stopRender();
    }
  });
  return btn;
}
function setBtnLabel(btn){
  btn.textContent = isRunning ? '⏹ Disable Bilingual Subtitles' : '▶ Enable Bilingual Subtitles';
}

function buildSourceToggle(){
  const label = document.createElement('label');
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '4px';
  label.style.color = '#fff';
  label.style.fontSize = '12px';

  const sel = document.createElement('select');
  sel.title = 'Translation Source';
  sel.style.padding = '2px 6px';
  sel.innerHTML = `<option value="gpt">GPT</option><option value="yt">YouTube</option>`;
  sel.value = useCustomAPI ? 'gpt' : 'yt';

  const badge = document.createElement('span');
  badge.textContent = useCustomAPI ? 'GPT' : 'YT';
  badge.style.cssText = 'font-weight:600;padding:0 4px;background:rgba(255,255,255,.2);border-radius:4px;';

  sel.addEventListener('change', async (e) => {
    useCustomAPI = (e.target.value === 'gpt');
    badge.textContent = useCustomAPI ? 'GPT' : 'YT';
    chrome.storage?.local.set({ ytbc_useCustomAPI: useCustomAPI });
    handleLangOrSourceChange();             // ← react immediately
    if (isRunning && gSegsOrig.length) await rebuildTranslatedTrack();
  });

  label.appendChild(document.createTextNode('Source'));
  label.appendChild(sel);
  label.appendChild(badge);
  return label;
}

function buildLangSelect(){
  const sel = document.createElement('select');
  sel.title = 'Translate to…';
  sel.style.padding = '2px 6px';
  sel.innerHTML = `
    <option value="en">English</option>
    <option value="zh-TW">Traditional Chinese</option>
    <option value="zh-CN">Simplified Chinese</option>
    <option value="ja">Japanese</option>
    <option value="ko">Korean</option>
  `;
  sel.value = targetLang;

  sel.addEventListener('change', async (e)=>{
    targetLang = e.target.value || 'en';
    chrome.storage?.local.set({ ytbc_targetLang: targetLang });
    handleLangOrSourceChange(); // react immediately, but do NOT auto-start
  });  
  sel.addEventListener('dblclick', ()=>{
    const v = prompt('Enter BCP-47 language code:', targetLang);
    if (v) {
      targetLang = v.trim();
      sel.value = targetLang;
      useCustomAPI = true;
      chrome.storage?.local.set({ ytbc_targetLang: targetLang });
      // if (isRunning) rebuildTranslatedTrack();
      chrome.storage?.local.set({ ytbc_targetLang: targetLang, ytbc_useCustomAPI: true });
      handleLangOrSourceChange();         // react immediately
    }
  });
  return sel;
}
function handleLangOrSourceChange() {
  translationEpoch++;            // Invalidate older in-flight results
  doneChunks.clear();
  inflightChunks.clear();

  // Pre-fill with originals to avoid an empty screen
  if (gSegsOrig.length) {
    gSegsTran = gSegsOrig.map(s => ({ ...s }));
    window.gSegsTran = gSegsTran;
    buildChunks(gSegsOrig);
  }

  // If not enabled yet, just prepare data and exit (user must click Enable)
  if (!isRunning) return;

  // Immediately fetch/apply results for the current playback time
  const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  const now = v ? (v.currentTime || 0) * 1000 : 0;

  if (useCustomAPI) {
    // Current chunk + a bit ahead to feel instant
    ensureChunkTranslated(now);
    ensureChunkTranslated(now + 5000);
  } else if (lastTimedTextBaseUrl) {
    // YouTube built-in translation: fetch whole track once
    const tUrl = setParam(lastTimedTextBaseUrl, 'tlang', targetLang);
    fetchTimedText(tUrl).then(fullYT => {
      // If language/source changed again, you can guard with an epoch check here if needed
      if (!Array.isArray(fullYT)) return;
      gSegsTran = fullYT;
      window.gSegsTran = gSegsTran;
    }).catch(e => console.warn('[content] yt full rebuild fail', e));
  }
}

// ---------- Caption translation logic ----------
window.addEventListener('message', async (ev) => {
  if (ev.source !== window) return;
  const { type, url } = ev.data || {};
  if (type !== 'YT_TIMEDTEXT_URL' || !url) return;

  try {
    const base = url.includes('fmt=') ? url : url + '&fmt=json3';
    lastTimedTextBaseUrl = removeParam(base, 'tlang');

    // Fetch original captions (try regular, then ASR)
    let segsOrig = await fetchTimedText(base).catch(() => []);
    if (!segsOrig.length) {
      const asrUrl = base.includes('kind=asr') ? base : base + '&kind=asr';
      segsOrig = await fetchTimedText(asrUrl).catch(() => []);
    }

    // ===== Change: switch from full-file translation to chunked on-demand translation =====
    gSegsOrig = segsOrig;

    // Pre-fill translated array with originals to avoid empty UI; chunks will overwrite progressively
    gSegsTran = gSegsOrig.map(s => ({ ...s }));
    window.gSegsTran = gSegsTran;

    // Build chunk index by time (e.g., 45s per chunk; ensure buildChunks is defined)
    buildChunks(gSegsOrig);

    // Start rendering // Do NOT auto-start. Only build data; startRender() only if user already enabled.
    if (isRunning) startRender(); 

    // Immediately translate the chunk at current playback head (only calls API when using GPT)
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v) {
      const now = (v.currentTime || 0) * 1000;
      ensureChunkTranslated(now);
    }

    // (Optional) If you want to keep YouTube's full-file translation when not using GPT, do this:
    if (!useCustomAPI && lastTimedTextBaseUrl) {
      try {
        const tUrl = setParam(lastTimedTextBaseUrl, 'tlang', targetLang);
        const fullYT = await fetchTimedText(tUrl);
        if (fullYT?.length) {
          gSegsTran = fullYT;
          window.gSegsTran = gSegsTran;
        }
      } catch (e2) {
        console.warn('[content] YouTube full-file translation failed (safe to ignore; will continue showing original captions)', e2);
      }
    }

  } catch (e) {
    console.warn('[content] fetch/parse captions failed:', e);
  }
});

async function startRender(){
  setNativeCCHidden(true);

  const overlay = ensureOverlay();
  const video = await waitForVideo(8000);

  if (!overlay || !video) {
    if (isRunning) setTimeout(startRender, 500); // retry while enabled
    return;
  }

  overlay.style.zIndex = '2147483647';
  if (rafId) cancelAnimationFrame(rafId);

  const o = overlay.querySelector('.yt-bc-original');
  const t = overlay.querySelector('.yt-bc-translated');

  const renderLoop = () => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v || !document.body.contains(v) || !isRunning) {
      if (rafId) cancelAnimationFrame(rafId);
      return;
    }
    const now = (v.currentTime || 0) * 1000;
    const prefetchWindow = 5000;

    maybeEnsureByVideoTime(now);
    maybeEnsureByVideoTime(now + prefetchWindow);

    o.textContent = activeText(gSegsOrig, now);
    t.textContent = activeText(window.gSegsTran || gSegsTran, now);

    rafId = requestAnimationFrame(renderLoop);
  };
  renderLoop();
}

function stopRender(){
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  const overlay = document.querySelector('.yt-bc-overlay');
  if (overlay) {
    const o = overlay.querySelector('.yt-bc-original');
    const t = overlay.querySelector('.yt-bc-translated');
    if (o) o.textContent = '';
    if (t) t.textContent = '';
  }
  setNativeCCHidden(false);
}
window.stopRender = stopRender; 

// ---------- Video change observer ----------
new MutationObserver(() => {
  if (location.href !== pageUrl) {
    pageUrl = location.href;
    gSegsOrig = [];
    gSegsTran = [];
    gSegsOrig = [];

    chunks = [];
    doneChunks.clear();
    inflightChunks.clear();
    translationEpoch++; 

    if (rafId) cancelAnimationFrame(rafId);
    const overlay = document.querySelector('.yt-bc-overlay');
    if (overlay) overlay.remove();
  }
}).observe(document, {subtree:true, childList:true});
