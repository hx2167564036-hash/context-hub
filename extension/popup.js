function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function shortUrl(u) {
  return String(u || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 60);
}

async function refresh() {
  let st = {};
  try { st = (await chrome.runtime.sendMessage({ type: 'status' })) || {}; } catch (e) { st = {}; }
  document.getElementById('v').textContent = st.version || '—';
  document.getElementById('q').textContent = st.queue || 0;

  const v = await chrome.storage.local.get(['lastAt', 'log', 'seen']);
  document.getElementById('t').textContent = fmtTime(v.lastAt);

  const log = v.log || [];
  const injects = log.filter((x) => x.hello);
  document.getElementById('i').textContent = injects.length
    ? '成功 · ' + String(injects[0].url || '').replace('注入 ', '').replace(/^https?:\/\/[^/]+/, '').slice(0, 22)
    : '未注入';
  document.getElementById('i').className = injects.length ? 'ok' : 'bad';

  document.getElementById('r').textContent = log.length
    ? (log[0].ok ? '成功' : '失败') + ' · ' + shortUrl(log[0].url).slice(0, 28)
    : '还没抓到';
  document.getElementById('log').textContent = log.length
    ? log.slice(0, 6).map((x) => (x.ok ? '✓' : '✗') + ' ' + fmtTime(x.t) + ' ' + shortUrl(x.url).slice(0, 40) + (x.ok ? '' : ' | ' + x.err)).join('\n')
    : '暂无记录。';

  const seen = (st.seen && st.seen.length ? st.seen : v.seen) || [];
  document.getElementById('seen').textContent = seen.length
    ? seen.slice(-8).map((u) => shortUrl(u)).join('\n')
    : '还没有捕获到页面请求。';

  try {
    const r = await chrome.runtime.sendMessage({ type: 'probe' });
    if (!r || !r.ok) throw new Error((r && r.err) || 'no response');
    const el = document.getElementById('s');
    el.textContent = '在线 · ' + r.total + ' 条';
    el.className = 'ok';
  } catch (e) {
    const el = document.getElementById('s');
    el.textContent = '未启动';
    el.className = 'bad';
  }
}

document.getElementById('inject').addEventListener('click', async () => {
  const el = document.getElementById('inject');
  el.textContent = '查找标签页…';
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://*.hzcu.edu.cn/*']
    });
    if (!tabs.length) throw new Error('没找到学在城院/爱城院的标签页，先打开一个');
    el.textContent = '注入 ' + tabs.length + ' 个标签页…';
    const r = await chrome.runtime.sendMessage({ type: 'injectTabs', tabs: tabs.map((t) => ({ id: t.id, url: t.url })) });
    const ok = (r.results || []).filter((x) => x.main === 'ok' && x.iso === 'ok').length;
    const bad = (r.results || []).filter((x) => !(x.main === 'ok' && x.iso === 'ok'));
    el.textContent = ok === tabs.length ? '已注入 ' + ok + ' 个标签页，去页面点几下' : '成功 ' + ok + '/' + tabs.length + '：' + (bad[0] && (bad[0].main || bad[0].iso));
  } catch (e) {
    el.textContent = '失败：' + String((e && e.message) || e).slice(0, 70);
  }
  setTimeout(() => { el.textContent = '强制注入学在城院/爱城院标签页'; refresh(); }, 3000);
});

const CAMPUS = ['https://*.hzcu.edu.cn/*'];

async function campusTabs() {
  return chrome.tabs.query({ url: CAMPUS });
}

document.getElementById('syncNow').addEventListener('click', async () => {
  const el = document.getElementById('syncNow');
  el.textContent = '同步中…（别关标签页）';
  try {
    const tabs = (await campusTabs()).filter((t) => /\/course\/\d+\//.test(String(t.url || '')));
    if (!tabs.length) throw new Error('先打开一个课程页面（courses.hzcu.edu.cn/course/…）');
    const r = await chrome.runtime.sendMessage({ type: 'syncCourses', tabs: tabs.map((t) => ({ id: t.id, url: t.url })) });
    const parts = (r.courses || []).map((c) => '课程' + c.courseId + '：入库' + c.added + ' 条');
    el.textContent = (parts.join('，') || '没同步到东西') + (r.errors && r.errors.length ? '（' + r.errors.length + ' 个错误）' : '');
  } catch (e) {
    el.textContent = '失败：' + String((e && e.message) || e).slice(0, 70);
  }
  setTimeout(() => { el.textContent = '同步当前课程（全量）'; refresh(); }, 5000);
});

document.getElementById('syncAll').addEventListener('click', async () => {
  const el = document.getElementById('syncAll');
  el.textContent = '同步全部中…（较慢，别关页面）';
  try {
    const tabs = await campusTabs();
    if (!tabs.length) throw new Error('先打开任意学在城院页面');
    const r = await chrome.runtime.sendMessage({ type: 'syncAll', tabs: tabs.map((t) => ({ id: t.id, url: t.url })) });
    if (r.error) throw new Error(r.error);
    if (r.probe && !r.probe.ok) { el.textContent = '课程列表探测失败：' + (r.probe.errors || []).slice(0, 2).join(' | ').slice(0, 80); }
    else {
      const total = (r.courses || []).reduce((a, c) => a + (c.added || 0), 0);
      el.textContent = '同步 ' + (r.courses || []).length + ' 门课，入库 ' + total + ' 条' + (r.errors && r.errors.length ? '（' + r.errors.length + ' 错）' : '');
    }
  } catch (e) {
    el.textContent = '失败：' + String((e && e.message) || e).slice(0, 70);
  }
  setTimeout(() => { el.textContent = '同步所有课程'; refresh(); }, 6000);
});

document.getElementById('snap').addEventListener('click', async () => {
  const el = document.getElementById('snap');
  el.textContent = '抓取中…';
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://*.hzcu.edu.cn/*']
    });
    if (!tabs.length) throw new Error('没找到学在城院/爱城院的标签页');
    const r = await chrome.runtime.sendMessage({ type: 'snapshot', tabs: tabs.map((t) => ({ id: t.id, url: t.url })) });
    const ok = (r.results || []).filter((x) => x.ok).length;
    const resCount = (r.results || []).reduce((a, x) => a + (x.resources || 0), 0);
    el.textContent = '已快照 ' + ok + '/' + tabs.length + ' 页，含 ' + resCount + ' 条资源请求';
  } catch (e) {
    el.textContent = '失败：' + String((e && e.message) || e).slice(0, 70);
  }
  setTimeout(() => { el.textContent = '抓当前页快照（诊断真实接口）'; refresh(); }, 3000);
});

document.getElementById('test').addEventListener('click', async () => {
  const el = document.getElementById('test');
  el.textContent = '发送中…';
  const r = await chrome.runtime.sendMessage({ type: 'selftest' });
  el.textContent = r && r.ok ? '成功，去中枢搜「插件自检」' : '失败：' + ((r && r.detail) || '未知');
  setTimeout(() => { el.textContent = '发一条测试数据（验证通路）'; refresh(); }, 2500);
});

refresh();
setInterval(refresh, 2000);