# Day 6 Pi 历史 sidecar：冻结实现规格

状态：规格于 2026-09-16 冻结；实现及阶段 4 证据复核于 2026-09-17 完成。
实施证据见 [Day 6 实现与验证记录](DAY6_HISTORY_SIDECAR.md)。

## 1. 目标与非目标

本切片建立一条授权先于正文加载的纯逻辑闭环：

```text
Pi SessionManager.getEntries()
  -> HistoryIndexer（增量 reconcile）
  -> HistoryCatalog（无正文 descriptor）
  -> 现有授权矩阵的窄适配层
  -> HistoryLoader（只按 allowed ID 回读）
  -> ExplicitContentExtractor（丢弃 thinking）
  -> 显式 text / tool call / tool result
```

Pi 仍是原始 session 历史的唯一正文来源。Relay sidecar 不复制正文、正文片段、摘要、
embedding 或 tool result。Day 6 不实现检索排序、摘要、GroupFactStore、ContextManager、
context 注入、真实模型调用或 Pi core patch。

## 2. 已核对的 Pi 0.85.1 接口事实

- `SessionManager.getEntries()` 返回除 header 外的全部 `SessionEntry[]` 浅防御副本；
  session 本身是 append-only tree。
- 每个 entry 有稳定的 `id`、`parentId`、ISO `timestamp` 和 `type`。
- `SessionManager.getEntry(id)` 按 ID 返回 entry 或 `undefined`。
- `SessionManager.getSessionId()` 可用于核对 Relay 登记的 `piSessionRef`。
- `message` entry 的正文位于 `entry.message`。MVP 索引其中的 `user`、`assistant` 和
  `toolResult`；assistant 的 content block 可能同时含 `text`、`thinking` 和
  `toolCall`。
- `compaction` entry 顶层包含 `summary`，但 Day 6 只登记其 descriptor 元数据，不向
  loader/extractor 输出 summary。
- `thinking_level_change`、`model_change`、`branch_summary`、`custom`、
  `custom_message`、`label`、`session_info` 不属于 Day 6 可检索正文，reconcile 只输出
 安全的 `SKIPPED_UNSUPPORTED_ENTRY` 计数/类型，不复制内容。

若实际安装的 Pi 0.85.1 与这些事实冲突，Luna 必须停在阶段 1，并给出文件、类型定义或
最小只读探针证据；不得自行改 Pi core 或用不稳定字段猜测 entry 身份。

## 3. 与现有授权接口的兼容决定

`authorizeRecordDescriptor()` 当前只接受 DevelopmentRecord descriptor，使用
`recordId`，并拒绝 `piEntryId/status` 等额外字段。Day 6 不修改或放宽它。

新增窄适配层：

```text
HistoryEntryDescriptor.id -> authorization descriptor.recordId
groupId/sourceSessionId/exposure -> 原值
其他 History 字段 -> 不传给旧授权函数
```

授权后再按 `recordId === HistoryEntryDescriptor.id` 映射回原 descriptor。这样复用同一
5×3 授权矩阵，同时保持 Day 1-4 的字段白名单和既有测试不变。

## 4. 文件边界

Luna 只新增或修改：

```text
src/history-sidecar.js
tests/unit/history-sidecar.test.js
tests/integration/pi-history-sidecar.test.js
scripts/pi-history-sidecar-spike.mjs
src/index.js
package.json
tests/README.md
docs/DAY6_HISTORY_SIDECAR.md
```

只有发现已验证的设计约束变化时，才可最小更新：

```text
docs/CONTEXT_MANAGEMENT_SPEC.md
docs/ARCHITECTURE.md
docs/MVP_PLAN.md
README.md
```

不得修改 `src/authorization.js`、`src/record-store.js`、Day 1-5 源码或既有测试断言。
不得增加依赖、修改 `node_modules`、读取真实用户 session、联网、调用真实模型、commit、
push 或创建 remote。生成的 runtime artifact 不提交。

## 5. 冻结常量与导出接口

`src/history-sidecar.js` 使用原生 JavaScript ES module，并导出：

