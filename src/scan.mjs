// 扫描本机各目录，抽取正文写入数据库。用法：node src/scan.mjs [--full]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDb, loadConfig, ROOT, upsertDoc, dedupeExports } from './db.mjs';
import { indexText } from './tokenize.mjs';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.csv', '.json', '.canvas', '.srt', '.vtt']);
const PY_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);

const cfg = loadConfig();
const { db, dbPath } = openDb(cfg);
const maxBytes = (cfg.maxFileMB || 80) * 1024 * 1024;
const excludeDirs = new Set((cfg.excludeDirs || []).map((s) => s.toLowerCase()));

const stmtGet = db.prepare('SELECT id, hash, size, mtime FROM documents WHERE uri = ?');
const stmtDup = db.prepare('SELECT id, uri, meta FROM documents WHERE hash = ? AND uri <> ? LIMIT 1');
const pathBlocks = (cfg.excludePathRegex || []).map((s) => new RegExp(s, 'i'));
const seen = new Set();

function blocked(full) {
  for (const re of pathBlocks) if (re.test(full)) return true;
  return false;
}

/** 内容完全相同的文件只保留一份，其余记为副本路径 */
function isDuplicate(db, uri, hash, stats) {
  const row = stmtDup.get(hash, uri);
  if (!row) return false;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
  const alts = Array.isArray(meta.altPaths) ? meta.altPaths : [];
  if (!alts.includes(uri) && alts.length < 12) {
    alts.push(uri);
    meta.altPaths = alts;
    db.prepare('UPDATE documents SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
  }
  stats.dup = (stats.dup || 0) + 1;
  seen.add(uri);
  return true;
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function canvasToText(raw) {
  try {
    const j = JSON.parse(raw);
    const out = [];
    for (const n of j.nodes || []) {
      if (n.text) out.push(n.text);
      if (n.file) out.push(n.file);
      if (n.url) out.push(n.url);
      if (n.label) out.push(n.label);
    }
    for (const e of j.edges || []) if (e.label) out.push(e.label);
    return out.join('\n');
  } catch {
    return raw;
  }
}

function frontmatterBody(text) {
  if (!text.startsWith('---')) return { fm: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: null, body: text };
  const fmRaw = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^[\r\n]+/, '');
  return { fm: fmRaw, body };
}

function titleFrom(text, fallback) {
  const m = /^#{1,3}\s+(.+)$/m.exec(text.slice(0, 2000));
  if (m) return m[1].trim().slice(0, 120);
  const first = text.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
  if (first && first.length <= 40) return first.slice(0, 120);
  return fallback;
}

function docTimeFrom(fm, statMtime, relPath) {
  if (fm) {
    const m = /^date:\s*['"]?(\d{4}-\d{1,2}-\d{1,2})/m.exec(fm);
    if (m) {
      const [y, mo, d] = m[1].split('-').map(Number);
      const dt = new Date(y, mo - 1, d, 12, 0, 0);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString();
    }
  }
  const pm = /(\d{4}-\d{2})\//.exec(relPath.replace(/\\/g, '/'));
  if (pm) return new Date(pm[1] + '-15T12:00:00').toISOString();
  return new Date(statMtime).toISOString();
}

async function walk(root, out) {
  const stack = [root.path];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name.toLowerCase())) continue;
        if (e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXT.has(ext) && !PY_EXT.has(ext)) continue;
        if (blocked(full)) continue;
        out.push({ full, ext, root });
      }
    }
  }
}

function buildDocBase(file, stat) {
  const rel = path.relative(file.root.path, file.full);
  return {
    source: file.root.source,
    uri: file.full,
    ext: file.ext.slice(1),
    size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    meta: { label: file.root.label || path.basename(file.root.path), rootPath: file.root.path, relPath: rel }
  };
}

function statUnchanged(uri, stat) {
  const prev = stmtGet.get(uri);
  if (!prev) return false;
  return prev.size === stat.size && prev.mtime === new Date(stat.mtimeMs).toISOString();
}

async function processTextFile(file, stat, stats) {
  if (statUnchanged(file.full, stat)) { stats.unchanged++; seen.add(file.full); return; }
  const buf = await fsp.readFile(file.full);
  let text = buf.toString('utf8');
  const base = buildDocBase(file, stat);
  let fm = null;
  if (file.ext === '.html' || file.ext === '.htm') text = htmlToText(text);
  else if (file.ext === '.canvas') text = canvasToText(text);
  else if (file.ext === '.json') {
    try { text = JSON.stringify(JSON.parse(text), null, 1); } catch { /* keep raw */ }
  } else if (file.ext === '.md' || file.ext === '.markdown') {
    const r = frontmatterBody(text);
    fm = r.fm;
    text = r.body;
  }
  if (!text.trim()) { stats.empty++; return; }
  text = text.slice(0, cfg.maxTextChars || 400000);
  const name = path.basename(file.full, file.ext);
  const title = (file.ext === '.md' ? titleFrom(text, name) : name).slice(0, 120);
  const hash = sha1(text);
  const prev = stmtGet.get(base.uri);
  if (prev && prev.hash === hash) { stats.unchanged++; seen.add(base.uri); return; }
  if (isDuplicate(db, base.uri, hash, stats)) return;
  upsertDoc(db, {
    ...base,
    kind: file.ext.slice(1),
    title,
    body: text,
    docTime: docTimeFrom(fm, stat.mtimeMs, base.meta.relPath),
    hash,
    ftsTitle: indexText(title, 2000),
    ftsBody: indexText(base.meta.relPath + '\n' + text, cfg.maxTextChars || 400000)
  });
  seen.add(base.uri);
  stats.added++;
}

