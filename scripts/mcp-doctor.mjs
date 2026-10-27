#!/usr/bin/env node
// MCP 自检：stdio 进程内协议 + 真实 CLI 子进程 + HTTP 三条链路都走一遍。
// 用法：
//   node scripts/mcp-doctor.mjs                          （HTTP 默认打 7311）
//   node scripts/mcp-doctor.mjs --http=http://127.0.0.1:7312
//   node scripts/mcp-doctor.mjs --skip-http --skip-cli
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, openDb, ROOT } from '../src/db.mjs';
import { makeReader } from '../src/hub-read.mjs';
import { makeMcp } from '../src/mcp-tools.mjs';
import { attachStdio } from '../src/mcp-stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const cfg = loadConfig();
const HTTP = opt('http', 'http://127.0.0.1:7311');
const TOKEN = opt('token', (cfg.lan && cfg.lan.token) || '');
const skipStdio = args.includes('--skip-stdio');
const skipCli = args.includes('--skip-cli');
const skipHttp = args.includes('--skip-http');
const Q = opt('q', '微积分');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  ' + detail : ''));
}

const JSONRPC_HEAD = { jsonrpc: '2.0' };

// ---------- 1. stdio 协议（进程内，同一份 attachStdio） ----------
async function testStdio() {
  console.log('\n[stdio] 进程内协议链路');
  const { db, dbPath } = openDb(cfg);
  const reader = makeReader({ db, dbPath, cfg });
  const mcp = makeMcp({ db, cfg, reader });
  const input = new PassThrough();
  const output = new PassThrough();
  attachStdio({ mcp, input, output, log: () => {} });

  let nextId = 1;
  const waiting = new Map();
  let buf = '';
  output.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    input.write(JSON.stringify({ ...JSONRPC_HEAD, id, method, params }) + '\n');
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
  });
  const notify = (method, params) => input.write(JSON.stringify({ ...JSONRPC_HEAD, method, params }) + '\n');

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '0' } });
  check('initialize', !!init && init.serverInfo.name === 'context-hub', init.serverInfo.name + ' / ' + init.protocolVersion);
  notify('notifications/initialized', {});
  const tl = await rpc('tools/list', {});
  const tools = (tl.tools || []).map((t) => t.name);
  check('tools/list', tools.length >= 7, tools.join(','));
  const sr = await rpc('tools/call', { name: 'search_context', arguments: { q: Q, limit: 3 } });
  const payload = JSON.parse(sr.content[0].text);
  check('search_context', !sr.isError && Array.isArray(payload.hits), 'total=' + payload.total + ' 命中=' + payload.hits.length + ' 首个=' + (payload.hits[0] && payload.hits[0].title || '无'));
  check('search_context 体积', sr.content[0].text.length < 12000, sr.content[0].text.length + ' 字节');
  const first = payload.hits[0];
  if (first) {
    const gd = await rpc('tools/call', { name: 'get_document', arguments: { id: first.id, maxChars: 600 } });
    const doc = JSON.parse(gd.content[0].text);
    check('get_document', !gd.isError && doc.id === first.id && typeof doc.body === 'string', 'chars=' + doc.bodyChars + ' 截断=' + doc.truncated);
  } else {
    check('get_document', false, '检索无命中');
  }
  const rg = await rpc('tools/call', { name: 'recent_digest', arguments: { days: 7, limit: 5 } });
  const dig = JSON.parse(rg.content[0].text);
  check('recent_digest', !rg.isError && Array.isArray(dig.groups), 'total=' + dig.total + ' 返回=' + dig.returned);
  const lt = await rpc('tools/call', { name: 'list_tasks', arguments: { days: 14 } });
  const tasks = JSON.parse(lt.content[0].text);
  check('list_tasks', !lt.isError && Array.isArray(tasks.items), 'count=' + tasks.count);
  const st = await rpc('tools/call', { name: 'hub_stats', arguments: {} });
  const ss = JSON.parse(st.content[0].text);
  check('hub_stats', !st.isError && ss.total > 0, ss.total + ' 条 / ' + ss.mb + 'MB');
  const tb = await rpc('tools/call', { name: 'today_brief', arguments: {} });
  const brief = JSON.parse(tb.content[0].text);
  check('today_brief', !tb.isError && Array.isArray(brief.due), 'due=' + brief.due.length + ' week=' + brief.week.length);
  const bad = await rpc('tools/call', { name: 'search_context', arguments: {} });
  check('空参数 → isError', bad.isError === true, (bad.content[0].text || '').slice(0, 40));
  const unk = await rpc('tools/call', { name: 'nope', arguments: {} });
  check('未知工具 → isError', unk.isError === true, (unk.content[0].text || '').slice(0, 30));
  let protoErr = null;
  try { await rpc('bogus/method', {}); } catch (e) { protoErr = e; }
  check('未知方法 → -32601', !!protoErr, protoErr && protoErr.message);
  let frag = null;
  try { await rpc('ping', {}).then((r) => { frag = r; }); } catch (e) { frag = e.message; }
  check('ping', frag && typeof frag === 'object', JSON.stringify(frag));
  // Content-Length 分帧兼容
  const clId = nextId++;
  const clBody = JSON.stringify({ ...JSONRPC_HEAD, id: clId, method: 'ping' });
  const clMsg = 'Content-Length: ' + Buffer.byteLength(clBody) + '\r\n\r\n' + clBody;
  const clP = new Promise((resolve, reject) => { waiting.set(clId, { resolve, reject }); setTimeout(() => reject(new Error('Content-Length 超时')), 5000); });
  input.write(clMsg);
  let clRes = null;
  try { clRes = await clP; } catch (e) { clRes = e.message; }
  check('Content-Length 分帧', clRes && typeof clRes === 'object', JSON.stringify(clRes));
  db.close();
}

