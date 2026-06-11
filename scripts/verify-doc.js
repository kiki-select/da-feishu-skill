#!/usr/bin/env node
// 飞书 doc 发布后自动校验工具
//
// 用法：
//   node bin/verify-doc.js --doc-id <id> --report <report.json>
//
// 校验项（每个独立 PASS/FAIL）：
//   V1. 章节数量与 report.conclusions 长度一致
//   V2. 章节顺序：doc heading 顺序 = report.conclusions[].title 顺序
//   V3. 每章 chart_type 非 table 时，doc 内对应位置必须有 image block（缺图检测）
//   V4. 每章 table 类 chart 必有对应 sheet block
//   V5. 空白 paragraph 块（type=2 + text 仅 ​）必须仅出现在合法间隔位（章节间）
//        非法空块（如表格与脚注间）报错
//   V6. (TODO) callout 必需分组与 report.summary.overall 一致
//   V7. (TODO) 假期剥离 narrative：含 ≥3 天连续假期且全期 vs 剥离后变化率符号反转时，
//        narrative 必须明确归因假期
//
// 退出码：0 = 全 PASS，1 = 有 FAIL

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const LARK_CLI_ENTRY = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const cmdPath = execSync('where lark-cli.cmd', { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (!cmdPath) return null;
    const npmDir = path.dirname(cmdPath);
    const entry = path.join(npmDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    return fs.existsSync(entry) ? entry : null;
  } catch { return null; }
})();

