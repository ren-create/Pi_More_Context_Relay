# Day 7 GroupFactStore 与事实快照：冻结实现规格

状态：2026-09-17 冻结，等待 Luna 分阶段实现和主审复核。

## 1. 目标与非目标

Day 7 建立 Relay 自有的、按 group/factKey 版本化的当前权威事实库，并为一次 agent run
冻结不可变事实快照：

```text
group root 发布/替换/撤销事实
  -> GroupFactStore（ACTIVE / SUPERSEDED / REVOKED）
  -> 同 group session 读取 ACTIVE facts
  -> FactSnapshotManager 冻结一次 run 的事实版本
  -> 同一 tool loop 复用旧快照
  -> 下一次 run 读取新版本
```

本切片同时收口 Day 6 留下的活动分支范围：History sidecar 仍可索引完整 Pi tree 用于审计，
但必须能只用 metadata 计算当前 leaf 的 active branch，供 Day 8 默认候选范围使用。

Day 7 不实现历史相关性检索、摘要、正式 ContextManager、最终 Pi messages 组装、JSON
持久化/恢复、真实模型调用或 Pi core patch。GroupFact 是 Relay 自有正文，不是 Pi 原始
历史的副本，也不写成 persistent custom message。

## 2. 已核对的当前边界

- Day 5 已证明一次 agent run 内可复用 snapshot ID，并在每次 agent LLM call 前重建
  context；Day 7 不重复实现 hook harness。
- Day 6 已实现 descriptor/catalog、授权后加载和显式内容提取，但 `getEntries()` 包含整棵
  Pi session tree。若不增加 branch scope，Day 8 可能把废弃分支重新作为候选。
- Pi 0.85.1 entry 有 `id + parentId`，`SessionManager.getLeafId()` 暴露当前 leaf；这些都是
  metadata。不得为判断 branch 调用返回正文对象的 `getBranch()` 后再做授权。
- GroupTree 的 `group.rootSessionId` 可用于 root-only mutation；同 group session 可读取
  active facts，跨 group 必须拒绝。
- GroupFact value 由 Relay 保存，因此可以进入同 group snapshot；普通日志、错误和 runner
  artifact 不得复制 value。

## 3. 文件边界

允许新增或修改：

```text
# Day 6 branch-scope 收口
src/history-sidecar.js
tests/unit/history-sidecar.test.js
tests/integration/pi-history-sidecar.test.js
scripts/pi-history-sidecar-spike.mjs
docs/DAY6_HISTORY_SIDECAR_DESIGN.md
docs/DAY6_HISTORY_SIDECAR.md

# Day 7
src/group-fact-store.js
src/fact-snapshot.js
tests/unit/group-fact-store.test.js
tests/unit/fact-snapshot.test.js
tests/integration/group-fact-snapshot.test.js
scripts/group-fact-store-spike.mjs
docs/DAY7_GROUP_FACT_STORE.md
src/index.js
package.json
tests/README.md
README.md
docs/MVP_PLAN.md
```

只有实际验证改变架构假设时，才最小更新 `docs/ARCHITECTURE.md` 或
`docs/CONTEXT_MANAGEMENT_SPEC.md`。

不得修改 Pi core、`node_modules`、旧授权矩阵、Day 1-5 实现或既有断言。不得增加依赖、
读取真实用户 session、联网、调用真实模型、commit、push 或创建 remote。runtime artifact
不提交。

## 4. Day 6 收口：metadata-only active branch scope

### 4.1 为什么需要 topology metadata

`SessionManager.getEntries()` 返回完整 append-only tree；`getBranch()` 返回 entry 对象，包含
正文。为了保持“授权前不读取正文”的安全边界，Day 7 前置收口不使用 `getBranch()` 做候选
范围，而是在 reconcile 已经扫描 Pi entries 时，只复制以下 metadata：

```js
{
  piEntryId: "entry-002",
  piParentEntryId: "entry-001" // string | null
}
```

