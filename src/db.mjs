import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

export function openDb(config) {
  const cfg = config || loadConfig();
  const dbPath = path.isAbsolute(cfg.dbPath) ? cfg.dbPath : path.join(ROOT, cfg.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL UNIQUE,
      title TEXT,
      body TEXT,
      ext TEXT,
      size INTEGER,
      mtime TEXT,
      doc_time TEXT,
      hash TEXT,
      meta TEXT,
      indexed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_documents_mtime ON documents(mtime DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
    CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
    CREATE INDEX IF NOT EXISTS idx_documents_doctime ON documents(doc_time DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS tron_courses (
      id INTEGER PRIMARY KEY,
      name TEXT, code TEXT, year TEXT, teacher TEXT,
      start_date TEXT, end_date TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tron_files (
      ref_id TEXT PRIMARY KEY,
      course_id INTEGER, activity_id INTEGER, upload_id INTEGER,
      name TEXT, url TEXT, local_path TEXT, updated_at TEXT
    );
  `);
  return { db, dbPath, cfg };
}

export function upsertDoc(db, doc) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id, hash FROM documents WHERE uri = ?').get(doc.uri);
  if (existing && existing.hash === doc.hash) return { id: existing.id, changed: false };

  let id;
  if (existing) {
    id = existing.id;
    db.prepare(`UPDATE documents SET source=?, kind=?, title=?, body=?, ext=?, size=?, mtime=?,
      doc_time=?, hash=?, meta=?, indexed_at=? WHERE id=?`).run(
      doc.source, doc.kind, doc.title, doc.body, doc.ext, doc.size, doc.mtime,
      doc.docTime, doc.hash, JSON.stringify(doc.meta || {}), now, id
    );
  } else {
    const r = db.prepare(`INSERT INTO documents (source, kind, uri, title, body, ext, size, mtime,
      doc_time, hash, meta, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.source, doc.kind, doc.uri, doc.title, doc.body, doc.ext, doc.size, doc.mtime,
      doc.docTime, doc.hash, JSON.stringify(doc.meta || {}), now
    );
    id = Number(r.lastInsertRowid);
  }
  db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(id);
  db.prepare('INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)').run(
    id, doc.ftsTitle || '', doc.ftsBody || ''
  );
  return { id, changed: true };
}

/** 同一份笔记既导出了 PDF 又保留了原文时，只留原文，PDF 记为副本路径 */
export function dedupeExports(db) {
  const rows = db.prepare('SELECT id, kind, title, uri, meta FROM documents').all();
  const byKey = new Map();
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}'); } catch { /* ignore */ }
    const rel = String(meta.relPath || r.uri || '');
    const base = rel.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
    if (!base) continue;
    const key = String(meta.label || '') + '|' + base;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...r, meta });
  }
  let removed = 0;
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const rank = { md: 0, markdown: 0, txt: 1, html: 2, htm: 2 };
    const text = group.filter((g) => rank[g.kind] !== undefined).sort((a, b) => rank[a.kind] - rank[b.kind])[0];
    if (!text) continue;
    const copies = group.filter((g) => g !== text && ['pdf', 'html', 'htm', 'docx'].includes(g.kind));
    if (!copies.length) continue;
    const alts = Array.isArray(text.meta.altPaths) ? text.meta.altPaths : [];
    for (const c of copies) {
      if (alts.length < 12 && !alts.includes(c.uri)) alts.push(c.uri);
      // 不删行：保留原件记录（避免下次扫描重复抽取），只是不参与检索
      db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(c.id);
      db.prepare('UPDATE documents SET meta = ? WHERE id = ?').run(
        JSON.stringify({ ...c.meta, dupOf: text.id }), c.id
      );
      removed++;
    }
    text.meta.altPaths = alts;
    db.prepare('UPDATE documents SET meta = ? WHERE id = ?').run(JSON.stringify(text.meta), text.id);
  }
  return removed;
}

export function deleteDoc(db, uri) {
  const row = db.prepare('SELECT id FROM documents WHERE uri = ?').get(uri);
  if (!row) return false;
  db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(row.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
  return true;
}
