// 单文件入库：手机上传（/api/upload）与 PC 侧 adb 拉取共用。
// 落盘到 data/files/<来源>/<日期>/，抽正文（docx/pptx/xlsx/pdf 走 tools/extract.py），写 documents + docs_fts。
// 扫描目录的批量逻辑仍在 src/scan.mjs，这里只处理「单个外部文件」。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, upsertDoc } from './db.mjs';
import { indexText } from './tokenize.mjs';

export const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.csv', '.json', '.canvas', '.srt', '.vtt', '.log', '.mjs', '.js', '.py']);
export const PY_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tif', '.tiff']);
export const PHONE_DIR = path.join(ROOT, 'data', 'files', 'phone');

const WIN_BAD = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 只留文件名，去掉路径与非法字符，保留后缀 */
export function safeName(name, fallback = 'attachment.bin') {
  let base = String(name || '').split(/[\\/]/).pop().trim();
  base = base.replace(WIN_BAD, '_').replace(/\s+/g, ' ').replace(/^\.+/, '');
  if (!base) base = fallback;
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** 同目录重名时加 -1、-2 … */
export function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) && i < 999; i++) p = path.join(dir, stem + '-' + i + ext);
  return p;
}

function dayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 把内存里的字节落盘，返回绝对路径 */
export async function saveBytes(buf, name, { sub = 'phone', dir } = {}) {
  const baseDir = dir || path.join(ROOT, 'data', 'files', sub);
  const dayDir = path.join(baseDir, dayStamp());
  await fsp.mkdir(dayDir, { recursive: true });
  const target = uniquePath(dayDir, safeName(name));
  await fsp.writeFile(target, buf);
  return target;
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** docx/pptx/xlsx/pdf 抽正文：写 jobs jsonl → python tools/extract.py → 读 out jsonl */
export function extractWithPython(filePath, cfg, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const script = path.isAbsolute(cfg.extractScript || '') ? cfg.extractScript : path.join(ROOT, cfg.extractScript || 'tools/extract.py');
    const tmp = path.join(ROOT, 'data', 'tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* ignore */ }
    const tag = crypto.randomBytes(4).toString('hex');
    const jobs = path.join(tmp, 'one-' + tag + '.jobs.jsonl');
    const out = path.join(tmp, 'one-' + tag + '.out.jsonl');
    const errf = path.join(tmp, 'one-' + tag + '.err.log');
    fs.writeFileSync(jobs, JSON.stringify({ i: 0, path: filePath, ext: path.extname(filePath).toLowerCase() }) + '\n', 'utf8');
    const py = cfg.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
    let done = false;
    let errFd = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { if (errFd !== null) fs.closeSync(errFd); } catch { /* ignore */ }
      for (const f of [jobs, out, errf]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      resolve(r);
    };
    // 沙箱里子进程的 stdio 管道会 EPERM，这里把 stderr 重定向到普通文件描述符
    let child;
    try {
      errFd = fs.openSync(errf, 'w');
      child = spawn(py, [script, jobs, out], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', errFd] });
    } catch (e) {
      finish({ ok: false, text: '', err: 'python 启动失败：' + e.message });
      return;
    }
    const readErr = () => { try { return fs.readFileSync(errf, 'utf8').slice(-300); } catch { return ''; } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, text: '', err: '抽取超时（' + timeoutMs + 'ms）' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, text: '', err: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let rec = null;
      try {
        const line = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).pop();
        if (line) rec = JSON.parse(line);
      } catch { /* ignore */ }
      if (!rec) {
        const e = readErr();
        return finish({ ok: false, text: '', err: 'python 退出码 ' + code + (e ? '：' + e : '') });
      }
      finish({ ok: !!rec.ok, text: rec.ok ? String(rec.text || '') : '', err: rec.err || (rec.ok ? '' : '抽取失败') });
    });
  });
}

