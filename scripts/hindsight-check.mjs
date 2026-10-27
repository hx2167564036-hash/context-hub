#!/usr/bin/env node
/**
 * Hindsight 本地记忆服务自检：
 *   1. 配置文件是否存在、是否被 BOM 污染、是否指向 daemon
 *   2. daemon 是否健康（/health）
 *   3. 这个仓库对应的 bank 里有多少条事实
 *
 * 用法：node scripts/hindsight-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = process.env.HINDSIGHT_CONFIG || path.join(os.homedir(), '.hindsight', 'coding-agent.json');
const BANK = process.env.HINDSIGHT_BANK || 'coding-agent::应用信息互联';
let bad = 0;
const ok = (label, detail = '') => console.log('  [OK]  ' + label + (detail ? ' — ' + detail : ''));
const no = (label, detail = '') => { bad++; console.log('  [!!]  ' + label + (detail ? ' — ' + detail : '')); };

console.log('配置文件：' + CONFIG);
let cfg = null;
if (!fs.existsSync(CONFIG)) {
  no('配置文件不存在', '插件会退回云端并 401');
} else {
  const buf = fs.readFileSync(CONFIG);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) no('配置带 UTF-8 BOM', 'JSON.parse 会失败 → 静默退回云端；请重写为无 BOM');
  else ok('无 BOM');
  try {
    cfg = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
    ok('JSON 可解析', JSON.stringify(cfg));
  } catch (e) {
    no('JSON 解析失败', e.message);
  }
  if (cfg) {
    if (cfg.serverMode === 'daemon') ok('serverMode=daemon', 'apiPort=' + (cfg.apiPort || '默认'));
    else no('serverMode 不是 daemon', '当前 ' + cfg.serverMode);
  }
}

const port = cfg?.apiPort || 9077;
const base = 'http://127.0.0.1:' + port;
try {
  const h = await (await fetch(base + '/health', { signal: AbortSignal.timeout(5000) })).json();
  ok('daemon /health', h.status + ' · database=' + h.database);
  const banks = await (await fetch(base + '/v1/default/banks', { signal: AbortSignal.timeout(10000) })).json();
  const mine = (banks.banks || []).find((b) => b.bank_id === BANK);
  if (mine) ok('本仓库的 bank', BANK + ' · ' + (mine.fact_count ?? 0) + ' 条事实');
  else no('本仓库的 bank 还不存在', '第一次写入时会自动建：' + BANK);
} catch (e) {
  no('daemon 连不上', base + ' — ' + (e.message || e));
  console.log('       启动：wscript "D:\\应用信息互联\\scripts\\hindsight-daemon.vbs"');
}

console.log(bad === 0 ? '\n全部正常：DSH 里的 🧠 记忆会写进本机库。' : '\n发现 ' + bad + ' 个问题，见上面 [!!]。');
process.exit(bad === 0 ? 0 : 1);
