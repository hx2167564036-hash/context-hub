import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/context.db');
const rows = db.prepare('select name, url from tron_files where url is not null limit 3').all();
for (const r of rows) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(r.url, { method: 'GET', headers: { Range: 'bytes=0-2047' }, signal: ac.signal });
    const buf = await res.arrayBuffer();
    console.log(res.status, res.headers.get('content-type'), res.headers.get('content-length'), buf.byteLength, '|', r.name.slice(0, 40));
  } catch (e) {
    console.log('FAIL', r.name.slice(0, 30), String(e.message || e).slice(0, 100));
  } finally { clearTimeout(timer); }
}