// ---------- 2. 真实 CLI 子进程（文件重定向，绕开沙箱管道限制） ----------
async function testCli() {
  console.log('\n[cli] node scripts/mcp-server.mjs（文件重定向）');
  if (process.platform !== 'win32') { check('CLI 链路', true, '非 Windows 跳过'); return; }
  const tmp = path.join(ROOT, 'data', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const req = path.join(tmp, 'mcp-cli-req.jsonl');
  const resp = path.join(tmp, 'mcp-cli-resp.jsonl');
  const errf = path.join(tmp, 'mcp-cli-err.log');
  const reqs = [
    { ...JSONRPC_HEAD, id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '0' } } },
    { ...JSONRPC_HEAD, id: 2, method: 'tools/list', params: {} },
    { ...JSONRPC_HEAD, id: 3, method: 'tools/call', params: { name: 'search_context', arguments: { q: Q, limit: 2 } } }
  ];
  fs.writeFileSync(req, reqs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  // 用 .cmd 包装再执行：spawnSync 直接传带引号的长命令行会被 Node 二次转义，cmd 解析不了
  const runner = path.join(tmp, 'mcp-cli-run.cmd');
  fs.writeFileSync(runner, [
    '@echo off',
    'chcp 65001 >nul',
    'node "' + path.join(HERE, 'mcp-server.mjs') + '" < "' + req + '" > "' + resp + '" 2> "' + errf + '"',
    'exit /b %ERRORLEVEL%'
  ].join('\r\n'), 'utf8');
  const r = spawnSync('cmd.exe', ['/c', runner], { cwd: ROOT, stdio: 'ignore', timeout: 90000 });
  let lines = [];
  try { lines = fs.readFileSync(resp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* ignore */ }
  check('子进程退出码', r.status === 0, 'status=' + r.status);
  check('三条回包', lines.length === 3, lines.length + ' 条');
  const init = lines.find((l) => l.id === 1);
  check('initialize', !!(init && init.result && init.result.serverInfo.name === 'context-hub'), init && init.result.protocolVersion);
  const call = lines.find((l) => l.id === 3);
  const okCall = !!(call && call.result && call.result.content && !call.result.isError);
  check('tools/call', okCall, okCall ? call.result.content[0].text.length + 'B' : '失败');
  const stderr = (() => { try { return fs.readFileSync(errf, 'utf8'); } catch { return ''; } })();
  check('日志只走 stderr', stderr.includes('[mcp] 已启动'), stderr.split('\n')[0].slice(0, 60));
}

// ---------- 3. HTTP（POST /mcp） ----------
async function rpcHttp(body) {
  const res = await fetch(HTTP + '/mcp' + (TOKEN ? '?t=' + encodeURIComponent(TOKEN) : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 可能是 SSE 帧 */ }
  return { status: res.status, headers: res.headers, data, text };
}

async function testHttp() {
  console.log('\n[http] ' + HTTP + '/mcp');
  try {
    const init = await rpcHttp({ ...JSONRPC_HEAD, id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '0' } } });
    check('initialize', init.status === 200 && !!(init.data && init.data.result && init.data.result.serverInfo.name === 'context-hub'),
      'status=' + init.status + ' session=' + (init.headers.get('mcp-session-id') || '-') + ' proto=' + (init.data && init.data.result && init.data.result.protocolVersion));
    const tl = await rpcHttp({ ...JSONRPC_HEAD, id: 2, method: 'tools/list', params: {} });
    const names = ((tl.data && tl.data.result && tl.data.result.tools) || []).map((t) => t.name);
    check('tools/list', names.length >= 7, names.join(','));
    const sr = await rpcHttp({ ...JSONRPC_HEAD, id: 3, method: 'tools/call', params: { name: 'search_context', arguments: { q: Q, limit: 2 } } });
    const srp = sr.data && sr.data.result;
    check('tools/call', !!(srp && srp.content && !srp.isError), 'status=' + sr.status + ' ' + sr.text.length + 'B');
    const notif = await rpcHttp({ ...JSONRPC_HEAD, method: 'notifications/initialized', params: {} });
    check('通知 → 202', notif.status === 202, 'status=' + notif.status);
    const badJson = await fetch(HTTP + '/mcp' + (TOKEN ? '?t=' + encodeURIComponent(TOKEN) : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
    });
    const badBody = await badJson.text();
    check('坏 JSON → -32700', badJson.status === 400 && badBody.includes('-32700'), 'status=' + badJson.status);
    const batch = await rpcHttp([{ ...JSONRPC_HEAD, id: 4, method: 'ping' }, { ...JSONRPC_HEAD, id: 5, method: 'tools/list' }]);
    check('批量请求', Array.isArray(batch.data) && batch.data.length === 2, 'status=' + batch.status);
    const get = await fetch(HTTP + '/mcp', { method: 'GET' });
    check('GET → 405', get.status === 405, 'status=' + get.status);
  } catch (e) {
    check('HTTP 链路', false, e.message);
  }
}

