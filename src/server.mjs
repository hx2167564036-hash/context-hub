// 本地检索服务：node src/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { openDb, loadConfig, ROOT, upsertDoc } from './db.mjs';
import { ftsQuery, snippet, indexText, tokenize } from './tokenize.mjs';
import { parseTronClass } from './tronclass.mjs';
import { makeReader } from './hub-read.mjs';
import { makeMcp } from './mcp-tools.mjs';
import { saveBytes, ingestFile } from './ingest-file.mjs';
import { classifyNotification } from './notify-filter.mjs';

let cfg = loadConfig();
const { db, dbPath } = openDb(cfg);
// 只读查询（检索/时间线/到期/今日/统计）抽到 hub-read.mjs，MCP 复用同一套逻辑
const reader = makeReader({ db, dbPath, cfg });
const { search, timeline, due, brief, stats, reminders, actions } = reader;
// MCP 工具（stdio 服务用同一份实现，见 scripts/mcp-server.mjs）
const mcp = makeMcp({ db, cfg, reader });
const PORT = Number(process.env.PORT || cfg.port || 7311);
const LAN = !!(cfg.lan && cfg.lan.enabled);
const HUB_TOKEN = (cfg.lan && cfg.lan.token) || '';
const HOST = LAN ? '0.0.0.0' : (cfg.host || '127.0.0.1');

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function tokenOk(req, url) {
  if (!HUB_TOKEN) return true;
  const t = url.searchParams.get('t') || req.headers['x-hub-token'] || '';
  return String(t) === HUB_TOKEN;
}
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------- 推送设置与晨报 ----------

function briefText(b) {
  const L = [];
  const d = new Date();
  L.push('【' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 天枢】');
  if (b.due.length) {
    L.push('今天有 ' + b.due.length + ' 项要交：');
    for (const it of b.due.slice(0, 8)) {
      const h = it.hoursLeft;
      const when = h < 0 ? '已过期' : h < 24 ? '剩' + h + '小时' : '剩' + Math.round(h / 24) + '天';
      const t = new Date(it.endTime);
      const hm = (t.getMonth() + 1) + '-' + t.getDate() + ' ' +
        String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      L.push('· ' + it.title + '（' + it.course + '，' + when + '，截止 ' + hm + '）');
      if (it.files && it.files.length) L.push('  附件：' + it.files.join('、'));
    }
  } else L.push('今天没有快到期的作业。');
  if (b.week.length) {
    L.push('');
    L.push('本周有 ' + b.week.length + ' 项课程活动：');
    for (const w of b.week.slice(0, 6)) L.push('· ' + w.title + '（' + w.kind + '）');
  }
  if (b.fresh.length) {
    L.push('');
    L.push('最近进库 ' + b.fresh.length + ' 条：');
    for (const f of b.fresh.slice(0, 5)) L.push('· ' + f.title);
  }
  L.push('');
  L.push('打开中枢：http://127.0.0.1:' + PORT);
  return L.join('\n');
}

function pushCfg() {
  const p = cfg.pushplus || {};
  const d = cfg.deepseek || {};
  const key = d.key || process.env.DEEPSEEK_API_KEY || '';
  return {
    hasToken: !!p.token,
    tokenTail: p.token ? String(p.token).slice(-4) : '',
    enabled: !!p.enabled,
    time: p.time || '08:30',
    hasModel: !!key,
    modelTail: key ? String(key).slice(-4) : ''
  };
}

function savePushCfg(body) {
  const next = { ...(cfg.pushplus || {}) };
  if (typeof body.token === 'string') next.token = body.token.trim();
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time)) next.time = body.time;
  cfg = { ...cfg, pushplus: next };
  if (typeof body.modelKey === 'string' && body.modelKey.trim()) {
    cfg = { ...cfg, deepseek: { ...(cfg.deepseek || {}), key: body.modelKey.trim() } };
  }
  if (!cfg.deepseek) cfg = { ...cfg, deepseek: { key: '' } };
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2));
  return pushCfg();
}

