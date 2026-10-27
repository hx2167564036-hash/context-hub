#!/usr/bin/env node
/**
 * 手机附件回传（Termux 侧，零依赖）
 *
 * 把钉钉 / 微信 / 浏览器下载到手机里的文件，批量 POST 到中枢 /api/upload，
 * 中枢负责落盘 + 抽正文 + 建索引，之后在电脑上就能搜到附件内容。
 *
 * 用法（Termux）：
 *   node phone-attach.mjs --hub http://192.168.0.204:7311 --token <token> --once
 *   node phone-attach.mjs --hub ... --token ... --loop 300        # 每 5 分钟扫一次
 *   node phone-attach.mjs --hub ... --token ... --dry --once      # 只看要传什么
 *   node phone-attach.mjs --dir /sdcard/Download --token ... --once
 *
 * 常用参数：
 *   --hub       中枢地址，默认 http://127.0.0.1:7311（手机要填电脑局域网 IP）
 *   --token     局域网 token（也认环境变量 HUB_TOKEN）
 *   --dir       扫描目录，可重复；默认见 DEFAULT_DIRS
 *   --days      只看最近 N 天改过的文件，默认 14
 *   --max-mb    单文件上限，默认 40
 *   --once      扫一轮退出（默认）
 *   --loop 秒   常驻，每 N 秒扫一轮
 *   --dry       只列出，不上传
 *   --state     已传状态文件，默认 ~/.hub-phone-files.json
 *
 * Android/data 下的目录普通 shell 读不到时，自动退回 Shizuku 的 rish。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRS = [
  '/sdcard/Download',
  '/sdcard/Documents',
  '/sdcard/DingTalk',
  '/sdcard/Android/data/com.alibaba.android.rimet/files',
  '/sdcard/Android/data/com.tencent.mm/Download',
  '/sdcard/Android/data/com.tencent.mm/MicroMsg/Download',
];
const SKIP_EXT = new Set(['.tmp', '.part', '.crdownload', '.opdownload', '.db', '.db-wal', '.db-shm', '.pid', '.nomedia', '.thumbnails']);
const SKIP_DIR = new Set(['.thumbnails', '.trash', 'cache', 'Cache', '.cache', 'tmp', 'Temp']);

function parseArgs(argv) {
  const o = {
    hub: process.env.HUB || 'http://127.0.0.1:7311',
    token: process.env.HUB_TOKEN || '',
    dirs: [],
    days: 14,
    maxMB: 40,
    once: true,
    loop: 0,
    dry: false,
    state: path.join(os.homedir(), '.hub-phone-files.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--hub') o.hub = next();
    else if (a === '--token') o.token = next();
    else if (a === '--dir') o.dirs.push(next());
    else if (a === '--days') o.days = Math.max(1, parseInt(next(), 10) || 14);
    else if (a === '--max-mb') o.maxMB = Math.max(1, parseInt(next(), 10) || 40);
    else if (a === '--once') { o.once = true; o.loop = 0; }
    else if (a === '--loop') { o.loop = Math.max(10, parseInt(next(), 10) || 300); o.once = false; }
    else if (a === '--dry') o.dry = true;
    else if (a === '--state') o.state = next();
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  }
  if (!o.dirs.length) o.dirs = DEFAULT_DIRS;
  o.hub = o.hub.replace(/\/+$/, '');
  return o;
}

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(stamp(), ...a);

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s.sent === 'object') return s;
  } catch { /* 首次运行 */ }
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

function skipName(name) {
  if (name.startsWith('.')) return true;
  if (SKIP_EXT.has(path.extname(name).toLowerCase())) return true;
  return false;
}

/** 直接读文件系统（Termux 能读到的目录） */
function walkFs(dir, opts, out, depth = 0) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (depth === 0) throw e;
    return;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIR.has(ent.name) || skipName(ent.name)) continue;
        walkFs(p, opts, out, depth + 1);
      } else if (ent.isFile()) {
        if (skipName(ent.name)) continue;
        const st = fs.statSync(p);
        if (!st.size || st.size > opts.maxBytes) continue;
        if (st.mtimeMs < opts.since) continue;
        out.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    } catch { /* 单个文件没权限就跳过 */ }
  }
}

