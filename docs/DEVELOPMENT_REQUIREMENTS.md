# 开发需求（v2）

## 1. 项目目标

在 Pi coding agent 的多个独立 session 之上，实现一个本地、可审计、可复现的上下文编排层。系统不修改 Pi core 和原始 session JSONL，而是为原始 entry 建立旁路权限索引，独立维护 group 当前事实，并在每次模型调用前从已授权历史、摘要和显式开发记录中构建最小必要上下文。

项目的简历价值不在“又做了一个聊天界面”，而在以下工程问题：

- 多会话之间如何建立相对关系和读权限。
- 如何把“允许读取”和“本轮实际注入”分开。
- 如何证明禁止记录没有进入模型输入。
- 如何让权威 group facts 独立于普通聊天和 Pi compaction 做版本切换。
- 如何用授权后的历史检索、摘要和结构化开发证据减少全量广播。
- 如何在相同任务上做可复现的基线对照。

## 2. 技术基线

### 2.1 必需环境

| 项目 | 最低要求 | 用途 |
|---|---:|---|
| 操作系统 | Windows 10/11 | 首个开发与演示平台 |
| Node.js | 22.19.0 | 与当前 Pi coding-agent 包的 engine 约束对齐 |
| npm | 随 Node.js | 安装和运行依赖 |
| Git | 当前稳定版 | 版本管理和演示代码仓库 |
| PowerShell | 7 推荐 | 本地命令行演示 |
| 模型凭据 | Pi 支持的任一 provider | 真正执行 Agent 任务 |

当前 `package.json` 固定 Pi coding-agent `0.85.1` 和 Vitest `4.1.11`。项目使用 Node.js 原生 JavaScript ES modules，不需要 TypeScript 编译步骤。升级 Pi 必须单独提交并记录 SDK 行为变化，避免开发期间无意漂移。

### 2.2 首次下载

1. 安装 Node.js 和 Git。
2. 在项目根目录运行 `npm install`。
3. 使用 Pi 官方认证方式配置一个模型；密钥不得进入仓库。
4. 需要阅读上游实现时再克隆 Pi 仓库，普通开发不要求克隆上游。

### 2.3 当前不需要

- Python 或 Conda。
- Docker、WSL 或远程服务器。
- PostgreSQL、MySQL 等数据库服务。
- 向量数据库、embedding 模型或外部 RAG 服务。

MVP 的 history RAG 使用授权后的确定性词法检索，不增加上述服务。Relay 自有状态
先通过内存 repository 和原子 JSON snapshot/replay 恢复；领域接口保持可替换，
SQLite 放到核心闭环之后评估。

## 3. 用户故事

作为单一用户，我希望：

1. 创建一个 group，并把若干 Pi session 放入该 group。
2. 指定 session 的父子关系，由系统计算当前读者相对于记录来源的关系。
3. 把任务发给 group 入口，由 supervisor 产生显式计划并分发给 worker/tester。
4. 让 worker 只看到任务、active group facts、允许的上游设计和检索到的相关历史，而不是 supervisor 的全部对话。
5. 让 tester 看见待验证变更和验收条件，但看不到无关私有讨论。
6. 让 supervisor 收到结构化实现报告和测试证据，并给出最终审核。
7. 更新一个权威事实后，让所有同组 session 在下一次 prompt 使用新版本，旧 managed fact 不再注入。
8. 在每次模型调用后查看 manifest，确认哪些 Pi entry、事实、摘要或记录被包含/排除及原因。
9. 重启程序后重新绑定 Pi sessions，并恢复 group、权限头、事实、摘要、任务和审计清单。

## 4. 功能需求

### FR-01 Pi session 适配

- 使用 Pi SDK 的 `createAgentSession`、`AgentSession`、事件订阅和 `SessionManager` 管理各自独立的会话生命周期。
- 不重新实现 Pi 的 provider 调用、tool-call loop、内置文件/PowerShell 工具或单会话历史。
- 第一项可执行试验必须证明：两个 session 可独立保留历史，且调用方可在 prompt 前构造显式上下文包。
- 第二项接入试验必须证明：extension `context` hook 能在每次 LLM call 前幂等重建
  messages，保留当前 tool call/result，并且 managed context 不作为普通历史持久化。

### FR-02 Group 与关系

- 一个 group 可包含 N 个 session；MVP 演示固定使用 3 至 4 个。
- 每个 group 有且仅有一个 root；其他 session 必须通过同 group 的唯一父节点接入
  这棵树，一个 session 可以有多个直接子节点。
