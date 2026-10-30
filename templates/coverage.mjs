// coverage.mjs —— 覆盖矩阵 + 静态合规检查（纯机械层，零 LLM、零成本）
//
// 用法:
//   node coverage.mjs <tasks.md> <workflow.js>
//   node coverage.mjs <tasks.md> <workflow.js> <actions.md>
//   node coverage.mjs <tasks.md> <workflow.js> <actions.md> <profile.md>
//   node coverage.mjs <tasks.md> <workflow.js> <actions.md> <profile.md> --scope 4.1,4.2,4.3
//
// 检查分三层：
//
//   A · 任务级覆盖   任务单里每个未完成单元，被哪个 stage / 人工段认领了
//   B · 动作级覆盖   一个任务占一个 stage 不代表它里面的动作都被做了
//   C · 静态合规     模型是否分档、skill 路径是否硬编码、WAVES 与 STAGES/MANUAL 是否对得上
//
// 为什么有 C：三次独立产出（两个手写 + 一个按 skill 生成）三次都把 MODEL_GATE 写成和
// worker 同一个模型。同一条规则被反复违反说明它不是"该记得的事"，而是必须机检的事。
//
// --scope：本切片范围。不传 = 全量。切片编排时传上，否则 out-of-scope 的任务会被误报为漏项。

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let scopeArg = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') scopeArg = argv[++i] || '';
    else if (argv[i].startsWith('--scope=')) scopeArg = argv[i].slice(8);
    else files.push(argv[i]);
}
const [tasksFile, wfFile, actionsFile, profileFile] = files;
if (!tasksFile || !wfFile) {
    console.error('用法: node coverage.mjs <tasks.md> <workflow.js> [actions.md] [profile.md] [--scope X.Y,Z.W]');
    process.exit(1);
}

const read = (f) => (f ? fs.readFileSync(f, 'utf8') : '');
// scope 优先取命令行；没传就读同目录 plan.md 的 `scope:` 行 ——
// 否则「本次范围」就变成一个人人都不会记得传的参数。
let scopeSrc = scopeArg || '';
if (!scopeSrc) {
    const planPath = path.join(path.dirname(tasksFile), 'plan.md');
    if (fs.existsSync(planPath)) {
        const pm = fs.readFileSync(planPath, 'utf8').match(/^\s*scope\s*[:：]\s*(.+)$/im);
        if (pm) scopeSrc = pm[1].replace(/[（）()].*$/, '');
    }
}
const SCOPE = new Set(
    String(scopeSrc)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
);
const inScope = (t) => SCOPE.size === 0 || SCOPE.has(t.id);

// ── 任务单：抽 - [ ] / - [x] 的 编号 + 标题
const tsrc = read(tasksFile);
// 任务单元形态按画像第 4 节可以是 `- [ ] 2.2`、`- [ ] T2.3`、甚至表格行。
// 硬编码只认「数字.数字」会让换一种写法直接报「全部漏项」——那是假结论。
// 统一取 `- [ ]` 后的第一个 token 当 id；表格行取首列。
const ID_OK = /^[A-Za-z]*\d+(?:[.\-_]\d+)*$/;
const tasks = [];
for (const line of tsrc.split('\n')) {
    let m = line.match(/^\s*-\s*\[([ xX])\]\s*(\S+)\s*(.*)$/);
    if (m && ID_OK.test(m[2])) {
        tasks.push({ id: m[2], done: m[1].toLowerCase() === 'x', title: m[3].replace(/[*`]/g, '').slice(0, 44) });
        continue;
    }
    m = line.match(/^\s*\|\s*([A-Za-z]*\d+(?:[.\-_]\d+)*)\s*\|\s*(.*?)\s*\|/);
    if (m && !/^[-: ]+$/.test(m[2])) {
        tasks.push({ id: m[1], done: false, title: m[2].replace(/[*`]/g, '').slice(0, 44) });
    }
}
if (!tasks.length) {
    console.error('任务单里没找到 `- [ ] X.Y 标题` 形式的单元。');
    process.exit(1);
}

// ── workflow：分区抽任务号
const wsrc = read(wfFile);
// 按「行首 const <NAME> =」定位，不能用 indexOf('const GATES') ——
// 那会先命中 `const GATES_DOC`，读错整块文本。
const region = (name, endName) => {
    const start = new RegExp('^const\\s+' + name + '\\s*=', 'm').exec(wsrc);
    if (!start) return '';
    const from = start.index;
    if (!endName) return wsrc.slice(from);
    const end = new RegExp('^const\\s+' + endName + '\\s*=', 'm').exec(wsrc.slice(from + 1));
    return wsrc.slice(from, end ? from + 1 + end.index : wsrc.length);
};
const stageRegion = region('STAGES', 'GATES');
const manualRegion = region('MANUAL', null).split('// ════════════════ 以下不需要改')[0];

function blocks(text, keyPattern) {
    const out = {};
    const re = new RegExp('^\\s*' + keyPattern + '\\s*:?\\s*\\[([\\s\\S]*?)\\]\\.join', 'gm');
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[2];
    return out;
}
const stageBlocks = blocks(stageRegion, '([A-Za-z][\\w-]*)');
const manualBlocks = blocks(manualRegion, '([A-Za-z][\\w-]*)');

