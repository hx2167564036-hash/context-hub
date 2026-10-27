#!/usr/bin/env node
/**
 * 清理自检产生的测试记录与落盘文件。
 * 只动明确带测试前缀的东西：标题以「手机测试-」「MCP 自测」开头，uri 是自检用的 note，
 * 或 uri 以 dingtalk://window/selftest / wechat://window/selftest 开头。
 * 用法：node scripts/clean-test.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, openDb } from '../src/db.mjs';

const dry = process.argv.includes('--dry');
const cfg = loadConfig();
const { db } = openDb(cfg);

const rows = db.prepare("SELECT id, uri, title FROM documents WHERE title LIKE '手机测试-%' OR title LIKE 'MCP 自测%' OR title LIKE '全息控制台自测%' OR uri LIKE 'note://holo/%' OR uri LIKE 'dingtalk://window/selftest%' OR uri LIKE 'wechat://window/selftest%'").all();
let docs = 0;
for (const r of rows) {
  console.log((dry ? '[dry] 将删除 ' : '删除 ') + r.id + ' ' + r.uri);
  if (dry) continue;
  db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(r.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(r.id);
  docs++;
  if (r.uri && path.isAbsolute(r.uri) && fs.existsSync(r.uri) && r.uri.startsWith(path.join(ROOT, 'data', 'files', 'phone'))) {
    try { fs.unlinkSync(r.uri); } catch { /* ignore */ }
  }
}

let files = 0;
const phoneRoot = path.join(ROOT, 'data', 'files', 'phone');
if (fs.existsSync(phoneRoot)) {
  for (const day of fs.readdirSync(phoneRoot)) {
    const dir = path.join(phoneRoot, day);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!/^(手机测试-|MCP 自测)/.test(f)) continue;
      console.log((dry ? '[dry] 将删文件 ' : '删文件 ') + path.join(day, f));
      if (!dry) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
      files++;
    }
  }
}

console.log(`完成：文档 ${docs} 条、文件 ${files} 个${dry ? '（dry）' : ''}；库内还剩 ${db.prepare('SELECT count(*) n FROM documents').get().n} 条`);
