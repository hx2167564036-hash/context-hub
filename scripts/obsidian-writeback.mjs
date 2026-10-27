#!/usr/bin/env node
// Obsidian 写回：把中枢晨报生成为中文 Markdown 日报，写进 Obsidian vault 的日记目录。
// 用法：
//   node scripts/obsidian-writeback.mjs                       （写默认 vault 目录）
//   node scripts/obsidian-writeback.mjs --dry                 （只打印，不写盘）
//   node scripts/obsidian-writeback.mjs --out data/tmp/writeback-test.md
//   node scripts/obsidian-writeback.mjs --date 2026-10-27 --hub http://127.0.0.1:7311 --token xxx
// 说明：
//   - 只读 HTTP 接口（/api/brief、/api/due?days=14、/api/stats、/api/timeline?days=3、/api/search?days=3&limit=30），
//     不直连数据库、不依赖第三方库（Node 24 内置 fetch）。
//   - 「近 3 天新增」以 /api/timeline?days=3 为准：它对 doc_time 真正做时间窗过滤并折叠 archive/expired/stub；
//     当前 src/hub-read.mjs 的 search() 并不认识 days 参数（只认 q/source/kind/limit/offset/tier/stub），
//     /api/search?days=3 实际返回的是「最新 N 条」，所以它只做兜底与交叉核对，避免日报虚报「近 3 天」。
//   - 幂等：同一 date 只会产生同一个文件，重跑整文件覆盖，不会追加。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/db.mjs';

const TZ = 'Asia/Shanghai';
const NOTE = '> 由天枢自动生成，勿手改';
const TAG = '中枢日报';
const DEFAULT_HUB = 'http://127.0.0.1:7311';
// 默认 vault 相对路径（config.json 里 obsidian 根之下）
const VAULT_SUBDIR = ['日记', '天枢'];

const args = process.argv.slice(2);
const has = (name) => args.some((a) => a === '--' + name || a.startsWith('--' + name + '='));
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
};
const DRY = has('dry');
const HELP = has('help') || has('h');

function usage() {
  console.log([
    'Obsidian 写回：把中枢晨报生成为中文 Markdown 日报，写入 Obsidian vault。',
    '',
    '用法：node scripts/obsidian-writeback.mjs [选项]',
    '',
    '选项：',
    '  --dry              只打印将写入的路径与全文，不落盘（沙箱/演练用）',
    '  --date YYYY-MM-DD  指定日报日期（默认本地时区 Asia/Shanghai 的今天）',
    '  --out <路径>       输出路径：以 .md 结尾视为文件，否则视为目录（在其下写 YYYY-MM-DD.md）；',
    '                     默认 ' + defaultVaultDir(),
    '  --hub <URL>        中枢地址（默认 http://127.0.0.1:7311）',
    '  --token <TOKEN>    访问码（默认取 config.json 的 lan.token）',
    '  --help             显示本帮助',
    '',
    '示例：',
    '  node scripts/obsidian-writeback.mjs --dry',
    '  node scripts/obsidian-writeback.mjs --out data/tmp/writeback-test.md',
    '  node scripts/obsidian-writeback.mjs --date 2026-10-27'
  ].join('\n'));
}

// ---------- 配置/参数 ----------

function loadCfgSafe() {
  try { return loadConfig(); } catch { return {}; }
}
const CFG = loadCfgSafe();

/** 默认 vault 目录：优先用 config.json 里 source=obsidian 的根，其次退回硬编码路径 */
function defaultVaultDir() {
  const roots = Array.isArray(CFG.roots) ? CFG.roots : [];
  const ob = roots.find((r) => r && r.source === 'obsidian' && r.path);
  const base = ob ? ob.path : 'D:\\kendle\\Documents\\chx的美好生活';
  return path.join(base, ...VAULT_SUBDIR);
}

const HUB = String(opt('hub', DEFAULT_HUB)).replace(/\/+$/, '');
const TOKEN = String(opt('token', (CFG.lan && CFG.lan.token) || ''));

// ---------- 日期（固定 Asia/Shanghai，不依赖机器 TZ） ----------

function partsOf(date, withTime) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : {})
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  return out;
}
const ymd = (date) => {
  const p = partsOf(date, false);
  return p.year + '-' + p.month + '-' + p.day;
};
const hhmm = (date) => {
  const p = partsOf(date, true);
  return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
};
/** ISO/日期串 → 本地（Asia/Shanghai）时刻；无效返回 null */
function localDate(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}
function fmtDateTime(v) {
  const d = localDate(v);
  if (!d) return '时间未知';
  return ymd(d).slice(5) + ' ' + hhmm(d);
}
function checkDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00+08:00');
  if (Number.isNaN(d.getTime())) return false;
  return ymd(d) === s; // 排除 2026-02-31 这类溢出
}

