# Group 与 Session Tree 接口规范（v2）

状态：按用户确认的三层组内可见性修订并冻结，2026-09-15。

本规范只覆盖 Day 3-4 的第一条垂直切片：内存中的 group 管理、session 树、
相对关系和历史访问范围判定。它不实现 Task、DevelopmentRecord、历史读取、
持久化或模型调用。

## 1. 术语和方向

- `viewerSessionId`：准备读取历史的 session。
- `ownerSessionId`：历史所属的 session。
- `reader/source` 关系与上述方向一致：reader 是 viewer，source 是 owner。
- `ancestor` 是严格祖先，不包含节点自身；访问规则会单独允许 `SELF`。
- “全部历史”仅指 Pi 中允许应用读取的显式历史，例如用户消息、助手显式文本、
  工具调用和工具结果；永远不包含隐藏 chain-of-thought、凭据或被安全适配层丢弃
  的事件。
- 本切片用 `DevelopmentRecord` 验证 `DESIGN_CONTEXT` 和 `GROUP_FACT`；v2 Context
  Manager 还会把同一 exposure 语义应用于 Pi `HistoryEntryDescriptor`。独立
  `GroupFactStore` 的 active facts 对同 group 可见，但不因此自动开放原始聊天正文。

## 2. 数据对象

### Group

```js
{
  id: "group-001",
  name: "relay-demo",
  rootSessionId: "session-supervisor",
  policyVersion: "group-tree-v2"
}
```

### SessionNode

```js
{
  id: "session-worker",
  groupId: "group-001",
  piSessionRef: "pi-session-id-or-stable-ref",
  displayRole: "worker",
  parentId: "session-supervisor",
  status: "active"
}
```

根节点的 `parentId` 必须为 `null`。`displayRole` 只用于展示，不能参与关系或
访问判定。

## 3. 强制不变量

1. 每个 group 创建时必须同时创建且仅创建一个 root session。
2. root 的 `id` 必须等于 group 的 `rootSessionId`，且 `parentId === null`。
3. 除 root 外的每个 session 必须有且仅有一个同 group 父节点。
4. 一个父节点可以拥有零个或多个直接子节点。
5. 不允许给已存在的 group 增加第二个 `parentId === null` 节点。
6. 不允许跨 group 挂接父子关系。
7. session node ID 在 manager 内全局唯一；同一个 `piSessionRef` 也只能登记一次。
8. v2 不提供 reparent、删除 root 或删除非叶节点，因此公开 API 无法制造环。
9. 所有 ID、name、piSessionRef、displayRole、status 和 policyVersion 都必须是
   去除首尾空白后仍非空的字符串。
10. 查询结果是快照；调用方修改返回对象不能改变 manager 内部状态。

## 4. 公开接口

```js
class GroupTreeManager {
  createGroup({ id, name, policyVersion, rootSession })
  getGroup(groupId)
  listGroups()

  addSession({ id, groupId, piSessionRef, displayRole, parentId, status })
  getSession(sessionId)
  listSessions(groupId)

  getParent(sessionId)
  getChildren(sessionId)
  getAncestors(sessionId)
  getDescendants(sessionId)
  isAncestor(ancestorSessionId, descendantSessionId)

  resolveRelationship(readerSessionId, sourceSessionId)
  resolveHistoryAccess(viewerSessionId, ownerSessionId)
}
```

返回约定：

- `createGroup()` 返回 `{ group, rootSession }`。
- `addSession()` 返回新节点快照。
- `getParent(rootId)` 返回 `null`。
- `getChildren()` 只返回直接子节点，并保持添加顺序。
- `getAncestors()` 按“父节点到 root”顺序返回。
- `getDescendants()` 使用稳定的深度优先先序，并保持同级节点的添加顺序。
- `isAncestor(x, x)` 返回 `false`。
- 未知 ID 和非法输入必须抛出 `GroupTreeError`，不能静默返回空结果。

