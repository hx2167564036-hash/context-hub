// 把已下载课件的 doc_time 对齐到所属课程活动的时间（而不是下载时间）
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/context.db');
const files = db.prepare("select activity_id, local_path from tron_files where local_path is not null and local_path <> '' and activity_id is not null").all();
const actTime = new Map();
for (const r of db.prepare("select uri, doc_time from documents where uri like 'tron://activity/%'").all()) actTime.set(r.uri.replace('tron://activity/', ''), r.doc_time);
const docByUri = new Map();
for (const r of db.prepare("select id, uri, doc_time from documents where uri like '%hzcu%'").all()) docByUri.set(r.uri, r);
const upd = db.prepare('update documents set doc_time = ? where id = ?');
let fixed = 0;
for (const f of files) {
  const abs = path.resolve(f.local_path);
  const row = docByUri.get(abs) || docByUri.get(f.local_path);
  if (!row) continue;
  const t = actTime.get(String(f.activity_id));
  if (!t || row.doc_time === t) continue;
  upd.run(t, row.id);
  fixed++;
}
console.log('[fix-times] 修正', fixed);
