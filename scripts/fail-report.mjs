import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/context.db');
const rows = db.prepare("select id, title, kind, length(body) n, uri, substr(meta,1,160) m from documents where title like '%文献综述%' or title like '%实验报告模板-B01116%'").all();
console.log(JSON.stringify(rows, null, 1).slice(0, 2000));
