# Tests

运行 `npm test` 执行不联网、不消耗模型额度的默认测试。

- `integration/pi-sdk-spike.test.js`：Day 1-2 接入验收，验证两个
  `SessionManager.inMemory()` 的 ID、历史和文件状态相互独立，并验证 handoff
  字段白名单与 thinking 事件 fail-closed 过滤。
- `unit/group-tree.test.js`：Day 3-4 第一切片，验证唯一 root、多级父子结构、
  父子/祖先/后代查询、五类关系和基础历史访问范围。
- `unit/task-record-auth.test.js`：验证最小 Task、DevelopmentRecord、派生记录
  exposure 继承、payload-free descriptor、5×3 固定授权矩阵和 canary 不进入
  descriptor/decision/filter/error。
- `unit/pi-context-hook-spike.test.js`：Day 5 纯函数、hook harness、安全 evidence、
  固定 toolCallId 闭环、异常落点和 scenario-specific check 聚合。
- `unit/history-sidecar.test.js`：Day 6 descriptor/canonical hash、catalog、增量索引、
  受控 exposure、旧授权窄适配、fail-closed loader、授权前 read-attempt 和 extractor 白名单。
- `integration/pi-history-sidecar.test.js`：使用 Pi 0.85.1 `SessionManager.inMemory()`、
  `appendMessage/appendCompaction/branch` 验证实际 entry ID/形状、授权加载、完整性、工具闭环和 D6-H17 active branch scope。
- `unit/group-fact-store.test.js`：Day 7 canonical value/hash、schema、root-only 权限、版本 CAS/撤销/republish、原子失败、audit 和深拷贝。
- `unit/fact-snapshot.test.js`：active facts snapshot、预算估算/超限、深拷贝、release 生命周期。
- `integration/group-fact-snapshot.test.js`：跨 session 下一 run 读取新版本，并证明事实全流程不修改 Pi in-memory entries。

- `unit/`：关系、权限、投影、预算和状态机的纯逻辑测试。
- `integration/`：Pi session adapter、持久化和顺序 relay 测试。
- `security/`：canary 泄露、跨 group、日志脱敏和派生记录继承测试。
- `fixtures/`：只保存合成任务和假数据，不保存真实会话或凭据。

v2 后续测试按以下安全边界增加：

- sidecar descriptor 能关联 Pi entry，未知 ID、hash mismatch 和撤销状态 fail closed。
- GroupFact 版本切换后，旧 managed fact 不再进入下一轮上下文。
- 授权先于正文加载、词法检索和摘要；禁止正文不进入这些阶段的输入。
- `context` hook 重复触发时不重复注入，并保留当前 tool call/result。
- envelope、manifest 和普通日志均不复制被拒绝正文或 thinking 内容。

在线模型测试必须通过 `npm run spike:pi:dual:online` 显式执行，不能让普通
测试意外消耗 API 额度。

Day 5 faux-provider spike 必须通过 `npm run spike:pi:context` 显式执行；它只使用
`@earendil-works/pi-ai@0.85.1` 的 faux provider 和 in-memory session。非零退出码或
`UNOBSERVED`/`FAIL` 结果不得解释为 SDK 通过，也不得自动启动 ContextManager 或修改 Pi core。

Day 6 历史 sidecar runner 通过 `npm run spike:pi:history` 显式执行，只使用 Pi
`SessionManager.inMemory()` 和合成数据，不读取真实用户 session、不联网、不调用模型。
结构化结果写入 `artifacts/pi-history-sidecar-spike.json`；D6-H01 至 D6-H17 全 `PASS`
才得到 `DAY6_COMPLETE_GO_DAY7`。

Day 7 GroupFact runner 通过 `npm run spike:group-facts` 显式执行，语法检查为
`npm run spike:group-facts:check`。仅使用合成事实和 Pi in-memory session；D7-H01 至
D7-H16 全 `PASS` 才得到 `DAY7_COMPLETE_GO_DAY8`。artifact 写入
`artifacts/group-fact-store-spike.json`，不代表真实模型、持久化或最终 context 注入已验证。
