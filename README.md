# Pi More Context Relay

> A policy-aware context relay for coordinating multiple Pi agent sessions.

Pi More Context Relay 是一个基于 [Pi coding agent](https://github.com/earendil-works/pi) 的简历项目。它不重新实现模型调用和单会话 agent loop，也不修改 Pi 原始 session JSONL；它在多个独立 Pi 会话之上逻辑接管每次模型调用的上下文构建：为原始历史建立旁路权限头，维护不参与 Pi 压缩的版本化 group facts，从已授权历史中检索和总结本轮必要内容，并解释为什么包含或排除每条信息。

## 当前状态

- 阶段：Day 1-7 已完成离线/in-memory 验证；Day 8 尚未开始。
- 日期：2026-09-17。
- 已完成：依赖和版本验证、JavaScript 双 session 在线 spike、结构化事件订阅、内存历史隔离、字段白名单 handoff，以及不联网的接入回归测试；Day 5 faux-provider spike 进一步验证了普通回复、tool loop、auto-retry、auto-compaction、临时 managed context 和 settled 清理。
- 接入决策：`before_agent_start / context / agent_settled` 公开 extension 接缝满足 Day 5 验收，16 项检查全部通过，决策为 `GO_SDK`；没有证据支持 fork 或 patch Pi core。事件证据见 [Day 5 hook spike](docs/DAY5_HOOK_SPIKE.md)。
- 已实现：每个 group 唯一 root、任意数量子 session、父子/祖先/后代双向查询、五类相对关系、最小 Task、DevelopmentRecord，以及“祖先读完整显式工作记录、子孙读设计内容、其他同组分支只读公开事实、跨组拒绝”的 5×3 固定授权矩阵。接口规范见 [Group 与 Session Tree 接口规范](docs/GROUP_TREE_SPEC.md)和 [Task、DevelopmentRecord 与授权接口规范](docs/TASK_RECORD_AUTH_SPEC.md)。
- Day 6：Pi 0.85.1 in-memory history sidecar 与七场景 runner 已通过；D6-H01–H17 全 PASS，`DAY6_COMPLETE_GO_DAY7`。证据见 [Day 6 实现与验证记录](docs/DAY6_HISTORY_SIDECAR.md)和本地产物 `artifacts/pi-history-sidecar-spike.json`。
- Day 7：root-only 版本化 GroupFactStore、预算化事实 snapshot、跨 session 下一 run 生效测试和六场景 runner 已通过；D7-H01–H16 全 PASS，`DAY7_COMPLETE_GO_DAY8`。证据见 [Day 7 实现与验证记录](docs/DAY7_GROUP_FACT_STORE.md)和本地产物 `artifacts/group-fact-store-spike.json`。
- 尚未实现：授权后词法检索/排序、历史摘要、正式 ContextManager、projection/token budget/manifest、最终 context 注入、完整 Relay、持久化/恢复和基线评估。尚未读取真实用户 session，也未调用真实模型。
- 项目边界：只基于 Pi 开发，不导入、复制或继续修改 MrR。

## MVP 要解决的问题

普通多 Agent 示例往往把其他会话的全部历史直接拼进提示词。这样虽然容易运行，却会产生三类问题：无关上下文浪费 token、敏感或私有记录越权泄露、最终结果难以解释“信息是从哪里来的”。

本项目的 MVP 将实现：

1. 在一个 group 中管理 3 个以上相互独立的 Pi session。
2. 通过会话关系计算 `SELF / SUPERIOR / PEER / SUBORDINATE / UNRELATED`，而不是把角色数量写死。
3. 保留 Pi 原始历史，为每条可检索 entry 建立不含正文的 `HistoryEntryDescriptor` sidecar。
4. 用独立 `GroupFactStore` 管理 `ACTIVE / SUPERSEDED / REVOKED` 事实版本，每轮临时注入当前事实。
5. 严格按 `descriptor 授权 -> 允许正文加载 -> 历史检索/摘要 -> 投影 -> token 预算` 的顺序重建上下文。
6. 每次模型调用生成 `ContextEnvelope` 和 `ContextManifest`，记录实际暴露了什么、排除了什么及原因。
7. 完成固定但可演示的 `计划 -> 实现 -> 测试 -> 审核` 顺序工作流。
8. 对比“Pi/default 或授权范围全量历史”和“授权 + 词法检索 + 预算投递”在 token、任务完成率、证据送达率和越权泄露率上的差异。

## 首个版本不做什么

- 不实现新的 LLM provider、底层 tool-call loop 或 PowerShell 执行器。
- 不做向量数据库、通用知识库 RAG、长期人格记忆或自动事实抽取；MVP 只做面向 Pi 历史、授权后的确定性词法检索。
- 不做任意 DAG、并行写代码、多机调度和完整 GUI。
- 不声称应用层的上下文权限等同于操作系统沙箱。
- 不采集或跨会话传播模型的隐藏思维过程；只共享显式消息、工具结果、决策、补丁摘要、测试证据和交接记录。

## 环境要求

最小开发环境：

- Windows 10/11。
- PowerShell 7 推荐；Windows PowerShell 可用于基础命令。
- Node.js `>= 22.19.0`。
- npm（随 Node.js 安装）。
- Git。
- 一个 Pi 支持的模型提供商账号或 API 凭据，用于真正运行 Agent。

本项目当前按 Pi 上游 `packages/coding-agent/package.json` 的版本快照固定以下依赖：

- `@earendil-works/pi-coding-agent`：`0.85.1`
- Vitest：`4.1.11`

项目运行时代码使用原生 JavaScript ES modules，由 Node.js 直接执行，不需要 TypeScript 编译步骤。

不需要 Python、Conda、Docker、WSL、独立数据库服务器、向量数据库或 embedding 服务。MVP 先用内存领域服务和可恢复 JSON 状态；SQLite 与 embedding 混合检索留到核心闭环完成以后。

## 第一次需要下载什么

先安装 [Node.js](https://nodejs.org/) 和 [Git](https://git-scm.com/)。进入项目目录后再安装项目依赖：

```powershell
cd D:\Project\Pi_WMRAH\Pi_More_Context_Relay
node --version
npm --version
npm install
```

`npm install` 会在本地下载 Pi SDK 和 Vitest。无需先克隆 Pi 上游仓库；只有当公开 SDK/扩展接口无法完成某个必要的上下文注入点时，才考虑建立带清晰上游来源的最小 fork。

模型认证优先使用 Pi 自己的登录或认证配置。不要把 API key、Pi 的认证文件或真实会话内容提交到此仓库。

安装以后可使用：

```powershell
npm run check
npm test
```

`npm run check` 执行 JavaScript 语法检查；`npm test` 运行普通离线接入测试，不会触发在线模型试验。在线双 session 试验必须显式运行 `npm run spike:pi:dual:online`。

## 项目目录

```text
Pi_More_Context_Relay/
├─ docs/          # 需求、v2 架构、上下文规范和两周 MVP 计划
├─ src/
│  ├─ pi/         # Pi SDK/扩展适配层
│  ├─ group/      # group、session 拓扑和关系解析
│  ├─ tasks/      # 最小 Task 生命周期
│  ├─ records/    # DevelopmentRecord、handoff 和可见性标签
│  ├─ history/    # sidecar、授权后加载、词法检索和摘要
│  ├─ facts/      # 版本化 group facts
│  ├─ context/    # snapshot、投影、预算、envelope 和 manifest
│  ├─ relay/      # 任务分发、交接和顺序工作流
│  ├─ store/      # MVP JSON 状态适配；以后可换 SQLite
│  └─ extension/  # Pi 每轮 context 注入入口
├─ tests/         # 单元、集成和权限/泄露测试
├─ benchmarks/    # 对照任务、期望证据和结果
└─ artifacts/     # 本地演示产物；默认不提交
```

这是目标模块结构；Day 1-4 的现有实现暂时仍在 `src/` 根部，后续按垂直切片迁移，
不做一次性目录搬家。详细要求见 [开发需求](docs/DEVELOPMENT_REQUIREMENTS.md)、
[项目架构](docs/ARCHITECTURE.md)、[上下文管理规范](docs/CONTEXT_MANAGEMENT_SPEC.md)
和 [两周 MVP 计划](docs/MVP_PLAN.md)。

## 上游与许可

Pi 是独立的 MIT 许可开源项目。本项目会优先通过公开 SDK/extension API 接入。未来若复制或修改 Pi 示例代码，必须保留原许可和来源说明；在公开发布前还需要为本项目补充正式许可证与第三方声明。
