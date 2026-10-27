#!/usr/bin/env node
// 清理已经收进来的营销 / 广告手机通知（按 src/notify-filter.mjs 的规则判定）。
//
//   node scripts/clean-notify.mjs            # 只看会删哪些，不真删
//   node scripts/clean-notify.mjs --apply    # 真删
//   node scripts/clean-notify.mjs --list     # 逐条列出保留 / 删除与理由
import { openDb, loadConfig } from '../src/db.mjs';
import { classifyNotification } from '../src/notify-filter.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIST = argv.includes('--list');

const cfg = loadConfig();
const { db } = openDb(cfg);
const opt = { filterAds: cfg.phone?.filterAds !== false, keepPkgs: cfg.phone?.keepPkgs, blockPkgs: cfg.phone?.blockPkgs };

const rows = db.prepare("SELECT id, title, meta, body FROM documents WHERE uri LIKE 'phone://notify/%' ORDER BY id").all();
const del = [];
const byApp = {};
const byReason = {};
let keep = 0;
for (const r of rows) {
  let meta = {};
  try { meta = JSON.parse(r.meta || '{}'); } catch { /* ignore */ }
  const lines = String(r.body || '').split('\n').filter((l) => !/^\[(应用|时间)\]/.test(l));
  const title = (lines[0] || '').trim();
  const text = lines.slice(1).join(' ').trim();
  const c = classifyNotification({ pkg: meta.pkg || '', app: meta.app || '', title, text }, opt);
  if (c.ad) {
    del.push(r.id);
    const app = meta.app || '未知';
    byApp[app] = (byApp[app] || 0) + 1;
    byReason[c.reason] = (byReason[c.reason] || 0) + 1;
    if (LIST) console.log(`DEL  #${r.id} ${app.padEnd(14)} ${c.reason.padEnd(18)} ${title.slice(0, 40)}`);
  } else {
    keep++;
    if (LIST) console.log(`KEEP #${r.id} ${(meta.app || '').padEnd(14)} ${c.reason.padEnd(18)} ${title.slice(0, 40)}`);
  }
}

console.log(`\n手机通知共 ${rows.length} 条：保留 ${keep}，过滤 ${del.length}`);
if (del.length) {
  console.log('按应用：' + Object.entries(byApp).map(([a, n]) => `${a} ${n}`).join(' / '));
  console.log('按原因：' + Object.entries(byReason).map(([a, n]) => `${a} ${n}`).join(' / '));
}

if (!del.length) process.exit(0);
if (!APPLY) {
  console.log('\n（预演模式，什么也没删。确认没问题后加 --apply 真删。）');
  process.exit(0);
}

const delFts = db.prepare('DELETE FROM docs_fts WHERE rowid = ?');
const delDoc = db.prepare('DELETE FROM documents WHERE id = ?');
db.exec('BEGIN');
try {
  for (const id of del) { delFts.run(id); delDoc.run(id); }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  throw e;
}
console.log(`\n已删除 ${del.length} 条营销通知。`);
const left = db.prepare("SELECT count(*) n FROM documents WHERE uri LIKE 'phone://notify/%'").get();
const total = db.prepare('SELECT count(*) n FROM documents').get();
console.log(`剩余手机通知 ${left.n} 条，库内共 ${total.n} 条。`);