所有 entry type 都建立 topology node，包括不建立 HistoryEntryDescriptor 的 model change、
label、custom 等节点。这样 active branch 链可以跨过 unsupported entry，而无需保存正文。

### 4.2 HistoryCatalog 新增接口

```js
catalog.replaceSessionTopology({
  piSessionRef,
  nodes: [{ piEntryId, piParentEntryId }],
  leafPiEntryId
})

catalog.getSessionTopology(piSessionRef)
catalog.listActiveBranchEntryIds(piSessionRef)
catalog.listActiveBranchDescriptors({ piSessionRef, groupId, taskId,
                                      sourceSessionId, entryType, status })
```

固定规则：

1. topology 只含 ID/parent ID，不含 type 正文、message、summary、payload 或 content hash。
2. `replaceSessionTopology` 先完整验证再原子替换；失败时保留旧 topology。
3. node ID 在 session 内唯一；parent 必须为 null 或指向同一 topology node。
4. 允许多个 root（Pi `resetLeaf()` 可产生）；只沿当前 leaf 回溯对应 active branch。
5. leaf 必须为 null（空 session）或存在于 nodes；循环、孤儿、未知 leaf 均 fail closed。
6. `listActiveBranchEntryIds()` 返回 root -> leaf 顺序的深拷贝 ID 列表。
7. `listActiveBranchDescriptors()` 只返回 branch ID 对应的 eligible descriptors；废弃分支
   descriptor 仍保留在普通 catalog 中用于审计，但不进入默认候选。
8. `HistoryIndexer.reconcile()` 要求公开的 `getLeafId()`，从本次 `getEntries()` 一次性构建
   topology；不得额外调用 `getBranch()`。
9. topology 中缺少 descriptor 是正常的（unsupported node）；descriptor 不在 topology、
   parent drift 或已见 entry 消失属于 integrity conflict，不得静默修正。

Day 6 artifact 新增 `D6-H17`：真实 Pi in-memory 分支切换后，普通 catalog 保留两个分支，
active-branch list 只返回当前 leaf 路径；branch scope/artifact 不含废弃分支 canary 正文。

## 5. GroupFact 数据契约

### 5.1 常量与导出

`src/group-fact-store.js` 导出：

```js
GROUP_FACT_SCHEMA_VERSION = 1
GROUP_FACT_STATUS = {
  ACTIVE: "ACTIVE",
  SUPERSEDED: "SUPERSEDED",
  REVOKED: "REVOKED"
}
GROUP_FACT_AUDIT_CODES = {
  PUBLISHED,
  SUPERSEDED,
  REPUBLISHED,
  REVOKED
}

class GroupFactError extends Error
canonicalizeFactValue(value)
hashFactValue(value)
class GroupFactStore
```

错误带稳定 `code`，message 只描述字段/状态，不复制 fact value。

### 5.2 GroupFact

```js
{
  id: "fact-authorization-order-v2",
  groupId: "group-001",
  factKey: "authorization.pipeline-order",
  version: 2,
  value: "authorization-before-retrieval",
  status: "ACTIVE",
  supersedesId: "fact-authorization-order-v1", // string | null
  supersededById: null,                        // string | null
  createdBySessionId: "session-root",
  contentHash: "sha256:...",
  schemaVersion: 1,
  createdAt: "...",
  supersededAt: null,                          // ISO | null
  revokedAt: null,                             // ISO | null
  revokedBySessionId: null,                    // string | null
  revokeReason: null                           // safe enum | null
}
```

`factKey` 使用小写稳定 key：`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`，最长 128。ID、group、
session 和 authority 字段拒绝首尾空格。

`value` 必须是 lossless JSON value：string/boolean/null/有限 number、数组或 plain object；
拒绝 undefined、函数、symbol、bigint、非有限数、稀疏数组、循环、accessor、symbol key、
非枚举字段和非 plain object。对象 key 排序后做稳定 SHA-256。不要通过关键词扫描声称能
识别 hidden chain-of-thought；调用契约只接受显式、经 root 确认的事实。

