(() => {
  if (window.__yt_bc_injected__) return;
  window.__yt_bc_injected__ = true;
  console.log('[inject] injected. flag =', window.__yt_bc_injected__);

  const post = (url) => window.postMessage({ type: 'YT_TIMEDTEXT_URL', url }, '*');

  // fetch capture
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input] = args;
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('timedtext')) {
      console.log('[inject] timedtext:', url);
      post(url);
    }
    return origFetch.apply(this, args);
  };

  // XHR capture (some parts use XHR)
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('timedtext')) {
      console.log('[inject] XHR timedtext:', url);
      post(url);
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
