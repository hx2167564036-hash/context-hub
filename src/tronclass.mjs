// 学在城院 TronClass 接口解析：把原始 JSON 变成结构化文档（课程/章节/课件/作业/考试/讨论）。
import crypto from 'node:crypto';

const KIND_BY_TYPE = {
  material: '课件',
  homework: '作业',
  exam: '考试',
  forum: '讨论',
  quiz: '测验',
  rollcall: '点名',
  live: '直播',
  video: '视频'
};

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripOrigin(url) {
  return String(url || '').replace(/^https?:\/\/[^/]+/, '');
}

function pathOf(url) {
  return stripOrigin(url).split('?')[0];
}

function courseNameOf(db, courseId) {
  if (!courseId) return '';
  try {
    const row = db.prepare('SELECT name FROM tron_courses WHERE id = ?').get(Number(courseId));
    return row ? String(row.name || '') : '';
  } catch {
    return '';
  }
}

function upsertCourse(db, c) {
  if (!c || !c.id) return;
  db.prepare(`INSERT INTO tron_courses (id, name, code, year, teacher, start_date, end_date, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, year=excluded.year,
      teacher=excluded.teacher, start_date=excluded.start_date, end_date=excluded.end_date, updated_at=excluded.updated_at`).run(
    Number(c.id), String(c.name || ''), String(c.code || ''), String(c.year || ''),
    String(c.teacher || ''), c.startDate || null, c.endDate || null, new Date().toISOString()
  );
}

function teacherNames(course) {
  const list = course.teachers || course.teacher_infos || [];
  return (Array.isArray(list) ? list : []).map((t) => t.name || t.display_name || '').filter(Boolean).join('、');
}

const IGNORE_PREFIXES = [
  '/api/my-semesters', '/api/my-departments', '/api/air-credit', '/orgs/',
  '/api/config', '/api/links', '/api/profile', '/api/groups', '/api/notes',
  '/api/course/activities-read', '/api/uploads/org/arrears', '/api/courseware-quiz',
  '/api/subject-libs', '/api/classrooms', '/api/air-credit', '/api/orgs/',
  '/api/course/activity-publish-setting', '/api/activities/'
];

function isIgnored(p) {
  if (!p || p === '/' || p === '/api' || p === '/api/') return true;
  if (p.startsWith('/api?')) return true;
  return IGNORE_PREFIXES.some((x) => p === x || p.startsWith(x));
}

function saveCourse(db, c) {
  if (!c || !c.id) return;
  upsertCourse(db, {
    id: c.id,
    name: c.display_name || c.name || '',
    code: c.course_code || '',
    year: c.academic_year && c.academic_year.name ? c.academic_year.name : (c.academic_year_id || ''),
    teacher: teacherNames(c),
    startDate: iso(c.start_date), endDate: iso(c.end_date)
  });
}

function courseDoc(c, url, now) {
  const name = c.display_name || c.name || '';
  const body = [
    '课程：' + name,
    '课程代码：' + (c.course_code || ''),
    '学年：' + ((c.academic_year && c.academic_year.name) || c.academic_year_id || ''),
    '教师：' + teacherNames(c),
    '学分：' + (c.credit == null ? '' : c.credit),
    '开课：' + (c.start_date || '') + ' 至 ' + (c.end_date || ''),
    '学院：' + ((c.department && c.department.name) || ''),
    '类型：' + (c.course_type || '') + ' 阶段：' + (c.grade || ''),
    '[来源] ' + url
  ].join('\n');
  return {
    source: 'hzcu', kind: '课程', uri: 'tron://course/' + c.id,
    title: '课程 · ' + name, body, ext: 'json', size: body.length,
    mtime: now, docTime: iso(c.start_date) || now, hash: hash(body),
    meta: { label: '学在城院', courseId: Number(c.id), courseName: name, courseCode: c.course_code || '', credit: c.credit == null ? null : c.credit, url }
  };
}

