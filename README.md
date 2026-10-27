# 天枢 · 上下文中枢

把散落在本机各处与校园平台上的资料（Obsidian 笔记、课程课件、微信文件、手机通知、浏览器下载）
汇总成一个可以用一句话检索的知识库，并通过 MCP 把结果交给任何支持该协议的 AI 客户端。

本地索引过 2,255 份文档；`data/context.db` 是 SQLite + FTS5 的单文件库（**不入库**，见下）。

## 结构

```
src/           核心：扫描 scan.mjs / HTTP 服务 server.mjs / MCP server / 教务平台抓取 tronclass.mjs
scripts/       40+ 个运维脚本：抓课件、拉手机通知、抓窗口文本、写回 Obsidian、日报推送
public/        本地 Web 界面（首页 / 今天 / holo 视图）
desktop/       Electron 壳（main.js）
extension/     Chrome 扩展
config.example.json  配置样例（真实密钥已替换为占位符）
```

## 设计取舍

- **单机优先**：所有数据留在本机 SQLite，服务只监听 `127.0.0.1`，手机端通过局域网 token 访问。
- **多源归并**：不同来源用 `source` 字段区分（`obsidian / fs / hzcu / wechat / phone`），
  同一份文件按内容 hash 去重。
- **给 AI 用**：`src/mcp-stdio.mjs` 把检索暴露成 MCP 工具，模型可以直接「查我的资料」而不是靠提示词。

## 为什么仓库里没有 data/

`data/context.db`（52 MB）里有课程资料、成绩、微信记录与手机通知 —— 属于个人数据，
不随仓库分发。拉下来后按 `config.example.json` 配好目录，跑 `npm run scan` 会重建自己的库。

## 快速开始

```bash
npm install
cp config.example.json config.json   # 填入你自己的 pushplus / lan / deepseek 配置
npm run scan                         # 建立索引
npm run serve                        # http://127.0.0.1:7311
npm run mcp:doctor                   # 检查 MCP 是否可用
```
