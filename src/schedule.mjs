import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.mjs';

// 城院作息：每节 45 分钟，按上/下午/晚上三段排
const PERIOD_TIME = {
  1: ['08:00', '08:45'], 2: ['08:55', '09:40'],
  3: ['10:00', '10:45'], 4: ['10:55', '11:40'],
  5: ['13:30', '14:15'], 6: ['14:25', '15:10'],
  7: ['15:30', '16:15'], 8: ['16:25', '17:10'],
  9: ['18:30', '19:15'], 10: ['19:25', '20:10'],
  11: ['20:20', '21:05'], 12: ['21:15', '22:00'],
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 上午 1-4 节、下午 5-8 节、晚上 9-12 节；跨段（比如 3-5 节）要分两截显示
const SEGMENTS = [[1, 4], [5, 8], [9, 12]];

export function timeSpan(a, b) {
  const parts = [];
  for (const [lo, hi] of SEGMENTS) {
    const s = Math.max(a, lo);
    const e = Math.min(b, hi);
    if (s > e) continue;
    const st = (PERIOD_TIME[s] || [])[0];
    const en = (PERIOD_TIME[e] || [])[1];
    if (st && en) parts.push(st + '–' + en);
  }
  return parts.join(' / ');
}

function parseWeeks(text) {
  // "1-3周,5-17周" / "第18周" / "3-5周(单),6-13周" / "1周,4-6周,8-15周,17周" / "第4周"
  const out = [];
  for (const raw of String(text || '').split(/[,，;；]/)) {
    const tok = raw.trim().replace(/^第/, '');
    if (!tok) continue;
    const odd = /[(（]单[)）]|单周/.test(tok);
    const even = /[(（]双[)）]|双周/.test(tok);
    const m = tok.match(/(\d+)\s*(?:[-–~]\s*(\d+))?/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    out.push({ from: Math.min(a, b), to: Math.max(a, b), odd, even });
  }
  return out;
}

function weekMatch(weeks, weekNo) {
  for (const w of weeks) {
    if (weekNo < w.from || weekNo > w.to) continue;
    if (w.odd && weekNo % 2 === 0) continue;
    if (w.even && weekNo % 2 === 1) continue;
    return true;
  }
  return false;
}

function toDay(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function loadSchedule(cfg) {
  const file = path.join(ROOT, (cfg && cfg.schedule && cfg.schedule.file) || 'data/schedule.json');
  try {
    const st = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const anchor = (cfg && cfg.schedule && cfg.schedule.week1Monday) || '2026-09-14';
    return { file, mtime: st.mtimeMs, data, anchor, week1: toDay(anchor) };
  } catch {
    return null;
  }
}

export function weekNoOf(sched, date) {
  const d = toDay(date);
  const a = new Date(sched.week1);
  const d0 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dd = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((dd - d0) / 86400000 / 7) + 1;
}

function hm(list, i) {
  return (PERIOD_TIME[i] || ['', ''])[list];
}

export function classesOn(sched, date) {
  if (!sched) return [];
  const d = toDay(date);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const weekNo = weekNoOf(sched, d);
  const list = [];
  for (const c of sched.data.courses || []) {
    if (c.day !== day) continue;
    if (!weekMatch(parseWeeks(c.weeks), weekNo)) continue;
    list.push({
      course: c.course,
      periods: c.startPeriod + '-' + c.endPeriod + '节',
      time: timeSpan(c.startPeriod, c.endPeriod),
      start: hm(0, c.startPeriod),
      end: hm(1, c.endPeriod),
      startPeriod: c.startPeriod,
      endPeriod: c.endPeriod,
      room: c.room,
      teacher: c.teacher,
      weeks: c.weeks,
    });
  }
  list.sort((a, b) => a.startPeriod - b.startPeriod);
  return list;
}

export function describeSchedule(sched, date) {
  if (!sched) return { weekNo: 0, dayName: '', classes: [] };
  const d = toDay(date);
  return {
    weekNo: weekNoOf(sched, d),
    dayName: DAY_NAMES[d.getDay()],
    classes: classesOn(sched, d),
  };
}
