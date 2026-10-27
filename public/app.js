const $ = (s) => document.querySelector(s);
let sources = [];
let kinds = [];
let state = { q: '', source: '', kind: '', tab: 'search', activeId: null, hideOld: true, brief: null };

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const TIER = {
  due: '\u5728\u505a', active: '\u672c\u5b66\u671f', fresh: '\u8fd1\u4e24\u5468', expired: '\u5df2\u8fc7\u671f',
  archive: '\u5f80\u671f', old: '\u534a\u5e74\u4ee5\u4e0a', stub: '\u63a5\u53e3\u6e23'
};

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function leftText(h) {
  if (h < 0) return '\u5df2\u8fc7\u671f ' + Math.abs(Math.round(h)) + ' \u5c0f\u65f6';
  if (h < 24) return '\u8fd8\u5269 ' + Math.round(h) + ' \u5c0f\u65f6';
  return '\u8fd8\u5269 ' + Math.round(h / 24) + ' \u5929';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const terms = [...new Set(q.split(/\s+/).filter((t) => t.length >= 1))];
  let out = safe;
  for (const t of terms) {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => '\u0001' + m + '\u0002');
  }
  return out.replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#stats').innerHTML =
    '<span class="chip"><span class="k">\u8d44\u6599</span><b>' + s.total + '</b></span>' +
    '<span class="chip"><span class="k">\u4f53\u79ef</span><b>' + fmtBytes(s.bytes) + '</b></span>' +
    '<span class="chip"><span class="k">\u6700\u65b0</span><b>' + fmtTime(s.latest) + '</b></span>';
  return s;
}

async function loadFilters() {
  const s = await loadStats();
  sources = s.bySource;
  kinds = s.byKind;
  for (const r of sources) {
    const o = document.createElement('option');
    o.value = r.source;
    o.textContent = r.source + ' \u00b7 ' + r.n;
    $('#source').appendChild(o);
  }
  for (const r of kinds) {
    const o = document.createElement('option');
    o.value = r.kind;
    o.textContent = '.' + r.kind + ' \u00b7 ' + r.n;
    $('#kind').appendChild(o);
  }
}

async function doSearch() {
  const params = new URLSearchParams({ q: state.q, source: state.source, kind: state.kind, limit: 60 });
  const res = await api('/api/search?' + params);
  const list = $('#list');
  $('#resultmeta').innerHTML = state.q
    ? '\u547d\u4e2d <b style="color:#cfe0ff">' + res.total + '</b> \u6761' + (res.loose ? ' \u00b7 \u65e0\u7cbe\u786e\u5339\u914d\uff0c\u4ee5\u4e0b\u662f\u76f8\u5173\u7684' : '') + (res.total > 60 ? ' \u00b7 \u663e\u793a\u524d 60' : '')
    : '<b style="color:#cfe0ff">' + res.total + '</b> \u6761\u4ecd\u5728\u7528\u7684\u8d44\u6599' +
      (res.allTotal > res.total ? ' \u00b7 \u53e6\u6709 ' + (res.allTotal - res.total) + ' \u6761\u5f80\u671f/\u8fc7\u671f\u5df2\u6298\u53e0' : '');
  list.innerHTML = '';
  if (!res.hits.length) {
    list.innerHTML = '<div class="item" style="animation:none"><div class="s">\u6ca1\u6709\u5339\u914d\u7ed3\u679c\u3002\u6362\u4e2a\u5173\u952e\u8bcd\u8bd5\u8bd5\uff1f</div></div>';
    return;
  }
  let i = 0;
  for (const h of res.hits) {
    const el = document.createElement('div');
    el.className = 'item' + (h.id === state.activeId ? ' active' : '');
    el.style.setProperty('--i', String(Math.min(i, 14)));
    i++;
    el.innerHTML =
      '<div class="t">' + highlight(h.title, state.q) + '</div>' +
      '<div class="s">' + highlight(h.snippet || '', state.q) + '</div>' +
      '<div class="m"><span class="badge ' + h.source + '">' + h.source + '</span>' +
      '<span>' + escapeHtml(h.kind) + '</span><span>' + fmtTime(h.docTime) + '</span>' +
      (h.meta && h.meta.label ? '<span>' + escapeHtml(h.meta.label) + '</span>' : '') +
      (TIER[h.meta && h.meta.tier] ? '<span class="tier tier-' + h.meta.tier + '">' + TIER[h.meta.tier] + '</span>' : '') + '</div>';
    el.onclick = () => openDoc(h.id, el);
    list.appendChild(el);
  }
}