```js
DAY6_SCHEMA_VERSION = 1

HISTORY_ENTRY_TYPES = {
  MESSAGE: "MESSAGE",
  TOOL_RESULT: "TOOL_RESULT",
  COMPACTION: "COMPACTION"
}

HISTORY_DESCRIPTOR_STATUS = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED"
}

EXPOSURE_OVERRIDE_KINDS = {
  TASK_DIRECTIVE: "TASK_DIRECTIVE",
  HANDOFF: "HANDOFF"
}

class HistorySidecarError extends Error

canonicalizePiEntry(entry)
hashPiEntry(entry)
class HistoryCatalog
class HistoryIndexer
toAuthorizationDescriptor(historyDescriptor)
filterAuthorizedHistoryDescriptors({ viewerSessionId, descriptors, groupTree })
class HistoryLoader
extractExplicitContent({ descriptor, entry })
loadAuthorizedExplicitHistory({ viewerSessionId, catalog, loader, groupTree,
                                filters })
```

所有参数或状态错误抛出 `HistorySidecarError`，带稳定 `code`。错误 message、审计事件、
runner record 和 artifact 不得复制 Pi 正文、tool arguments、tool result、thinking、
compaction summary 或 canary。

## 6. HistoryEntryDescriptor 与哈希

descriptor 固定为：

```js
{
  id: "history-descriptor-001",
  piSessionRef: "pi-session-worker",
  piEntryId: "pi-entry-id",
  groupId: "group-001",
  sourceSessionId: "session-worker",
  taskId: "task-001",              // string | null
  entryType: "MESSAGE",            // MESSAGE | TOOL_RESULT | COMPACTION
  exposure: "WORK_RECORD",
  exposureSource: "DEFAULT",        // DEFAULT | TASK_DIRECTIVE | HANDOFF
  exposureAuthorityId: null,        // string | null
  status: "ACTIVE",                // ACTIVE | REVOKED
  contentHash: "sha256:...",
  schemaVersion: 1,
  createdAt: "...",
  revokedAt: null                   // ISO string | null
}
```

descriptor 顶层禁止出现：`message`、`content`、`text`、`summary`、`payload`、
`arguments`、`details`、`thinking`、`toolResult`、`rawEntry`。所有 catalog getter/list
返回深拷贝。

默认条目的 `exposureSource="DEFAULT"` 且 `exposureAuthorityId=null`；受控 override
必须把 provenance kind 和 authorityRecordId 固化到这两个 metadata 字段。它们只用于
审计，不传入旧授权函数，也不能作为自动扩大 exposure 的依据。

`canonicalizePiEntry()` 对 JSON 值按对象 key 排序后稳定序列化；拒绝循环、函数、symbol、
bigint、非有限 number 和会被 JSON 静默丢弃的 `undefined`。`hashPiEntry()` 对整个原始
entry 的 canonical form 做 SHA-256，并返回 `sha256:<hex>`。hash 包含正文但 descriptor
只保存不可逆 hash；compaction summary 也只参与 hash，不复制进 sidecar。

Pi 0.85.1 的 `SessionManager.appendCompaction()` 在内存 entry 上会创建值为 `undefined` 的
可选顶层字段 `details`、`usage`、`fromHook`；这些字段在 JSONL 序列化中被省略。为使同一
Pi entry 的内存形态与其 JSONL 形态具有相同 hash，canonicalizer 仅对根 compaction entry
的这三个已核实可选字段按“缺失”处理；其他位置的 `undefined`（包括普通对象属性和数组
槽）仍拒绝。该例外有 Pi 0.85.1 in-memory integration test 覆盖。

## 7. HistoryCatalog

接口：

```js
new HistoryCatalog({ now })

catalog.registerDescriptor(descriptor)
catalog.getDescriptor(descriptorId)
catalog.findDescriptor({ piSessionRef, piEntryId })
catalog.listDescriptors({ groupId, taskId, sourceSessionId, piSessionRef,
                          entryType, status })
catalog.revokeDescriptor({ descriptorId, reason })
catalog.listAuditEvents()
```

