// add-tsp-alert-center — P1 切片：骨架与契约（1.1–1.4）
//
// 用法（人工段会中断，分段续跑）：
//   subagent({ workflow: "<path>/workflow-p1.js", async: true })                                    // 从 M0 开始
//   subagent({ workflow: "<path>/workflow-p1.js", args: { fromStage: "s1", manualDone: ["M0"] }, async: true })
//   subagent({ workflow: "<path>/workflow-p1.js", args: { fromStage: "s2", manualDone: ["M0"] }, async: true })
//   subagent({ workflow: "<path>/workflow-p1.js", args: { fromStage: "s3", manualDone: ["M0"] }, async: true })
//   subagent({ workflow: "<path>/workflow-p1.js", args: { fromStage: "M1", manualDone: ["M0"] }, async: true })
//
//   派发前三步（顺序不能倒，见 SKILL.md Step 4）：
//     1. subagent({ action: "validate", workflow: "<path>" })
//     2. node <SKILL_DIR>/templates/dryrun.mjs <path>
//     3. node <SKILL_DIR>/templates/coverage.mjs <tasks.md> <path> <actions.md> <profile> --scope 1.1,1.2,1.3,1.4
//
// 骨架来自 plan-to-workflow 模板，控制流未改；只填 WAVES / STAGES / GATES / MANUAL 与顶部常量。
// 切片依据：openspec/changes/add-tsp-alert-center/plan.md

const REPO = "/Users/sunsky/code/java/work/keeway";
const NAME = "add-tsp-alert-center";
const CH = REPO + "/openspec/changes/" + NAME;
const SKILL_DIR = REPO + "/.agents/skills/plan-to-workflow"; // 随项目走
const GATES_DOC = SKILL_DIR + "/gates.md";
const PROFILE = REPO + "/docs/agent/workflow-profile.md";
const MODEL_WORKER = "sirun/deepseek-v4-pro-for-coding";
const MODEL_GATE = "sirun/deepseek-v4.1-flash"; // 与 worker 不同档
const STAGE_MODEL = {};
const MAX_ROUNDS = 2;

// ════════════════ 必读（必须按本项目重写） ════════════════
const DOCS = [
    "必读（按顺序，不要凭记忆）：",
    "1. " + GATES_DOC + " —— 门禁判据框架（P0 五形态 / 收敛 / 输出格式）",
    "2. " + PROFILE + " —— 本项目判据实例化、构建命令、仓拓扑、短名对照、人工段",
    "3. " + CH + "/tasks.md —— 本 stage 对应任务编号的定位/做法/验收",
    "4. " + CH + "/design.md —— D13（12 张表）、D15 与 D16（取数对象、三条渠道）、D7（列级所有权）",
    "5. " + CH + "/decisions.md —— 已裁决项，冲突时以它为准（P1 至 P5、S1 至 S3、V1 至 V8、W1 至 W6）",
    "6. " + CH + "/plan.md —— 本切片范围与取证约束（新建仓，diff 取证只在 tsp/tsp-alert-center 内有效）",
    "7. " + REPO + "/AGENTS.md、rules/java-basic-rules.md、rules/spring-develop-rules.md",
    "8. " + CH + "/specs/ —— 契约内容来源（computation、persistence、console、statistics、rule-config）"
].join("\n");

