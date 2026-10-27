#!/usr/bin/env node
// 后台启动中枢服务（真正脱离当前控制台/进程树，避免被 Ctrl+C 或任务回收带走）。
// 用法：
//   node scripts/start-server.mjs            启动 7311（已在跑则直接返回 0）
//   node scripts/start-server.mjs 7312       指定端口
// 日志：data/server.out.log / data/server.err.log
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || process.argv[2] || 7311);

function ping(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/stats', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

if (await ping(port)) {
  console.log(`[start] 端口 ${port} 已有服务在跑，无需启动`);
  process.exit(0);
}

const out = fs.openSync(path.join(ROOT, 'data', 'server.out.log'), 'a');
const err = fs.openSync(path.join(ROOT, 'data', 'server.err.log'), 'a');
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true,
  env: { ...process.env, PORT: String(port) },
});
child.unref();
console.log(`[start] 已后台拉起 node src/server.mjs（pid ${child.pid}，端口 ${port}）`);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 400));
  if (await ping(port)) {
    console.log('[start] 健康检查通过，服务已在后台运行');
    process.exit(0);
  }
}
console.error('[start] 12 秒内未响应 /api/stats，请查看 data/server.err.log');
process.exit(1);
