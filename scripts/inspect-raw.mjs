import fs from 'node:fs';
import path from 'node:path';
const dir = 'data/raw/hzcu';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 60);
for (const { f } of files) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const u = String(j.url || '');
  if (!/my-courses|announcement|notifications|my-semesters|my-departments/.test(u)) continue;
  console.log('===', u);
  const d = j.data;
  if (d && d.courses) {
    console.log('  courses:', d.courses.length);
    const c0 = d.courses[0] || {};
    console.log('  keys:', Object.keys(c0).slice(0, 18).join(','));
    console.log('  first:', JSON.stringify(c0).slice(0, 260));
  }
  console.log('  top keys:', d && typeof d === 'object' ? Object.keys(d).join(',') : typeof d);
  console.log('  head:', JSON.stringify(d).slice(0, 240));
}