// 北京时间当天的 [00:00, 24:00) 与本周（周一=起点）边界
function dayRange(dateStr) {
  const start = new Date(dateStr + 'T00:00:00+08:00');
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}
function weekRange(dateStr) {
  const { start } = dayRange(dateStr);
  // 本地（Asia/Shanghai）日历日的星期几：用 UTC 构造同一天，避免 +08:00 偏移把 getUTCDay 打回前一天
  const p = partsOf(start, false);
  const wd = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  const dow = (wd + 6) % 7; // 周一=0
  const monday = new Date(start.getTime() - dow * 86400000);
  return { start: monday, end: new Date(monday.getTime() + 7 * 86400000) };
}

// ---------- HTTP ----------

async function api(urlPath, required) {
  if (!TOKEN) throw new Error('缺少访问码：config.json 里 lan.token 为空，请用 --token 指定');
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = HUB + urlPath + sep + 't=' + encodeURIComponent(TOKEN);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error('连不上中枢 ' + HUB + '（' + err.message + '）');
  }
  if (res.status === 401) throw new Error('访问码被拒（401）：检查 config.json 的 lan.token 或 --token');
  if (!res.ok) throw new Error(urlPath + ' 返回 HTTP ' + res.status);
  try {
    return await res.json();
  } catch {
    throw new Error(urlPath + ' 返回的不是 JSON');
  }
}

// ---------- 数据整理 ----------

const SOURCE_LABEL = {
  obsidian: 'Obsidian 笔记',
  hzcu: '学在城院',
  fs: '本地文件',
  wechat: '微信',
  phone: '手机通知',
  dingtalk: '钉钉'
};
const sourceLabel = (s) => SOURCE_LABEL[s] || (s || '未知来源');
const KIND_LABEL = {
  md: '笔记', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PPT', txt: '文本', html: '网页',
  作业: '作业', 考试: '考试', 课件: '课件', 通知: '通知', 章节: '章节', 课程: '课程', 讨论: '讨论', misc: '杂项', 其他: '其他'
};
const kindLabel = (k) => KIND_LABEL[k] || k || '未知';

function dueBullet(it) {
  const dl = localDate(it.endTime);
  const left = Number(it.hoursLeft);
  let when = '';
  if (it.overdue || left < 0) when = '已过期';
  else if (left < 24) when = '剩 ' + Math.max(left, 0) + ' 小时';
  else when = '剩 ' + Math.max(Math.round(left / 24), 1) + ' 天';
  const bits = [
    '- [ ] **' + (it.title || '(无标题)') + '**',
    it.course ? '（' + it.course + '）' : '',
    ' — 截止 ' + fmtDateTime(it.endTime) + ' · ' + when
  ];
  const files = Array.isArray(it.files) ? it.files.filter(Boolean) : [];
  if (files.length) bits.push(' · 附件：' + files.join('、'));
  return bits.join('');
}

/** 近 3 天新增：优先 timeline（真时间窗），为空/失败时退回 search（客户端按 3 天过滤） */
function collectFresh(timeline, searchHits) {
  const now = Date.now();
  const cutoff = now - 3 * 86400000;
  // timeline 的条目用 snake_case 的 doc_time，search 的命中用 docTime，这里统一成 docTime
  const norm = (it) => ({ ...it, docTime: it.docTime || it.doc_time || '' });
  const items = [];
  let origin = 'timeline';
  if (timeline && Array.isArray(timeline.groups)) {
    for (const g of timeline.groups) {
      for (const it of g.items || []) items.push(norm(it));
    }
  }
  if (!items.length) {
    origin = 'search';
    for (const h of searchHits || []) {
      const t = localDate(h.docTime);
      if (t && t.getTime() >= cutoff) items.push(norm(h));
    }
  }
  // 按 source 分组，组内按时间倒序
  const groups = new Map();
  for (const it of items) {
    const s = it.source || '未知来源';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it);
  }
  const out = [...groups.entries()]
    .map(([source, list]) => {
      list.sort((a, b) => String(b.docTime || '').localeCompare(String(a.docTime || '')));
      return { source, list };
    })
    .sort((a, b) => b.list.length - a.list.length || a.source.localeCompare(b.source));
  return { items, groups: out, origin };
}

