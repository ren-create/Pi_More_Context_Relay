# Day 5 Pi 上下文接管 spike：冻结实现规格

状态：接口与验收逻辑已实现。2026-09-16 根据 Pi 0.85.1 的可执行证据修订了
auto-compaction 场景名称和真实顺序；其余验收含义保持冻结。

## 1. 目标与非目标

本切片只回答：Pi extension 的公开 hook 是否足以让 Relay 在一次 agent run 内，
对每次 agent LLM call 幂等地重建临时 messages，同时保留工具闭环、跨 retry 和
auto-compaction 使用同一 snapshot，并在 `agent_settled` 后清理状态。

本切片不实现 HistoryIndexer、FactStore、授权检索、HistorySummarizer、正式
BudgetPacker 或 ContextManager。测试内容只使用确定性合成数据和假标识，不读取或
记录真实会话正文、凭据或 hidden thinking。

## 2. 已核对的 Pi 0.85.1 接口事实

- `before_agent_start` 在用户提交 prompt 后、agent loop 前触发；返回 `message` 会被
  持久化，因此本 spike **不得**用它注入 managed context，只用它创建 snapshot。
- `context` 在每个 agent LLM call 前触发，收到 messages 深拷贝，可返回替换后的
  `messages`。
- `ctx.sessionManager.getSessionId()` 可供三个生命周期 hook 定位当前 session。
- `agent_settled` 在普通执行、自动 retry、auto-compaction retry 和 queued
  continuation 全部结束后触发。
- `session_before_compact`、`session_compact`、`session_compact_failed` 暴露
  compaction 的 `reason` 与 `willRetry`。
- Pi 的自动 compaction 分类取决于 provider usage 和 context window。本 spike 的小窗口
  faux 场景被 Pi 分类为 `reason=overflow`；Relay 自己估算的 managed token 增量不能
  假定已包含在 Pi 的 compaction 判定里。

## 3. 文件边界

Luna 只实现或修改以下文件：

```text
src/pi-context-hook-spike.js
scripts/pi-context-hook-spike.mjs
tests/unit/pi-context-hook-spike.test.js
package.json
package-lock.json
tests/README.md
docs/DAY5_HOOK_SPIKE.md
```

允许把 `@earendil-works/pi-ai@0.85.1` 增加为固定的直接依赖，因为脚本直接使用其
`fauxProvider`、`fauxAssistantMessage`、`fauxToolCall` 和 `Type`。不得增加其他依赖。

不得改动 Day 1-4 的业务实现或既有测试断言。不得修改 Pi core、`node_modules`、
session JSONL 或真实用户配置。

## 4. 冻结常量与公共函数

`src/pi-context-hook-spike.js` 必须导出下列名字。参数校验失败应抛出带稳定
`code` 属性的 `Day5SpikeError`，不得静默降级。

```js
DAY5_SCHEMA_VERSION = 1
MANAGED_CUSTOM_TYPE = "pi-more-context-relay/day5-managed-v1"
CHECK_STATUS = { PASS, FAIL, UNOBSERVED }
DECISION = {
  GO_SDK,
  NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH,
  INCONCLUSIVE_RERUN
}

class Day5SpikeError extends Error

createManagedMessage({ snapshotId, blockTag, managedText, timestamp })
isManagedMessage(message, { blockTag })
stripManagedMessages(messages, { blockTag })
findManagedInsertionIndex(messages)
inspectToolClosure(messages)
estimateBudget({ messagesBefore, messagesAfter, contextWindow, reserveTokens,
                 estimateMessageTokens, piContextUsage })
rebuildManagedContext({ messages, snapshot, estimateMessageTokens,
                        contextWindow, reserveTokens, piContextUsage })
createDay5HookHarness({ managedText, blockTag, now, createId, emit,
                        estimateMessageTokens, reserveTokens,
                        sequenceStart = 0 })
evaluateDay5Decision({ checks })
```

### 4.1 Managed message

Managed block 使用临时 Pi custom agent message：

```js
{
  role: "custom",
  customType: MANAGED_CUSTOM_TYPE,
  content: "<relay-managed-context ...>...</relay-managed-context>",
  display: false,
  details: { schemaVersion: 1, snapshotId, blockTag },
  timestamp
}
```

只有同时满足 `role`、`customType`、`details.schemaVersion` 和本次 harness 的
`blockTag` 才可被识别并删除。不得仅凭用户正文中出现 XML 标记删除消息。

`managedText` 必须是合成的公开测试文本。诊断事件不得复制 `managedText` 或其他
message/tool-result 正文，只能记录长度、role、toolCallId、计数和布尔检查。

### 4.2 幂等重建

