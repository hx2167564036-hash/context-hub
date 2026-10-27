// 隔离世界：只做消息搬运。页面钩子脚本由 manifest 以 MAIN world 注入，不受页面 CSP 影响。
(function () {
  chrome.runtime.sendMessage({ type: 'hello', page: location.href }).catch(() => {});

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ctxhub !== true) return;
    if (d.kind === 'seen') {
      chrome.runtime.sendMessage({ type: 'seen', page: location.href, urls: d.urls }).catch(() => {});
      return;
    }
    chrome.runtime.sendMessage({
      type: 'ingest',
      payload: { source: 'hzcu', url: d.url, data: d.data, ts: d.ts, page: location.href }
    }).catch(() => {});
  });
})();
