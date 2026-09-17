# Day 6 Pi History Sidecar：实现与验证记录

状态：实现、离线集成、runner 和阶段 4 审核完成。审计日期：2026-09-17。

## 结论

Day 6 的窄闭环及 active-branch metadata scope 已通过：Pi 0.85.1 in-memory session → 无正文 descriptor/catalog → 现有授权矩阵 → allowed-ID 回读 → 显式内容提取，并由 metadata-only topology 将候选范围收敛到当前 leaf branch。spike artifact 的决策为 `DAY6_COMPLETE_GO_DAY7`，D6-H01–H17 共 17 项均为 `PASS`，`failureLocation` 为 `null`。这表示本地合成/in-memory 验收通过；不表示已实现 GroupFactStore，也不表示真实用户数据、模型质量或应用层权限构成操作系统安全边界。

## 实施范围与数据边界

- `HistoryEntryDescriptor` 只保留稳定 Pi session/entry 引用、group/source/task、分类、exposure/provenance、状态、SHA-256 和时间字段。Catalog 只接受精确 schema 的 plain data object；拒绝未知、symbol、非枚举或 accessor 字段及非 SHA-256 `contentHash`，不接受正文别名或嵌套正文。
- `HistoryIndexer` 对新条目增量创建 descriptor；hash 或冻结 metadata 不匹配时报告 conflict，不覆盖已有 hash、不原地扩大 exposure。默认 `WORK_RECORD`；首次 `DESIGN_CONTEXT` 必须由相符、payload-free authority descriptor 证明。`GROUP_FACT` 不允许经此入口发布。
- Task directive authority 可以由 task supervisor/issuer 发布并授权 assignee session 中的
  对应 entry；不错误要求 authority record 与 Pi entry 同 source。首次 override 固化后，
  后续普通增量 reconcile 沿用 descriptor provenance，不要求每轮重复提交授权材料。
- `filterAuthorizedHistoryDescriptors()` 通过窄适配调用已有 `filterAuthorizedDescriptors()`；未修改 `src/authorization.js` 或既有授权断言。固定管线先列 descriptor 并完成授权，之后才将 allowed IDs 交给 loader。拒绝项在 `resolveSessionManager/getEntry` 的 spy/read-attempt 中为 0。
- Loader 对 unknown/revoked/session mismatch/hash mismatch/type drift/compaction fail-closed；批量加载在任一条目失败时不返回部分结果。Compaction 仅进入 metadata-only 输出，不读取 summary。
- Extractor 只生成显式 text、tool call、tool result。Thinking、image、details、usage、errorMessage、raw message/entry 不进入 projection 或 runner artifact。Tool call/result 保留并验证固定 `toolCallId` 闭环。
- Runner artifact 只含 schema 白名单中的安全字段和单调递增 sequence，不序列化 entry、正文、arguments、tool result、thinking、summary 或 stack。
- `HistoryCatalog` topology 每节点仅保存 `piEntryId/piParentEntryId`。`replaceSessionTopology()` 全量验证后原子替换；允许多 root 和 unsupported 中间节点，active path 按当前 leaf 回溯并以 root→leaf 返回。Indexer 只用一次 `getEntries()` 的 entry metadata 与 `getLeafId()`，没有调用 `getBranch()`。parent drift、已见 entry 消失、descriptor 脱离 topology 等冲突不会替换旧 topology。
- 普通 catalog 继续保留废弃分支 descriptors；`listActiveBranchDescriptors()` 仅返回当前 leaf 路径上的 eligible 项。真实 Pi `branch()` 集成和 runner H17 验证了切换后旧分支 descriptor 仍可审计、但其 canary 不进入 active scope 或 artifact。

## Pi 0.85.1 canonicalization 实测备注

