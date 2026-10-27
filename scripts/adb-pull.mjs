#!/usr/bin/env node
/**
 * PC 侧手机附件拉取（adb 无线调试，无需在手机装 Termux）
 *
 * 用 adb 从手机「下载 / 钉钉 / 微信」目录里挑最近的文件拉回电脑，
 * 落盘到 data/files/phone/<日期>/，抽正文后进中枢索引 —— 等价于手机端上传，
 * 适合手机不方便常驻 Termux 的情况。
 *
 * 用法：
 *   node scripts/adb-pull.mjs --once                 # 扫一轮
 *   node scripts/adb-pull.mjs --loop 600             # 每 10 分钟
 *   node scripts/adb-pull.mjs --dry --once           # 只看会拉什么
 *   node scripts/adb-pull.mjs --serial 192.168.0.5:5555 --dir /sdcard/Download --once
 *   node scripts/adb-pull.mjs --self-test            # 不碰手机，验证入库链路
 *
 * 参数：--serial / --dir（可重复）/ --days 14 / --max-mb 40 / --state / --dry / --once / --loop 秒
 * 前置：手机开「无线调试」并与电脑配对（同 adb-notify.mjs，tools/platform-tools/adb.exe）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, openDb } from '../src/db.mjs';
import { saveBytes, ingestFile } from '../src/ingest-file.mjs';

const ADB = process.env.ADB || path.join(ROOT, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const DEFAULT_DIRS = [
  '/sdcard/Download',
  '/sdcard/Documents',
  '/sdcard/DingTalk',
  '/sdcard/Android/data/com.alibaba.android.rimet/files',
  '/sdcard/Android/data/com.alibaba.android.rimet/files/download',
  '/sdcard/Android/data/com.tencent.mm/Download',
];
const SKIP_EXT = new Set(['.tmp', '.part', '.crdownload', '.opdownload', '.db', '.db-wal', '.db-shm', '.pid', '.nomedia']);
const MAX_FILES_PER_DIR = 400;

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(stamp(), ...a);

function parseArgs(argv) {
  const o = {
    dirs: [],
    days: 14,
    maxMB: 40,
    once: true,
    loop: 0,
    dry: false,
    serial: process.env.ANDROID_SERIAL || '',
    state: path.join(ROOT, 'data', 'adb-pull-state.json'),
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dir') o.dirs.push(next());
    else if (a === '--days') o.days = Math.max(1, parseInt(next(), 10) || 14);
    else if (a === '--max-mb') o.maxMB = Math.max(1, parseInt(next(), 10) || 40);
    else if (a === '--serial') o.serial = next();
    else if (a === '--state') o.state = next();
    else if (a === '--once') { o.once = true; o.loop = 0; }
    else if (a === '--loop') { o.loop = Math.max(30, parseInt(next(), 10) || 600); o.once = false; }
    else if (a === '--dry') o.dry = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  }
  if (!o.dirs.length) o.dirs = DEFAULT_DIRS;
  return o;
}

function adb(args, { timeout = 30000, encoding = 'utf8', maxBuffer = 32 * 1024 * 1024 } = {}) {
  return execFileSync(ADB, args, { encoding, timeout, maxBuffer, windowsHide: true });
}

function pickDevice() {
  let out = '';
  try { out = adb(['devices']); } catch { return ''; }
  const lines = out.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\tdevice$/.exec(line.trim());
    if (m) return m[1];
  }
  return '';
}

function ensureDevice(serial) {
  if (serial) return serial;
  let s = pickDevice();
  if (s) return s;
  // 没连上时试一次无线调试自动发现（_adb-tls-connect._tcp）
  try {
    const mdns = adb(['mdns', 'services']);
    const m = /_adb-tls-connect\._tcp\s+(\S+):(\d+)/.exec(mdns);
    if (m) {
      log(`发现无线调试设备 ${m[1]}:${m[2]}，正在连接…`);
      adb(['connect', `${m[1]}:${m[2]}`], { timeout: 20000 });
      s = pickDevice();
      if (s) return s;
    }
  } catch { /* 忽略 */ }
  return '';
}

function skipName(name) {
  if (name.startsWith('.')) return true;
  return SKIP_EXT.has(path.extname(name).toLowerCase());
}

/** 解析 `stat -c '%s|%Y|%n'` 的输出 */
function parseStatLines(raw) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.+)$/.exec(line.trim());
    if (m) out.push({ size: parseInt(m[1], 10), mtime: parseInt(m[2], 10) * 1000, path: m[3] });
  }
  return out;
}

