// 后台：把页面抓到的数据推到本地天枢，失败进队列重试，并留存最近事件日志便于排查。
const ENDPOINT = 'http://127.0.0.1:7311/api/ingest';
const STATS = 'http://127.0.0.1:7311/api/stats';
const VERSION = '0.9.1';
let queue = [];
let log = [];
let seen = [];

function addLog(entry) {
  log.unshift(Object.assign({ t: Date.now() }, entry));
  if (log.length > 30) log = log.slice(0, 30);
  chrome.storage.local.set({ log });
}

async function post(payload) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body.slice(0, 120));
  return body ? JSON.parse(body) : {};
}

async function flush() {
  if (!queue.length) return;
  const batch = queue.slice(0, 20);
  const rest = queue.slice(20);
  const failed = [];
  for (const item of batch) {
    try {
      const r = await post(item);
      addLog({ url: item.url, ok: true, added: r && r.added, captured: r && r.captured });
    } catch (e) {
      failed.push(item);
      addLog({ url: item.url, ok: false, err: String(e.message || e) });
    }
  }
  queue = rest.concat(failed);
  if (queue.length > 500) queue = queue.slice(0, 500);
  chrome.storage.local.set({ queue });
  updateBadge();
}

function collectPage() {
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\n{2,}/g, '\n').trim() : '');
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 300)
    .map((a) => ((a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)) + ' -> ' + a.href)
    .filter((s) => s.length > 4);
  let resources = [];
  try {
    resources = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !/\.(css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(n)).slice(0, 300);
  } catch (e) { /* ignore */ }
  return {
    url: location.href,
    title: document.title,
    hooked: !!window.__ctxhubInjected,
    text: txt(document.body).slice(0, 30000),
    links: links,
    resources: resources
  };
}

async function snapshotTabs(tabs) {
  const results = [];
  for (const t of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: collectPage });
      const snap = (res && res.result) || {};
      const r = await post({
        source: 'hzcu',
        url: snap.url || t.url,
        page: 'dom-snapshot',
        ts: Date.now(),
        data: { kind: 'snapshot', title: snap.title, hooked: snap.hooked, text: snap.text, links: snap.links, resources: snap.resources }
      });
      addLog({ url: '快照 ' + (snap.url || t.url), ok: true, added: r && r.added });
      results.push({ tabId: t.id, url: snap.url, ok: true, resources: (snap.resources || []).length });
    } catch (e) {
      addLog({ url: '快照失败 ' + String(t.url || ''), ok: false, err: String((e && e.message) || e) });
      results.push({ tabId: t.id, url: t.url, ok: false, err: String((e && e.message) || e) });
    }
  }
  return results;
}

// 在页面里（同源）抓一门课的全部结构化数据，再把结果交给后台入库
function pullCourseInPage(courseId) {
  const base = location.origin;
  const posts = [];
  const errors = [];
  const acts = [];
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u.replace(base, ''));
    if (!/json/i.test(ct)) throw new Error('非 JSON ' + u.replace(base, ''));
    return r.json();
  };
  return (async () => {
    const targets = [
      base + '/api/courses/' + courseId + '?fields=id,name,course_code,start_date,end_date,credit,course_type,academic_year,teachers,department,semester',
      base + '/api/courses/' + courseId + '/activities?sub_course_id=0',
      base + '/api/courses/' + courseId + '/modules',
      base + '/api/courses/' + courseId + '/exams'
    ];
    for (const u of targets) {
      try {
        const data = await get(u);
        posts.push({ url: u, data });
        if (/\/activities\?/.test(u) || /\/activities$/.test(u)) {
          const list = (data && data.activities) || [];
          for (const a of list) acts.push({ id: a.id, uploads: a.uploads || [] });
        }
      } catch (e) { errors.push(String((e && e.message) || e).slice(0, 100)); }
    }
    let asked = 0;
    for (const a of acts) {
      for (const u of a.uploads) {
        const refId = u.reference_id || u.upload_reference_id;
        if (!refId || asked >= 150) continue;
        asked++;
        try {
          const u2 = base + '/api/uploads/reference/document/' + refId + '/url?preview=true&refer_id=' + a.id + '&refer_type=learning_activity';
          posts.push({ url: u2, data: await get(u2) });
        } catch (e) { errors.push('file ' + refId + ': ' + String((e && e.message) || e).slice(0, 60)); }
      }
    }
    return { posts, errors, activityCount: acts.length, fileAsked: asked };
  })();
}

