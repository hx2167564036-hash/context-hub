// 只读查询层：检索 / 时间线 / 到期 / 今日 / 统计。
// 从 server.mjs 抽出，供 HTTP 服务与 MCP（stdio + /mcp）共用，避免两套逻辑漂移。
import { tokenize, ftsQuery, snippet } from './tokenize.mjs';
import { loadSchedule, describeSchedule } from './schedule.mjs';

export function makeReader({ db, dbPath, cfg }) {
  let schedCache = null;
  let schedMtime = -1;

  /** 课表按 data/schedule.json 的 mtime 缓存，改完文件不用重启 */
  function sched() {
    const s = loadSchedule(cfg);
    if (!s) return null;
    if (s.mtime !== schedMtime) {
      schedMtime = s.mtime;
      schedCache = s;
    }
    return schedCache;
  }

  function mapRow(row, q) {
    return {
      id: row.id,
      title: row.title || '(无标题)',
      source: row.source,
      kind: row.kind,
      uri: row.uri,
      docTime: row.doc_time,
      size: row.size,
      score: row.score,
      meta: (() => { try { return JSON.parse(row.meta || '{}'); } catch { return {}; } })(),
      snippet: snippet(row.body || '', q || '', 180)
    };
  }

  /** 稀有度加权的关键词覆盖率：只保留「命中了真正有辨识度那些词」的文档 */
  function runLoose(expr, q, where, fargs) {
    const terms = [...new Set(tokenize(q))];
    if (!terms.length) return [];
    const dfStmt = db.prepare('SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH ?');
    const weight = new Map();
    let totalW = 0;
    for (const t of terms) {
      let df = 0;
      try { df = dfStmt.get('"' + t.replace(/"/g, '""') + '"').n; } catch { df = 0; }
      const w = 1 / Math.log(2 + df);
      weight.set(t, w);
      totalW += w;
    }
    const rows = db.prepare(
      'SELECT d.id, d.title, d.source, d.kind, d.uri, d.doc_time, d.size, d.body, d.meta, bm25(docs_fts) AS score ' +
      'FROM docs_fts JOIN documents d ON d.id = docs_fts.rowid ' +
      'WHERE docs_fts MATCH ?' + where + ' ORDER BY score LIMIT 300'
    ).all(expr, ...fargs);

    const scored = [];
    for (const r of rows) {
      const hay = String(r.title || '') + ' ' + String(r.body || '').slice(0, 60000);
      const low = hay.toLowerCase();
      let cov = 0;
      for (const t of terms) if (low.includes(t)) cov += weight.get(t);
      const ratio = cov / totalW;
      if (ratio > 0) scored.push({ row: r, ratio });
    }
    scored.sort((a, b) => b.ratio - a.ratio || a.row.score - b.row.score);
    const best = scored.length ? scored[0].ratio : 0;
    return scored.filter((s) => s.ratio >= Math.max(0.5, best * 0.75)).slice(0, 100).map((s) => s.row);
  }

  function search(params) {
    const q = (params.get('q') || '').trim();
    const source = params.get('source') || '';
    const kind = params.get('kind') || '';
    const limit = Math.min(Number(params.get('limit') || 40), 200);
    const offset = Math.max(Number(params.get('offset') || 0), 0);

    const filters = [];
    const fargs = [];
    if (source) { filters.push('d.source = ?'); fargs.push(source); }
    if (kind) { filters.push('d.kind = ?'); fargs.push(kind); }
    const tier = params.get('tier') || '';
    if (tier) { filters.push("json_extract(d.meta,'$.tier') = ?"); fargs.push(tier); }
    // days：只要最近 N 天的资料（0/缺省=不限）
    const days = Math.min(Number(params.get('days') || 0), 3650);
    if (days > 0) { filters.push('d.doc_time >= ?'); fargs.push(new Date(Date.now() - days * 86400000).toISOString()); }
    // 默认不显示接口载荷桩（tier=stub），需要时用 stub=1
    if (!params.get('stub')) filters.push("COALESCE(json_extract(d.meta,'$.tier'),'') <> 'stub'");
    // 空查询（浏览模式）默认只列「还可能有用的」：往期课程、过期作业折叠，需要时用 all=1
    if (!q && !tier && !params.get('all')) {
      filters.push("COALESCE(json_extract(d.meta,'$.tier'),'') NOT IN ('archive','expired')");
    }
    const where = filters.length ? ' AND ' + filters.join(' AND ') : '';

    if (!q) {
      const rows = db.prepare(
        'SELECT d.id, d.title, d.source, d.kind, d.uri, d.doc_time, d.size, d.body, d.meta, 0 AS score ' +
        "FROM documents d WHERE COALESCE(json_extract(d.meta,'$.dupOf'),'') = ''" + where + ' ORDER BY d.doc_time DESC NULLS LAST LIMIT ? OFFSET ?'
      ).all(...fargs, limit, offset);
      const total = db.prepare(
        "SELECT count(*) AS n FROM documents d WHERE COALESCE(json_extract(d.meta,'$.dupOf'),'') = ''" + where
      ).get(...fargs).n;
      const allTotal = db.prepare(
        "SELECT count(*) AS n FROM documents d WHERE COALESCE(json_extract(d.meta,'$.dupOf'),'') = ''" +
        " AND COALESCE(json_extract(d.meta,'$.tier'),'') <> 'stub'"
      ).get().n;
      return { total, allTotal, hits: rows.map((r) => mapRow(r, '')) };
    }

    const expr = ftsQuery(q);
    if (!expr) return { total: 0, hits: [] };
    try {
      const run = (e) => {
        const rows = db.prepare(
          'SELECT d.id, d.title, d.source, d.kind, d.uri, d.doc_time, d.size, d.body, d.meta, bm25(docs_fts) AS score ' +
          'FROM docs_fts JOIN documents d ON d.id = docs_fts.rowid ' +
          'WHERE docs_fts MATCH ?' + where + ' ORDER BY score LIMIT ? OFFSET ?'
        ).all(e, ...fargs, limit, offset);
        const total = db.prepare(
          'SELECT count(*) AS n FROM docs_fts JOIN documents d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ?' + where
        ).get(e, ...fargs).n;
        return { total, rows };
      };
      const strict = run(expr);
      if (strict.total > 0) return { total: strict.total, hits: strict.rows.map((r) => mapRow(r, q)) };

      // 严格匹配没有结果：放宽成「任一关键词命中」，再按词的重要程度（稀有度加权覆盖率）排序过滤
      const orExpr = ftsQuery(q, 24, ' OR ');
      if (orExpr && orExpr !== expr) {
        const ranked = runLoose(orExpr, q, where, fargs);
        if (ranked.length) return { total: ranked.length, hits: ranked.map((r) => mapRow(r, q)) };
        const looseRows = db.prepare(
          'SELECT d.id, d.title, d.source, d.kind, d.uri, d.doc_time, d.size, d.body, d.meta, bm25(docs_fts) AS score ' +
          'FROM docs_fts JOIN documents d ON d.id = docs_fts.rowid ' +
          'WHERE docs_fts MATCH ?' + where + ' ORDER BY score LIMIT 20'
        ).all(orExpr, ...fargs);
        if (looseRows.length) return { total: looseRows.length, loose: true, hits: looseRows.map((r) => mapRow(r, q)) };
      }
      return { total: 0, hits: [] };
    } catch (err) {
      console.warn('[search] FTS 查询失败，退化为 LIKE:', err.message);
    }
    // 退化：LIKE 匹配（单字或特殊查询）
    const like = '%' + q + '%';
    const rows = db.prepare(
      'SELECT d.id, d.title, d.source, d.kind, d.uri, d.doc_time, d.size, d.body, d.meta, 0 AS score ' +
      'FROM documents d WHERE (d.title LIKE ? OR d.body LIKE ?)' + where +
      ' ORDER BY d.doc_time DESC LIMIT ? OFFSET ?'
    ).all(like, like, ...fargs, limit, offset);
    return { total: rows.length, hits: rows.map((r) => mapRow(r, q)) };
  }

  function timeline(params) {
    const days = Math.min(Number(params.get('days') || 30), 3650);
    const source = params.get('source') || '';
    const hide = String(params.get('hide') || 'archive,expired,stub')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const filters = ["doc_time >= ?", "COALESCE(json_extract(meta,'$.dupOf'),'') = ''"];
    const args = [new Date(Date.now() - days * 86400000).toISOString()];
    if (source) { filters.push('source = ?'); args.push(source); }
    if (hide.length) {
      filters.push("COALESCE(json_extract(meta,'$.tier'),'') NOT IN (" + hide.map(() => '?').join(',') + ')');
      args.push(...hide);
    }
    const rows = db.prepare(
      'SELECT id, title, source, kind, uri, doc_time, size, meta FROM documents WHERE ' +
      filters.join(' AND ') + ' ORDER BY doc_time DESC LIMIT 2000'
    ).all(...args);
    const groups = new Map();
    for (const r of rows) {
      const d = (r.doc_time || '').slice(0, 10) || '未知日期';
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push({ ...r, meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })() });
    }
    return { days, hidden: hide, total: rows.length, groups: [...groups.entries()].map(([date, items]) => ({ date, items })) };
  }

  /** 近期截止：作业/考试的活动结束时间在窗口内 */
  function due(params) {
    const days = Math.min(Math.max(Number(params.get('days') || 14), 1), 120);
    const includePast = params.get('past') === '1';
    const now = Date.now();
    const rows = db.prepare(
      "SELECT id, title, kind, doc_time, meta FROM documents WHERE kind IN ('作业','考试') AND COALESCE(json_extract(meta,'$.dupOf'),'') = ''"
    ).all();
    const out = [];
    for (const r of rows) {
      let meta = {};
      try { meta = JSON.parse(r.meta || '{}'); } catch { continue; }
      const end = meta.endTime ? Date.parse(meta.endTime) : NaN;
      if (!Number.isFinite(end)) continue;
      const diff = end - now;
      if (diff < (includePast ? -7 * 864e5 : -3600e3)) continue;
      if (diff > days * 864e5) continue;
      out.push({
        id: r.id, title: r.title, kind: meta.activityType === 'exam' || /考试/.test(String(meta.courseName || '')) ? '考试' : r.kind,
        course: meta.courseName || '', endTime: meta.endTime, startTime: meta.startTime || null,
        hoursLeft: Math.round(diff / 3600000), overdue: diff < 0,
        files: Array.isArray(meta.files) ? meta.files.map((f) => f.name) : []
      });
    }
    out.sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime));
    return { days, count: out.length, items: out };
  }

  /** 某节课在指定日期的开始时间（毫秒）。c.start 形如 '10:00' */
  function classStartAt(c, day) {
    const m = String(c.start || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }

  /**
   * 提醒候选：今天还没开始的课 + 未过期的 DDL。
   * 供桌面端每分钟轮询（拿到 minutes 后自己决定弹不弹）。
   */
  function reminders(params) {
    const within = Math.min(Math.max(Number(params.get('within') || 180), 1), 4320);
    const now = Date.now();
    const limit = now + within * 60000;
    const items = [];
    try {
      const day = new Date(now);
      const list = describeSchedule(sched(), day).classes || [];
      for (const c of list) {
        const t = classStartAt(c, day);
        if (!Number.isFinite(t) || t <= now || t > limit) continue;
        items.push({
          key: 'class:' + day.toISOString().slice(0, 10) + ':' + c.course + ':' + c.start,
          kind: 'class', title: c.course,
          at: new Date(t).toISOString(), minutes: Math.round((t - now) / 60000),
          detail: c.time + ' · ' + c.periods + ' · ' + c.room,
          teacher: c.teacher || '',
        });
      }
    } catch { /* 课表坏了不影响 DDL 提醒 */ }
    try {
      const list = due({ get: (k) => (k === 'days' ? '4' : k === 'past' ? '0' : null) }).items || [];
      for (const it of list) {
        const t = Date.parse(it.endTime);
        if (!Number.isFinite(t) || t <= now || t > limit) continue;
        items.push({
          key: 'ddl:' + it.id,
          kind: 'ddl', id: it.id, title: it.title, course: it.course,
          at: new Date(t).toISOString(), minutes: Math.round((t - now) / 60000),
          detail: (it.course ? it.course + ' · ' : '') + '截止 ' + it.endTime,
        });
      }
    } catch { /* 单个来源失败不影响整体 */ }
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { now: new Date(now).toISOString(), within, count: items.length, items };
  }

  /** 可执行清单（纯文本/Markdown），给微信推送和托盘复制用 */
  function actions() {
    const b = brief();
    const now = new Date();
    const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    const lines = [];
    lines.push('天枢 · 今日行动 ' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + dayName);
    const sch = b.schedule || { weekNo: 0, classes: [] };
    if (sch.classes && sch.classes.length) {
      lines.push('');
      lines.push('【今天的课】');
      for (const c of sch.classes) lines.push('- ' + c.time + ' ' + c.course + ' · ' + c.room + (c.teacher ? ' · ' + c.teacher : ''));
    }
    const ddls = (b.due || []).slice(0, 8);
    if (ddls.length) {
      lines.push('');
      lines.push('【要交的】');
      for (const d of ddls) {
        const when = d.overdue ? '已过截止' : '还剩 ' + (d.hoursLeft < 48 ? d.hoursLeft + ' 小时' : Math.round(d.hoursLeft / 24) + ' 天');
        lines.push('- ' + d.title + (d.course ? '（' + d.course + '）' : '') + ' · ' + when + ' · 截止 ' + (d.endTime || ''));
      }
    }
    const fresh = (b.fresh || []).slice(0, 5);
    if (fresh.length) {
      lines.push('');
      lines.push('【最近进的资料】');
      for (const f of fresh) lines.push('- ' + f.title);
    }
    lines.push('');
    lines.push('完整视图：http://127.0.0.1:7311/today.html');
    return { text: lines.join('\n'), due: ddls.length, classes: (sch.classes || []).length };
  }

  /** 晨报/今日视图：到期 + 本周课程活动 + 近两天新进 */
  function brief() {
    const LIVE = "COALESCE(json_extract(meta,'$.dupOf'),'') = ''";
    const rows = db.prepare(
      'SELECT id, title, source, kind, doc_time, meta FROM documents WHERE ' + LIVE +
      " AND json_extract(meta,'$.tier') <> 'stub'"
    ).all();
    const now = Date.now();
    const parse = (r) => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } };
    const dueItems = [];
    const week = [];
    const fresh = [];
    const d = new Date();
    const dow = (d.getDay() + 6) % 7;               // 周一=0
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow, 0, 0, 0, 0).getTime();
    const weekEnd = monday + 7 * 864e5;
    for (const r of rows) {
      const m = parse(r);
      const end = m.endTime ? Date.parse(m.endTime) : NaN;
      const start = m.startTime ? Date.parse(m.startTime) : NaN;
      if (Number.isFinite(end)) {
        const diff = end - now;
        if (diff > -3600e3 && diff < 14 * 864e5) {
          dueItems.push({ id: r.id, title: r.title, course: m.courseName || '', endTime: m.endTime,
            hoursLeft: Math.round(diff / 36e5), overdue: diff < 0,
            files: Array.isArray(m.files) ? m.files.map((f) => f.name) : [] });
        }
      }
      const t = Number.isFinite(start) ? start : (Number.isFinite(end) ? end : NaN);
      if (Number.isFinite(t) && t >= monday && t < weekEnd && ['课件', '作业', '考试', '章节', '讨论'].includes(r.kind)) {
        week.push({ id: r.id, title: r.title, course: m.courseName || '', kind: r.kind,
          startTime: m.startTime || null, endTime: m.endTime || null, at: new Date(t).toISOString() });
      }
      const dt = Date.parse(r.doc_time);
      if (Number.isFinite(dt) && now - dt < 3 * 864e5 && m.tier !== 'archive' && m.tier !== 'expired' && r.source !== 'hzcu') {
        fresh.push({ id: r.id, title: r.title, source: r.source, kind: r.kind, docTime: r.doc_time });
      }
    }
    dueItems.sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime));
    week.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    fresh.sort((a, b) => String(b.docTime).localeCompare(String(a.docTime)));
    let curCourses = 0;
    try { curCourses = db.prepare("SELECT count(*) c FROM tron_courses WHERE year LIKE '%2026-2027%'").get().c; } catch { /* ignore */ }
    return {
      generatedAt: new Date().toISOString(),
      hours: d.getHours(),
      due: dueItems,
      week: week.slice(0, 40),
      fresh: fresh.slice(0, 20),
      schedule: describeSchedule(sched(), d),
      stats: { currentCourses: curCourses, totalLive: rows.length }
    };
  }

  function stats() {
    const LIVE = "COALESCE(json_extract(meta,'$.dupOf'),'') = ''";
    const total = db.prepare('SELECT count(*) AS n, sum(size) AS bytes FROM documents WHERE ' + LIVE).get();
    const bySource = db.prepare('SELECT source, count(*) AS n FROM documents WHERE ' + LIVE + ' GROUP BY source ORDER BY n DESC').all();
    const byKind = db.prepare('SELECT kind, count(*) AS n FROM documents WHERE ' + LIVE + ' GROUP BY kind ORDER BY n DESC LIMIT 15').all();
    const latest = db.prepare('SELECT max(doc_time) AS t FROM documents WHERE ' + LIVE).get();
    const byTier = db.prepare("SELECT COALESCE(json_extract(meta,'$.tier'),'') AS tier, count(*) AS n FROM documents WHERE " + LIVE + ' GROUP BY tier ORDER BY n DESC').all();
    return { total: total.n, bytes: total.bytes || 0, bySource, byKind, byTier, latest: latest.t, dbPath };
  }

  return { mapRow, search, timeline, due, brief, stats, reminders, actions };
}