const allIds = (text) => {
    const set = new Set();
    // 认两种 id：`2.2` 与 `T2.3`
    for (const m of String(text).matchAll(/\b([A-Za-z]?[0-9]+(?:\.[0-9]+)+)\b/g)) set.add(m[1]);
    return set;
};
// 认领 = 「范围:」行里的编号。前置/背景里提到别的任务号不算认领，否则矩阵会假闭合。
// 有「范围：」行就只认它；没有就退化为全文扫描 —— 但那会把前置/背景里提到的任务号
// 也算成认领（假闭合）。所以退化时必须报警，不能让调用方以为覆盖真闭合了。
const noScopeLine = new Set();
const claimIds = (text, name) => {
    const s = String(text);
    const scope = s.match(/范围[：:]\s*([^\n]*)/);
    if (!scope && name) noScopeLine.add(name);
    return allIds(scope ? scope[1] : s);
};

const coveredBy = {};
for (const [name, body] of Object.entries(stageBlocks))
    for (const id of claimIds(body, name)) (coveredBy[id] = coveredBy[id] || []).push('stage:' + name);
for (const [name, body] of Object.entries(manualBlocks))
    for (const id of allIds(body)) (coveredBy[id] = coveredBy[id] || []).push('manual:' + name);

// WAVES 里的全部成员 = 合法位置
const wavesBlock = wsrc.match(/const WAVES = \[([\s\S]*?)\n\];/);
const positions = new Set();
if (wavesBlock) {
    for (const m of wavesBlock[1].matchAll(/\[([^\]]*)\]/g))
        for (const s of m[1].split(',')) {
            const t = s.trim().replace(/^["']|["']$/g, '');
            if (t) positions.add(t);
        }
}

const problems = [];
const warnings = [];

// 派发契约是形状无关的硬事实（有没有超时、RULES 在不在），
// 所以要跑在形状闸门之前 —— 手写变体恰恰是最容易转圈的那一类，不能因为形状不认识就跳检。
const dcBefore = problems.length;
if (wsrc) checkDispatchContract(wsrc);
// 派发契约的问题先摘出来：形状好就并入总账一起报（一次报全），形状不认识才是唯一结论
const dcProblems = problems.splice(dcBefore);

// ── C7 / C8 · 派发契约（防止「子 agent 自己转圈」把整轮拖住）
// 实测：一次卡在自写验证脚本的假 FAIL 上 49 分钟，一次卡在不返回的 spring-boot:run 上 51 分钟。
// 两条都可预防：规则写进 worker 会读的 RULES，超时写进每次派发。
// C9 常驻命令：stage 自检里不许出现「起服务并等它」这类不会返回的动作。
// 实测事故：s3 自检写「以 test profile 启动 service 上下文」，worker 用了
// `mvn spring-boot:run`，命令本身成功了却永不退出 → bash 卡死 51 分钟。


function checkDwell(wsrc) {
    const DWELL = [
        ['spring-boot:run', /spring-boot:run/],
        ['java -jar（前台起服务）', /java\s+-jar\s/],
        ['npm start / npm run dev', /npm\s+(?:start|run\s+dev)\b/],
        ['tail -f', /tail\s+-[fF]\b/],
        ['nc -l', /\bnc\s+-l\b/],
        ['docker run / compose up（前台）', /docker\s+(?:run\b|compose\s+up\b)/],
        ['启动服务/上下文/应用', /(?:启动|起)[^。；\n]{0,6}(?:服务|service|上下文|应用)/i]
    ];
    // 扫 RULES / STAGES / GATES / DOCS 里给 worker 和 gate 看的字符串
    const zones = [];
    for (const m of wsrc.matchAll(/(?:const|let)\s+(RULES|STAGES|GATES|DOCS)\s*=\s*([\s\S]*?)\n(?:const|let|function|\/\/|$)/g)) {
        zones.push({ name: m[1], body: m[2] });
    }
    if (!zones.length) {
        console.log('  ! 未识别到 RULES/STAGES/GATES/DOCS → C9 无法验证');
        warnings.push('未识别到约束块 → 无法确认 stage 自检里没有常驻命令；请人工核对');
        return [];
    }

    const hits = [];
    for (const z of zones) {
        // 逐行看，行号才定位得准
        const lines = z.body.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // 放行：显式说明用有界执行器
            if (/run-bounded\.sh/.test(line)) continue;
            for (const [label, re] of DWELL) {
                if (re.test(line)) {
                    hits.push(`${z.name} 第 ${i + 1} 行：${label}`);
                    break;
                }
            }
        }
    }
    return hits;
}

