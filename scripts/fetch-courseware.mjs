// 下载学在城院课件（用带 token 的 meida 地址，服务器端直连即可）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDb, loadConfig } from '../src/db.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const BASE = path.join('data', 'files', 'hzcu');
const LIMIT = Number(process.argv[2] || 40);
const MAXMB = Number(process.argv[3] || 80);

function safeName(s) {
  return String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'file';
}

const courses = new Map();
for (const c of db.prepare('select id, name from tron_courses').all()) courses.set(String(c.id), c.name || String(c.id));

const WITH_VIDEO = process.argv[4] === 'video';
const SKIP_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.m4v']);
let rows = db.prepare("select ref_id, course_id, activity_id, name, url from tron_files where url is not null and (local_path is null or local_path = '') limit ?").all(LIMIT);
if (!WITH_VIDEO) {
  const before = rows.length;
  rows = rows.filter((r) => !SKIP_EXT.has((path.extname(String(r.name || '')) || '').toLowerCase()));
  if (before !== rows.length) console.log('[dl] 跳过视频/大媒体 ' + (before - rows.length) + ' 个（加参数 video 可下载）');
}
console.log('[dl] 待下载', rows.length);
let ok = 0, fail = 0, bytes = 0;
for (const r of rows) {
  const courseName = safeName(courses.get(String(r.course_id)) || r.course_id);
  const dir = path.join(BASE, courseName);
  const ext = (path.extname(String(r.name || '')) || '.bin').toLowerCase();
  let dest = path.join(dir, safeName(path.basename(String(r.name || ''), ext)) + ext);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120000);
    const res = await fetch(r.url, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 1024) throw new Error('太小 ' + buf.byteLength);
    if (buf.byteLength > MAXMB * 1024 * 1024) throw new Error('超过 ' + MAXMB + 'MB');
    const magic = buf.subarray(0, 8).toString('hex');
    let dest2 = dest;
    if (magic.startsWith('25504446') && ext !== '.pdf') dest2 = dest.slice(0, -ext.length) + '.pdf';
    else if (magic.startsWith('504b0304') && ext !== '.zip' && ext !== '.docx' && ext !== '.pptx' && ext !== '.xlsx') dest2 = dest.slice(0, -ext.length) + '.zip';
    await fsp.writeFile(dest2, buf);
    if (dest2 !== dest) { try { await fsp.rm(dest, { force: true }); } catch { /* ignore */ } }
    dest = dest2;
    db.prepare('update tron_files set local_path = ?, updated_at = ? where ref_id = ?').run(dest, new Date().toISOString(), r.ref_id);
    ok++; bytes += buf.byteLength;
    console.log('[dl] OK', dest, (buf.byteLength / 1024 / 1024).toFixed(1) + 'MB');
  } catch (e) {
    fail++;
    console.log('[dl] FAIL', r.name, String((e && e.message) || e).slice(0, 80));
  }
}
console.log('[dl] 完成 ok=' + ok + ' fail=' + fail + ' 共 ' + (bytes / 1024 / 1024).toFixed(1) + 'MB');
