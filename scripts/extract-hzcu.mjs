// 把 data/files/hzcu 下所有 pdf/docx/pptx/xlsx 抽全文入库，打印失败原因
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDb, loadConfig, ROOT, upsertDoc } from '../src/db.mjs';
import { indexText } from '../src/tokenize.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const BASE = path.join(ROOT, 'data', 'files', 'hzcu');
const PY_EXT = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);
const FORCE = process.argv[2] === '--force';
const LIMIT = Number(process.argv[3] || 9999);

const stmtGet = db.prepare('SELECT id, hash, length(body) n FROM documents WHERE uri = ?');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (PY_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

const all = [];
walk(BASE, all);
const todo = [];
for (const full of all) {
  const prev = stmtGet.get(full);
  if (!FORCE && prev && prev.n >= 100) continue;
  todo.push(full);
}
console.log('[hzcu] 目录内可抽文件', all.length, '待处理', todo.length);

let added = 0, empty = 0, fail = 0, dup = 0;
const CHUNK = 12;
const stamp0 = Date.now();
for (let s = 0; s < todo.length && s < LIMIT; s += CHUNK) {
  const chunk = todo.slice(s, s + CHUNK);
  const tmp = path.join(ROOT, 'data', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const inPath = path.join(tmp, 'hz-in-' + stamp0 + '-' + s + '.jsonl');
  const outPath = path.join(tmp, 'hz-out-' + stamp0 + '-' + s + '.jsonl');
  fs.writeFileSync(inPath, chunk.map((p, i) => JSON.stringify({ i, path: p, ext: path.extname(p).toLowerCase() })).join('\n') + '\n', 'utf8');
  const r = spawnSync(cfg.pythonPath || 'python', [path.join(ROOT, cfg.extractScript || 'tools/extract.py'), inPath, outPath], { encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) console.error('[py] 退出', r.status, String(r.stderr || '').slice(0, 300));
  const recs = new Map();
  if (fs.existsSync(outPath)) {
    for (const line of fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(line); recs.set(o.i, o); } catch { /* ignore */ }
    }
  }
  for (let i = 0; i < chunk.length; i++) {
    const full = chunk[i];
    const rec = recs.get(i);
    const rel = path.relative(BASE, full);
    if (!rec) { fail++; console.log('[fail] 无结果', rel); continue; }
    if (!rec.ok) { fail++; console.log('[fail]', rel, String(rec.err || '').slice(0, 90)); continue; }
    const text = String(rec.text || '').slice(0, cfg.maxTextChars || 400000);
    if (!text.trim()) { empty++; console.log('[empty]', rel); continue; }
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const prev = stmtGet.get(full);
    if (prev && prev.hash === hash) continue;
    const stat = fs.statSync(full);
    const ext = path.extname(full).toLowerCase();
    const title = path.basename(full, ext).slice(0, 120);
    upsertDoc(db, {
      source: 'hzcu', kind: ext.slice(1), uri: full, title, body: text, ext: ext.slice(1),
      size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(),
      docTime: new Date(stat.mtimeMs).toISOString(), hash,
      meta: { label: '学在城院课件', rootPath: BASE, relPath: rel },
      ftsTitle: indexText(title, 2000),
      ftsBody: indexText(rel + '\n' + text, cfg.maxTextChars || 400000)
    });
    added++;
  }
  try { fs.unlinkSync(inPath); fs.unlinkSync(outPath); } catch { /* ignore */ }
  console.log('[progress] 新增', added, '空', empty, '失败', fail);
}
console.log('[hzcu] 完成：新增', added, '空内容', empty, '失败', fail, '跳过(已有)', all.length - todo.length);
