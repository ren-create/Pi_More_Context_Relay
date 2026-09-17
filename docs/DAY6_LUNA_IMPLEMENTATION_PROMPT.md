# Day 6 独立 Luna 对话提示词

用途：用户按阶段粘贴给同一个 Luna 对话。普通实现问题由 Luna 自行修复并继续；只有
`DAY6_HISTORY_SIDECAR_DESIGN.md` 第 14 节的接口/重要逻辑冲突才提前停止等待主审。

## 首条提示词：阶段 1，只读接口审计

```text
你在本地仓库 D:\Project\Pi_WMRAH\Pi_More_Context_Relay 工作。

目标：完成 Day 6 Pi 历史 sidecar，但严格按冻结规格分阶段。本轮只执行阶段 1 的只读
接口审计，不修改文件、不运行测试或 runner。不要创建子智能体，不要联网，不要读取
真实用户 Pi session，不要调用真实模型。

完整阅读：
1. 根目录 AGENTS.md
2. docs/DAY6_HISTORY_SIDECAR_DESIGN.md
3. docs/CONTEXT_MANAGEMENT_SPEC.md 中 HistoryEntryDescriptor、固定上下文管线和生命周期
4. docs/TASK_RECORD_AUTH_SPEC.md 的 exposure 与 5×3 授权矩阵
5. src/authorization.js、src/record-store.js、src/group-tree.js、src/task-manager.js
6. package.json、src/index.js、tests/README.md
7. 当前安装的 @earendil-works/pi-coding-agent@0.85.1 的 session-manager.d.ts、
   docs/session-format.md，以及 getEntries/getEntry/getSessionId 的公开实现边界

必须核对并输出 discrepancy table：
- Pi SessionEntry 的稳定 id、message/toolResult/compaction 真实形状是否与冻结规格一致；
- getEntries/getEntry/getSessionId 是否足够定位原文；
- History descriptor 使用 id，而旧授权接口只接受 recordId 的兼容问题；
- 窄适配层是否能在不修改 src/authorization.js 的前提下复用授权矩阵；
- canonical hash、compaction metadata-only、thinking/content block 白名单是否可实现；
- 冻结 exposure override 能否用现有 DevelopmentRecordStore 的 payload-free descriptor
  验证 authority，且不会绕过 Day 7 root-only GroupFactStore；
- 计划修改文件是否严格在白名单内。

每项分类为 CONFIRMED、IMPLEMENTATION_DETAIL、TEST_GAP、PI_API_CONFLICT 或
DESIGN_CONFLICT。不要把可以按规格实现的普通细节升级为冲突。

若命中冻结规格第 14 节停止条件：给出最小证据和可选修订，但不要改代码，最后写
STOPPED_DAY6_CONTRACT_REVIEW。

如果没有停止条件：给出阶段 2 的精确测试清单和实现顺序，最后写
READY_FOR_DAY6_STAGE_2。然后停止本轮，等待我发送阶段 2。
```

## 阶段 2：纯逻辑实现与单测

```text
继续 Day 6 阶段 2。若阶段 1 没有 PI_API_CONFLICT 或 DESIGN_CONFLICT，直接实现纯逻辑
sidecar，不再重复方案讨论。普通语法/测试问题自行修复，不要提前停。

允许新增/修改：
- src/history-sidecar.js
- tests/unit/history-sidecar.test.js

只读引用但不得修改：
- src/authorization.js
- src/record-store.js
- src/group-tree.js
- src/task-manager.js
- 既有测试

严格实现 docs/DAY6_HISTORY_SIDECAR_DESIGN.md 第 5-11 节：
- stable canonical hash 与无正文 HistoryEntryDescriptor；
- HistoryCatalog 唯一键、深拷贝、revoke 和安全审计；
- HistoryIndexer eligibility、幂等增量 reconcile、conflict、不覆盖旧 hash；
- 默认 WORK_RECORD 与首次受控 DESIGN_CONTEXT override；把 exposureSource 和
  exposureAuthorityId 固化为安全 metadata；用现有 DevelopmentRecordStore 的无 payload
  descriptor 验证 authority record 的 group/task/type/exposure；拒绝伪造 authority、
  GROUP_FACT 和事后扩大；
- toAuthorizationDescriptor 和 filterAuthorizedHistoryDescriptors 必须调用现有授权函数，
  不得复制矩阵或放宽旧字段白名单；
- HistoryLoader 的 unknown/revoked/session mismatch/hash mismatch/type drift/compaction
  fail-closed 与批量无半成功；
- extractExplicitContent 只输出显式 text/tool call/result，丢弃 thinking、image、details、
  usage、errorMessage 和 raw object；
- loadAuthorizedExplicitHistory 固定 catalog -> authorization -> compaction metadata-only
  分流 -> loader -> extractor 顺序。

单测必须用 read-attempt spy 证明 denied descriptor 没有触发 resolveSessionManager/getEntry，
并覆盖跨 group canary、thinking/tool-result/compaction canary 不进入 decision/error/安全输出。

只运行：
- node --check src/history-sidecar.js
- npx vitest run tests/unit/history-sidecar.test.js

若失败，定位并修复后重跑。输出 changed files、测试数、仍待阶段 3 验证的 Pi 接口项。
最后写 READY_FOR_DAY6_STAGE_3，然后停止本轮。
```

