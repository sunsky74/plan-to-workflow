# 这是故意失败的样本，不要当 change 目录传给 selftest

`node templates/selftest.mjs <这个目录>` 会逐份跑 dryrun + coverage 并断言**全部通过** —— 这里的文件全部是**反例**，跑出来必然红。

它们的断言写在 `templates/selftest.mjs` 里，各对应一个具体检查：

| 文件 | 被哪个测试用 | 期望 |
|---|---|---|
| `s3-stage.txt` | C9 | 含「启动 service 上下文」→ 阻断 |
| `verdict-zh.txt` | verdict 解析 | 末行不是 `VERDICT:`，靠「结论：通过」判 PASS |
| `verdict-quote.txt` | verdict 解析 | 正文引用 `STATUS: BLOCKED` 不能盖过末行 `STATUS: DONE` |
| `workflow-p0.js` | C7/C8/C11 | 手写变体 → PARTIAL，缺超时 + 缺解析器 |
| `workflow-p1.js` | C7/C8 | 模板形状但缺超时 |

来历见 `2026-10-29-alert-center/SOURCE.md`（逐字 vs 拼装逐项标注）。
