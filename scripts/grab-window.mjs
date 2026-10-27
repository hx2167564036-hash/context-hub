#!/usr/bin/env node
/**
 * grab-window.mjs —— 抓取钉钉/微信（或当前前台）主窗口文本的 CLI 包装
 *
 * 真正干活的是同目录下的 win-grab.ps1（PowerShell 5.1 + UIAutomation / Windows.Media.Ocr），
 * 这个脚本只负责：拼参数 → 调 ps1（结果 JSON 落盘再读，避免管道 stdio）→ 打印/入库。
 *
 * 用法：
 *   node scripts/grab-window.mjs --app dingtalk                # 抓钉钉窗口并 POST 入库
 *   node scripts/grab-window.mjs --app wechat --dry            # 只抓并打印，不入库
 *   node scripts/grab-window.mjs --app dingtalk --method ocr   # 强制 OCR（UIA 拿不到文字时）
 *   node scripts/grab-window.mjs --app foreground --json       # 单行 JSON 输出（含全文）
 *
 * 参数：--app <dingtalk|wechat|foreground>（默认 foreground）
 *       --method <auto|uia|ocr>（默认 auto：UIA ≥200 字用 UIA，否则走 OCR）
 *       --dry        只抓取打印，不 POST 入库
 *       --hub <url>  中枢服务地址，默认 http://127.0.0.1:7311
 *       --token <t>  入库 token，默认读 <repo>/config.json 的 lan.token
 *       --json       输出单行完整 JSON（含 text）；否则先打印文本，最后一行是摘要 JSON
 *       --process <name> 按进程名找窗口（自测/调试用，覆盖 --app 的进程名表）
 *       --max <n>    最多取多少字（默认 20000，透传 ps1 的 -MaxChars）
 *       -h, --help   帮助
 *
 * 退出码：0 抓到（入库失败不影响 0，但 ingested=false）；2 没找到窗口/没取到文本；1 脚本/环境错误。
 * 输出约定：最后一行永远是单行 JSON，字段 ok / ingested / chars / method / reason（+ app/hwnd/title/url/png，--json 时还有 text），
 *          方便 desktop/main.js 之类的调用方只 parse 最后一行。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PS1 = path.join(SCRIPT_DIR, 'win-grab.ps1');
const WORK_DIR = path.join(REPO_ROOT, 'data', 'tmp');
const DEFAULT_HUB = 'http://127.0.0.1:7311';
const DEFAULT_TIMEOUT_MS = 26_000; // 比 desktop/main.js 的 30s 上限略短，保证能在父进程 kill 之前吐出一行 JSON

const APP_VALUES = new Set(['dingtalk', 'wechat', 'foreground']);
const METHOD_VALUES = new Set(['auto', 'uia', 'ocr']);

function usage() {
  const lines = [
    'grab-window.mjs —— 抓当前钉钉/微信窗口文本并（可选）入库',
    '',
    '用法: node scripts/grab-window.mjs --app <dingtalk|wechat|foreground> [选项]',
    '',
    '选项:',
    '  --app <name>        dingtalk | wechat | foreground（默认 foreground）',
    '  --method <m>        auto | uia | ocr（默认 auto）',
    '  --dry               只抓取打印，不入库',
    '  --hub <url>         中枢地址（默认 http://127.0.0.1:7311）',
    '  --token <t>         入库 token（默认 config.json 的 lan.token）',
    '  --json              输出单行完整 JSON（含 text）',
    '  --process <name>    按进程名找窗口（自测/调试）',
    '  --max <n>           最多取多少字（默认 20000）',
    '  -h, --help          显示帮助',
    '',
    '退出码: 0 成功 / 2 没找到窗口或无文本 / 1 错误',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function parseArgs(argv) {
  const opts = {
    app: 'foreground',
    method: 'auto',
    dry: false,
    hub: DEFAULT_HUB,
    token: '',
    json: false,
    processName: '',
    maxChars: 20000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--app': opts.app = need(); break;
      case '--method': opts.method = need(); break;
      case '--dry': opts.dry = true; break;
      case '--hub': opts.hub = need(); break;
      case '--token': opts.token = need(); break;
      case '--json': opts.json = true; break;
      case '--process': opts.processName = need(); break;
      case '--max': opts.maxChars = Number.parseInt(need(), 10); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const [k, ...rest] = a.split('=');
          const v = rest.join('=');
          if (k === '--app') opts.app = v;
          else if (k === '--method') opts.method = v;
          else if (k === '--hub') opts.hub = v;
          else if (k === '--token') opts.token = v;
          else if (k === '--process') opts.processName = v;
          else if (k === '--max') opts.maxChars = Number.parseInt(v, 10);
          else throw new Error(`未知参数 ${a}`);
        } else {
          throw new Error(`未知参数 ${a}`);
        }
    }
  }
  if (!APP_VALUES.has(opts.app)) throw new Error(`--app 只能是 dingtalk/wechat/foreground，收到 ${opts.app}`);
  if (!METHOD_VALUES.has(opts.method)) throw new Error(`--method 只能是 auto/uia/ocr，收到 ${opts.method}`);
  if (!Number.isFinite(opts.maxChars) || opts.maxChars <= 0) throw new Error('--max 必须是正整数');
  return opts;
}

function readConfigToken() {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return (cfg && cfg.lan && cfg.lan.token) || cfg?.token || '';
  } catch {
    return '';
  }
}

function findPowerShell() {
  if (process.env.HUB_POWERSHELL && fs.existsSync(process.env.HUB_POWERSHELL)) return process.env.HUB_POWERSHELL;
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'powershell.exe';
}

/** 调 ps1：结果写到临时 JSON 再读（沙箱/受限环境下不用管道 stdio） */
function runGrabPs1(opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonOut = path.join(WORK_DIR, `grab-${opts.app}-${stamp}.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-STA',
    '-File', PS1,
    '-App', opts.app,
    '-Method', opts.method,
    '-JsonOut', jsonOut,
    '-MaxChars', String(opts.maxChars),
  ];
  if (opts.processName) args.push('-ProcessName', opts.processName);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      // 读结果 JSON 后再删临时文件（失败也删）
      let data = null;
      let readErr = '';
      try {
        data = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      } catch (e) {
        readErr = e?.message || String(e);
      }
      try { fs.rmSync(jsonOut, { force: true }); } catch { /* ignore */ }
      resolve({ ...val, data, readErr });
    };

    let child;
    try {
      child = spawn(findPowerShell(), args, {
        cwd: REPO_ROOT,
        windowsHide: true,
        stdio: 'ignore', // 管道 stdio 在受限沙箱下会 spawn EPERM
      });
    } catch (e) {
      finish({ code: -1, spawnErr: e?.message || String(e) });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ code: -1, spawnErr: `win-grab.ps1 执行超时（>${DEFAULT_TIMEOUT_MS}ms）` });
    }, DEFAULT_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ code: -1, spawnErr: e?.message || String(e) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      finish({ code: typeof code === 'number' ? code : -1, signal });
    });
  });
}

async function postIngest({ hub, token, app, data }) {
  const base = String(hub || DEFAULT_HUB).replace(/\/+$/, '');
  const url = `${base}/api/ingest?t=${encodeURIComponent(token)}`;
  const body = {
    source: app,
    url: `${app}://window/${Date.now()}`,
    data: {
      title: data.title || '',
      text: data.text || '',
      method: data.method || '',
      hwnd: data.hwnd || 0,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, ok: res.ok, payload };
}

function summarize({ opts, grab, ingested, reason }) {
  const data = grab.data || {};
  return {
    ok: Boolean(data.ok),
    ingested: Boolean(ingested),
    chars: Number(data.chars) || 0,
    method: data.method || 'none',
    reason: reason || data.reason || '',
    app: opts.app,
    hwnd: data.hwnd || 0,
    title: data.title || '',
    png: data.png || '',
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`参数错误：${e.message}\n\n`);
    usage();
    process.exit(1);
    return;
  }
  if (opts.help) {
    usage();
    process.exit(0);
    return;
  }
  if (!fs.existsSync(PS1)) {
    process.stderr.write(`找不到 ${PS1}\n`);
    process.exit(1);
    return;
  }

  const token = opts.token || process.env.HUB_INGEST_TOKEN || readConfigToken();
  const grab = await runGrabPs1(opts);

  // 环境/脚本级失败
  if (grab.spawnErr) {
    const summary = { ok: false, ingested: false, chars: 0, method: 'none', reason: `调用 win-grab.ps1 失败：${grab.spawnErr}`, app: opts.app, hwnd: 0, title: '', png: '' };
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.stderr.write(`调用 powershell 失败：${grab.spawnErr}\n`);
    process.exit(1);
    return;
  }
  if (!grab.data) {
    const summary = { ok: false, ingested: false, chars: 0, method: 'none', reason: `win-grab.ps1 没产出结果 JSON（exit=${grab.code}${grab.signal ? ' signal=' + grab.signal : ''}）：${grab.readErr}`, app: opts.app, hwnd: 0, title: '', png: '' };
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.stderr.write(summary.reason + '\n');
    process.exit(1);
    return;
  }

  const data = grab.data;
  const noText = !data.ok || !String(data.text || '').trim();

  // 打印正文（非 --json 时）
  if (!opts.json && !noText) {
    const head = `# ${data.app || opts.app} 窗口「${data.title || '(无标题)'}」 hwnd=${data.hwnd} method=${data.method} chars=${data.chars}`;
    process.stdout.write(head + '\n');
    process.stdout.write('----- 8< -----\n');
    process.stdout.write(String(data.text) + '\n');
    process.stdout.write('----- >8 -----\n');
  }

  let ingested = false;
  let ingestNote = '';
  if (noText) {
    ingestNote = '';
  } else if (opts.dry) {
    ingestNote = 'dry-run 未入库';
  } else if (!token) {
    ingestNote = '未找到 token（config.json 的 lan.token），跳过入库';
  } else {
    try {
      const r = await postIngest({ hub: opts.hub, token, app: opts.app, data });
      ingested = Boolean(r.ok);
      if (!r.ok) ingestNote = `入库失败 HTTP ${r.status}：${JSON.stringify(r.payload)}`;
    } catch (e) {
      ingestNote = `入库失败（服务可能没起）：${e?.message || String(e)}`;
    }
  }

  const summary = summarize({ opts, grab, ingested, reason: ingestNote });
  if (opts.json) {
    const full = { ...summary, text: String(data.text || ''), ingested, ingestNote };
    process.stdout.write(JSON.stringify(full) + '\n');
  } else {
    if (ingestNote) process.stderr.write(ingestNote + '\n');
    process.stdout.write(JSON.stringify(summary) + '\n');
  }

  if (noText) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, ingested: false, chars: 0, method: 'none', reason: `未捕获异常：${e?.message || String(e)}` }) + '\n');
  process.stderr.write(`未捕获异常：${e?.stack || e}\n`);
  process.exit(1);
});