function probeCourseListInPage() {
  const base = location.origin;
  const cands = [
    '/api/my-courses?page_size=100',
    '/api/my-courses',
    '/api/courses?offset=0&limit=100',
    '/api/dashboard/courses'
  ];
  const pick = (data) => {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    const keys = ['courses', 'my_courses', 'rows', 'data', 'items', 'list'];
    for (const k of keys) if (Array.isArray(data[k])) return data[k];
    return null;
  };
  return (async () => {
    const errors = [];
    for (const c of cands) {
      try {
        const r = await fetch(base + c, { credentials: 'include', headers: { Accept: 'application/json' } });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok) { errors.push(c + ' → HTTP ' + r.status); continue; }
        if (!/json/i.test(ct)) { errors.push(c + ' → 非 JSON(' + ct.split(';')[0] + ')'); continue; }
        const data = await r.json();
        const list = pick(data);
        if (!list || !list.length) { errors.push(c + ' → 空'); continue; }
        const ids = list.map((x) => x && (x.id || x.course_id)).filter(Boolean);
        if (!ids.length) { errors.push(c + ' → 无 id'); continue; }
        const pages = Number(data.pages || 1);
        if (c.indexOf('/api/my-courses') === 0 && pages > 1) {
          const sep = c.indexOf('?') >= 0 ? '&' : '?';
          for (let pg = 2; pg <= pages; pg += 1) {
            try {
              const u = base + c + sep + 'page=' + pg;
              const rr = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
              if (!rr.ok || !/json/i.test(rr.headers.get('content-type') || '')) continue;
              const dd = await rr.json();
              const ll = pick(dd) || [];
              for (const x of ll) { const id = x && (x.id || x.course_id); if (id && ids.indexOf(id) < 0) ids.push(id); }
            } catch (e) { errors.push('page ' + pg + ' 失败'); }
          }
        }
        return { ok: true, endpoint: base + c, ids, count: ids.length, sample: list.slice(0, 5).map((x) => x.name || x.title || '') };
      } catch (e) { errors.push(c + ' → ' + String((e && e.message) || e).slice(0, 50)); }
    }
    return { ok: false, errors };
  })();
}

async function syncCourses(tabs) {
  const seen = new Set();
  const summary = { courses: [], errors: [] };
  for (const t of tabs) {
    const m = String(t.url || '').match(/\/course\/(\d+)\//);
    if (!m) continue;
    const courseId = m[1];
    if (seen.has(courseId)) continue;
    seen.add(courseId);
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: pullCourseInPage, args: [Number(courseId)] });
      const out = (res && res.result) || { posts: [], errors: ['脚本无返回'] };
      let added = 0;
      for (const p of out.posts) {
        try {
          const r = await post({ source: 'hzcu', url: p.url, page: 'sync', ts: Date.now(), data: p.data });
          added += (r && r.added) || 0;
        } catch (e) { out.errors.push('入库失败 ' + String((e && e.message) || e).slice(0, 60)); }
      }
      summary.courses.push({ courseId, added, posts: out.posts.length, activities: out.activityCount, files: out.fileAsked });
      summary.errors.push(...(out.errors || []));
      addLog({ url: '同步课程 ' + courseId, ok: true, added });
    } catch (e) {
      summary.errors.push('课程 ' + courseId + ': ' + String((e && e.message) || e).slice(0, 80));
      addLog({ url: '同步课程 ' + courseId, ok: false, err: String((e && e.message) || e) });
    }
  }
  return summary;
}

function updateBadge() {
  const n = queue.length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
}

