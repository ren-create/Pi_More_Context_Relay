# 上下文管理规范（v1 设计稿）

状态：2026-09-15 完成架构重排，尚未实现。本规范是 Day 5 以后各切片的共同契约。

## 1. 目标与边界

本项目在逻辑上接管“每次 Pi 模型调用最终看到什么”，但暂时不修改 Pi core，也不
改变 Pi 原始 session JSONL 格式。

```text
Pi：保存原始 session 历史，执行模型与工具循环
Relay：建立旁路权限索引，维护当前事实，检索历史，构建每轮上下文并审计
```

“逻辑接管”具体指：Relay 在 Pi 的 `context` hook 中返回最终消息列表。Pi 仍是原始
历史的事实来源；Relay 的临时注入内容不回写成普通 Pi 消息。

首版只覆盖本机、单用户、顺序执行的 3-session 演示。它不提供操作系统级隔离，
也不承诺从自然语言旧历史中自动删除已经出现过的过期事实。

## 2. 五类数据必须分开

| 数据 | 所有者 | 是否保存正文 | 是否参与 Pi 默认压缩 | 用途 |
|---|---|---:|---:|---|
| Pi 原始历史 | Pi | 是 | 是 | 回放、恢复、当前工具循环 |
| `HistoryEntryDescriptor` | Relay | 否 | 否 | 权限、来源和索引头 |
| `GroupFact` | Relay | 是 | 否 | 每轮注入的当前权威事实 |
| `HistorySummary` | Relay | 是 | 否 | 较早历史的派生摘要 |
| `DevelopmentRecord` | Relay | 是 | 否 | session 主动发布的计划、证据和 handoff |

sidecar descriptor 不是第二份聊天记录；它只通过 `piSessionRef + piEntryId` 指向
Pi 中的原文。事实、摘要和 DevelopmentRecord 是 Relay 自己管理的内容。

## 3. 最小数据契约

### 3.1 HistoryEntryDescriptor

```js
{
  id: "history-descriptor-001",
  piSessionRef: "pi-session-worker",
  piEntryId: "pi-entry-id",
  groupId: "group-001",
  sourceSessionId: "session-worker",
  taskId: "task-001",              // 可以为 null
  entryType: "MESSAGE",            // MESSAGE | TOOL_RESULT | COMPACTION
  exposure: "WORK_RECORD",
  status: "ACTIVE",                // ACTIVE | REVOKED
  contentHash: "sha256:...",
  schemaVersion: 1,
  createdAt: "..."
}
```

- descriptor 不含正文、正文片段、embedding 或模型摘要。
- Pi entry 不可定位、哈希不匹配或 descriptor 已撤销时，读取器必须 fail closed。
- exposure 复用已完成的 `WORK_RECORD / DESIGN_CONTEXT / GROUP_FACT` 授权矩阵。
- 普通 Pi message/tool result 默认标为 `WORK_RECORD`。只有 Relay 在创建任务指令或
  handoff 时已经显式指定 exposure，索引器才可写入更宽级别；LLM 分类不能自动
  扩大 exposure。
- MVP 不原地扩大已有历史的 exposure。若需要向子孙或全组主动公开内容，由 source
  显式发布新的 `DESIGN_CONTEXT` DevelopmentRecord，或由 root 发布新的 GroupFact。
- 修改 exposure 或撤销条目必须留下审计事件；不重写 Pi 原始历史。
- 首版以 entry/turn 为检索单元，不实现通用语义 chunker。超大工具结果只做安全
  截断或产物引用。
- Pi compaction entry 首版只登记 metadata，不作为跨 session 可检索正文；它可能
  混合多个来源，不能在缺少来源链时获得新的共享权限。

### 3.2 GroupFact

```js
{
  id: "fact-authorization-order-v2",
  groupId: "group-001",
  factKey: "authorization.pipeline-order",
  version: 2,
  value: "authorization-before-retrieval",
  status: "ACTIVE",                // ACTIVE | SUPERSEDED | REVOKED
  supersedesId: "fact-authorization-order-v1",
  createdBySessionId: "session-root",
  contentHash: "sha256:...",
  createdAt: "..."
}
```

