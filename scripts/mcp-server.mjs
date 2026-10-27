#!/usr/bin/env node
// MCP stdio 服务：让 Claude Desktop / Cursor / 任何 MCP 客户端直接读用户的本机中枢。
//
// 客户端配置（Claude Desktop 的 claude_desktop_config.json）：
//   "mcpServers": {
//     "context-hub": { "command": "node", "args": ["D:/应用信息互联/scripts/mcp-server.mjs"] }
//   }
//
// 协议：JSON-RPC 2.0 over stdio（一行一条，兼容 Content-Length 分帧）。
// 零第三方依赖，直接打开同一个 SQLite（WAL，可与网页服务并存）。
import process from 'node:process';
import { attachStdio } from '../src/mcp-stdio.mjs';
import { openDb, loadConfig } from '../src/db.mjs';
import { makeReader } from '../src/hub-read.mjs';
import { makeMcp } from '../src/mcp-tools.mjs';

const cfg = loadConfig();
const { db, dbPath } = openDb(cfg);
const reader = makeReader({ db, dbPath, cfg });
const mcp = makeMcp({ db, cfg, reader });

function log(...a) {
  try { process.stderr.write('[mcp] ' + a.join(' ') + '\n'); } catch { /* ignore */ }
}

const link = attachStdio({ mcp, input: process.stdin, output: process.stdout, log });

process.stdin.on('end', () => { log('stdin 关闭，退出'); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)));

log('已启动 | 库 ' + dbPath + ' | 工具 ' + mcp.tools.length + ' 个：' + mcp.tools.map((t) => t.name).join(', '));
void link;