async function openDoc(id, el) {
  state.activeId = id;
  document.querySelectorAll('.item.active').forEach((n) => n.classList.remove('active'));
  if (el) el.classList.add('active');
  const d = await api('/api/doc?id=' + id);
  const full = d.body || '';
  const body = full.length > 6000 ? full.slice(0, 6000) + '\n\n\u2026\uff08\u8fd8\u6709 ' + (full.length - 6000) + ' \u5b57\uff0c\u70b9\u201c\u9884\u89c8\u539f\u6587\u201d\u770b\u5168\u8c8c\uff09' : full;
  const meta = d.meta || {};
  const detail = $('#detail');
  detail.className = 'col-view';
  detail.innerHTML =
    '<article class="doc">' +
    '<h1>' + escapeHtml(d.title || '(\u65e0\u6807\u9898)') + '</h1>' +
    '<div class="mchips"><span class="badge ' + d.source + '">' + escapeHtml(d.source) + '</span>' +
    '<span class="badge">' + escapeHtml(d.kind) + '</span>' +
    (meta.label ? '<span class="badge">' + escapeHtml(meta.label) + '</span>' : '') +
    (meta.tier && TIER[meta.tier] ? '<span class="tier tier-' + meta.tier + '">' + TIER[meta.tier] + '</span>' : '') +
    '<span>' + fmtTime(d.doc_time) + '</span><span>' + fmtBytes(d.size) + '</span></div>' +
    '<div class="actions"><button class="btn primary" id="btn-open">\u5728\u6587\u4ef6\u5939\u4e2d\u663e\u793a</button>' +
    '<a class="btn" href="/api/file?uri=' + encodeURIComponent(d.uri) + '" target="_blank">\u9884\u89c8\u539f\u6587</a>' +
    '<button class="btn" id="btn-copy">\u590d\u5236\u94fe\u63a5</button></div>' +
    '<div class="uri">' + escapeHtml(d.uri) + '</div>' +
    '<div class="body" style="margin-top:14px">' + escapeHtml(body) + '</div>' +
    '</article>';
  $('#btn-open').onclick = () => fetch('/api/open?uri=' + encodeURIComponent(d.uri)).then(() => {
    const b = $('#btn-open');
    b.textContent = '\u5df2\u6253\u5f00';
    setTimeout(() => (b.textContent = '\u5728\u6587\u4ef6\u5939\u4e2d\u663e\u793a'), 1200);
  });
  $('#btn-copy').onclick = () => {
    navigator.clipboard.writeText(location.origin + '/?doc=' + d.id).then(() => {
      const b = $('#btn-copy');
      b.textContent = '\u5df2\u590d\u5236';
      setTimeout(() => (b.textContent = '\u590d\u5236\u94fe\u63a5'), 1200);
    });
  };
  detail.scrollTop = 0;
}

function greeting(h) {
  return h < 5 ? '\u591c\u91cc\u597d' : h < 11 ? '\u65e9\u4e0a\u597d' : h < 14 ? '\u4e2d\u5348\u597d' : h < 18 ? '\u4e0b\u5348\u597d' : '\u665a\u4e0a\u597d';
}

