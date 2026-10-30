// <change-name> — <一句话范围>
//
// 用法（人工段会中断，分段续跑）：
//   subagent({ workflow: "<path>/workflow.js", async: true })                          // 从 s1 开始
//   subagent({ workflow: "<path>/workflow.js", args: { fromStage: "s2", manualDone: ["M1"] }, async: true })
//
//   派发前必须三步（顺序不能倒，见 SKILL.md Step 4）：
//     1. subagent({ action: "validate", workflow: "<path>" })   ← 只证明语法能解析
//     2. stub 干跑（假 runs，真执行控制流）                        ← 才能抓出 ReferenceError / 跳层错
//     3. 冷 reviewer 只拿任务单 + 本文件                           ← 抓漏项 / 卡死门禁 / 撞车并行
//
// 骨架固定，只有 WAVES / STAGES / GATES / MANUAL 四块按任务生成。控制流不要改 ——
// 改控制流是历史上语法错误和派发事故的唯一来源。
//
// ⚠️ DOCS / RULES 是**示例**（来自一个 Java / Maven / 多仓项目）。换项目必须整个重写：
//    条款源叫什么、构建命令是什么、什么算越界，全部看该项目的 workflow-profile.md。

// ════════════════ 顶部常量（每个 change 改） ════════════════
const REPO = "<项目根绝对路径>";
const NAME = "<change-name>";
const CH = REPO + "/<任务单所在目录>/" + NAME; // 例：openspec/changes/<name>
const SKILL_DIR = REPO + "/.agents/skills/plan-to-workflow"; // skill 随项目走；装在别处才改这一行
const GATES_DOC = SKILL_DIR + "/gates.md";
const PROFILE = REPO + "/docs/agent/workflow-profile.md"; // 首次在新项目用先填
const MODEL_WORKER = "<provider/model-worker-id>";
const MODEL_GATE = "<provider/model-gate-id>"; // 必须与 worker 不同族或不同档

// 可选：per-stage worker 模型覆盖。有些 stage 确实需要更强的 worker —— 这是正门。
// 硬约束：覆盖后该 stage 的 worker **仍必须**与 MODEL_GATE 不同族/不同档，coverage 会逐 stage 核。
// 不要自己另造一个映射常量（如 HEAVY_STAGES）去改派发逻辑：那样机检认不出来，等于绕过规则，
// 而且会悄悄把某个 stage 变成「弱门禁审强产出」。
const STAGE_MODEL = {};
const MAX_ROUNDS = 2;

// 每次派发的时间上限。**必须有**：没有它，一个卡住的 worker 只会被人工发现，实测代价 49 分钟／次。
// checkpointBeforeDeadlineMs 让子 agent 在到点前结账并汇报，于是「卡住」变成「超时 + 有部分结论」。
const STAGE_TIMEOUT_MS = 25 * 60 * 1000;
const STAGE_CHECKPOINT_MS = 3 * 60 * 1000;

// ════════════════ 必读（必须按本项目重写） ════════════════
const DOCS = [
    "必读（按顺序，不要凭记忆）：",
    "1. " + GATES_DOC + " —— 门禁判据框架（P0 五形态 / 收敛 / 输出格式）",
    "2. " + PROFILE + " —— 本项目判据实例化、构建命令、仓拓扑、短名对照、人工段",
    "3. <任务单绝对路径> —— 本 stage 对应任务编号的定位/做法/验收/单测",
    "4. <条款源绝对路径列表> —— 规格 / 设计 / 决策记录 / 项目规范"
].join("\n");

