# 两周 MVP 计划（v2）

总预算仍为 14 天，每天 2 个 45 分钟工作块，共 21 小时。Day 1-4 已完成；剩余
15 小时集中证明一件事：不修改 Pi core/JSONL，也能安全地从多 session 原始历史
构建带事实版本、授权检索和审计证据的每轮上下文。

详细架构契约见 [`CONTEXT_MANAGEMENT_SPEC.md`](CONTEXT_MANAGEMENT_SPEC.md)。

## Day 1-2：Pi 基础接入（已完成）

- [x] 验证 Node、Pi SDK、模型和事件订阅。
- [x] 建立两个彼此独立的 in-memory session。
- [x] 完成显式字段 handoff、usage 读取和 thinking event fail-closed 过滤。

交付：双 session 在线 spike、8 项离线回归、SDK 基础接入决策。

说明：当时的“extension 可选”只针对最小 handoff；新的上下文接管目标仍需 Day 5
专门验证 `context` hook，不把旧结论外推。

## Day 3-4：Group、Task 与授权地基（已完成）

- [x] 实现每 group 唯一 root 的 session tree 和双向关系查询。
- [x] 实现最小 Task、DevelopmentRecord 和严格 exposure 继承。
- [x] 实现 `SELF / SUPERIOR / SUBORDINATE / PEER / UNRELATED` 的 5×3 授权矩阵。
- [x] 证明 descriptor/decision 不含正文，fake canary 不进入授权输出。

交付：关系、记录与授权的 64 项离线测试。

## Day 5：Pi 上下文接管 spike（已完成）

### 工作块 A：最小 extension harness

- [x] 用 `before_agent_start` 创建一次运行的 snapshot ID。
- [x] 用 `context` hook 临时增加并删除带标识的 managed block。
- [x] 用 `agent_settled` 清理 snapshot，不把 managed context 持久写入 Pi 历史。

### 工作块 B：真实生命周期验证

- [x] 验证 `context` 在普通回复和 tool loop 的每次 LLM call 前触发。
- [x] 验证重复触发不重复注入，且最新 tool result 不被裁掉。
- [x] 记录 Pi auto-retry/compaction 顺序和加入 managed block 后的预算缺口。

交付：可执行 hook spike、59 条全局排序事件、H01-H16 全部 PASS，决策为 `GO_SDK`；
详见 [DAY5_HOOK_SPIKE.md](DAY5_HOOK_SPIKE.md)。

停止条件：hook 不能稳定控制最终 messages、不能保留工具闭环或不能定位当前
session 时，先记录失败证据，不继续实现依赖错误假设的 ContextManager。

## Day 6：Pi 历史 sidecar（已完成）

### 工作块 A：权限头与增量索引

- 定义 `HistoryEntryDescriptor`，使用 `piSessionRef + piEntryId` 关联 Pi 原文。
- 从 `SessionManager.getEntries()` 增量 reconcile 新 entry。
- 普通 message/tool result 默认 `WORK_RECORD`；受控 task/handoff 可显式指定更宽
  exposure，模型不得自动扩大。
- compaction 只索引元数据；由 ExplicitContentExtractor 丢弃 thinking 内容。

### 工作块 B：授权后读取边界

- `HistoryCatalog` 只列不含正文的 descriptor。
- 先运行现有授权矩阵，再由 `HistoryLoader` 按 allowed ID 回读原文。
- 对已允许 entry 再提取显式 text/tool call/result，不把原始 message object 直接交给
  检索器或摘要器。
- 覆盖未知 entry、hash mismatch、撤销 descriptor 和跨 group fake canary。

交付：从 Pi entry 到 sidecar descriptor，再到授权后正文加载的纯逻辑闭环。

验收：Pi 0.85.1 `SessionManager.inMemory()` 集成与六场景 runner 已执行；D6-H01–H16
全部 PASS，artifact decision 为 `DAY6_COMPLETE_GO_DAY7`。全量 `npm run check` 与
`npm test` 均通过。范围和未执行事项见 [Day 6 实现与验证记录](DAY6_HISTORY_SIDECAR.md)。
该验收不包含真实用户 session、真实模型、检索、摘要或 ContextManager。

## Day 7：独立 GroupFactStore（已完成验证）

### 工作块 A：事实版本

- [x] 实现 `ACTIVE / SUPERSEDED / REVOKED` 和同 key 单 active 约束。
- [x] 首版仅 group root 可发布、替换和撤销权威事实。
- [x] 旧事实保留审计链，不修改 Pi 原始历史。

### 工作块 B：事实快照

- [x] 为一次 agent run 冻结 active fact versions。
- [x] 证明同一工具循环保持旧快照，下一次 prompt 全 group 读取新版本。
- [x] 事实预算超限时显式失败，不静默丢弃。

交付：版本化 FactStore、事实快照与跨 session 下一 run 测试；D7-H01–H16 全 PASS，runner decision 为 `DAY7_COMPLETE_GO_DAY8`。证据见 [Day 7 实现与验证记录](DAY7_GROUP_FACT_STORE.md)。验证仅覆盖离线合成/in-memory，不含真实模型、真实 session、持久化或最终上下文注入。

## Day 8：授权后的历史检索

### 工作块 A：候选范围