/** 任意标题/正文推到微信（PushPlus）。没配 token 时把文本原样返回，便于桌面端兜底显示。 */
async function pushNotify(body) {
  const title = String(body.title || '天枢').slice(0, 60);
  const content = String(body.content || body.text || '').slice(0, 20000);
  if (!content.trim()) return { ok: false, reason: 'empty' };
  const token = (cfg.pushplus && cfg.pushplus.token) || process.env.PUSHPLUS_TOKEN || '';
  if (!token) return { ok: false, reason: 'no-token', text: content };
  try {
    const r = await fetch('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, content, template: 'txt' })
    });
    const t = await r.text();
    return { ok: r.ok, status: r.status, body: t };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

async function pushBrief() {
  const token = (cfg.pushplus && cfg.pushplus.token) || process.env.PUSHPLUS_TOKEN || '';
  const text = briefText(brief());
  if (!token) return { ok: false, reason: 'no-token', text };
  try {
    const r = await fetch('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title: '今天的天枢', content: text, template: 'txt' })
    });
    const t = await r.text();
    return { ok: r.ok, status: r.status, body: t, text };
  } catch (e) {
    return { ok: false, reason: String(e), text };
  }
}

/** 检索 + 可选大模型作答（DeepSeek）。没配 key 时只返回检索来源，前端据此说明。 */
async function askAnswer(q, limit) {
  const hits = search({ get: (k) => (k === 'q' ? q : k === 'limit' ? String(limit || 8) : null) }).hits || [];
  const sources = hits.slice(0, Math.max(3, limit || 8)).map((h) => ({ id: h.id, title: h.title, source: h.source, kind: h.kind, docTime: h.docTime }));
  const key = (cfg.deepseek && cfg.deepseek.key) || process.env.DEEPSEEK_API_KEY || '';
  if (!key) return { mode: 'retrieval', sources };
  if (!hits.length) return { mode: 'retrieval', sources: [] };
  const parts = [];
  for (let i = 0; i < Math.min(hits.length, 5); i++) {
    const h = hits[i];
    const row = db.prepare('SELECT body FROM documents WHERE id = ?').get(h.id) || {};
    const text = String(row.body || '').replace(/\s+/g, ' ').slice(0, 1200);
    parts.push('[' + (i + 1) + '] 《' + h.title + '》 (' + h.source + '/' + h.kind + ')\n' + text);
  }
  const sys = '你是用户电脑上的个人资料助理。用户的问题，先看他本机的资料片段，再用中文简洁作答（不超过 300 字）。' +
    '要求：只依据给出的资料；资料不足就直说“本机资料里没有覆盖这一点”，不要编造；需要点名出处时用 [1][2] 标注；语气像秘书，先给结论再给要点。';
  const user = '问题：' + q + '\n\n本机资料：\n' + parts.join('\n\n');
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: cfg.deepseek && cfg.deepseek.model || 'deepseek-chat',
        temperature: 0.2,
        max_tokens: 800,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
      }),
      signal: ac.signal
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* ignore */ }
    if (!r.ok) return { mode: 'error', error: (j && j.error && j.error.message) || ('HTTP ' + r.status), sources };
    const answer = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    return { mode: 'llm', answer: answer || '（模型没有返回内容）', sources, usage: j && j.usage };
  } catch (e) {
    return { mode: 'error', error: String(e && e.message || e), sources };
  } finally {
    clearTimeout(to);
  }
}

// ---------- 采集入库 ----------

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 二进制上传：原样收字节（/api/upload 收手机附件） */
function readBodyBuffer(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large: ' + size + ' > ' + limit)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const TIME_KEYS = ['publishTime', 'createTime', 'gmtCreate', 'createdAt', 'sendTime', 'noticeTime', 'updateTime', 'deadline', 'dueTime', 'endTime', 'startTime'];
const TITLE_KEYS = ['title', 'noticeTitle', 'subject', 'taskName', 'name', 'content', 'summary'];
const ID_KEYS = ['id', 'noticeId', 'taskId', 'uuid', 'bizId', 'code', 'key'];

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function toIso(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = String(n).length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 在响应体里找出「条目数组」：优先 data.list / data.records / rows */
function findItems(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  for (const key of ['list', 'records', 'rows', 'items', 'result', 'content', 'data']) {
    const v = payload[key];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object') {
      const got = findItems(v, depth + 1);
      if (got) return got;
    }
  }
  return null;
}

function flattenText(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (s && s.length < 4000) parts.push(prefix + k + ': ' + s);
    } else if (typeof v === 'object' && !Array.isArray(v) && prefix.length < 40) {
      parts.push(flattenText(v, prefix + k + '.'));
    }
  }
  return parts.filter(Boolean).join('\n');
}