// ════════════════ 硬约束（必须按本项目重写） ════════════════
const RULES = [
    "硬性约束：",
    "- <构建环境：运行时版本、必带的配置参数、代理>",
    "- 只改本 stage 授权范围内的文件；范围外的改动一律不做",
    "- <人工段白名单（从画像第 7 节抄）：提交 / 执行 SQL / 部署 / 发布 / 改线上配置>",
    "- <本 change 的一句话总约束，例：纯改名零行为，diff 里出现非标识符改动即打回>",
    "- <本项目编码规范里最容易被违反的 2-3 条，带出处>",
    "- 自检命令必须真跑并把结果贴出来；<本项目的跳过开关> 不算通过",
    "",
    "验证预算（这三条是为了打断「验证器自己坏了 → 假 FAIL → 无限修」的死循环，实测代价 49 分钟／次）：",
    "- 自证验证器：自己写的校验脚本/正则，先用一条已知 PASS 的样本跑一次。",
    "  如果它对已知 PASS 的东西报 FAIL，那是脚本有 bug —— 改脚本，不改交付物。",
    "- 同一条验证命令最多跑 2 次（含换参数）。第 2 次仍 FAIL → 立刻 `STATUS: BLOCKED`，",
    "  写清「验证器疑似有 bug」和「已用什么样本自证」。不许为了让它变绿而改交付物。",
    "- 禁止前台常驻命令（不会自己退出）：mvn spring-boot:run / npm start / tail -f / nc -l / 起服务端。",
    "  需要起服务时用 `timeout 60s <cmd>`，或后台 + 显式 kill + 轮询日志到关键字为止。",
    "- 输出末尾必须有一行 `STATUS: DONE` 或 `STATUS: BLOCKED <原因>`",
    "",
    "`STATUS: BLOCKED` 之后**必须**紧跟裁决块，缺任一项视为「决议不完整」（门禁判 P0）：",
    "  选项: A) <做法> @代价  /  B) <做法> @代价",
    "  推荐: <A 或 B> —— <一句理由>",
    "  已尝试: <做了什么、查到什么>",
    "  需要: <必须由人提供的具体信息；无则写「无」>",
    "",
    "理由：运行中冒出来的决策点，如果只回一个原因，编排方就得重新调研一遍才能裁决。"
].join("\n");

// ════════════════ WAVES：依赖层级（人工段也在这张表里） ════════════════
// 外层 = 串行的层；内层 = 同层并行的 stage。
// 人工段写成 "M1" / "M2" 独立占一层 —— 遇到就停机等人工，续跑时用 args.manualDone 放行。
// 顺序即真值，没有第二份映射要维护。划分规则见 SKILL.md Step 2，不在这里重写。
// 另加一条构建层硬限制：不向共享缓存安装同坐标产物（~/.m2、node_modules、lockfile 会互相覆盖）
//   → 并行 stage 只跑自检，安装类动作留给下游串行 stage。
//
// 推荐做法：开头立一个人工段 M0 清基线。agent 不许提交，所以开工前工作树可能已经有
// 别处的脏改动；先让人把它清零，后面所有「纯度取证」才有干净基线可依。
// 不是硬规则 —— 但如果省掉，门禁的路径限定 diff 会夹带无关改动，误判成越界。
const WAVES = [
    ["s1"],
    ["M1"],
    ["s2", "s3"],
    ["M2"],
    ["s4"]
];

// ════════════════ STAGES：只写「任务编号 + 差异指令 + 自检」 ════════════════
// 不复述任务单正文 —— 正文走 DOCS 引用，由子 agent 现场读。
// 复述会出现三份副本（任务单 / STAGES / GATES），改一处漏两处。
const STAGES = {
    s1: [
        "范围：tasks.md 任务编号 <1.1>、<1.2>",
        "授权范围：<repo-path>",
        "补充指令：<任务单没写、但本轮必须遵守的约束>",
        "自检：<本项目的单仓自检命令，从画像第 1 节抄>"
    ].join("\n"),
    s2: [
        "范围：tasks.md 任务编号 <2.1>",
        "授权范围：<repo-path>",
        "自检：<命令>"
    ].join("\n"),
    s3: [
        "范围：tasks.md 任务编号 <2.2>",
        "授权范围：<repo-path>",
        "自检：<命令>"
    ].join("\n"),
    s4: [
        "范围：tasks.md 任务编号 <3.1>",
        "授权范围：<repo-path>",
        "自检：<命令>"
    ].join("\n")
};

// ════════════════ GATES：本 stage 专项核对 ════════════════
// 不写通用判据（通用判据在 gates.md）。
// 同类 stage 的专项核往往 90% 相同 —— 用函数抽公共段，只留差异点。不要复制粘贴。
//
//   function mechanicalGate(scope, total) {
//       return "① `grep` 在该范围为零且数量对得上原 " + total + " 处；"
//            + "② diff 里除 <本类改动> 外零改动；③ 只碰了 " + scope + "；④ 测试真跑绿";
//   }
//   const GATES = { s2: mechanicalGate("<scope>", 128), s3: mechanicalGate("<scope>", 32) };
//
// 验证型 stage（写集为空、只跑检查）的专项核对全部指向假绿：
//   命令真跑了没、真输出贴了没、有没有用项目的跳过开关、断言是空转还是真验行为。
const GATES = {
    s1: "逐条核对：①<产出形态符合 design>；②<声明保留处> 零改动；③<测试为真断言，非空转>；④全量测试绿且既有基线不恶化",
    s2: "逐条核对：<本 stage 特有的可验证点>",
    s3: "逐条核对：<本 stage 特有的可验证点>",
    s4: "逐条核对：<本 stage 特有的可验证点>"
};