function renderHome(b) {
  const detail = $('#detail');
  const now = new Date();
  const h = now.getHours();
  const due = b.due || [];
  const week = b.week || [];
  const fresh = b.fresh || [];
  const rows = (arr) => arr.map((it) => {
    const hot = it.hoursLeft != null && it.hoursLeft < 48;
    return '<div class="aitem' + (hot ? ' hot' : '') + '" data-id="' + it.id + '">' +
      '<span class="d"></span><div style="flex:1;min-width:0">' +
      '<div class="bt">' + escapeHtml(it.title) + '</div>' +
      '<div class="bs">' + escapeHtml(it.course || it.source || '') +
      (it.endTime ? ' <em>' + leftText(it.hoursLeft) + '</em>' : '') +
      (it.at ? ' \u00b7 ' + fmtWhen(it.at) : '') + '</div></div></div>';
  }).join('');

  detail.className = 'col-view empty';
  detail.innerHTML =
    '<div class="hero">' +
    '<div class="herotop"><div class="orb"><span>AI</span></div>' +
    '<div class="hello"><h2>' + greeting(h) + '\uff0c\u6211\u662f\u4f60\u7684\u4e0a\u4e0b\u6587\u79d8\u4e66</h2>' +
    '<p>\u5df2\u540c\u6b65 <b>' + (b.stats ? b.stats.totalLive : 0) + '</b> \u6761\u8d44\u6599 \u00b7 \u672c\u5b66\u671f <b>' + (b.stats ? b.stats.currentCourses : 0) + '</b> \u95e8\u8bfe \u00b7 \u6570\u636e\u4e0d\u51fa\u672c\u673a</p></div></div>' +
    '<div class="tiles">' +
    '<div class="tile"><div class="k">\u5728\u505a</div><b>' + due.length + '<i>\u9879</i></b></div>' +
    '<div class="tile"><div class="k">\u672c\u5468\u8bfe\u7a0b</div><b>' + week.length + '<i>\u6761</i></b></div>' +
    '<div class="tile"><div class="k">\u8fd1\u4e24\u5929\u8fdb\u5e93</div><b>' + fresh.length + '<i>\u6761</i></b></div>' +
    '</div>' +
    '<div class="sec"><div class="sechead"><span class="bar"></span><h3>\u73b0\u5728\u8be5\u505a</h3><span class="n">' + (due.length || '\u6682\u65e0') + '</span></div>' +
    (due.length ? rows(due) : '<div class="placeholder" style="height:60px;justify-content:flex-start">\u6ca1\u6709\u5feb\u5230\u671f\u7684\u4f5c\u4e1a\u3002\u53ef\u4ee5\u5b89\u5fc3\u5b66\u70b9\u522b\u7684\u3002</div>') +
    '</div>' +
    '<div class="sec"><div class="sechead"><span class="bar"></span><h3>\u672c\u5468\u8bfe\u7a0b\u6d3b\u52a8</h3><span class="n">' + week.length + '</span></div>' +
    (week.length ? rows(week.slice(0, 6)) : '<div class="placeholder" style="height:60px;justify-content:flex-start">\u672c\u5468\u6ca1\u6709\u843d\u5728\u65e5\u7a0b\u4e0a\u7684\u8bfe\u7a0b\u6d3b\u52a8\u3002</div>') +
    '</div>' +
    '<div class="sec"><div class="sechead"><span class="bar"></span><h3>\u95ee\u95ee\u8fd9\u4e2a\u5e93</h3><span class="n">\u68c0\u7d22 + \u6a21\u578b</span></div>' +
    '<div class="askbox"><input id="askq" placeholder="\u6bd4\u5982\uff1a\u8fd9\u5468\u7684\u8f6f\u4ef6\u5de5\u7a0b\u4f5c\u4e1a\u8981\u4ea4\u4ec0\u4e48\uff1f\u53ef\u884c\u6027\u7814\u7a76\u5199\u4e86\u54ea\u4e9b\uff1f">' +
    '<button id="askbtn">\u95ee</button></div>' +
    '<div class="quickask">' +
    '<button class="qchip" data-q="\u53ef\u884c\u6027\u7814\u7a76">\u53ef\u884c\u6027\u7814\u7a76</button>' +
    '<button class="qchip" data-q="\u96c5\u601d \u53e3\u8bed">\u96c5\u601d\u53e3\u8bed</button>' +
    '<button class="qchip" data-q="\u7ebf\u6027\u56de\u5f52">\u7ebf\u6027\u56de\u5f52</button>' +
    '<button class="qchip" data-q="\u9ad8\u4e2d\u5316\u5b66 \u6559\u6848">\u5316\u5b66\u6559\u6848</button>' +
    '</div>' +
    '<div id="askout" style="margin-top:12px"></div>' +
    '</div>' +
    '</div>';

  detail.querySelectorAll('.aitem').forEach((n) => (n.onclick = () => openDoc(Number(n.dataset.id), null)));
  $('#askbtn').onclick = ask;
  $('#askq').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  detail.querySelectorAll('.qchip').forEach((n) => (n.onclick = () => { $('#askq').value = n.dataset.q; ask(); }));
}

