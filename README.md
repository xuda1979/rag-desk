# RAG-Desk (20)

垂直行业 RAG 客服壳：把律所知识库 / 诊所 FAQ / 招中标资料做成可嵌入的问答 bot。
**完全离线**：默认路径不依赖任何外部 LLM 或 embedding 模型，仅用本地 SQLite FTS5 +
CJK 友好分词 + BM25 做检索回答，数据不出机器。

## 功能
- 知识摄入：Markdown / PDF / DOCX / 纯文本 / CSV（FAQ），自动分块（400 字符窗口，40 字符重叠）
- 中文友好检索：SQLite FTS5 + unicode61，Han 部分按二元切词索引与查询；BM25 排序
- 离线问答：返回「检索片段 + 置信度 + 引用（文档名 + 段落号）」
- 领域预设（法律 / 医疗 / 招采 / 通用）作为 prompt/模板包，可自定义 system prompt
- 管理后台：上传文档、查看索引分块、查询日志与统计
- 嵌入浮窗：`<script src="/widget.js" data-api=... data-domain=...>` 即可使用
- 可选 LLM 摘要：默认关闭，可注入自定义 summarizer（mock 已内置用于测试）

## 技术栈
- Node.js ≥ 22.5（使用内置 `node:sqlite`，无需编译本地依赖）
- 解析器：`pdf-parse`（PDF）、`fflate`（DOCX 解压）、自研 CSV/纯文本
- 前端：原生 HTML/CSS/JS（chat UI + admin + wiki 组件），无构建步骤
- 部署：Docker Compose

## 快速开始

```bash
node --version   # >= 22.5
npm install
npm run seed     # 生成并把领域语料（fixtures/corpus）写入 data/ragdesk.db
npm start        # 启动 http://localhost:3000
```

打开：
- 演示页：http://localhost:3000/
- 管理后台：http://localhost:3000/admin
- 健康检查：http://localhost:3000/api/health

Docker：

```bash
docker compose up --build
```

镜像包含健康检查（`/api/health`），数据持久化在命名卷 `ragdesk-data`。

## API

### POST /api/chat
```json
{ "query": "律师咨询费怎么收取？", "domain": "legal" }
```
当设置 `RAGDESK_CHAT_TOKEN` 时，需附带请求头 `Authorization: Bearer <token>`。
响应：
```json
{
  "answer": "...检索片段 + 置信度说明...",
  "mode": "offline-retrieval",
  "llm": false,
  "confidence": 0.86,
  "citations": [{ "docId": 3, "document": "law-faq.md", "paragraph": 2, "excerpt": "…" }],
  "top": { "docId": 3, "document": "law-faq.md", "paragraph": 2, "excerpt": "…" }
}
```

### 其他
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 引擎状态、领域列表 |
| GET | /api/domains | 领域预设（含示例问题） |
| GET | /api/admin/docs | 已索引文档列表（含分块数） |
| GET | /api/admin/docs/:id | 某文档的全部分块（查看索引） |
| DELETE | /api/admin/docs/:id | 删除文档及其分块 |
| POST | /api/admin/upload | multipart 上传（字段名 `files`，支持多文件，单文件 ≤ 50MB，单次 ≤ 20 个） |
| GET | /api/admin/logs | 查询日志 + 统计（上传后可查看到记录） |
| GET | /widget.js | 嵌入式聊天浮窗脚本 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `RAGDESK_DB` | `data/ragdesk.db` | SQLite 数据库文件路径 |
| `RAGDESK_ADMIN_TOKEN` | 空（开放） | 设置后所有 `/api/admin/*` 需携带请求头 `x-admin-token: <token>`；`docker-compose.yml` 中请替换默认的 `change-me` |
| `RAGDESK_CHAT_TOKEN` | 空（开放） | 设置后 `/api/chat` 需携带 `Authorization: Bearer <token>` |
| `RAGDESK_ALLOW_ORIGIN` | 跟随请求 Origin（任意） | 限制浮窗跨域来源：`*` 或具体站点，如 `https://docs.example.com` |

> 默认（未设置任何 token）时功能与完全离线 demo 一致；生产对外暴露时建议至少设置
> `RAGDESK_ADMIN_TOKEN`（管理后台会在浏览器中提示输入令牌）。

## 嵌入浮窗

```html
<script
  src="http://localhost:3000/widget.js"
  data-api="http://localhost:3000/api/chat"
  data-domain="medical"
  data-title="诊所在线咨询"
  data-greeting="您好，我是诊所在线导诊助手。"
  data-token="<chat token，仅当设置了 RAGDESK_CHAT_TOKEN 时填写>"></script>
```

## 测试

```bash
npm test
```

覆盖：分块、中文检索命中（top1 片段含答案 + 引用）、重复上传幂等、删除清理、
空白语料兜底、离线模式、查询日志、上传→索引→问答、浮窗脚本提供、静态页。

## 自定义领域

在 `src/lib/domains.js` 增加条目即可；`systemPrompt` 使用于可选 LLM 摘要，
`lead/fallback/footer` 控制离线答案措辞。可注入自定义 `kb.answerWithLlm({summarizer})`。

## 目录
```
src/
  app.js            # express 路由（API + 页面）
  server.js         # HTTP 启动 / 端口 / 首次种子
  lib/knowledge.js  # 摄入 + 检索 + 答案组装（离线模式核心）
  lib/storage.js    # SQLite FTS5 存储层
  lib/tokenizer.js  # CJK 二元词 + unicode61 查询/索引互转
  lib/chunker.js    # 分块（段落感知 + 重叠窗口）
  lib/extractors.js # MD/TXT/CSV/DOCX/PDF 解析
  lib/domains.js    # 领域预设包
public/             # 演示页 / admin / widget.js
scripts/            # 种子与 fixtures 生成
fixtures/corpus/    # 中文领域语料（law/clinic/bid + pdf/docx/csv/txt）
Dockerfile          # 多阶段：npm ci + 运行
docker-compose.yml  # 单服务编排
```

## 许可
MIT
