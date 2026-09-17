# 项目架构（v2）

状态：2026-09-15 完成方向修订。Day 1-4 已实现部分保留；Day 5 起按本架构推进。

## 1. 架构结论

Pi More Context Relay 不是新的 agent runtime，也不复制一套 Pi session 文件。它在
Pi 的公开 SDK/extension 接缝上增加一个可审计的 Context Manager：

```text
Pi 负责：模型调用、工具循环、原始 session JSONL、分支和默认 compaction
Relay 负责：session tree、权限头、当前事实、历史检索、摘要、预算和最终上下文
```

项目在逻辑上控制每次模型调用看到的消息，但首版不修改 Pi core 和原始历史格式。

## 2. 总体结构

```text
                         ┌──────────────────────────┐
                         │ GroupTree / Task / Policy│
                         └────────────┬─────────────┘
                                      │
Pi SessionManager ──> HistoryIndexer ─┼─> HistoryCatalog (sidecar headers)
  raw JSONL              │            │
                         │            v
                         │    AuthorizationFilter
                         │       descriptors only
                         │            │ allowed IDs
                         v            v
                    HistoryLoader -> ExplicitExtractor -> LexicalRetriever -> Summarizer
                                                           │
GroupFactStore ───── ACTIVE versions ───────────────────────┤
DevelopmentRecordStore ─ explicit handoffs/evidence ───────┤
                                                           v
                          ContextManager -> BudgetPacker -> Envelope/Manifest
                                                           │
                                                           v
                                               Pi `context` extension hook
                                                           │
                                                           v
                                                     LLM request
```

`AuthorizationFilter` 必须先于正文加载、检索、摘要和任何模型调用。Context Manager
是确定性代码控制器；LLM 只可作为被授权摘要器使用。

## 3. 数据所有权

### Pi 原始历史

- Pi session 是用户、助手显式消息、tool call/result、分支和 compaction 的原始来源。
- Relay 通过 `SessionManager.getEntries()` / `getEntry()` 读取，不改写 Pi JSONL schema。
- `thinking_*` 内容不进入 Relay 索引、摘要、handoff、manifest 或普通日志。

### Relay sidecar 历史目录

- `HistoryEntryDescriptor` 通过 `piSessionRef + piEntryId` 关联原文。
- descriptor 只保存 group、source、task、entry type、exposure、状态和内容哈希。
- 原文只在目标 session 已通过授权后按 allowed ID 加载。
- 普通 Pi entry 默认是 `WORK_RECORD`；更宽 exposure 只能由 Relay 在写入受控任务/
  handoff 时显式指定，不能由 LLM 自动分类扩大。
- Pi compaction entry 首版只登记 metadata，不作为跨 session 检索正文。
- sidecar 是权限和检索头，不是第二份完整 transcript。

### Relay 当前事实

- `GroupFactStore` 保存按 `factKey` 版本化的权威事实。
- 旧版本保留为 `SUPERSEDED/REVOKED`，只有 `ACTIVE` 版本进入新快照。
- facts 每轮临时注入，不持久追加为 Pi custom message，因此不依赖 Pi compaction。

### Relay 派生与主动发布内容

- `HistorySummary` 是带来源 ID/hash 和严格 exposure 继承的派生缓存。
- `DevelopmentRecord` 继续用于 session 主动发布计划、设计、实现报告、测试证据、
  handoff 和产物引用。
- DevelopmentRecord 不是完整 Pi 历史，也不再承担全部上下文来源。

详细字段和生命周期见 [`CONTEXT_MANAGEMENT_SPEC.md`](CONTEXT_MANAGEMENT_SPEC.md)。

## 4. 模块结构

以下是目标结构。Day 1-4 已实现文件目前仍位于 `src/` 根部；后续只在对应切片
落地时迁移或增加模块，不做一次性目录重构。

```text
src/
├─ pi/             # PiSessionPort、SessionManager 读取与安全事件适配
├─ group/          # GroupTree 与相对关系
├─ tasks/          # 最小 Task 生命周期
├─ records/        # DevelopmentRecord 与 handoff
├─ history/        # sidecar catalog、indexer、authorized loader、词法检索、摘要
├─ facts/          # GroupFact 版本与 active snapshot
├─ context/        # ContextManager、projection、budget、envelope、manifest
├─ extension/      # before_agent_start/context/agent_settled 集成
├─ relay/          # 固定的 plan -> implement -> verify -> review
└─ store/          # MVP JSON 状态适配；SQLite 留给后续
```