- 同一 group、同一 `factKey` 最多一个 `ACTIVE` 版本。
- Active facts 只对同 group 节点可见，跨 group 始终拒绝。
- 首版只允许 group root 发布、替换或撤销权威事实；其他节点可通过
  DevelopmentRecord 提议，但不能直接生效。
- 更新事实创建新版本并把旧版本标为 `SUPERSEDED`；撤销不删除旧版本。
- 每次 ContextSnapshot 读取一组不可变的 active fact 版本。当前 agent 工具循环
  使用同一快照，下一次用户 prompt 才读取新版本。
- active facts 不作为 persistent custom message 追加进 Pi，因此不依赖 Pi compaction
  保存。MVP 对事实预留固定预算；事实超额时明确失败，不静默丢弃部分权威事实。

### 3.3 HistorySummary

```js
{
  id: "summary-001",
  groupId: "group-001",
  sourceSessionId: "session-worker",
  taskId: "task-001",
  sourceEntryIds: ["pi-entry-1", "pi-entry-2"],
  sourceContentHashes: ["sha256:...", "sha256:..."],
  payload: {
    goal: "...",
    decisions: [],
    constraints: [],
    changedFiles: [],
    testEvidence: [],
    unresolvedIssues: []
  },
  exposure: "WORK_RECORD",
  summaryModel: "...",
  summaryPromptVersion: 1,
  createdAt: "..."
}
```

- 摘要模型只能接收已经授权并已加载的正文。
- 摘要继承所有来源中最严格的 exposure，允许收紧，不允许自动降密。
- 摘要是派生缓存，不替代 Pi 原始历史；来源哈希变化时摘要失效。
- 单元测试使用 deterministic fake summarizer；在线 LLM summarizer 是独立显式试验。
- 模型可以总结内容，但不能决定权限、事实版本、token 预算或是否降密。

### 3.4 ContextSnapshot、Envelope 与 Manifest

`ContextSnapshot` 在一次用户 prompt 开始时冻结事实版本、任务和已选历史；同一
工具循环的多次 LLM 调用复用它。`ContextEnvelope` 是准备注入的内容，
`ContextManifest` 是每次实际组装的审计结果。

Manifest 至少包含：

- snapshot、group、target session、task 和 policy version。
- active fact 的 key、version 与 hash。
- 被纳入的 Pi entry、summary、DevelopmentRecord ID、投影形式、估算 token 和原因。
- 被拒绝或未选中的安全 reason code/聚合计数；不得复制被拒绝正文。
- Pi 原生消息输入哈希、最终消息哈希和本次预算结果。

## 4. 固定上下文管线

```text
target session + task + current prompt
                |
                v
        list descriptors only
                |
                v
 RelationshipResolver + AuthorizationFilter
                |
          allowed IDs only
                v
 load allowed entries -> ExplicitContentExtractor
           safe explicit text / summaries
                |
                v
  LexicalHistoryRetriever (task/file/type/text)
                |
                v
 optional authorized-only summarization
                |
                +-------- GroupFactStore (ACTIVE only)
                v
  Projection -> BudgetPacker -> Envelope + Manifest
                |
                v
          Pi `context` hook
```

顺序是安全契约：授权发生在正文加载、相关性评分、摘要和任何模型调用之前。小数据
MVP 直接对授权后的文档做确定性词法评分，不建立包含所有私有正文的共享向量索引。

## 5. ContextManager 的职责

```js
class ContextManager {
  buildSnapshot({ groupId, targetSessionId, taskId, currentPrompt, tokenBudget })
  buildForCall({ snapshotId, piMessages })
  releaseSnapshot(snapshotId)
}
```

内部职责保持可拆分测试：

```text
HistoryCatalog      只列 descriptor
AuthorizationFilter 只做 allow/deny
HistoryLoader       只按 allowed ID 读取 Pi entry
ExplicitExtractor   只保留显式文本、tool call/result 和安全元数据
HistoryRetriever    只给已授权内容打相关性分
HistorySummarizer   只总结已授权来源
FactStore           只返回当前 active 版本
Projection          决定原文、摘要或引用形式
BudgetPacker        决定预算内组合
ManifestBuilder     生成不含拒绝正文的审计信息
```