- 从读取者与记录来源的相对位置计算：`SELF`、`SUPERIOR`、`PEER`、`SUBORDINATE`、`UNRELATED`。
- 角色名称只是展示属性，不能代替关系计算。

### FR-03 记录模型

Task 是 group 内的一次工作指令，包含 issuer、assignee、goal、验收条件和状态；
它不形成第二棵权限树，也不参与记录授权。

至少区分以下数据：

- `ConversationEvent`：用户消息、助手显式输出、工具调用和工具结果。
- `DevelopmentRecord`：工作指令、计划、决策、实现报告、补丁摘要、测试证据、问题、交接、产物和摘要。
- `HistoryEntryDescriptor`：指向 Pi 原始 entry、但不含正文的 sidecar 权限头。
- `HistorySummary`：由已授权来源生成、带来源 ID/hash 的结构化摘要。
- `GroupFact`：按 key/version 管理的 group 权威当前事实。

每个 descriptor 至少包含稳定 ID、Pi session/entry 引用、group/session/task 来源、
entry type、exposure、状态、内容哈希和 schema 版本。descriptor 不得包含正文。

普通 Pi message/tool result 默认使用 `WORK_RECORD`。只有 Relay 创建受控任务指令或
handoff 时已显式指定 exposure，索引器才能写入更宽级别；MVP 不允许模型自动分类
或原地扩大已有历史的 exposure。需要主动公开时，source 显式发布新的
DevelopmentRecord，或 root 发布新的 GroupFact。Pi compaction entry 只登记元数据，
不进入跨 session 检索正文。

同一 group、同一 fact key 最多一个 `ACTIVE` 版本；旧版本进入 `SUPERSEDED` 或
`REVOKED`。MVP 仅 group root 可发布、替换或撤销事实。事实不得以 persistent
custom message 复制到每个 Pi session。

### FR-04 内容级别与授权

HistoryEntryDescriptor、DevelopmentRecord 和 HistorySummary 的内容级别从严格到
宽松为：

- `WORK_RECORD`：source 自身及其祖先可读。
- `DESIGN_CONTEXT`：在上述范围外，source 的子孙也可读。
- `GROUP_FACT`：同 group 所有节点可读。

跨 group 始终拒绝。同 group 但不构成祖先/子孙关系的节点只能读取
`GROUP_FACT`。祖先可以读取后代全部显式工作记录；“全部”不包含 hidden
chain-of-thought、凭据或已被事件适配层丢弃的内容。

授权必须是确定性代码，并在任何语义检索、关键词匹配或模型排序之前执行。
AuthorizationFilter 只接收不含 payload 的 descriptor；被拒绝的原文不能进入
候选集合，也不能传给用于重排或摘要的模型。

派生摘要、handoff 和组合记录默认继承所有来源中最严格的内容级别。允许进一步
收紧，但 MVP 不允许扩大或自动降密。

事实撤销只保证旧 managed fact 不再进入未来 ContextSnapshot；系统不承诺从 Pi
原始自然语言历史中自动识别和删除所有旧事实提及。

### FR-05 上下文生成管线

固定管线：

```text
DescriptorScope
  -> RelationshipResolver
  -> AuthorizationFilter
  -> AllowedContentLoader
  -> ExplicitContentExtractor
  -> LexicalHistoryRetriever
  -> optional authorized-only HistorySummarizer
  -> Projection
  -> BudgetPacker
  -> ContextEnvelope + ContextManifest
```

- `AuthorizationFilter` 只读取 descriptor，决定“允许看”。
- `AllowedContentLoader` 只能按 allowed ID 回读 Pi 原文；被拒绝正文不能进入检索 corpus。
- `ExplicitContentExtractor` 从已允许 entry 中丢弃 thinking block，只保留显式消息、
  tool call/result 和安全元数据。
- `LexicalHistoryRetriever` 决定“本轮有用”，使用 task/file/type/text 与稳定 tie-break。
- `HistorySummarizer` 只接收已授权来源；测试使用 fake，在线模型试验必须显式运行。
- `Projection` 决定以原文、结构化摘要、证据引用或元数据何种形式呈现。
- `BudgetPacker` 在明确 token 预算内保留系统约束、任务目标、关键决策和验收证据。
- `ContextSnapshot` 在一次 agent run 内冻结 fact 和检索版本；同一 tool loop 的多次
  LLM call 复用它，下一次用户 prompt 才读取新事实。

MVP 的“RAG”只指对 Pi/Relay 历史做授权后的受限检索，不做通用知识库或向量库。
embedding 混合排序不是核心完成条件。

### FR-06 Relay 与工作流

MVP 工作流固定为：

