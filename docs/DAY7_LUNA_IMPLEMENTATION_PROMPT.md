# Day 7 独立 Luna 对话提示词

用途：在同一个 Luna 对话中按顺序粘贴五段。普通实现问题由 Luna 修复并继续；只有
`DAY7_GROUP_FACT_STORE_DESIGN.md` 第 10 节的接口或权威逻辑冲突才提前停止。

## 阶段 1：只读审计

```text
你在本地仓库 D:\Project\Pi_WMRAH\Pi_More_Context_Relay 工作。

目标：完成 Day 7 GroupFactStore 与事实快照，并先收口 Day 6 active-branch metadata scope。
严格分五阶段。本轮只执行阶段 1 的只读审计：不修改文件、不运行测试/runner、不创建
子智能体、不联网、不读取真实用户 session、不调用模型。

完整阅读：
1. AGENTS.md
2. docs/DAY7_GROUP_FACT_STORE_DESIGN.md
3. docs/CONTEXT_MANAGEMENT_SPEC.md 的 GroupFact/ContextSnapshot/预算部分
4. docs/ARCHITECTURE.md 和 docs/MVP_PLAN.md 的 Day 7
5. Day 6 source/tests/runner/design/implementation record
6. src/group-tree.js、src/record-store.js、src/task-manager.js、src/index.js、package.json
7. Pi 0.85.1 session-manager.d.ts/js 中 getEntries/getLeafId/parentId/branch/resetLeaf

输出 discrepancy table，并确认：
- 是否可只用 getEntries 已扫描 entry 的 id/parentId 加 getLeafId 建立 metadata topology；
- unsupported entry 是否需要 topology node 才能连接 active branch；
- 多 root、branch 切换、orphan/cycle/entry removal 的 fail-closed 规则是否可实现；
- group.rootSessionId 是否足以实现 root-only mutation；
- GroupFact replace/revoke/republish 的单 active、CAS 和原子提交是否无合同冲突；
- snapshot 不写 Pi 历史仍能保持一次 run 内不可变；
- 五阶段文件白名单与现有依赖是否足够。

分类为 CONFIRMED、IMPLEMENTATION_DETAIL、TEST_GAP、PI_API_CONFLICT 或 DESIGN_CONFLICT。
普通实现细节不能升级成阻塞。

命中设计第 10 节时最后写 STOPPED_DAY7_CONTRACT_REVIEW；否则给出阶段 2 的精确文件和
测试清单，最后写 READY_FOR_DAY7_STAGE_2，然后停止等待我发送阶段 2。
```

## 阶段 2：Day 6 active-branch scope 收口

```text
继续 Day 7 阶段 2。只处理 Day 6 metadata-only topology 和 active branch scope，不开始
GroupFactStore。普通测试/fixture 错误自行修复并重跑。

允许修改：
- src/history-sidecar.js
- tests/unit/history-sidecar.test.js
- tests/integration/pi-history-sidecar.test.js
- scripts/pi-history-sidecar-spike.mjs
- docs/DAY6_HISTORY_SIDECAR_DESIGN.md
- docs/DAY6_HISTORY_SIDECAR.md

严格实现冻结设计第 4 节：
- topology 为每个 Pi entry 保存 piEntryId/piParentEntryId，不保存正文；
- replaceSessionTopology 完整验证后原子替换；
- 支持 unsupported 中间节点、多 root 和 leaf 切换；
- orphan、cycle、未知 leaf、parent drift、已见 entry 消失 fail closed；
- listActiveBranchEntryIds 返回 root->leaf；
- listActiveBranchDescriptors 保留当前分支 eligible descriptors，废弃分支仍留普通 catalog；
- HistoryIndexer 只使用已取得 entries 的 metadata 和 getLeafId，不调用 getBranch；
- 新增真实 SessionManager.inMemory branch() 场景和 D6-H17；废弃分支正文 canary 不得进入
  scope、record 或 artifact。

运行：
- node --check src/history-sidecar.js
- Day 6 unit + integration 定向测试
- npm run spike:pi:history

修到 D6-H01–H17 全 PASS、DAY6_COMPLETE_GO_DAY7，输出 changed files、测试数、branch
sequence 和 artifact 结果。最后写 READY_FOR_DAY7_STAGE_3，然后停止。
```

## 阶段 3：GroupFactStore 版本状态机

