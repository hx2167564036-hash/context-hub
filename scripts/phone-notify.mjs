#!/usr/bin/env node
// 手机通知桥：在 Termux 里跑，把钉钉 / 微信 / 爱城院 的通知同步到电脑上的天枢。
//
// 前置（手机）：
//   1. 装 Termux、装 Shizuku（用无线调试或 USB 启动 Shizuku）
//   2. Termux 里：pkg install nodejs
//   3. 把 Shizuku 的 rish 与 rish_shizuku.dex 放进 ~ ，并 chmod +x rish
//   4. 跑：node phone-notify.mjs --hub http://192.168.0.204:7311 --token <中枢token>
//
// 参数：
//   --hub       电脑中枢地址（默认 http://127.0.0.1:7311）
//   --token     中枢访问码（config.json 里的 lan.token）
//   --once      只跑一次（默认每 60 秒一轮）
//   --interval  轮询秒数
//   --dump      打印解析到但没过滤掉的通知，便于校对
//   --no-filter 不过滤系统包名
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const HUB = (arg('hub', process.env.HUB_URL || 'http://127.0.0.1:7311')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.HUB_TOKEN || '');
const ONCE = argv.includes('--once');
const DUMP = argv.includes('--dump');
const NOFILTER = argv.includes('--no-filter');
const INTERVAL = Number(arg('interval', '60')) * 1000;
const STATE = path.join(os.homedir(), '.hub-phone-sent.json');

const SKIP = new Set([
  'android', 'com.android.systemui', 'com.android.settings', 'com.android.providers.downloads',
  'com.termux', 'com.google.android.gms', 'com.google.android.apps.wellbeing',
  'com.miui.systemui', 'com.miui.notification', 'com.android.intentresolver',
  'com.android.permissioncontroller', 'com.android.vending', 'com.android.packageinstaller'
]);
const APP_NAME = {
  'com.alibaba.android.rimet': '钉钉',
  'com.alibaba.dingtalk': '钉钉',
  'com.tencent.mm': '微信',
  'com.tencent.wework': '企业微信',
  'com.ss.android.ugc.aweme': '抖音',
  'com.xingin.xhs': '小红书',
  'com.tencent.mobileqq': 'QQ',
  'com.hzcu.campus': '爱城院',
  'com.hzcu.edu': '爱城院'
};

