/**
 * add-tsp-alert-center — P0(门禁与基准)派发脚本
 *
 * 运行(在 keeway 工作区):
 *   subagent({ workflow: "./openspec/changes/add-tsp-alert-center/workflow-p0.js", async: true })
 *
 * 阶段定义见 openspec/changes/add-tsp-alert-center/phases.md 的 P0;
 * 任务编号与验收口径以 tasks.md 为唯一真相源。
 *
 * 调度规则:
 * - 同一个 cwdKey 只有一个写者,天然串行(0.1 / 0.9 / 0.2 都在 driver,依次跑;含构建)。
 * - 纯文档任务按「文件互斥且无构建」拆成独立 cwdKey(rules-port / rules-error / adr / notes / ledger),
 *   可以同波并行(单波上限 MAX_PARALLEL=4);0.6 / 0.11 是 runtime,走 ops / env。
 * - deps 是硬前置;未完成的前置会挡住后续任务。
 * - 每个任务 = 1 个实现者 + 1 个全新 reviewer;MAX_ROUNDS=2。
 * - runtime 任务在环境不可用时必须报 BLOCKED 并给出命令与错误,禁止编造证据。
 * - STYLE_CONTRACT 由 rules/java-basic-rules.md、spring-develop-rules.md、git-rules.md(§二/§三)、
 *   project-env-rules.md(§4.2 Maven)与 AGENTS.md(§一─§六/§八)摘出,逐条可判定;worker 要自检,reviewer 要逐条给 PASS/N-A。
 *
 * 预算:11 个任务,MAX_ROUNDS=2 → 最坏 11 × 4 = 44 个子 agent,低于默认 64 的 spawn 预算。
 *
 * 预期 BLOCKED:
 * - 0.6 Kafka 基础设施参数核实 —— 需运维/nacos 权限;无权限时 BLOCKED 不阻塞其余任务。
 * - 0.11 通用位实采命中率 —— 需可连 dev 的 Kafka 或 MySQL;无环境时 BLOCKED。
 * 这两项由 0.12 出口报告记录为阻塞项,不阻止 P0 其余部分收口。
 */

const ROOT = "/Users/sunsky/code/java/work/keeway";
const DRIVER = ROOT + "/tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver";
const CHANGE = ROOT + "/openspec/changes/add-tsp-alert-center";

const MAX_ROUNDS = 2;
const MAX_WAVES = 40;
const MAX_PARALLEL = 4; // 单波最多 4 个实现者,避免一波 8 个 child 互相抢眼

const STYLE_CONTRACT = [
  "【适用性】改 .java 适用第 2–7 条;改 SQL 适用第 8 条;所有任务适用第 1、9–12 条。",
  "1【必读】动工前读 AGENTS.md + rules/java-basic-rules.md + rules/spring-develop-rules.md;改构建/端口读 rules/project-env-rules.md;任何 git 念头读 rules/git-rules.md。",
  "2【方法注释·强制】方法体超过 5 行要写中文编号步骤注释(// 1. … // 2. …),放在实现类方法体内对应代码块前;接口方法只写 Javadoc;新类写简洁 Javadoc 或项目 10-tag 头,禁止留占位符或 TODO 模板。",
  "3【常量·强制】字面量进常量类,禁止魔法数字与魔法字符串;常量类 final class + private 构造;public 常量必须有中文 Javadoc;状态/类型用枚举且含 code(int,从 1 连续)+ description,入库用 getCode() 禁用 name();分层:只有 driver 用放 driver 常量类,跨 center 才放 base-common。本阶段点名:FAULT_COUNT_MAX_VALID、0x98 位映射(bit→alertKey)、指标名、topic 名不得裸写。",
  "4【判空·强制】对象用 Objects.isNull/nonNull;字符串用 cn.hutool.core.util.StrUtil.isBlank/isNotBlank;集合用 cn.hutool.core.collection.CollUtil。",
  "5【日志·强制】@Slf4j + {} 占位符,禁字符串拼接;异常日志带异常对象 log.error(\"[方法] 说明, key={}\", k, e);关键操作打 info 且含业务标识。逐帧热路径(解码/判定)禁止打日志。",
  "6【日期时间】统一 LocalDateTime/LocalDate,禁 Date 与 SimpleDateFormat;表示时刻的存 UTC 字面量(ADR-0036),报文 6B 时间按 BeanTime.ZONE_ID 解释后转 Instant。",
  "7【JSON】统一 JacksonUtils,禁 new ObjectMapper()/JsonMapper。",
  "8【DB 脚本】文件名 yyyy-MM-dd-<feat>.sql,放产生变更模块的 src/main/resources/db/,文件头注释含 功能/模块/日期/说明/关联,尽量 IF [NOT] EXISTS;片段文件(如 ledger-seed.sql)必须在头部写明「片段,不可单独执行,由建表脚本或人工串接」。",
  "9【测试】JUnit 5 + AssertJ + @DisplayName;非平凡逻辑至少留一个可运行检查;不引入新测试框架;TDD 不强制(AGENTS §八)。",
  "10【构建】先 java -version 确认 JDK 21;命令行一律 mvn -s /Users/sunsky/develop/maven/apache-maven-3.6.3/conf/settings--sirun.xml(双横线);单模块验证用 mvn -s <settings> -pl <模块路径> -am test;禁改 localRepository。",
  "11【Git 红线】不 commit、不建分支、不 push、不打 tag、不部署、不改密钥;改动只留工作区,由人工审批后提交(rules/git-rules.md)。",
  "12【不扩范围】不改 pom 依赖、不加第三方依赖、不重构无关代码、不改既有公开方法签名(0.9 明确要求保留双版本入口);范围外的发现写进报告,不动手。"
].join("\n");