```text
继续 Day 7 阶段 3。只实现 GroupFactStore、版本状态机和纯单元测试，不做 snapshot、runner
或结论文档。

允许新增/修改：
- src/group-fact-store.js
- tests/unit/group-fact-store.test.js
- src/index.js（只增加 Day 7 API export）

严格实现冻结设计第 5-6 节：
- lossless canonical JSON value 和稳定 SHA-256；
- 精确 GroupFact schema、factKey、深拷贝和安全错误；
- root-only publish/replace/revoke；同 group read、跨 group deny；
- version 1、单 ACTIVE、双向 supersede 链、CAS expectedPreviousFactId；
- revoke 不删除/不回滚；replace 最新 REVOKED 时显式 republish version+1；
- stale expected ID、重复 ID、ACTIVE 同 hash、非法 value 全部原子失败；REVOKED 后允许
  root 用相同或新 value 显式 republish 为新版本，旧 REVOKED 不改写；
- audit 不含 value，稳定排序；跨 group/revoked/superseded canary 不进入错误或 audit。

不要修改 GroupTree、DevelopmentRecordStore 或授权矩阵；不要用关键词扫描声称识别 thinking。

运行：
- node --check src/group-fact-store.js
- npx vitest run tests/unit/group-fact-store.test.js

修到通过，输出接口、测试数和仍待 snapshot 验证项。最后写 READY_FOR_DAY7_STAGE_4。
```

## 阶段 4：FactSnapshotManager 与预算

```text
继续 Day 7 阶段 4。实现事实快照、预算和跨 session 下一 run 生效测试；不写最终 runner
和结论文档。

允许新增/修改：
- src/fact-snapshot.js
- tests/unit/fact-snapshot.test.js
- tests/integration/group-fact-snapshot.test.js
- src/group-fact-store.js、tests/unit/group-fact-store.test.js（仅修复 snapshot 暴露的问题）
- src/index.js（增加 snapshot exports）

严格实现冻结设计第 7 节：
- createSnapshot 读取目标 session 同 group 全部 ACTIVE facts，并按 factKey 稳定排序；
- 保存 facts 深拷贝、factRefs 和明确的启发式 budget metadata；
- 同一 snapshot 在 replace/revoke 后仍保持旧版本/value；
- 下一 run 的 worker/tester 新 snapshot 读取新 ACTIVE 版本；
- revoke 后新 snapshot 不含 key，旧 snapshot 不变；
- 超预算抛 FACT_BUDGET_EXCEEDED，不创建 snapshot、不返回部分 facts；
- release 后 get/release fail closed；所有 getter/list 深拷贝；
- 用真实 Pi SessionManager.inMemory 证明事实全流程不增加/修改 Pi entries。

运行：
- node --check src/fact-snapshot.js
- Day 7 三个 unit/integration 定向测试文件

修到通过，输出版本序列、snapshot A/B/C 观察和预算失败证据。最后写
READY_FOR_DAY7_STAGE_5。
```

## 阶段 5：runner、独立复核与文档收口

```text
继续 Day 7 阶段 5。先独立审计阶段 2-4 的源码和测试，再实现 runner、修复问题、执行全量
回归并收口文档。不要因为定向测试通过就跳过代码审核。

允许新增/修改：
- scripts/group-fact-store-spike.mjs
- docs/DAY7_GROUP_FACT_STORE.md
- package.json、src/index.js、tests/README.md、README.md、docs/MVP_PLAN.md
- 冻结设计允许的 Day 6/7 文件（只做审核发现的最小修复）
- docs/ARCHITECTURE.md、docs/CONTEXT_MANAGEMENT_SPEC.md（仅实际证据改变假设时）

审核并执行：
1. topology 全程 metadata-only，active branch 排除 abandoned canary，D6-H17 有真实 Pi 证据。
2. GroupFact root-only、同组读、跨组拒绝、单 active、CAS、失败原子性。
3. replace/revoke/republish 链和 audit；不得自动恢复旧版本。
4. snapshot 在 store 更新中保持旧版本，下一 run 跨 session 读取新版本。
5. 预算超限不创建 snapshot、不返回部分 facts、不泄漏 value。
6. 实现六场景 runner、D7-H01–H16、全局唯一 sequence 和 finally artifact。
7. artifact 写盘前扫描四个 D7 canary；发现时写最小脱敏 failure artifact。
8. 运行 Day 6/7 定向测试、npm run spike:pi:history、npm run spike:group-facts、
   npm run check、npm test。
9. 扫描两个 artifact 的 canary、正文 key、stack 和 credential-like value。
10. 只按实际证据写 DAY7_GROUP_FACT_STORE.md，明确未运行真实模型、真实 session、
    持久化、检索、ContextManager 和最终 context 注入。

package scripts 新增：
- spike:group-facts:check
- spike:group-facts
并把新 source/runner 加入 npm run check，不删除旧命令。

最终输出 changed files、所有命令/测试数、D6-H01–H17、D7-H01–H16、两个 artifact 的
路径/record 数/decision/failureLocation、是否 GO_DAY8 和未执行范围。不要开始 Day 8，
不要 commit/push/创建 remote。

正常完成最后写 DAY7_IMPLEMENTATION_FINISHED_FOR_REVIEW；真实停止条件才写
STOPPED_DAY7_CONTRACT_REVIEW。
```

## 建议设置

- Luna，reasoning medium。
- 五段使用同一个对话，保持接口审计和状态机上下文。
- 不使用子智能体；普通实现问题不返回用户决策。
