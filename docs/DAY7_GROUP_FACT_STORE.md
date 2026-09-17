# Day 7 GroupFactStore：实现与验证记录

状态：GroupFactStore、事实快照、离线 runner 与本阶段回归验证完成，待主审核。日期：2026-09-17。

## 结论

Day 7 本地合成验收通过：GroupFact 由 root 管理版本，同组 session 可读、跨组拒绝；每次 agent run 创建独立、深拷贝的事实快照；预算超限显式失败。Pi 0.85.1 in-memory 集成证明发布、替换、快照、撤销和 release 全流程未增加或修改 Pi entries。`artifacts/group-fact-store-spike.json` 中 D7-H01–H16 全 PASS，decision 为 `DAY7_COMPLETE_GO_DAY8`，`failureLocation` 为 `null`。

这表示可进入 Day 8 工作，不表示 Day 8 已开始，也不表示真实模型、真实用户 session 或完整上下文注入已验证。应用层可见性不是操作系统安全边界。

## 实施与安全边界

- `GroupFactStore` 接受 lossless JSON value；canonical JSON 对象键稳定排序并产生 SHA-256。GroupFact schema 精确、返回深拷贝；拒绝非法 factKey/value 和未知字段。
- 仅 group root 可 publish/replace/revoke。版本从 1 递增；replace 用 `expectedPreviousFactId` 做 CAS。ACTIVE 替换形成 supersede 链；revoke 保留版本和值而不回滚；REVOKED 链只能显式 republish 为新版本，旧 REVOKED 记录不改写。每次成功 mutation 一个 payload-free audit；失败无半状态/半审计。
- 同组已登记 session 可读事实；跨组读取拒绝。列表与 audit 稳定排序并返回深拷贝。错误、audit 和 artifact 不复制 fact value；没有用关键词扫描声称识别 thinking。
- `FactSnapshotManager` 每次创建从 `listActiveFacts()` 读取 target 同组所有 ACTIVE facts，按 factKey 排序，保存完整深拷贝、`factRefs` 和明确的预算方法/计数。默认估算是 `{factKey, version, value}` canonical JSON 字符数 `ceil(chars/4)`，仅为启发式。
- 超预算 `FACT_BUDGET_EXCEEDED` 携带安全数值计数，不调用 snapshot ID 生成器、不保存 snapshot、不返回部分 facts；`budgetGap` 表示超出预算的 token 数，预算内为 0。release 后 get/release fail closed。
- GroupFactStore 和 snapshots 不写 Pi history；artifact 只使用冻结安全字段白名单、全局唯一递增 sequence，并在写盘前扫描四个 D7 canary、正文类字段和 credential-like pattern。扫描失败分支写最小脱敏 artifact。

## Runner 场景和 sequence

Runner 使用 Pi 0.85.1 `SessionManager.inMemory()`、真实 `GroupTreeManager` 和合成 facts；不调用模型、不读真实 session。

| sequence | scenario | 观察结果 |
|---:|---|---|
| 1 | `version-lifecycle` | 首次发布 v1、替换 v2、CAS/重复 ID/同 hash/非法 value 原子拒绝、撤销 v2 不恢复 v1、显式 republish v3；hash/schema、单 ACTIVE、链与无 value audit 均验证 |
| 2 | `root-only-mutation` | worker、peer、跨组 root 的替换及 worker revoke 被拒绝；版本与 audit 不变 |
| 3 | `group-read-boundary` | root/worker/tester 可读；跨组 canary 读取拒绝且未进入错误/audit；列表深拷贝与排序验证 |
| 4 | `snapshot-isolation` | A 固定 v1；下一 run 的 worker B 与 tester C 读取 v2；revoke 后 D 不含 key，A/B/C 不变 |
| 5 | `fact-budget` | 预算内完整快照成功；超预算失败且 active snapshot 数不增加，诊断无 value |
| 6 | `pi-history-isolation` | 事实发布、替换、快照、撤销和 release 前后 Pi entry 数量与内容完全相同 |

## 验收矩阵

| Check | Result | Evidence sequence |
|---|---|---:|
| D7-H01 | PASS | 1 |
| D7-H02 | PASS | 1 |
| D7-H03 | PASS | 1 |
| D7-H04 | PASS | 1 |
| D7-H05 | PASS | 1 |
| D7-H06 | PASS | 1 |
| D7-H07 | PASS | 1 |
| D7-H08 | PASS | 2 |
| D7-H09 | PASS | 3 |
| D7-H10 | PASS | 1, 3 |
| D7-H11 | PASS | 4 |
| D7-H12 | PASS | 4 |
| D7-H13 | PASS | 4 |
| D7-H14 | PASS | 4 |
| D7-H15 | PASS | 5 |
| D7-H16 | PASS | 6 |

## Day 6 topology 复核

Stage 2 topology 节点只含 `piEntryId/piParentEntryId`；Indexer 从扫描 entries metadata 和 `getLeafId()` 构建 scope，不调用 `getBranch()`。H17 使用真实 Pi in-memory `branch()` 场景；当前 active branch 只有 anchor 与新 leaf，普通 catalog 保留废弃分支 descriptor，artifact 中 `abandonedBranchExcluded: true`。

最终 Day 6 artifact 为 [`artifacts/pi-history-sidecar-spike.json`](../artifacts/pi-history-sidecar-spike.json)：7 records，sequence 1–7 唯一递增，D6-H01–H17 全 PASS，decision `DAY6_COMPLETE_GO_DAY7`，`failureLocation: null`。

## 执行命令与测试

- `npx vitest run tests/unit/history-sidecar.test.js tests/integration/pi-history-sidecar.test.js tests/unit/group-fact-store.test.js tests/unit/fact-snapshot.test.js tests/integration/group-fact-snapshot.test.js`：5 个文件、37 项通过。
- `npm run spike:pi:history`：7 场景、17 checks 全 PASS。
- `npm run spike:group-facts:check`：通过。
- `npm run spike:group-facts`：最终通过，6 场景、16 checks 全 PASS。早期 runner fixture 对字符串 canary 使用了对象字段断言，修正后重跑通过；无 GroupFactStore 接口冲突。
- `npm run check`：通过，保留所有既有检查并增加 Day 7 source/runner 检查。
- `npm test`：9 个文件、116 项通过。
- 两个最终 artifact 均已扫描：D6/D7 canary、正文类 key、stack key 和 credential-like pattern 均未发现；D6 为 7 records/DAY6_COMPLETE_GO_DAY7，D7 为 6 records/DAY7_COMPLETE_GO_DAY8，二者 `failureLocation: null`。

## 主审核补足

Day 7 主审核补齐了三项验收收口：artifact 安全扫描失败时 runner 现在必定返回非零退出码；root-only 场景同时覆盖非 root publish、replace 和 revoke；版本生命周期证据显式核对旧 value/hash、双向 supersede 链，以及 republish 后旧 REVOKED 版本的完整不变性。`PROJECT_STATUS` 同步更新为 `phase-2-day-7-complete`。这些修改没有改变冻结 API 或事实状态机。

## 未执行范围

未调用真实模型、未读取真实用户 Pi session、未做在线测试或持久化/恢复；未实现检索、排序、摘要、ContextManager、最终 context 注入、ContextEnvelope/Manifest 或 Day 8 工作。Pi 历史只由合成 in-memory session 验证不变。
