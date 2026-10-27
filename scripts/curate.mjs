// 去重 + 给每份资料打「有效性」分层
// 用法：node scripts/curate.mjs [--apply]
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const db = new DatabaseSync('data/context.db');
const LIVE = "COALESCE(json_extract(meta,'$.dupOf'),'') = ''";
const now = Date.now();
const DAY = 864e5;
const CUR_YEAR = '2026-2027';

const docs = db.prepare('select id, source, kind, uri, title, body, hash, doc_time, meta, size from documents where ' + LIVE).all()
  .map((d) => { let m = {}; try { m = JSON.parse(d.meta || '{}'); } catch { /* ignore */ } return { ...d, m }; });
const courses = new Map();
for (const c of db.prepare('select id, name, year, start_date, end_date from tron_courses').all()) courses.set(String(c.id), c);

const normTitle = (t) => String(t || '')
  .replace(/\s*[(（]\d+[)）]$/, '')
  .replace(/\.(pdf|docx?|pptx?|xlsx?)$/i, '')
  .replace(/[\s_\-·]+/g, '')
  .toLowerCase();

// 1) 同内容（hash 或 标题归一化后正文前 3000 字相同）
const dup = [];
const groups = new Map();
for (const d of docs) {
  if (!d.body || d.body.length < 120) continue;
  const key = d.hash + '|' + normTitle(d.title).slice(0, 40);
  const arr = groups.get(key) || [];
  arr.push(d); groups.set(key, arr);
}
const byNorm = new Map();
for (const arr of groups.values()) for (const d of arr) { const k = normTitle(d.title); const a = byNorm.get(k) || []; a.push(d); byNorm.set(k, a); }
for (const arr of byNorm.values()) {
  if (arr.length < 2) continue;
  const rank = (d) => (d.source === 'hzcu' && d.kind !== 'misc' ? 0 : d.source === 'fs' ? 1 : d.source === 'wechat' ? 2 : 3);
  arr.sort((a, b) => rank(a) - rank(b) || b.body.length - a.body.length);
  const keepHead = (arr[0].body || '').slice(0, 3000);
  for (let i = 1; i < arr.length; i++) {
    const head = (arr[i].body || '').slice(0, 3000);
    if (arr[i].hash === arr[0].hash || head === keepHead) dup.push([arr[0].id, arr[i].id]);
  }
}
// 同 hash 兜底（标题不同但内容一样）
const byHash = new Map();
for (const d of docs) { if (!d.body || d.body.length < 200) continue; const a = byHash.get(d.hash) || []; a.push(d); byHash.set(d.hash, a); }
const dupSet = new Set(dup.map((p) => p[1]));
for (const arr of byHash.values()) {
  if (arr.length < 2) continue;
  const live = arr.filter((d) => !dupSet.has(d.id));
  if (live.length < 2) continue;
  const rank = (d) => (d.source === 'hzcu' ? 0 : d.source === 'fs' ? 1 : 2);
  live.sort((a, b) => rank(a) - rank(b) || b.body.length - a.body.length);
  for (let i = 1; i < live.length; i++) { dup.push([live[0].id, live[i].id]); dupSet.add(live[i].id); }
}

function tierOf(d) {
  if (d.kind === 'misc' || /学在城院 misc/.test(d.title)) return 'stub';
  const end = d.m.endTime ? Date.parse(d.m.endTime) : NaN;
  const t = d.doc_time ? Date.parse(d.doc_time) : NaN;
  const ageDays = Number.isFinite(t) ? (now - t) / DAY : 9999;
  const course = d.m.courseId ? courses.get(String(d.m.courseId)) : null;
  const isCur = course && String(course.year || '').includes(CUR_YEAR);
  if (Number.isFinite(end) && end > now) return 'due';
  if ((d.kind === '作业' || d.kind === '考试') && Number.isFinite(end) && end < now - 7 * DAY) return 'expired';
  if (course && !isCur) return 'archive';
  if (isCur) return 'active';
  if (ageDays <= 14) return 'fresh';
  if (ageDays <= 120) return 'recent';
  return 'old';
}

const tiers = {};
const curCourseIds = new Set();
for (const d of docs) {
  const tier = tierOf(d);
  tiers[tier] = (tiers[tier] || 0) + 1;
  if (tier === 'active' && d.m.courseId) curCourseIds.add(String(d.m.courseId));
  if (APPLY) db.prepare('update documents set meta = ? where id = ?').run(JSON.stringify({ ...d.m, tier }), d.id);
}
// 标题重名（同一门课的多个不同活动同名）→ 加日期后缀区分
const titleCount = new Map();
for (const d of docs) { const k = String(d.title); titleCount.set(k, (titleCount.get(k) || 0) + 1); }
const renamed = [];
for (const d of docs) {
  if ((titleCount.get(String(d.title)) || 0) < 2) continue;
  if (d.kind === 'misc' || /学在城院 misc/.test(d.title)) continue;
  const day = (d.doc_time || '').slice(5, 10).replace('-', '/');
  const newTitle = (d.title + (day ? ' · ' + day : ' · #' + d.id)).slice(0, 120);
  renamed.push([d.id, newTitle]);
  if (APPLY) db.prepare('update documents set title = ? where id = ?').run(newTitle, d.id);
}

if (APPLY) {
  for (const [keep, drop] of dup) {
    const row = db.prepare('select meta from documents where id = ?').get(keep);
    let m = {}; try { m = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
    const alt = Array.isArray(m.altPaths) ? m.altPaths : [];
    const dropp = db.prepare('select uri from documents where id = ?').get(drop);
    if (dropp && !alt.includes(dropp.uri)) alt.push(dropp.uri);
    db.prepare('update documents set meta = ? where id = ?').run(JSON.stringify({ ...m, altPaths: alt }), keep);
    db.prepare('update documents set meta = ? where id = ?').run(JSON.stringify({ dupOf: keep }), drop);
  }
}
console.log('live', docs.length, '| 重复对', dup.length, '| 标题消歧', renamed.length);
console.log('分层', JSON.stringify(tiers));
console.log('当前学期课程', curCourseIds.size);
