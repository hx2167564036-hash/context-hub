import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/context.db');
const rows = db.prepare("select title, meta from documents where kind in ('作业','考试')").all();
const withEnd = rows.map((r) => { try { return { ...r, meta: JSON.parse(r.meta || '{}') }; } catch { return { ...r, meta: {} }; } }).filter((r) => r.meta.endTime);
console.log('作业+考试', rows.length, '有截止', withEnd.length);
withEnd.sort((a, b) => Date.parse(b.meta.endTime) - Date.parse(a.meta.endTime));
for (const r of withEnd.slice(0, 10)) console.log(' ', r.meta.endTime, '|', r.title);