真实 `SessionManager.appendCompaction()` 返回的内存 entry 有可选顶层 `details`、`usage`、`fromHook` 属性，值为 `undefined`；Pi 的 JSONL 形态会省略它们。为了让同一 entry 的内存与 JSON 表示具有一致 hash，canonicalizer 只在根 compaction entry 上省略这三个已核实字段。其他对象位置的 `undefined`、数组空槽及非 JSON 值仍拒绝。此例外由 Pi in-memory integration test 验证，具体规则已补入冻结设计说明。

## 验证证据

Day 6 定向集成使用真实 `SessionManager.inMemory()` 和 `appendMessage/appendCompaction/branch`，没有伪造 SessionManager，也没有真实 session、网络或模型调用。七个 runner 场景均通过：

| sequence | scenario | 观察到的关键结果 |
|---:|---|---|
| 1 | `incremental-index` | 初次新增 2 条、重复 reconcile 0 条、追加后仅新增 1 条；验证真实 ID、entry 回读和默认 exposure |
| 2 | `controlled-exposure` | supervisor authority 产生首次 `DESIGN_CONTEXT`；后续缺省 reconcile 保持 unchanged，`GROUP_FACT` 被拒绝 |
| 3 | `authorized-load` | child 拒绝且 read attempt 为 0；root 加载成功；现有授权函数对 5 种关系 × 3 种 exposure 的决策符合固定矩阵 |
| 4 | `integrity-failures` | Unknown、session/hash/type mismatch、revoked fail-closed；compaction 不进正文 loader；catalog 深拷贝和撤销审计通过 |
| 5 | `cross-group-canary` | 跨组拒绝，foreign Pi `getEntry` read attempt 为 0，安全结果无 canary |
| 6 | `explicit-extraction` | 显式内容输出、toolCallId 闭环成立；thinking/image 计数后丢弃 |
| 7 | `active-branch-scope` | 真实 `branch()` 后 active IDs 为 anchor→新 leaf；catalog 仍有旧分支 descriptor；topology 只有 ID/parent metadata；未调用 `getBranch()` |

验收矩阵：

| Check | Result | Evidence sequence |
|---|---|---:|
| D6-H01 | PASS | 1 |
| D6-H02 | PASS | 1 |
| D6-H03 | PASS | 1 |
| D6-H04 | PASS | 1 |
| D6-H05 | PASS | 1 |
| D6-H06 | PASS | 2 |
| D6-H07 | PASS | 4 |
| D6-H08 | PASS | 4 |
| D6-H09 | PASS | 3 |
| D6-H10 | PASS | 3 |
| D6-H11 | PASS | 4 |
| D6-H12 | PASS | 4 |
| D6-H13 | PASS | 4 |
| D6-H14 | PASS | 6 |
| D6-H15 | PASS | 5 |
| D6-H16 | PASS | 1 |
| D6-H17 | PASS | 7 |

Artifact：[`artifacts/pi-history-sidecar-spike.json`](../artifacts/pi-history-sidecar-spike.json)；7 records，sequence 1–7 连续唯一，17 checks 全 PASS，decision `DAY6_COMPLETE_GO_DAY7`，`failureLocation: null`。完整扫描未发现五个冻结 D6 canary 或本次扫描的 credential-like pattern。artifact 是本地合成验证输出，不是原始对话记录。

## 执行命令与测试

- `node --check src/history-sidecar.js`：通过。
- `npx vitest run tests/unit/history-sidecar.test.js tests/integration/pi-history-sidecar.test.js`：2 个文件、21 项通过。
- `npm run spike:pi:history`：七场景、D6-H01–H17 全部通过。

## 未执行与后续边界

未执行真实模型调用、真实用户 Pi session 读取、在线测试、Day 7 GroupFactStore、检索/排序、摘要器、ContextManager、projection/token budget/manifest 的集成或完整 Relay 工作流。D6-H17 仅验证本地合成的 Pi in-memory branch 行为和 metadata scope；Day 7 GroupFactStore 尚未开始。