let asking = false;
async function ask() {
  if (asking) return;
  const q = ($('#askq').value || '').trim();
  if (!q) return;
  const out = $('#askout');
  asking = true;
  $('#askbtn').disabled = true;
  out.innerHTML = '<div class="placeholder" style="height:40px;justify-content:flex-start">\u6b63\u5728\u68c0\u7d22\u672c\u673a\u8d44\u6599\u2026</div>';
  try {
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q, limit: 8 }) });
    const d = await r.json();
    let html = '';
    if (d.mode === 'llm') {
      html += '<div class="body" style="font-size:13px;line-height:1.85;margin-bottom:10px">' + escapeHtml(d.answer) + '</div>';
    } else if (d.mode === 'error') {
      html += '<div class="dlgstatus" style="color:#fca5a5">\u6a21\u578b\u8c03\u7528\u5931\u8d25\uff1a' + escapeHtml(d.error) + '\u3002\u4e0b\u9762\u662f\u68c0\u7d22\u5230\u7684\u8d44\u6599\u3002</div>';
    } else {
      html += '<div class="dlgstatus" style="color:#93a3ba">\u672a\u914d\u7f6e\u6a21\u578b\u5bc6\u94a5\uff08\u8bbe\u7f6e \u2192 AI \u56de\u7b54\uff09\uff0c\u5148\u7ed9\u4f60\u68c0\u7d22\u7ed3\u679c\uff1a</div>';
    }
    if (d.sources && d.sources.length) {
      html += '<div class="sec" style="margin-top:4px">';
      for (const s of d.sources) {
        html += '<div class="aitem" data-id="' + s.id + '"><span class="d"></span><div style="flex:1;min-width:0">' +
          '<div class="bt">' + escapeHtml(s.title) + '</div>' +
          '<div class="bs">' + escapeHtml(s.source) + ' \u00b7 ' + escapeHtml(s.kind || '') + ' \u00b7 ' + fmtTime(s.docTime) + '</div></div></div>';
      }
      html += '</div>';
    } else {
      html += '<div class="placeholder" style="height:40px;justify-content:flex-start">\u6ca1\u68c0\u7d22\u5230\u76f8\u5173\u8d44\u6599\u3002</div>';
    }
    out.innerHTML = html;
    out.querySelectorAll('.aitem').forEach((n) => (n.onclick = () => openDoc(Number(n.dataset.id), null)));
  } catch (e) {
    out.innerHTML = '<div class="dlgstatus" style="color:#fca5a5">\u67e5\u8be2\u5931\u8d25\uff1a' + escapeHtml(e.message) + '</div>';
  } finally {
    asking = false;
    $('#askbtn').disabled = false;
  }
}

async function loadBrief() {
  try {
    const b = await api('/api/brief');
    state.brief = b;
    if (state.tab === 'search' && !state.activeId) renderHome(b);
  } catch (e) { /* ignore */ }
}

async function loadTimeline() {
  const hide = state.hideOld ? 'archive,expired,stub' : '';
  const res = await api('/api/timeline?days=30&hide=' + encodeURIComponent(hide) +
    (state.source ? '&source=' + encodeURIComponent(state.source) : ''));
  const tl = $('#timeline');
  tl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'tlwrap';
  const bar = document.createElement('div');
  bar.className = 'tlbar';
  bar.innerHTML = '<span class="l">\u6700\u8fd1 30 \u5929 \u00b7 ' + res.total + ' \u6761</span>' +
    '<label><input type="checkbox" id="hideold"' + (state.hideOld ? ' checked' : '') + '> \u9690\u85cf\u5f80\u671f\u8bfe\u7a0b / \u8fc7\u671f\u4f5c\u4e1a / \u63a5\u53e3\u6e23</label>';
  wrap.appendChild(bar);
  tl.appendChild(wrap);
  $('#hideold').onchange = (e) => { state.hideOld = e.target.checked; loadTimeline(); };
  if (!res.groups.length) {
    const empty = document.createElement('div');
    empty.className = 'placeholder';
    empty.style.height = '180px';
    empty.textContent = state.hideOld ? '\u6700\u8fd1 30 \u5929\u6ca1\u6709\u65b0\u8d44\u6599\uff08\u5df2\u9690\u85cf\u975e\u5728\u529e\u5185\u5bb9\uff0c\u53ef\u53d6\u6d88\u52fe\u9009\u67e5\u770b\u5168\u90e8\uff09' : '\u6700\u8fd1 30 \u5929\u6ca1\u6709\u65b0\u8d44\u6599';
    wrap.appendChild(empty);
    return;
  }
  for (const g of res.groups) {
    const day = document.createElement('div');
    day.className = 'day';
    day.innerHTML = '<h3>' + g.date + ' \u00b7 ' + g.items.length + ' \u6761</h3>';
    for (const it of g.items) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<div class="t">' + escapeHtml(it.title || '(\u65e0\u6807\u9898)') + '</div>' +
        '<div class="m"><span class="badge ' + it.source + '">' + it.source + '</span>' + escapeHtml(it.kind) +
        (it.meta && it.meta.label ? ' \u00b7 ' + escapeHtml(it.meta.label) : '') + '</div>';
      row.onclick = () => { switchTab('search'); openDoc(it.id, null); };
      day.appendChild(row);
    }
    wrap.appendChild(day);
  }
}

