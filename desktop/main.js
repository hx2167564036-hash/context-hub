const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, globalShortcut, nativeImage, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

// 这台机器上 Chromium 的沙箱初始化会在进入 JS 之前就崩溃（0x80000003，platform_channel 拒绝访问），
// 所以必须先由启动器带上 --no-sandbox 命令行开关，JS 里的 appendSwitch 来不及生效。
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:7311';
const PORT = 7311;

// 提醒状态：记下已经提醒过的条目，避免每分钟重复弹
const REMIND_FILE = path.join(ROOT, 'data', 'reminders-sent.json');

// 启动日志：双击打不开时，凭 data/desktop-startup.log 判断卡在哪一步
const STARTUP_LOG = path.join(ROOT, 'data', 'desktop-startup.log');
function startupLog(msg) {
  const line = '[' + new Date().toISOString() + '] pid=' + process.pid + ' ' + msg + '\n';
  try {
    if (fs.existsSync(STARTUP_LOG) && fs.statSync(STARTUP_LOG).size > 512 * 1024) fs.renameSync(STARTUP_LOG, STARTUP_LOG + '.1');
    fs.appendFileSync(STARTUP_LOG, line);
  } catch {}
  console.log(line.trimEnd());
}
startupLog('启动 argv=' + JSON.stringify(process.argv.slice(1)) +
  ' 版本 electron=' + process.versions.electron + ' chrome=' + process.versions.chrome + ' node=' + process.versions.node +
  ' RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || '-') +
  ' 用户数据=' + (app && app.getPath ? app.getPath('userData') : '?'));
let mainWin = null;
let todayWin = null;
let holoWin = null;
let tray = null;
let serverProc = null;
let quitting = false;
let lastNotifyDay = '';

const configPath = path.join(ROOT, 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

function getJson(urlPath, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get(BASE + urlPath, { timeout }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function serverAlive() {
  const s = await getJson('/api/stats', 1500);
  return !!s && typeof s.total === 'number';
}

async function ensureServer() {
  if (await serverAlive()) return true;
  const logPath = path.join(ROOT, 'data', 'server.out.log');
  const errPath = path.join(ROOT, 'data', 'server.err.log');
  try { fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true }); } catch {}
  serverProc = spawn(process.env.CTXHUB_NODE || 'node', ['src/server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(errPath, 'a')]
  });
  serverProc.on('exit', () => { serverProc = null; });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverAlive()) return true;
  }
  return false;
}

// 手机通知桥：adb 已装就常驻跑 adb-notify.mjs（脚本自己带单实例锁，重复启动会立刻退出）。
// 广告/营销通知在脚本侧和 /api/ingest 侧都会过滤，见 src/notify-filter.mjs。
let notifyProc = null;
function ensureNotify() {
  if (notifyProc) return true;
  const adb = path.join(ROOT, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (!fs.existsSync(adb)) { startupLog('手机通知桥：没找到 adb，跳过'); return false; }
  try {
    notifyProc = spawn(process.env.CTXHUB_NODE || 'node', ['scripts/adb-notify.mjs', '--interval', '90'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch (e) {
    startupLog('手机通知桥起不来：' + String(e && e.message || e));
    notifyProc = null;
    return false;
  }
  startupLog('手机通知桥已启动');
  notifyProc.on('exit', (code) => {
    startupLog('手机通知桥退出 code=' + code + '，60 秒后重试');
    notifyProc = null;
    setTimeout(() => ensureNotify(), 60000).unref?.();
  });
  notifyProc.on('error', (e) => { startupLog('手机通知桥出错：' + String(e && e.message || e)); notifyProc = null; });
  return true;
}

// 抓当前钉钉/微信窗口的文字（scripts/grab-window.mjs：UIA 优先、截图 OCR 兜底），抓到就入库。
function grabWindow(appName) {
  return new Promise((resolve) => {
    const cfg = readConfig();
    const token = (cfg.lan && cfg.lan.token) || '';
    const args = ['scripts/grab-window.mjs', '--app', appName, '--json'];
    if (token) args.push('--token', token);
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(process.env.CTXHUB_NODE || 'node', args, { cwd: ROOT, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, reason: String(e) });
    }
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, reason: '超时（30 秒）' }); }, 30000);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: String(e) }); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch {}
      resolve(j || { ok: false, reason: '退出码 ' + code + (err ? '：' + err.slice(0, 200) : '') });
    });
  });
}