不变量：

1. `id` 全局唯一，`piSessionRef + piEntryId` 组合唯一。
2. 不提供 exposure 更新接口；已有历史不能原地扩大权限。
3. revoke 只将 `ACTIVE -> REVOKED`，保留 descriptor，并生成不含正文的审计事件。
4. 重复 revoke 幂等返回当前 descriptor，不重复生成审计事件。
5. 所有返回值均为深拷贝，调用方修改不得污染 catalog。
6. catalog 不接受 schema 外字段，以防正文伪装成 metadata 进入 sidecar。

## 8. HistoryIndexer 与增量 reconcile

接口：

```js
new HistoryIndexer({ catalog, groupTree, taskManager, developmentRecordStore,
                     now, createId })

indexer.reconcile({
  sessionManager,
  piSessionRef,
  groupId,
  sourceSessionId,
  taskId = null,
  exposureOverrides = []
})
```

`reconcile()` 先验证：group、source session、可选 task 属于同一 group；group tree 中
source 的 `piSessionRef` 与参数相同；`sessionManager.getSessionId()` 与它相同。然后只从
`getEntries()` 读取，并返回安全报告：

```js
{
  scannedCount,
  createdDescriptorIds,
  unchangedDescriptorIds,
  skipped: [{ piEntryId, piEntryType, reasonCode }],
  conflicts: [{ piEntryId, descriptorId, reasonCode }]
}
```

固定分类：

- `entry.type === "message"` 且 role 是 `user/assistant` -> `MESSAGE`。
- `entry.type === "message"` 且 role 是 `toolResult` -> `TOOL_RESULT`。
- `entry.type === "compaction"` -> `COMPACTION`。
- 其余类型 -> `SKIPPED_UNSUPPORTED_ENTRY`，不建 descriptor。

增量规则：

1. 未见过的 eligible entry 创建 descriptor。
2. 同一 `piSessionRef + piEntryId`、hash 和冻结 metadata 相同：`UNCHANGED`，不重复创建。
3. 已有 descriptor 但当前 hash 不同：记录 `CONTENT_HASH_MISMATCH` conflict，不覆盖旧
   hash，不创建替代 descriptor。
4. 已有 descriptor 的 group/source/task/type/exposure 与本次推导不同：记录明确 conflict，
   不修改 descriptor。
5. 单个 conflict 不掩盖同一批其他 entry 的安全 reconcile；报告非空 conflicts 时 runner
   仍判对应检查失败。

### 8.1 exposure override

缺省 exposure 恒为 `WORK_RECORD`。唯一允许的 override 形状：

```js
{
  piEntryId,
  exposure: "DESIGN_CONTEXT",
  provenance: {
    kind: "TASK_DIRECTIVE" | "HANDOFF",
    authorityRecordId: "non-empty-id"
  }
}
```

Day 6 raw history override 的上限冻结为 `DESIGN_CONTEXT`。`GROUP_FACT` 由 Day 7 的
root-only GroupFactStore 发布，不能借 history override 绕过。override 必须在 descriptor
首次创建时由受控调用方给出；不得基于正文或模型分类推导；不得用于事后扩大已有
descriptor。未命中 entry、重复 override、非法 provenance 或 `GROUP_FACT` 均 fail closed。

`authorityRecordId` 不是自由字符串。Indexer 必须调用现有
`developmentRecordStore.getDescriptor(authorityRecordId)`，只读取无 payload 的 metadata，
并验证：record 与 entry 的 group/task 一致；`TASK_DIRECTIVE` 对应 record type
`WORK_DIRECTIVE`，`HANDOFF` 对应 record type `HANDOFF`；authority record 自身 exposure
为 `DESIGN_CONTEXT`。缺失、类型不符、跨 group/task 或 exposure 不符均拒绝 override。
没有 override 时不得为了默认 WORK_RECORD 读取 DevelopmentRecordStore。

