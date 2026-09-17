# Task、DevelopmentRecord 与授权接口规范（v1）

状态：已实现并通过离线测试，2026-09-15。

本规范覆盖 Day 3-4 的剩余切片。权限只取决于唯一 session tree 中 viewer 与
record source 的关系，以及记录的内容级别；Task 不参与授权，只用于工作分配、
状态、记录归属和后续相关性选择。

## 1. 总体模型

```text
Group
├── 唯一 Session Tree
│   └── 决定 SELF / SUPERIOR / SUBORDINATE / PEER / UNRELATED
└── Tasks
    └── DevelopmentRecords
        └── WORK_RECORD / DESIGN_CONTEXT / GROUP_FACT
```

授权顺序固定为：

```text
record descriptor（不含 payload）
  -> 解析 session 关系
  -> 固定内容级别矩阵
  -> allow/deny + reasonCode
  -> 仅对 allow 的 record ID 读取正文
```

Task ID 可以用于后续相关性筛选，但不能扩大或缩小授权结果。

## 2. Task

Task 是 group 内的一次具体工作指令，不是 group 的上级，也不形成第二棵权限树。
v1 不实现 `parentTaskId` 或“合法参与者”概念。

```js
{
  id: "task-auth-001",
  groupId: "group-001",
  issuerSessionId: "session-root",
  assigneeSessionId: "session-worker",
  goal: "实现记录授权矩阵",
  acceptanceCriteria: ["15 个矩阵场景通过"],
  status: "PENDING"
}
```

### Task 状态

```text
PENDING -> IN_PROGRESS -> COMPLETED
                       -> FAILED
```

终态不能继续迁移，同状态迁移也视为错误。

### Task 不变量

1. Task ID 在 `TaskManager` 内唯一。
2. group、issuer 和 assignee 必须存在。
3. issuer 和 assignee 必须属于 Task 指定的同一个 group。
4. issuer 必须是 assignee 自身或祖先；peer、descendant 和 cross-group 不能下达
   Task。
5. `goal` 和每条 `acceptanceCriteria` 必须是非空字符串；验收条件至少一条。
6. 创建时状态固定为 `PENDING`，不能由调用方伪造。
7. Task 只描述工作，不参与记录授权。

### TaskManager 接口

```js
class TaskManager {
  constructor({ groupTree })
  createTask({ id, groupId, issuerSessionId, assigneeSessionId,
               goal, acceptanceCriteria })
  getTask(taskId)
  listTasks(groupId)
  listAssignedTasks(sessionId)
  transitionTask(taskId, nextStatus)
}
```

所有返回值均为防御性快照。

## 3. DevelopmentRecord

DevelopmentRecord 是一个 session 显式发布的结构化工作记录，不是它的完整 Pi
session 历史。

```js
{
  id: "record-001",
  groupId: "group-001",
  taskId: "task-auth-001",
  sourceSessionId: "session-worker",
  type: "IMPLEMENTATION_REPORT",
  exposure: "WORK_RECORD",
  payload: { summary: "完成初版实现" },
  sourceRecordIds: [],
  contentHash: "sha256:...",
  schemaVersion: 1,
  createdAt: "2026-09-15T00:00:00.000Z"
}
```

### 记录类型

```text
WORK_DIRECTIVE
PLAN
DESIGN_DECISION
IMPLEMENTATION_REPORT
PATCH_SUMMARY
TEST_EVIDENCE
ISSUE
HANDOFF
ARTIFACT
SUMMARY
```

记录类型不决定权限，权限只看 `exposure`。

### 内容级别

从严格到宽松：

```text
WORK_RECORD < DESIGN_CONTEXT < GROUP_FACT
```

- `WORK_RECORD`：完整显式工作过程，只允许 source 自身和其祖先读取。
- `DESIGN_CONTEXT`：关键目标、接口、约束、设计决定和下达给子孙的命令；除自身
  和祖先外，source 的子孙也可读取。
- `GROUP_FACT`：稳定接口、状态、文件/产物引用和公开证据；同 group 所有节点可
  读取。
- 跨 group 对三类记录都拒绝。

### 记录不变量

1. record ID 在 store 内唯一。
2. group、task 和 source session 必须存在且属于同一 group。
3. `payload` 必须是可 JSON 序列化的数据；普通日志和授权决定不得复制 payload。
4. `contentHash` 由 store 使用 SHA-256 根据 payload 序列化结果生成。
5. `schemaVersion` 由 store 固定为 `1`；`createdAt` 由注入时钟生成。
6. `sourceRecordIds` 中的来源必须已存在且属于同 group。
7. 派生记录默认继承所有来源中最严格的 exposure。调用方可以进一步收紧，但不
   能扩大；v1 不实现降密。
8. 不接受或生成 hidden chain-of-thought。该边界由上游显式事件适配和 record
   发布契约共同保证，不声称通过关键词扫描 payload 就能识别思维链。

### DevelopmentRecordStore 接口

```js
class DevelopmentRecordStore {
  constructor({ groupTree, taskManager, now })
  createRecord({ id, groupId, taskId, sourceSessionId, type,
                 exposure, payload, sourceRecordIds = [] })
  getRecord(recordId)
  getDescriptor(recordId)
  listDescriptors({ groupId, taskId, sourceSessionId })
}
```