## 阶段 3：真实 Pi in-memory 闭环与 artifact

```text
继续 Day 6 阶段 3。实现 Pi 0.85.1 in-memory integration、可执行 runner 和结构化证据。
普通 fixture/runner/test 问题自行修复并重跑；只有冻结规格第 14 节的真实接口冲突才停。

允许新增/修改：
- tests/integration/pi-history-sidecar.test.js
- scripts/pi-history-sidecar-spike.mjs
- package.json
- src/index.js
- 阶段 2 文件（仅修复 integration 暴露出的实现缺陷）

不得增加依赖、联网、调用模型、读取真实 session、修改 Pi core/node_modules 或旧授权实现。

要求：
- 使用 @earendil-works/pi-coding-agent@0.85.1 的 SessionManager.inMemory()；
- 通过 appendMessage/appendCompaction 构造 user、assistant(text+thinking+toolCall)、
  toolResult 和 compaction；不得伪造一个“长得像”SessionManager 的对象来冒充 H16；
- 实现 incremental-index、controlled-exposure、authorized-load、integrity-failures、
  cross-group-canary、explicit-extraction 六类场景；
- deny/cross-group 场景用 spy 记录 loader read attempt，必须为 0；
- runner 全局 sequence 唯一，日志使用安全字段白名单；
- 在 finally 写 artifacts/pi-history-sidecar-spike.json；
- artifact 不得保存 raw entry、正文、arguments、tool result、thinking、summary 或 stack；
- 聚合 D6-H01 至 D6-H16，只有全 PASS 才输出 DAY6_COMPLETE_GO_DAY7。

新增 package scripts：
- spike:pi:history:check
- spike:pi:history
并把新源/脚本加入 npm run check，但不要删除既有检查。

依次运行：
- node --check scripts/pi-history-sidecar-spike.mjs
- Day 6 unit + integration 定向测试
- npm run spike:pi:history

失败时保留 artifact，区分 IMPLEMENTATION_BUG、TEST_FIXTURE_BUG、PI_API_CONFLICT 或
DESIGN_CONFLICT。前三者中只有真实 PI_API_CONFLICT 按停止条件停；普通 bug 必须修复。

输出六场景关键 sequence、16 项 check、decision、failureLocation 和 read-attempt 证据。
最后写 READY_FOR_DAY6_STAGE_4，然后停止本轮。
```

## 阶段 4：独立复核、最小修复和文档收口

```text
继续 Day 6 阶段 4。先独立审核阶段 2/3 的源码、测试和 artifact，再最小修复并完成 Day 6。
不要因为已有测试通过就跳过证据审核。

允许修改：
- docs/DAY6_HISTORY_SIDECAR_DESIGN.md 允许的 Day 6 文件
- docs/DAY6_HISTORY_SIDECAR.md
- tests/README.md
- README.md、docs/MVP_PLAN.md（只更新已验证状态，不改历史计划含义）
- docs/CONTEXT_MANAGEMENT_SPEC.md、docs/ARCHITECTURE.md（只有实际 Pi 约束改变假设时）

复核顺序：
1. 检查 descriptor/catalog/artifact schema，确认不存在正文别名或嵌套正文。
2. 确认 HistoryIndexer 不覆盖 hash、不扩大 exposure，GROUP_FACT override 被拒绝。
3. 确认 history 授权适配调用现有 filterAuthorizedDescriptors，没有复制 5×3 矩阵，
   src/authorization.js 和既有断言未改。
4. 确认固定管线在调用 loader 前完成授权；用 read-attempt 证明 denied/cross-group 为 0。
5. 审核 loader 的 unknown/revoked/session/hash/type/compaction fail-closed 和批量无半成功。
6. 审核 extractor 白名单，thinking/image/details/usage/errorMessage/raw object 均不输出。
7. 全量扫描 artifact，四个 D6 canary 和 credential-like 内容均不得出现。
8. 修复实现问题后，重跑 Day 6 定向测试和 npm run spike:pi:history。
9. 运行 npm run check 与 npm test，确认所有 Day 1-5 测试仍保留并通过。
10. 只依据实际证据写 docs/DAY6_HISTORY_SIDECAR.md；明确实测、纯逻辑、未运行事项。

最终输出：
- changed files；
- 实际执行命令与每组测试数；
- D6-H01 至 D6-H16 状态；
- artifact 路径、record 数、decision、failureLocation；
- 是否可以进入 Day 7；
- 未执行的真实模型、真实用户 session、检索、摘要、ContextManager 等范围。

不要 commit、push、创建 remote 或开始 Day 7。普通实现问题修到通过再汇报；只有冻结规格
第 14 节的接口/重要逻辑冲突才提前停并给出失败证据。

最后必须写 DAY6_IMPLEMENTATION_FINISHED_FOR_REVIEW，或在真实停止条件下写
STOPPED_DAY6_CONTRACT_REVIEW。
```

## 建议 Luna 设置

- 模型：Luna。
- reasoning：medium；只有阶段 1 发现有证据的接口冲突时再提高。
- 使用同一个 Luna 对话依次发送四段，避免丢失阶段 1 的接口审计结论。
- 不使用子智能体；不要求用户在普通实现 bug 上做决策。