## 5. 关系解析

`resolveRelationship(readerSessionId, sourceSessionId)` 返回：

| 条件 | 结果 |
|---|---|
| reader 与 source 相同 | `SELF` |
| reader 是 source 的严格祖先 | `SUPERIOR` |
| source 是 reader 的严格祖先 | `SUBORDINATE` |
| 同 group，但互相不是祖先 | `PEER` |
| 不同 group | `UNRELATED` |

在 v2 中，`PEER` 表示“同 group 的非上下级节点”，不要求拥有同一个直接父节点。
这样叔侄分支也属于非上下级协作者，不会被误授予完整历史。

## 6. 历史访问范围

`resolveHistoryAccess(viewerSessionId, ownerSessionId)` 只返回访问范围，不读取内容：

| 条件 | access | reasonCode |
|---|---|---|
| viewer 是 owner 自身 | `FULL_EXPLICIT_HISTORY` | `ALLOW_SELF` |
| viewer 是 owner 的祖先 | `FULL_EXPLICIT_HISTORY` | `ALLOW_ANCESTOR` |
| viewer 是 owner 的子孙 | `DESIGN_CONTEXT_AND_GROUP_FACT` | `ALLOW_DESCENDANT_CONTEXT` |
| 同 group，但双方不构成祖先/子孙关系 | `GROUP_FACT_ONLY` | `ALLOW_GROUP_FACT_ONLY` |
| 不同 group | `DENIED` | `DENY_CROSS_GROUP` |

返回结构：

```js
{
  access: "FULL_EXPLICIT_HISTORY",
  relationship: "SUPERIOR",
  reasonCode: "ALLOW_ANCESTOR"
}
```

该函数必须在任何历史读取、索引、排序、摘要或模型调用之前执行。v1 不允许跨
group 暴露；以后如果增加跨 group 分享，必须使用单独、显式、可审计的规则，
不能改变本规则的默认拒绝语义。

## 7. 错误契约

所有业务错误使用 `GroupTreeError`，至少包含稳定的 `code`：

```text
INVALID_ARGUMENT
GROUP_ALREADY_EXISTS
GROUP_NOT_FOUND
SESSION_ALREADY_EXISTS
SESSION_NOT_FOUND
PI_SESSION_ALREADY_REGISTERED
PARENT_GROUP_MISMATCH
ROOT_SESSION_REQUIRED
```

错误消息只描述 ID 和结构问题，不携带 session 历史正文。

## 8. v2 测试契约

测试必须覆盖：

1. 创建 group 时自动登记唯一 root。
2. 一个 root 下添加多个直接子节点。
3. 子节点继续添加多个子节点。
4. 从 child 查 parent，从 parent 查直接 children。
5. ancestors 顺序和 descendants 稳定顺序。
6. 第二个 root、未知父节点、跨 group 父节点、重复 node ID 和重复
   `piSessionRef` 均失败。
7. `SELF / SUPERIOR / SUBORDINATE / PEER / UNRELATED` 五种关系均有表驱动测试。
8. self/ancestor 获得 `FULL_EXPLICIT_HISTORY`。
9. descendant 获得 `DESIGN_CONTEXT_AND_GROUP_FACT`。
10. peer 获得 `GROUP_FACT_ONLY`。
11. cross-group 为 `DENIED`。
12. 展示角色名称变化不会改变关系和访问判定。
13. 修改查询返回值不会改变内部状态。

## 9. 明确不在本切片内

- Task 和 DevelopmentRecord 的具体 schema/实现，见独立的
  [`TASK_RECORD_AUTH_SPEC.md`](TASK_RECORD_AUTH_SPEC.md)。
- Pi session 原始历史读取、sidecar descriptor 和 FactStore。
- JSON/SQLite 持久化、CLI、extension 和在线模型调用。
- 节点删除、移动、合并和任意 DAG。