## 6. GroupFactStore 接口与状态机

```js
new GroupFactStore({ groupTree, now })

store.publishFact({ id, groupId, factKey, value, createdBySessionId })

store.replaceFact({ id, groupId, factKey, value, createdBySessionId,
                    expectedPreviousFactId })

store.revokeFact({ groupId, factKey, revokedBySessionId,
                   expectedActiveFactId, reason })

store.getFact({ factId, viewerSessionId })
store.getActiveFact({ groupId, factKey, viewerSessionId })
store.listActiveFacts({ groupId, viewerSessionId })
store.listFactVersions({ groupId, factKey, viewerSessionId })
store.listAuditEvents({ groupId, viewerSessionId })
```

### 6.1 权限

- publish/replace/revoke 的 actor 必须等于 `group.rootSessionId`。
- read/list 的 viewer 必须存在且属于同 group；所有同 group session 可读，跨 group 拒绝。
- 不接受由模型输出的 actor/权限推断；调用方必须传已登记 session ID。
- error、decision、audit 不复制 value；跨 group canary 不能进入错误或 artifact。

### 6.2 发布、替换、撤销

`publishFact()`：

- 只用于一个 group/factKey 从未存在版本时，自动创建 version 1 ACTIVE。
- 已有任何版本时拒绝，调用方应使用 `replaceFact()`。

`replaceFact()`：

- `expectedPreviousFactId` 必须等于该 key 的最新版本，作为 compare-and-set。
- 最新版本 ACTIVE：原版本原子改为 SUPERSEDED，新版本为 version+1 ACTIVE。
- 最新版本 REVOKED：旧版本保持 REVOKED，新版本为 version+1 ACTIVE，audit code 为
  REPUBLISHED；不自动恢复更早的 SUPERSEDED 版本。
- 最新版本 SUPERSEDED 但不是链尾、expected ID 过期、已有其他 ACTIVE、ID 冲突或新
  fact 校验失败时，整个操作失败，旧状态不变。最新版本仍为 ACTIVE 时，相同 value/hash
  视为 `NO_FACT_CHANGE`；最新版本已经 REVOKED 时允许显式 republish 相同 value，表示
  经 root 重新确认后恢复该结论，但必须生成新版本，不能把旧 REVOKED 改回 ACTIVE。
- 新版本 `supersedesId` 指向最新版本；ACTIVE 新版本 `supersededById=null`。

`revokeFact()`：

- 只允许撤销当前 ACTIVE，`expectedActiveFactId` 必须匹配。
- 状态变为 REVOKED，保留 value/hash/version 和完整旧链；不删除、不回滚、不自动激活旧版。
- reason 仅允许 `POLICY_REVOKED | INCORRECT | OBSOLETE | USER_REQUEST`。
- 对已撤销/无 active key 的重复调用 fail closed，不伪造幂等成功。

### 6.3 其他不变量

1. fact ID 全局唯一；group/factKey/version 组合唯一。
2. 同 group/factKey 最多一个 ACTIVE。
3. 版本从 1 单调递增，不能由调用方指定。
4. mutation 全部先验证、后原子提交，失败不留下半状态或半审计。
5. list 按 `factKey`、version 稳定排序；所有返回值深拷贝。
6. audit 只保存 fact ID、group、key、version、actor、前后状态、关联 ID、safe reason 和时间，
   不保存 value。
7. 每次成功的公开 mutation 恰好追加一个 audit event：首次发布 `PUBLISHED`，替换 ACTIVE
   为 `SUPERSEDED`，从 REVOKED 新建版本为 `REPUBLISHED`，撤销为 `REVOKED`；失败不追加。

## 7. FactSnapshotManager 与事实预算

`src/fact-snapshot.js` 导出：

```js
FACT_TOKEN_ESTIMATOR_VERSION = "json-char-ceil-div-4-v1"
class FactSnapshotError extends Error
estimateFactTokens(fact)
class FactSnapshotManager
```