function statLine(stats) {
  const mb = (Number(stats.bytes || 0) / 1024 / 1024).toFixed(1);
  return '资料总量 **' + (stats.total ?? '?') + '** 条，占用 **' + mb + ' MB**；最近入库 ' + fmtDateTime(stats.latest) + '。';
}

// ---------- Markdown ----------

function buildReport({ date, brief, due14, stats, timeline, search, now }) {
  const L = [];
  const { start: dayStart, end: dayEnd } = dayRange(date);
  const { start: weekStart, end: weekEnd } = weekRange(date);

  // 到期项：/api/due?days=14（窗口语义正确）为准
  const dueItems = Array.isArray(due14 && due14.items) ? due14.items : [];
  const todayDue = [];
  const weekDue = [];
  const laterDue = [];
  const overdue = [];
  for (const it of dueItems) {
    const end = localDate(it.endTime);
    if (!end) continue;
    if (it.overdue || end.getTime() < dayStart.getTime()) overdue.push(it);
    else if (end.getTime() < dayEnd.getTime()) todayDue.push(it);
    else if (end.getTime() >= weekStart.getTime() && end.getTime() < weekEnd.getTime()) weekDue.push(it);
    else laterDue.push(it);
  }

  const weekActs = Array.isArray(brief && brief.week) ? brief.week : [];
  const fresh = collectFresh(timeline, search && search.hits);

  // frontmatter
  L.push('---');
  L.push('date: ' + date);
  L.push('tags: [' + TAG + ']');
  L.push('generated: ' + ymd(now) + 'T' + hhmm(now) + ':00+08:00');
  L.push('---');
  L.push('');
  L.push('# ' + date + ' · 天枢日报');
  L.push('');
  L.push(NOTE);
  L.push('> 生成时间：' + ymd(now) + ' ' + hhmm(now) + '（Asia/Shanghai）　数据截至：' + fmtDateTime(brief && brief.generatedAt));
  L.push('');
  L.push('数据源：`/api/brief`、`/api/due?days=14`、`/api/timeline?days=3`、`/api/search?days=3&limit=30`、`/api/stats`');
  L.push('');

  // 一、今日与本周到期
  L.push('## 一、今日与本周到期');
  L.push('');
  if (overdue.length) {
    L.push('### 已过期未交（' + overdue.length + '）');
    for (const it of overdue) L.push(dueBullet(it));
    L.push('');
  }
  if (todayDue.length) {
    L.push('### 今日到期（' + todayDue.length + '）');
    for (const it of todayDue) L.push(dueBullet(it));
  } else {
    L.push('### 今日到期');
    L.push('今天没有要到期的作业或考试。');
  }
  L.push('');
  if (weekDue.length) {
    L.push('### 本周到期（' + weekDue.length + '）');
    for (const it of weekDue) L.push(dueBullet(it));
  } else {
    L.push('### 本周到期');
    L.push('本周剩余时间没有要到期的作业或考试。');
  }
  L.push('');
  if (laterDue.length) {
    L.push('### 更晚（14 天内，' + laterDue.length + '）');
    for (const it of laterDue) L.push(dueBullet(it));
    L.push('');
  }
  if (weekActs.length) {
    L.push('### 本周课程活动（' + weekActs.length + '）');
    for (const w of weekActs) {
      L.push('- **' + (w.title || '(无标题)') + '**（' + kindLabel(w.kind) + '）· ' +
        (w.course ? w.course + ' · ' : '') + fmtDateTime(w.at));
    }
  } else {
    L.push('### 本周课程活动');
    L.push('本周暂无课程活动记录。');
  }
  L.push('');
  L.push('> 未来 14 天共 **' + dueItems.length + '** 项截止（`/api/due?days=14`）。');
  L.push('');

  // 二、近 3 天新增
  L.push('## 二、近 3 天新增（按来源分组）');
  L.push('');
  if (!fresh.items.length) {
    L.push('近 3 天没有新资料进库。');
  } else {
    const shown = 8;
    for (const g of fresh.groups) {
      L.push('### ' + sourceLabel(g.source) + '（' + g.list.length + '）');
      for (const it of g.list.slice(0, shown)) {
        L.push('- ' + (it.docTime ? fmtDateTime(it.docTime) : '时间未知') + ' · **' + (it.title || '(无标题)') + '**（' + kindLabel(it.kind) + '）');
      }
      if (g.list.length > shown) L.push('- … 另有 ' + (g.list.length - shown) + ' 条');
      L.push('');
    }
    L.push('> 近 3 天合计 **' + fresh.items.length + '** 条' +
      (fresh.origin === 'timeline' ? '（`/api/timeline?days=3`，已折叠归档/过期/桩）' : '（已回退 `/api/search` 并按 3 天过滤）') + '。');
    L.push('');
  }

  // 三、资料总量
  L.push('## 三、资料总量');
  L.push('');
  L.push(statLine(stats));
  L.push('');
  if (Array.isArray(stats.bySource) && stats.bySource.length) {
    L.push('| 来源 | 条数 |');
    L.push('| --- | ---: |');
    for (const s of stats.bySource) L.push('| ' + sourceLabel(s.source) + ' | ' + s.n + ' |');
    L.push('');
  }
  if (Array.isArray(stats.byKind) && stats.byKind.length) {
    const top = stats.byKind.slice(0, 8).map((k) => kindLabel(k.kind) + ' ' + k.n).join('、');
    L.push('主要类型：' + top + '。');
    L.push('');
  }
  L.push('---');
  L.push('由 `scripts/obsidian-writeback.mjs` 生成 · 中枢 ' + HUB);
  L.push('');
  return L.join('\n');
}