async function loadDue() {
  const res = await api('/api/due?days=45&past=1');
  const box = $('#due');
  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'duewrap';
  wrap.innerHTML = '<div class="duehead">\u8fd1 45 \u5929\u5185\u5e26\u622a\u6b62\u65f6\u95f4\u7684\u4f5c\u4e1a\u4e0e\u8003\u8bd5 \u00b7 ' + res.count + ' \u9879</div>';
  box.appendChild(wrap);
  if (!res.items.length) {
    wrap.innerHTML += '<div class="placeholder" style="height:160px">\u8fd1 45 \u5929\u6ca1\u6709\u5e26\u622a\u6b62\u65f6\u95f4\u7684\u4f5c\u4e1a/\u8003\u8bd5</div>';
    return;
  }
  for (const it of res.items) {
    const el = document.createElement('div');
    el.className = 'duerow' + (it.overdue ? ' overdue' : '');
    const cls = it.overdue ? 'late' : it.hoursLeft < 48 ? 'soon' : '';
    const big = it.overdue ? Math.abs(Math.round(it.hoursLeft / 24)) : it.hoursLeft < 24 ? Math.round(it.hoursLeft) : Math.round(it.hoursLeft / 24);
    const unit = it.overdue ? '\u5929\u524d\u622a\u6b62' : it.hoursLeft < 24 ? '\u5c0f\u65f6\u540e\u622a\u6b62' : '\u5929\u540e\u622a\u6b62';
    el.innerHTML =
      '<div class="info"><div class="t">' + escapeHtml(it.title) + '</div>' +
      '<div class="m"><span class="badge due">' + escapeHtml(it.kind || '\u4efb\u52a1') + '</span>' + escapeHtml(it.course || '') +
      ' \u00b7 \u622a\u6b62 ' + escapeHtml(new Date(it.endTime).toLocaleString('zh-CN', { hour12: false })) + '</div>' +
      (it.files.length ? '<div class="s">\u9644\u4ef6\uff1a' + escapeHtml(it.files.join('\u3001')) + '</div>' : '') + '</div>' +
      '<div class="count"><b class="' + cls + '">' + big + '</b><s>' + unit + '</s></div>';
    el.onclick = () => openDoc(it.id, null);
    wrap.appendChild(el);
  }
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.navbtn[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const isTl = tab === 'timeline';
  const isDue = tab === 'due';
  $('#timeline').classList.toggle('hidden', !isTl);
  $('#due').classList.toggle('hidden', !isDue);
  $('#ws').classList.toggle('hidden', isTl || isDue);
  if (isTl) loadTimeline();
  if (isDue) loadDue();
  if (tab === 'search' && !state.activeId) loadBrief();
}

async function openSettings() {
  $('#setMask').classList.remove('hidden');
  $('#setStatus').textContent = '';
  $('#setToken').value = '';
  $('#setModelKey').value = '';
  try {
    const c = await api('/api/config');
    $('#setToken').placeholder = c.hasToken ? '\u5df2\u4fdd\u5b58\uff08\u5c3e\u53f7 ' + c.tokenTail + '\uff09\uff0c\u7559\u7a7a\u8868\u793a\u4e0d\u6539' : '32 \u4f4d token';
    $('#setModelKey').placeholder = c.hasModel ? '\u5df2\u4fdd\u5b58\uff08\u5c3e\u53f7 ' + c.modelTail + '\uff09\uff0c\u7559\u7a7a\u8868\u793a\u4e0d\u6539' : 'sk-\u2026\uff08\u53ef\u9009\uff0c\u4e0d\u586b\u5c31\u53ea\u505a\u68c0\u7d22\uff09';
    $('#setTime').value = c.time || '08:30';
    $('#setEnabled').checked = !!c.enabled;
  } catch (e) { $('#setStatus').textContent = '\u8bfb\u53d6\u8bbe\u7f6e\u5931\u8d25\uff1a' + e.message; }
}

async function postJson(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { body: t }; }
}