// ════════════════ MANUAL：人工段，永不进 stage ════════════════
// 每段要写：做什么、怎么核、完成后用哪条 args 续跑。
const MANUAL = {
    M1: [
        "【M1】<这段人工要做什么>",
        "1. <具体步骤，可复制执行>",
        "2. <怎么核这一段的产出确实就绪（下游 stage 的门禁会核它）>",
        "完成后续跑：args:{ fromStage:'<下一段第一个 stage 名>', manualDone:['M1'] }"
    ].join("\n"),
    M2: [
        "【M2】<这段人工要做什么>",
        "1. <具体步骤>",
        "完成后续跑：args:{ fromStage:'<stage 名>', manualDone:['M1','M2'] }"
    ].join("\n")
};

// ════════════════ 以下不需要改 ════════════════

const PASS = "VERDICT: PASS";
const BLOCKED = "VERDICT: BLOCKED";
const HALT = "STATUS: BLOCKED";

const FROM = args && args.fromStage ? String(args.fromStage) : "";
const DONE = args && args.manualDone ? args.manualDone : [];
const findings = {}; // stage -> 上一轮门禁输出

function isManual(wave) {
    return String(wave[0]).charAt(0) === "M";
}

function implTask(stage, round, findings) {
    const lines = [DOCS, "", RULES, "", "## 本轮任务（" + stage + " 第 " + round + " 轮）", STAGES[stage]];
    if (round > 1) {
        lines.push("", "## 上一轮门禁 findings（逐条修，或带证据反驳，不许沉默跳过）", findings);
    }
    return lines.join("\n");
}

// 判越界要用「累积授权」：全仓 status 里每处改动，只要能归到某个 stage 或 M 段就不算越界。
// 只给当前 stage 的边界，gate 就无法归因，只能把别的 stage 的合法产出判成 P0。
function scopeIndex() {
    return Object.keys(STAGES).map(function (k) {
        const m = String(STAGES[k]).match(/授权范围[：:]\s*([^\n]*)/);
        return k + ": " + (m ? m[1] : "(未声明授权范围)");
    }).join("\n");
}

function revTask(stage, implOutput, round) {
    const r = round || 1;
    return [
        "只读评审，不修改任何文件。判据来源：" + GATES_DOC + "（先读它，P0 等级与收敛规则以它为准）。",
        "本项目判据实例化：" + PROFILE,
        "被审对象：" + stage + " 的实现产出（下附）与工作区实际改动。",
        "",
        "## 本轮是第 " + r + " 轮",
        r > 1
            ? "这是复审轮：只判 (a) 上一轮的 P0 修没修净；(b) 修复动作是否**新引入** P0。与上轮修复无关的新发现一律降级 P1/P2，**不得**据此判 FAIL。"
            : "这是首轮：全量判定。",
        "",
        "## 本 stage 的任务与授权范围（判「越界」的唯一依据）",
        "边界以这里为准，不以你读到的改动为准：",
        STAGES[stage],
        "",
        "## 全 change 各 stage 的授权范围（归因用）",
        "判越界时：全仓 `git status` 里每一处改动，只要**能归到下面任一行**就不算越界。",
        "只有一处都归不上的，才是越界 P0。",
        scopeIndex(),
        "",
        "## 实现者当时被要求遵守的约束",
        RULES,
        "",
        "## 本 stage 专项核对", GATES[stage], "",
        "## 实现者输出（尾部）", String(implOutput).slice(-3000), "",
        "输出格式与末行 VERDICT 严格按 " + GATES_DOC
    ].join("\n");
}