Authority record 与被索引 entry 不要求 `sourceSessionId` 相同：典型 task directive 由
supervisor/issuer 发布，却写入 assignee 的 Pi session。source 身份的合法性由受控发布
路径与 Task/DevelopmentRecord 自身契约负责；Indexer 在本切片只验证上述无正文 metadata。
首次创建并固化 override 后，后续普通 reconcile 无需重复提供 override，而是沿用已有
descriptor 的 exposure/provenance 做完整性比较。再次显式提供不同 override 仍视为
metadata conflict，不能原地扩大或改写权限。

## 9. 授权适配层

```js
toAuthorizationDescriptor(historyDescriptor)
```

只返回旧授权函数允许的 metadata 字段，至少包括：

```js
{
  recordId: historyDescriptor.id,
  groupId,
  taskId,
  sourceSessionId,
  type: entryType,
  exposure,
  sourceRecordIds: [],
  contentHash,
  schemaVersion,
  createdAt
}
```

`filterAuthorizedHistoryDescriptors()` 必须调用现有
`filterAuthorizedDescriptors()`，不得复制一份授权矩阵。返回：

```js
{
  descriptors: [/* allowed HistoryEntryDescriptor 深拷贝 */],
  decisions: [/* 现有安全 decision；recordId 等于 history descriptor id */]
}
```

REVOKED descriptor 在进入旧授权矩阵前即 fail closed，并产生不含正文的
`DENY_REVOKED_DESCRIPTOR` decision；不能让矩阵的 relationship allow 覆盖撤销状态。

## 10. HistoryLoader 与固定授权管线

构造与接口：

```js
new HistoryLoader({ catalog, resolveSessionManager })

loader.loadAllowed({ allowedDescriptorIds })
```

`resolveSessionManager(piSessionRef)` 是注入的本地适配器。loader 对每个 ID 重新从 catalog
取 descriptor，并依次验证：

1. ID 存在且没有重复。
2. descriptor 为 `ACTIVE`。
3. entryType 不是 `COMPACTION`；compaction 返回 `CONTENT_NOT_LOADABLE`。
4. 能定位 session manager，且其 `getSessionId()` 等于 `piSessionRef`。
5. `getEntry(piEntryId)` 存在，且返回的 `entry.id` 完全相同。
6. 当前 `hashPiEntry(entry)` 等于 descriptor `contentHash`。
7. 当前 entry 的分类仍等于 descriptor `entryType`。

任一失败均不返回该 entry，抛出稳定 code。批量 load 必须先完成全部验证，再返回结果，
避免调用方误用半批成功数据。返回：

```js
[{ descriptor, entry }]
```

两者都是深拷贝。这个原始中间对象只能交给 `extractExplicitContent()`；runner 和 artifact
不得序列化它。

产品路径使用：

```js
loadAuthorizedExplicitHistory({ viewerSessionId, catalog, loader,
                                groupTree, filters })
```

固定执行：catalog list -> authorization adapter -> allowed IDs -> metadata-only 分流 ->
loader -> extractor。返回 allowed descriptors、safe decisions、
`metadataOnlyDescriptors` 和 extracted items。授权通过的 COMPACTION 在进入 loader 前
分流到 `metadataOnlyDescriptors`，不读取其 Pi entry/summary；其他 allowed IDs 才交给
loader。拒绝 descriptor 绝不调用 `resolveSessionManager/getEntry`。不得提供“先 load
全部再 filter”的便捷路径。

## 11. ExplicitContentExtractor

`extractExplicitContent({ descriptor, entry })` 只接受 loader 已验证的 MESSAGE 或
TOOL_RESULT。返回：

```js
{
  descriptorId,
  piSessionRef,
  piEntryId,
  sourceSessionId,
  entryType,
  items: [
    { type: "TEXT", role: "user" | "assistant", text },
    { type: "TOOL_CALL", toolCallId, toolName, arguments },
    { type: "TOOL_RESULT", toolCallId, toolName, isError, text }
  ],
  omitted: {
    thinkingBlockCount,
    imageBlockCount,
    unsupportedBlockCount
  }
}
```

