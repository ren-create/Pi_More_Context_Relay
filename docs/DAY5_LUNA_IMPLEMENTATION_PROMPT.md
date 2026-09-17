# Day 5 独立 Luna 对话提示词

用途：由用户在一个新的 Luna 对话中粘贴。该提示词采用四阶段停止点，避免一次性执行
架构审计、完整实现、所有测试和文档而耗尽额度。

## 首条提示词（只执行阶段 1）

```text
你在本地仓库 D:\Project\Pi_WMRAH\Pi_More_Context_Relay 工作。

目标：完成 Day 5 Pi context-hook feasibility spike，但必须分四个阶段执行。本轮只做
阶段 1，完成后停止，等待我回复“继续阶段 2”。不要创建子智能体，不要联网，不要调用
真实模型，不要运行 Day 5 spike。

先完整阅读：
1. 根目录 AGENTS.md
2. docs/DAY5_HOOK_SPIKE_DESIGN.md
3. 当前半成品：src/pi-context-hook-spike.js、
   scripts/pi-context-hook-spike.mjs、tests/unit/pi-context-hook-spike.test.js、package.json

重要背景：上一轮 Luna 因额度耗尽中断。当前半成品不是可信实现；语法检查和 69 项测试
虽通过，但已知测试覆盖不足。不得因为已有测试通过就宣布 Day 5 通过，也不得修改 Pi
core、node_modules、Day 1-4 实现或既有测试断言。

阶段 1 任务（只读审计，不修改文件）：
- 按冻结接口逐项比对半成品，输出 discrepancy table。
- 必须特别检查：安全 evidence 白名单是否保留验收字段；artifact sequence 是否全局唯一；
  H08-H11 的 scenario 归属；H13 settled 前后取值时机；faux provider 最终 Context 是否
  被真实观察；toolCallId 闭环；三层历史持久化审计；异常是否被记录；compaction 是否
  真的触发而非仅消费了预设 response。
- 把每个问题归类为 IMPLEMENTATION_BUG、TEST_GAP、PI_API_UNCERTAINTY 或 DESIGN_CONFLICT。
- 给出阶段 2 的精确拟修改文件与测试列表，但不要写代码、不要运行命令。

输出要简洁，最后必须写：STOPPED_AFTER_STAGE_1。
```

## 用户确认后：阶段 2 提示词

```text
继续阶段 2。只修纯函数与 hook harness，不改在线/确定性 runner 的场景实现。

允许修改：
- src/pi-context-hook-spike.js
- tests/unit/pi-context-hook-spike.test.js

要求：
- 严格实现 docs/DAY5_HOOK_SPIKE_DESIGN.md 的导出接口、幂等重建、session/snapshot
  状态机、安全 evidence schema、预算字段和异常落点。
- 补齐针对日志字段未被脱敏层误删、固定 toolCallId、stale snapshot、缺失 session、
  estimator/emit 异常、settled 前后状态的定向单测。
- 不要修改冻结验收含义，不要为了通过测试弱化 FAIL/UNOBSERVED。
- 只运行：node --check src/pi-context-hook-spike.js 和
  npx vitest run tests/unit/pi-context-hook-spike.test.js。
- 输出 changed files、测试结果和仍未实现项，然后停止。不要修改 runner、package、docs。

最后必须写：STOPPED_AFTER_STAGE_2。
```

## 用户确认后：阶段 3 提示词

```text
继续阶段 3。实现确定性 faux-provider runner 与四场景验收，不写结论文档。

允许修改：
- scripts/pi-context-hook-spike.mjs
- package.json
- package-lock.json（只有依赖清单确需同步时）
- tests/unit/pi-context-hook-spike.test.js（只补 runner 可抽取纯逻辑的测试）

要求：
- 不联网、不调用真实模型，使用 @earendil-works/pi-ai@0.85.1 faux provider。
- 四个隔离场景：normal、tool-loop、auto-retry、threshold-compaction。
- response factory 必须观察 Pi 最终传给 provider 的 Context，并显式标注 providerPurpose；
  不把 before_provider_request 当唯一 provider-call 证据。
- compaction tool result 使用足量合成字符真实越过阈值；确认 session_before_compact、
  compaction-summary provider call、session_compact、下一次 context 的真实顺序。
- 全 artifact sequence 唯一递增；scenario 专属 check 按设计归属聚合。
- 任一异常仍在 finally 写 artifacts/pi-context-hook-spike.json；FAIL、UNOBSERVED、
  INCONCLUSIVE 不得伪装成 PASS。
- 先运行语法检查和定向单测，再运行一次 npm run spike:pi:context。
- 如果 spike 失败，保留 artifact，定位为 spike bug、未观察或 Pi 证据；不要 patch Pi core。

输出每个 scenario 的关键序列、16 项 check、decision、failureLocation 和下一步；停止，
不要写 docs/DAY5_HOOK_SPIKE.md。

最后必须写：STOPPED_AFTER_STAGE_3。
```

## 用户确认后：阶段 4 提示词

```text
继续阶段 4。先独立复核阶段 3 的 artifact，再做最小修复和文档收口。

允许修改：
- 阶段 2/3 已允许的 Day 5 文件
- docs/DAY5_HOOK_SPIKE.md
- tests/README.md

执行顺序：
1. 审计 artifact 中 sequence、scenario、providerPurpose、snapshot/session、toolCallId、
   compaction/retry 顺序和 failureLocation。
2. 扫描完整 artifact，确认不含 managed/tool-result/thinking 三个合成 canary，也不含
   credential-like 内容。
3. 修复 spike 自身问题后重跑定向测试和 spike。
4. 运行 npm run check 与 npm test，确认原 64 项测试仍在且全部通过。
5. 仅依据实际证据写 docs/DAY5_HOOK_SPIKE.md，明确区分 PASS、FAIL、UNOBSERVED；若
   不是 GO_SDK，不得开始 ContextManager，也不得直接 patch Pi core。

最终输出：准确 changed files、执行过的命令、测试数、16 项结果、SDK/core-patch 决策、
仍未运行的工作。不要 commit、push 或创建 remote。

最后必须写：STOPPED_AFTER_STAGE_4。
```

## 建议的 Luna 设置

- 模型：Luna。
- reasoning：先用 medium；只有阶段 1 出现真实接口冲突时再临时提高，不建议一开始
  使用 high/max。
- 每阶段完成后由用户检查输出再继续，不使用子智能体。