```text
user -> supervisor(plan) -> worker(implement)
     -> tester(verify) -> supervisor(review)
     -> optional worker(repair) -> tester(retest) -> supervisor(final)
```

每一步都必须写入显式任务状态和结构化 handoff；工作流控制由应用代码决定，模型只能在允许的决策点输出计划、工作结果或是否需要修复，不能自行越过授权边界。

### FR-07 审计

每次模型调用生成 `ContextManifest`，至少记录：

- 目标 group/session/task。
- 关系快照和策略版本。
- snapshot ID、active fact key/version/hash。
- 纳入 Pi entry/summary/record ID、投影形式、内容哈希、估算 token 数和纳入原因。
- 排除记录 ID 或安全的聚合计数，以及排除原因。
- 最终 prompt/envelope 的哈希。

默认不在普通日志中重复保存完整敏感正文。

### FR-08 本地恢复

- Pi 继续负责其 session 原始历史。
- 本项目首版用原子 JSON 状态保存 group、任务、sidecar descriptor、facts、summary、
  DevelopmentRecord、relay checkpoint 和 manifest。
- 大型补丁、测试日志和演示产物保存在独立本地文件中，Relay 状态只保存引用、哈希和元数据。
- 状态文件必须带 schema version；Store 接口不得依赖 JSON 细节，以便以后换 SQLite。

### FR-09 演示入口

至少提供一个固定命令或脚本：创建/恢复 group、绑定 session、运行顺序任务并输出
manifest。完整交互式 CLI 不是 MVP 完成条件。

首版不制作 Web UI。

### FR-10 评估

同一组固定任务至少运行两个策略：

- Baseline：Pi/default 或允许范围内的全历史输入。
- Relay：按授权、active facts、词法相关性、摘要、投影和预算生成上下文。

记录输入 token、总调用次数、任务是否完成、必要证据是否送达、canary 是否泄露、延迟和人工审核结果。没有实测数据时不得宣传节省比例。

## 5. 非功能要求

- 权限规则必须可单元测试，不能依赖自然语言提示词保证隔离。
- 同一输入、策略版本和记录快照应生成可重复的授权结果与 manifest。
- 日志和错误消息不得输出 API key 或被拒绝记录正文。
- 单用户、本机、顺序执行优先；并发和多租户安全不属于 MVP。
- Windows 下从全新 clone 到运行演示应有一页以内的可复现步骤。

## 6. Phase 1 接入试验的完成条件

状态：2026-09-15 已满足。逐项证据、命令和后续非阻塞缺口见
[`PI_SDK_SPIKE.md`](PI_SDK_SPIKE.md)。

最初的双 session spike 在写持久化和工作流之前已完成，并同时满足：

1. 能从 JavaScript 创建两个独立 Pi session。
2. 能订阅并保存显式事件，而不依赖解析终端文本。
3. session A 与 B 的消息列表相互独立。
4. 调用方能把一个带来源标识的 handoff 注入 B 的下一次输入。
5. 能获取模型和 token/usage 元数据，或明确记录当前 SDK 不提供的字段。
6. 能在无持久化模式下用 fake provider 或最小成本模型完成自动测试；如果不能，则把在线测试单独标记。
7. 写明继续使用 SDK/extension 还是必须最小 fork Pi core 的证据。

该试验只证明基础 SDK 接入，不证明 `context` hook 足以接管最终消息。Day 5 必须
通过第二个 hook spike 后，才开始 HistoryIndexer、FactStore 和 ContextManager。

## 7. MVP 验收标准

- 一个命令可以运行固定 3-session 示例并生成最终结果与逐调用 manifest。
- 固定 5×3 权限矩阵的 15 个组合全部通过，并覆盖跨 group、派生记录最严格
  exposure 继承和 descriptor 不含 payload。
- sidecar 能关联 Pi entry；未知 entry、hash mismatch 和撤销 descriptor 均 fail closed。
- fact 更新后，同组所有 session 下一次 prompt 读取新 active 版本；旧 managed fact
  不再注入，且事实不依赖 Pi compaction 保存。
- canary 测试证明禁止正文未出现在 loader 输出、检索 corpus、目标模型输入、摘要
  输入、manifest 或普通日志中。
- 同一工具循环多次 LLM call 复用 snapshot，且最新 tool result 没有丢失。
- 进程重启后可以重新绑定 Pi sessions 并恢复至少一条未完成的固定工作流。
- baseline 与 relay 使用相同任务、相同模型设置和可比较的运行次数。
- README 中的每个“已实现”主张都有命令、测试或演示产物对应。
