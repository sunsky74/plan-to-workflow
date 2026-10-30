// dryrun.mjs —— workflow 脚本的 stub 干跑器
//
// 用法:
//   node dryrun.mjs <workflow.js>
//
// 为什么需要它: `subagent({action:"validate"})` 只做静态检查，**不执行脚本**。
// 它能证明「语法能被解析」，但抓不到 ReferenceError、跳层错、人工段放行错。
// 这一关用假 runs 真执行控制流，不烧任何子 agent。
//
// 自动从脚本里读出 WAVES，为每个人工段生成一个「续跑到它」的场景，
// 再加四个固定场景：全新开跑、漏传 manualDone、门禁一直 FAIL、总门禁 FAIL。

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('用法: node dryrun.mjs <workflow.js>');
    process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

// ── 从源码里读 WAVES，得到 stage 顺序与人工段位置
const wavesBlock = src.match(/const WAVES = \[([\s\S]*?)\n\];/);
if (!wavesBlock) {
    console.error('读不到 const WAVES = [...]，无法自动生成场景。');
    process.exit(1);
}
const waves = [...wavesBlock[1].matchAll(/\[([^\]]*)\]/g)].map((m) =>
    m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
);
const manuals = waves.filter((w) => w.length && w[0].charAt(0) === 'M').map((w) => w[0]);
const firstStageAfter = (mIdx) => {
    for (let i = mIdx + 1; i < waves.length; i++) {
        if (waves[i].length && waves[i][0].charAt(0) !== 'M') return waves[i][0];
    }
    return null;
};

// ── 执行器
const fn = new Function('runs', 'args', 'return (async () => {' + src + '})()');

// 注入的失败形态：blocked | timeout | timeout-once（第一次超时，续跑成功）
const seen = {};
const seenG = {};
function injectImpl(failStages, seenMap, key) {
    const st = key.split('-impl-')[0];
    const v = failStages && failStages[st];
    if (!v) return null;
    if (v === 'blocked') return { ok: true, output: 'STATUS: BLOCKED 测试注入' };
    if (v === 'timeout') return { ok: false, failureKind: 'timeout', output: '' };
    if (v === 'timeout-once') {
        seenMap[st] = (seenMap[st] || 0) + 1;
        return seenMap[st] === 1 ? { ok: false, failureKind: 'timeout', output: '' } : null;
    }
    return null;
}

async function run(label, args, failStages) {
    for (const k of Object.keys(seen)) delete seen[k];
    for (const k of Object.keys(seenG)) delete seenG[k];
    const log = [];
    const runs = {
        all: async (specs) =>
            specs.map((x) => {
                log.push(x.key);
                const isGate = x.key.includes('-gate-') || x.key.startsWith('final-');
                if (isGate) {
                    const st = x.key.startsWith('final-') ? x.key : x.key.split('-gate-')[0];
                    if (failStages && failStages[st] === 'timeout-once') {
                        seenG[st] = (seenG[st] || 0) + 1;
                        if (seenG[st] === 1) return { ok: false, failureKind: 'timeout', output: '' };
                    }
                    if (failStages && failStages[st] === 'unknown-once') {
                        seenG[st] = (seenG[st] || 0) + 1;
                        if (seenG[st] === 1) return { ok: true, output: '门禁通过了，但…' };
                    }
                    if (failStages && failStages[st] === 'timeout') {
                        return { ok: false, failureKind: 'timeout', output: '' };
                    }
                    const gv = failStages && failStages[st];
                    if (gv && gv !== 'timeout' && gv !== 'timeout-once' && gv !== 'unknown-once') {
                        return { ok: true, output: 'VERDICT: FAIL' };
                    }
                    return { ok: true, output: 'VERDICT: PASS' };
                }
                {
                    const inj = injectImpl(failStages, seen, x.key);
                    if (inj) return inj;
                }
                return { ok: true, output: 'STATUS: DONE' };
            }),
        run: async (key) => {
            log.push(key);
            return { ok: true, output: 'STATUS: DONE' };
        }
    };
    let r, err = null;
    try {
        r = await fn(runs, args);
    } catch (e) {
        err = e;
        r = { halted: 'THREW', reason: e.message, progress: [] };
    }
    const stages = [...new Set(log.filter((k) => k.includes('-impl-')).map((k) => k.split('-impl-')[0]))];
    const out = {
        label,
        args: args || null,
        stages,
        children: log.length,
        halted: r.halted,
        nextManual: r.nextManual || '',
        resumes: r.resumes || [],
        reason: String(r.reason || ''),
        err
    };
    console.log(
        `  ${label.padEnd(30)} ${err ? '💥' : '  '} halted=${String(out.halted).padEnd(5)} next=${(out.nextManual || '-').padEnd(3)} ` +
            `children=${String(out.children).padEnd(3)} stages=[${stages.join(',')}]`
    );
    if (err) console.log('     ' + err.message);
    else if (out.reason) console.log('     ' + out.reason.slice(0, 90));
    return out;
}

