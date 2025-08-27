function sendMessageWithTimeout(msg, ms = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) reject(new Error('translate-timeout'));
    }, ms);

    chrome.runtime.sendMessage(msg, (resp) => {
      const lastErr = chrome.runtime.lastError;
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (lastErr) return reject(new Error('translate-channel-closed: ' + lastErr.message));
      resolve(resp);
    });
  });
}

async function translateWithAPI(segs, targetLang) {
  const SEGMENT_DURATION_MS = 60000;
  const segments = [];
  let current = [];
  let currentStart = 0;

  for (const s of segs) {
    if (s.startMs >= currentStart + SEGMENT_DURATION_MS) {
      segments.push(current);
      current = [];
      currentStart = s.startMs;
    }
    current.push(s);
  }
  if (current.length) segments.push(current);

  const translatedResults = new Array(segs.length).fill(null);

  async function translateSegment(segment, indexOffset) {
    const texts = segment
      .map(s => s.text)
      .filter(t => t.trim() !== '' && !/^\[.*\]$/.test(t));

    if (texts.length === 0) {
      for (let i = 0; i < segment.length; i++) {
        translatedResults[indexOffset + i] = { ...segment[i] };
      }
      return;
    }

    let resp;
    try {
      console.log('[GPT] Translating segment:', texts);
      resp = await sendMessageWithTimeout(
        { type: 'TRANSLATE', texts, targetLang },
        60000
      );
    } catch (e) {
      console.warn('[GPT] Segment translation failed, using original text', e);
      for (let i = 0; i < segment.length; i++) {
        translatedResults[indexOffset + i] = { ...segment[i] };
      }
      return;
    }

    let ti = 0;
    for (let i = 0; i < segment.length; i++) {
      const text = segment[i].text;
      if (text.trim() === '' || /^\[.*\]$/.test(text)) {
        translatedResults[indexOffset + i] = { ...segment[i] };
      } else {
        translatedResults[indexOffset + i] = {
          ...segment[i],
          text: resp.translations?.[ti] ?? text
        };
        ti++;
      }
    }

    // After each segment, update the global variable and refresh the screen
    window.gSegsTran = translatedResults.filter(x => x !== null);
    if (window.isRunning) startRender(); // or call forceRender()
  }

  const workers = [];
  let offset = 0;
  for (const seg of segments) {
    const myOffset = offset;
    workers.push(translateSegment(seg, myOffset));
    offset += seg.length;
  }

  await Promise.all(workers);
  return translatedResults;
}

// Key: expose translateWithAPI for content.js
window.translateWithAPI = translateWithAPI;