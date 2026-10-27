import fs from 'node:fs';
import path from 'node:path';
const BASE = path.join('data', 'files', 'hzcu');
const out = new Map();
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(8);
      fs.readSync(fd, buf, 0, 8, 0);
      fs.closeSync(fd);
      const hex = buf.toString('hex');
      const ext = path.extname(p).toLowerCase();
      let real = 'other';
      if (hex.startsWith('25504446')) real = '.pdf';
      else if (hex.startsWith('504b0304')) real = '.zip';
      else if (hex.startsWith('d0cf11e0')) real = '.cfb';
      else if (hex.startsWith('89504e47')) real = '.png';
      else if (hex.startsWith('ffd8ff')) real = '.jpg';
      const key = ext + ' -> ' + real;
      out.set(key, (out.get(key) || 0) + 1);
    }
  }
}
walk(BASE);
for (const [k, v] of [...out.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k);