规则：

- user string 或 `text` block -> `TEXT`。
- assistant 只保留 `text` 与 `toolCall`；所有 `thinking` 块无条件丢弃。
- toolResult 只保留 toolCallId、toolName、isError 和 text block；丢弃 `details`、`usage`、
  image/base64 和未知字段。
- `arguments` 必须是 JSON 可序列化对象并深拷贝；无效时 fail closed。
- 不输出 provider、model、usage、errorMessage、raw message、raw entry 或对象引用。
- 输出中保留原 toolCallId，供后续验证 tool call/result 闭环。

## 12. 可执行离线 runner 与诊断

新增命令：

```text
npm run spike:pi:history:check
npm run spike:pi:history
```

runner 使用 Pi 0.85.1 `SessionManager.inMemory()`、现有 GroupTree/Task/Authorization 和
确定性假数据，不联网、不读取真实 session、不调用模型。场景至少覆盖：

1. `incremental-index`：首次索引、重复 reconcile、新增 entry 后增量索引、默认 exposure。
2. `controlled-exposure`：合法 DESIGN_CONTEXT override；非法/事后扩大被拒绝。
3. `authorized-load`：self/ancestor 可以读；peer/descendant 按矩阵拒绝；拒绝项无 read attempt。
4. `integrity-failures`：未知 entry、hash mismatch、REVOKED、compaction metadata-only。
5. `cross-group-canary`：另一 group 正文含 fake canary，目标 viewer 的 loader/extractor
   均未接触。
6. `explicit-extraction`：text/tool call/result 保留，thinking/image/details/usage 丢弃。

artifact：

```text
artifacts/pi-history-sidecar-spike.json
```

结构至少包含 schemaVersion、createdAt、piSdkVersion、execution、records、checks、
failureLocation、decision、passed。全局 `sequence` 唯一递增。record 只允许安全字段：

```text
scenario, stage, code, status, descriptorId, piSessionRef, piEntryId,
sourceSessionId, groupId, taskId, entryType, exposure, descriptorStatus,
scannedCount, createdCount, unchangedCount, skippedCount, conflictCount,
allowedCount, deniedCount, loadedCount, extractedItemCount,
thinkingBlockCount, imageBlockCount, unsupportedBlockCount,
readAttemptCount, reasonCode, errorCode, contentHashMatched, topologyNodeCount,
activeBranchCount, catalogDescriptorCount, abandonedBranchExcluded
```

不得输出正文、tool arguments、tool result、summary、raw entry、stack 或 canary。即使异常，
脚本也要在 `finally` 中写 artifact。最终 artifact 全量扫描以下合成 canary，均不得出现：

```text
D6_CROSS_GROUP_SECRET_CANARY
D6_THINKING_CANARY
D6_TOOL_RESULT_CANARY
D6_COMPACTION_SUMMARY_CANARY
D6_ABANDONED_BRANCH_CANARY
```

注意：允许正文的提取正确性由内存断言验证；artifact 只记录类型、数量、ID 和布尔证据。

## 13. 冻结验收矩阵

每项使用 `PASS | FAIL | UNOBSERVED` 和 evidence sequence：