// ════════════════ 硬约束（必须按本项目重写） ════════════════
const RULES = [
    "硬性约束：",
    "- 构建环境：JDK 21，先 java -version；Maven 必带 -s /Users/sunsky/develop/maven/apache-maven-3.6.3/conf/settings--sirun.xml；新仓自检用 cd tsp/tsp-alert-center 后再跑 mvn，根目录无聚合入口",
    "- 只改本 stage 授权范围内的文件；范围外的改动一律不做",
    "- 人工段白名单（画像第七节）：提交、push、打 tag、执行 SQL 或 DDL、部署或发布配置、冒烟、归档，一律不做；也不做 git init",
    "- 本切片总约束：只建骨架与契约，不实现业务逻辑，即无 controller 方法体、无 Service 实现、无 Streams 拓扑；契约冻结后只允许加字段，不允许改名",
    "- 编码规范见 rules/java-basic-rules.md：方法体超过 5 行写中文编号步骤注释；常量进常量类且 final class 加 private 构造、public 常量有中文 Javadoc；枚举含 code 与 description，入库用 getCode；判空用 Objects 与 StrUtil 与 CollUtil；日志用 Slf4j 加占位符",
    "- 规范见 rules/spring-develop-rules.md：返回体泛型必须写明；Controller 不依赖 Feign 或 Mapper 或 Redis 或 Kafka；方法参数四个及以上用 DTO；DTO 与 VO 每个字段带 Schema 描述；异常走 ErrorDetail 枚举且 errCode 等于 messageKey；spring.messages.basename 必须带 i18n/messages 与 i18n/errors/messages 两条",
    "- 新模块形态：tsp-alert-center 下 pom.xml 与三个子模块 api、handle、service；api 内禁止 Feign 客户端与 openfeign 依赖；本切片不建 feign 模块",
    "- 自检命令必须真跑并把结果贴出来；骨架阶段若确无测试类，要给出 compile 结果并说明无测试类，不得用 skipTests 蒙过本应存在的测试",
    "- 输出末尾必须有一行 STATUS 与 DONE 或 BLOCKED 加原因",
    "",
    "STATUS 为 BLOCKED 时，之后必须紧跟裁决块，缺任一项视为决议不完整，门禁判 P0：",
    "  选项：A 做法加代价，B 做法加代价",
    "  推荐：A 或 B，附一句理由",
    "  已尝试：做了什么、查到什么",
    "  需要：必须由人提供的具体信息；无则写「无」",
    "",
    "取证方式：纯度用路径限定 diff，越界用累积授权，该仓每处改动都要能归到某个 stage。根仓脏状态与本切片无关，不得引用。"
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
    ["M0"],
    ["s1"],
    ["s2"],
    ["s3"],
    ["M1"]
];