`rebuildManagedContext` 的固定算法：

1. 校验当前 snapshot、session ID、messages 与预算参数。
2. 删除本 harness 先前注入的全部 managed message；记录删除数量和 snapshot ID，
   不删除其他 extension 的 custom message。
3. 在最后一个 user message之前插入一份当前 snapshot 的 managed message；没有 user
   message 时在索引 0 插入。
4. 除删除本 harness 的旧 block 外，所有输入消息必须保持值、顺序和相对位置不变。
5. 对重建后的 messages 检查 managed block 恰好一份。
6. 检查所有 assistant tool call 与 toolResult 的匹配关系；至少输出 dangling call、
   orphan result、最新 tool result 是否仍在以及其 ID。
7. 计算并返回预算诊断，不在本切片裁剪历史。

返回结构固定为：

```js
{
  messages,
  diagnostic: {
    removedManagedCount,
    finalManagedCount,
    insertionIndex,
    originalMessagesPreserved,
    toolClosure,
    budget
  }
}
```

### 4.3 预算诊断

预算输出必须同时保留估算来源，不能把启发式估算冒充 provider 精确 token：

```js
{
  method: "pi-estimateTokens-sum",
  baseEstimatedTokens,
  managedEstimatedTokens,
  finalEstimatedTokens,
  contextWindow,
  reserveTokens,
  inputThreshold,
  budgetGap,
  piLastReportedTokens,       // number | null
  piLastReportedPercent      // number | null
}
```

其中 `budgetGap = Math.max(0, finalEstimatedTokens - inputThreshold)`。Pi 最近一次
usage 与本次重建估算必须分字段输出；不得相加，因为最近 usage 可能已经包含上一次
managed block。

## 5. Hook harness 状态机

`createDay5HookHarness` 返回：

```js
{
  extension,              // named InlineExtension
  getActiveSnapshots(),   // 只读诊断副本
  getRecords(),           // 只读诊断副本
  getChecks(),            // 当前 scenario 的完整、语义相关 check 副本
  noteProviderCall(record),
  finalize()
}
```

内部状态按 `sessionId` 建 `Map`，snapshot 至少包含：

```js
{
  snapshotId,
  sessionId,
  runOrdinal,
  createdAt,
  contextCallCount,
  providerAgentCallCount,
  settled: false
}
```

生命周期逻辑冻结如下：

- `before_agent_start`
  - 从 `ctx.sessionManager.getSessionId()` 取 session ID。
  - 为该 session 创建唯一 snapshot，并输出 `SNAPSHOT_CREATED`。
  - 若已有未清理 snapshot，输出 `STALE_SNAPSHOT_ACTIVE` 的 FAIL 证据后再替换，禁止
    静默覆盖。
- `context`
  - 无 snapshot 或 session ID 不匹配时输出 FAIL，并返回原 messages，禁止无归属注入。
  - 调用 `rebuildManagedContext`，递增 call index，逐项输出 managed 数量、原消息保持、
    工具闭环和预算结果。
  - 函数异常时输出精确 stage/code，并返回原 messages；最终决策必须 FAIL，不能因为
    Pi 仍产生回复而判定成功。
- `agent_settled`
  - 输出 settlement 记录，删除本 session snapshot。
  - 未找到 snapshot 时输出 FAIL，禁止假装完成清理。
- compaction hooks
  - 只记录 `reason`、`willRetry`、`fromExtension`、tokensBefore 等安全元数据，不取消、
    替换或触发 compaction。
- 其他生命周期
  - 记录 `agent_start/end`、`turn_start/end`、tool execution start/end；不得记录消息或
    工具结果正文。

## 6. 可执行脚本与确定性场景

`scripts/pi-context-hook-spike.mjs` 使用 Pi SDK 的 in-memory `SessionManager`、
`SettingsManager`、named inline extension，以及 `pi-ai` 的 faux provider。它验证真实
Pi runtime，不联网、不使用用户模型额度、不写 session 文件。

命令：

```text
npm run spike:pi:context:check
npm run spike:pi:context
```

默认依次运行四个隔离场景；每个场景使用新的 session、harness 和 faux provider：

1. `normal`：一次 agent LLM call 后正常结束。
2. `tool-loop`：第一次 faux 响应发出固定 ID 的 `day5_probe_tool` call，工具返回合成
   结果，第二次 agent LLM call 正常结束。
3. `auto-retry`：第一次 faux 响应为可重试 503 error，第二次正常结束；retry delay
   设为 0，最多一次。
