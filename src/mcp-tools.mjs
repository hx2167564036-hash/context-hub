// MCP 工具层：把中枢的检索/时间线/待办/文档读写给任何 MCP 客户端用。
// 同一份实现同时服务于两种传输：stdio（scripts/mcp-server.mjs）与 HTTP（POST /mcp）。
// 零第三方依赖，手写 JSON-RPC 2.0 分发。
import crypto from 'node:crypto';
import { upsertDoc } from './db.mjs';
import { indexText } from './tokenize.mjs';

const SERVER_INFO = { name: 'context-hub', title: '天枢', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function text(v) {
  return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] };
}

export function makeMcp({ db, cfg, reader }) {
  const { search, timeline, due, brief, stats } = reader;

  /** 把检索命中压成给模型看的小对象：省 token，也避免把整段正文灌进去 */
  function compactHit(h) {
    const m = h.meta || {};
    return {
      id: h.id,
      title: h.title,
      source: h.source,
      kind: h.kind,
      docTime: h.docTime,
      course: m.courseName || m.label || '',
      endTime: m.endTime || null,
      files: Array.isArray(m.files) ? m.files.slice(0, 8).map((f) => f.name) : undefined,
      snippet: h.snippet
    };
  }

  const tools = [
    {
      name: 'search_context',
      description:
        '在用户本机的天枢里做全文检索（中文/英文）。覆盖课件、作业、通知（手机钉钉/微信/爱城院）、本地文档、微信文件、笔记。' +
        '回答任何“我这边关于 X 有什么”的问题前，先调这个。返回标题、来源、时间、正文摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '检索词，可中文自然语言短语（空格分词）' },
          source: { type: 'string', description: '限定来源，如 hzcu / fs / wechat / phone / obsidian / note' },
          kind: { type: 'string', description: '限定类型，如 pdf / docx / 作业 / 通知 / 课件' },
          days: { type: 'number', description: '只找最近 N 天的资料（默认不限）' },
          limit: { type: 'number', description: '返回条数，默认 10，最多 50' }
        },
        required: ['q']
      },
      handler(args) {
        const q = String(args.q || '').trim();
        if (!q) throw new Error('q 不能为空');
        const params = new URLSearchParams({ q, limit: String(Math.min(Number(args.limit) || 10, 50)) });
        if (args.source) params.set('source', String(args.source));
        if (args.kind) params.set('kind', String(args.kind));
        if (Number(args.days) > 0) params.set('days', String(Number(args.days)));
        const r = search(params);
        return { query: q, total: r.total, loose: !!r.loose, hits: (r.hits || []).map(compactHit) };
      }
    },
    {
      name: 'recent_digest',
      description:
        '最近几天新进中枢的资料摘要，按天分组（课件、作业、通知、本地文件）。想知道“最近发生了什么/新进了什么”时用。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '回溯天数，默认 3，最多 60' },
          source: { type: 'string', description: '限定来源' },
          limit: { type: 'number', description: '最多返回多少条，默认 60' }
        }
      },
      handler(args) {
        const days = Math.min(Math.max(Number(args.days) || 3, 1), 60);
        const params = new URLSearchParams({ days: String(days), hide: 'archive,expired,stub' });
        if (args.source) params.set('source', String(args.source));
        const r = timeline(params);
        const max = Math.min(Number(args.limit) || 60, 200);
        let n = 0;
        const groups = [];
        for (const g of r.groups || []) {
          const items = [];
          for (const it of g.items) {
            if (n >= max) break;
            items.push({ id: it.id, title: it.title, source: it.source, kind: it.kind, docTime: it.doc_time });
            n++;
          }
          if (items.length) groups.push({ date: g.date, items });
          if (n >= max) break;
        }
        return { days, total: r.total, returned: n, groups };
      }
    },
    {
      name: 'list_tasks',
      description: '列出近期到期的作业/考试（含剩余小时数、课程、附件名）。问“有什么要交/快到期”时用。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '往后看几天，默认 14，最多 120' },
          includePast: { type: 'boolean', description: '是否包含刚过期 7 天内的' }
        }
      },
      handler(args) {
        const days = Math.min(Math.max(Number(args.days) || 14, 1), 120);
        const params = new URLSearchParams({ days: String(days) });
        if (args.includePast) params.set('past', '1');
        const r = due(params);
        return { days, count: r.count, items: r.items };
      }
    },
    {
      name: 'get_document',
      description: '按 id（来自 search_context / recent_digest）或 uri 取一份资料的正文。默认截 4000 字，可用 maxChars 放大。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '文档 id' },
          uri: { type: 'string', description: '文档 uri（也支持部分匹配）' },
          maxChars: { type: 'number', description: '正文最多返回多少字，默认 4000，上限 50000' }
        }
      },
      handler(args) {
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 4000, 200), 50000);
        let row = null;
        if (args.id !== undefined && args.id !== null && args.id !== '') {
          row = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(args.id));
        } else if (args.uri) {
          row = db.prepare('SELECT * FROM documents WHERE uri = ?').get(String(args.uri)) ||
            db.prepare('SELECT * FROM documents WHERE uri LIKE ? ORDER BY doc_time DESC LIMIT 1').get('%' + String(args.uri) + '%');
        }
        if (!row) throw new Error('没找到这份文档：请先用 search_context 拿 id');
        let meta = {};
        try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }
        const body = String(row.body || '');
        return {
          id: row.id,
          title: row.title,
          source: row.source,
          kind: row.kind,
          uri: row.uri,
          docTime: row.doc_time,
          size: row.size,
          meta,
          body: body.slice(0, maxChars),
          truncated: body.length > maxChars,
          bodyChars: body.length
        };
      }
    },
    {
      name: 'hub_stats',
      description: '中枢总览：资料条数、体积、按来源/类型/分层的分布、最新入库时间。',
      inputSchema: { type: 'object', properties: {} },
      handler() {
        const s = stats();
        return { total: s.total, mb: Math.round((s.bytes / 1048576) * 10) / 10, latest: s.latest, bySource: s.bySource, byKind: s.byKind };
      }
    },
    {
      name: 'today_brief',
      description: '今日视图：要交的、本周课程活动、近三天新进。和桌面“今天”小窗、微信晨报同一份数据。',
      inputSchema: { type: 'object', properties: {} },
      handler() {
        const b = brief();
        return { generatedAt: b.generatedAt, due: b.due, week: b.week, fresh: b.fresh, stats: b.stats };
      }
    },
    {
      name: 'ingest_note',
      description:
        '把一段文字写回中枢（随手记/会议要点/稍后要查的结论），之后能被全文检索。仅在用户明确要求记下来时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记下的正文' },
          title: { type: 'string', description: '标题，可省略（取首行）' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' }
        },
        required: ['text']
      },
      handler(args) {
        const body = String(args.text || '').trim();
        if (!body) throw new Error('text 不能为空');
        const firstLine = body.split('\n').map((s) => s.trim()).find(Boolean) || '手记';
        const title = String(args.title || firstLine).slice(0, 120);
        const now = new Date().toISOString();
        const hash = crypto.createHash('sha1').update(body).digest('hex');
        const uri = 'note://mcp/' + hash.slice(0, 18);
        const tags = Array.isArray(args.tags) ? args.tags.slice(0, 12).map(String) : [];
        const res = upsertDoc(db, {
          source: 'note', kind: 'note', uri, title, body,
          ext: 'md', size: Buffer.byteLength(body), mtime: now, docTime: now, hash,
          meta: { label: '手记', tags, via: 'mcp' },
          ftsTitle: indexText(title, 2000),
          ftsBody: indexText(body, cfg.maxTextChars || 400000)
        });
        return { ok: true, id: res.id, changed: res.changed, uri, title };
      }
    }
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  const list = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  function callTool(name, args) {
    const t = byName.get(name);
    if (!t) return { isError: true, content: [{ type: 'text', text: '未知工具：' + name }] };
    try {
      return text(t.handler(args && typeof args === 'object' ? args : {}));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: '工具执行失败：' + (e && e.message || e) }] };
    }
  }

  /** 处理一条 JSON-RPC 消息；通知返回 null（不回包） */
  function handleRpc(msg) {
    if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      const version = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: '这是用户本机的个人知识库（天枢）。回答问题前先用 search_context 查一下他的资料，别凭空猜。'
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: list });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = params && params.arguments;
      if (!name) return rpcError(id, -32602, 'missing tool name');
      return ok(callTool(name, args));
    }
    if (method === 'resources/list') return ok({ resources: [] });
    if (method === 'prompts/list') return ok({ prompts: [] });
    if (method === 'shutdown') return ok({});
    return rpcError(id, -32601, 'Method not found: ' + method);
  }

  function rpcError(id, code, message) {
    if (id === undefined || id === null) return null;
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  return { tools: list, callTool, handleRpc, serverInfo: SERVER_INFO, protocols: PROTOCOLS };
}
