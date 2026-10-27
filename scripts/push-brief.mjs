// 晨报推微信（PushPlus）：node scripts/push-brief.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const token = (cfg.pushplus && cfg.pushplus.token) || process.env.PUSHPLUS_TOKEN || '';
const dry = process.argv.includes('--dry');

async function loadBrief() {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch('http://127.0.0.1:7311/api/brief');
      if (r.ok) return await r.json();
    } catch {}
    if (i === 0) {
      // 服务没起来就顺手拉起来（计划任务在开机后可能先于桌面端运行）
      try {
        const { spawn } = await import('node:child_process');
        const fsx = await import('node:fs');
        fsx.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
        const out = fsx.openSync(path.join(ROOT, 'data', 'server.out.log'), 'a');
        const err = fsx.openSync(path.join(ROOT, 'data', 'server.err.log'), 'a');
        spawn(process.env.CTXHUB_NODE || 'node', ['src/server.mjs'], { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', out, err] }).unref();
        console.log('[brief] 本地服务没在跑，已后台启动，等它就绪…');
      } catch (e) { console.error('[brief] 启动服务失败：' + e); }
      for (let k = 0; k < 30; k++) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

const b = await loadBrief();
if (!b) { console.error('[brief] 本地服务没起来，先启动 node src/server.mjs'); process.exit(1); }

const lines = [];
const d = new Date();
lines.push('【' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 天枢】');
if (b.due.length) {
  lines.push('今天有 ' + b.due.length + ' 项要交：');
  for (const it of b.due.slice(0, 8)) {
    const h = it.hoursLeft;
    const when = h < 0 ? '已过期' : h < 24 ? '剩' + h + '小时' : '剩' + Math.round(h / 24) + '天';
    const t = new Date(it.endTime);
    const hm = ((t.getMonth() + 1) + '-' + t.getDate()).padStart(0) + ' ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    lines.push('· ' + it.title + '（' + it.course + '，' + when + '，截止 ' + hm + '）');
    if (it.files && it.files.length) lines.push('  附件：' + it.files.join('、'));
  }
} else {
  lines.push('今天没有快到期的作业。');
}
if (b.week.length) {
  lines.push('');
  lines.push('本周有 ' + b.week.length + ' 项课程活动：');
  for (const w of b.week.slice(0, 6)) lines.push('· ' + w.title + '（' + w.kind + '）');
}
if (b.fresh.length) {
  lines.push('');
  lines.push('最近进库 ' + b.fresh.length + ' 条：');
  for (const f of b.fresh.slice(0, 5)) lines.push('· ' + f.title);
}
lines.push('');
lines.push('打开中枢：http://127.0.0.1:7311');
const content = lines.join('\n');
console.log(content);

if (dry) process.exit(0);
if (!token) {
  console.error('\n[push] 还没配置 PushPlus token：在 config.json 里加 "pushplus": { "token": "你的token", "enabled": true }');
  process.exit(2);
}
const r = await fetch('http://www.pushplus.plus/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, title: '今天的天枢', content, template: 'txt' })
});
console.log('\n[push] ' + (await r.text()));