| ID | 必须证明 |
|---|---|
| D6-H01 | descriptor 精确关联 `piSessionRef + piEntryId`，且 schema/diagnostic/artifact 均不含正文 |
| D6-H02 | hash 是整个 Pi entry 的稳定 SHA-256，相同 entry 相同、内容变化不同 |
| D6-H03 | reconcile 只索引 eligible message/tool result/compaction，unsupported 安全跳过 |
| D6-H04 | reconcile 幂等；第二次零新增；追加 entry 后只新增该 entry |
| D6-H05 | 普通 message/tool result 缺省为 `WORK_RECORD` |
| D6-H06 | 只有带受控 provenance 的首次 `DESIGN_CONTEXT` override 生效并固化安全 provenance；自动、GROUP_FACT 和事后扩大均拒绝 |
| D6-H07 | compaction 只有 metadata descriptor，summary 不可加载或提取 |
| D6-H08 | HistoryCatalog getter/list 是无正文深拷贝；revoke 留安全审计且不可恢复为 ACTIVE |
| D6-H09 | history 授权适配真实复用现有 5×3 矩阵，且不修改旧授权接口 |
| D6-H10 | 固定管线先授权后加载；denied descriptor 的 session/getEntry read attempt 为 0 |
| D6-H11 | 未知 descriptor、未知 Pi entry/session 或 session-ref mismatch 全部 fail closed |
| D6-H12 | hash mismatch 和 entry type drift fail closed，不返回半批结果 |
| D6-H13 | REVOKED descriptor 即使原文仍存在也不能加载，且 decision/error 不含正文 |
| D6-H14 | extractor 保留显式 text/tool call/result 与固定 toolCallId，丢弃 thinking/image/details/usage/raw object |
| D6-H15 | 跨 group fake canary 在 loader、extractor、候选输出、decision、error、record、artifact 中均不可见 |
| D6-H16 | Pi 0.85.1 in-memory `getEntries/getEntry/getSessionId` 的真实 entry 形状完成端到端闭环 |
| D6-H17 | metadata-only topology 跟随真实 Pi branch leaf；普通 catalog 保留废弃分支 descriptor，但 active scope/artifact 不含其正文 |

决策：17 项全 PASS 才是 `DAY6_COMPLETE_GO_DAY7`；有 FAIL 为 `DAY6_FAILED`；无 FAIL 但
有 UNOBSERVED 为 `DAY6_INCONCLUSIVE_RERUN`。不得因单测通过就伪造 H16；H16 必须使用
真实 Pi `SessionManager.inMemory()`。

Day 7 前置 active-branch metadata scope 使用 `getEntries()` 中每个 entry 的 `id`/
`parentId`（unsupported entry 也建立仅含 ID 的 topology node）和 `getLeafId()`；不得调用
`getBranch()`。Topology replacement 必须校验完整节点集合、parent 引用、唯一 ID、cycle 和
leaf 后再原子提交。parent drift、已见 entry 消失或 catalog descriptor 脱离 topology 均为
integrity conflict，保留旧 topology 并 fail closed。废弃分支 descriptor 留在普通 catalog，
仅 active-branch descriptor 接口用于当前 leaf scope。

## 14. Luna 的停止条件

只有下列情况提前停止并等待主审：

1. Pi 0.85.1 没有稳定 entry ID、`getEntries/getEntry/getSessionId`，或实际 entry shape 与
   第 2 节冲突，导致无法安全关联原文。
2. 不修改旧授权矩阵就无法做窄适配，或适配会让正文/额外字段进入授权函数。
3. hash 无法对 Pi entry 做确定性验证，且没有更窄的公开 SDK 证据可用。
4. 实现正确闭环必须读取真实 session、联网、修改 Pi core/node_modules 或扩大 Day 6 范围。
5. 冻结规格内部存在会改变权限结果或数据所有权的重要逻辑矛盾。

测试失败、语法错误、runner bug、fixture 构造错误、日志字段遗漏、文档不一致属于普通
实现问题；Luna 应定位、修复、重跑并继续完成 Day 6，不能把它们冒充接口阻塞。

## 15. 主审核顺序

Luna 完成后主审：

1. 审核 descriptor 无正文、hash canonicalization、exposure 不可扩大和 revoke 语义。
2. 确认适配层调用现有授权函数，没有复制矩阵或修改旧契约。
3. 用 spy/read-attempt 证据确认 denied/cross-group entry 在授权前未被读取。
4. 检查 extractor 对 Pi 每种允许内容块的白名单处理，尤其 thinking、details、usage。
5. 运行定向测试、真实 in-memory runner、`npm run check` 和完整 `npm test`。
6. 全量扫描 artifact canary/credential-like 内容，并核对 16 项 check 与 failureLocation。
7. 若是实现缺陷，主审最小修复并重跑；若是冻结接口冲突，记录证据后停下，不开始 Day 7。
