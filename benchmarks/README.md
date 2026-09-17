# Benchmarks

- `tasks/`：固定的小型编码任务与初始仓库快照说明。
- `expected/`：必须送达的证据、禁止泄露的 canary 和人工验收规则。
- `results/`：本地运行输出，默认不提交。

每次基线与 Relay 对照必须固定任务版本、模型、模型参数、工具集合和最大步骤数，
并保留失败结果。最小对照为：

```text
Pi/default 或授权范围全量历史
vs
授权 + active facts + 词法历史检索 + token budget
```

至少记录 input token、必要证据送达、任务结果、延迟和 fake canary 泄漏。embedding
混合检索是 MVP 后可选的第三组，不引入向量数据库。该目录用于证据，不用于只展示
“最好的一次”。
