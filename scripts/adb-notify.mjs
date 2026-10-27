#!/usr/bin/env node
// PC 侧通知桥：用 adb 直接读手机通知，不需要在手机上装任何 App。
//
// 前置（手机一次）：
//   开发者选项 → 打开「USB 调试」「USB 安装」「USB 调试（安全设置）」
//   数据线连电脑 → 手机上点「允许 USB 调试」→ 勾选「一律允许」
//
// 用法（电脑）：
//   node scripts/adb-notify.mjs                 # 每 60 秒抓一次，直到 Ctrl+C
//   node scripts/adb-notify.mjs --once          # 只抓一次
//   node scripts/adb-notify.mjs --dump          # 打印解析结果
//   node scripts/adb-notify.mjs --interval 30   # 改频率
//   node scripts/adb-notify.mjs --serial 1a2b3c # 多台设备时指定
//   node scripts/adb-notify.mjs --keep-ads      # 连广告/营销通知也一起收（默认过滤）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyNotification } from '../src/notify-filter.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
function arg(n, d) { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; }

const ROOT = path.resolve(import.meta.dirname, '..');
const ADB = process.env.ADB || path.join(ROOT, 'tools', 'platform-tools', 'adb.exe');
const HUB = (arg('hub', 'http://127.0.0.1:7311')).replace(/\/+$/, '');
const CFG = path.join(ROOT, 'config.json');
const TOKEN = arg('token', (() => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')).lan?.token || ''; } catch { return ''; } })());
const ALL = has('all');
const KEEP_ADS = has('keep-ads');
const ONCE = has('once');
const DUMP = has('dump');
const INTERVAL = Number(arg('interval', '60')) * 1000;
const SERIAL = arg('serial', '');
const STATE = path.join(ROOT, 'data', 'adb-notify-sent.json');
const LOG = path.join(ROOT, 'data', 'adb-notify.log');
function log(...a) { const line = a.join(' '); console.log(line); try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {} }

const SKIP = new Set(['android', 'com.android.systemui', 'com.android.settings', 'com.android.providers.downloads',
  'com.google.android.gms', 'com.miui.systemui', 'com.miui.notification', 'com.android.intentresolver',
  'com.android.permissioncontroller', 'com.android.vending', 'com.android.packageinstaller', 'com.miui.securitycenter']);
const SKIP_PREFIX = ['com.miui.', 'com.xiaomi.', 'com.milink.', 'com.mi.', 'com.android.', 'com.google.', 'com.sec.', 'com.samsung.'];
const APP_NAME = {
  'com.eg.android.AlipayGphone': '支付宝', 'me.ele': '饿了么', 'com.taobao.taobao': '淘宝',
  'com.jingdong.app.mall': '京东', 'com.sankuai.meituan': '美团', 'com.dianping.v1': '大众点评',
  'com.MobileTicket': '铁路12306', 'com.autonavi.minimap': '高德地图', 'com.baidu.BaiduMap': '百度地图',
  'com.netease.cloudmusic': '网易云音乐', 'com.tencent.qqmusic': 'QQ音乐', 'tv.danmaku.bili': '哔哩哔哩',
  'com.zhihu.android': '知乎', 'com.ss.android.article.news': '今日头条', 'com.UCMobile': 'UC浏览器',
  'com.android.chrome': 'Chrome', 'com.microsoft.emmx': 'Edge', 'com.tencent.tim': 'TIM',
  'cn.wps.moffice_eng': 'WPS', 'com.youdao.dict': '有道词典', 'com.baicizhan.bcz': '百词斩',
  'com.ximalaya.ting.android': '喜马拉雅', 'com.tencent.weishi': '微视', 'com.alibaba.android.rimet': '钉钉', 'com.alibaba.dingtalk': '钉钉', 'com.tencent.mm': '微信',
  'com.tencent.wework': '企业微信', 'com.tencent.mobileqq': 'QQ', 'com.xingin.xhs': '小红书',
  'com.ss.android.ugc.aweme': '抖音', 'com.hzcu.campus': '爱城院' };

function adb(args, timeout = 30000) {
  return execFileSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

function pickDevice() {
  const out = adb(['devices']);
  const line = out.split(/\r?\n/).find((l) => /\tdevice$/.test(l.trim()));
  if (!line) return null;
  return line.split(/\t/)[0].trim();
}

function ensureDevice() {
  let dev = pickDevice();
  if (dev) return dev;
  // 没有已连接设备时，用 mDNS 发现无线调试端口并自动连上（小米 15 / Android 11+）
  try {
    const out = adb(['mdns', 'services']);
    const m = out.match(/_adb-tls-connect\._tcp\s+(\S+):(\d+)/);
    if (m) {
      const target = m[1] + ':' + m[2];
      adb(['connect', target]);
      dev = pickDevice();
      if (dev) { log('[i] 已自动连接无线调试 ' + target); return dev; }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function cleanVal(s) {
  if (!s) return '';
  let v = String(s).trim();
  const m = v.match(/^(?:String|SpannableString|CharSequence)\s*\((.*)\)\s*$/s);
  if (m) v = m[1];
  if (v === 'null' || v === 'undefined') return '';
  return v.replace(/\s*\n\s*/g, ' ').replace(/\n/g, ' ').slice(0, 400);
}

function parse(raw) {
  const out = [];
  for (const blk of raw.split(/NotificationRecord\(0x[0-9a-f]+/i).slice(1)) {
    const pkgM = blk.match(/pkg=([\w.]+)/);
    if (!pkgM) continue;
    const pkg = pkgM[1];
    if (!ALL && SKIP.has(pkg)) continue;
    if (!ALL && SKIP_PREFIX.some((x) => pkg.startsWith(x))) continue;
    const grab = (k) => { const m = blk.match(new RegExp('android\\.' + k + '=([^\\n]*)')); return m ? cleanVal(m[1]) : ''; };
    const title = grab('title'); const text = grab('text');
    if (!title && !text) continue;
    const tM = blk.match(/(?:mPostTime|postTime|when)=(\d{10,13})/);
    let ts = Date.now();
    if (tM) { const n = Number(tM[1]); ts = n > 1e12 ? n : n * 1000; }
    out.push({ pkg, app: APP_NAME[pkg] || pkg, title, text, time: ts });
  }
  return out;
}

function loadState() { try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).keys || []); } catch { return new Set(); } }
function saveState(set) { try { fs.writeFileSync(STATE, JSON.stringify({ keys: [...set].slice(-1500), at: new Date().toISOString() }), 'utf8'); } catch {} }

async function post(items) {
  const body = JSON.stringify({ source: 'phone', url: 'phone://notify', ts: Date.now(), data: { notifications: items } });
  const r = await fetch(HUB + '/api/ingest?t=' + encodeURIComponent(TOKEN), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-token': TOKEN }, body });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.json();
}

async function cycle(sent) {
  let raw;
  if (!ensureDevice()) { log('[!] 手机未连接：插数据线，或在手机开发者选项里打开「无线调试」'); return false; }
  try { raw = adb(['shell', 'dumpsys', 'notification', '--noredact']); }
  catch (e) {
    log('[!] adb 取通知失败：' + String(e.message || e).split('\n')[0].slice(0, 160));
    log('    检查：数据线是否连上 / 手机是否点了「允许 USB 调试」/ 开发者选项是否开了 USB 调试');
    return false;
  }
  const all = parse(raw);
  const fresh = [];
  const dropped = [];
  for (const n of all) {
    const key = n.pkg + '|' + n.title + '|' + n.text + '|' + Math.floor(n.time / 3600000);
    if (sent.has(key)) continue;
    sent.add(key);
    if (!KEEP_ADS) {
      const c = classifyNotification(n);
      if (c.ad) { dropped.push({ n, reason: c.reason }); continue; }
    }
    fresh.push(n);
    if (DUMP) log('  · ' + n.app + ' | ' + n.title + ' | ' + n.text.slice(0, 60));
  }
  if (dropped.length) {
    const byApp = {};
    for (const d of dropped) byApp[d.n.app] = (byApp[d.n.app] || 0) + 1;
    log('[-] 过滤营销/广告通知 ' + dropped.length + ' 条：' +
      Object.entries(byApp).map(([a, c]) => a + ' ' + c).join(' / '));
    if (DUMP) for (const d of dropped) log('    × ' + d.n.app + ' | ' + d.n.title.slice(0, 40) + ' → ' + d.reason);
  }
  if (!fresh.length) { log('[=] ' + new Date().toLocaleTimeString('zh-CN') + ' 没有新通知（扫描 ' + all.length + ' 条）'); return true; }
  try { const r = await post(fresh); log('[+] ' + fresh.length + ' 条同步 → 新增 ' + (r.added || 0) + ' 条'); }
  catch (e) {
    log('[!] 上传失败（下轮重试）：' + String(e.message).slice(0, 160));
    for (const n of fresh) sent.delete(n.pkg + '|' + n.title + '|' + n.text + '|' + Math.floor(n.time / 3600000));
  }
  return true;
}

log('天枢 · adb 通知桥');
log('  adb：' + ADB);
const dev = ensureDevice();
if (!dev) {
  log('  ✗ 没有找到已授权的设备');
  log('    1) 手机：设置 → 我的设备 → 全部参数与信息 → 连点「OS 版本」7 次');
  log('    2) 设置 → 更多设置 → 开发者选项 → 打开「USB 调试」「USB 安装」「USB 调试（安全设置）」');
  log('    3) 插数据线（选「传输文件」模式），手机弹窗点「允许」并勾「一律允许」');
  log('    4) 再跑一次本脚本');
  process.exit(1);
}
log('  设备：' + dev + '，中枢：' + HUB);
const LOCK = path.join(ROOT, 'data', 'adb-notify.pid');
try {
  const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
  if (pid) { execFileSync('tasklist', ['/FI', 'PID eq ' + pid], { encoding: 'utf8' }).includes(String(pid)) && process.exit(0); }
} catch {}
try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch {} });

const sent = loadState();
if (ONCE) { await cycle(sent); saveState(sent); }
else { for (;;) { await cycle(sent); saveState(sent); await new Promise((r) => setTimeout(r, INTERVAL)); } }