function originOf(pageUrl) {
  try { return new URL(String(pageUrl)).origin; } catch { return ''; }
}

function ingest(payload) {
  const { source = 'hzcu', data, ts } = payload || {};
  const page = payload && payload.page ? payload.page : '';
  let url = (payload && payload.url) || '';
  if (url && !/^https?:/i.test(url) && !url.startsWith('tron://')) {
    const o = originOf(page);
    if (o) url = o + (url.startsWith('/') ? url : '/' + url);
  }
  const dir = path.join(ROOT, 'data', 'raw', source);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(ts || Date.now()).toISOString().replace(/[:.]/g, '-');
  const rawPath = path.join(dir, stamp + '-' + Math.random().toString(36).slice(2, 7) + '.json');
  fs.writeFileSync(rawPath, JSON.stringify({ url, page, ts, data }, null, 1), 'utf8');

  if (source === 'phone' && data && Array.isArray(data.notifications)) {
    const docs = [];
    const filterAds = cfg.phone?.filterAds !== false;
    const opt = { filterAds, keepPkgs: cfg.phone?.keepPkgs, blockPkgs: cfg.phone?.blockPkgs };
    let skippedAds = 0;
    for (const n of data.notifications.slice(0, 300)) {
      const app = String(n.app || '手机').slice(0, 40);
      const title = String(n.title || '').trim();
      const text = String(n.text || '').trim();
      if (!title && !text) continue;
      if (filterAds && classifyNotification({ pkg: String(n.pkg || ''), app, title, text }, opt).ad) { skippedAds++; continue; }
      const at = n.time ? new Date(n.time) : new Date();
      const iso = isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
      const body = [title, text, '[应用] ' + app, '[时间] ' + iso].filter(Boolean).join('\n');
      const h = crypto.createHash('sha1').update(app + '|' + title + '|' + text + '|' + iso.slice(0, 16)).digest('hex');
      docs.push({
        source: 'phone', kind: '通知', uri: 'phone://notify/' + h.slice(0, 18),
        title: (app + ' · ' + (title || text)).slice(0, 120),
        body: body.slice(0, 20000), ext: 'txt', size: body.length,
        mtime: new Date().toISOString(), docTime: iso,
        hash: crypto.createHash('sha1').update(body).digest('hex'),
        meta: { label: '手机通知', app, pkg: n.pkg || '', channel: n.channel || '' },
        ftsTitle: '', ftsBody: ''
      });
    }
    let addedN = 0;
    db.exec('BEGIN');
    try {
      for (const d of docs) {
        d.ftsTitle = indexText(d.title, 2000);
        d.ftsBody = indexText(d.body, 400000);
        if (upsertDoc(db, d).changed) addedN++;
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { ok: true, captured: docs.length, added: addedN, skippedAds, phone: true, raw: path.relative(ROOT, rawPath) };
  }

  // 窗口取文（钉钉方案 A / 微信界面读取）：{ source:'dingtalk'|'wechat', data:{ title, text, method, hwnd } }
  if ((source === 'dingtalk' || source === 'wechat') && data && typeof data.text === 'string') {
    const text = String(data.text).trim();
    if (!text) return { ok: true, captured: 0, added: 0, empty: true, raw: path.relative(ROOT, rawPath) };
    const appName = source === 'dingtalk' ? '钉钉' : '微信';
    const at = new Date(ts || Date.now());
    const iso = isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
    const h = crypto.createHash('sha1').update(appName + '|' + (data.title || '') + '|' + text).digest('hex');
    const head = '[窗口] ' + appName + ' · ' + (data.method === 'ocr' ? '截图识别' : '界面文本') + ' · ' + iso;
    const body = [head, data.title ? '[标题] ' + data.title : '', '', text].filter((x, i) => x !== '' || i === 1).join('\n').slice(0, 200000);
    const title = (appName + '窗口 · ' + (data.title || text.slice(0, 40).replace(/\s+/g, ' '))).slice(0, 120);
    const doc = {
      source, kind: '窗口', uri: source + '://window/' + h.slice(0, 18),
      title, body, ext: 'txt', size: body.length, mtime: iso, docTime: iso,
      hash: crypto.createHash('sha1').update(body).digest('hex'),
      meta: { label: appName + '窗口', app: appName, method: data.method || 'uia', hwnd: Number(data.hwnd) || 0, via: 'window-grab' },
      ftsTitle: '', ftsBody: ''
    };
    doc.ftsTitle = indexText(doc.title, 2000);
    doc.ftsBody = indexText(doc.body, 400000);
    const r = upsertDoc(db, doc);
    console.log('[grab] ' + appName + '窗口 ' + text.length + ' 字（' + (doc.meta.method) + '）→ id=' + r.id + (r.changed ? '' : ' 已存在'));
    return { ok: true, captured: 1, added: r.changed ? 1 : 0, id: r.id, title, chars: text.length, method: doc.meta.method, uri: doc.uri, raw: path.relative(ROOT, rawPath) };
  }

  let tron = { docs: [], files: [], hit: false };
  try { tron = parseTronClass(db, url || page, data); } catch (err) { console.log('[tronclass] 解析失败 ' + err.message); }

  const items = findItems(data);
  const bucket = /notice|courier|announcement|notification/i.test(url) ? 'notice' : (/todo|task|workflow/i.test(url) ? 'task' : 'misc');
  const site = /(^https?:\/\/)?(courses?\.hzcu\.edu\.cn|note-s\.hzcu\.edu\.cn)/.test(String(url)) || /courses?\.hzcu\.edu\.cn/.test(String(page))
    ? '学在城院' : '爱城院';
  const docs = [];
  if (tron.hit) {
    if (!tron.docs.length) {
      return { ok: true, captured: 0, added: 0, tron: true, ignored: true, files: tron.files.length, raw: path.relative(ROOT, rawPath) };
    }
    docs.push(...tron.docs);
  } else if (items) {
    for (const item of items.slice(0, 200)) {
      const id = pickFirst(item, ID_KEYS) ?? crypto.createHash('sha1').update(JSON.stringify(item)).digest('hex').slice(0, 16);
      const title = String(pickFirst(item, TITLE_KEYS) ?? (site + '-' + bucket)).slice(0, 120).replace(/\s+/g, ' ');
      const body = flattenText(item) + '\n[来源] ' + (url || page);
      const docTime = toIso(pickFirst(item, TIME_KEYS)) || new Date(ts || Date.now()).toISOString();
      docs.push({
        source, kind: bucket, uri: 'hzcu://' + bucket + '/' + id, title,
        body: body.slice(0, 200000), ext: 'json', size: body.length, mtime: new Date().toISOString(),
        docTime, hash: crypto.createHash('sha1').update(body).digest('hex'),
        meta: { label: site, url, page }, ftsTitle: '', ftsBody: ''
      });
    }
  } else {
    const body = flattenText(data || {}) || JSON.stringify(data || {}).slice(0, 20000);
    docs.push({
      source, kind: bucket, uri: 'hzcu://' + bucket + '/' + crypto.createHash('sha1').update(url + (ts || 0)).digest('hex').slice(0, 16),
      title: site + ' ' + bucket + ' ' + new Date(ts || Date.now()).toLocaleString('zh-CN'),
      body: body.slice(0, 200000) + '\n[来源] ' + (url || page), ext: 'json', size: body.length,
      mtime: new Date().toISOString(), docTime: toIso(ts) || new Date().toISOString(),
      hash: crypto.createHash('sha1').update(body).digest('hex'),
      meta: { label: site, url, page }, ftsTitle: '', ftsBody: ''
    });
  }

  let added = 0;
  db.exec('BEGIN');
  try {
    for (const d of docs) {
      d.ftsTitle = indexText(d.title, 2000);
      d.ftsBody = indexText(d.body, 400000);
      const r = upsertDoc(db, d);
      if (r.changed) added++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return { ok: true, captured: docs.length, added, tron: tron.hit, files: tron.files.length, raw: path.relative(ROOT, rawPath) };
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([.][.][\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

function withinRoots(p) {
  const low = path.resolve(p).toLowerCase();
  return cfg.roots.some((r) => low.startsWith(path.resolve(r.path).toLowerCase()));
}

// ---------- MCP over HTTP（Streamable HTTP，无状态；单条请求直接回 JSON） ----------
const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-hub-token, mcp-session-id, mcp-protocol-version, accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

async function handleMcp(req, res, url) {
  if (!isLoopback(req) && !tokenOk(req, url)) return json(res, 401, { error: 'token required' });
  for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS, DELETE');
    return json(res, 405, { error: 'MCP 走 POST' });
  }
  let raw;
  try { raw = await readBody(req, 8 * 1024 * 1024); } catch { return json(res, 413, { error: 'body too large' }); }
  let msg;
  try { msg = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  const first = Array.isArray(msg) ? msg[0] : msg;
  if (first && first.method === 'initialize') res.setHeader('Mcp-Session-Id', crypto.randomUUID());

  if (Array.isArray(msg)) {
    const out = msg.map((m) => mcp.handleRpc(m)).filter(Boolean);
    if (!out.length) { res.writeHead(202).end(); return; }
    return json(res, 200, out);
  }
  const resp = mcp.handleRpc(msg);
  if (!resp) { res.writeHead(202).end(); return; }
  return json(res, 200, resp);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  try {
    if (p === '/mcp') return await handleMcp(req, res, url);
    if (p.startsWith('/api/') && !isLoopback(req) && !tokenOk(req, url)) {
      return json(res, 401, { error: 'token required' });
    }
    if (p === '/api/search') return json(res, 200, search(url.searchParams));
    if (p === '/api/timeline') return json(res, 200, timeline(url.searchParams));
    if (p === '/api/stats') return json(res, 200, stats());
    if (p === '/api/due') return json(res, 200, due(url.searchParams));
    if (p === '/api/brief') return json(res, 200, brief());
    if (p === '/api/reminders') return json(res, 200, reminders(url.searchParams));
    if (p === '/api/actions') return json(res, 200, actions());
    if (p === '/api/push/notify' && req.method === 'POST') {
      const raw = await readBody(req, 128 * 1024);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      return json(res, 200, await pushNotify(body));
    }
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, pushCfg());
    if (p === '/api/config' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      return json(res, 200, savePushCfg(body));
    }
    if (p === '/api/push' && req.method === 'POST') return json(res, 200, await pushBrief());
    if (p === '/api/ask' && req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const q = String(body.q || '').trim();
      if (!q) return json(res, 400, { error: 'empty question' });
      const t0 = Date.now();
      const r = await askAnswer(q, Number(body.limit) || 8);
      r.ms = Date.now() - t0;
      return json(res, 200, r);
    }
    if (p === '/api/note' && req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty text' });
      const title = String(body.title || '').trim() || text.split('\n')[0].slice(0, 40);
      const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : [];
      const nowIso = new Date().toISOString();
      const hash = crypto.createHash('sha1').update('note|' + text).digest('hex');
      const r = upsertDoc(db, {
        source: 'note', kind: 'note', uri: 'note://holo/' + hash.slice(0, 18),
        title, body: text, ext: 'md', size: Buffer.byteLength(text),
        mtime: nowIso, docTime: nowIso, hash,
        meta: { label: '手记', tags, via: 'holo' },
        ftsTitle: indexText(title), ftsBody: indexText(text)
      });
      console.log('[note] ' + (r.changed ? '新增' : '已存在') + ' id=' + r.id + ' ' + title);
      return json(res, 200, { ok: true, id: r.id, title, changed: r.changed });
    }
    if (p === '/api/roots') return json(res, 200, cfg.roots.map((r) => ({ source: r.source, label: r.label, path: r.path })));
    if (p === '/api/ingest' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const r = ingest(payload);
      console.log('[ingest] ' + payload.source + ' ' + (payload.url || '') + ' → 捕获 ' + r.captured + '，新增 ' + r.added);
      return json(res, 200, r);
    }
    if (p === '/api/ingest' && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    if (p === '/api/upload' && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-file-name, x-file-mtime'
      });
      return res.end();
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const maxMB = Math.max(1, Math.min(Number((cfg.phone && cfg.phone.maxFileMB) || 40), Number(cfg.maxFileMB) || 80));
      let buf;
      try {
        buf = await readBodyBuffer(req, maxMB * 1024 * 1024);
      } catch (e) {
        return json(res, 413, { error: '文件太大（上限 ' + maxMB + 'MB）' });
      }
      if (!buf || !buf.length) return json(res, 400, { error: 'empty body' });
      // 同一份文件重复回传（换手机、状态文件丢了）不再落第二份
      const bufHash = crypto.createHash('sha1').update(buf).digest('hex');
      if (url.searchParams.get('force') !== '1') {
        const dup = db.prepare('SELECT id, title, uri FROM documents WHERE hash = ? ORDER BY id LIMIT 1').get(bufHash);
        if (dup) {
          return json(res, 200, { ok: true, dedupe: 'hash', id: dup.id, title: dup.title, uri: dup.uri, changed: false, textChars: 0, saved: '' });
        }
      }
      const rawName = url.searchParams.get('name') || req.headers['x-file-name'] || '';
      let name = '';
      if (rawName) { try { name = decodeURIComponent(String(rawName)); } catch { name = String(rawName); } }
      if (!name) name = 'attachment-' + Date.now() + '.bin';
      const source = url.searchParams.get('source') || 'phone';
      const label = url.searchParams.get('label') || (source === 'phone' ? '手机附件' : source);
      const mtime = url.searchParams.get('mtime') || req.headers['x-file-mtime'] || '';
      const saved = await saveBytes(buf, name, { sub: source === 'phone' ? 'phone' : source });
      const r = await ingestFile({ db, cfg, filePath: saved, data: buf, source, label, origName: name, fileMtime: mtime ? String(mtime) : '' });
      console.log('[upload] ' + name + ' ' + Math.round(buf.length / 1024) + 'KB → id=' + r.id + ' 正文 ' + r.textChars + ' 字' + (r.extractErr ? '（' + r.extractErr + '）' : ''));
      return json(res, 200, { ok: true, ...r });
    }
    if (p === '/api/doc') {
      const id = Number(url.searchParams.get('id'));
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      if (!row) return json(res, 404, { error: 'not found' });
      let meta = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
      return json(res, 200, { ...row, meta });
    }
    if (p === '/api/open') {
      const uri = url.searchParams.get('uri') || '';
      if (!uri || !withinRoots(uri) || !fs.existsSync(uri)) return json(res, 400, { error: 'bad path' });
      spawn('explorer.exe', ['/select,' + path.resolve(uri)], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/file') {
      const uri = url.searchParams.get('uri') || '';
      if (!uri || !withinRoots(uri)) { res.writeHead(403).end('forbidden'); return; }
      try {
        const st = await fsp.stat(uri);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(uri).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size
        });
        fs.createReadStream(uri).pipe(res);
      } catch {
        res.writeHead(404).end('404');
      }
      return;
    }
    if (p === '/holo' || p === '/holo/') return serveStatic(req, res, '/holo.html');
    if (p === '/m' || p === '/m/') return serveStatic(req, res, '/m.html');
    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[server]', err);
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('天枢已启动: http://' + HOST + ':' + PORT);
  console.log('数据库: ' + dbPath);
  const n = db.prepare('SELECT count(*) AS n FROM documents').get().n;
  console.log('库内文档: ' + n + ' 条');
});


