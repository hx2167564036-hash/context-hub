// 生成桌面端图标：圆角方块 + 三条信息流
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const px = new Uint8Array(S * S * 4);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const R = 56;
function inRound(x, y) {
  const rx = Math.min(x, S - 1 - x);
  const ry = Math.min(y, S - 1 - y);
  if (rx >= R || ry >= R) return rx >= 0 && ry >= 0;
  const dx = R - rx, dy = R - ry;
  return dx * dx + dy * dy <= R * R;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRound(x, y)) { set(x, y, 0, 0, 0, 0); continue; }
    const t = (x + y) / (2 * S);
    const r = Math.round(59 + (37 - 59) * t);
    const g = Math.round(130 + (99 - 130) * t);
    const b = Math.round(246 + (235 - 246) * t);
    set(x, y, r, g, b, 255);
  }
}

// 三条“消息流”：一个圆点 + 一条横杠
const rows = [
  { y: 84, w: 96, dot: true },
  { y: 128, w: 64, dot: false },
  { y: 172, w: 80, dot: true }
];
for (const row of rows) {
  for (let yy = row.y - 7; yy <= row.y + 7; yy++) {
    for (let xx = 64; xx < 64 + row.w; xx++) {
      const yy2 = yy - row.y;
      if (yy2 * yy2 > 49) continue;
      set(xx, yy, 255, 255, 255, 235);
    }
  }
  if (row.dot) {
    for (let yy = -11; yy <= 11; yy++) {
      for (let xx = -11; xx <= 11; xx++) {
        if (xx * xx + yy * yy > 121) continue;
        set(38 + xx, row.y + yy, 12, 16, 24, 255);
      }
    }
  }
}

function png(w, h, data) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const buf = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(buf) >>> 0);
    return Buffer.concat([len, buf, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TBL[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const out = png(S, S, px);
fs.writeFileSync(new URL('./icon.png', import.meta.url), out);
// ICO：内嵌 PNG 负载
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(out.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(new URL('./icon.ico', import.meta.url), Buffer.concat([ico, out]));
console.log('icon.png', out.length, 'bytes');
