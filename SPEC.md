# 20 — RAG-Desk: 垂直行业 RAG 客服壳（律所/诊所/中标公告）

## 定位
Glean（$300M ARR）/ Chatbase 类的垂直行业 RAG 客户支持壳：把律所知识库/诊所
FAQ/招中标资料做成问答 bot。数据本地索引（SQLite + 向量自构建），轻量部署。
母市场企业搜索 Glean $300M（近线，可换 Figma 母叙事）。

## 主要痛点
- 中小企业（律所/诊所/政务）客服问 FAQ 千篇一律，内部知识找不到
- Chatbase 上传有隐私顾虑，且贵
- 需要离线自托管 + 数据不出去

## 功能需求
1. 知识摄入：
   - 格式：Markdown / PDF / DOCX / 纯文本 / CSV（FAQ）
   - 分块（chunk）与索引（本地 SQLite FTS5 + 可选项向量）
2. RAG 问答：
   - 查询 → 本地检索（FTS BM25 + 可选 embedding 混合）→ prompt（LLM 可选）
   - LLM 默认关闭：用「检索 + 规则」生成（返回 原文片段 + 置信度）
3. 领域壳：
   - 预设领域配置（法律/医疗/招采），可自定义 system prompt 模板
   - 答案「引用片段」可溯源（来源文档 + 段落号）
4. 管理界面：
   - 上传文档、查看索引、统计查询日志
5. 客户在线：嵌入式聊天浮窗（script）+ API endpoint
6. 离线模式：无外部 LLM 也可运行（纯检索回答）

## 非目标
- 企业级多租户（v1 单租户）
- 复杂知识图谱

## 技术栈
- Node v22 或 Python 3.14
- 检索：SQLite FTS5 + jieba/分词（中文）或 BM25（rank-bm25）
- embed（可选，v2）：本地小模型（如 fastembed ONNX，~100MB 内存）
- 前端：简单聊天 UI + admin（自建）
- 部署：Docker Compose

## 低算力守则
见全局 — 「不训模型」。embedding 若用可用 ONNX 小模型（50–200MB）可选，
LLM 检索增强按量（可关）。

## AC
1. 索引 10 篇领域文档（中文 markdown/pdf），问答命中正确片段（检索 top1 含答案）
2. 答案带引用（文档名 + 段落文字）
3. 离线（无 LLM/embedding）模式仍能回答（FTS 检索）
4. 无需外部 API 的纯本地 demo 页可开
5. 上传新文档 → 索引自动更新 → 可问
6. admin 查看查询日志
7. 测试 + README + 领域示例语料

## Phases
- P0: 摄入 + 分块 + FTS 索引
- P1: 问答 API + 引用
- P2: 聊天浮窗 + admin
- P3: embedding 增强（可选）+ 领域模板

## 里程碑
M1: FTS 检索问答（MVP）
M2: 引用 + API
M3: 浮窗 + admin

## 变现
- 开源 self-host，托管版订阅