async function grabAndNotify(appName) {
  const label = appName === 'wechat' ? '微信' : '钉钉';
  const j = await grabWindow(appName);
  const body = j && j.ok
    ? (j.ingested ? '已入库 ' + j.chars + ' 字（' + (j.method === 'ocr' ? '截图识别' : '界面文本') + '）' : '抓到 ' + j.chars + ' 字，未入库')
    : '没抓到：' + ((j && j.reason) || '未知错误');
  console.log('[grab] ' + label + ' ' + body);
  if (Notification.isSupported()) {
    new Notification({ title: '抓' + label + '窗口', body, icon: path.join(__dirname, 'icon.png') }).show();
  }
  return j;
}

// 把今天的晨报/到期/新增写成 Obsidian 日报（scripts/obsidian-writeback.mjs）
function runWriteback(notify) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(process.env.CTXHUB_NODE || 'node', ['scripts/obsidian-writeback.mjs'], { cwd: ROOT, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, reason: String(e) });
    }
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, reason: '超时' }); }, 60000);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: String(e) }); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      const lines = (out || err).trim().split('\n').filter(Boolean);
      const text = lines.slice(-2).join(' / ');
      console.log('[writeback] exit ' + code + ' ' + text);
      if (notify !== false && Notification.isSupported()) {
        new Notification({ title: 'Obsidian 日报', body: code === 0 ? (text || '已写入') : '失败：' + (text || code), icon: path.join(__dirname, 'icon.png') }).show();
      }
      resolve({ ok: code === 0, output: text });
    });
  });
}

function makeWindow(opts) {
  const w = new BrowserWindow(Object.assign({
    backgroundColor: '#0d0f13',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  }, opts));
  w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log('[renderer] ' + message + ' (' + String(sourceId).split('/').slice(-5).join('/') + ':' + line + ')');
  });
  // 缩放：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 还原、Ctrl+滚轮（preload 里转发）、F11 全屏
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const k = input.key;
    if (ctrl && (k === '=' || k === '+' || k === 'Add')) { zoomBy(w, 0.1); e.preventDefault(); }
    else if (ctrl && (k === '-' || k === 'Subtract')) { zoomBy(w, -0.1); e.preventDefault(); }
    else if (ctrl && k === '0') { zoomReset(w); e.preventDefault(); }
    else if (k === 'F11') { w.setFullScreen(!w.isFullScreen()); e.preventDefault(); }
  });
  return w;
}

function zoomBy(win, delta) {
  if (!win || win.isDestroyed()) return;
  const cur = win.webContents.getZoomFactor() || 1;
  const next = Math.round(Math.min(2.5, Math.max(0.5, cur + delta)) * 100) / 100;
  win.webContents.setZoomFactor(next);
  startupLog('[缩放] 当前 ' + Math.round(next * 100) + '%');
}

function zoomReset(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(1);
  startupLog('[缩放] 还原 100%');
}

