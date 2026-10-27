const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const leftText = (h) => (h < 0 ? '已过期' + Math.abs(h) + '小时' : h < 24 ? '还剩' + h + '小时' : '还剩' + Math.round(h / 24) + '天');
const SRC = { hzcu: '学在城院', obsidian: '笔记', fs: '文件', wechat: '微信', phone: '手机', note: '手记', foreground: '窗口', other: '其它' };
const KIND = { pdf: 'PDF', docx: 'Word', pptx: 'PPT', xlsx: 'Excel', md: 'Markdown', txt: '文本', html: '网页', '': '' };
const srcLabel = (it) => {
  const s = SRC[it.source] || it.source || '';
  const k = KIND[it.kind] || '';
  return k ? s + ' · ' + k : s;
};

function renderBrief(b) {
  const dw = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];
  const hh = b.hours;
  $('#hi').textContent = (hh < 5 ? '夜里好' : hh < 11 ? '早上好' : hh < 14 ? '中午好' : hh < 18 ? '下午好' : '晚上好');
  const sch = b.schedule || { weekNo: 0, classes: [] };
  $('#date').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) +
    ' · 第 ' + sch.weekNo + ' 周 · 本学期 ' + b.stats.currentCourses + ' 门课';
  $('#hint-week').textContent = '';
  $('#n-class').textContent = sch.classes.length ? sch.classes.length + ' 节' : '';
  const cl = $('#class-list');
  cl.innerHTML = '';
  if (!sch.classes.length) cl.innerHTML = '<div class="empty">今天没有课，时间是你的。</div>';
  for (const c of sch.classes) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = '<div class="t">' + esc(c.course) + '</div>' +
      '<div class="m">' + esc((c.time || c.start + '–' + c.end)) + ' · ' + esc(c.periods) + '</div>' +
      '<div class="f">' + esc(c.room) + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div>';
    cl.appendChild(el);
  }

  $('#n-due').textContent = b.due.length ? b.due.length + ' 项' : '';
  const dl = $('#due-list');
  dl.innerHTML = '';
  if (!b.due.length) dl.innerHTML = '<div class="empty">没有快到期的作业。可以安心学点别的。</div>';
  for (const it of b.due) {
    const cls = it.overdue || it.hoursLeft < 24 ? 'soon' : it.hoursLeft < 72 ? '' : 'later';
    const el = document.createElement('div');
    el.className = 'card ' + cls;
    el.innerHTML = '<div class="t">' + esc(it.title) + '</div>' +
      '<div class="m">' + esc(it.course) + ' · 截止 ' + fmtWhen(it.endTime) + ' · <b>' + leftText(it.hoursLeft) + '</b></div>' +
      (it.files.length ? '<div class="f">附件 ' + esc(it.files.join('、')) + '</div>' : '');
    el.onclick = () => openDoc(it.id);
    dl.appendChild(el);
  }

  $('#n-week').textContent = b.week.length ? b.week.length + ' 条' : '';
  const wl = $('#week-list');
  wl.innerHTML = '';
  const dueIds = new Set(b.due.map((x) => x.id));
  const weekOnly = b.week.filter((x) => !dueIds.has(x.id));
  if (!weekOnly.length) wl.innerHTML = '<div class="empty">本周没有别的课程活动（待办里的同一条不再重复列）。</div>';
  for (const it of weekOnly) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = '<div class="dot2"></div><div class="bt">' + esc(it.title) + '</div>' +
      '<div class="bs">' + esc(it.kind) + ' ' + fmtWhen(it.at) + '</div>';
    el.onclick = () => openDoc(it.id);
    wl.appendChild(el);
  }

  $('#n-fresh').textContent = b.fresh.length ? b.fresh.length + ' 条' : '';
  const fl = $('#fresh-list');
  fl.innerHTML = '';
  if (!b.fresh.length) fl.innerHTML = '<div class="empty">这两天没有新资料进来。</div>';
  for (const it of b.fresh) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = '<div class="dot2"></div><div class="bt">' + esc(it.title) + '</div>' +
      '<div class="bs">' + esc(srcLabel(it)) + '</div>';
    el.onclick = () => openDoc(it.id);
    fl.appendChild(el);
  }
  $('#foot-stats').textContent = '库里 ' + b.stats.totalLive + ' 条资料 · ' + fmtWhen(b.generatedAt) + ' 更新';
}

async function openDoc(id) {
  if (window.ctxhub && window.ctxhub.openDoc) return window.ctxhub.openDoc(id);
  window.open('/?doc=' + id, '_blank');
}

async function loadBrief() {
  try {
    const r = await fetch('/api/brief');
    renderBrief(await r.json());
  } catch (e) {
    $('#due-list').innerHTML = '<div class="empty">连不上本地中枢（server 没启动？）</div>';
  }
}

let t = null;
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(t);
  if (q.length < 2) { $('#hits').innerHTML = ''; return; }
  t = setTimeout(async () => {
    const r = await fetch('/api/search?limit=8&q=' + encodeURIComponent(q));
    const res = await r.json();
    $('#hits').innerHTML = res.hits.length
      ? res.hits.map((h) => '<div class="row" data-id="' + h.id + '"><div class="dot2"></div><div class="bt">' +
          esc(h.title) + '</div><div class="bs">' + esc(srcLabel(h)) + '</div></div>').join('')
      : '<div class="empty">没找到。</div>';
    $('#hits').querySelectorAll('.row[data-id]').forEach((n) => (n.onclick = () => openDoc(Number(n.dataset.id))));
  }, 220);
});
$('#btn-refresh').onclick = loadBrief;
$('#btn-main').onclick = () => { if (window.ctxhub && window.ctxhub.openMain) window.ctxhub.openMain(); else window.open('/', '_blank'); };
$('#btn-holo').onclick = () => { if (window.ctxhub && window.ctxhub.openHolo) window.ctxhub.openHolo(); else window.open('/holo', '_blank'); };
$('#btn-hide').onclick = () => { if (window.ctxhub && window.ctxhub.hide) window.ctxhub.hide(); };
$('#btn-min').onclick = () => { if (window.ctxhub && window.ctxhub.winAction) window.ctxhub.winAction('min'); else window.close(); };
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.ctxhub && window.ctxhub.hide) window.ctxhub.hide();
});
loadBrief();
setInterval(loadBrief, 5 * 60 * 1000);

