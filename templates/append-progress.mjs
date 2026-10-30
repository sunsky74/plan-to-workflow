#!/usr/bin/env node
// append-progress.mjs —— 把一次 workflow 返回的 progress 行追加进 <change>/progress.md
//
// 用法：
//   node append-progress.mjs <change 目录> <status.json | -> [--dry-run]
//
// status.json 是 pi 的 async run 状态文件；从 workflow.value.progress 取行。
// 也接受 `-`，此时从 stdin 读一段 JSON。
//
// 为什么要有它：progress.md 是机器账，靠人手动复制会漂移（漏行、改格式、
// 同一段贴两遍）。这里按「stage + 轮次」去重，重复调用是幂等的。

import fs from 'node:fs';
import path from 'node:path';

const [changeDir, src, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');

if (!changeDir || !src) {
    console.error('用法: node append-progress.mjs <change 目录> <status.json | -> [--dry-run]');
    process.exit(125);
}

const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
let doc;
try {
    doc = JSON.parse(raw);
} catch (e) {
    console.error('✗ status.json 不是合法 JSON：' + e.message);
    process.exit(1);
}

// 兼容两种位置：status.json 的 value.progress，或直接就是 workflow 的返回体
const value = (doc && doc.value) || doc || {};
const rows = value.progress || [];
if (!Array.isArray(rows) || !rows.length) {
    console.error('✗ 没找到 progress 行（期望 status.json 里 value.progress 是数组）');
    process.exit(1);
}

const md = path.join(changeDir, 'progress.md');
const header = [
    '# Progress',
    '',
    '> 机器账：由 `append-progress.mjs` 从 workflow 返回体追加。人账：`tasks.md` 的 `- [x]`。两者需对账。',
    '',
    '| 时刻 | stage / 段 | 结果 | 备注 |',
    '|---|---|---|---|'
];

let text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
if (!text.trim()) {
    text = header.join('\n') + '\n';
}

// 去重键：stage + 结果（含轮次）。同一 stage 的 r1 与 r2 是两条不同记录。
const keyOf = (line) => {
    const cells = String(line).split('|').map((x) => x.trim());
    return cells.length >= 5 ? cells[2] + '::' + cells[3] : String(line).trim();
};
const seen = new Set(
    text.split('\n').filter((l) => l.trim().startsWith('|')).map(keyOf)
);

const added = [];
for (const line of rows) {
    const s = String(line).trim();
    if (!s) continue;
    if (!s.startsWith('|')) {
        console.error(`✗ progress 行不是表格形态（应为 | 时刻 | stage | 结果 | 备注 |）：${s.slice(0, 80)}`);
        process.exit(1);
    }
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(s);
}

if (!added.length) {
    console.log('✓ 没有新行（已是最新）');
    process.exit(0);
}

const body = text.replace(/\s*$/, '') + '\n' + added.join('\n') + '\n';
if (dryRun) {
    console.log(`（dry-run）将追加 ${added.length} 行：`);
    for (const a of added) console.log('  ' + a);
    process.exit(0);
}
fs.writeFileSync(md, body);
console.log(`✓ 追加 ${added.length} 行 → ${md}`);