function runPythonBatch(jobs, stats) {
  const tmpDir = path.join(ROOT, 'data', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const inPath = path.join(tmpDir, 'jobs-' + stamp + '.jsonl');
  const outPath = path.join(tmpDir, 'out-' + stamp + '.jsonl');
  fs.writeFileSync(inPath, jobs.map((j) => JSON.stringify({ i: j.i, path: j.full, ext: j.ext })).join('\n') + '\n', 'utf8');
  const py = cfg.pythonPath || 'python';
  const script = path.join(ROOT, cfg.extractScript || 'tools/extract.py');
  const r = spawnSync(py, [script, inPath, outPath], { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) {
    console.error('[extract] python 退出码', r.status, (r.stderr || '').slice(0, 500));
  }
  if (!fs.existsSync(outPath)) return;
  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const job = jobs.find((j) => j.i === rec.i);
    if (!job) continue;
    if (!rec.ok) { stats.failed++; continue; }
    const text = String(rec.text || '').slice(0, cfg.maxTextChars || 400000);
    if (!text.trim()) { stats.empty++; continue; }
    const name = path.basename(job.full, job.ext);
    const hash = sha1(text);
    const prev = stmtGet.get(job.full);
    if (prev && prev.hash === hash) { stats.unchanged++; seen.add(job.full); continue; }
    if (isDuplicate(db, job.full, hash, stats)) continue;
    upsertDoc(db, {
      ...job.base,
      kind: job.ext.slice(1),
      title: name.slice(0, 120),
      body: text,
      docTime: docTimeFrom(null, job.statMtime, job.base.meta.relPath),
      hash,
      ftsTitle: indexText(name, 2000),
      ftsBody: indexText(job.base.meta.relPath + '\n' + text, cfg.maxTextChars || 400000)
    });
    seen.add(job.full);
    stats.added++;
  }
  try { fs.unlinkSync(inPath); fs.unlinkSync(outPath); } catch { /* ignore */ }
}

async function main() {
  const t0 = Date.now();
  const stats = { added: 0, unchanged: 0, empty: 0, failed: 0, skippedBig: 0, files: 0 };
  console.log('[scan] 数据库:', dbPath);
  for (const root of cfg.roots) {
    if (!fs.existsSync(root.path)) { console.warn('[scan] 跳过不存在的根目录:', root.path); continue; }
    const files = [];
    db.exec('BEGIN');
    await walk(root, files);
    console.log('[scan] ' + (root.label || root.path) + ' 发现 ' + files.length + ' 个候选文件');
    const pyJobs = [];
    let jobIdx = 0;
    for (const file of files) {
      stats.files++;
      let stat;
      try { stat = await fsp.stat(file.full); } catch { continue; }
      if (stat.size > maxBytes) { stats.skippedBig++; continue; }
      // 过小的 json 基本是程序配置，不作为资料入库
      if (file.ext === '.json' && stat.size < (cfg.minJsonBytes || 3000)) { stats.skippedTiny = (stats.skippedTiny || 0) + 1; continue; }
      if (TEXT_EXT.has(file.ext)) {
        try { await processTextFile(file, stat, stats); } catch (err) { stats.failed++; console.warn('[scan] 读失败', file.full, err.message); }
      } else if (PY_EXT.has(file.ext)) {
        if (statUnchanged(file.full, stat)) { stats.unchanged++; seen.add(file.full); continue; }
        jobIdx++;
        pyJobs.push({ i: jobIdx, full: file.full, ext: file.ext, statMtime: stat.mtimeMs, base: buildDocBase(file, stat) });
        if (pyJobs.length >= (cfg.officeBatch || 40)) {
          runPythonBatch(pyJobs.splice(0, pyJobs.length), stats);
          console.log('[scan] 进度 ' + stats.added + ' 新增 / ' + stats.unchanged + ' 未变 / ' + stats.failed + ' 失败');
        }
      }
    }
    if (pyJobs.length) runPythonBatch(pyJobs, stats);
    db.exec('COMMIT');
    console.log('[scan] 根目录完成:', root.label || root.path, JSON.stringify(stats));
  }

  // 清理已删除的文件（仅限本次成功扫描过的根目录）
  let removed = 0;
  const rows = db.prepare('SELECT id, uri FROM documents').all();
  const roots = cfg.roots.map((r) => r.path.toLowerCase());
  const seenLower = new Set([...seen].map((s) => s.toLowerCase()));
  for (const row of rows) {
    const low = row.uri.toLowerCase();
    if (!roots.some((r) => low.startsWith(r))) continue;
    if (!seenLower.has(low)) {
      db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(row.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
      removed++;
    }
  }

  const deduped = dedupeExports(db);
  if (deduped) console.log('[scan] 合并重复导出的副本 ' + deduped + ' 个');

  const total = db.prepare('SELECT count(*) AS n FROM documents').get().n;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[scan] 完成，用时 ' + secs + 's：新增 ' + stats.added + '，未变 ' + stats.unchanged +
    '，空内容 ' + stats.empty + '，失败 ' + stats.failed + '，超大跳过 ' + stats.skippedBig +
    '，清理失效 ' + removed + '，库内共 ' + total + ' 条');
}

main()
  .then(() => console.log('[scan] 全部完成'))
  .catch((err) => {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('[scan] 失败:', err);
    process.exitCode = 1;
  });
