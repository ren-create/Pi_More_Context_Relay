# Pi SDK 双 Session 接入试验与接入决策

## 结论

- 收口日期：2026-09-15。
- SDK：`@earendil-works/pi-coding-agent` `0.85.1`。
- 在线入口：`npm run spike:pi:dual:online`。
- 离线入口：`npm test`。
- 结果：Day 1-2 基础接入完成；公开 SDK 足以继续下一项 context-hook spike。
- 决策：继续使用 Pi SDK；原试验只证明多 session 和显式 handoff，不证明完整上下文
  接管。v2 架构将 extension 作为 `before_agent_start / context / agent_settled` 的必要
  集成点；Day 5 验证失败前仍没有证据支持 fork 或 patch Pi core。
- 范围：只证明两个 session 共存、结构化事件订阅、内存历史隔离、一条受控
  handoff 和 usage 元数据可读；不代表完整 Relay、权限矩阵、持久化或完整泄露
  防护已经实现。

## 试验结构

1. 在同一 Node.js 进程中并发创建两个独立 `AgentSession`。
2. 每个 session 使用自己的 `SessionManager.inMemory()`。
3. 禁用工具、扩展、技能、提示模板和项目上下文加载。
4. supervisor A 生成包含公开字段和 fake private canary 的显式 JSON。
5. 投影逻辑只允许 `plan` 和 `expectedMarker` 进入 handoff。
6. worker B 接收带来源 session ID 的 handoff，并解析来源、marker 和状态。
7. prompt 顺序执行；本试验不进行并行仓库写入。

## 在线证据

- 两个 session ID 不同。
- 两个 session 的消息数组不是同一对象，且各自产生独立历史。
- supervisor 历史包含 fake canary。
- 序列化 handoff 与 worker 历史均不包含 fake canary。
- worker 正确返回来源 session ID、`WORKER_OK` 和 `accepted`。
- 两个 session 都发出了结构化生命周期事件。
- 两个 in-memory session 的 `getSessionFile()` 均为 `undefined`。
- `AgentSession.getSessionStats()` 可返回 session ID、消息计数、token、cost 和
  context usage；不同 provider 对 usage 字段的实际填充程度可能不同。
- 本地运行产物：`artifacts/pi-dual-session-spike.json`，由 `.gitignore` 排除。

在线模型结果有非确定性且可能产生费用，因此不属于默认 `npm test`。脚本会把
模型标识、SDK 版本、两个 session 的统计信息和布尔验收结果写入本地产物。

## 离线回归证据

`tests/integration/pi-sdk-spike.test.js` 不读取模型凭据、不访问网络，覆盖：

1. 两个 `SessionManager.inMemory()` 生成不同 session ID。
2. 两边历史相互隔离且均不生成 session 文件。
3. handoff 只投影 `plan` 和 `expectedMarker`，fake private canary 不会进入结果。
4. `thinking_delta` 在事件记录创建前即被丢弃。
5. `text_delta` 只记录类型和字符数，不复制正文到普通事件日志。
6. 显式助手 JSON 输出可由接入适配逻辑解析。

默认测试不再使用 `--passWithNoTests`；测试文件意外缺失时，命令会失败而不是把
空测试误报为通过。

## 安全事件样例

事件样例只保留路由和审计需要的元数据，不保存 delta 正文：

```json
{
  "session": "session-A",
  "type": "message_update",
  "updateType": "text_delta",
  "explicitTextCharacters": 12
}
```

## 事件边界发现

在 `kimi/kimi-k2.7-code` 上，即使创建 session 时请求 `thinkingLevel: "off"`，订阅流仍观察到 `thinking_start` 和 `thinking_delta` 事件类型。首轮试验没有保存这些事件的正文；该结果进一步说明 Relay 不能仅依赖模型配置来排除隐藏思维。

适配层必须按事件子类型做字段级过滤：只保留显式 `text_delta` 和允许的生命周期/工具元数据，直接丢弃所有 thinking 更新，不将其写入记录、handoff、manifest 或普通日志。当前 spike 已按此规则收紧。

