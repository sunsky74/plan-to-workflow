# 这份 fixture 的来历

来源会话：`/Users/sunsky/.pi/agent/sessions/--Users-sunsky-code-java-work-keeway--/2026-10-29T06-06-33-646Z_01a18644-6cad-745f-8c2a-cd050ae0a0cc.jsonl`
（6.80 小时，797 次工具调用，202M 输入 token）

逐项标明是**逐字摘录**还是**拼装**——拼装件不冒充实测数据。

| 文件 | 性质 | 用途 |
|---|---|---|
| `verdict-zh.txt` | **逐字摘录** | 真实 reviewer 输出，末行不是 `VERDICT:`，靠行首「结论：通过」才能判 PASS |
| `verdict-quote.txt` | **拼装** | 正文代码块里引用了一段真实的 `STATUS: BLOCKED`，但报告本身末行是 `STATUS: DONE`。用来钉住「引用 ≠ 本次结论」 |
| `s3-stage.txt` | **逐字摘录** | 导致 51 分钟挂死的 stage 自检原文 |
| `workflow-p1.js` | **逐字复制** | 模板形状，供 coverage 全量走查 |
| `workflow-p0.js` | **逐字复制** | 手写变体，供形状闸门 + C7/C8/C9 走查 |

## 为什么 `verdict-quote.txt` 是拼装的

会话里**不存在**「正文引用 `STATUS: BLOCKED`、自身末行 `STATUS: DONE`」的块。检索结果：

```
末行 DONE 的块: 0
其中正文含 STATUS: BLOCKED 的: 0
```

所以这条用例用两个真实片段拼成：引用块取自一个真实的 `STATUS: BLOCKED` 输出，外层报告按真实报告格式写。

**它测的是真需求**：`lastDecl()` 只认行首最后一条声明，正文里的引用不能覆盖它。这条规则在 `2026-10-22` 那次已经用全文匹配踩过坑（`STATUS` 全文匹配 → 把引用的 BLOCKED 当成结论）。

## 三个 fixture 对应的真实事故

| fixture | 事故 | 代价 |
|---|---|---|
| `s3-stage.txt` | stage 自检写「以 test profile 启动 service 上下文」，没限定不许 `spring-boot:run` | 子 workflow 挂死 51 分钟 |
| `verdict-zh.txt` | 编排脚本 `passed()` 只认英文 `VERDICT: PASS`，reviewer 写「结论：通过」→ 6 个真通过的任务被记成 blocked | 0.12 出口验收因此从未执行 |
| `verdict-quote.txt` | 同族：只认一种写法会用「失败」掩盖「通过」，比漏判更贵 | — |

编排方当时的原话（逐字）：

> 顺带记一个我该修的：`s3` 的自检里我写了"以 test profile 启动 service 上下文"，没限定**不许用 `spring-boot:run`**。这是我给的指令留的坑，不是 worker 的问题。

> **真相**：11 个任务的实现与评审都已完成，但我的编排脚本 `passed()` 只认英文 `VERDICT: PASS`，而一部分 reviewer 写的是「结论：通过」。结果 **0.1 / 0.2 / 0.4 / 0.8 / 0.9 / 0.11 六个真通过的任务被记成 blocked**。
