// 中文按 bigram 切分，英文/数字按单词切分，给 FTS5 unicode61 用。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9]+(?:[._-][a-z0-9]+)*/g;

export function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

/** 生成索引/查询共用的词元序列 */
export function tokenize(text, limit = 0) {
  const t = norm(text);
  const out = [];
  let m;
  RUN.lastIndex = 0;
  while ((m = RUN.exec(t)) !== null) {
    const w = m[0];
    if (CJK.test(w[0])) {
      if (w.length === 1) out.push(w);
      else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else {
      out.push(w);
    }
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** 建索引用：词元以空格连接，保留重复（影响 bm25 打分） */
export function indexText(text, maxChars = 400000) {
  const s = maxChars ? String(text || '').slice(0, maxChars) : String(text || '');
  return tokenize(s).join(' ');
}

/** 查用：去重、限量、转成 FTS5 的 AND 表达式 */
export function ftsQuery(q, maxTerms = 24, joiner = ' AND ') {
  const seen = new Set();
  const terms = [];
  for (const tok of tokenize(q)) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    terms.push(tok);
    if (terms.length >= maxTerms) break;
  }
  if (!terms.length) return null;
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(joiner);
}

/** 从原文里截一段包含关键词的摘要 */
export function snippet(body, q, width = 150) {
  const src = String(body || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const terms = tokenize(q).filter((t) => t.length >= 1);
  if (!terms.length) return src.slice(0, width);
  const low = norm(src);
  let best = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return src.slice(0, width);
  const start = Math.max(0, best - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + src.slice(start, start + width) + (start + width < src.length ? '…' : '');
}