console.log(`干跑: ${file}`);
console.log(`  WAVES: ${waves.map((w) => w.join('+')).join(' → ')}`);
console.log(`  人工段: ${manuals.join(', ') || '无'}\n`);

const results = [];
results.push(await run('全新开跑（不传 args）', undefined));

if (manuals.length) {
    const done = [];
    for (let i = 0; i < manuals.length; i++) {
        const next = firstStageAfter(waves.findIndex((w) => w[0] === manuals[i]));
        results.push(await run(`人工段 ${manuals[i]} 后续跑`, { fromStage: next, manualDone: done.slice() }));
        done.push(manuals[i]);
        // 完成本轮人工段后可继续往后
        results.push(await run(`  ↳ ${manuals[i]} 完成后续跑`, { fromStage: next, manualDone: done.slice() }));
    }
    const firstM = waves.findIndex((w) => w[0] === manuals[0]);
    const fs2 = firstStageAfter(firstM);
    results.push(await run('漏传 manualDone（应一个都不跑）', { fromStage: fs2 }));
}

// 取「最后一个非人工层的首成员」：若取 allStages 末位，末层是并行层时会拿到层内非首成员，
// 旧控制流（只认 wave[0]）下整链静默跳过 → 场景跑 0 个 stage → 误报失败。
const lastLayer = [...waves].reverse().find((w) => w.length && w[0].charAt(0) !== 'M') || [];
const lastStage = lastLayer[0] || '';
const lastM = manuals.slice();
results.push(await run('最后一个 stage 门禁一直 FAIL', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: true }));
results.push(await run('总门禁 B FAIL', { fromStage: lastStage, manualDone: lastM }, { 'final-b': true }));
results.push(await run('某 stage 实现者 BLOCKED', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'blocked' }));

// ── 判定
const bad = [];
for (const r of results) {
    if (r.err) bad.push(`${r.label}: 抛出异常 → ${r.err.message}`);
}
const fresh = results[0];
if (manuals.length) {
    if (fresh.nextManual !== manuals[0]) bad.push(`全新开跑应停在 ${manuals[0]}，实际 ${fresh.nextManual || '未停'}`);
    const leak = results.find((r) => r.label.startsWith('漏传 manualDone'));
    if (leak && (leak.stages.length > 0 || leak.nextManual !== manuals[0]))
        bad.push('漏传 manualDone 却跑了 stage 或没停在人工段');
}
const lastFail = results.find((r) => r.label.includes('门禁一直 FAIL'));
if (lastFail && lastFail.stages.length === 0) bad.push('门禁 FAIL 场景没跑到目标 stage');
const blockedRun = results.find((r) => r.label.includes('BLOCKED'));
if (blockedRun && blockedRun.nextManual) bad.push('实现者 BLOCKED 时应停机报人，不应继续到人工段');

// —— A2 超时分档 / 续跑
results.push(await run('实现超时 → 续跑成功', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'timeout-once' }));
const res1 = results[results.length - 1];
if (res1.halted) bad.push('实现超时续跑成功后仍 halted：' + (res1.reason || ''));
if (!res1.resumes || !res1.resumes.length) bad.push('实现超时后没有记录续跑');

results.push(await run('实现超时 → 续跑仍超时 → 停机', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'timeout' }));
const res2 = results[results.length - 1];
if (!res2.halted) bad.push('续跑仍超时却没收手');

results.push(await run('实现非超时失败 → 直接停机不续跑', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'blocked' }));
const res3 = results[results.length - 1];
if ((res3.resumes || []).length) bad.push('非超时失败不该续跑');

results.push(await run('门禁超时 → 重派 → PASS', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'timeout-once' }));
const res4 = results[results.length - 1];
if (res4.halted && /门禁/.test(res4.reason || '')) bad.push('门禁超时重派后仍按失败停了');

results.push(await run('门禁首次 UNKNOWN → 重派 → PASS', { fromStage: lastStage, manualDone: lastM }, { [lastStage]: 'unknown-once' }));
const res5 = results[results.length - 1];
if (res5.halted) bad.push('门禁 UNKNOWN 重派后仍停机：' + (res5.reason || ''));
if (!(res5.resumes || []).some((x) => x.reason === 'gate-unknown')) bad.push('UNKNOWN 没有触发格式重派');

console.log('\n' + (bad.length ? '✗ 干跑发现问题:\n  - ' + bad.join('\n  - ') : '✓ 干跑通过：跳层、人工段放行、门禁收敛、BLOCKED 停机都符合预期'));
process.exit(bad.length ? 1 : 0);