- descriptor 先按 group、关系、task、entry type 和 exposure 授权。
- 只加载 allowed IDs；禁止正文不能进入 query corpus。

### 工作块 B：最小 history RAG

- 实现确定性词法检索：task/file/type/text 相关性加稳定 tie-break。
- 数据量小时直接对已授权文档评分；不引入向量数据库。
- 记录 selected/not-selected reason，避免把“有权读”混成“本轮一定注入”。

交付：`Authorization -> AllowedContentLoader -> LexicalHistoryRetriever` 单元测试。

## Day 9：历史摘要与投影

### 工作块 A：摘要契约

- 定义结构化 `HistorySummary` 和 source ID/hash/provenance。
- 单元测试使用 fake summarizer，验证摘要只收到 authorized sources。
- 摘要继承来源中最严格 exposure，来源哈希变化即失效。

### 工作块 B：在线摘要窄试验

- 使用一个显式调用的 Pi/model adapter 总结一段合成旧历史。
- 输出 goal、decisions、constraints、changedFiles、testEvidence、unresolvedIssues。
- 对比近期原文、持久摘要和检索后临时摘要的使用场景。

交付：摘要接口、离线安全测试和一个可选在线样例；不实现通用 chunker。

## Day 10：ContextManager 纯函数闭环

### 工作块 A：ContextSnapshot 与预算

- 组合当前任务、active facts、当前 session 近期历史、授权摘要和检索结果。
- 固定优先级：当前工具闭环/事实/任务 > 近期历史 > 摘要 > 较早原文。
- 使用版本化保守 token estimator；固定部分超预算时 fail closed。

### 工作块 B：Envelope 与 Manifest

- 生成 `ContextEnvelope` 和每次调用的 `ContextManifest`。
- 记录 included ID、projection、hash、估算 token、reason 和安全排除统计。
- canary 测试覆盖 loader、retriever、summarizer、envelope、manifest 和日志。

交付：从 descriptors/facts/Pi messages 到 envelope/manifest 的纯函数闭环。

## Day 11：ContextManager 接入 Pi

### 工作块 A：extension adapter

- 把 Day 10 ContextManager 接入 Day 5 的三个生命周期 hook。
- 每次 `context` 重建最终 messages，并复用同一 ContextSnapshot。

### 工作块 B：工具循环集成

- 运行带至少一次 tool call/result 的在线合成任务。
- 验证 managed facts 不进入 Pi 持久历史、旧 fact 不再注入、工具结果仍完整。
- 对照 manifest 与实际送给模型的最终消息哈希。

交付：单 session 的真实上下文接管证据。只有这一步通过，才称 SDK hook 足够。

## Day 12：固定三 session Relay

### 工作块 A：顺序工作流

- 固定 `root plan -> worker implement -> tester verify -> root review`。
- Task 控制工作归属；DevelopmentRecord 负责主动 handoff；History RAG 补充相关旧史。

### 工作块 B：事实与权限演示

- 中途替换一个 group fact，证明所有 session 下一轮使用新版本。
- 布置同组其他分支和跨组 canary，证明只投递允许且相关的内容。

交付：进程内三 session 端到端 demo 和逐调用 manifest。

## Day 13：恢复与基线对照

### 工作块 A：最小恢复

- 将 group、task、descriptor、facts、summaries 和 manifest checkpoint 保存为原子 JSON。
- 重启后绑定已有 Pi session 并恢复一条未完成固定工作流。
- SQLite 和完整 migration 留到 MVP 后。

### 工作块 B：小型对照

- 准备 2 至 3 个固定合成任务。
- 比较 Pi/default 或授权范围全量输入与 Relay 词法检索输入。
- 记录估算/实际 input token、证据送达、任务结果、延迟和 canary 泄漏。

交付：可重放 JSON 状态、机器可读结果和不预设胜负的对照表。

## Day 14：安全收口、演示与简历表达

### 工作块 A：故障与声明审计

- 覆盖超预算、缺 entry、hash mismatch、摘要失败、工具失败和重复恢复。
- 核对 README 的每个“已实现”声明均有测试、命令或本地产物。
- 明确应用层可见性不等于 OS 沙箱，事实撤销不等于删除自然语言旧提及。

### 工作块 B：作品集包装

- 整理 3 至 5 分钟演示路径、架构图、manifest 样例和复现命令。
- 冻结依赖与 fixtures。
- 只根据实测结果写 2 至 3 条简历 bullet；没有数据就不写节省百分比。

## 核心完成线与裁剪顺序

必须保留：

1. Day 5 hook spike 和不修改 Pi core/JSONL 的证据。
2. sidecar descriptor、FactStore 和授权后正文加载。
3. 至少一种确定性历史检索、预算与 ContextManifest。
4. managed context 的真实 Pi 注入与多阶段 canary 测试。

时间不足时依次裁剪：

1. JSON 重启恢复，改为导出可重放状态但不现场 resume。
2. 三 session 的 tester，保留 root + worker 双 session demo。
3. 在线 LLM 摘要，只保留接口、fake summarizer 和已有摘要 fixture。
4. repair/retest、完整 CLI 和多任务 benchmark。

无论如何不加入向量数据库、通用 RAG、自动事实抽取、GUI、任意工作流 DAG 或
并行仓库写入。embedding 混合检索属于 MVP 完成后的对照实验，不占用核心日程。
