// 在页面世界（MAIN world）挂钩 fetch / XHR。
// ① 凡 /api/ 或 /dapi/ 的 JSON 响应，原样交给扩展；② 所有非静态资源的请求 URL 都记下来（含课件文件），便于排查。
(function () {
  if (window.__ctxhubInjected) return;
  window.__ctxhubInjected = true;

  const ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(\?|#|$)/i;
  const API = /\/(dapi|api)\//i;
  const seen = [];
  let timer = null;

  function flushSeen() {
    timer = null;
    try { window.postMessage({ __ctxhub: true, kind: 'seen', urls: seen.slice(-40) }, '*'); } catch (e) {}
  }
  function note(url) {
    const u = String(url || '');
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || ASSET.test(u)) return;
    const short = u.replace(/^https?:\/\/[^/]+/, '');
    if (seen[seen.length - 1] === short) return;
    const at = seen.indexOf(short);
    if (at >= 0) seen.splice(at, 1);
    seen.push(short);
    if (seen.length > 60) seen.shift();
    if (!timer) timer = setTimeout(flushSeen, 1200);
  }

  function report(url, data) {
    try { window.postMessage({ __ctxhub: true, kind: 'data', url: String(url), data, ts: Date.now() }, '*'); } catch (e) {}
  }

  function isApi(url) { return API.test(String(url || '')); }

  function tryParse(text) {
    const t = String(text || '').trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        note(url);
        if (isApi(url)) {
          p.then((res) => {
            try {
              const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              if (!ct || /json|text\//i.test(ct)) {
                res.clone().text().then((t) => {
                  const d = tryParse(t);
                  if (d !== null) report(url, d);
                }).catch(() => {});
              }
            } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ctxhubUrl = url;
    note(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const u = this.__ctxhubUrl;
    if (u && isApi(u)) {
      this.addEventListener('loadend', () => {
        try {
          if (this.status >= 200 && this.status < 400) {
            const ct = this.getResponseHeader('content-type') || '';
            if (!ct || /json|text\//i.test(ct)) {
              const d = tryParse(this.responseText);
              if (d !== null) report(u, d);
            }
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, args);
  };
})();
