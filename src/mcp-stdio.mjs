// stdio 传输层：把 MCP JSON-RPC 接到任意一对流上（CLI 用 process.stdin/stdout，自检用内存流）。
// 兼容两种分帧：MCP 规范的「一行一条 JSON」，以及 LSP 风格的 Content-Length 头。
// stdout 只走协议；日志一律走 stderr，避免污染客户端。
export function attachStdio({ mcp, input, output, log = () => {} }) {
  /** 在缓冲区里找一条完整 JSON 的结尾；字符串里的花括号不算 */
  function findJsonEnd(buf) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === 0x5c) esc = true;      // \
        else if (ch === 0x22) inStr = false;   // "
        continue;
      }
      if (ch === 0x22) { inStr = true; continue; }
      if (ch === 0x7b) depth++;                // {
      else if (ch === 0x7d) {                  // }
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function send(msg) {
    if (!msg) return;
    try { output.write(JSON.stringify(msg) + '\n'); } catch (e) { log('写输出失败 ' + e.message); }
  }

  function handle(msg) {
    if (Array.isArray(msg)) {
      const out = msg.map((m) => mcp.handleRpc(m)).filter(Boolean);
      if (out.length) send(out);
      return;
    }
    send(mcp.handleRpc(msg));
  }

  let buf = Buffer.alloc(0);
  let closed = false;
  input.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
    for (;;) {
      const start = buf.indexOf(0x7b); // 跳过前导空白 / Content-Length 头
      if (start < 0) { buf = Buffer.alloc(0); return; }
      if (start > 0) buf = buf.subarray(start);
      const end = findJsonEnd(buf);
      if (end < 0) return; // 半条消息，等下一块
      const raw = buf.subarray(0, end + 1).toString('utf8');
      buf = buf.subarray(end + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { log('JSON 解析失败：' + e.message + ' 原文=' + raw.slice(0, 200)); continue; }
      try { handle(msg); } catch (e) { log('处理失败：' + (e && e.stack || e)); }
    }
  });
  input.on('end', () => { closed = true; log('输入结束'); });
  input.on('error', (e) => log('输入错误 ' + e.message));
  return { get closed() { return closed; }, send, handle };
}