/** 通过 rish（Shizuku）列文件：find + stat，返回 [{path,size,mtime}] */
function listViaRish(dir, opts) {
  const cmd = `find '${dir.replace(/'/g, `'\\''`)}' -type f -mtime -${opts.days} 2>/dev/null | while read -r f; do stat -c '%Y|%s|%n' "$f" 2>/dev/null; done`;
  const raw = execFileSync('rish', ['-c', cmd], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  return parseStatLines(raw, opts);
}

function parseStatLines(raw, opts) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.+)$/.exec(line);
    if (!m) continue;
    const mtime = parseInt(m[1], 10) * 1000;
    const size = parseInt(m[2], 10);
    const p = m[3];
    if (!size || size > opts.maxBytes) continue;
    if (mtime < opts.since) continue;
    if (skipName(path.basename(p))) continue;
    out.push({ path: p, size, mtime });
  }
  return out;
}

/** 尽量用文件系统，读不到再用 rish */
function listDir(dir, opts) {
  try {
    const out = [];
    walkFs(dir, opts, out);
    return { via: 'fs', files: out };
  } catch (e) {
    try {
      return { via: 'rish', files: listViaRish(dir, opts) };
    } catch (e2) {
      return { via: 'skip', files: [], err: e2.message };
    }
  }
}

async function upload(file, opts) {
  const buf = fs.readFileSync(file.path);
  const qs = new URLSearchParams({ name: path.basename(file.path), mtime: String(file.mtime) });
  if (opts.token) qs.set('t', opts.token);
  const res = await fetch(`${opts.hub}/api/upload?${qs}`, {
    method: 'POST',
    headers: { 'x-hub-token': opts.token, 'content-type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || !body || !body.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return body;
}

async function scanOnce(opts, state) {
  const opts2 = { days: opts.days, maxBytes: opts.maxMB * 1024 * 1024, since: Date.now() - opts.days * 86400000 };
  let found = 0, sent = 0, skipped = 0, failed = 0;
  for (const dir of opts.dirs) {
    if (!fs.existsSync(dir) && !dir.startsWith('/sdcard') && !dir.startsWith('/storage')) {
      log(`跳过不存在的目录 ${dir}`);
      continue;
    }
    const { via, files, err } = listDir(dir, opts2);
    if (err) { log(`跳过 ${dir}：${err}`); continue; }
    if (!files.length) { log(`${dir} 没有新文件（${via}）`); continue; }
    log(`${dir} 找到 ${files.length} 个候选（${via}）`);
    for (const f of files) {
      found++;
      const key = f.path;
      const old = state.sent[key];
      if (old && old.size === f.size && old.mtime === f.mtime) { skipped++; continue; }
      if (opts.dry) { log(`[dry] ${f.path}  ${(f.size / 1024).toFixed(0)} KB`); continue; }
      try {
        const r = await upload(f, opts);
        state.sent[key] = { size: f.size, mtime: f.mtime, id: r.id, at: Date.now() };
        saveState(opts.state, state);
        sent++;
        if (r.dedupe) log(`[=] ${path.basename(f.path)} 已存在（id=${r.id}）`);
        else log(`[+] ${path.basename(f.path)} ${(f.size / 1024).toFixed(0)} KB → id=${r.id}（${r.textChars || 0} 字）`);
      } catch (e) {
        failed++;
        log(`[!] ${path.basename(f.path)} 上传失败：${e.message}`);
      }
    }
  }
  return { found, sent, skipped, failed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) {
    console.error('缺少 --token（中枢局域网 token，见 config.json 的 lan.token）');
    process.exit(2);
  }
  const state = loadState(opts.state);
  log(`中枢 ${opts.hub} 目录 ${opts.dirs.length} 个 近 ${opts.days} 天 ≤${opts.maxMB}MB${opts.dry ? ' [dry]' : ''}`);
  const run = async () => {
    try {
      const r = await scanOnce(opts, state);
      log(`本轮：候选 ${r.found} 已传 ${r.sent} 跳过 ${r.skipped} 失败 ${r.failed}`);
    } catch (e) {
      log('扫描出错：' + e.message);
    }
  };
  await run();
  if (opts.loop) {
    log(`常驻模式，每 ${opts.loop} 秒扫描一次（Ctrl+C 退出）`);
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