模型不是 ContextManager。首版只有 `HistorySummarizer` 可以调用模型；reranker 和
embedding 都不是完成 MVP 的前置条件。

## 6. Pi extension 生命周期

```text
before_agent_start -> 对 Pi entries 做增量 reconcile，创建 ContextSnapshot
context            -> 每次 LLM 调用前幂等重建最终 messages
agent_settled       -> 索引本轮新显式 entries，释放 ContextSnapshot
```

`context` hook 必须：

1. 移除同一 snapshot 已经注入过的 Relay managed block，避免重复。
2. 保留当前用户输入、当前 assistant tool call 和对应 tool result。
3. 在预算内选择本 session 的近期显式历史。
4. 注入 active facts、任务约束和授权检索结果。
5. 为每次调用生成 manifest。

即使 Pi 原始 assistant entry 内含 thinking block，`ExplicitContentExtractor` 也必须在
任何检索、摘要或跨 session 投影前丢弃它；不能只依赖事件订阅阶段的过滤。

Day 5 spike 要先验证 hook 与 Pi 自动 retry、compaction 和多轮 tool loop 的真实顺序。
如果不能稳定控制最终消息、不能关联 entry ID，或加入 Relay 内容后无法守住预算，
才记录失败证据并考虑最小 Pi core patch。

## 7. 预算优先级

从不可丢弃到可裁剪：

1. Pi system/tool contract 的保留预算。
2. 当前用户输入与尚未闭合的 tool call/tool result。
3. 全部 active group facts 与当前任务验收条件。
4. 当前 session 的近期显式历史。
5. 已授权且相关的摘要。
6. 已授权且相关的较早原文或产物引用。

固定部分已经超预算时返回显式错误；不得通过丢弃当前事实、工具结果或绕过授权
来“尽量运行”。首版 token 数是保守估算值，manifest 必须标记 estimator 版本，
不能把估算值宣传成 provider 的精确计费 token。

## 8. 检索策略与 MVP 裁剪

首版是面向 Pi 历史的受限 RAG，不是通用知识库 RAG：

- descriptor 元数据先按 group、关系、task、entry type 和 exposure 授权。
- 只加载 allowed IDs 的正文。
- 使用关键词/BM25、文件路径、任务 ID、记录类型和时间衰减做确定性排序。
- 不引入向量数据库；embedding 混合排序只作为完成 MVP 后的可选对照。
- 若以后使用外部 embedding provider，必须另行说明正文离开本机的隐私边界。

基线至少比较：

```text
Pi/default 或授权范围内全量上下文
vs
Relay 授权 + 词法检索 + 预算上下文
```

有余量时再增加 `词法 + 本地 embedding`，不能为了做第三条曲线牺牲授权和 canary
测试。

## 9. MVP 明确不做

- 修改 Pi 原始 JSONL schema 或重写 Pi agent loop。
- 通用 chunking 平台、向量数据库、外部 RAG 服务或长期人格记忆。
- 自动从任意旧自然语言中识别并擦除过期事实。
- LLM 权限判断、LLM 自动降密或先总结全部历史再授权。
- 任意 DAG、并发仓库写入、多机调度、完整 GUI 或 OS 沙箱。
- 完整交互式 CLI 和 SQLite；首版使用内存服务加可恢复 JSON 状态/演示产物。

## 10. 架构完成条件

只有同时满足以下证据，才可称为“逻辑接管 Pi 上下文”的 MVP：

1. Pi 原始历史格式未修改，sidecar 可稳定关联并校验原条目。
2. 禁止 descriptor 对应的正文没有进入加载、检索、摘要、最终 messages 或日志。
3. 更新一个 group fact 后，所有同组 session 下一次 prompt 使用新版本；旧 managed
   fact 不再注入。
4. 同一工具循环多次 LLM 调用复用相同 snapshot，且新 tool result 没有被丢失。
5. 长历史可由近期原文、持久摘要和本轮授权检索结果共同组成。
6. 每次最终 messages 都有可核对的 ContextManifest。
7. 固定多 session 任务能比较全量基线与 Relay 的 token、证据送达、任务结果和
   fake canary 泄漏情况。