4. `auto-compaction`：小 context window 加大体积的合成 tool result，并在 `agent_end`
   排入一次 follow-up，使 Pi 自动 compaction 成功后继续同一 run。Pi 0.85.1 实测将其
   分类为 `reason=overflow`。faux response 队列明确区分 `agent-1`、`agent-2`、
   `compaction-summary`、`agent-3`，不得靠 prompt 文本猜测用途。

如果某场景因 Pi 实际约束无法构造，必须记录为 `UNOBSERVED` 和具体原因，整体只能是
`INCONCLUSIVE_RERUN`，不能算 PASS。实现者不得为让测试通过而 patch Pi core。

## 7. 分层输出与失败定位

所有运行步骤使用整个 artifact 范围内单调递增且不重复的 `sequence`。每个 scenario
创建 harness 时把前一 scenario 的末尾序号作为 `sequenceStart`；不得在合并 artifact
后留下重复序号。控制台每一步输出单行 JSON，至少包含：

```js
{
  schemaVersion: 1,
  sequence,
  scenario,
  stage,
  status,          // INFO | PASS | FAIL | UNOBSERVED
  code,
  sessionId,
  snapshotId,
  contextCallIndex,
  evidence         // 仅安全元数据
}
```

固定 stage：

```text
SETUP -> BEFORE_AGENT_START -> AGENT_START -> TURN_START -> CONTEXT
-> PROVIDER_CALL -> TOOL_START -> TOOL_END -> COMPACTION
-> RETRY -> AGENT_END -> AGENT_SETTLED -> HISTORY_AUDIT -> DECISION
```

脚本即使在 setup、prompt、tool、compaction 或断言阶段抛错，也必须在 `finally` 中尽力
写出 `artifacts/pi-context-hook-spike.json`。artifact 至少包含：

```js
{
  schemaVersion,
  createdAt,
  piSdkVersion,
  execution,
  scenarios,
  records,
  checks,
  decision,
  failureLocation,
  passed
}
```

`failureLocation` 保存 scenario、stage、sequence、稳定错误 code、错误类型和脱敏后的
message；不得保存 stack 中的凭据或整份 provider payload。退出码：`GO_SDK` 为 0，
`NO_GO...` 或 `INCONCLUSIVE...` 为 1。

诊断输出必须使用显式安全字段白名单，但白名单至少要包含所有验收实际读取的字段：

```text
runOrdinal, removedManagedCount, finalManagedCount, insertionIndex,
originalMessagesPreserved, toolClosureClosed, latestToolResultId,
latestToolResultPresent, matchingToolPairIds, budgetMethod,
baseEstimatedTokens, managedEstimatedTokens, finalEstimatedTokens,
contextWindow, reserveTokens, inputThreshold, budgetGap,
piLastReportedTokens, piLastReportedPercent, contextCallCount,
providerAgentCallCount, activeSnapshotCountBefore, activeSnapshotCountAfter,
messageCount, entryCount, persistedManaged, toolCallId, toolName,
reason, willRetry, fromExtension, isError, tokensBefore, turnIndex,
providerCallIndex, providerPurpose
```

必须新增单测证明这些数值/布尔/ID 字段经过脱敏层后仍存在，同时正文和 canary 不存在。
“计算正确但被日志白名单删除”属于 spike 实现失败，不是 Pi hook 失败。

## 8. 冻结验收矩阵

每项 check 使用独立 ID、`PASS | FAIL | UNOBSERVED` 和 `evidenceSequences`：

| ID | 必须证明 |
|---|---|
| D5-H01 | 每个 scenario 的 `before_agent_start` 恰好一次 |
| D5-H02 | 三个核心 hook 均可取得同一非空 session ID |
| D5-H03 | 同一 agent run 的所有 context call 使用同一 snapshot |
| D5-H04 | 每个 agent provider call 前恰好有一次 context hook |
| D5-H05 | 每次最终 provider context 中 managed block 恰好一份 |
| D5-H06 | 把上次输出再次传入重建仍只有一份 managed block |
| D5-H07 | 非 managed 原消息值与顺序全部保留 |
| D5-H08 | tool-loop 第二次 call 保留匹配的 tool call/result 和固定 ID |
| D5-H09 | retry 前后 snapshot 不变，且 retry call 再次经过 context |
| D5-H10 | auto-compaction 的 before/success/下一次 context 顺序可定位 |
| D5-H11 | compaction 后工具闭环仍有效 |
| D5-H12 | 每次 call 均输出 managed 增量和预算缺口，来源标记为估算 |
| D5-H13 | `agent_settled` 后 active snapshot 数为 0 |
| D5-H14 | agent state、SessionManager context、entries 均不含 managed block |
| D5-H15 | diagnostics/artifact 不含 tool result 正文或 thinking 内容 |
| D5-H16 | 任一内部异常都会落为 FAIL/UNOBSERVED，不会被最终回复掩盖 |