| 模块 | 单一职责 | MVP 输出 |
|---|---|---|
| Pi adapter | 读取原始 entries、prompt、事件和 usage | `PiSessionPort`, `PiHistorySource` |
| Group/Task | 树关系和工作归属 | 已实现的 manager |
| Policy | descriptor 级固定授权 | 已实现的 5×3 matrix |
| History | 建头、授权后加载、词法检索和派生摘要 | `HistoryCatalog`, `HistoryRetriever` |
| Facts | 当前事实的版本切换 | `GroupFactStore` |
| Context | 每轮快照、投影、预算和审计 | `ContextManager` |
| Extension | 把最终消息注入每次 Pi LLM call | `PiContextExtension` |
| Relay | 固定三会话顺序演示 | `RelayWorkflow` |
| Store | 恢复 Relay 自有状态 | JSON snapshot/replay adapter |

## 5. 每轮运行时序

```text
user prompt
   |
   v
before_agent_start
   ├─ reconcile 新 Pi entries -> sidecar descriptors
   └─ freeze task + policy + ACTIVE facts + retrieval selection as ContextSnapshot
   |
   v
context (每次 LLM call 都触发)
   ├─ 清除可能重复的 managed block
   ├─ 保留当前 prompt 与尚未闭合的 tool call/result
   ├─ 选择当前 session 近期显式历史
   ├─ 注入同一 snapshot 的事实与授权历史
   └─ 输出本次 ContextManifest
   |
   v
Pi model/tool loop ... context may fire again
   |
   v
agent_settled
   ├─ index 本轮新显式 entries
   └─ release snapshot
```

同一工具循环冻结 snapshot，避免一次任务执行到一半事实版本发生变化；下一个用户
prompt 才读取新的 active facts。context hook 对每次调用保持幂等，同时必须保留刚
产生的 tool result。

## 6. Context Manager 的固定阶段

```text
DescriptorScope
  -> RelationshipResolver
  -> AuthorizationFilter
  -> AllowedContentLoader
  -> ExplicitContentExtractor
  -> LexicalHistoryRetriever
  -> optional HistorySummarizer
  -> Projection
  -> BudgetPacker
  -> ContextEnvelope + ContextManifest
```

- Authorization 回答“能否读取”。
- Retrieval 回答“已授权内容中什么与本轮有关”。
- Projection 回答“使用原文、摘要还是引用”。
- BudgetPacker 回答“在预算内如何组合”。
- Manifest 回答“实际包含/排除了什么以及原因”。

首版检索限定在 group 内 Pi 历史和 Relay 记录，使用确定性元数据加词法/BM25
评分。它属于受限 history RAG，但不是通用 RAG；不引入向量数据库。embedding
只保留为 MVP 完成后的可选对照。

## 7. 与 Pi compaction 的关系

Relay 不关闭也不重写 Pi 默认 compaction：

- Pi compaction 继续服务 Pi 自身的会话恢复和默认上下文。
- Relay 的 active facts 永远从 FactStore 重建，不会依赖 compaction summary。
- Relay 的 HistorySummary 有独立来源和 exposure，不信任 Pi summary 自动获得跨
  session 可见性。
- `context` hook 对 Pi 提供的 messages 做最终重组；Day 5 spike 必须验证在自动
  retry、compaction 和工具循环中仍然成立。

如果 spike 证明 context hook 无法可靠控制消息、无法关联 entry ID，或无法计算
加入 Relay 内容后的预算，才考虑最小 core patch。候选补丁只允许是可插拔
`ContextBuilder`、`CompactionPolicy` 或 metadata adapter，不重写整个 Pi runtime。

## 8. 持久化选择

为避免两周 MVP 同时承担数据库设计，首版使用：

```text
Pi 原始历史       -> Pi 自己的 session JSONL
Relay domain state -> 内存服务 + 原子 JSON snapshot/replay
Manifest/results   -> 本地 JSON/JSONL artifacts
```

Store 接口与领域逻辑分离，以后可以替换为 SQLite。SQLite、迁移系统和完整 CLI 不再
是核心验收条件；恢复一次固定演示即可。

## 9. 威胁模型与明确限制

MVP 保证的是：应用不会把被策略拒绝的正文发送给目标模型调用、摘要模型、检索器
或普通日志。它不防御拥有本机文件权限的恶意进程，也不限制 Pi 工具读取工作区。

另外，撤销一个 managed fact 只能保证它不再由 Relay 注入；如果旧事实曾作为普通
自然语言写入 Pi 历史，它仍可能出现在原始记录或近期窗口中。演示和简历描述必须
区分“权威事实版本切换”与“删除所有历史提及”。

## 10. 已实现与待实现

已实现并验证：

- 双 Pi session、事件过滤和最小 handoff spike。
- 每 group 唯一 root 的 session tree。
- Task、DevelopmentRecord、严格 exposure 继承和 5×3 授权矩阵。

待实现：

- context hook 接管可行性 spike。
- HistoryEntryDescriptor sidecar、FactStore、authorized loader 和词法检索。
- HistorySummary、ContextSnapshot、预算、Envelope/Manifest。
- extension 集成、固定三 session 演示、恢复与基线评估。