$('#btnHolo').onclick = () => { if (window.ctxhub && window.ctxhub.openHolo) window.ctxhub.openHolo(); else location.href = '/holo'; };
$('#btnSet').onclick = openSettings;
$('#btnSet2').onclick = openSettings;
$('#btnSetClose').onclick = () => $('#setMask').classList.add('hidden');
$('#setMask').onclick = (e) => { if (e.target.id === 'setMask') $('#setMask').classList.add('hidden'); };
$('#btnSetSave').onclick = async () => {
  $('#setStatus').textContent = '\u4fdd\u5b58\u4e2d\u2026';
  const body = { time: $('#setTime').value || '08:30', enabled: $('#setEnabled').checked };
  const tok = $('#setToken').value.trim();
  if (tok) body.token = tok;
  const mk = $('#setModelKey').value.trim();
  if (mk) body.modelKey = mk;
  try {
    const c = await postJson('/api/config', body);
    const parts = [];
    parts.push(c.hasToken ? '\u5fae\u4fe1 token \u5df2\u4fdd\u5b58\uff08\u5c3e\u53f7 ' + c.tokenTail + '\uff09' : '\u8fd8\u6ca1\u6709 token\uff0c\u63a8\u9001\u4e0d\u4f1a\u751f\u6548');
    parts.push(c.hasModel ? 'AI \u5bc6\u94a5\u5df2\u4fdd\u5b58\uff08\u5c3e\u53f7 ' + c.modelTail + '\uff09' : '\u672a\u914d\u7f6e AI \u5bc6\u94a5\uff0c\u53ea\u505a\u68c0\u7d22');
    $('#setStatus').textContent = parts.join('\uff1b') + '\u3002\u6bcf\u5929 ' + c.time + (c.enabled ? ' \u63a8\u9001' : '\uff0c\u63a8\u9001\u672a\u542f\u7528');
  } catch (e) { $('#setStatus').textContent = '\u4fdd\u5b58\u5931\u8d25\uff1a' + e.message; }
};
$('#btnTestPush').onclick = async () => {
  $('#setStatus').textContent = '\u6b63\u5728\u53d1\u5230\u5fae\u4fe1\u2026';
  try {
    const r = await postJson('/api/push', {});
    if (r.ok) $('#setStatus').textContent = '\u5df2\u53d1\u5230\u5fae\u4fe1\uff0c\u53bb\u770b\u770b\u624b\u673a\u3002' + String(r.body || '').slice(0, 100);
    else if (r.reason === 'no-token') $('#setStatus').textContent = '\u8fd8\u6ca1\u6709 token\uff0c\u5148\u628a token \u7c98\u5230\u4e0a\u9762\u4fdd\u5b58\u3002';
    else $('#setStatus').textContent = '\u53d1\u9001\u5931\u8d25\uff1a' + String(r.body || r.reason || '').slice(0, 160);
  } catch (e) { $('#setStatus').textContent = '\u53d1\u9001\u5931\u8d25\uff1a' + e.message; }
};

let timer = null;
$('#q').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  clearTimeout(timer);
  timer = setTimeout(doSearch, 220);
});
$('#source').addEventListener('change', (e) => { state.source = e.target.value; doSearch(); if (state.tab === 'timeline') loadTimeline(); });
$('#kind').addEventListener('change', (e) => { state.kind = e.target.value; doSearch(); });
document.querySelectorAll('.navbtn[data-tab]').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); switchTab('search'); $('#q').focus(); $('#q').select(); return; }
  if (mod && e.key >= '1' && e.key <= '3') {
    e.preventDefault();
    switchTab(['search', 'timeline', 'due'][Number(e.key) - 1]);
    return;
  }
  if (e.key === 'Escape') {
    $('#setMask').classList.add('hidden');
    if (document.activeElement === $('#q')) $('#q').blur();
  }
});

loadFilters().then(() => { loadBrief(); doSearch(); }).then(() => {
  const qs = new URLSearchParams(location.search);
  const id = Number(qs.get('doc') || 0);
  if (id) openDoc(id, null);
  const tab = qs.get('tab');
  if (tab === 'timeline' || tab === 'due') switchTab(tab);
  if (qs.get('settings')) openSettings();
}).catch((e) => {
  $('#stats').innerHTML = '<span class="chip" style="color:#fca5a5">' + escapeHtml('\u8fde\u4e0d\u4e0a\u672c\u5730\u670d\u52a1\uff1a' + e.message) + '</span>';
  $('#live').classList.add('off');
});
