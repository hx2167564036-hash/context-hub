import fs from 'node:fs';
import path from 'node:path';
const roots = [
  'C:\\Users\\kendle\\Documents\\WeChat Files',
  'D:\\电脑管家迁移文件\\xwechat_files'
];
for (const r of roots) {
  if (!fs.existsSync(r)) { console.log('不存在', r); continue; }
  const acc = [];
  const files = [];
  (function walk(d, depth) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else {
        let st; try { st = fs.statSync(p); } catch { continue; }
        files.push({ p, size: st.size, mtime: st.mtimeMs });
      }
    }
  })(r, 0);
  const byExt = new Map();
  let total = 0;
  for (const f of files) { const e = (path.extname(f.p) || '?').toLowerCase(); byExt.set(e, (byExt.get(e) || 0) + 1); total += f.size; }
  files.sort((a, b) => b.mtime - a.mtime);
  console.log('==== ' + r);
  console.log('  文件数', files.length, '| 合计', (total / 1024 / 1024).toFixed(1) + 'MB');
  console.log('  类型', JSON.stringify([...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)));
  console.log('  最近 12 个：');
  for (const f of files.slice(0, 12)) console.log('   ', new Date(f.mtime).toISOString().slice(0, 16), (f.size / 1024).toFixed(0) + 'KB', path.relative(r, f.p));
}