接口：

```js
new FactSnapshotManager({ factStore, now, createId,
                          estimateTokens = estimateFactTokens })

snapshots.createSnapshot({ groupId, targetSessionId, factTokenBudget })
snapshots.getSnapshot(snapshotId)
snapshots.releaseSnapshot(snapshotId)
snapshots.listActiveSnapshots()
```

快照固定为：

```js
{
  id: "fact-snapshot-001",
  groupId: "group-001",
  targetSessionId: "session-worker",
  facts: [/* 创建时 ACTIVE facts 的完整深拷贝，按 factKey 排序 */],
  factRefs: [{ id, factKey, version, contentHash }],
  budget: {
    method: "json-char-ceil-div-4-v1",
    factCount: 2,
    estimatedTokens: 42,
    factTokenBudget: 128,
    budgetGap: 0
  },
  createdAt: "..."
}
```

规则：

1. `createSnapshot()` 通过 `factStore.listActiveFacts()` 读取同 group ACTIVE facts；跨 group
   target 失败。
2. 默认 estimator 对 `{factKey, version, value}` 的 canonical JSON 字符数做
   `Math.ceil(length / 4)`；它是确定性启发式，不冒充 provider 精确 token。自定义 estimator
   返回值必须是非负整数。
3. 总估算超过 `factTokenBudget` 时抛 `FACT_BUDGET_EXCEEDED`，错误只带安全计数/数值，
   不创建 snapshot，不返回部分 facts，不静默裁剪。
4. snapshot 创建后与 store 解耦；replace/revoke 不改变已有 snapshot。
5. 同一 tool loop 只按 snapshot ID 重复 `getSnapshot()`；返回深拷贝但版本/value 不变。
6. 下一次 agent run 必须创建新 snapshot，才能读取新的 ACTIVE 版本。
7. release 后再次 get/release 均 fail closed，便于定位生命周期错误。
8. snapshot 不写 Pi session；Day 7 integration 必须证明 `SessionManager.getEntries()` 在事实
   发布、替换、snapshot 和 release 前后数量/内容均不变。

## 8. 可执行 runner 与 artifact

新增命令：

```text
npm run spike:group-facts:check
npm run spike:group-facts
```

runner 使用现有 GroupTree 和 Pi 0.85.1 `SessionManager.inMemory()`，但不调用模型。场景：

1. `version-lifecycle`：publish v1、replace v2、revoke v2、replace/republish v3，链和单 active。
2. `root-only-mutation`：worker/peer/cross-group mutation 全拒绝且无状态变化。
3. `group-read-boundary`：同组 root/worker/tester 可读，跨 group canary 零泄漏。
4. `snapshot-isolation`：snapshot A 固定 v1；store 更新后 A 不变；worker/tester 的新
   snapshot B/C 都读取 v2；revoke 后新 snapshot 不含该 key，旧快照仍保留。
5. `fact-budget`：预算内完整成功；超预算显式失败且 active snapshot 数不增加。
6. `pi-history-isolation`：FactStore/snapshot 全流程不增加或修改任何 Pi entry。

artifact：

```text
artifacts/group-fact-store-spike.json
```

包含 schemaVersion、createdAt、execution、scenarios、records、checks、decision、
failureLocation、passed。records 只允许安全 metadata：sequence/scenario/stage/code/status、
groupId、factId、factKey、version、factStatus、supersedesId、supersededById、actorSessionId、
snapshotId、targetSessionId、factCount、estimatedTokens、factTokenBudget、budgetGap、
activeSnapshotCount、piEntryCountBefore/After、reasonCode/errorCode。不得包含 value、payload、
message、tool content、stack 或 canary。

冻结 canary：

```text
D7_CROSS_GROUP_FACT_CANARY
D7_SUPERSEDED_FACT_CANARY
D7_REVOKED_FACT_CANARY
D7_BUDGET_FACT_CANARY
```

