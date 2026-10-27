// 把 meida 返回的 PDF（原名是 ppt/doc/docx/xls）改名成 .pdf，并同步 tron_files.local_path
import fs from 'node:fs';
import path from 'node:path';
import { openDb, loadConfig } from '../src/db.mjs';

const cfg = loadConfig();
const { db } = openDb(cfg);
const BASE = path.join('data', 'files', 'hzcu');
const upd = db.prepare('update tron_files set local_path = ? where local_path = ?');
let renamed = 0;
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const ext = path.extname(p).toLowerCase();
    if (ext === '.pdf') continue;
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (!buf.toString('hex').startsWith('25504446')) continue;
    const base = p.slice(0, -ext.length);
    let dest = base + '.pdf';
    let n = 2;
    while (fs.existsSync(dest)) { dest = base + '(' + n + ').pdf'; n++; }
    fs.renameSync(p, dest);
    upd.run(dest, p);
    renamed++;
    console.log('[rename]', path.basename(p), '→', path.basename(dest));
  }
}
walk(BASE);
console.log('[rename] 完成', renamed);
