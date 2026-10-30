// selftest.mjs —— plan-to-workflow 自身的回归套件
//
// 用法:
//   node selftest.mjs                                  # 只跑自检（不需要真实 change）
//   node selftest.mjs <change 目录>                     # 额外跑真实 artifact 的干跑 + 覆盖
//
// 为什么需要它：这套 skill 的规则散在 4 个文件的 6 个位置，靠人记住「谁读哪本」。
// 每次改一条规则，都要确认 ① 它落到了正确的规则本 ② 机检还能拦住该拦的 ③ 不误伤真实文件。
// 手动做这件事每次要十几步，所以固化成脚本。
//
// 退出码: 0 全过 / 1 有失败

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ptw-selftest-'));
const CHANGE = process.argv[2] || '';

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fails.push(name + (detail ? ` — ${detail}` : ''));
        console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    }
};

// 跑任意可执行文件（run-bounded.sh 这类不是 node 脚本）
const sh = (file, args, extra = {}) => {
    try {
        const out = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
};

const run = (file, args) => {
    try {
        const out = execFileSync('node', [file, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
};

// ── fixture 生成器
function fixture(name, opt = {}) {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    const waves = opt.waves || [['s1']];
    const stages = opt.stages || { s1: '范围：tasks.md 1.1 改造' };
    const gates = opt.gates || { s1: '①diff 仅含预期改动' };
    const manuals = opt.manuals || {};
    const mw = opt.mw || 'p/pro-a';
    const mg = opt.mg === undefined ? 'p/flash-b' : opt.mg;
    const skillDir = opt.skillDir || 'REPO_EXPR';

    const js = [
        'const REPO = ' + JSON.stringify(dir) + ';',
        'const SKILL_DIR = ' + (skillDir === 'REPO_EXPR' ? 'REPO + "/.agents/skills/plan-to-workflow"' : JSON.stringify(skillDir)) + ';',
        'const MODEL_WORKER = ' + JSON.stringify(mw) + ';',
        mg === null ? '' : 'const MODEL_GATE = ' + JSON.stringify(mg) + ';',
        'const MAX_ROUNDS = 2;',
        'const WAVES = [',
        ...waves.map((w) => '    [' + w.map((x) => JSON.stringify(x)).join(', ') + '],'),
        '];',
        'const STAGES = {',
        ...Object.entries(stages).map(
            ([k, v]) => '    ' + k + ': [' + v.split('|').map((x) => JSON.stringify(x)).join(', ') + '].join("\\n"),'
        ),
        '};',
        'const GATES = {',
        ...Object.entries(gates).map(([k, v]) => '    ' + k + ': ' + JSON.stringify(v) + ','),
        '};',
        'const MANUAL = {',
        ...Object.entries(manuals).map(
            ([k, v]) => '    ' + k + ': [' + v.split('|').map((x) => JSON.stringify(x)).join(', ') + '].join("\\n"),'
        ),
        '};',
        // RULES 块：默认不写（旧用例靠这条走「未识别 → 警告」分支）
        opt.rules === 'full'
            ? 'const RULES = ["自证验证器：先用已知 PASS 的样本跑一次", "同一条验证命令最多跑 2 次", "禁止前台常驻命令"].join("\\n");'
            : opt.rules === 'partial'
              ? 'const RULES = ["自证验证器：先用已知 PASS 的样本跑一次"].join("\\n");'
              : '',
        // 派发点：验 C8 是否要求超时
        opt.dispatch === 'timeout'
            ? 'const SPEC = [{ key: "x", agent: "worker", model: MODEL_WORKER, maxRuntimeMs: 60000, task: "t" }];'
            : opt.dispatch === 'no-timeout'
              ? 'const SPEC = [{ key: "x", agent: "worker", model: MODEL_WORKER, task: "t" }];'
              : ''
    ]
        .filter(Boolean)
        .join('\n');
    // 真实产物是「模板 + 填内容」，所以一定带模板解析器块；fixture 也带上，
    // 否则 C11 会把每个 fixture 都当成「自定义解析器」。
    const tplSrc = fs.readFileSync(path.join(HERE, 'workflow.template.js'), 'utf8');
    const pa = tplSrc.indexOf('function lastDecl(');
    const pb = tplSrc.indexOf("return zhVerdict(out) || 'UNKNOWN';");
    const parser = pa >= 0 && pb > pa ? tplSrc.slice(pa, tplSrc.indexOf('\n};', pb) + 3) : '';
    fs.writeFileSync(path.join(dir, 'wf.js'), js + '\n' + parser + '\n');
    fs.writeFileSync(path.join(dir, 'tasks.md'), opt.tasks || '- [ ] 1.1 造个东西\n');
    if (opt.profile) fs.writeFileSync(path.join(dir, 'profile.md'), opt.profile);
    return dir;
}

// 参数位置是 <tasks> <wf> [actions] [profile] —— 跳过 actions 直接传 profile 会串位，
// 所以需要 profile 时补一个合法的 actions.md。
const cov = (dir, withProfile) => {
    const args = [path.join(dir, 'tasks.md'), path.join(dir, 'wf.js')];
    if (withProfile) {
        fs.writeFileSync(path.join(dir, 'actions.md'), '- 1.1 | 改造 | s1\n');
        args.push(path.join(dir, 'actions.md'), path.join(dir, 'profile.md'));
    }
    return run(path.join(HERE, 'coverage.mjs'), args);
};

console.log('━'.repeat(72));
console.log('一 · 工具自身');
console.log('━'.repeat(72));

// T1 模板干跑
const t1 = run(path.join(HERE, 'dryrun.mjs'), [path.join(HERE, 'workflow.template.js')]);
ok('模板干跑通过', t1.code === 0, t1.code !== 0 ? t1.out.split('\n').slice(-2).join(' / ') : '');

// T2 形状闸门：不认识的形状不得出结论
{
    const d = fixture('shape', { waves: [['s1']], stages: {} });
    fs.writeFileSync(path.join(d, 'wf.js'), 'const TASK = ["范围：1.1 做点事"].join("\\n");\n');
    const r = cov(d);
    ok('形状不认时拒绝出结论（退出码 2）', r.code === 2, `实际 ${r.code}`);
    ok('且不输出「无人认领」这类假结论', !/无人认领/.test(r.out));
}

// T3 门禁同模型
{
    const r = cov(fixture('same-model', { mg: 'p/pro-a' }));
    ok('门禁与 worker 同模型被判违规', r.code === 1 && /共用模型|相同/.test(r.out));
}

// T4 模型可用性
{
    const prof = '## 10 · 可用模型\n\n| provider | model | 档位 | 备注 |\n|---|---|---|---|\n| p | `flash-b` | 快 | **已下线**，不要再用 |\n';
    const r = cov(fixture('unavailable', { mg: 'p/flash-b', profile: prof }), true);
    // fixture() 把 profile 写在 dir 里，但 cov 需要它作为第 4 参；这里直接判文案
    // 断言必须只命中「失败分支」：成功文案里有「均不在不可用清单」，用 /不可用清单/ 会两个分支都过
    const hit = /命中画像第 10 项的不可用清单/.test(r.out);
    const green = /均不在不可用清单/.test(r.out);
    ok('已下线模型被拦下', hit && !green && r.code === 1, hit ? '被拦下但退出码非 1' : '没拦住（可能是测试断言空转）');
}

// T5 验证型 stage 未核制品新鲜度
{
    const r = cov(
        fixture('stale', {
            waves: [['s1'], ['s2']],
            stages: { s1: '范围：tasks.md 1.1 改造', s2: '授权范围：无写集（只跑测试）' },
            gates: { s1: '①diff 仅含预期改动', s2: '①各仓 Tests run 真输出' }
        })
    );
    ok('验证型 stage 缺制品核对被警告', /验证型 stage 未核制品新鲜度/.test(r.out) && r.code === 0);
}

// T6 编号跳号
{
    const r = cov(
        fixture('gap', {
            waves: [['s1'], ['s3']],
            stages: { s1: '范围：tasks.md 1.1 改造', s3: '范围：tasks.md 1.1 收尾' },
            gates: { s1: '①x', s3: '①y' }
        })
    );
    ok('stage 编号跳号被警告', /跳号/.test(r.out) && r.code === 0);
}

// T7 干净 fixture 全绿
{
    const r = cov(
        fixture('clean', {
            waves: [['s1'], ['M1']],
            stages: { s1: '范围：tasks.md 1.1 改造' },
            gates: { s1: '①diff 仅含预期改动' },
            manuals: { M1: '【M1】提交 — 完成 tasks 1.1' }
        })
    );
    ok('干净 fixture 全绿', r.code === 0, r.code !== 0 ? r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / ') : '');
}

// ── 控制流行为（直接跑模板本体，模板的占位符都是合法字符串，可执行）
const TPL_SRC = fs.readFileSync(path.join(HERE, 'workflow.template.js'), 'utf8');
const runTpl = async (args, implOut) => {
    const fn = new Function('runs', 'args', 'return (async () => {' + TPL_SRC + '})()');
    const runs = {
        all: async (specs) =>
            specs.map((x) => ({
                ok: true,
                output: x.key.includes('-gate-') ? 'VERDICT: PASS' : implOut
            }))
    };
    return await fn(runs, args);
};
{
    // T8: fromStage 认层内任意成员。只认 wave[0] 时，传层内其它 stage 会静默跳过整条链。
    const r = await runTpl({ fromStage: 's3', manualDone: ['M1'] }, 'STATUS: DONE');
    const ran = [...new Set(r.progress.map((x) => x.split(' ')[0]))];
    ok('fromStage 传层内非首成员仍跑该层', ran.includes('s3') && ran.includes('s2'), '跑到: ' + JSON.stringify(ran));

    // T9: worker 引用规则原文不得被判 BLOCKED（indexOf 全文匹配的经典误判）
    const echo = '已按 RULES 完成。末尾 STATUS: DONE。若遇无法裁决则写 STATUS: BLOCKED <原因>。';
    const r2 = await runTpl(undefined, echo);
    ok('worker 复述规则原文不被误判 BLOCKED', !String(r2.reason || '').includes('实现者 BLOCKED'), String(r2.reason || '').slice(0, 50));

    // T10: 行首真 BLOCKED 仍要停
    const r3 = await runTpl(undefined, '做了一半发现矛盾。\n\nSTATUS: BLOCKED 规格与 design 冲突');
    ok('真 BLOCKED（行首）仍然停机', String(r3.reason || '').includes('实现者 BLOCKED'));
}

// T11: 自造映射把某 stage 的 worker 设成与 gate 同模型 → 必须拦住
{
    const d = fixture('homemade', { mg: 'p/gate' , mw: 'p/worker' });
    const src = fs.readFileSync(path.join(d, 'wf.js'), 'utf8') +
        '\nconst HEAVY_STAGES = { s1: "p/gate" };\n' +
        'void HEAVY_STAGES;\n';
    fs.writeFileSync(path.join(d, 'wf.js'), src);
    const r = cov(d);
    ok('自造映射造成 worker==gate 被拦住', /自造映射/.test(r.out) && r.code === 1, `code=${r.code}`);
}

// T12: 正式 STAGE_MODEL 与 gate 不同 → 通过；与 gate 相同 → 拦住
{
    const d1 = fixture('sm-ok', { mg: 'p/gate', mw: 'p/worker' });
    fs.writeFileSync(
        path.join(d1, 'wf.js'),
        fs.readFileSync(path.join(d1, 'wf.js'), 'utf8') + '\nconst STAGE_MODEL = { s1: "p/heavy" };\nvoid STAGE_MODEL;\n'
    );
    const r1 = cov(d1);
    ok('STAGE_MODEL 覆盖到不同模型 → 通过', r1.code === 0, r1.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    const d2 = fixture('sm-bad', { mg: 'p/gate', mw: 'p/worker' });
    fs.writeFileSync(
        path.join(d2, 'wf.js'),
        fs.readFileSync(path.join(d2, 'wf.js'), 'utf8') + '\nconst STAGE_MODEL = { s1: "p/gate" };\nvoid STAGE_MODEL;\n'
    );
    const r2 = cov(d2);
    ok('STAGE_MODEL 覆盖到与 gate 同模型 → 拦住', /同模型/.test(r2.out) && r2.code === 1);
}

// T13: 同层同仓 → 拦住；同层不同仓 → 通过
{
    const mk = (name, authA, authB) =>
        fixture(name, {
            waves: [['s1', 's2']],
            stages: { s1: '范围：tasks.md 1.1 a|授权范围：' + authA, s2: '范围：tasks.md 1.1 b|授权范围：' + authB },
            gates: { s1: '①x', s2: '①y' }
        });
    const rSame = cov(mk('same-repo', 'REPO/ops/usc/**', 'REPO/ops/usc/other/**'));
    ok('同层同仓被判违反硬规则 3', /同层同仓/.test(rSame.out) && rSame.code === 1);
    const rDiff = cov(mk('diff-repo', 'REPO/ops/usc/**', 'REPO/tsp/dispatch/**'));
    ok('同层不同仓通过', rDiff.code === 0, rDiff.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
}

// T15: progress.md 表格格式（表头/分隔行要跳过，坏行要拦住）
{
    const d = fixture('prog-ok', {});
    fs.writeFileSync(
        path.join(d, 'actions.md'),
        '- 1.1 | 改造 | s1\n'
    );
    fs.writeFileSync(
        path.join(d, 'progress.md'),
        '# Progress\n\n> 说明\n\n| 时刻 | stage / 段 | 结果 | 备注 |\n|---|---|---|---|\n| t1 | s1 | PASS r1 | ok |\n| t2 | M1 | ✅ 完成 | 人工 |\n'
    );
    // 台账检查挂在 actions.md 分支下，必须显式传它
    const run3 = () =>
        run(path.join(HERE, 'coverage.mjs'), [
            path.join(d, 'tasks.md'),
            path.join(d, 'wf.js'),
            path.join(d, 'actions.md')
        ]);
    const r = run3();
    ok('progress.md 标准表格格式通过', r.code === 0, r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    fs.appendFileSync(path.join(d, 'progress.md'), '| t3 | s2 | 搞定了 | 坏行 |\n');
    const r2 = run3();
    ok('progress.md 结果列不合规被拦住', /格式不符/.test(r2.out) && r2.code === 1);
}

// ── T17 verdict 解析：直接从模板里抠出解析器本体来测（不是复写一份）
{
    const src = fs.readFileSync(path.join(SKILL, 'templates', 'workflow.template.js'), 'utf8');
    const a = src.indexOf('function lastDecl(');
    const b = src.indexOf("return zhVerdict(out) || 'UNKNOWN';");
    ok('能定位模板里的解析器块', a > 0 && b > a);
    let P = null;
    if (a > 0 && b > a) {
        const end = src.indexOf('\n};', b) + 3;
        const block = src.slice(a, end);
        P = new Function(block + '\nreturn { verdictOf, isBlocked, lastDecl };')();
    }
    if (P) {
        const cases = [
            ['VERDICT: PASS', 'PASS', '英文 VERDICT'],
            ['- 结论：通过', 'PASS', '行首中文（真实事故形态）'],
            ['判定：不通过', 'FAIL', '行首中文 FAIL'],
            ['门禁结论：需裁决', 'BLOCKED', '行首中文 BLOCKED'],
            ['门禁通过了，但…', 'UNKNOWN', '中文不在行首 → 不认（避免句中误判）'],
            ['VERDICT: PASS\nRESULT_JSON: {"verdict":"FAIL"}', 'FAIL', 'RESULT_JSON 优先于 VERDICT'],
            ['VERDICT: PASS\nRESULT_JSON: {坏 JSON}', 'PASS', '非法 JSON 回退到 VERDICT'],
            ['没人写裁决', 'UNKNOWN', '什么都没有 → UNKNOWN'],
            ['VERDICT: PASS\n\n若无法判断则写 VERDICT: FAIL\n\n谢谢', 'PASS', '行首最后一条生效'],
            ['STATUS: DONE\n正文曾引用 STATUS: BLOCKED', '', '引用不能盖过末行']
        ];
        for (const [out, want, label] of cases) {
            const got = label.startsWith('引用') ? (P.isBlocked(out) ? 'BLOCKED' : '') : P.verdictOf(out);
            ok(`verdict 解析：${label}`, got === want, `got=${got} want=${want}`);
        }
        // 真实 fixture：reviewer 写「结论：通过」
        const inc = path.join(SKILL, 'fixtures', 'incidents', '2026-10-29-alert-center');
        const f1 = path.join(inc, 'verdict-zh.txt');
        if (fs.existsSync(f1)) {
            ok('真实件 verdict-zh.txt 判为 PASS', P.verdictOf(fs.readFileSync(f1, 'utf8')) === 'PASS');
        }
        const f2 = path.join(inc, 'verdict-quote.txt');
        if (fs.existsSync(f2)) {
            const t = fs.readFileSync(f2, 'utf8');
            ok('真实件 verdict-quote.txt：正文引用 BLOCKED 不算本次结论',
                P.isBlocked(t) === false && P.lastDecl(t, 'STATUS') === 'DONE',
                `isBlocked=${P.isBlocked(t)} lastDecl=${P.lastDecl(t, 'STATUS')}`);
        }
    }
}

// ── T18 有界执行器：run-bounded.sh
{
    const BIN = path.join(HERE, 'bin', 'run-bounded.sh');
    ok('run-bounded.sh 存在且可执行', fs.existsSync(BIN) && (fs.statSync(BIN).mode & 0o111) !== 0);

    if (fs.existsSync(BIN)) {
        // 1) 正常结束 → 0
        const r1 = sh('bash', [BIN, '5', '--', 'true']);
        ok('run-bounded 正常结束返回 0', r1.code === 0, `code=${r1.code}`);

        // 2) 超时 → 124，且 sleep 已被杀
        const pidFile = path.join(TMP, 'sleep.pid');
        const t0 = Date.now();
        const r2 = sh('bash', [BIN, '2', '--', 'bash', '-c', `echo $$ > ${pidFile}; sleep 30`]);
        const el = Date.now() - t0;
        ok('run-bounded 超时返回 124', r2.code === 124, `code=${r2.code}`);
        ok('run-bounded 到点就杀（不等满 30s）', el < 12000, `${el}ms`);
        const pid = (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '').trim();
        let alive = true;
        try { process.kill(Number(pid), 0); } catch { alive = false; }
        ok('run-bounded 超时后子进程真的没了', pid !== '' && !alive, `pid=${pid} alive=${alive}`);

        // 3) --until 命中 → 0，且子进程被杀
        const logf = path.join(TMP, 'svc.log');
        const pidFile2 = path.join(TMP, 'svc.pid');
        if (fs.existsSync(logf)) fs.unlinkSync(logf);
        const r3 = sh('bash', [
            BIN, '20', '--until', 'READY', '--log', logf, '--',
            // 真实形态：服务自己往日志文件里写，--until 读的是那个文件
            'bash', '-c', `echo $$ > ${pidFile2}; echo booting >> ${logf}; sleep 1; echo READY >> ${logf}; sleep 30`
        ]);
        ok('run-bounded --until 命中返回 0', r3.code === 0, `code=${r3.code} out=${r3.out.slice(0, 80)}`);
        const pid2 = (fs.existsSync(pidFile2) ? fs.readFileSync(pidFile2, 'utf8') : '').trim();
        let alive2 = true;
        try { process.kill(Number(pid2), 0); } catch { alive2 = false; }
        ok('run-bounded --until 命中后子进程被杀', pid2 !== '' && !alive2, `pid=${pid2} alive=${alive2}`);

        // 4) 整个进程组一起杀（孙进程也不能留）
        const pidDir = path.join(TMP, 'pgpids');
        fs.mkdirSync(pidDir, { recursive: true });
        const r4 = sh('bash', [
            BIN, '2', '--',
            'bash', '-c', `echo $$ > ${pidDir}/a; ( echo $$ > ${pidDir}/b; sleep 30 ) & sleep 30`
        ]);
        ok('run-bounded 超时（进程组）返回 124', r4.code === 124, `code=${r4.code}`);
        let aliveCount = 0;
        for (const f of fs.readdirSync(pidDir)) {
            const q = fs.readFileSync(path.join(pidDir, f), 'utf8').trim();
            try { process.kill(Number(q), 0); aliveCount++; } catch { /* dead */ }
        }
        ok('run-bounded 杀掉整个进程组（含孙进程）', aliveCount === 0, `still alive: ${aliveCount}`);
    }
}

// ── T19 C9：常驻命令必须被拦住
{
    const bad = fixture('c9-bad', {
        rules: 'full',
        dispatch: 'timeout',
        stages: { s1: '范围：tasks.md 1.1 改造|自检：以 test profile 启动 service 上下文并记录结果' }
    });
    const r = cov(bad, false);
    ok('C9 拦住「启动 service 上下文」', r.code === 1 && /常驻|run-bounded/.test(r.out),
        `code=${r.code} ` + r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    const bad2 = fixture('c9-bad2', {
        rules: 'full',
        dispatch: 'timeout',
        stages: { s1: '范围：tasks.md 1.1 改造|自检：mvn spring-boot:run 后看日志' }
    });
    const r2 = cov(bad2, false);
    ok('C9 拦住 spring-boot:run', r2.code === 1 && /spring-boot:run/.test(r2.out),
        `code=${r2.code}`);

    // 真实事故原文：s3 的自检语句（逐字）
    const inc = path.join(SKILL, 'fixtures', 'incidents', '2026-10-29-alert-center', 's3-stage.txt');
    if (fs.existsSync(inc)) {
        const s3 = fs.readFileSync(inc, 'utf8').trim();
        const d = fixture('c9-incident', {
            rules: 'full', dispatch: 'timeout',
            stages: { s1: '范围：tasks.md 1.1 改造|' + s3 }
        });
        const rr = cov(d, false);
        ok('C9 拦住真实事故原文（s3-stage.txt）', rr.code === 1 && /常驻进程/.test(rr.out),
            rr.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

        // 同一句改成有界写法就该放行
        const d2 = fixture('c9-incident-fixed', {
            rules: 'full', dispatch: 'timeout',
            stages: { s1: '范围：tasks.md 1.1 改造|自检：用 run-bounded.sh 60 --until "Started .*Application" --log app.log -- mvn spring-boot:run' }
        });
        const rr2 = cov(d2, false);
        ok('C9 放行真实事故的有界改法', rr2.code === 0,
            rr2.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
    }

    const good = fixture('c9-good', {
        rules: 'full',
        dispatch: 'timeout',
        stages: { s1: '范围：tasks.md 1.1 改造|自检：使用 run-bounded.sh --until READY -- ./start.sh 证明能启动' }
    });
    const r3 = cov(good, false);
    ok('C9 放行 run-bounded.sh 的写法', r3.code === 0,
        `code=${r3.code} ` + r3.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
}

// T15b: 形状闸门之前也要跑派发契约 —— 手写变体恰是最容易转圈的那一类
{
    const d = fixture('handwritten', {});
    // 把 wf.js 改成手写变体：无 WAVES/STAGES，但有一个没超时的派发点
    fs.writeFileSync(
        path.join(d, 'wf.js'),
        'const REPO = ' + JSON.stringify(d) + ';\n' +
        'const TASKS = [{ id: "0.1", title: "x" }];\n' +
        'const SPEC = [{ key: "a", agent: "worker", task: "t" }];\n'
    );
    const r = cov(d, false);
    // 手写变体走 PARTIAL（exit 2）：形状无关的问题照报，但覆盖矩阵不判
    ok('手写变体走 PARTIAL 且照报派发超时',
        r.code === 2 && /PARTIAL/.test(r.out) && /缺 maxRuntimeMs/.test(r.out),
        `code=${r.code} ` + r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
    ok('手写变体缺解析器被判 C11', /解析器块缺失/.test(r.out));
}

// T20 C10：STAGE_KIND 取值与登记
{
    const d = fixture('kind-bad', { rules: 'full', dispatch: 'timeout' });
    fs.appendFileSync(path.join(d, 'wf.js'),
        '\nconst STAGE_TIMEOUT_TIER = { skeleton: 10, feature: 25 };\nconst STAGE_KIND = { s1: "skelton" };\n');
    const r = cov(d, false);
    ok('C10 拦住非法 STAGE_KIND 取值', r.code === 1 && /STAGE_KIND 取值非法/.test(r.out),
        r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    const d2 = fixture('kind-missing', { rules: 'full', dispatch: 'timeout' });
    fs.appendFileSync(path.join(d2, 'wf.js'),
        '\nconst STAGE_TIMEOUT_TIER = { skeleton: 10, feature: 25 };\nconst STAGE_KIND = { };\n');
    const r2 = cov(d2, false);
    ok('C10 未登记的 stage 只警告不阻断', r2.code === 0 && /没登记 STAGE_KIND/.test(r2.out),
        `code=${r2.code}`);
}

// T21 C8：硬编码超时 > 25 分钟要拦（分档的意义就在于不许随手写大数）
{
    const d = fixture('tmo-long', { rules: 'full', dispatch: 'timeout' });
    fs.appendFileSync(path.join(d, 'wf.js'),
        '\nconst SPEC2 = [{ key: "y", agent: "worker", model: MODEL_WORKER, maxRuntimeMs: 90 * 60 * 1000, task: "t" }];\n');
    const r = cov(d, false);
    ok('C8 拦住 > 25 分钟的超时字面量', r.code === 1 && /25 分钟的超时字面量/.test(r.out),
        r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
}

// T16: 派发契约 —— RULES 缺「验证预算」要拦住（子 agent 转圈的根因）
{
    const d = fixture('rules-partial', { rules: 'partial', dispatch: 'timeout' });
    const r = cov(d, false);
    ok('RULES 缺验证预算条款被拦住', /验证预算/.test(r.out) && r.code === 1,
        r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    const d2 = fixture('rules-full', { rules: 'full', dispatch: 'timeout' });
    const r2 = cov(d2, false);
    ok('RULES 含三条时通过', r2.code === 0 && /含验证预算三条/.test(r2.out),
        r2.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
}

// T17: 派发点缺超时要拦住（实测卡住 51 分钟那次就是因为没有止损）
{
    const d = fixture('disp-none', { rules: 'full', dispatch: 'no-timeout' });
    const r = cov(d, false);
    ok('派发点缺 maxRuntimeMs 被拦住', /缺 maxRuntimeMs/.test(r.out) && r.code === 1,
        r.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));

    const d2 = fixture('disp-ok', { rules: 'full', dispatch: 'timeout' });
    const r2 = cov(d2, false);
    ok('派发点带超时时通过', r2.code === 0 && /个派发点都带超时/.test(r2.out),
        r2.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / '));
}

// T14: plan.md 的 scope 被自动读取（不传 --scope 也要生效）
{
    const d = fixture('plan-scope', {
        waves: [['s1'], ['s2']],
        stages: { s1: '范围：tasks.md 1.1 a', s2: '范围：tasks.md 2.2 b' },
        gates: { s1: '①x', s2: '①y' },
        tasks: '- [ ] 1.1 a\n- [ ] 2.2 b\n'
    });
    fs.writeFileSync(path.join(d, 'plan.md'), '# Plan\n\nscope: 1.1\n');
    const r = cov(d);
    ok('plan.md 的 scope 被自动读取', /本切片范围: 1\.1/.test(r.out), r.out.split('\n').filter((l) => l.includes('范围')).join(' / '));
}

console.log('\n' + '━'.repeat(72));
console.log('二 · 规则本落位');
console.log('━'.repeat(72));

const rd = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8');
const skill = rd('SKILL.md');
const gates = rd('gates.md');
const profileT = rd('profile.template.md');
const cold = rd('templates/cold-review.md');
const tplJs = rd('templates/workflow.template.js');

ok('gates.md 有「取证方式」（路径限定 diff / 累积授权）', /## 取证方式/.test(gates) && /路径限定/.test(gates));
ok('SKILL.md 有「角色 × 规则本」表', /角色 × 规则本/.test(skill));
ok('SKILL.md 有「证据可达」自查', /gate 拿得到这个证据吗/.test(skill));
ok('SKILL.md 有「幂等性」约束', /幂等性/.test(skill));
ok('profile.template.md 有第 10 项「可用模型」', /## 10 · 可用模型/.test(profileT));
ok('SKILL.md 无「九项」残留（应为十项）', !/九项/.test(skill));
ok('模板 revTask 传轮次', /revTask\(g\.stage, g\.output, round\)/.test(tplJs));
ok('模板 revTask 传授权范围', /STAGES\[stage\]/.test(tplJs));
ok('模板有异常兜底（try/catch + failure）', /catch \(e\)/.test(tplJs) && /failure: failure/.test(tplJs));
ok('模板 return 带幂等提醒', /不幂等/.test(tplJs));
ok('gates.md 规定末两行 VERDICT + RESULT_JSON', /RESULT_JSON/.test(gates) && /最后两行固定/.test(gates));
ok('RULES 要求 worker 也给 RESULT_JSON', /RESULT_JSON/.test(tplJs));
ok('模板：UNKNOWN 重派一次后按 FAIL', /unknownRetried/.test(tplJs) && /verdictStrict/.test(tplJs));
ok('coverage 有 C11 解析器哈希比对', /C11/.test(fs.readFileSync(path.join(HERE, 'coverage.mjs'), 'utf8')));
ok('SKILL.md 说明 PARTIAL 不得派发', /PARTIAL 不得据此派发/.test(skill));
ok('模板按档位取超时（STAGE_TIMEOUT_TIER + STAGE_KIND）', /STAGE_TIMEOUT_TIER/.test(tplJs) && /timeoutMsOf\(s\)/.test(tplJs) && /GATE_TIMEOUT_MS/.test(tplJs));
ok('模板超时后自动续跑一次', /resumed\[s\]/.test(tplJs) && /-resume/.test(tplJs));
ok('模板门禁超时重派一次', /gateResumed\[g\.stage\]/.test(tplJs));
ok('SKILL.md 编排表有「类型」列并解释超时分档', /\*\*类型\*\*决定/.test(skill) && /STAGE_TIMEOUT_TIER/.test(skill));
ok('模板 RULES 指向 run-bounded.sh', /run-bounded\.sh/.test(tplJs));
ok('画像第 1 项含「有界执行工具」', /有界执行工具/.test(profileT));
ok('SKILL.md 规定 stage 自检不得起常驻进程', /不得要求启动常驻进程/.test(skill));
ok('run-bounded.sh 已随 skill 分发', fs.existsSync(path.join(HERE, 'bin', 'run-bounded.sh')));
ok('模板内置派发超时（按档位）', /maxRuntimeMs: budget\.ms/.test(tplJs) && /checkpointBeforeDeadlineMs: budget\.checkpoint/.test(tplJs) && /GATE_TIMEOUT_MS/.test(tplJs));
ok('SKILL.md 记录了子 agent 自转圈的两道闸', /自证验证器/.test(skill) && /maxRuntimeMs/.test(skill));
ok('模板提供 STAGE_MODEL 正门', /const STAGE_MODEL = \{\};/.test(tplJs) && /STAGE_MODEL\[s\] \|\| MODEL_WORKER/.test(tplJs));
ok('SKILL.md 要求 plan.md 落盘', /plan\.md/.test(skill) && /scope:/.test(skill));
ok('gates.md 把本地仓指向画像而非写死 ~/.m2', /本地仓路径见画像第 1 项/.test(gates) && /不要假设它是/.test(gates));

// T9 冷审占位符必须都在填表清单里
{
    const lines = cold.split('\n');
    const tableEnd = lines.findIndex((l, i) => i > 0 && /^\|/.test(lines[i - 1]) && !/^\|/.test(l));
    const checklist = lines.slice(0, tableEnd < 0 ? lines.length : tableEnd).join('\n');
    const all = [...cold.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    const miss = [...new Set(all)].filter((k) => !checklist.includes('{{' + k + '}}'));
    ok('冷审占位符全部在填表清单里', miss.length === 0, miss.length ? '缺 ' + miss.join(', ') : '');
}

console.log('\n' + '━'.repeat(72));
console.log('三 · 真实 artifact');
console.log('━'.repeat(72));

if (!CHANGE) {
    console.log('  （未给 change 目录，跳过）');
} else {
    const dir = path.resolve(CHANGE);
    const files = fs.readdirSync(dir);
    const wfs = files.filter((f) => /^workflow.*\.js$/.test(f));
    if (!wfs.length) ok('找到 workflow 文件', false, dir);
    if (wfs.length > 1) {
        console.log(`  i 目录里有 ${wfs.length} 份 workflow 并存：${wfs.join(', ')}`);
        console.log('    按后缀配对 actions（workflow.v2.js ↔ actions.v2.md）；已被取代的请归档，否则会一直报失败');
    }
    // 按后缀配对：workflow<X>.js ↔ actions<X>.md，不能取"第一个匹配的 actions"
    const actsFor = (wf) => {
        const sfx = (wf.match(/^workflow(.*)\.js$/) || [])[1] || '';
        const cand = 'actions' + sfx + '.md';
        return files.includes(cand) ? path.join(dir, cand) : '';
    };
    const prof = path.resolve(dir, '../../..', 'docs/agent/workflow-profile.md');
    for (const wf of wfs) {
        const d = run(path.join(HERE, 'dryrun.mjs'), [path.join(dir, wf)]);
        ok(`${wf} 干跑`, d.code === 0, d.code !== 0 ? d.out.split('\n').slice(-2).join(' / ') : '');
        const args = [path.join(dir, 'tasks.md'), path.join(dir, wf)];
        const acts = actsFor(wf);
        if (acts) args.push(acts);
        if (fs.existsSync(prof) && acts) args.push(prof);
        const c = run(path.join(HERE, 'coverage.mjs'), args);
        const why = c.code !== 0 ? c.out.split('\n').filter((l) => l.startsWith('  - ')).join(' / ') : '';
        ok(`${wf} 覆盖 + 静态合规${acts ? ' (' + path.basename(acts) + ')' : ' (无配对 actions)'}`, c.code === 0, why);
    }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '━'.repeat(72));
if (fails.length) {
    console.log(`✗ ${pass} 过 / ${fails.length} 败`);
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
}
console.log(`✓ 全量回归通过（${pass} 项）`);