const tasks = [
  {
    id: "0.1",
    title: "修 0x07 故障数哨兵(0xFE 异常 / 0xFF 无效)",
    goal: "在 AlarmDataCodec(V2016)给 N1~N4 故障数加哨兵守卫:0xFE 视为异常、0xFF 视为无效,两者都不读故障码列表且不消费后续字节;0..0xFD 为有效计数。抽常量 FAULT_COUNT_MAX_VALID = 0xFD 到常量类,并为哨兵命中加计数(日志或 Micrometer 指标)。",
    purpose: "TD-46 ① 是报警数据源的可信度门禁:计数被误读成 254/255 会越界吃掉同一帧里的 0x01 整车与 0x08 单体电压,导致阈值规则吃错值。",
    files: [
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/main/java/net/sirun/project4j/keeway/gateway/gbt32960/driver/codec/gbt2016/realtime/AlarmDataCodec.java",
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/main/java/net/sirun/project4j/keeway/gateway/gbt32960/driver/codec/"
    ],
    deps: [],
    cwd: DRIVER,
    cwdKey: "driver",
    acceptance:
      "4 条固定字节用例(计数 0 / 253 / 0xFE / 0xFF)全绿;候选集为空时不消费后续字节;最关键的是回归用例「0x07 计数为 0xFF 时,紧跟其后的 0x01 整车数据仍能正确解析」通过;常量 FAULT_COUNT_MAX_VALID 无裸字面量残留;mvn -pl tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver test 全绿。"
  },
  {
    id: "0.9",
    title: "AlertFlatData 补 21 个国标报警位与 0x98 17 位",
    goal: "在 driver 的 AlertFlatData 与 AlertFlatDataConverter 中补齐两类报警数据:①21 个国标报警位 + maxAlarmLevel(来源 AlarmData / AlarmV2025Data);②0x98 通用报警标志 3 字节的 Bit0~Bit16(来源 VehicleAlarmCustomData.generalAlarm,17 个 Boolean)。只做 V2016 映射;V2025 分支不补(计算侧有版本闸门)。",
    purpose: "报警计算只需要这两个数据面。AlertFlatData 已有阈值计算所需全部字段,缺的正是报警位;补齐后 driver/model/flat 就是报警模块唯一的取数契约,不需要新建子模块。",
    files: [
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/main/java/net/sirun/project4j/keeway/gateway/gbt32960/driver/model/flat/AlertFlatData.java",
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/main/java/net/sirun/project4j/keeway/gateway/gbt32960/driver/model/flat/AlertFlatDataConverter.java",
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/test/java/net/sirun/project4j/keeway/gateway/gbt32960/driver/model/flat/"
    ],
    deps: [],
    cwd: DRIVER,
    cwdKey: "driver",
    acceptance:
      "固定字节用例断言国标报警位、maxAlarmLevel 与 0x98 Bit0~Bit16 全部映射正确;VehicleLatestFlatData 与 AlertFlatDataConverter 的既有双版本入口签名不变;既有 flat 相关测试不红;mvn -pl .../gateway-connect-gbt32960-driver test 全绿。"
  },
  {
    id: "0.2",
    title: "解码吞吐基准",
    goal: "用 ≥1000 条真实 gbt32960.report 报文(覆盖多车型;无真实数据时用仓库内外现有样本并注明来源)测单线程 hex → AlertFlatData 的解码吞吐:p50/p99 与帧/秒。结论写入 openspec/changes/add-tsp-alert-center/benchmark.md,给出 1000 帧/秒预算所需线程数(等于分区数)的建议。",
    purpose: "解码是整条链路最贵的一步,它决定 num.stream.threads 与分区数;这个数字错会让 P2 返工。",
    files: [
      "tsp/gateway-connect-gbt32960/gateway-connect-gbt32960-driver/src/test/java/",
      "openspec/changes/add-tsp-alert-center/benchmark.md"
    ],
    deps: [],
    cwd: DRIVER,
    cwdKey: "driver",
    acceptance:
      "benchmark.md 含样本来源与数量、运行命令、p50/p99、单线程帧/秒、以及「满足 1,000 帧/秒所需线程数」的明确结论;若单线程 ≥250 帧/秒则注明 4 线程达标;基准代码可重复运行且不进生产代码路径。"
  },
  {
    id: "0.3",
    title: "端口领号 10044 / 10045",
    goal: "在 rules/project-env-rules.md 的 100xx TSP 业务域表登记 10044(tsp-alert-center handle)与 10045(tsp-alert-center service),写明同服务多模块连号,并在修订记录追加一行。",
    purpose: "端口是部署与网关路由的前置;不领号就动配置会与在役服务撞号(10043 已被 32960 management 占用)。",
    files: ["rules/project-env-rules.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "rules-port",
    acceptance:
      "10044/10045 出现在端口表且归属 tsp-alert-center;未改动 10041/10042/10043 等既有归属;修订记录有对应日期行。"
  },
  {
    id: "0.4",
    title: "错误码段 14001–14999 登记",
    goal: "在 rules/spring-develop-rules.md §4.3 错误码分段表把 14001–14999 分配给 tsp-alert-center,并从「未分配」行里剔除该段。",
    purpose: "AlertErrorDetail 要有唯一段位;段位不登记等于给自己留了一个撞码隐患。",
    files: ["rules/spring-develop-rules.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "rules-error",
    acceptance:
      "分段表出现 14001–14999 → tsp-alert-center;未分配行不再包含 14000–19999 中的 14001–14999 区间;表内无重复段位。"
  },
  {
    id: "0.5",
    title: "ADR-0040 计算引擎与状态模型",
    goal: "新建 docs/adr/0040-tsp-alert-center-compute-engine.md,记录三条决策:①Kafka Streams 取代 Flink;②punctuator + 到期索引取代 Flink per-key timer;③事件表列级所有权(计算列 vs 业务列)。每条写清 context、备选与否决理由、后果。",
    purpose: "这三条是跨模块、难回退的选择,必须留决策痕迹,否则后续无人能解释为什么不是 Flink。",
    files: ["docs/adr/0040-tsp-alert-center-compute-engine.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "adr",
    acceptance:
      "ADR 含 Status/Context/Decision/Alternatives/Consequences 结构;三条决策各有备选与否决理由;与 design.md D2/D3/D7 表述一致,不引入新口径;格式与 docs/adr 既有篇一致。"
  },
  {
    id: "0.8",
    title: "版本约束落纸与抽样口径",
    goal: "在 openspec/changes/add-tsp-alert-center/notes.md 写明:生产报文为 GB/T 32960-2016,编解码包保留 V2025 能力但不使用,计算侧设版本闸门(D17);列出需运维确认的 Kafka 参数清单(源 topic 分区数、内部 topic 是否允许自动创建、tsp.alert.event 保留 3 天、state.dir 5GB)。抽样佐证由 0.11 承接,本节只写口径与命令。",
    purpose: "版本口径散落在对话里就会漂移;写成 notes.md 后,0.6/0.11 有可执行的输入。",
    files: ["openspec/changes/add-tsp-alert-center/notes.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "notes",
    acceptance:
      "notes.md 含版本结论、闸门语义、抽样命令(SQL 与 Kafka 两种取法,注明 vehicle_history 每 VIN 仅保留 2000 帧)、以及给运维的四项确认清单;结论与 decisions.md V1–V8 不冲突。"
  },
  {
    id: "0.10",
    title: "0x98 台账定稿与种子片段",
    goal: "把 ledger.md 的 17 项固化为可直接建种子的形式:在 ledger.md 补全 bit → alert_key → 中文名 → 默认等级 → fault_part 的完整表格(若已有则核对),并产出 openspec/changes/add-tsp-alert-center/ledger-seed.sql,内容是 17 行 tm_alert_info 的 INSERT VALUES 片段(alert_type=2、usage_status、alert_level、fault_part),字段名以 design.md D13 的 tm_alert_info 列为准。",
    purpose: "台账是 P2 校验 0x98 渠道的唯一输入;没有种子数据,2.11 的判定无法验证。",
    files: [
      "openspec/changes/add-tsp-alert-center/ledger.md",
      "openspec/changes/add-tsp-alert-center/ledger-seed.sql"
    ],
    deps: [],
    cwd: ROOT,
    cwdKey: "ledger",
    acceptance:
      "ledger-seed.sql 恰好 17 行 VALUES,bit 覆盖 Bit0~Bit16 无重无漏;alert_type 全为 2,等级 ∈ {1,2,3};ledger.md 与 seed 的 alert_key/等级/中文名三列完全一致;Bit17~Bit23 与故障状态字节不入账;SQL 可直接粘进 1.5 的建表脚本之后执行(不写库)。"
  },
  {
    id: "0.6",
    title: "Kafka 基础设施参数核实",
    goal: "核实并记录:①gbt32960.report 与 gbt32960.lifecycle.event 的实际分区数;②集群是否允许 Streams 自动创建 <app-id>-alert-*-changelog 与 -repartition(不允许则给出预建语句);③tsp.alert.event 建 topic 的保留策略;④state.dir 挂载建议。结果追加到 notes.md。",
    purpose: "分区数写进 P1 的 yml;内部 topic 不能建则 Streams 起不来。这两件事错了 P2 会卡在启动阶段。",
    files: ["openspec/changes/add-tsp-alert-center/notes.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "ops",
    kind: "runtime",
    acceptance:
      "notes.md 记录两个源 topic 的实际分区数、内部 topic 的结论与(必要时)预建命令、保留策略与 state.dir 建议;CASE:无集群访问权限时输出 BLOCKED 与已尝试的命令,不填写推测值。"
  },
  {
    id: "0.11",
    title: "0x98 通用位实采命中率抽样",
    goal: "取 ≥500 个不同 VIN、每车 ≥4 帧、共 ≥2000 帧 REAL_TIME 原始 HEX(优先从 gbt32960.report 抽;从 vehicle_history 抽时注意每 VIN 仅保留 2000 帧约数小时),解码后只统计 VehicleAlarmCustomData.generalAlarm 的 Bit0~Bit16 命中次数与涉及车辆数,产出 openspec/changes/add-tsp-alert-center/0x98-bit-coverage.md。",
    purpose: "17 项里哪些车端真的会置位只有实测知道;恒 0 的项在台账里应默认停用,免得配置界面留一堆永不触发的开关。",
    files: ["openspec/changes/add-tsp-alert-center/0x98-bit-coverage.md"],
    deps: [],
    cwd: ROOT,
    cwdKey: "env",
    kind: "runtime",
    acceptance:
      "报告含样本规模(帧数/VIN 数/时间窗)、17 位各一行(命中次数/涉及车辆数/结论:恒 0、偶发、高频)、以及对应的台账 usage_status 建议;CASE:无环境访问权限时输出 BLOCKED 与已尝试的命令,不编造统计值。"
  },
  {
    id: "0.12",
    title: "P0 出口验收与收口报告",
    goal: "逐条核对 0.1–0.11 的验收物,跑 openspec validate add-tsp-alert-center --strict 与 driver 模块 mvn test(JDK 21 + 项目 settings),勾选 tasks.md 中已完成的 P0 项,把出口结论写进 openspec/changes/add-tsp-alert-center/p0-exit.md:每个任务一行(完成/阻塞 + 证据路径),阻塞项写清原因与解除条件。",
    purpose: "phases.md 规定 P0 出门禁才能进 P1;没有书面出口结论,P1 会在错误前提上开工。",
    files: [
      "openspec/changes/add-tsp-alert-center/p0-exit.md",
      "openspec/changes/add-tsp-alert-center/tasks.md"
    ],
    deps: ["0.1", "0.2", "0.3", "0.4", "0.5", "0.8", "0.9", "0.10"],
    cwd: ROOT,
    cwdKey: "docs",
    acceptance:
      "p0-exit.md 覆盖 0.1–0.11 全部 11 项(0.6/0.11 允许 BLOCKED,须写解除条件);openspec validate 输出 valid;driver mvn test 结果贴出 BUILD SUCCESS 或失败明细;tasks.md 中完成的 P0 项已勾选且未误勾;对 0.6/0.11 的阻塞不隐瞒。"
  }
];

function emit(line) {
  console.log("[P0] " + line);
}

// reviewer 有两种输出习惯：`VERDICT: PASS` 与「结论：通过 / 判定：通过」。
// 只认英文会让中文 reviewer 的通过被判成失败 —— P0 首跑就因此把 6 个真通过的任务记成 blocked。
function passed(text) {
  const s = String(text || "");
  if (/\bVERDICT\s*:\s*PASS\b/i.test(s)) return true;
  const zh = s.match(/^[\s>*`\-]*(结论|判定|评审结论|merge verdict)\s*[:：]\s*(通过|不通过|未通过)/gim);
  if (!zh || zh.length === 0) return false;
  const last = zh[zh.length - 1];
  return /通过\s*$/i.test(last) && !/不通过|未通过/.test(last);
}

function taskPrompt(t, round, feedback) {
  const lines = [
    "You are the sole writer for cwdKey '" + t.cwdKey + "'. Do not edit files owned by another cwdKey.",
    "Task " + t.id + ": " + t.title,
    "Goal: " + t.goal,
    "Purpose: " + t.purpose,
    "Files/area: " + (t.files.length ? t.files.join(", ") : "runtime verification only"),
    "Acceptance: " + t.acceptance,
    "Review round: " + round + "/" + MAX_ROUNDS,
    "Read the repo AGENTS.md first, plus openspec/changes/add-tsp-alert-center/{design.md,decisions.md,ledger.md,phases.md} for the contracts this task must satisfy.",
    "Constraints: change only this task's files; do not commit, push, deploy, or alter secrets; report BLOCKED instead of guessing.",
    "Style contract (遵守,并在报告里自检):\n" + STYLE_CONTRACT,
    "Run focused validation (compile/test/grep). Report changed files, commands, results, and any blocker.",
    "Report must end with a STYLE SELF-CHECK block: one line per applicable contract item (2–12) with file:line where it was applied, or N/A with reason."
  ];
  if (feedback) {
    lines.push("Previous review feedback (fix only these findings, do not expand scope):\n" + feedback);
  }
  if (t.kind === "runtime") {
    lines.push(
      "This is a runtime/infrastructure verification task. If the environment is unavailable, report BLOCKED with the exact command and error. Never invent evidence."
    );
  }
  return lines.join("\n");
}

function reviewPrompt(t, implRef, round) {
  return [
    "Review only task " + t.id + ": " + t.title + ".",
    "Round: " + round + "/" + MAX_ROUNDS + ".",
    "Read the implementation report at " + implRef + " and inspect the actual files/diff.",
    "Check the goal and acceptance: " + t.acceptance,
    "Do not modify project/source files. Do not expand scope. Do not review other tasks.",
    "Return exactly these lines:",
    "VERDICT: PASS or FAIL",
    "FINDINGS: concrete findings with file/line references, or 'none'",
    "EVIDENCE: commands/files inspected",
    "Style contract (review every applicable item; a violation of any of them is a FAIL):\n" + STYLE_CONTRACT,
    "Add a STYLE CHECK block after EVIDENCE: one line per applicable item (2–12) with PASS/N-A and file:line evidence; grep for bare literals that belong in a constants class.",
    "If the report is missing, evidence is absent, or the task is runtime-only and blocked, return FAIL with the reason."
  ].join("\n");
}

// 0.7(剩余业务问题)已于 2026-10-29 全部裁决,预置为完成态。
const done = new Set(["0.7"]);
const blocked = new Map();
const feedback = new Map();
const waves = [];

for (let wave = 0; wave < MAX_WAVES; wave++) {
  const ready = tasks.filter(
    t => !done.has(t.id) && !blocked.has(t.id) && t.deps.every(d => done.has(d))
  );

  if (ready.length === 0) break;

  // 一个 cwdKey 同时只放一个写者;不同 cwdKey 可同波并行。
  const byCwd = new Map();
  for (const t of ready) {
    if (!byCwd.has(t.cwdKey)) byCwd.set(t.cwdKey, t);
  }
  let active = Array.from(byCwd.values()).slice(0, MAX_PARALLEL);
  const waveIds = active.map(t => t.id);
  emit("wave " + (wave + 1) + " start: " + waveIds.join(", "));

  for (let round = 1; round <= MAX_ROUNDS && active.length; round++) {
    const implItems = active.map(t => ({
      key: t.id + "-impl-r" + round,
      label: "Implement " + t.id + ": " + t.title,
      agent: "worker",
      context: "fresh",
      cwd: t.cwd,
      task: taskPrompt(t, round, feedback.get(t.id)),
      output: t.id + "/impl-r" + round + ".md",
      outputMode: "file-only"
    }));

    const implSettled = await Promise.allSettled(
      implItems.map(item => {
        const { key, ...opts } = item;
        return runs.run(key, opts);
      })
    );

    const implemented = [];
    const failed = [];
    for (let i = 0; i < active.length; i++) {
      const t = active[i];
      const r = implSettled[i];
      if (r.status === "fulfilled") {
        implemented.push({ task: t, ref: String(r.value.output || "") });
      } else {
        feedback.set(t.id, "Implementation agent failed: " + String(r.reason || "unknown error"));
        failed.push(t);
      }
    }

    const reviewItems = implemented.map(x => ({
      key: x.task.id + "-review-r" + round,
      label: "Review " + x.task.id + ": " + x.task.title,
      agent: "reviewer",
      context: "fresh",
      cwd: x.task.cwd,
      task: reviewPrompt(x.task, x.ref, round),
      output: false
    }));

    const reviewSettled = await Promise.allSettled(
      reviewItems.map(item => {
        const { key, ...opts } = item;
        return runs.run(key, opts);
      })
    );

    const next = failed.slice();
    for (let i = 0; i < implemented.length; i++) {
      const x = implemented[i];
      const r = reviewSettled[i];
      if (r.status === "fulfilled" && passed(r.value.output)) {
        done.add(x.task.id);
        feedback.delete(x.task.id);
        emit("pass: " + x.task.id);
      } else {
        const why = r.status === "fulfilled"
          ? String(r.value.output || "review returned no verdict")
          : "Review agent failed: " + String(r.reason || "unknown error");
        feedback.set(x.task.id, why);
        if (round < MAX_ROUNDS) {
          next.push(x.task);
        } else {
          blocked.set(x.task.id, why);
          emit("blocked: " + x.task.id);
        }
      }
    }

    active = next;
    emit("wave " + (wave + 1) + " round " + round + ": done=" + done.size + " blocked=" + blocked.size);
  }

  for (const t of active) {
    if (!blocked.has(t.id)) blocked.set(t.id, feedback.get(t.id) || "max rounds reached");
  }
  waves.push({ wave: wave + 1, ids: waveIds });
}

const unfinished = tasks.filter(t => !done.has(t.id) && !blocked.has(t.id)).map(t => t.id);

return {
  phase: "P0",
  done: Array.from(done).sort(),
  blocked: Object.fromEntries(blocked),
  unfinished,
  waves
};