import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/context.db');
const show = (t) => {
  const rows = db.prepare("select id, source, kind, uri, length(body) n, substr(doc_time,1,19) dt, substr(meta,1,90) m from documents where title like ?").all('%' + t + '%');
  console.log('==== ' + t + ' -> ' + rows.length);
  for (const r of rows.slice(0, 6)) console.log('  #' + r.id, r.source, r.kind, r.n, r.dt, '|', r.uri);
};
show('B/S架构应用开发 · 参考资料');
show('第1章 软件工程学概述(1)');
show('学在城院 misc');