async function createMain() {
  console.log('[main] createMain called');
  if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); return mainWin; }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.max(900, Math.min(1280, Math.round(area.width * 0.82)));
  const h = Math.max(600, Math.min(880, Math.round(area.height * 0.86)));
  mainWin = makeWindow({
    width: w, height: h, minWidth: 900, minHeight: 560,
    x: Math.round((area.width - w) / 2), y: Math.round((area.height - h) / 2) - 8,
    title: '天枢', icon: path.join(__dirname, 'icon.png')
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[main] load fail', code, desc, url));
  mainWin.webContents.on('render-process-gone', (_e, d) => console.error('[main] renderer gone', JSON.stringify(d)));
  mainWin.once('ready-to-show', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); });
  try { await mainWin.loadURL(BASE + '/'); } catch (e) { console.error('[main] loadURL error', String(e)); }
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
  mainWin.on('close', (e) => {
    if (!quitting && process.env.CTXHUB_CLOSE_TO_TRAY !== '0') { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

async function createToday() {
  if (todayWin && !todayWin.isDestroyed()) { if (todayWin.isMinimized()) todayWin.restore(); todayWin.show(); todayWin.focus(); return todayWin; }
  const area = screen.getPrimaryDisplay().workAreaSize;
  todayWin = makeWindow({
    width: 430, height: Math.min(760, area.height - 120), minWidth: 380, minHeight: 480,
    x: area.width - 450, y: 70,
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: false,
    title: '今天', icon: path.join(__dirname, 'icon.png')
  });
  todayWin.once('ready-to-show', () => { if (todayWin && !todayWin.isDestroyed()) todayWin.show(); });
  await todayWin.loadURL(BASE + '/today.html');
  if (todayWin && !todayWin.isDestroyed()) todayWin.show();
  todayWin.on('closed', () => { todayWin = null; });
  return todayWin;
}

async function createHolo() {
  if (holoWin && !holoWin.isDestroyed()) { if (holoWin.isMinimized()) holoWin.restore(); holoWin.show(); holoWin.focus(); return holoWin; }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1440, Math.round(area.width * 0.94));
  const h = Math.min(920, Math.round(area.height * 0.92));
  holoWin = makeWindow({
    width: w, height: h, minWidth: 900, minHeight: 560,
    x: Math.round((area.width - w) / 2), y: Math.round((area.height - h) / 2),
    frame: false, backgroundColor: '#02040a',
    title: 'J.A.R.V.I.S 全息控制台', icon: path.join(__dirname, 'icon.png')
  });
  holoWin.setMenuBarVisibility(false);
  holoWin.once('ready-to-show', () => { if (holoWin && !holoWin.isDestroyed()) holoWin.show(); });
  await holoWin.loadURL(BASE + '/holo');
  if (holoWin && !holoWin.isDestroyed()) { holoWin.show(); holoWin.focus(); }
  holoWin.on('closed', () => { holoWin = null; });
  return holoWin;
}

function toggleToday() {
  if (todayWin && todayWin.isVisible()) todayWin.hide();
  else createToday();
}

async function pushWeChat(text) {
  const cfg = readConfig();
  const token = (cfg.pushplus && cfg.pushplus.token) || process.env.PUSHPLUS_TOKEN || '';
  if (!token) return { ok: false, reason: 'no-token' };
  return new Promise((resolve) => {
    const body = JSON.stringify({ token, title: '今天的天枢', content: text, template: 'txt' });
    const req = http.request('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ ok: true, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: String(e && e.message) }));
    req.end(body);
  });
}

// ---------- 提醒：上课前 30 分钟、DDL 前 24 小时 / 1 小时 ----------
function loadRemindSent() {
  try { return JSON.parse(fs.readFileSync(REMIND_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveRemindSent(obj) {
  try {
    const keys = Object.keys(obj);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete obj[k];
    fs.writeFileSync(REMIND_FILE, JSON.stringify(obj, null, 1));
  } catch {}
}
let remindSent = loadRemindSent();
let remindBusy = false;

function notify(title, body) {
  if (!Notification.isSupported()) return;
  try { new Notification({ title, body, icon: path.join(__dirname, 'icon.png') }).show(); } catch {}
}

async function checkReminders() {
  if (remindBusy) return;
  remindBusy = true;
  try {
    const j = await getJson('/api/reminders?within=1560', 8000);
    if (!j || !Array.isArray(j.items)) return;
    for (const it of j.items) {
      const m = it.minutes;
      let key = null;
      let body = '';
      if (it.kind === 'class' && m > 22 && m <= 35) {
        key = it.key + '@30';
        body = m + ' 分钟后上课：' + it.title + '\n' + it.detail;
      } else if (it.kind === 'ddl' && m > 1380 && m <= 1500) {
        key = it.key + '@24h';
        body = '还有 24 小时截止：' + it.title + (it.course ? '（' + it.course + '）' : '');
      } else if (it.kind === 'ddl' && m > 55 && m <= 70) {
        key = it.key + '@1h';
        body = '还有 1 小时截止：' + it.title;
      }
      if (!key || remindSent[key]) continue;
      remindSent[key] = new Date().toISOString();
      saveRemindSent(remindSent);
      startupLog('[提醒] ' + key + ' | ' + body.replace(/\n/g, ' / '));
      notify('天枢提醒', body);
      pushWeChat(body).catch(() => {});
    }
  } catch (e) {
    startupLog('[提醒] 检查失败：' + String(e));
  } finally {
    remindBusy = false;
  }
}

function startReminders() {
  checkReminders().catch(() => {});
  setInterval(() => { checkReminders().catch(() => {}); }, 60 * 1000);
}

/** 把今天的可执行清单推到微信（托盘菜单和快捷键用） */
async function pushActions() {
  const a = await getJson('/api/actions', 8000);
  if (!a || !a.text) { notify('天枢', '行动清单没取到，本地服务可能在重启'); return { ok: false }; }
  const r = await pushWeChat(a.text);
  if (r && r.ok) notify('已推到微信', '今日行动清单已发送');
  else notify('推送失败', (r && r.reason) || '检查 PushPlus token');
  startupLog('[行动清单] push=' + JSON.stringify(r));
  return r;
}

function briefText(b) {
  const lines = [];
  const d = new Date();
  lines.push('【' + d.getMonth() + 1 + '月' + d.getDate() + '日】共 ' + b.due.length + ' 项待办');
  if (b.due.length) {
    for (const it of b.due.slice(0, 8)) {
      const h = it.hoursLeft;
      const when = h < 0 ? '已过期' : h < 24 ? '剩' + h + '小时' : '剩' + Math.round(h / 24) + '天';
      lines.push('· ' + it.title + '（' + it.course + '，' + when + '）');
      if (it.files && it.files.length) lines.push('    附件：' + it.files.join('、'));
    }
  } else {
    lines.push('· 没有快到期的作业');
  }
  if (b.fresh && b.fresh.length) {
    lines.push('');
    lines.push('这两天新进 ' + b.fresh.length + ' 条：');
    for (const f of b.fresh.slice(0, 5)) lines.push('· ' + f.title);
  }
  lines.push('');
  lines.push('—— 本地中枢 ' + BASE);
  return lines.join('\n');
}

async function runBrief(manual) {
  const b = await getJson('/api/brief', 8000);
  if (!b) return { ok: false, reason: 'no-server' };
  const text = briefText(b);
  const cfg = readConfig();
  if (manual || (cfg.pushplus && cfg.pushplus.enabled)) await pushWeChat(text);
  if (Notification.isSupported()) {
    new Notification({ title: b.due.length ? '今天有 ' + b.due.length + ' 项要交' : '今天没有快到期的作业', body: text.split('\n').slice(0, 5).join('\n'), icon: path.join(__dirname, 'icon.png') })
      .show();
  }
  return { ok: true, text };
}

function scheduleDailyBrief() {
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const cfg = readConfig();
    const at = (cfg.pushplus && cfg.pushplus.time) || '08:30';
    const [hh, mm] = at.split(':').map(Number);
    if (now.getHours() === hh && now.getMinutes() === mm && lastNotifyDay !== day) {
      lastNotifyDay = day;
      await runBrief(false);
    }
  };
  setInterval(tick, 30 * 1000);
}

// 服务看门狗：应用开着的时候服务不该消失（手动 kill、崩溃都由它拉回来），每 45 秒看一次。
function startWatchdog() {
  let misses = 0;
  setInterval(async () => {
    if (quitting) return;
    if (notifyProc === null) ensureNotify();
    if (await serverAlive()) { misses = 0; return; }
    misses += 1;
    // 连续失败时只在第 1、5、10… 次重试，避免日志刷爆
    if (misses > 1 && misses % 5 !== 0) return;
    console.log('[watchdog] 服务没响应（连续第 ' + misses + ' 次），尝试重新拉起');
    const ok = await ensureServer();
    if (ok) misses = 0;
    if (!ok && Notification.isSupported()) {
      new Notification({ title: '天枢', body: '本地服务没起来，看 data/server.err.log', icon: path.join(__dirname, 'icon.png') }).show();
    }
  }, 45 * 1000);
}

function buildTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('天枢');
  const refresh = async () => {
    const b = await getJson('/api/brief', 4000);
    const n = b ? b.due.length : 0;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: n ? '今天 ' + n + ' 项待办' : '今天没有待办', enabled: false },
      { type: 'separator' },
      { label: '全息控制台（J.A.R.V.I.S）', click: () => createHolo() },
      { label: '悬浮小窗（今天）', click: toggleToday },
      { label: '打开中枢', click: () => createMain() },
      { label: '马上生成晨报', click: () => runBrief(true) },
      { label: '把今日行动清单推到微信', click: () => pushActions() },
      { type: 'separator' },
      { label: '抓钉钉窗口入库（Ctrl+Alt+D）', click: () => grabAndNotify('dingtalk') },
      { label: '抓微信窗口入库（Ctrl+Alt+W）', click: () => grabAndNotify('wechat') },
      { label: '导出 Obsidian 日报', click: () => runWriteback(false) },
      { type: 'separator' },
      {
        label: '开机自动启动', type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [path.resolve(__dirname), '--no-sandbox'] })
      },
      { label: '在文件夹里打开数据目录', click: () => shell.openPath(path.join(ROOT, 'data')) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.setToolTip(n ? '天枢 · 今天 ' + n + ' 项待办' : '天枢');
  };
  tray.on('click', toggleToday);
  refresh();
  setInterval(refresh, 10 * 60 * 1000);
}

// 单实例：不用 Chromium 自带的 requestSingleInstanceLock。
// 它会建锁文件 + 命名管道，权限稍微不对就 FATAL: platform_channel.cc(83) Check failed: 拒绝访问(0x5)，
// 表现为「双击完全没反应」（连窗口都不建、日志都来不及写）。换成自己的 pid 文件：
// 最坏情况是多开一个窗口，永远不会因为锁而崩。
let gotLock = true;
if (!app || typeof app.getPath !== 'function') {
  startupLog('致命：electron 模块没给出 app 对象（多半是环境里带了 ELECTRON_RUN_AS_NODE=1，被当成纯 Node 运行）');
  process.exit(1);
}
const LOCK_FILE = path.join(ROOT, 'data', '.desktop.pid');
// 唤醒通道：已有实例在后台时，再点一次桌面图标要能把窗口弹出来
const WAKE_FILE = path.join(ROOT, 'data', '.desktop-wake');
const WAKE_PIPE = '\\\\.\\pipe\\tianshu-' + String(process.env.USERNAME || 'user').replace(/[^\w-]/g, '_');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function requestWake(what) {
  // 双保险：唤醒文件（一定能写）+ 命名管道（立即生效）。已有实例收到任一个就把窗口弹出来。
  try { fs.writeFileSync(WAKE_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, what: what })); } catch {}
  let done = false;
  const finish = () => { if (!done) { done = true; process.exit(0); } };
  try {
    const sock = net.connect(WAKE_PIPE);
    sock.on('connect', () => { sock.write(what); setTimeout(() => sock.end(), 120); });
    sock.on('error', finish);
    sock.on('close', finish);
  } catch { finish(); }
  setTimeout(finish, 1500);
}
{
  let other = 0;
  try {
    const n = parseInt(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim(), 10);
    if (n && n !== process.pid && pidAlive(n)) other = n;
  } catch {}
  startupLog('单实例检查：' + (other ? ('已有实例 pid=' + other) : '没有其他实例') + '，锁文件=' + LOCK_FILE);
  if (other) {
    startupLog('已有实例在运行（pid=' + other + '），唤醒它的窗口后本实例退出');
    requestWake(process.argv.includes('--holo') ? 'holo' : 'main');
    return;
  }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { startupLog('写实例锁失败（忽略）：' + String(e)); }
  app.on('will-quit', () => {
    try { if (String(fs.readFileSync(LOCK_FILE, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch {}
  });
}
if (!gotLock) {
  startupLog('没有拿到单实例锁，直接退出');
  process.exit(0);
} else {
  app.on('second-instance', (_e, argv) => { startupLog('收到第二个实例的唤醒'); if ((argv || []).includes('--holo')) createHolo(); else createMain(); });
  app.on('child-process-gone', (_e, d) => startupLog('子进程退出 type=' + d.type + ' reason=' + d.reason + ' exitCode=' + d.exitCode));
  app.whenReady().then(async () => {
    startupLog('electron ready，开始初始化界面');
    app.setAppUserModelId('com.ctxhub.desktop');
    Menu.setApplicationMenu(null);
    ipcMain.handle('openDoc', async (_e, id) => {
      const w = await createMain();
      await w.loadURL(BASE + '/?doc=' + id);
      w.show();
      w.focus();
    });
    ipcMain.handle('openMain', async () => { const w = await createMain(); w.focus(); });
    ipcMain.handle('openHolo', async () => { await createHolo(); });
    ipcMain.handle('brief', async () => runBrief(false));
    ipcMain.handle('grabWindow', async (_e, appName) => grabAndNotify(appName === 'wechat' ? 'wechat' : 'dingtalk'));
    ipcMain.handle('writeback', async () => runWriteback(false));
    ipcMain.handle('quit', () => { quitting = true; app.quit(); });
    ipcMain.handle('minimizeToday', () => { if (todayWin) todayWin.hide(); });
    ipcMain.on('zoom', (e, dir) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      if (dir === 'in') zoomBy(win, 0.1);
      else if (dir === 'out') zoomBy(win, -0.1);
      else zoomReset(win);
    });
    // 无边框窗口自己的窗口按钮：最小化 / 最大化还原 / 关闭
    ipcMain.on('winAction', (e, act) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win || win.isDestroyed()) return;
      if (act === 'min') win.minimize();
      else if (act === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
      else if (act === 'close') { if (win === mainWin && !quitting) win.hide(); else win.close(); }
      startupLog('[窗口] ' + act);
    });
    try { buildTray(); startupLog('托盘已创建'); } catch (e) { startupLog('托盘创建失败：' + String(e)); }
    // 唤醒服务：后台安静运行时，用户再点图标 → 把主窗口弹到前台
    let wakeHandledAt = 0;
    const doWake = (what, from) => {
      if (Date.now() - wakeHandledAt < 1500) return;
      wakeHandledAt = Date.now();
      startupLog('收到唤醒请求（' + from + '）：' + what);
      if (String(what).includes('holo')) createHolo().catch((e) => startupLog('唤醒全息失败：' + String(e)));
      else createMain().catch((e) => startupLog('唤醒主窗失败：' + String(e)));
    };
    try {
      const wakeServer = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (d) => { buf += d; });
        sock.on('end', () => doWake(buf || 'main', '管道'));
      });
      wakeServer.on('error', (e) => startupLog('唤醒管道监听失败：' + String(e)));
      wakeServer.listen(WAKE_PIPE, () => startupLog('唤醒管道就绪'));
    } catch (e) { startupLog('唤醒管道创建失败：' + String(e)); }
    let lastWakeMs = 0;
    try { lastWakeMs = fs.statSync(WAKE_FILE).mtimeMs; } catch {}
    setInterval(() => {
      try {
        const st = fs.statSync(WAKE_FILE);
        if (st.mtimeMs > lastWakeMs + 300) {
          lastWakeMs = st.mtimeMs;
          let what = 'main';
          try { what = JSON.parse(fs.readFileSync(WAKE_FILE, 'utf8')).what || 'main'; } catch {}
          doWake(what, '文件');
        }
      } catch {}
    }, 1200);
    // 先出界面，再去确认/拉起本地服务：服务慢的时候不能让用户对着「点了没反应」的桌面发呆
    createToday().then(() => startupLog('今天小窗已创建')).catch((e) => startupLog('今天小窗失败：' + String(e)));
    if (process.argv.includes('--holo')) createHolo().catch((e) => startupLog('全息窗失败：' + String(e)));
    ensureServer().then((ok) => {
      startupLog('本地服务检查完成 ok=' + ok);
      if (!ok && Notification.isSupported()) {
        new Notification({ title: '天枢', body: '本地服务没起来，请检查 data/server.err.log' }).show();
      }
    });
    scheduleDailyBrief();
    startWatchdog();
    ensureNotify();
    startReminders();
    const r1 = globalShortcut.register('Control+Alt+T', toggleToday);
    const r2 = globalShortcut.register('Control+Alt+M', () => createMain());
    const r3 = globalShortcut.register('Control+Alt+H', () => createHolo());
    const r4 = globalShortcut.register('Control+Alt+D', () => grabAndNotify('dingtalk'));
    const r5 = globalShortcut.register('Control+Alt+W', () => grabAndNotify('wechat'));
    startupLog('快捷键 T=' + r1 + ' M=' + r2 + ' H=' + r3 + ' D=' + r4 + ' W=' + r5);
    process.on('unhandledRejection', (e) => startupLog('unhandledRejection ' + String(e)));
    process.on('uncaughtException', (e) => startupLog('uncaughtException ' + String(e && e.stack ? e.stack : e)));
    const marker = path.join(ROOT, 'data', '.desktop-inited');
    if (!fs.existsSync(marker)) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [path.resolve(__dirname), '--no-sandbox'] });
      try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
    }
  }).catch((e) => startupLog('whenReady 初始化失败：' + String(e && e.stack ? e.stack : e)));
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.on('before-quit', () => { quitting = true; });
}