/** 按后缀抽正文；抽不出就返回空串，由调用方写占位说明 */
export async function extractText(filePath, ext, cfg, buf) {
  const max = Math.max(1000, Number(cfg.maxTextChars) || 400000);
  if (TEXT_EXT.has(ext)) {
    const raw = (buf || await fsp.readFile(filePath)).toString('utf8');
    if (ext === '.html' || ext === '.htm') return { text: htmlToText(raw).slice(0, max), err: '' };
    if (ext === '.canvas') {
      try {
        const j = JSON.parse(raw);
        const out = [];
        for (const n of j.nodes || []) for (const k of ['text', 'file', 'url', 'label']) if (n[k]) out.push(String(n[k]));
        for (const e of j.edges || []) if (e.label) out.push(String(e.label));
        return { text: out.join('\n').slice(0, max), err: '' };
      } catch { return { text: raw.slice(0, max), err: '' }; }
    }
    return { text: raw.slice(0, max), err: '' };
  }
  if (PY_EXT.has(ext)) return extractWithPython(filePath, cfg);
  if (IMAGE_EXT.has(ext)) return { text: '', err: 'image' };
  return { text: '', err: 'unsupported' };
}

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

/** 统一把毫秒数 / 数字串 / ISO 串转成 ISO；无法解析返回 '' */
export function toIso(t) {
  if (t === undefined || t === null || t === '') return '';
  if (typeof t === 'number' || typeof t === 'bigint') return new Date(Number(t)).toISOString();
  const s = String(t).trim();
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString();
  const d = Date.parse(s);
  return Number.isNaN(d) ? '' : new Date(d).toISOString();
}

/**
 * 入库一份文件。
 * @param {object} p
 * @param {import('node:sqlite').DatabaseSync} p.db
 * @param {object} p.cfg
 * @param {string} p.filePath 已落盘的文件绝对路径
 * @param {Buffer} [p.data] 已有字节时直接给，省一次读盘（上限内）
 * @param {string} [p.source] documents.source，默认 phone
 * @param {string} [p.label] 展示用标签，默认 手机附件
 * @param {string} [p.origName] 原始文件名（手机上的名字）
 * @param {string|number} [p.fileMtime] 原始修改时间：毫秒数、数字串或 ISO
 */
export async function ingestFile({ db, cfg, filePath, data, source = 'phone', label = '手机附件', origName, fileMtime }) {
  const st = await fsp.stat(filePath).catch(() => null);
  const name = origName || path.basename(filePath);
  const ext = (path.extname(name) || path.extname(filePath)).toLowerCase();
  const size = st ? st.size : (data ? data.length : 0);
  const mtime = toIso(fileMtime) || (st ? new Date(st.mtimeMs).toISOString() : new Date().toISOString());
  const kind = IMAGE_EXT.has(ext) ? 'image' : (ext ? ext.slice(1) : 'file');

  let bytes = data;
  if (!bytes && size <= 64 * 1024 * 1024) bytes = await fsp.readFile(filePath);
  const hash = bytes ? sha1(bytes) : sha1(String(size) + ':' + mtime + ':' + filePath);

  const ex = await extractText(filePath, ext, cfg, bytes);
  const info = ['[附件] ' + name, '类型：' + (ext || '未知'), '大小：' + fmtSize(size)];
  if (origName && origName !== path.basename(filePath)) info.push('原始名称：' + origName);
  info.push('入库：' + mtime + '（' + label + '）');
  if (ex.err && ex.err !== 'image') info.push('未能抽正文：' + ex.err);

  let title = name.replace(/\.[^.]+$/, '');
  let body = ex.text || '';
  if (ex.text) {
    const md = /^#{1,3}\s+(.+)$/m.exec(ex.text.slice(0, 1000));
    if (md) title = md[1].trim().slice(0, 120);
  }
  if (!body) body = info.join('\n');
  else body = info.join('\n') + '\n\n' + body;
  body = body.slice(0, Math.max(1000, Number(cfg.maxTextChars) || 400000));

  const rel = path.relative(ROOT, filePath);
  const meta = {
    label,
    origName: name,
    sizeText: fmtSize(size),
    via: source === 'phone' ? 'upload' : source,
    localPath: rel,
    ...(IMAGE_EXT.has(ext) ? { image: true } : {})
  };
  const docTime = Number.isNaN(Date.parse(mtime)) ? new Date().toISOString() : new Date(mtime).toISOString();

  const r = upsertDoc(db, {
    source, kind, uri: filePath, title, body,
    ext: ext.replace(/^\./, '') || kind, size, mtime: docTime, docTime, hash, meta,
    ftsTitle: indexText(title, 2000), ftsBody: indexText(body, cfg.maxTextChars || 400000)
  });
  return { id: r.id, changed: r.changed, title, kind, source, textChars: ex.text.length, extractErr: ex.err || '', saved: rel, sizeText: fmtSize(size) };
}