// 广告 / 营销过滤（规则与 src/notify-filter.mjs 相同，只是手机上看不到仓库代码，所以内联一份；
// 电脑端的 scripts/adb-notify.mjs 和 src/server.mjs 引用的是那个模块，改规则要两边一起改）
const KEEP_NAMES = new Set(['微信', '钉钉', '企业微信', 'QQ', 'TIM', '爱城院', '邮件', '日历', '短信', '支付宝']);
const KEEP_PKGS = new Set([
  'com.tencent.mm', 'com.alibaba.android.rimet', 'com.alibaba.dingtalk', 'com.tencent.wework',
  'com.tencent.mobileqq', 'com.hzcu.campus', 'com.hzcu.edu', 'com.android.email',
  'com.google.android.gm', 'com.android.calendar', 'com.android.mms', 'com.eg.android.AlipayGphone'
]);
const BLOCK_PKGS = new Set([
  'com.taobao.taobao', 'com.taobao.idlefish', 'com.jingdong.app.mall', 'com.jd.jrapp',
  'com.xunmeng.pinduoduo', 'com.tmall.wireless', 'com.suning.mobile.ebuy', 'com.achievo.vipshop',
  'com.kaola', 'com.dianping.v1', 'com.sankuai.meituan', 'com.sankuai.meituan.takeoutnew',
  'me.ele', 'com.smzdm', 'ctrip.android.view', 'com.Qunar',
  'com.xingin.xhs', 'com.ss.android.ugc.aweme', 'com.ss.android.article.news', 'com.smile.gifmaker',
  'com.tencent.weishi', 'tv.danmaku.bili', 'com.UCMobile', 'com.autonavi.minimap',
  'com.xt.retouch', 'com.mt.mtxx.mtxx', 'com.luna.music', 'com.kugou.android',
  'com.netease.cloudmusic', 'com.tencent.qqmusic', 'com.ximalaya.ting.android',
  'com.xiaomi.shop', 'com.huawei.appmarket', 'com.heytap.market', 'com.oppo.market',
  'com.bbk.appstore', 'com.tencent.android.qqdownloader', 'com.qihoo.appstore',
  'com.shizhuang.duapp'
]);
const BLOCK_NAMES = new Set([
  '淘宝', '京东', '京东金融', '拼多多', '天猫', '苏宁', '唯品会', '闲鱼', '考拉', '大众点评',
  '美团', '饿了么', '高德地图', '小红书', '抖音', '快手', '今日头条', '微博', '哔哩哔哩',
  '网易云音乐', 'QQ音乐', '酷狗音乐', '喜马拉雅', '什么值得买', '美颜相机', '美图秀秀', '携程', '去哪儿',
  '小米商城', '华为商城', '应用商店', '应用宝', '得物', '得物App'
]);
const NOISE_RE = /(权限管理服务|正在运行|后台运行|前台服务|系统更新|发现新版本|充电中|快充|极致加速|电量低|存储空间|安全中心|垃圾清理|加速球|已连接|已断开|连接成功|网络不可用|无线调试|应用接力|设备已连接|Wake with voice|Continuity|Device interconnectivity)/;
const KEEP_MSG_RE = /(私信|发来消息|回复了你|评论了你|@了你|提到了你|好友申请|群消息|有人@|向你发起了)/;
const TRANSACTION_RE = /(您的订单|订单号|已发货|已签收|派送中|派件|取件码|快递|包裹|退款|退货|验证码|动态码|扣款|扣费|支付成功|已支付|账单|还款|转账|入账|支出|消费金额|余额变动|到账提醒)/;
const PROMO_RE = /(优惠|特价|秒杀|限量|限时|抢购|大促|满减|折扣|红包|抽奖|福利|礼包|好礼|领取|免费|包邮|种草|必吃|好物|精选|推荐|上新|会员日|签到|积分|返现|补贴|清仓|低至|起购|业绩比较基准|理财|试听|直播|砍价|拼单|首单|专属|特权|幸运|资格|速来|倒计时|立即使用)/;
const PROMO_G = new RegExp(PROMO_RE.source, 'g');

function isAdNotification(n) {
  const t = [n.title, n.text].filter(Boolean).join(' ').trim();
  if (!t) return false;
  const trusted = KEEP_PKGS.has(n.pkg) || KEEP_NAMES.has(n.app);
  const msg = KEEP_MSG_RE.test(t);
  const trans = TRANSACTION_RE.test(t);
  if (trusted) return !msg && !trans && (t.match(PROMO_G) || []).length >= 2;
  if (msg || trans) return false;
  if (NOISE_RE.test(t)) return true;
  if (BLOCK_PKGS.has(n.pkg) || BLOCK_NAMES.has(n.app)) return true;
  return PROMO_RE.test(t);
}

function haveRish() {
  try { execFileSync('rish', ['-c', 'echo ok'], { timeout: 8000 }); return true; } catch { return false; }
}

function dumpNotifications() {
  let raw = '';
  if (haveRish()) {
    raw = execFileSync('rish', ['-c', 'dumpsys notification --noredact'], { timeout: 25000, maxBuffer: 32 * 1024 * 1024 }).toString();
  } else {
    raw = execFileSync('sh', ['-c', 'dumpsys notification --noredact'], { timeout: 25000, maxBuffer: 32 * 1024 * 1024 }).toString();
  }
  return raw;
}

function cleanVal(s) {
  if (!s) return '';
  let v = String(s).trim();
  // String (xxx) / SpannableString (xxx) / String[x]
  const m = v.match(/^(?:String|SpannableString|CharSequence)\s*\((.*)\)\s*$/s);
  if (m) v = m[1];
  if (v === 'null' || v === 'undefined') return '';
  return v.replace(/\s+\n\s*/g, ' ').replace(/\n/g, ' ').slice(0, 400);
}

