// Uploaded plugins serve only index.html and plugin.js. Request assets through SP's bridge.
(function () {
  const status = document.getElementById('status');
  const messageId = 'deadlines-assets-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  let timer;

  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', cleanup);
  }

  function fail(message) {
    cleanup();
    status.textContent = 'Could not start Deadlines. Re-upload the plugin ZIP. ' + message;
  }

  function receive(event) {
    const data = event.data;
    if (event.source !== window.parent || !data || data.messageId !== messageId) return;
    if (data.type === 'PLUGIN_MESSAGE_ERROR') {
      fail(typeof data.error === 'string' ? data.error.slice(0, 300) : 'Plugin assets are unavailable.');
      return;
    }
    if (data.type !== 'PLUGIN_MESSAGE_RESPONSE') return;
    const assets = data.result;
    if (!assets || typeof assets.css !== 'string' || typeof assets.js !== 'string'
        || !assets.js.trim() || assets.js.length > 5 * 1024 * 1024 || assets.css.length > 1024 * 1024) {
      fail('The installed plugin assets are incomplete.');
      return;
    }
    cleanup();
    const style = document.createElement('style');
    style.dataset.deadlinesLibraries = 'true';
    style.textContent = assets.css;
    document.head.insertBefore(style, document.getElementById('deadlines-styles'));
    const script = document.createElement('script');
    script.textContent = assets.js;
    document.body.appendChild(script);
  }

  if (window.parent === window) {
    status.textContent = 'Open this view from inside Super Productivity.';
    return;
  }
  status.textContent = 'Loading Deadlines…';
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', cleanup);
  timer = setTimeout(() => fail('The plugin did not respond.'), 15000);
  window.parent.postMessage({
    type: 'PLUGIN_MESSAGE', messageId, message: { type: 'deadlines-assets-v1' },
  }, '*');
})();