check 的 scenario 归属固定如下，非归属 scenario 不产生该 check 的 `UNOBSERVED`：

- H01-H07、H12-H16：四个 scenario 都必须通过，聚合时任一失败即失败。
- H08：只由 `tool-loop` 提供证据。
- H09：只由 `auto-retry` 提供证据。
- H10-H11：只由 `auto-compaction` 提供证据。

不得像普通矩阵那样给每个 scenario 都生成 16 项并把“不适用”写成 `UNOBSERVED`；
否则即使专属场景通过，最终也会被无关场景永久聚合为 inconclusive。

H04/H05 使用 faux provider response factory 对**最终收到的 Context**所做的观察，不以
`before_provider_request` 作为唯一证据。native faux provider 不保证构造 provider
payload，因此该 hook 可能不触发。每个 scripted faux response 必须显式标记
`providerPurpose = agent-1 | agent-2 | agent-3 | retry | compaction-summary`：

- H04 只比较 agent/retry provider call 与 `context`，必须一一对应且 context 序号在前。
- compaction-summary 是独立摘要调用，预期不经过 agent `context`，不能误报漏触发。
- H05 必须检查 provider 最终 Context 中 managed block 恰好一份，不能只检查 hook
  返回值。

H08/H11 必须检查固定 `toolCallId` 同时存在于 assistant tool call 与对应 tool result，
不能用“当前看到的最后一个 result 仍在它自己的 Set 中”这种恒真判断代替。

H13 的 settled 前状态必须由 `agent_settled` handler 在删除 snapshot 前记录
`activeSnapshotCountBefore`，删除后记录 `activeSnapshotCountAfter`。`session.prompt()`
返回时 settled 已完成，不能在返回后再把“settled 前”状态读作 0。

H14 必须分别检查：`session.state.messages`、
`sessionManager.buildSessionContext().messages`、`sessionManager.getEntries()`。entry 是
包装对象，不能直接把 entry 当 message 调用 `isManagedMessage`；应检查 message entry、
custom-message entry 的实际字段，并只输出计数/布尔值。

H15 在完整 artifact 写盘前扫描 managed/tool/thinking 三个合成 canary；扫描结果本身只
输出布尔值。H16 还必须用注入式单测制造 token estimator 或 emitter 异常，证明异常
会生成定位记录，而不是仅依赖正常场景没有抛错。

`auto-compaction` 的合成 tool result 必须足够大，确保触发 Pi 自动压缩；正文不得进入
日志。Pi 0.85.1 的实测顺序固定为：

```text
CONTEXT(agent-1)
PROVIDER_CALL(agent-1)
TOOL_START / TOOL_END
CONTEXT(agent-2)
PROVIDER_CALL(agent-2)
AGENT_END
COMPACTION_BEFORE(reason=overflow)
PROVIDER_CALL(compaction-summary)   # 不要求 context
COMPACTION_SUCCESS
CONTEXT(agent-3)
PROVIDER_CALL(agent-3)
AGENT_SETTLED
```

若该顺序没有真实出现，H10/H11 为 `UNOBSERVED`，不得用 response queue 中预先写好的
“compaction summary”字符串冒充已发生 compaction。

## 9. 决策函数

`evaluateDay5Decision` 只按 check 状态决策：

- 16 项全部 `PASS`：`GO_SDK`。
- 任一项 `FAIL`：`NO_GO_SDK_CONSIDER_MINIMAL_CORE_PATCH`。
- 没有 FAIL，但至少一项 `UNOBSERVED`：`INCONCLUSIVE_RERUN`。

core patch 候选只能由失败证据映射：

- 无法稳定替换最终 messages：候选 `ContextBuilder` 接缝。
- 无法在 compaction/retry 前后守住预算：候选 `CompactionPolicy` 接缝。
- 无法定位 session/entry：候选只读 metadata adapter。

不得因为 spike 代码本身的 bug、faux 场景未构造成功或某项未观察到，就宣称 Pi core
必须修改。先修 spike 或返回 `INCONCLUSIVE_RERUN`。

## 10. 审核与验证顺序

Luna 完成后由主审执行：

1. 按本文件逐一核对导出接口、状态机、诊断脱敏和决策函数。
2. 运行语法检查与全部离线测试。
3. 运行确定性 Day 5 spike，并核对 artifact 与控制台事件顺序。
4. 对 artifact 做 managed 正文、tool-result canary、thinking canary 和凭据样式扫描。
5. 若发现实现缺陷，主审修改源码/测试并重跑；若是 Pi 能力失败，只记录证据，不实现
   ContextManager，也不擅自 patch core。