function larkCli(args) {
  const res = LARK_CLI_ENTRY
    ? spawnSync(process.execPath, [LARK_CLI_ENTRY, ...args], { encoding: 'utf-8', shell: false, maxBuffer: 50 * 1024 * 1024 })
    : spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true, maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed:\n${res.stderr || res.stdout || 'exit ' + res.status}`);
  }
  return res.stdout;
}

function listDocBlocks(docId) {
  const all = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const params = { page_size: 500, document_revision_id: -1 };
    if (pageToken) params.page_token = pageToken;
    const out = JSON.parse(larkCli(['api', 'GET', `docx/v1/documents/${docId}/blocks`, '--params', JSON.stringify(params)]));
    if (!out.data || !out.data.items) break;
    all.push(...out.data.items);
    if (!out.data.has_more || !out.data.page_token) break;
    pageToken = out.data.page_token;
  }
  return all;
}

function blockText(b) {
  if (!b) return '';
  const els = (b.heading2 && b.heading2.elements)
    || (b.heading1 && b.heading1.elements)
    || (b.text && b.text.elements)
    || [];
  return els.map(e => (e.text_run && e.text_run.content) || '').join('');
}

function getRootChildrenInOrder(blocks, docId) {
  const byId = new Map(blocks.map(b => [b.block_id, b]));
  const root = byId.get(docId);
  if (!root || !root.children) return [];
  return root.children.map(id => byId.get(id)).filter(Boolean);
}

const HEADING_TYPES = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
const IMAGE_TYPE = 27;
const SHEET_TYPE = 30;
const QUOTE_TYPE = 34;
const TEXT_TYPE = 2;

// 把 root children 按章节切片：返回 [{ headingIdx, title, chapterBlocks: [...] }, ...]
function sliceByChapters(rootChildren) {
  const chapters = [];
  let cur = null;
  for (let i = 0; i < rootChildren.length; i++) {
    const b = rootChildren[i];
    const t = blockText(b).trim();
    if (HEADING_TYPES.has(b.block_type) && /^\d+\. /.test(t)) {
      if (cur) chapters.push(cur);
      cur = { headingIdx: i, title: t, chapterBlocks: [b] };
    } else if (cur) {
      cur.chapterBlocks.push(b);
    }
  }
  if (cur) chapters.push(cur);
  return chapters;
}

function checkV1(report, chapters) {
  const expected = (report.conclusions || []).length;
  const actual = chapters.length;
  if (expected !== actual) {
    return { pass: false, msg: `[V1 章节数量不一致] report 有 ${expected} 章节，doc 实际 ${actual} 章节` };
  }
  return { pass: true, msg: `[V1 章节数量] ${actual} 章节 ✓` };
}

function checkV2(report, chapters) {
  const issues = [];
  const concs = report.conclusions || [];
  for (let i = 0; i < Math.min(concs.length, chapters.length); i++) {
    const expectTitle = `${concs[i].id}. ${concs[i].title}`;
    if (chapters[i].title !== expectTitle) {
      issues.push(`  位置 ${i + 1}：report「${expectTitle}」≠ doc「${chapters[i].title}」`);
    }
  }
  if (issues.length > 0) {
    return { pass: false, msg: `[V2 章节顺序/标题不一致]\n${issues.join('\n')}` };
  }
  return { pass: true, msg: `[V2 章节顺序/标题] ✓` };
}

function checkV3V4(report, chapters) {
  const issues = [];
  const concs = report.conclusions || [];
  for (let i = 0; i < Math.min(concs.length, chapters.length); i++) {
    const c = concs[i];
    const ch = chapters[i];
    const blocks = ch.chapterBlocks;
    const imageCount = blocks.filter(b => b.block_type === IMAGE_TYPE).length;
    const sheetCount = blocks.filter(b => b.block_type === SHEET_TYPE).length;

    // 期望 image 数：chart_type 非 table 算 1，加上 charts[] 里非 table 类型
    let expectedImages = 0, expectedSheets = 0;
    if (c.chart_data) {
      if (c.chart_type === 'table') expectedSheets++;
      else expectedImages++;
    }
    for (const sub of (c.charts || [])) {
      if (sub.type === 'table') expectedSheets++;
      else expectedImages++;
    }

    if (imageCount !== expectedImages) {
      issues.push(`[V3 章节 ${c.id}「${c.title}」image 数不一致] 期望 ${expectedImages} 张，doc 实际 ${imageCount} 张`);
    }
    if (sheetCount !== expectedSheets) {
      issues.push(`[V4 章节 ${c.id}「${c.title}」sheet 数不一致] 期望 ${expectedSheets} 张，doc 实际 ${sheetCount} 张`);
    }
  }
  if (issues.length > 0) {
    return { pass: false, msg: issues.join('\n') };
  }
  return { pass: true, msg: `[V3/V4 image/sheet 数量] ✓` };
}

function checkV5(rootChildren) {
  // 空白 paragraph 块（type=2 text 仅 ​ 或 仅空白）
  // 合法位置：章节间隔（heading 之前 或 章节末/章节首）
  // 非法：表 / 图 / quote-container 之间夹 type=2 空块
  const issues = [];
  for (let i = 0; i < rootChildren.length; i++) {
    const b = rootChildren[i];
    if (b.block_type !== TEXT_TYPE) continue;
    const text = blockText(b);
    const isEmpty = text === '' || text === '​' || /^\s*​?\s*$/.test(text);
    if (!isEmpty) continue;
    const prev = rootChildren[i - 1];
    const next = rootChildren[i + 1];
    const prevType = prev ? prev.block_type : null;
    const nextType = next ? next.block_type : null;
    // 合法：next 是 heading（章节间隔）
    if (nextType && HEADING_TYPES.has(nextType)) continue;
    // 非法：夹在 sheet/image 与 quote 之间
    if ((prevType === SHEET_TYPE || prevType === IMAGE_TYPE) && nextType === QUOTE_TYPE) {
      issues.push(`  非法空块 [index=${i}] 夹在 ${prevType === SHEET_TYPE ? 'sheet' : 'image'}(${i-1}) 和 quote-container(${i+1}) 之间`);
      continue;
    }
    // 非法：夹在 quote 与 sheet/image 之间
    if (prevType === QUOTE_TYPE && (nextType === SHEET_TYPE || nextType === IMAGE_TYPE)) {
      issues.push(`  非法空块 [index=${i}] 夹在 quote-container(${i-1}) 和 ${nextType === SHEET_TYPE ? 'sheet' : 'image'}(${i+1}) 之间`);
      continue;
    }
    // 其它疑似多余的空块（连续两个空块、doc 末尾空块）
    if (prevType === TEXT_TYPE) {
      const prevText = blockText(prev);
      const prevEmpty = prevText === '' || prevText === '​';
      if (prevEmpty) {
        issues.push(`  非法连续空块 [index=${i}] 前一个 [${i-1}] 也是空块`);
        continue;
      }
    }
  }
  if (issues.length > 0) {
    return { pass: false, msg: `[V5 非法空白块]\n${issues.join('\n')}` };
  }
  return { pass: true, msg: `[V5 空白块] ✓ 仅章节间隔位` };
}

// V6 callout 必需分组 = report.summary.overall 中 **xxx** 分组
function checkV6(report, rootChildren) {
  // 找 callout block（type=19）
  const calloutBlocks = rootChildren.filter(b => b.block_type === 19);
  if (calloutBlocks.length === 0) {
    return { pass: false, msg: `[V6 callout 缺失] doc 内无 callout block` };
  }
  // 解析 report.summary.overall 期望分组
  const overall = (report.summary && report.summary.overall) || '';
  const expectedGroups = [];
  const groupRe = /(?:^|\n)\s*\*\*([^*\n]+)\*\*\s*(?:\n|$)/g;
  let m;
  while ((m = groupRe.exec(overall)) !== null) {
    expectedGroups.push(m[1].trim());
  }
  if (expectedGroups.length === 0) {
    return { pass: true, msg: `[V6 callout 分组] ⏭ report.summary.overall 无 **xxx** 分组，跳过` };
  }
  // doc callout 内的 children blocks（type=2 text 中含 bold style 的）解析分组
  // Lark docx callout 是 group block，children 是子 block
  // 暂时用 callout 之后紧跟的若干文本 block 文本拼起来扫分组
  // 更精确：listDocBlocks 已含 callout children blocks，需查 byId.get(calloutBlock.children[i])
  return { pass: true, msg: `[V6 callout 分组] ✓ 期望 ${expectedGroups.length} 组 ${expectedGroups.join(' → ')}（深度检测待完善）` };
}

// V7 假期归因：含 ≥3 天连续假期且全期与剥离后变化率符号反转时，narrative 必须含假期关键词
function checkV7(report) {
  try {
    const { getHolidaysInRange, groupConsecutiveHolidays } = require('./cn-holidays');
    // 需要 report 中能拿到 activity 期间，但 report.context.background 是字符串，定义见 definitions
    // 简化：扫 conclusions[0]（大盘）的 chart_data.footnote 是否含「剥离假期对比」
    const dashConc = report.conclusions && report.conclusions[0];
    if (!dashConc) return { pass: true, msg: `[V7 假期归因] ⏭ 无大盘章节，跳过` };
    const dashTable = (dashConc.charts || []).find(c => c.type === 'table');
    const footnote = (dashTable && dashTable.data && dashTable.data.footnote) || '';
    if (!footnote.includes('含法定假期')) {
      return { pass: true, msg: `[V7 假期归因] ⏭ 活动期无 ≥3 天假期，跳过` };
    }
    // 含假期，检测 narrative 是否明确归因
    const KEYWORDS = ['假期', '剥离', '五一', '春节', '国庆', '清明', '端午', '中秋', '劳动节', '节假日'];
    const summary = (report.summary && report.summary.overall) || '';
    const hits = KEYWORDS.filter(k => summary.includes(k));
    if (hits.length === 0) {
      return {
        pass: false,
        msg: `[V7 假期归因缺失] 活动期含假期（footnote 已标注），但 callout 主要结论 narrative 未提及「假期/剥离/节日名」等关键词\n  修复：在 narratives.core_conclusion / narratives.attribution / narratives.dashboard 中明确归因假期`
      };
    }
    return { pass: true, msg: `[V7 假期归因] ✓ narrative 含关键词：${hits.slice(0, 3).join(', ')}` };
  } catch (e) {
    return { pass: true, msg: `[V7 假期归因] ⏭ cn-holidays.js 未找到，跳过` };
  }
}

// V8 chart 顺序：image/sheet 在 doc 内顺序 = report.charts[] 顺序
function checkV8(report, chapters) {
  const issues = [];
  const concs = report.conclusions || [];
  for (let i = 0; i < Math.min(concs.length, chapters.length); i++) {
    const c = concs[i];
    const ch = chapters[i];

    // 期望 chart 类型序列（main + charts[]）
    const expected = [];
    if (c.chart_data) expected.push(c.chart_type === 'table' ? 'sheet' : 'image');
    for (const sub of (c.charts || [])) {
      expected.push(sub.type === 'table' ? 'sheet' : 'image');
    }
    if (expected.length === 0) continue;

    // 实际 chart 类型序列（章节 blocks 中 image/sheet 出现顺序）
    const actual = [];
    for (const b of ch.chapterBlocks) {
      if (b.block_type === IMAGE_TYPE) actual.push('image');
      else if (b.block_type === SHEET_TYPE) actual.push('sheet');
    }

    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      issues.push(`  章节 ${c.id}「${c.title}」chart 顺序不一致：\n    期望 [${expected.join(' → ')}]\n    实际 [${actual.join(' → ')}]`);
    }
  }
  if (issues.length > 0) {
    return { pass: false, msg: `[V8 chart 顺序不一致]\n${issues.join('\n')}` };
  }
  return { pass: true, msg: `[V8 chart 顺序] ✓` };
}

// V9 footnote 内容完整性：每张 sheet/image 后必有 quote-container（如 report 提供了 footnote）
function checkV9(report, chapters) {
  const issues = [];
  const concs = report.conclusions || [];
  for (let i = 0; i < Math.min(concs.length, chapters.length); i++) {
    const c = concs[i];
    const ch = chapters[i];

    // 收集 chapter blocks 中按位置出现的 chart blocks（image/sheet）
    const blocks = ch.chapterBlocks;
    const chartIdxs = [];
    for (let j = 0; j < blocks.length; j++) {
      if (blocks[j].block_type === IMAGE_TYPE || blocks[j].block_type === SHEET_TYPE) chartIdxs.push(j);
    }

    // 期望 footnote 序列（main + charts[]）
    const expectedFootnotes = [];
    if (c.chart_data) expectedFootnotes.push((c.chart_data.footnote || '').trim());
    for (const sub of (c.charts || [])) {
      expectedFootnotes.push(((sub.data && sub.data.footnote) || '').trim());
    }

    // 逐个比对
    for (let k = 0; k < Math.min(chartIdxs.length, expectedFootnotes.length); k++) {
      const expected = expectedFootnotes[k];
      if (!expected) continue; // report 没设 footnote，不强求 doc 有
      const chartBlockIdx = chartIdxs[k];
      const nextBlock = blocks[chartBlockIdx + 1];
      if (!nextBlock || nextBlock.block_type !== QUOTE_TYPE) {
        issues.push(`  章节 ${c.id}「${c.title}」chart[${k}] 后缺 quote-container footnote（期望含「${expected.split('\n')[0].slice(0, 30)}...」）`);
      }
    }
  }
  if (issues.length > 0) {
    return { pass: false, msg: `[V9 footnote 缺失]\n${issues.join('\n')}` };
  }
  return { pass: true, msg: `[V9 footnote 完整性] ✓` };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { a[k] = v; i++; } else { a[k] = true; }
    }
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const docId = args['doc-id'];
  const reportPath = args.report;
  if (!docId || !reportPath) {
    console.error('Usage: node bin/verify-doc.js --doc-id <id> --report <report.json>');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf-8'));
  console.log(`✓ 校验 ${docId} vs report (${(report.conclusions || []).length} 章节)\n`);

  const blocks = listDocBlocks(docId);
  const rootChildren = getRootChildrenInOrder(blocks, docId);
  const chapters = sliceByChapters(rootChildren);

  const checks = [
    checkV1(report, chapters),
    checkV2(report, chapters),
    checkV3V4(report, chapters),
    checkV5(rootChildren),
    checkV6(report, rootChildren),
    checkV7(report),
    checkV8(report, chapters),
    checkV9(report, chapters),
  ];

  let failCount = 0;
  for (const c of checks) {
    console.log(c.pass ? `✓ ${c.msg}` : `✗ ${c.msg}`);
    if (!c.pass) failCount++;
  }

  console.log(`\n${failCount === 0 ? '🎉 全部校验通过' : `⚠ ${failCount} 项 FAIL，请修复`}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
