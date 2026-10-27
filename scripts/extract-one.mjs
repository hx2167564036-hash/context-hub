// 单文件抽取：node scripts/extract-one.mjs <文件绝对路径> [source] [label]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDb, loadConfig, ROOT, upsertDoc } from '../src/db.mjs';
import { indexText } from '../src/tokenize.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const full = path.resolve(process.argv[2] || '');
const source = process.argv[3] || 'fs';
const label = process.argv[4] || path.basename(path.dirname(full));
if (!fs.existsSync(full)) { console.error('文件不存在', full); process.exit(1); }
const ext = path.extname(full).toLowerCase();
const stat = fs.statSync(full);
const tmp = path.join(ROOT, 'data', 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
const inPath = path.join(tmp, 'one-in-' + stamp + '.jsonl');
const outPath = path.join(tmp, 'one-out-' + stamp + '.jsonl');
fs.writeFileSync(inPath, JSON.stringify({ i: 1, path: full, ext }) + '\n', 'utf8');
const r = spawnSync(cfg.pythonPath || 'python', [path.join(ROOT, cfg.extractScript || 'tools/extract.py'), inPath, outPath], { encoding: 'utf8', timeout: 900000 });
if (r.status !== 0) console.error('[extract] 退出码', r.status, (r.stderr || '').slice(0, 400));
if (!fs.existsSync(outPath)) { console.error('[extract] 无输出'); process.exit(1); }
const rec = JSON.parse(fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean)[0] || '{}');
if (!rec.ok) { console.error('[extract] 失败', rec.err); process.exit(1); }
const text = String(rec.text || '').slice(0, cfg.maxTextChars || 400000);
const hash = crypto.createHash('sha1').update(text).digest('hex');
const title = path.basename(full, ext).slice(0, 120);
const relPath = path.relative(path.join(ROOT, 'data', 'files', 'hzcu'), full);
const res = upsertDoc(db, {
  source, kind: ext.slice(1), uri: full, title, body: text, ext: ext.slice(1), size: stat.size,
  mtime: new Date(stat.mtimeMs).toISOString(), docTime: new Date(stat.mtimeMs).toISOString(), hash,
  meta: { label, rootPath: path.join(ROOT, 'data', 'files', 'hzcu'), relPath },
  ftsTitle: indexText(title, 2000),
  ftsBody: indexText(relPath + '\n' + text, cfg.maxTextChars || 400000)
});
console.log('[extract-one]', res.changed ? '已入库' : '无变化', '| 文本', text.length, '字 | id', res.id);