// ---------- 4. 附件回传（POST /api/upload）+ 手机侧脚本纯函数 ----------
async function testUpload() {
  if (skipHttp) { console.log('\n[upload] 跳过（--skip-http）'); return; }
  console.log('\n[upload] ' + HTTP + '/api/upload');
  const q = (extra) => {
    const p = new URLSearchParams(extra);
    if (TOKEN) p.set('t', TOKEN);
    return p.toString();
  };
  const nonce = Date.now().toString(36);
  const body = Buffer.from(`手机附件回传自检 ${nonce}\n\n关键词：附件 回传 自检 doctor。\n`, 'utf8');
  const fname = '手机测试-doctor-' + nonce + '.txt';
  const head = { 'Content-Type': 'application/octet-stream', 'x-hub-token': TOKEN };
  try {
    const up = await fetch(HTTP + '/api/upload?' + q({ name: fname, mtime: String(Date.now()) }), {
      method: 'POST', headers: head, body, signal: AbortSignal.timeout(60000)
    });
    const b = await up.json().catch(() => null);
    check('上传 → 入库', up.status === 200 && !!b && b.ok === true && b.textChars > 0,
      'status=' + up.status + ' id=' + (b && b.id) + ' 正文 ' + (b && b.textChars) + ' 字');

    const up2 = await fetch(HTTP + '/api/upload?' + q({ name: fname, mtime: String(Date.now()) }), {
      method: 'POST', headers: head, body, signal: AbortSignal.timeout(60000)
    });
    const b2 = await up2.json().catch(() => null);
    const sameId = !!(b2 && b2.id && b && b2.id === b.id);
    check('重复上传 → 哈希去重', up2.status === 200 && !!b2 && b2.ok === true && sameId && b2.changed === false,
      'id=' + (b2 && b2.id) + ' changed=' + (b2 && b2.changed) + ' dedupe=' + (b2 && b2.dedupe));

    const sr = await fetch(HTTP + '/api/search?' + q({ q: '附件回传自检', limit: '5' }), { signal: AbortSignal.timeout(30000) });
    const sb = await sr.json().catch(() => null);
    const hit = !!(sb && (sb.hits || []).some((h) => h.id === (b && b.id)));
    check('检索到附件正文', hit, 'total=' + (sb && sb.total));

    const empty = await fetch(HTTP + '/api/upload?' + q({}), { method: 'POST', headers: head, body: Buffer.alloc(0), signal: AbortSignal.timeout(30000) });
    check('空 body → 400', empty.status === 400, 'status=' + empty.status);
  } catch (e) {
    check('上传链路', false, e.message);
  }
}