`getDescriptor()` 和 `listDescriptors()` 的结果不得包含 `payload`。后续读取器只能
在授权后，根据允许的 ID 调用正文读取接口；v1 的 `getRecord()` 只作为本地 store
能力，不得被候选构建器直接使用。

## 4. 固定授权矩阵

`authorizeRecordDescriptor()` 只接受不含 payload 的 descriptor：

| Relationship | WORK_RECORD | DESIGN_CONTEXT | GROUP_FACT |
|---|---:|---:|---:|
| `SELF` | allow | allow | allow |
| `SUPERIOR`（viewer 是 source 祖先） | allow | allow | allow |
| `SUBORDINATE`（viewer 是 source 子孙） | deny | allow | allow |
| `PEER`（同组其他分支） | deny | deny | allow |
| `UNRELATED`（跨 group） | deny | deny | deny |

接口：

```js
authorizeRecordDescriptor({ viewerSessionId, descriptor, groupTree })

filterAuthorizedDescriptors({ viewerSessionId, descriptors, groupTree })
```

单条决定返回：

```js
{
  recordId: "record-001",
  allowed: false,
  relationship: "PEER",
  access: "GROUP_FACT_ONLY",
  reasonCode: "DENY_NON_PUBLIC_TO_PEER"
}
```

决定对象不得包含 `payload`、payload 摘要或被拒绝正文。批量过滤返回允许的
descriptor 和所有安全决定；被拒绝正文不能进入后续 candidate、ranker、summary
或模型调用。

### reasonCode

```text
ALLOW_SELF
ALLOW_ANCESTOR
ALLOW_DESCENDANT_CONTEXT
ALLOW_GROUP_FACT
DENY_WORK_RECORD_TO_DESCENDANT
DENY_NON_PUBLIC_TO_PEER
DENY_CROSS_GROUP
```

## 5. 错误契约

Task 使用 `TaskError`，Record 使用 `DevelopmentRecordError`。至少覆盖：

```text
INVALID_ARGUMENT
TASK_ALREADY_EXISTS
TASK_NOT_FOUND
INVALID_TASK_ASSIGNMENT
INVALID_TASK_TRANSITION
RECORD_ALREADY_EXISTS
RECORD_NOT_FOUND
GROUP_MISMATCH
INVALID_RECORD_TYPE
INVALID_EXPOSURE
INVALID_PAYLOAD
SOURCE_RECORD_NOT_FOUND
EXPOSURE_ESCALATION
```

错误消息不得包含 payload 或 session 历史正文。

## 6. 测试契约

1. Task 的 self/ancestor 下达成功；descendant、peer、cross-group 下达失败。
2. Task 状态合法迁移成功，非法迁移失败。
3. Task 返回防御性快照，且 Task 不参与授权。
4. record 的 group/task/source 一致性和枚举校验。
5. descriptor 不含 payload，content hash 稳定。
6. 派生记录继承最严格 exposure，扩大 exposure 失败。
7. 固定授权矩阵的 5×3 共 15 个组合全部使用表驱动测试。
8. descendant 能读 `DESIGN_CONTEXT` 和 `GROUP_FACT`，不能读 `WORK_RECORD`。
9. peer 只能读 `GROUP_FACT`，不受节点深度或 displayRole 影响。
10. cross-group 三种 exposure 全部拒绝。
11. 含 fake canary 的拒绝记录，其 descriptor、decision、批量过滤结果和错误消息
    均不出现 canary。

## 7. 与 v2 Context Manager 的关系

本实现继续保留，但不再代表全部历史：

- DevelopmentRecord 负责 session 主动发布的计划、证据、handoff 和产物。
- Pi 原始历史另由不含正文的 `HistoryEntryDescriptor` sidecar 建立权限头，并复用
  本文件的 exposure 和 5×3 授权语义。
- 权威当前事实由独立 `GroupFactStore` 管理，不靠重复写入 GROUP_FACT record 或
  Pi persistent custom message 保持。
- HistorySummary、handoff 和其他派生内容仍继承来源中最严格的 exposure。

## 8. 本切片不做

- 读取或复制 Pi session 原始历史。
- sidecar loader、词法检索、摘要、projection 和 token budget。
- JSON/SQLite 持久化、CLI、extension 或在线模型调用。
- Task 子任务树、多人参与者、任意 DAG 或跨 group 分享。

## 9. 实现与验证

- `src/task-manager.js`：Task 创建、查询和状态迁移。
- `src/record-store.js`：记录校验、JSON 归一化、稳定 SHA-256、descriptor 和派生
  exposure 继承。
- `src/authorization.js`：只接收无 payload descriptor 的单条授权与批量过滤。
- `tests/unit/task-record-auth.test.js`：Task/Record 契约、完整 5×3 矩阵和 fake
  canary 边界。

2026-09-15 收口验证：`npm run check` 通过，`npm test` 为 3 个测试文件、64 项
测试全部通过。该结果是离线纯逻辑证据，不代表 Pi 在线 relay、Context Manager
或持久化已经实现。