export function parseTronClass(db, url, data) {
  const p = pathOf(url);
  const docs = [];
  const files = [];
  const now = new Date().toISOString();

  const mActivityList = p.match(/^\/api\/courses\/(\d+)\/activities$/);
  const mModules = p.match(/^\/api\/courses\/(\d+)\/modules$/);
  const mExams = p.match(/^\/api\/courses\/(\d+)\/exams$/);
  const mCourse = p.match(/^\/api\/courses\/(\d+)$/);
  const mActivity = p.match(/^\/api\/activities\/(\d+)$/);
  const mUploadUrl = p.match(/^\/api\/uploads\/reference\/document\/(\d+)\/url$/);

  if (mUploadUrl) {
    const refId = mUploadUrl[1];
    const u = data && typeof data === 'object' ? data.url : '';
    if (u) {
      db.prepare(`INSERT INTO tron_files (ref_id, url, updated_at) VALUES (?,?,?)
        ON CONFLICT(ref_id) DO UPDATE SET url=excluded.url, updated_at=excluded.updated_at`).run(String(refId), String(u), now);
      files.push({ refId, url: String(u) });
    }
    return { docs: [], files, hit: true };
  }

  if (mCourse && data && data.id) {
    const c = data;
    saveCourse(db, c);
    const name = String(c.name || '');
    const body = [
      '课程：' + name,
      '课程代码：' + (c.course_code || ''),
      '学年：' + ((c.academic_year && c.academic_year.name) || ''),
      '学期：' + (c.semester_name || c.semester || ''),
      '教师：' + teacherNames(c),
      '学分：' + (c.credit ?? ''),
      '开课：' + (c.start_date || '') + ' → ' + (c.end_date || ''),
      '学院：' + (c.department_name || (c.department && c.department.name) || ''),
      '[来源] ' + url
    ].join('\n');
    docs.push({
      source: 'hzcu', kind: '课程', uri: 'tron://course/' + c.id,
      title: '课程 · ' + name, body, ext: 'json', size: body.length,
      mtime: now, docTime: iso(c.start_date) || now,
      hash: hash(body), meta: { label: '学在城院', courseId: Number(c.id), courseName: name, courseCode: c.course_code || '', url }
    });
    return { docs, files, hit: true };
  }

  if (mActivityList && data && Array.isArray(data.activities)) {
    const courseId = Number(mActivityList[1]);
    const cname = courseNameOf(db, courseId);
    for (const a of data.activities) {
      const kind = KIND_BY_TYPE[a.type] || (a.type === 'material' ? '课件' : '其他');
      const ups = Array.isArray(a.uploads) ? a.uploads : [];
      const fileLines = ups.map((u) => '文件：' + (u.name || u.filename || '') + ' （ref ' + (u.reference_id || u.id || '') + '）');
      const body = [
        (cname ? '课程：' + cname : '课程ID：' + courseId),
        '类型：' + (a.type || ''),
        '标题：' + (a.title || ''),
        '开始：' + (a.start_time || ''),
        '截止：' + (a.end_time || ''),
        '发布：' + (a.published ? '是' : '否'),
        a.completion_criterion ? '完成条件：' + a.completion_criterion : '',
        a.data && a.data.description ? '说明：' + String(a.data.description).replace(/<[^>]+>/g, ' ').slice(0, 2000) : '',
        ...fileLines,
        '[来源] ' + url
      ].filter(Boolean).join('\n');
      const title = (cname ? cname + ' · ' : '') + (a.title || kind + ' ' + a.id);
      const fileMeta = ups.map((u) => ({
        uploadId: u.id || null,
        refId: u.reference_id || u.upload_reference_id || null,
        name: u.name || u.filename || '',
        type: u.content_type || u.type || ''
      }));
      docs.push({
        source: 'hzcu', kind, uri: 'tron://activity/' + a.id,
        title, body, ext: 'json', size: body.length, mtime: now,
        docTime: iso(a.start_time) || iso(a.created_at) || now, hash: hash(body),
        meta: {
          label: '学在城院', courseId, courseName: cname, activityId: Number(a.id),
          activityType: a.type || '', moduleId: a.module_id || null,
          startTime: a.start_time || null, endTime: a.end_time || null,
          files: fileMeta, url
        }
      });
      for (const f of fileMeta) {
        if (!f.refId) continue;
        db.prepare(`INSERT INTO tron_files (ref_id, course_id, activity_id, upload_id, name, updated_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(ref_id) DO UPDATE SET course_id=excluded.course_id, activity_id=excluded.activity_id,
            upload_id=excluded.upload_id, name=excluded.name, updated_at=excluded.updated_at`).run(
          String(f.refId), courseId, Number(a.id), f.uploadId, f.name, now
        );
      }
    }
    return { docs, files, hit: true };
  }

  if (mModules && data && Array.isArray(data.modules)) {
    const courseId = Number(mModules[1]);
    const cname = courseNameOf(db, courseId);
    const body = data.modules.map((m) => {
      const syl = (m.syllabuses || []).map((s) => '    · ' + (s.summary || '') + (s.date ? '（' + s.date + '）' : '')).join('\n');
      return '第' + (m.sort ?? '') + '讲 ' + (m.name || '') + (m.is_hidden ? '（隐藏）' : '') + (syl ? '\n' + syl : '');
    }).join('\n');
    docs.push({
      source: 'hzcu', kind: '章节', uri: 'tron://course/' + courseId + '/modules',
      title: (cname ? cname + ' · ' : '') + '章节结构', body: (cname ? '课程：' + cname + '\n' : '') + body + '\n[来源] ' + url,
      ext: 'json', size: body.length, mtime: now, docTime: now, hash: hash(body),
      meta: { label: '学在城院', courseId, courseName: cname, moduleCount: data.modules.length, url }
    });
    return { docs, files, hit: true };
  }

  if (mExams && data && Array.isArray(data.exams) && data.exams.length) {
    const courseId = Number(mExams[1]);
    const cname = courseNameOf(db, courseId);
    for (const e of data.exams) {
      const body = ['课程：' + cname, '考试：' + (e.name || e.title || ''), '开始：' + (e.start_time || ''), '截止：' + (e.end_time || ''), '[来源] ' + url].join('\n');
      docs.push({
        source: 'hzcu', kind: '考试', uri: 'tron://exam/' + (e.id || hash(body).slice(0, 12)),
        title: (cname ? cname + ' · ' : '') + (e.name || e.title || '考试'), body, ext: 'json', size: body.length,
        mtime: now, docTime: iso(e.start_time) || now, hash: hash(body),
        meta: { label: '学在城院', courseId, courseName: cname, examId: e.id || null, url }
      });
    }
    return { docs, files, hit: true };
  }

  if (mActivity && data && data.id) {
    const a = data;
    const courseId = Number(a.course_id || 0);
    const cname = courseNameOf(db, courseId);
    const kind = KIND_BY_TYPE[a.type] || '其他';
    const ups = Array.isArray(a.uploads) ? a.uploads : (a.data && Array.isArray(a.data.uploads) ? a.data.uploads : []);
    const body = [
      (cname ? '课程：' + cname : ''),
      '类型：' + (a.type || ''),
      '标题：' + (a.title || ''),
      '开始：' + (a.start_time || ''),
      '截止：' + (a.end_time || ''),
      a.data && a.data.description ? '说明：' + String(a.data.description).replace(/<[^>]+>/g, ' ').slice(0, 3000) : '',
      ...ups.map((u) => '文件：' + (u.name || u.filename || '')),
      '[来源] ' + url
    ].filter(Boolean).join('\n');
    docs.push({
      source: 'hzcu', kind, uri: 'tron://activity/' + a.id,
      title: (cname ? cname + ' · ' : '') + (a.title || kind), body, ext: 'json', size: body.length,
      mtime: now, docTime: iso(a.start_time) || now, hash: hash(body),
      meta: { label: '学在城院', courseId, courseName: cname, activityId: Number(a.id), activityType: a.type || '', url, startTime: a.start_time || null, endTime: a.end_time || null }
    });
    return { docs, files, hit: true };
  }

  const mMyCourses = /^\/api\/my-courses$/.test(p);
  const mAnnouncement = /^\/api\/announcement$/.test(p);
  const mNotify = /^\/ntf\/users\/\d+\/notifications$/.test(p);

  if (isIgnored(p)) return { docs: [], files: [], hit: true };

  if (mMyCourses && data && Array.isArray(data.courses)) {
    for (const c of data.courses) {
      saveCourse(db, c);
      docs.push(courseDoc(c, url, now));
    }
    return { docs, files, hit: true };
  }

  if (mAnnouncement && data && Array.isArray(data.announcements)) {
    for (const a of data.announcements) {
      const body = ['标题：' + (a.title || ''), '发布：' + (a.published_at || a.created_at || ''), String(a.content || '').replace(/<[^>]+>/g, ' ').slice(0, 4000), '[来源] ' + url].filter(Boolean).join('\n');
      docs.push({
        source: 'hzcu', kind: '通知', uri: 'tron://announcement/' + (a.id || hash(body).slice(0, 12)),
        title: '通知 · ' + (a.title || ''), body, ext: 'json', size: body.length,
        mtime: now, docTime: iso(a.published_at || a.created_at) || now, hash: hash(body),
        meta: { label: '学在城院', announcementId: a.id || null, url }
      });
    }
    return { docs, files, hit: true };
  }

  if (mNotify && data) {
    const list = data.notifications || (Array.isArray(data) ? data : []);
    for (const n of list) {
      const body = ['通知：' + (n.subject || n.title || ''), '内容：' + String(n.body || n.content || '').replace(/<[^>]+>/g, ' ').slice(0, 2000), '时间：' + (n.created_at || n.createdAt || ''), '[来源] ' + url].join('\n');
      docs.push({
        source: 'hzcu', kind: '通知', uri: 'tron://notify/' + (n.id || hash(body).slice(0, 12)),
        title: '通知 · ' + (n.subject || n.title || ''), body, ext: 'json', size: body.length,
        mtime: now, docTime: iso(n.created_at || n.createdAt) || now, hash: hash(body),
        meta: { label: '学在城院', notifyId: n.id || null, url }
      });
    }
    return { docs, files, hit: true };
  }

  return { docs: [], files: [], hit: false };
}
