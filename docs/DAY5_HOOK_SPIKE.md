# Day 5 Pi context-hook spike 收口

日期：2026-09-16  
Pi coding-agent：0.85.1  
Provider：`@earendil-works/pi-ai@0.85.1` `fauxProvider`  
网络：关闭  
持久化：`SessionManager.inMemory()`；未写入真实 session 文件

## 结论

本次修正后的结果为 `GO_SDK`。这只证明 Day 5 的公开 hook 可行性，不表示已经实现
ContextManager；本次也没有 patch Pi core。

最终 decision：

```text
GO_SDK
```

原 H05 失败来自 spike 在 Pi 已把 custom message 转成 provider `user` message 后仍按
custom 结构计数；原 compaction 失败来自 response factory 参数顺序错误。两者均已修正，
没有形成修改 Pi core 的证据。

## 实际运行

最终 artifact：[artifacts/pi-context-hook-spike.json](../artifacts/pi-context-hook-spike.json)

artifact 共 59 条记录，`sequence` 为连续的 `1..59`，无重复、无缺口。四个 scenario 均有
非空 session ID 和唯一 snapshot。所有 provider 观察来自 faux provider response factory；
`before_provider_request` 没有被当作唯一 provider-call 证据。

| Scenario | 关键顺序 | 观察结果 |
|---|---|---|
| `normal` | `1 BEFORE_AGENT_START → 4 CONTEXT → 7 AGENT_SETTLED` | agent-1 最终 Context 可观察；managed block 未出现在 faux provider 最终 Context。 |
| `tool-loop` | `8 BEFORE_AGENT_START → 11 CONTEXT → 12 TOOL_START → 13 TOOL_END → 16 CONTEXT → 19 AGENT_SETTLED` | 固定 `day5-tool-fixed-001` 同时存在于 assistant tool call 和对应 tool result。 |
| `auto-retry` | `20 BEFORE_AGENT_START → 23 CONTEXT → 28 CONTEXT → 31 AGENT_SETTLED` | retry 前后 snapshot 相同，两个 retry provider call 均经过 context。 |
| `auto-compaction` | `37 BEFORE_AGENT_START → 40 CONTEXT(agent-1) → 41 PROVIDER_CALL → 42/43 TOOL → 46 CONTEXT(agent-2) → 47 PROVIDER_CALL → 50 COMPACTION_BEFORE(reason=overflow) → 51 PROVIDER_CALL(compaction-summary) → 52 COMPACTION_SUCCESS → 55 CONTEXT(agent-3) → 56 PROVIDER_CALL → 59 AGENT_SETTLED` | compaction 成功后 managed marker 仍为一份，固定 tool call/result 仍成对存在。 |

## 16 项验收结果

| Check | Status | 说明 |
|---|---|---|
| H01 | PASS | 四个 scenario 各一次 `before_agent_start`。 |
| H02 | PASS | 核心 hook 使用同一非空 session ID。 |
| H03 | PASS | 每个 run 的 context call 使用同一 snapshot。 |
| H04 | PASS | 每个 agent/retry provider observation 都有全局 sequence，并与同一 `contextCallIndex` 的 context 一一对应。 |
| H05 | PASS | Pi 转换后的 provider `user` message 中安全 marker 每次恰好一份。 |
| H06 | PASS | context 重建保持一份 managed block。 |
| H07 | PASS | 非 managed 消息值、顺序和相对位置保持。 |
| H08 | PASS | `tool-loop` 中固定 toolCallId 闭环成立；非归属 scenario 不生成 H08 证据。 |
| H09 | PASS | `auto-retry` 前后 snapshot 不变，retry 两次均有 context。 |
| H10 | PASS | 自动 compaction 的 before、summary provider call、success、下一次 context/provider 顺序可定位。 |
| H11 | PASS | compaction 后 provider Context 仍含固定 `day5-tool-fixed-001` 的 tool call/result。 |
| H12 | PASS | 每次 context 都输出估算来源、预算字段和缺口。 |
| H13 | PASS | settled handler 记录 active snapshot 删除前为 1、删除后为 0。 |
| H14 | PASS | `session.state.messages`、`buildSessionContext().messages` 和 entries 的实际 message 字段均无 managed block。 |
| H15 | PASS | 完整 artifact 不含 managed、tool-result、thinking 三个合成 canary。 |
| H16 | PASS | 注入式异常和 runtime failure 必须包含 stage、sequence、code 及安全错误摘要；内部失败不再反向导致 H16 自身失败。 |

## 安全审计

对完整 artifact 做了字符串扫描，结果如下：

- `SYNTHETIC_MANAGED_CONTEXT_CANARY`：不存在
- `SYNTHETIC_TOOL_RESULT_CANARY`：不存在
- `SYNTHETIC_THINKING_CANARY`：不存在
- credential-like 模式（API key、access token、Bearer、password、secret）：不存在
- `failureLocation`：`null`；最终运行没有内部、setup、prompt 或写盘失败

完整 artifact 的 H01-H16 均为 `PASS`。

## 验证命令

```text
node --check src/pi-context-hook-spike.js
node --check scripts/pi-context-hook-spike.mjs
npx vitest run tests/unit/pi-context-hook-spike.test.js
npm run spike:pi:context
npm run check
npm test
```

结果：Day 5 定向测试 15/15；`npm run check` 通过；全量测试 79/79，其中既有测试
64 项保持通过，Day 5 测试 15 项。runtime spike 退出码为 0，artifact 在 `finally`
写出。

## 后续边界

Day 5 结论允许后续按既定计划实现 ContextManager 的下一垂直切片；本结论不授权实现
HistoryIndexer、检索、摘要或修改 Pi core。