若写盘前扫描发现 canary，必须丢弃待写 records，写最小脱敏 failure artifact，不能把泄漏
内容连同 FAIL 证据一起保存。

## 9. Day 7 验收矩阵

| ID | 必须证明 |
|---|---|
| D7-H01 | GroupFact/value canonical hash 稳定，schema 精确，普通日志/artifact 无 value |
| D7-H02 | root 首次 publish 自动生成 version 1 ACTIVE |
| D7-H03 | 同 group/factKey 始终最多一个 ACTIVE，group 间同 key 独立 |
| D7-H04 | replace 生成 version+1、旧版 SUPERSEDED、双向链正确且旧 value/hash 保留 |
| D7-H05 | stale expected ID、重复 ID、ACTIVE 同 hash 或非法新值原子失败，无半状态/半审计 |
| D7-H06 | revoke 只作用当前 ACTIVE，保留版本链且不自动恢复旧版本 |
| D7-H07 | revoked 链可显式 republish 为下一版本，旧 REVOKED 状态不改写 |
| D7-H08 | 只有 group root 可 publish/replace/revoke，其他 actor 全拒绝 |
| D7-H09 | 同 group 所有 session 可读 ACTIVE facts，跨 group 始终拒绝且无 canary 泄漏 |
| D7-H10 | get/list/audit 返回深拷贝、稳定排序，audit 不含 value |
| D7-H11 | snapshot 捕获创建时全部 ACTIVE facts、refs 和估算预算，不缺失、不重复 |
| D7-H12 | store replace 后同一 snapshot/tool loop 仍保持旧版本和值 |
| D7-H13 | 下一 run 的 worker/tester 新 snapshot 都读取新 ACTIVE 版本 |
| D7-H14 | revoke 只影响未来 snapshot；旧 snapshot 保持，新 snapshot 不含被撤销 key |
| D7-H15 | facts 超预算显式失败，不创建 snapshot、不返回部分 facts，诊断不含 value |
| D7-H16 | FactStore/snapshot 不写 Pi 历史；runner 离线、零模型调用、artifact 安全 |

16 项全 PASS：`DAY7_COMPLETE_GO_DAY8`；任一 FAIL：`DAY7_FAILED`；无 FAIL 但有
UNOBSERVED：`DAY7_INCONCLUSIVE_RERUN`。

## 10. Luna 停止条件

只有以下情况提前停止等待主审：

1. Pi 0.85.1 没有稳定 `id/parentId/getLeafId()`，无法在不读取正文的情况下建立 topology。
2. active branch scope 必须调用含正文的 `getBranch()` 才能判断，且 metadata topology
   方案不可实现。
3. 现有 GroupTree 无法可靠确定 group root 或同 group reader。
4. 单 active/replace/revoke 无法原子实现，或需要修改 Pi core/原始 JSONL。
5. Fact snapshot 若不写 Pi 历史就无法在同一 run 保持稳定。
6. 冻结规格内部存在会改变权限、事实权威或数据所有权的重大矛盾。

语法、测试、fixture、runner、artifact、日志白名单或文档错误属于普通实现问题，Luna
必须自行修复并重跑，不能冒充接口阻塞。

## 11. 主审核顺序

1. 先审核 Day 6 topology 是否全程 metadata-only，分支 canary 未进入 active scope/artifact。
2. 审核 GroupFact schema、root-only mutation、单 active、CAS 和失败原子性。
3. 审核 replace/revoke/republish 链与审计，不允许自动恢复旧版本。
4. 审核同组读取和跨组拒绝；错误、audit、artifact 不含 value。
5. 审核 snapshot 深拷贝、跨更新稳定和下一 run 生效。
6. 审核预算超限无部分 facts、无 snapshot side effect。
7. 运行 Day 6/7 定向测试、两个 runner、`npm run check` 和完整 `npm test`。
8. 扫描两个 artifact 的 canary、正文 key 和 credential-like value。
9. 实现缺陷最小修复并重跑；真实接口/权威冲突则记录证据，不开始 Day 8。