function parse(raw) {
  const out = [];
  const parts = raw.split(/NotificationRecord\(0x[0-9a-f]+/i).slice(1);
  for (const blk of parts) {
    const pkgM = blk.match(/pkg=([\w.]+)/);
    if (!pkgM) continue;
    const pkg = pkgM[1];
    if (!NOFILTER && SKIP.has(pkg)) continue;
    const grab = (key) => {
      const re = new RegExp('android\\.' + key + '=([^\\n]*)');
      const m = blk.match(re);
      return m ? cleanVal(m[1]) : '';
    };
    const title = grab('title');
    const text = grab('text');
    if (!title && !text) continue;
    const tM = blk.match(/(?:mPostTime|postTime|when)=(\d{10,13})/);
    let ts = Date.now();
    if (tM) { const n = Number(tM[1]); ts = n > 1e12 ? n : n * 1000; }
    out.push({ pkg, app: APP_NAME[pkg] || pkg, title, text, time: ts });
  }
  return out;
}

function loadState() {
  try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8')); return new Set(j.keys || []); } catch { return new Set(); }
}
function saveState(set) {
  const keys = [...set].slice(-800);
  try { fs.writeFileSync(STATE, JSON.stringify({ keys, at: new Date().toISOString() }), 'utf8'); } catch { /* ignore */ }
}

async function post(items) {
  const body = JSON.stringify({ source: 'phone', url: 'phone://notify', ts: Date.now(), data: { notifications: items } });
  const r = await fetch(HUB + '/api/ingest?t=' + encodeURIComponent(TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-token': TOKEN },
    body
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function cycle(sent) {
  let raw;
  try { raw = dumpNotifications(); } catch (e) {
    console.log('[!] 取通知失败：' + String(e.message || e).slice(0, 200));
    console.log('    确认 Shizuku 在运行，且 rish 能执行：rish -c "echo ok"');
    return;
  }
  const all = parse(raw);
  const fresh = [];
  const dropped = [];
  for (const n of all) {
    const key = n.pkg + '|' + n.title + '|' + n.text + '|' + Math.floor(n.time / 3600000);
    if (sent.has(key)) continue;
    sent.add(key);
    if (!NOFILTER && isAdNotification(n)) { dropped.push(n); continue; }
    fresh.push(n);
    if (DUMP) console.log('  · ' + n.app + ' | ' + n.title + ' | ' + n.text.slice(0, 60));
  }
  if (dropped.length) {
    const byApp = {};
    for (const n of dropped) byApp[n.app] = (byApp[n.app] || 0) + 1;
    console.log('[-] 过滤营销/广告通知 ' + dropped.length + ' 条：' +
      Object.entries(byApp).map(([a, c]) => a + ' ' + c).join(' / '));
  }
  if (!fresh.length) { console.log('[=] ' + new Date().toLocaleTimeString('zh-CN') + ' 没有新通知（扫描 ' + all.length + ' 条）'); return; }
  try {
    const r = await post(fresh);
    console.log('[+] ' + fresh.length + ' 条已同步 → 新增 ' + (r.added || 0) + ' 条入库');
  } catch (e) {
    console.log('[!] 上传失败：' + String(e.message || e).slice(0, 200));
    for (const n of fresh) sent.delete(n.pkg + '|' + n.title + '|' + n.text + '|' + Math.floor(n.time / 3600000));
  }
}

const sent = loadState();
console.log('天枢 · 手机通知桥');
console.log('  中枢：' + HUB);
console.log('  token：' + (TOKEN ? TOKEN.slice(0, 6) + '…' : '（空，局域网访问会被拒绝）'));
console.log('  模式：' + (ONCE ? '单次' : '每 ' + INTERVAL / 1000 + ' 秒'));

if (ONCE) {
  await cycle(sent);
  saveState(sent);
} else {
  while (true) {
    await cycle(sent);
    saveState(sent);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}