/** 手机侧脚本的纯函数（不碰手机、不联网） */
async function testPhoneScripts() {
  console.log('\n[phone] phone-attach / adb-pull 纯函数');
  try {
    const phone = await import('./phone-attach.mjs');
    const adb = await import('./adb-pull.mjs');
    const opts = { days: 14, maxBytes: 40 * 1024 * 1024, since: Date.now() - 86400000 };
    // phone-attach 用 `stat -c '%Y|%s|%n'`（mtime|size|path）
    const phoneSample = '1793076213|101|/sdcard/Download/笔记.txt\n1793076213|0|/sdcard/Download/空.txt\n1793076213|999|/sdcard/Download/.hidden.txt\n1793076213|999|/sdcard/Download/半截.tmp\nbad line';
    const pa = phone.parseStatLines(phoneSample, opts);
    check('phone-attach 解析', pa.length === 1 && pa[0].path.endsWith('笔记.txt') && pa[0].size === 101, '有效 ' + pa.length + ' 条');
    // adb-pull 用 `stat -c '%s|%Y|%n'`（size|mtime|path）
    const adbSample = '101|1793076213|/sdcard/Download/笔记.txt\n0|1793076213|/sdcard/Download/空.txt\n999|1793076213|/sdcard/Download/.hidden.txt\n999|1793076213|/sdcard/Download/半截.tmp\nbad line';
    const ab = adb.parseStatLines(adbSample);
    check('adb-pull 解析', ab.length === 4 && ab[0].size === 101 && ab[0].mtime > 0, '有效 ' + ab.length + ' 条');
    check('跳过临时/隐藏', phone.skipName('.hidden') && phone.skipName('a.tmp') && !phone.skipName('报告.pdf'), 'ok');
  } catch (e) {
    check('手机脚本', false, e.message);
  }
}

(async () => {
  console.log('MCP 自检 | ' + path.join(ROOT, 'data', 'context.db') + ' | 关键词「' + Q + '」');
  try {
    if (!skipStdio) await testStdio();
    if (!skipCli) await testCli();
    if (!skipHttp) await testHttp();
    await testUpload();
    await testPhoneScripts();
  } catch (e) {
    check('自检中断', false, e.message);
  }
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (!skipHttp) console.log('提示：自检会在库里留一条「手机测试-doctor-*」附件，清理用 node scripts/clean-test.mjs');
  process.exit(fail ? 1 : 0);
})();
