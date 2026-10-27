// 一次性重建：把 data/raw/hzcu 下已抓到的 TronClass 原始 JSON 重新解析成结构化文档
import fs from 'node:fs';
import path from 'node:path';
import { openDb, loadConfig, upsertDoc, ROOT } from '../src/db.mjs';
import { indexText } from '../src/tokenize.mjs';
import { parseTronClass } from '../src/tronclass.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const dir = path.join(ROOT, 'data', 'raw', 'hzcu');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

const before = db.prepare("SELECT count(*) AS n FROM documents WHERE source='hzcu'").get().n;
db.exec("DELETE FROM documents WHERE source='hzcu'");
db.exec("DELETE FROM docs_fts WHERE rowid NOT IN (SELECT id FROM documents)");

let hit = 0, docs = 0, added = 0, fileRows = 0;
for (const f of files) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const url = payload.url || payload.page || '';
  let parsed;
  try { parsed = parseTronClass(db, url, payload.data); } catch (e) { continue; }
  if (!parsed.hit) continue;
  hit++;
  fileRows += parsed.files.length;
  for (const d of parsed.docs) {
    d.ftsTitle = indexText(d.title, 2000);
    d.ftsBody = indexText(d.body, 400000);
    const r = upsertDoc(db, d);
    docs++;
    if (r.changed) added++;
  }
}
const after = db.prepare("SELECT count(*) AS n FROM documents WHERE source='hzcu'").get().n;
const kinds = db.prepare("SELECT kind, count(*) AS n FROM documents WHERE source='hzcu' GROUP BY kind ORDER BY n DESC").all();
console.log(JSON.stringify({ rawFiles: files.length, matched: hit, docs, added, before, after, fileRows,
  kinds: kinds.map((k) => k.kind + ':' + k.n),
  courses: db.prepare('SELECT id, name, code FROM tron_courses').all() }, null, 1));
