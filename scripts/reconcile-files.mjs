// 把磁盘上已存在、但 tron_files.local_path 为空的记录关联回去（扩展名可能被改成 .pdf）
import fs from 'node:fs';
import path from 'node:path';
import { openDb, loadConfig } from '../src/db.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const BASE = path.join('data', 'files', 'hzcu');
function safeName(s) { return String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'file'; }
const dirCache = new Map();
function listDir(d) {
  if (dirCache.has(d)) return dirCache.get(d);
  let names = [];
  try { names = fs.readdirSync(d); } catch { names = []; }
  const map = new Map();
  for (const n of names) { const core = path.basename(n, path.extname(n)); if (!map.has(core)) map.set(core, n); }
  dirCache.set(d, map);
  return map;
}
const courses = new Map();
for (const c of db.prepare('select id, name from tron_courses').all()) courses.set(String(c.id), c.name || String(c.id));
const rows = db.prepare("select ref_id, course_id, name from tron_files where local_path is null or local_path = ''").all();
let linked = 0;
const upd = db.prepare('update tron_files set local_path = ?, updated_at = ? where ref_id = ?');
for (const r of rows) {
  const dir = path.join(BASE, safeName(courses.get(String(r.course_id)) || r.course_id));
  const core = safeName(path.basename(String(r.name || ''), path.extname(String(r.name || ''))));
  const hit = listDir(dir).get(core);
  if (!hit) continue;
  upd.run(path.join(dir, hit), new Date().toISOString(), r.ref_id);
  linked++;
}
console.log('[reconcile] 关联', linked, '/ 待补', rows.length);