function finalGateTask(kind) {
    const head = "只读总门禁（" + kind + "）。判据来源：" + GATES_DOC + "（先读它）。" + DOCS + "\n\n";
    if (kind === "A-规格符合性") {
        return head + [
            "对照 spec 逐条判定覆盖面，输出逐条表：",
            "- 每条 Requirement：已实现 / 部分 / 未做 / 待人工",
            "- 任务单每个 `- [ ]` 项：谁做掉的、证据在哪",
            "- 人工段项标「待人工」，不计未完成",
            "末行给 VERDICT。"
        ].join("\n");
    }
    return head + [
        "对抗性审查，专找：",
        "1) 越权面：改动是否让某类主体 / 调用方获得了它不该有的能力",
        "2) 存量破坏面：现网的 token / 缓存 / 会话 / 存量数据在新逻辑下会怎样",
        "3) 越界改动：git status 逐仓核对，是否有任务未授权的改动",
        "4) 假绿测试：断言是否空转、是否跳过、是否 mock 掉被测逻辑",
        "5) 遗漏的调用方：全仓 grep 确认声明「零改动」的地方真的没有第二处消费",
        "末行给 VERDICT。"
    ].join("\n");
}

// 状态判定只认「行首声明的最后一条」。
// 用 indexOf 全文匹配时，worker 只要在输出里引用一次规则原文（"若遇…则写 STATUS: BLOCKED"）
// 就会被当成真的 BLOCKED 停机。gate 的 VERDICT 同理。
function lastDecl(out, key) {
    const re = new RegExp('^[\\s>*`\\-]*' + key + ':[ \\t]*(DONE|BLOCKED|PASS|FAIL)\\b', 'gim');
    const hits = [...String(out || '').matchAll(re)];
    return hits.length ? hits[hits.length - 1][1].toUpperCase() : '';
}
const isBlocked = function (out) { return lastDecl(out, 'STATUS') === 'BLOCKED'; };
const verdictOf = function (out) { return lastDecl(out, 'VERDICT'); };

function ok(r, marker) {
    return String((r && r.output) || "").indexOf(marker) >= 0;
}

function line(stage, round, verdict) {
    return stage + " | " + verdict + " r" + round;
}

// ════════════════ 控制流：串行层 + 人工段 + 轮次门禁 + 层内并行 ════════════════
// 关键：轮次循环在外层，stage 并行在内层。这样既能并行，又只需顶层 await
// （workflow 沙箱不支持嵌套 async 函数，per-stage 的 async 重试循环会被拒）。

const report = { halted: false, reason: "", waves: [], progress: [], nextManual: "", at: "" };

// 异常兜底：provider / API / 参数被拒 / 运行时错误都要留下「死在哪、哪些过了」。
// 没有这层，脚本一抛错连 return 都到不了，report.progress 全丢（failureKind 会记成 script）。
let finalGates = null;
let failure = null;