// ---------- 落盘 ----------

function resolveTarget(date) {
  const outOpt = opt('out', '');
  if (!outOpt) return path.join(defaultVaultDir(), date + '.md');
  const p = path.isAbsolute(outOpt) ? outOpt : path.join(ROOT, outOpt);
  if (/\.md$/i.test(p)) return p;
  return path.join(p, date + '.md');
}

(async () => {
  if (HELP) { usage(); return; }

  const date = opt('date', ymd(new Date()));
  if (!checkDate(date)) {
    console.error('[写回] ✘ --date 不是合法日期（需 YYYY-MM-DD）：' + date);
    process.exit(1);
  }
  const now = new Date();
  const target = resolveTarget(date);

  console.log('[写回] 中枢 ' + HUB + ' · 日期 ' + date + (DRY ? ' · 演练模式（不写盘）' : ''));

  let brief, due14, stats, timeline, search;
  try {
    [brief, due14, stats] = await Promise.all([
      api('/api/brief'),
      api('/api/due?days=14'),
      api('/api/stats')
    ]);
    // 这两个是「近 3 天新增」的证据链，timeline 为主、search 兜底；单个失败不算致命
    try { timeline = await api('/api/timeline?days=3'); } catch (e) { console.warn('[写回] ! /api/timeline 失败，改用 search 兜底：' + e.message); }
    try { search = await api('/api/search?days=3&limit=30'); } catch (e) { console.warn('[写回] ! /api/search 失败（仅影响兜底与交叉核对）：' + e.message); }
  } catch (err) {
    console.error('[写回] ✘ 拉取中枢数据失败：' + err.message);
    process.exit(1);
  }

  if (!brief || !Array.isArray(brief.week) || !Array.isArray(brief.due)) {
    console.error('[写回] ✘ /api/brief 结构异常：缺少 due/week 数组');
    process.exit(1);
  }
  if (!stats || typeof stats.total !== 'number') {
    console.error('[写回] ✘ /api/stats 结构异常：缺少 total');
    process.exit(1);
  }
  if (!due14 || !Array.isArray(due14.items)) {
    console.error('[写回] ✘ /api/due 结构异常：缺少 items 数组');
    process.exit(1);
  }

  const md = buildReport({ date, brief, due14, stats, timeline, search, now });

  // 交叉核对（只记日志，不进正文）
  const freshInfo = collectFresh(timeline, search && search.hits);
  console.log('[写回] 今日/本周到期 ' + due14.items.length + ' 项（14 天窗）· 近 3 天新增 ' + freshInfo.items.length + ' 条' +
    (timeline ? '（timeline）' : '（search 兜底）') + ' · 资料总量 ' + stats.total + ' 条');
  console.log('[写回] 目标路径 ' + target);

  if (DRY) {
    console.log('[写回] ── 演练输出开始 ──');
    console.log(md);
    console.log('[写回] ── 演练输出结束（共 ' + md.length + ' 字符，未写盘）──');
    return;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, md, 'utf8'); // 整文件覆盖：幂等
  } catch (err) {
    console.error('[写回] ✘ 写入失败：' + err.message);
    console.error('[写回] 提示：vault 在 workspace 之外，沙箱下请用 --dry 或 --out data/tmp/xxx.md');
    process.exit(1);
  }
  console.log('[写回] ✔ 已写入 ' + target + '（' + md.length + ' 字符）');
})().catch((err) => {
  console.error('[写回] ✘ ' + err.message);
  process.exit(1);
});