async function selfTest() {
  const payload = {
    source: 'hzcu',
    url: 'https://course.hzcu.edu.cn/dapi/v2/selftest',
    page: 'selftest',
    ts: Date.now(),
    data: { list: [{ id: 'selftest-' + Date.now(), title: '插件自检 ' + new Date().toLocaleString('zh-CN'), createTime: Date.now() }] }
  };
  try {
    const r = await post(payload);
    addLog({ url: 'selftest', ok: true, added: r && r.added });
    return { ok: true, detail: r };
  } catch (e) {
    addLog({ url: 'selftest', ok: false, err: String(e.message || e) });
    return { ok: false, detail: String(e.message || e) };
  }
}


// ---------- 自动同步：正常浏览课程页时顺带把整门课同步一遍 ----------
const AUTO_COURSE_GAP = 6 * 60 * 60 * 1000;
const AUTO_ALL_GAP = 12 * 60 * 60 * 1000;
let autoRunning = false;

async function getMeta() {
  const s = await chrome.storage.local.get(['lastAutoCourse', 'lastAutoAll']);
  return { lastAutoCourse: s.lastAutoCourse || 0, lastAutoAll: s.lastAutoAll || 0 };
}

async function autoSync(tabId, url) {
  if (autoRunning) return;
  const now = Date.now();
  const meta = await getMeta();
  const isCourse = /^https:\/\/courses\.hzcu\.edu\.cn\/course\/(\d+)/.test(url);
  const isCourseList = /^https:\/\/courses\.hzcu\.edu\.cn\/user\/courses/.test(url);
  try {
    if (isCourse && now - meta.lastAutoCourse > AUTO_COURSE_GAP) {
      autoRunning = true;
      await chrome.storage.local.set({ lastAutoCourse: now });
      const r = await syncCourses([{ id: tabId, url }]);
      addLog({ url: '自动同步课程 ' + url.replace(/^https:\/\/[^/]+/, ''), ok: true, added: (r.courses || []).reduce((a, c) => a + (c.added || 0), 0) });
    } else if (isCourseList && now - meta.lastAutoAll > AUTO_ALL_GAP) {
      autoRunning = true;
      await chrome.storage.local.set({ lastAutoAll: now });
      addLog({ url: '自动同步课程列表（首次较慢，约 1 分钟）', ok: true, pending: true });
      const tabs = await chrome.tabs.query({ url: ['https://courses.hzcu.edu.cn/*'] });
      const probe = await chrome.scripting.executeScript({ target: { tabId }, func: probeCourseListInPage });
      const p = (probe && probe[0] && probe[0].result) || { ok: false, errors: ['无返回'] };
      if (p.ok) {
        let added = 0;
        for (const id of p.ids.slice(0, 80)) {
          try {
            const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pullCourseInPage, args: [Number(id)] });
            const out = (res && res.result) || { posts: [] };
            for (const item of out.posts) {
              try { const r = await post({ source: 'hzcu', url: item.url, page: 'auto', ts: Date.now(), data: item.data }); added += (r && r.added) || 0; } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        addLog({ url: '自动同步 ' + p.ids.length + ' 门课（新增 ' + added + '）', ok: true, added });
      } else {
        addLog({ url: '自动同步课程列表失败', ok: false, err: (p.errors || []).join(' | ').slice(0, 120) });
      }
      if (tabs.length) { /* 保持标签页引用，避免未使用告警 */ }
    }
  } catch (e) {
    addLog({ url: '自动同步出错', ok: false, err: String((e && e.message) || e).slice(0, 120) });
  } finally {
    autoRunning = false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https:\/\/courses\.hzcu\.edu\.cn\//.test(tab.url)) return;
  autoSync(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'hello') {
    addLog({ url: '注入 ' + String(msg.page || ''), ok: true, hello: true });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'seen') {
    seen = Array.isArray(msg.urls) ? msg.urls.slice(-40) : [];
    chrome.storage.local.set({ seen });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ingest') {
    addLog({ url: msg.payload && msg.payload.url, ok: true, queued: true });
    queue.push(msg.payload);
    if (queue.length > 500) queue = queue.slice(0, 500);
    chrome.storage.local.set({ queue, lastAt: Date.now() });
    flush();
    sendResponse({ queued: queue.length });
    return true;
  }
  if (msg.type === 'injectTabs') {
    (async () => {
      const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      const results = [];
      for (const t of tabs) {
        const r = { tabId: t.id, url: t.url, main: '', iso: '' };
        try {
          await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', files: ['inject.js'] });
          r.main = 'ok';
        } catch (e) { r.main = String((e && e.message) || e); }
        try {
          await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
          r.iso = 'ok';
        } catch (e) { r.iso = String((e && e.message) || e); }
        results.push(r);
        addLog({ url: '强制注入 ' + String(t.url || ''), ok: r.main === 'ok' && r.iso === 'ok', err: r.main === 'ok' ? undefined : r.main });
      }
      sendResponse({ results });
    })();
    return true;
  }
  if (msg.type === 'syncCourses') {
    (async () => {
      const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      sendResponse(await syncCourses(tabs));
    })();
    return true;
  }
  if (msg.type === 'syncAll') {
    (async () => {
      const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      if (!tabs.length) { sendResponse({ error: '没有可用标签页' }); return; }
      const host = tabs.find((t) => /^https:\/\/courses\.hzcu\.edu\.cn\//.test(String(t.url || '')));
      if (!host) {
        addLog({ url: '同步所有课程失败', ok: false, err: '请先打开一门课程页面（courses.hzcu.edu.cn）' });
        sendResponse({ probe: { ok: false, errors: ['当前没有 courses.hzcu.edu.cn 的标签页，请先打开一门课程再点同步'] } });
        return;
      }
      let probe;
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: host.id }, func: probeCourseListInPage });
        probe = (res && res.result) || { ok: false, errors: ['无返回'] };
      } catch (e) { probe = { ok: false, errors: [String((e && e.message) || e)] }; }
      if (!probe.ok) { addLog({ url: '探测课程列表失败', ok: false, err: (probe.errors || []).join(' | ').slice(0, 160) }); sendResponse({ probe }); return; }
      const summary = { probe, courses: [], errors: [] };
      for (const id of probe.ids.slice(0, 120)) {
        try {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: host.id }, func: pullCourseInPage, args: [Number(id)] });
          const out = (res && res.result) || { posts: [], errors: ['脚本无返回'] };
          let added = 0;
          for (const p of out.posts) {
            try { const r = await post({ source: 'hzcu', url: p.url, page: 'sync', ts: Date.now(), data: p.data }); added += (r && r.added) || 0; }
            catch (e) { out.errors.push('入库失败 ' + String((e && e.message) || e).slice(0, 50)); }
          }
          summary.courses.push({ courseId: id, added, posts: out.posts.length });
          summary.errors.push(...(out.errors || []));
          addLog({ url: '同步课程 ' + id, ok: true, added });
        } catch (e) { summary.errors.push('课程 ' + id + ': ' + String((e && e.message) || e).slice(0, 60)); }
      }
      sendResponse(summary);
    })();
    return true;
  }
  if (msg.type === 'snapshot') {
    (async () => {
      const tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      sendResponse({ results: await snapshotTabs(tabs) });
    })();
    return true;
  }
  if (msg.type === 'status') {
    sendResponse({ version: VERSION, queue: queue.length, log, seen });
    return true;
  }
  if (msg.type === 'selftest') {
    selfTest().then(sendResponse);
    return true;
  }
  if (msg.type === 'probe') {
    fetch(STATS, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, total: j.total }))
      .catch((e) => sendResponse({ ok: false, err: String(e.message || e) }));
    return true;
  }
  return false;
});

chrome.storage.local.get(['queue', 'log', 'seen']).then((v) => {
  queue = Array.isArray(v.queue) ? v.queue : [];
  log = Array.isArray(v.log) ? v.log : [];
  seen = Array.isArray(v.seen) ? v.seen : [];
  updateBadge();
  flush();
});

setInterval(flush, 60000);