function listRemote(serial, dir, days) {
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
  let raw;
  try {
    raw = adb(['-s', serial, 'shell', `find ${quoted} -type f -mtime -${days} 2>/dev/null`], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { files: [], err: e.message };
  }
  const paths = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((p) => !skipName(path.basename(p)));
  return { files: paths.slice(0, MAX_FILES_PER_DIR), truncated: paths.length > MAX_FILES_PER_DIR };
}

function statRemote(serial, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 25) {
    const batch = paths.slice(i, i + 25);
    const quoted = batch.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
    let raw = '';
    try {
      raw = adb(['-s', serial, 'shell', `stat -c '%s|%Y|%n' ${quoted} 2>/dev/null`], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    } catch { continue; }
    for (const rec of parseStatLines(raw)) out.set(rec.path, rec);
  }
  return out;
}

/** adb exec-out 取原始字节 */
function catRemote(serial, remotePath, maxBytes) {
  const buf = adb(['-s', serial, 'exec-out', `cat '${remotePath.replace(/'/g, `'\\''`)}'`], {
    encoding: 'buffer',
    timeout: 180000,
    maxBuffer: maxBytes + 2 * 1024 * 1024,
  });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s.sent === 'object') return s;
  } catch { /* 首次 */ }
  return { sent: {} };
}

function saveState(file, st) {
  const keys = Object.keys(st.sent);
  if (keys.length > 3000) {
    keys.sort((a, b) => (st.sent[a].at || 0) - (st.sent[b].at || 0));
    for (const k of keys.slice(0, keys.length - 3000)) delete st.sent[k];
  }
  try { fs.writeFileSync(file, JSON.stringify(st, null, 0), 'utf8'); } catch (e) { log('状态写入失败：' + e.message); }
}

/** 把拉到内存的字节落盘 + 入库 + 建索引 */
async function ingestPulled(db, cfg, buf, remotePath, mtimeMs) {
  const name = path.basename(remotePath);
  const saved = await saveBytes(buf, name, { sub: 'phone' });
  const r = await ingestFile({
    db, cfg,
    filePath: saved,
    data: buf,
    source: 'phone',
    label: '手机附件',
    origName: name,
    fileMtime: mtimeMs,
  });
  return { ...r, saved };
}

async function syncOnce(opts, db, cfg, state, serial, maxBytes) {
  let found = 0, pulled = 0, skipped = 0, failed = 0;
  for (const dir of opts.dirs) {
    const { files, err, truncated } = listRemote(serial, dir, opts.days);
    if (err) { log(`跳过 ${dir}：${err.split('\n')[0]}`); continue; }
    if (!files.length) { log(`${dir} 没有最近文件`); continue; }
    log(`${dir} 候选 ${files.length} 个${truncated ? `（已截断到 ${MAX_FILES_PER_DIR}）` : ''}`);
    const stats = statRemote(serial, files);
    for (const p of files) {
      const st = stats.get(p);
      if (!st) continue;
      found++;
      if (!st.size || st.size > maxBytes) { skipped++; continue; }
      const old = state.sent[p];
      if (old && old.size === st.size && old.mtime === st.mtime) { skipped++; continue; }
      if (opts.dry) { log(`[dry] ${p}  ${(st.size / 1024).toFixed(0)} KB`); continue; }
      try {
        const buf = catRemote(serial, p, maxBytes);
        if (!buf.length) { skipped++; continue; }
        const r = await ingestPulled(db, cfg, buf, p, st.mtime);
        state.sent[p] = { size: st.size, mtime: st.mtime, id: r.id, at: Date.now() };
        saveState(opts.state, state);
        pulled++;
        log(`[+] ${path.basename(p)} ${(st.size / 1024).toFixed(0)} KB → id=${r.id}（${r.textChars || 0} 字）`);
      } catch (e) {
        failed++;
        log(`[!] ${path.basename(p)} 拉取失败：${e.message.split('\n')[0]}`);
      }
    }
  }
  return { found, pulled, skipped, failed };
}

/** 不碰手机，验证「落盘 → 抽取 → 入库 → 检索」链路 */
async function selfTest(db, cfg) {
  const text = '手机附件回传自测\n\n这是 adb-pull 自测文件，用来验证落盘与索引。\n关键词：adb 拉取 附件 自测。\n';
  const fake = Buffer.from(text, 'utf8');
  const name = '手机测试-adb-pull.txt';
  const r = await ingestPulled(db, cfg, fake, '/sdcard/Download/' + name, Date.now());
  const hit = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(r.id);
  const fts = db.prepare("SELECT count(*) n FROM docs_fts WHERE docs_fts MATCH ?").get('"附件" AND "自测"');
  log(`自测入库 id=${r.id} title=${r.title} kind=${r.kind} 正文 ${r.textChars} 字 落盘 ${r.saved}`);
  log(`回读 ${hit ? 'OK' : '失败'}；FTS 命中 ${fts.n} 条`);
  log(`清理：node scripts/clean-test.mjs`);
  return hit && fts.n > 0 ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const { db } = openDb(cfg);
  if (opts.selfTest) return process.exit(await selfTest(db, cfg));

  const maxBytes = opts.maxMB * 1024 * 1024;
  const serial = ensureDevice(opts.serial);
  if (!serial) {
    console.error('没有可用的 adb 设备。请先在手机开「无线调试」并配对，或设置 ANDROID_SERIAL / --serial。');
    console.error('提示：adb 路径 ' + ADB);
    process.exit(2);
  }
  log(`设备 ${serial}｜目录 ${opts.dirs.length} 个｜近 ${opts.days} 天｜≤${opts.maxMB}MB${opts.dry ? ' [dry]' : ''}`);
  const state = loadState(opts.state);
  const run = async () => {
    try {
      const r = await syncOnce(opts, db, cfg, state, serial, maxBytes);
      log(`本轮：候选 ${r.found} 拉取 ${r.pulled} 跳过 ${r.skipped} 失败 ${r.failed}`);
    } catch (e) {
      log('扫描出错：' + e.message.split('\n')[0]);
    }
  };
  await run();
  if (opts.loop) {
    log(`常驻模式，每 ${opts.loop} 秒一次（Ctrl+C 退出）`);
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      await run();
      busy = false;
    }, opts.loop * 1000);
  }
}

export { parseStatLines, skipName };

function isMain() {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().catch((e) => { console.error(stamp(), 'fatal:', e.message); process.exit(1); });
