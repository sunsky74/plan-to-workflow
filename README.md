# plan-to-workflow

把一份任务单，变成一批可派发的子 agent workflow。

它不提供运行时——真正跑子 agent 的是 pi 的 `subagent` 工具。这个 skill 只决定两件事：**怎么切**，**怎么审**。

## 装到项目里

```bash
# 项目内（推荐：skill 随项目走）
mkdir -p <repo>/.agents/skills
ln -s /path/to/plan-to-workflow <repo>/.agents/skills/plan-to-workflow

# 全局（任何 cwd 都能发现）
mkdir -p ~/.agents/skills
ln -s /path/to/plan-to-workflow ~/.agents/skills/plan-to-workflow
```

软链而不是拷贝：多份副本会漂移，而这份 skill 的规则散在 4 个文件里，漂移过一次就再也不知道哪份在生效。

## 首次使用

```bash
# 1) 自检：确认工具本身没坏
node templates/selftest.mjs

# 2) 填项目画像（10 个取证项，一次落盘，之后复用）
cp profile.template.md <repo>/docs/agent/workflow-profile.md

# 3) 在 pi 里调用
/skill:plan-to-workflow <任务单路径>
```

## 文件

| 文件 | 管什么 |
|---|---|
| `SKILL.md` | 主流程：Step 0 分诊 → 1 画像 → 2 编排表 → 3 生成 → 4 四关 → 5 派发记账 |
| `gates.md` | 门禁判据框架：等级、`PASS := P0 == 0`、收敛、举证责任、取证方式 |
| `profile.template.md` | 项目画像模板：构建命令、条款源、授权范围、人工动作、可用模型 |
| `templates/workflow.template.js` | 生成的 workflow 的骨架（控制流写死，内容按项目填） |
| `templates/coverage.mjs` | 静态检查 C1–C12：覆盖 / 同仓并行 / 模型分档 / 派发契约 / 常驻命令 / 解析器哈希 / lite 边界 / 台账 |
| `templates/dryrun.mjs` | 干跑：跳层、人工放行、门禁收敛、超时续跑、UNKNOWN 重派、BLOCKED 停机 |
| `templates/cold-review.md` | 第四关：唯一需要 LLM 的环节（规格漏项、验收错位、门禁含糊） |
| `templates/bin/run-bounded.sh` | 有界执行器：起服务/长命令必须过它，到点杀整个进程组 |
| `templates/append-progress.mjs` | 把 workflow 返回的 progress 行幂等追加进 `progress.md` |
| `templates/selftest.mjs` | 检查器自己的回归套件 |
| `INCIDENTS.md` | 每条规则背后的真实事故 |
| `fixtures/` | 事故样本（故意失败）+ 真实切片度量表 |

## 改完必跑

```bash
node templates/selftest.mjs        # 101 项
```

退出码 0 才算改完。这套规则每一轮都是被真实事故喂出来的，`selftest` 里每一项都对应一次翻车。

`fixtures/incidents/` 里是**故意失败**的样本，不要当 change 目录传进去（见该目录 README）。