// ════════════════ STAGES：只写「任务编号 + 差异指令 + 自检」 ════════════════
// 不复述任务单正文 —— 正文走 DOCS 引用，由子 agent 现场读。
// 复述会出现三份副本（任务单 / STAGES / GATES），改一处漏两处。
const STAGES = {
    s1: [
        "范围：tasks.md 任务编号 1.1",
        "授权范围：tsp/tsp-alert-center/ ，仅 pom.xml 与本 stage 创建的三份子模块 POM",
        "补充指令：parent 用 net.sirun:keeway-project4j:1.0.0-SNAPSHOT，groupId 用 net.sirun.project4j.keeway，packaging 为 pom，modules 顺序 api、handle、service；description 写明与 AGENTS.md 第三节 api/biz 形态偏离的理由，对齐 tsp-vehicle-status-center。同时建三个子模块的最小 POM，只含 parent 与 artifactId 与 packaging，让聚合 POM 一次 install 通过；子模块内容留给 s2 与 s3。",
        "自检：cd tsp/tsp-alert-center 后跑 mvn -s /Users/sunsky/develop/maven/apache-maven-3.6.3/conf/settings--sirun.xml -o install -DskipTests，贴 BUILD SUCCESS 与 reactor 模块数，应为 4"
    ].join("\n"),
    s2: [
        "范围：tasks.md 任务编号 1.2",
        "授权范围：tsp/tsp-alert-center/tsp-alert-center-api/",
        "补充指令：实体 AlertEvent 的列以 design.md D7 与 D13 为准；DTO 至少含 AlertEventPageQuery、AlertEventProcessDTO、AlertInfoCreateDTO、AlertInfoUpdateDTO、ThresholdCreateDTO；AlertConstants 含 topic 名、eventKey 分隔符、计算列白名单、0x98 位映射 17 条（依据 ledger.md）；AlertErrorDetail 实现 common-spring 的 ErrorDetail，段位 14001 至 14999，errCode 等于 messageKey；每个字段带 Schema 描述。禁止建 feign 模块。",
        "自检：cd tsp/tsp-alert-center 后跑 mvn -s settings -o -pl tsp-alert-center-api -am install -DskipTests；再 grep 证明 api 内无 Feign 客户端、pom 内无 openfeign，两处零命中"
    ].join("\n"),
    s3: [
        "范围：tasks.md 任务编号 1.3 与 1.4，合并原因见 plan.md",
        "授权范围：tsp/tsp-alert-center/tsp-alert-center-handle/ 与 tsp/tsp-alert-center/tsp-alert-center-service/",
        "补充指令：handle 依赖 api、gateway-connect-gbt32960-driver、tsp-vehicle-asset-center-feign、tsp-geo-lookup-center-feign、kafka-streams、common-redis、common-security、common-log、mybatis-plus；service 依赖 api、common-security、common-log、common-swagger、mybatis-plus、mysql-connector-j。两端各建主类与 application.yml，handle 用 10044、service 用 10045，含 nacos discovery 与 config、spring.messages.basename 两条、service 建 db 目录；不实现任何业务 bean。service 无 DB 时用 spring.autoconfigure.exclude 关数据源自动配置并留注释，让上下文能起。【运行纪律·硬】禁止任何前台常驻命令：`mvn spring-boot:run`、`java -jar`、`npm start` 一律不许直接跑 —— 它们不会自退出，上一轮就是因此超时 30 分钟；本机没有 `timeout`/`gtimeout`，也别用。需要启动取证时只能：① 读已有日志；或 ② `nohup <cmd> > /tmp/x.log 2>&1 &` 后轮询日志，取证完 `lsof -ti:<port> | xargs kill`。【现状】上一轮已在盘上留下 handle/service 两模块（主类、application.yml、db/.gitkeep 齐备），编排方复跑 `mvn -o install -DskipTests` 为 BUILD SUCCESS、`dependency:tree` 命中 kafka-streams:4.1.2 且无 flink。先核对现状，只在发现缺陷时修，不要整体重写。",
        "自检：① cd tsp/tsp-alert-center 后跑 mvn -s settings -o install -DskipTests 并贴 BUILD SUCCESS；② cd tsp/tsp-alert-center 后跑 mvn -s settings -o dependency:tree -pl tsp-alert-center-handle，贴 kafka-streams:4.1.2 命中行与 flink 零命中；③ 启动取证只许读日志：grep 'Started AlertServiceApplication' tsp-alert-center-service/logs/tsp-alert-center-service/*.log（若日志不存在，才用 nohup 后台起 test profile，取证后立即 kill 并贴 kill 证据）；④ 贴 grep 证据证明两处 yml 的端口、basename、nacos discovery/config 段"
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
    s1: "逐条核对：一、聚合 POM 的 parent 为 net.sirun:keeway-project4j:1.0.0-SNAPSHOT、groupId 为 net.sirun.project4j.keeway、packaging 为 pom，且 description 明确点名 AGENTS.md 第三节并写出 api/handle/service 的偏离理由；二、modules 恰为 api、handle、service 三个且无重复；三、三份子模块最小 POM 存在（只含 parent、artifactId、packaging）；四、命令按修正后的写法执行并把输出贴出：cd tsp/tsp-alert-center && mvn -s /Users/sunsky/develop/maven/apache-maven-3.6.3/conf/settings--sirun.xml -o install -DskipTests，判据为 BUILD SUCCESS 且 reactor 汇总恰为 4 个模块；不得使用任务单原文的 mvn -pl tsp/tsp-alert-center -am（根目录无聚合入口，必假失败）；五、只改了授权范围内的四份 POM，未建任何 java 或 yml",
    s2: "逐条核对：一、AlertEvent 字段与 design D7 与 D13 一致，身份列、生命周期列、业务列三组齐全；二、五个 DTO（AlertEventPageQuery、AlertEventProcessDTO、AlertInfoCreateDTO、AlertInfoUpdateDTO、ThresholdCreateDTO）都在且每个字段带 Schema 描述；三、至少一个 VO 类存在于 api 的 vo 包；四、AlertConstants 满足任务单原文三条 —— 类为 final class、含 private 无参构造、每个 public 常量有中文 Javadoc；内容含 topic 名、状态码、eventKey 分隔符、缓存 key、计算列白名单，且 0x98 位映射 17 条与 ledger.md 逐条一致；五、AlertErrorDetail 实现 ErrorDetail 且段位在 14001 至 14999；六、grep 两处零命中：api 源码内无 Feign 客户端注解，api/pom.xml 内无 openfeign 依赖；七、mvn -s settings -o -pl tsp-alert-center-api -am install -DskipTests 真跑通过并贴输出；八、无业务逻辑，无超过 3 行的方法体",
    s3: "逐条核对：一、两个模块 POM 的依赖集合与任务 1.3 与 1.4 的声明逐项对得上，多一个或少一个都记 P0；二、解析后的依赖树取证：cd tsp/tsp-alert-center && mvn -s settings -o dependency:tree -pl tsp-alert-center-handle，判据为命中 kafka-streams:4.1.2 且 flink 零命中，贴输出；三、两处 application.yml 端口分别为 10044 与 10045，且各含 nacos discovery（server-addr、namespace、group）与 nacos config 段；四、spring.messages.basename 必须包含 i18n/messages 与 i18n/errors/messages 两条 common，模块自身条目排在其后；五、service 的 db 目录存在；六、无 DB 可启动的取证方式写死：application.yml 含 spring.autoconfigure.exclude 覆盖 DataSource 与 MyBatis-Plus 自动配置，且启动输出出现 Started 加主类名；Nacos 不可达导致启动失败时不得判 PASS，记为环境性阻塞并给出替代（本地 profile 关闭 nacos discovery 的日志）；七、未实现 controller、service、拓扑，骨架不含业务 bean；八、cd tsp/tsp-alert-center && mvn -s settings -o install -DskipTests 真跑通过并贴 BUILD SUCCESS"
};

// ════════════════ MANUAL：人工段，永不进 stage ════════════════
// 每段要写：做什么、怎么核、完成后用哪条 args 续跑。
const MANUAL = {
    M0: [
        "【M0】建立新仓基线，用户裁决 P2=A，人工建仓，否则门禁 diff 取证失效",
        "1. mkdir -p /Users/sunsky/code/java/work/keeway/tsp/tsp-alert-center",
        "2. cd 该目录后执行 git init，写 .gitignore 含 target/ 与 .idea/ 与 logs/，写 README.md，然后 git add -A 与 git commit -m 'chore: init tsp-alert-center repo'",
        "3. 核：git -C 该目录 log --oneline 显示该提交；git -C 该目录 status --porcelain 为空",
        "   该提交需用户明确批准，见 rules/git-rules.md 第一节。用户不批则本切片停在此处。",
        "完成后续跑：args:{ fromStage:'s1', manualDone:['M0'] }"
    ].join("\n"),
    M1: [
        "【M1】提交本切片产出，见 rules/git-rules.md 第一节，需用户批准",
        "1. cd 该目录后跑 git status --porcelain 逐条核对，只应出现 1.1 至 1.4 授权路径下的文件",
        "2. git add -A 与 git commit -m 'feat(alert): P1 骨架与契约'",
        "3. 核：git -C 该目录 status --porcelain 为空；git show --stat HEAD 文件数与本切片产出对得上",
        "   不得把根仓 keeway 的 P0 文档改动或 driver 仓改动混进来，它们是独立仓。",
        "完成后续跑：无。本切片结束；建表脚本与 db-schema 另起一片（见 plan.md 已知风险）"
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
// 模板只认 `VERDICT: PASS`。中文 reviewer 常写「结论：通过 / 判定：通过」，
// 实测 P0 首跑就有 6 个真通过的 stage 因此被判失败。这里加一条行首限定的中文兜底。
function zhVerdict(out) {
    const hits = [...String(out || '').matchAll(/^[\s>*`\-]*(结论|判定|评审结论)\s*[:：]\s*(通过|不通过|未通过)/gim)];
    if (!hits.length) return '';
    const last = hits[hits.length - 1][2];
    return /不通过|未通过/.test(last) ? 'FAIL' : 'PASS';
}
const verdictOf = function (out) { return lastDecl(out, 'VERDICT') || zhVerdict(out); };

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
        { key: "final-a", agent: "reviewer", model: MODEL_GATE, label: "总门禁A 规格符合性", task: finalGateTask("A-规格符合性") },
        { key: "final-b", agent: "reviewer", model: MODEL_GATE, label: "总门禁B 对抗性", task: finalGateTask("B-对抗性") }
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
