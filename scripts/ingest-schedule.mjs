#!/usr/bin/env node
/**
 * 把 data/schedule.json 渲染成一张课表并把整张课表作为一份资料入库（可被检索）。
 *
 *   node scripts/ingest-schedule.mjs            # 渲染 + 入库
 *   node scripts/ingest-schedule.mjs --dry      # 只打印，不入库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, openDb, ROOT } from '../src/db.mjs';
import { loadSchedule, weekNoOf, timeSpan } from '../src/schedule.mjs';
import { ingestFile } from '../src/ingest-file.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const DAY_NAME = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function md(sched) {
  const weekNo = weekNoOf(sched, new Date());
  const lines = [
    '# ' + (sched.data.term || '课表'),
    '',
    '- 学生：' + String((sched.data.meta && sched.data.meta.student) || '').replace(/课表$/, ''),
    '- 第 1 周周一：' + sched.anchor,
    '- 生成时间：' + new Date().toLocaleString('zh-CN'),
    '',
    '| 星期 | 节次 | 时间 | 课程 | 周次 | 地点 | 教师 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const courses = sched.data.courses.slice().sort((a, b) => a.day - b.day || a.startPeriod - b.startPeriod);
  for (const c of courses) {
    lines.push('| ' + [
      DAY_NAME[c.day], c.startPeriod + '-' + c.endPeriod + '节',
      timeSpan(c.startPeriod, c.endPeriod),
      c.course, c.weeks, c.room, c.teacher,
    ].join(' | ') + ' |');
  }
  lines.push('', '> 本周是第 ' + weekNo + ' 周。作息时间按学校默认节次估算，以教务系统为准。');
  return lines.join('\n');
}

function periodTime(n) {
  const t = {
    1: '08:00', 2: '08:55', 3: '10:00', 4: '10:55', 5: '13:30', 6: '14:25',
    7: '15:30', 8: '16:25', 9: '18:30', 10: '19:25', 11: '20:20', 12: '21:15',
  }[n];
  return t || '';
}

async function main() {
  const cfg = loadConfig();
  const sched = loadSchedule(cfg);
  if (!sched) {
    console.error('找不到 data/schedule.json，先跑 tools/timetable_parse.py');
    process.exit(1);
  }
  const body = md(sched);
  if (DRY) {
    console.log(body);
    return;
  }
  const dir = path.join(ROOT, 'data', 'files', 'schedule');
  fs.mkdirSync(dir, { recursive: true });
  const term = (sched.data.term || '课表').replace(/[\\/:*?"<>|]/g, '-');
  const file = path.join(dir, term + '-课表.md');
  fs.writeFileSync(file, body, 'utf8');
  const { db } = openDb(cfg);
  const r = await ingestFile({ db, cfg, filePath: file, source: 'fs', label: '课表', origName: path.basename(file) });
  console.log('入库 id=' + r.id + ' changed=' + r.changed + ' 标题=' + r.title + ' 字节=' + fs.statSync(file).size);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