try {

let started = !FROM;
for (let wi = 0; wi < WAVES.length; wi++) {
    if (report.halted) break;

    const wave = WAVES[wi];

    // 人工段：未在 args.manualDone 里声明就停机；已声明则跳过这一层
    if (isManual(wave)) {
        if (DONE.indexOf(wave[0]) < 0) {
            report.halted = true;
            report.nextManual = wave[0];
            report.reason = "到达人工段 " + wave[0] + "，需人工完成后再派发";
            break;
        }
        continue;
    }

    if (!started) {
        // 认层内任意成员：只认 wave[0] 时，传层内其它 stage 名会静默跳过整条链。
        if (wave.indexOf(FROM) >= 0) started = true;
        else continue;
    }

    report.at = "wave " + wave.join("+");
    const waveRec = { wave: wave.join("+"), stages: [], rounds: 0 };
    let pending = wave.slice();

    for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
        waveRec.rounds = round;

        // —— 并行派发本轮所有 pending stage
        const implSpecs = pending.map(function (s) {
            return {
                key: s + "-impl-r" + round,
                agent: "worker",
                model: STAGE_MODEL[s] || MODEL_WORKER,
                label: s + " 实现 r" + round,
                maxRuntimeMs: STAGE_TIMEOUT_MS,
                checkpointBeforeDeadlineMs: STAGE_CHECKPOINT_MS,
                task: implTask(s, round, findings[s] || "")
            };
        });
        const impls = await runs.all(implSpecs);

        // —— 分清谁 BLOCKED / 谁跑挂了 / 谁能进 gate
        const toGate = [];
        for (let i = 0; i < pending.length; i++) {
            const s = pending[i];
            const r = impls[i];
            if (!r || !r.ok) {
                report.halted = true;
                report.reason = s + " 第 " + round + " 轮实现运行失败";
                break;
            }
            if (isBlocked(r.output)) {
                report.halted = true;
                report.reason = s + " 实现者 BLOCKED：" + String(r.output).slice(-600);
                break;
            }
            toGate.push({ stage: s, output: r.output });
        }
        if (report.halted) break;

        // —— 并行门禁
        const gateSpecs = toGate.map(function (g) {
            return {
                key: g.stage + "-gate-r" + round,
                agent: "reviewer",
                model: MODEL_GATE,
                label: g.stage + " 门禁 r" + round,
                maxRuntimeMs: STAGE_TIMEOUT_MS,
                checkpointBeforeDeadlineMs: STAGE_CHECKPOINT_MS,
                task: revTask(g.stage, g.output, round)
            };
        });
        const gates = await runs.all(gateSpecs);

        // —— 判定与收敛
        const stillFailing = [];
        for (let i = 0; i < toGate.length; i++) {
            const s = toGate[i].stage;
            const g = gates[i];
            if (!g || !g.ok) {
                report.halted = true;
                report.reason = s + " 第 " + round + " 轮门禁运行失败";
                break;
            }
            if (verdictOf(g.output) === 'BLOCKED') {
                report.halted = true;
                report.reason = s + " 门禁需裁决：" + String(g.output).slice(-600);
                break;
            }
            findings[s] = g.output;
            if (verdictOf(g.output) === 'PASS') {
                waveRec.stages.push({ stage: s, ok: true, rounds: round });
                report.progress.push(line(s, round, "PASS"));
            } else {
                stillFailing.push(s);
            }
        }
        if (report.halted) break;
        pending = stillFailing;
    }

    // 轮次用尽仍有 pending → 停机。已 halted（BLOCKED / 跑挂）时不重复记 FAIL，只留原因。
    if (!report.halted && pending.length > 0) {
        for (let i = 0; i < pending.length; i++) {
            waveRec.stages.push({ stage: pending[i], ok: false, rounds: waveRec.rounds });
            report.progress.push(line(pending[i], waveRec.rounds, "FAIL"));
        }
        report.halted = true;
        report.reason = pending[0] + " 在 " + MAX_ROUNDS + " 轮内未过门禁：" + String(findings[pending[0]] || "").slice(-600);
    }

    report.waves.push(waveRec);
}

// ════════════════ 双总门禁（只有整条跑完才做） ════════════════
if (!report.halted) {
    const gs = await runs.all([
        { key: "final-a", agent: "reviewer", model: MODEL_GATE, label: "总门禁A 规格符合性", maxRuntimeMs: STAGE_TIMEOUT_MS, task: finalGateTask("A-规格符合性") },
        { key: "final-b", agent: "reviewer", model: MODEL_GATE, label: "总门禁B 对抗性", maxRuntimeMs: STAGE_TIMEOUT_MS, task: finalGateTask("B-对抗性") }
    ]);
    finalGates = gs.map(function (g, i) {
        return {
            gate: i === 0 ? "A-规格符合性" : "B-对抗性",
            ok: g.ok && verdictOf(g.output) === 'PASS',
            blocked: verdictOf(g.output) === 'BLOCKED',
            outputTail: String(g.output).slice(-1200)
        };
    });
    const bad = finalGates.filter(function (g) { return !g.ok; });
    if (bad.length > 0) {
        report.halted = true;
        report.reason = "总门禁未全过（" + bad.map(function (g) { return g.gate; }).join(" / ") + "）";
    }
}

} catch (e) {
    failure = { kind: "script", at: report.at || "(尚未进入任一 wave)", message: String((e && e.message) || e) };
    report.halted = true;
    report.reason = "脚本抛异常 @ " + failure.at + "：" + failure.message;
}

return {
    halted: report.halted,
    at: report.at || "",
    failure: failure,              // 非 null 说明是脚本异常退出，不是正常判定
    reason: report.reason,
    nextManual: report.nextManual,
    manualText: report.nextManual ? MANUAL[report.nextManual] : "",
    waves: report.waves,
    finalGates: finalGates,
    progress: report.progress, // 编排方逐行追加进 <change>/progress.md，并自己补时间戳
    // ⚠️ 续跑粒度是「层」不是 stage：同层已 PASS 的 stage 会被重跑，而写操作通常不幂等。
    //    重跑前查 progress 里该层有没有已 PASS 的；有就收窄 WAVES 再派发（见 SKILL.md Step 5 第 5 节）。
    manual: MANUAL             // 全部人工段，供编排方一次看全
};