function checkDispatchContract(wsrc) {
    console.log('\n── 派发契约 ──');

    // C7 RULES 必须含「验证预算」三族关键词
    const rulesBlk = (wsrc.match(/const\s+RULES\s*=\s*\[([\s\S]*?)\]\.join\(/) || [])[1] || '';
    if (!rulesBlk) {
        // 认不出 ≠ 违规。项目可能把约束块叫 STYLE_CONTRACT 之类，规则照样到得了 worker。
        // 但也不能装作查过了：降为警告，并要求人工确认。
        console.log('  ! 未找到名为 RULES 的约束块（可能用了项目自己的命名）→ C7 无法验证');
        warnings.push(
            '未找到 RULES 块 → 无法确认 worker 收到的约束里有「验证预算」三条。若约束块另有其名，请人工核对'
        );
    } else {
        const need = [
            ['自证验证器', /自证/],
            ['同一条验证命令最多跑 2 次', /最多跑\s*2\s*次|最多[^。\n]{0,6}2\s*次/],
            ['禁止前台常驻命令', /常驻|不会自己退出/]
        ];
        const miss = need.filter(([, re]) => !re.test(rulesBlk)).map(([n]) => n);
        if (miss.length) {
            console.log('  ✗ RULES 缺少: ' + miss.join(' / '));
            problems.push(
                `RULES 缺「验证预算」条款（${miss.join(' / ')}）→ 子 agent 没有收敛上限，会自己转圈到被人工叫停`
            );
        } else {
            console.log('  ✓ RULES 含验证预算三条（自证 / 最多 2 次 / 禁常驻）');
        }
    }

    // C9 常驻命令
    const dwell = checkDwell(wsrc);
    if (dwell.length) {
        console.log(`  ✗ ${dwell.length} 处常驻命令（不会自己返回）：`);
        for (const d of dwell) console.log('      ' + d);
        problems.push(
            `${dwell.length} 处 stage 指令要求起常驻进程（${dwell[0]}）→ worker 会卡在等 bash 返回上。改用 run-bounded.sh --until，或改成读日志`
        );
    } else {
        console.log('  ✓ 未发现常驻命令');
    }

    // C10 STAGE_KIND 必须取合法值，且每个 stage 都登记（缺省 feature，缺了就警告）
    {
        const tierBlk = (wsrc.match(/const\s+STAGE_TIMEOUT_TIER\s*=\s*\{([\s\S]*?)\};/) || [])[1] || '';
        const kindBlk = (wsrc.match(/const\s+STAGE_KIND\s*=\s*\{([\s\S]*?)\};/) || [])[1];
        const stagesBlk = (wsrc.match(/const\s+STAGES\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
        if (!tierBlk) {
            console.log('  ! 未找到 STAGE_TIMEOUT_TIER → C10 跳过');
        } else {
            const kinds = [...tierBlk.matchAll(/(\w+)\s*:\s*\d+/g)].map((m) => m[1]);
            const declared = kindBlk === undefined ? null : [...kindBlk.matchAll(/["']?([\w-]+)["']?\s*:\s*["']([\w-]+)["']/g)];
            const bad = (declared || []).filter((m) => !kinds.includes(m[2]));
            if (bad.length) {
                console.log(`  ✗ STAGE_KIND 取值非法: ${bad.map((m) => m[1] + '=' + m[2]).join(', ')}（合法: ${kinds.join('/')}）`);
                problems.push(`STAGE_KIND 有 ${bad.length} 处取值不在 STAGE_TIMEOUT_TIER 里 → 会静默退到 feature 档`);
            }
            const stageKeys = [...stagesBlk.matchAll(/^\s*["']?([\w-]+)["']?\s*:\s*\[/gm)].map((m) => m[1]);
            const undeclared = stageKeys.filter((k) => !(declared || []).some((m) => m[1] === k));
            if (stageKeys.length && undeclared.length) {
                console.log(`  ! ${undeclared.length} 个 stage 没登记 STAGE_KIND（按 feature 档）: ${undeclared.slice(0, 6).join(', ')}`);
                warnings.push(`${undeclared.length} 个 stage 未登记 STAGE_KIND → 一律按 feature 25 分钟，可能过长或过短`);
            } else if (stageKeys.length) {
                console.log(`  ✓ ${stageKeys.length} 个 stage 的 STAGE_KIND 都合法`);
            }
        }
    }

    // C8 每个派发点的选项对象必须带超时
    const MAX_TIMEOUT_MS = 25 * 60 * 1000;
    const dispatch = [];
    for (const m of wsrc.matchAll(/\bagent\s*:\s*["']/g)) {
        const start = wsrc.lastIndexOf('{', m.index);
        if (start < 0) continue;
        let depth = 0, end = -1;
        for (let i = start; i < wsrc.length; i++) {
            if (wsrc[i] === '{') depth++;
            else if (wsrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const obj = wsrc.slice(start, end + 1);
        const line = wsrc.slice(0, start).split('\n').length;
        const tm = obj.match(/(?:maxRuntimeMs|timeoutMs)\s*:\s*([^,\n}]+)/);
        let tooLong = false;
        if (tm) {
            const expr = tm[1].trim();
            // 只判字面量：STAGE_TIMEOUT_TIER 这类表达式由 C10 管
            const mm = expr.match(/^(\d+)\s*\*?\s*(\d*)\s*\*?\s*(\d*)$/);
            if (mm) {
                const v = Number(mm[1]) * (Number(mm[2]) || 1) * (Number(mm[3]) || 1);
                if (Number.isFinite(v) && v > MAX_TIMEOUT_MS) tooLong = true;
            }
        }
        dispatch.push({ line, hasTimeout: Boolean(tm), tooLong });
    }
    if (!dispatch.length) {
        console.log('  ! 未识别到派发点（可能用了自定义派发路径），C8 跳过');
        warnings.push('未识别到任何 agent: 派发点 → 无法验证超时，请人工确认每次派发都带 maxRuntimeMs');
    } else {
        const noTimeout = dispatch.filter((d) => !d.hasTimeout);
        if (noTimeout.length) {
            console.log(`  ✗ ${noTimeout.length}/${dispatch.length} 个派发点没有超时（行 ${noTimeout.map((d) => d.line).join(', ')}）`);
            problems.push(
                `${noTimeout.length} 个派发点缺 maxRuntimeMs/timeoutMs → 卡住的子 agent 不会被止损，只能等人工发现`
            );
        } else {
            console.log(`  ✓ ${dispatch.length} 个派发点都带超时`);
        }
        const tooLong = dispatch.filter((d) => d.tooLong);
        if (tooLong.length) {
            console.log(`  ✗ ${tooLong.length} 个派发点超时字面量 > 25 分钟（行 ${tooLong.map((d) => d.line).join(', ')}）`);
            problems.push(
                `${tooLong.length} 个派发点写了 > 25 分钟的超时字面量 → 卡住一次的代价不可接受。按 STAGE_TIMEOUT_TIER 取档位`
            );
        }
    }
}

// ── 形状闸门：不认识的形状一律拒绝出结论。
// 手写变体（const TASK / 模板字符串 / 对象而非数组）解析不到 stageBlocks，
// 那时若继续跑覆盖逻辑，会报「N 个单元无人认领」这种**假结论**——比没有结论更危险。
const shapeOk = wavesBlock && Object.keys(stageBlocks).length > 0;
if (!shapeOk && dcProblems.length) {
    console.error('');
    console.error('✗ 派发契约不达标（与文件形状无关，确定的事实）：');
    for (const p of dcProblems) console.error('  - ' + p);
    console.error('');
    console.error('  （覆盖矩阵未判：本文件不是模板形状，需人工核）');
    process.exit(1);
}
if (!shapeOk) {
    console.error('✗ 无法解析此文件的结构，不做覆盖判断，也不出结论。');
    console.error('');
    console.error('  本工具只认模板形状：');
    console.error('    const WAVES = [ ["s1"], ["M1"], ... ];');
    console.error('    const STAGES = { <key>: [ "..." ].join("\\n") };');
    console.error('    const MANUAL = { <key>: [ "..." ].join("\\n") };');
    console.error('');
    console.error(`  实际读到：WAVES ${wavesBlock ? '有' : '无'}；STAGES 块 ${Object.keys(stageBlocks).length} 个；MANUAL 块 ${Object.keys(manualBlocks).length} 个`);
    console.error('');
    console.error('  → 手写变体不受支持。请人工核覆盖，不要据本工具的结论派发。');
    process.exit(2);
}
problems.push(...dcProblems);


// ── A · 任务级矩阵
const todo = tasks.filter((t) => !t.done);
const done = tasks.filter((t) => t.done);
const known = new Set(tasks.map((t) => t.id));
const missing = [];
const outOfScope = [];
const reassigned = [];

console.log(`任务单: ${tasksFile}`);
console.log(`  ${tasks.length} 个单元  (未完成 ${todo.length} / 已完成 ${done.length})`);
if (SCOPE.size) console.log(`  本切片范围: ${[...SCOPE].join(', ')}（其余不算漏项）`);
console.log(`workflow: ${wfFile}`);
console.log(
    `  ${Object.keys(stageBlocks).length} 个 stage, ${Object.keys(manualBlocks).length} 个人工段, ${positions.size} 个合法位置\n`
);

console.log('编号   状态  认领                                       标题');
console.log('─'.repeat(96));
for (const t of tasks) {
    const claim = coveredBy[t.id] || [];
    let mark = '';
    if (!t.done && claim.length === 0) {
        if (inScope(t)) {
            mark = '  ← 漏项';
            missing.push(t);
        } else {
            mark = '  ← 本切片不覆盖（预期）';
            outOfScope.push(t);
        }
    }
    if (t.done && claim.length > 0) {
        mark = '  ← 已完成却被重新派发';
        reassigned.push(t);
    }
    const cs = claim.join(',') || '(无)';
    console.log(
        `${t.id.padEnd(6)}${(' ' + (t.done ? '[x]' : '[ ]')).padEnd(6)}${(cs.length > 41 ? cs.slice(0, 38) + '…' : cs).padEnd(43)}${t.title}${mark}`
    );
}

const ghosts = Object.keys(coveredBy).filter((id) => !known.has(id));
console.log('\n── 幽灵引用 ──');
console.log(ghosts.length ? '  ' + ghosts.map((g) => `${g} ← ${coveredBy[g].join(', ')}`).join('\n  ') : '  无');

console.log('\n── 人工段 ──');
if (!Object.keys(manualBlocks).length) console.log('  无');
for (const [name, body] of Object.entries(manualBlocks)) {
    const ids = [...allIds(body)];
    console.log(`  ${name}: ${ids.length ? ids.join(', ') : '(未关联任务号 ← 在段内写出它完成的任务编号)'}`);
}

if (missing.length) problems.push(`${missing.length} 个未完成单元无人认领: ${missing.map((t) => t.id).join(', ')}`);
if (reassigned.length) problems.push(`${reassigned.length} 个已完成单元被重新派发: ${reassigned.map((t) => t.id).join(', ')}`);
if (ghosts.length) problems.push(`${ghosts.length} 个幽灵引用: ${ghosts.join(', ')}`);

// ── C · 静态合规
console.log('\n── 静态合规 ──');

// C1 逐 stage 核模型分档（只比两个常量会被 per-stage 覆盖绕过）
const mw = wsrc.match(/const\s+MODEL_WORKER\s*=\s*["']([^"']+)["']/);
const mg = wsrc.match(/const\s+MODEL_GATE\s*=\s*["']([^"']+)["']/);
const m1 = wsrc.match(/const\s+MODEL\s*=\s*["']([^"']+)["']/);

// 模板提供的正门：STAGE_MODEL = { s1: "provider/id", ... }
const stageModel = {};
{
    const blk = wsrc.match(/const\s+STAGE_MODEL\s*=\s*\{([\s\S]*?)\n?\};/);
    if (blk) {
        for (const m of blk[1].matchAll(/["']?([\w-]+)["']?\s*:\s*["']([^"']+)["']/g)) stageModel[m[1]] = m[2];
    }
}
// 自造映射：形如 const HEAVY_STAGES = { s1: "p/id", ... } —— 键是 stage 名、值是 model id
const homemade = [];
for (const m of wsrc.matchAll(/const\s+(\w+)\s*=\s*\{([\s\S]*?)\};/g)) {
    const name = m[1];
    if (name === 'STAGE_MODEL') continue;
    const kv = [...m[2].matchAll(/["']?([\w-]+)["']?\s*:\s*["']([^"']+)["']/g)];
    if (kv.length && kv.every((x) => /^[A-Za-z]*\d+[A-Za-z]?$/.test(x[1]) && /[\/-]/.test(x[2]))) {
        homemade.push({ name, map: Object.fromEntries(kv.map((x) => [x[1], x[2]])) });
    }
}

if (mg && mw) {
    if (mg[1] === mw[1]) {
        console.log(`  ✗ MODEL_GATE 与 MODEL_WORKER 相同（${mg[1]}）`);
        problems.push('门禁与 worker 共用模型 → 门禁是自我确认，这是历史上门禁不收敛的头号原因');
    } else {
        console.log(`  ✓ 基础模型分档: worker=${mw[1]} / gate=${mg[1]}`);
    }

    // 逐 stage：effective worker（STAGE_MODEL 覆盖后的值）不能等于 gate
    const stageKeys = Object.keys(stageBlocks);
    const sameAsGate = [];
    for (const k of stageKeys) {
        const eff = stageModel[k] || mw[1];
        if (eff === mg[1]) sameAsGate.push(`${k}(worker=${eff})`);
    }
    if (sameAsGate.length) {
        console.log(`  ✗ 这些 stage 的 worker 与 gate 同模型: ${sameAsGate.join(', ')}`);
        problems.push(
            `STAGE_MODEL 覆盖后 worker 与 MODEL_GATE 同模型: ${sameAsGate.join(', ')} → 该 stage 的门禁是自我确认`
        );
    } else if (Object.keys(stageModel).length) {
        console.log(`  ✓ per-stage 覆盖后仍与 gate 不同: ${Object.keys(stageModel).map((k) => k + '→' + stageModel[k]).join(', ')}`);
    }

    // STAGE_MODEL 里的 key 必须是真实 stage
    const ghostSM = Object.keys(stageModel).filter((k) => !stageBlocks[k]);
    if (ghostSM.length) {
        console.log(`  ✗ STAGE_MODEL 引用了不存在的 stage: ${ghostSM.join(', ')}`);
        problems.push(`STAGE_MODEL 的 key 在 STAGES 里不存在: ${ghostSM.join(', ')}`);
    }

    // 自造映射：能被机检发现，但覆盖关系不可知 → 至少要求它不要指向 gate
    for (const h of homemade) {
        const toGate = Object.entries(h.map).filter(([, v]) => v === mg[1]).map(([k]) => k);
        const weaker = Object.entries(h.map).filter(([, v]) => v !== mg[1] && v !== mw[1]).map(([k, v]) => `${k}→${v}`);
        if (toGate.length) {
            console.log(`  ✗ 自造映射 ${h.name} 把 ${toGate.join(', ')} 的 worker 设成与 gate 同模型`);
            problems.push(
                `${h.name} 让 ${toGate.join(', ')} 的 worker 与 MODEL_GATE 同模型 → 该 stage 门禁自我确认。改用模板的 STAGE_MODEL`
            );
        } else {
            console.log(`  ! 发现自造模型映射 ${h.name}（${weaker.join(', ') || '无差异'}）—— 改用模板的 STAGE_MODEL，否则无法逐 stage 核档位`);
            warnings.push(`${h.name} 是自造映射，不是模板的 STAGE_MODEL → 逐 stage 分档无法校验，请迁移`);
        }
    }
} else if (m1 && !mg) {
    console.log(`  ✗ 只有单一 MODEL（${m1[1]}），worker 与 gate 共用`);
    problems.push('只有单一 MODEL → 门禁与 worker 同模型。拆成 MODEL_WORKER / MODEL_GATE 两个常量');
} else {
    console.log('  ? 读不到模型常量，跳过');
    warnings.push('读不到 MODEL_WORKER / MODEL_GATE，无法校验门禁模型是否与 worker 分档');
}

// C2 skill 路径必须由 REPO 拼出（不许绝对路径/软链）
const skillLine = wsrc.match(/const\s+SKILL_DIR\s*=\s*([^;\n]+);/);
if (skillLine) {
    const expr = skillLine[1].trim();
    if (/\bREPO\b/.test(expr)) {
        console.log(`  ✓ SKILL_DIR 由 REPO 拼出: ${expr.slice(0, 60)}`);
    } else {
        console.log(`  ✗ SKILL_DIR 是硬编码路径: ${expr.slice(0, 60)}`);
        problems.push(
            'SKILL_DIR 用了绝对路径/软链 → 软链一断，所有 gate 静默读不到 gates.md（读不到判据不报错，只会自由发挥）'
        );
    }
} else {
    console.log('  ? 没有 SKILL_DIR，跳过');
    warnings.push('没有 SKILL_DIR 常量，无法校验 gates.md 引用路径是否稳定');
}

// C3 WAVES ↔ STAGES / MANUAL 必须双向对得上
{
    const isM = (n) => n.charAt(0) === 'M';
    const bad = [];
    for (const p of positions) {
        if (isM(p)) {
            if (!(p in manualBlocks)) bad.push(`${p} 在 WAVES 里但没有 MANUAL 定义`);
        } else if (!(p in stageBlocks)) bad.push(`${p} 在 WAVES 里但没有 STAGES 定义`);
    }
    for (const k of Object.keys(stageBlocks)) if (!positions.has(k)) bad.push(`STAGES.${k} 不在 WAVES 里`);
    for (const k of Object.keys(manualBlocks)) if (!positions.has(k)) bad.push(`MANUAL.${k} 不在 WAVES 里`);
    if (bad.length) {
        console.log('  ✗ 位置对不上:');
        for (const b of bad) console.log('      ' + b);
        problems.push(`WAVES 与 STAGES/MANUAL 有 ${bad.length} 处对不上`);
    } else {
        console.log(`  ✓ WAVES ↔ STAGES/MANUAL 双向一致（${positions.size} 个位置）`);
    }

    // C4 验证型 stage 的 GATES 必须核制品新鲜度
    const verifyStages = [];
    for (const [name, body] of Object.entries(stageBlocks)) {
        const scopeLine = (body.match(/授权范围[：:]\s*([^\n]*)/) || [])[1] || '';
        if (/无写集|验证型/.test(scopeLine)) verifyStages.push(name);
    }
    if (verifyStages.length) {
        const gatesText = region('GATES', 'MANUAL');
        const staleOk = /制品|install|安装|mtime|快照|SNAPSHOT|版本号|哈希/;
        const bad = [];
        for (const v of verifyStages) {
            // 跨 `+` 续行：从 <key>: 捕到下一条 key 或收尾的 };
            const gm = new RegExp('^\\s*' + v + '\\s*:\\s*([\\s\\S]*?)(?=\\n\\s{4}[A-Za-z][\\w-]*\\s*:|\\n\\};)', 'm').exec(gatesText);
            const gt = gm ? gm[1] : '';
            if (!gt || !staleOk.test(gt)) bad.push(v);
        }
        if (bad.length) {
            console.log(`  ! 验证型 stage 未核制品新鲜度: ${bad.join(', ')}（非阻断）`);
            warnings.push(
                `验证型 stage [${bad.join(', ')}] 的 GATES 没提制品/快照/版本号 → 下游测试绿可能只是在测旧代码。核法：mtime / 版本号 / 哈希 与上游那一步对得上`
            );
        } else {
            console.log(`  ✓ 验证型 stage 都核制品新鲜度（${verifyStages.join(', ')}）`);
        }
    }

    // C4b 模型可用性：MODEL_* 不得命中画像第 10 项标记为不可用的 id
    if (profileFile) {
        const psrc = read(profileFile);
        const sec10 = psrc.split(/^## 10 · /m)[1] || '';
        const bad = new Set();
        for (const line of sec10.split('\n')) {
            if (!/不可用|下线|限流|停用|deprecated/i.test(line)) continue;
            for (const m of line.matchAll(/`([A-Za-z0-9][\w.\/-]*)`/g)) {
                const id = m[1];
                if (/[\/-]/.test(id) || /^\w+-\d/.test(id)) bad.add(id);
            }
        }
        const used = [mw && mw[1], mg && mg[1], m1 && m1[1]].filter(Boolean);
        const hit = used.filter((u) => [...bad].some((b) => u.includes(b) || b.includes(u)));
        if (!sec10) {
            console.log('  ? 画像没有第 10 节（可用模型），跳过可用性核对');
            warnings.push('画像缺第 10 节「可用模型」→ 无法在派发前发现模型下线');
        } else if (hit.length) {
            console.log(`  ✗ 用了画像标记为不可用的模型: ${hit.join(', ')}`);
            problems.push(`MODEL_* 命中画像第 10 项的不可用清单: ${hit.join(', ')} → 派发后才炸，白烧一轮`);
        } else {
            console.log(`  ✓ 模型可用性：${used.join(' / ')} 均不在不可用清单（${bad.size ? [...bad].join(', ') : '清单为空'}）`);
        }
    }

    // C6 同层同仓 / 并发上限（硬规则 3 是 skill 自认最贵的翻车形态，不该推给冷审）
    {
        // 授权范围里写的是常量名（BC/AUTH/…），先把 `const X = REPO + "/path"` 建成表
        const constPaths = { REPO: '' };
        for (const m of wsrc.matchAll(/const\s+(\w+)\s*=\s*REPO\s*\+\s*"([^"]*)"/g)) constPaths[m[1]] = m[2];
        for (const m of wsrc.matchAll(/const\s+(\w+)\s*=\s*REPO\s*;/g)) constPaths[m[1]] = '';

        const repoRoot = (p) => {
            const parts = String(p).split('/').filter(Boolean);
            if (parts.length >= 2 && ['ops', 'tsp', 'app'].includes(parts[0])) return parts[0] + '/' + parts[1];
            return parts[0] || '(根仓)';
        };
        const rootsOf = (stageName) => {
            const body = String(stageBlocks[stageName] || '');
            const line = (body.match(/授权范围[：:]\s*([^\n]*)/) || [])[1] || '';
            const out = new Set();
            // REPO 只是前缀，本身不是仓；把它算进来会让所有 stage 都落在「(根仓)」上互相撞
            for (const name of Object.keys(constPaths)) {
                if (name === 'REPO') continue;
                if (new RegExp('\\b' + name + '\\b').test(line)) out.add(repoRoot(constPaths[name]));
            }
            // 也认字面写死的子路径（ops/x、tsp/x、app/x）。不要泛化到任意首段：
            // `/src`、`/common-security` 这类是仓内模块，泛化会把它们当成不同仓 → 假冲突。
            for (const m of line.matchAll(/(?:^|[^A-Za-z0-9_.-])((?:ops|tsp|app)\/[\w.-]+)/g)) out.add(repoRoot(m[1]));
            // 一个都没解析出来 → 只能按根仓算（写不出仓根就不该并行，由硬规则兜）
            if (!out.size) out.add('(根仓)');
            return out;
        };

        // 画像 §2 的并发上限
        let concLimit = 0;
        if (profileFile) {
            const psrc = read(profileFile);
            const sec2 = psrc.split(/^## 2 · /m)[1]?.split(/^## /m)[0] || '';
            // 兼容三种写法：并发度上限 4 / 并发上限: 4 / 并发度 ≤ 4
            const cm = sec2.match(/并发(?:度)?(?:上限)?[^0-9\n]{0,8}(\d+)/);
            if (cm) concLimit = Number(cm[1]);
        }

        const layers = [];
        if (wavesBlock) {
            for (const m of wavesBlock[1].matchAll(/\[([^\]]*)\]/g)) {
                const items = m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
                if (items.length && items[0].charAt(0) !== 'M') layers.push(items);
            }
        }
        const multi = layers.filter((l) => l.length > 1);
        if (!multi.length) {
            console.log('  ✓ 无并行层（每层单成员），同仓/并发不适用');
        } else {
            const clashes = [];
            for (const l of multi) {
                const seen = new Map();
                for (const st of l) {
                    for (const r of rootsOf(st)) {
                        if (seen.has(r)) clashes.push(`同层 ${seen.get(r)} 与 ${st} 都指向 ${r}`);
                        else seen.set(r, st);
                    }
                }
            }
            const over = concLimit ? multi.filter((l) => l.length > concLimit) : [];
            if (clashes.length) {
                console.log('  ✗ 同层同仓:');
                for (const c of clashes) console.log('      ' + c);
                problems.push(`硬规则 3 违反：${clashes.join('；')} → 同层同仓会让门禁的 diff 取证互相污染`);
            } else {
                console.log(`  ✓ 并行层无同仓冲突（${multi.map((l) => l.join('+')).join(' / ')}）`);
            }
            if (over.length) {
                console.log(`  ! 同层成员数超画像并发上限 ${concLimit}: ${over.map((l) => l.join('+')).join(' / ')}`);
                warnings.push(`并行层 [${over.map((l) => l.join('+')).join(' / ')}] 超过画像 §2 的并发上限 ${concLimit}`);
            } else if (concLimit) {
                console.log(`  ✓ 并发未超上限 ${concLimit}`);
            } else {
                console.log('  ? 画像 §2 没写并发上限，跳过并发核对');
            }
        }
    }

    // C5 编号连续性（非阻断，但意味着有过删除）
    const nums = [...positions]
        .filter((p) => !isM(p))
        .map((p) => (p.match(/^[A-Za-z]*(\d+)/) || [])[1])
        .filter(Boolean)
        .map(Number);
    if (nums.length) {
        const max = Math.max(...nums);
        const have = new Set(nums);
        const gaps = [];
        for (let i = 1; i <= max; i++) if (!have.has(i)) gaps.push('s' + i);
        if (gaps.length) {
            console.log(`  ! 编号跳号: ${gaps.join(', ')}（非阻断）`);
            warnings.push(
                `stage 编号跳号 ${gaps.join(', ')} → 意味着有过删除；覆盖矩阵仍闭合不能证明被删 stage 的工作没一起消失，请人工确认`
            );
        } else {
            console.log(`  ✓ 编号连续（1–${max}）`);
        }
    }
}

// ── B · 动作级覆盖
if (actionsFile) {
    const asrc = read(actionsFile);
    const actions = [];
    for (const line of asrc.split('\n')) {
        const m = line.match(/^\s*-\s*([A-Za-z]?[0-9]+(?:\.[0-9]+)+)\s*\|\s*([^|]+?)\s*\|\s*(\S*)\s*$/);
        if (m) actions.push({ task: m[1], act: m[2], pos: m[3] });
    }
    console.log(`\n── 动作归属表 (${actionsFile}) ──`);
    if (!actions.length) {
        problems.push('动作归属表解析不到任何行（格式应为 `- <任务号> | <动作> | <位置>`）');
    } else {
        for (const a of actions) {
            const bad = [];
            if (!known.has(a.task)) bad.push('任务号不存在');
            if (!a.pos) bad.push('位置为空 ← 缺口，不许留空');
            else if (positions.size && !positions.has(a.pos)) bad.push(`位置 ${a.pos} 在 WAVES 里不存在`);
            const an = a.act.length > 26 ? a.act.slice(0, 25) + '…' : a.act;
            console.log(`  ${a.task.padEnd(6)}${an.padEnd(28)}${(a.pos || '(空)').padEnd(7)}${bad.length ? ' ← ' + bad.join('；') : ''}`);
            if (bad.length) problems.push(`动作「${a.task} ${a.act}」: ${bad.join('；')}`);
        }

        // 扫任务单里的动词（来自画像第 7 节），只扫 in-scope
        if (profileFile) {
            const psrc = read(profileFile);
            const sec = psrc.split(/^## 7 · /m)[1] || '';
            const verbs = [];
            for (const line of sec.split('\n')) {
                const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(人工|等待|验证)\s*\|/);
                if (!m) continue;
                for (const v of m[1].split('/')) {
                    const t = v.trim();
                    if (t && !/^<.*>$/.test(t))
                        verbs.push({ verb: t, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*N\s*/, '\\s*\\d+\\s*')) });
                }
            }
            console.log(`\n── 扫任务单动词 (${verbs.length} 个，来自画像第 7 节${SCOPE.size ? '，仅本切片' : ''}) ──`);
            let hits = 0;
            for (const t of tasks) {
                if (!inScope(t)) continue;
                const blockM = tsrc.match(
                    new RegExp('^\\s*-\\s*\\[[ xX]\\]\\s*' + t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?=^\\s*-\\s*\\[[ xX]\\]|^## |\\Z)', 'm')
                );
                const block = blockM ? blockM[0] : '';
                const found = [];
                for (const v of verbs) if (v.re.test(block)) found.push(v.verb);
                if (!found.length) continue;
                hits++;
                const declared = actions.filter((a) => a.task === t.id).map((a) => a.act);
                const absent = found.filter((verb) => !declared.some((d) => d.includes(verb) || verb.includes(d)));
                console.log(`  ${t.id}: 命中 [${found.join(', ')}]${absent.length ? '  ← 未见归属行: ' + absent.join(', ') : '  ✓ 均有归属行'}`);
                if (absent.length) problems.push(`任务 ${t.id} 提到 [${absent.join(', ')}]，但动作归属表里没有对应行`);
            }
            if (!hits) console.log('  本切片内没有命中任何人工/等待动词。');
        }
    }
}

if (noScopeLine.size) {
    console.log('\n── 认领范围不可判定 ──');
    console.log('  这些 stage 没有「范围：」行，已退化为全文扫描 → 前置里提到的任务号也会被算成认领（可能假闭合）：');
    for (const n of noScopeLine) console.log('    ' + n);
    warnings.push(`stage [${[...noScopeLine].join(', ')}] 缺「范围：」行 → 认领范围不可判定，覆盖矩阵可能假闭合`);
}

// ── progress.md 格式检查（只查格式，不做语义对账）
if (actionsFile) {
    const dir = path.dirname(tasksFile);
    const progPath = path.join(dir, 'progress.md');
    if (!fs.existsSync(progPath)) {
        console.log('\n── 台账 ──');
        console.log('  无 progress.md（本切片尚未派发，正常）');
    } else {
        const raw = fs.readFileSync(progPath, 'utf8').split('\n');
        // 只校验**数据行**：跳过标题/引用/空行、表头、分隔行
        const rows = raw.filter((l) => {
            const t = l.trim();
            if (!t || /^[#>]/.test(t)) return false;
            if (!t.startsWith('|')) return true; // 不以 | 开头的非标题行：当成需要校验的行
            const cells = t.split('|').map((x) => x.trim());
            if (cells.length < 4) return true;
            if (/^[-: ]+$/.test(cells[1])) return false;                 // 分隔行
            if (/stage/i.test(cells[2]) || /结果/.test(cells[3])) return false; // 表头
            return true;
        });
        const bad = rows.filter((l) => {
            const t = l.trim();
            if (!t.startsWith('|')) return true;
            const cells = t.split('|').map((x) => x.trim()).filter(Boolean);
            if (cells.length < 4) return true;
            const isManual = /^M\d+$/.test(cells[1]);
            const okResult = /^(PASS|FAIL)\s*r\d+/.test(cells[2]) || (isManual && /^(✅|❌)/.test(cells[2]));
            return !okResult;
        });
        const lines = rows;
        console.log('\n── 台账 ──');
        if (bad.length) {
            console.log(`  ✗ progress.md 有 ${bad.length} 行格式不符（应为 4 列表格：时刻 | stage/段 | 结果 | 备注）：`);
            for (const b of bad.slice(0, 5)) console.log('      ' + b.slice(0, 60));
            problems.push(`progress.md 有 ${bad.length} 行格式不符 → 台账解析不了，无法与 tasks.md 对账`);
        } else {
            console.log(`  ✓ progress.md 格式正确（${lines.length} 条记录）`);
        }
    }
}

// ── 结论
console.log('\n' + '─'.repeat(96));
if (outOfScope.length) {
    console.log(`i 本切片不覆盖（预期，非缺陷）: ${outOfScope.map((t) => t.id).join(', ')}`);
}
if (warnings.length) {
    console.log('\n! 警告（非阻断）:');
    for (const w of warnings) console.log('  - ' + w);
}
if (problems.length) {
    console.log('\n✗ 覆盖/合规有问题:');
    for (const p of problems) console.log('  - ' + p);
    console.log('\n  机械层查不了「认领了但验收错位 / 门禁含糊 / 规格漏项」——那些靠冷审（Step 4 第四关）。');
    process.exit(1);
}
console.log('\n✓ 覆盖闭合 + 静态合规：任务级与动作级都有归属，位置真实存在，模型分档，路径稳定。');
console.log('  下一步（语义层）: 冷审查规格漏项 / 验收错位 / 门禁含糊 —— 见 SKILL.md Step 4 第四关。');