## SDK 能力与缺口

| 项目 | 结论 | 对 MVP 的处理 |
|---|---|---|
| 创建多个独立 `AgentSession` | 支持 | 由 Pi adapter 包装生命周期 |
| `SessionManager.inMemory()` | 支持 | 用于测试和首个进程内演示 |
| 结构化事件订阅 | 支持 | 只接受显式文本和允许的元数据 |
| 调用前注入 handoff | 支持 | 先由 Relay 生成 envelope，再调用 `prompt()` |
| 模型、消息与 usage 统计 | 支持 | 从 session/model 和 `getSessionStats()` 读取 |
| 跨 session 关系与权限 | SDK 不提供 | 由本项目实现，这是核心价值 |
| 每次 LLM call 前修改消息 | 文档提供 `context` hook，本轮未实测 | v2 Day 5 单独 spike |
| 授权后检索、摘要、投影和预算 | SDK 不提供 | 由 Context Manager 实现 |
| Relay manifest | SDK 不提供 | 由本项目生成和持久化 |
| 关闭 thinking 后保证无 thinking 事件 | 不保证 | 适配层按事件子类型 fail closed |
| 进程重启恢复 Relay 状态 | 本轮未验证 | v2 Day 13 JSON 恢复切片处理 |

基础多 session 缺口都位于 Pi 单 session runtime 之外。公开 SDK 已提供创建 session、
订阅事件、读取历史、注入 prompt 和取得统计信息的必要接缝，因此 Phase 1 的结论是
**足以进入 Context Manager 可行性验证**，而不是提前宣称完整 SDK 路线已经闭环。

## Phase 1 完成条件映射

| 完成条件 | 证据 | 状态 |
|---|---|---:|
| JavaScript 创建两个独立 session | 在线 spike 创建两个不同 ID | 通过 |
| 订阅并保存显式结构化事件 | `session.subscribe()` + 安全事件样例 | 通过 |
| A/B 消息列表与历史独立 | 在线检查 + 离线回归测试 | 通过 |
| 带来源 handoff 注入 B | source/target ID 和 worker 解析检查 | 通过 |
| 模型和 usage 元数据 | model spec + `getSessionStats()` | 通过 |
| 默认测试不消耗模型额度 | Vitest 离线测试；在线命令单独标记 | 通过 |
| 基础 SDK/core 决策 | SDK 足以继续；不 fork | 通过 |

## 2026-09-15 收口验证

```text
Node.js: v24.14.1
npm: 11.11.0
@earendil-works/pi-coding-agent: 0.85.1
vitest: 4.1.11
npm run check: PASS
npm test: PASS (1 file, 8 tests)
npm run spike:pi:dual:online: PASS
```

本次在线运行使用 `kimi/kimi-k2.7-code`，两个 session 分别产生 2 条消息；
SDK 报告的 token 总数分别为 174 和 310。所有布尔验收项均为 `true`，包括 usage
元数据可读、handoff/worker 历史不含 fake private canary，以及两个 session 不生成
持久化文件。这些 token 数只属于本次接入 smoke，不是性能基线或节省结论。

## 后续非阻塞事项

- 尚未验证 session 持久化或进程重启恢复。
- 关系解析和 DevelopmentRecord descriptor 级 `AuthorizationFilter` 已在 Day 3-4
  完成；尚未实现 Pi `HistoryEntryDescriptor`、FactStore、`ContextManifest`、
  模型输入级 canary 矩阵或完整 Context Manager。
- extension `context` hook 虽有上游文档接口，尚未验证幂等注入、tool result 保留、
  snapshot 生命周期和加入 managed content 后的预算行为。
- 尚未比较 full-history baseline 与 scoped relay。

以上事项属于 v2 Day 5-13，不推翻 Day 1-2 基础接入证据，但必须在宣称“逻辑接管
Pi 上下文”之前完成。
