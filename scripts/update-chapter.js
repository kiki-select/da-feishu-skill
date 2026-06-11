#!/usr/bin/env node
// [通用版] 由 DA-activity/bin 通用化而来，供 DA-feishu 报告增量发布；DA-activity 原版不变
// 通用增量更新章节 — 不重发整文档，只改指定 conclusion
//
// 用法:
//   node bin/update-chapter.js \
//     --doc-id <id> \
//     --report <report.json> \
//     --conclusion-id <N>
//
// 实现：
//   1. 拉 doc，按 ## N. {title} 定位章节区间
//   2. 提取章节内所有 <sheet token="..."/>，按顺序对应 conclusion.chart_data + charts[].data（table 类型）
//   3. 对每个 sheet：applyTableStyle 写新内容（复用 sheet block id）
//   4. 用 selection-with-ellipsis 替 description 文本
//   5. 用 selection-with-ellipsis 替每个表上方的 bold title（如有变化）
//   6. 用 selection-with-ellipsis 替每个 quote-container 内的 footnote
//
// 限制：
//   - 章节内有 line/bar/pie 等 PNG 图表时，PNG 不会更新（保留旧 PNG）
//   - 表数量必须与 doc 中现存 sheet 数量一致，否则报错
//   - 列数或表 schema 变化超大时（如新增列），sheet cell range 可能对不齐

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { applyTableStyle } = require('./sheet-styler');

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
    ? spawnSync(process.execPath, [LARK_CLI_ENTRY, ...args], { encoding: 'utf-8', shell: false })
    : spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true });
  if (res.status !== 0) throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

function fetchDoc(docId) {
  return JSON.parse(larkCli(['docs', '+fetch', '--doc', docId])).data.markdown;
}

function replaceRangeEllipsis(docId, startAnchor, endAnchor, newMarkdown) {
  larkCli([
    'docs', '+update',
    '--doc', docId,
    '--mode', 'replace_range',
    '--selection-with-ellipsis', `${startAnchor}...${endAnchor}`,
    '--markdown', newMarkdown,
  ]);
}

// 把一行拆成两个不重叠的锚（start...end）。**保留 markdown 标记**（API 匹配的是 markdown 源文，
// 且 footnote 的 *前缀/后缀* 能避开背景/定义里同文本的重复）。单行取首45%/尾45%（中间留缝、不重叠）。
function lineToAnchors(line) {
  const s = line.trim();
  if (s.length >= 10) {
    const h = Math.floor(s.length * 0.45);
    return [s.slice(0, h), s.slice(s.length - h)];
  }
  return [s, s];
}

function locateChapter(md, conclusionId, title) {
  const heading = `## ${conclusionId}. ${title}`;
  const start = md.indexOf(heading);
  if (start >= 0) {
    // 找下一个 ## 标题（任何序号）
    const next = md.substring(start + heading.length).search(/\n## \d+\. /);
    const end = next < 0 ? md.length : start + heading.length + next;
    return { chapter: md.substring(start, end), heading, found: true };
  }
  // 未找到目标 title，可能是 title 被改过（report 新 title vs doc 旧 title）
  // 退而求其次：用 conclusionId 作 anchor 找旧 title
  const idHeadingRe = new RegExp(`## ${conclusionId}\\. ([^\\n]+)`);
  const m = md.match(idHeadingRe);
  if (!m) throw new Error(`未找到章节 ${conclusionId}`);
  const oldTitle = m[1];
  const oldHeading = `## ${conclusionId}. ${oldTitle}`;
  const oldStart = md.indexOf(oldHeading);
  const next = md.substring(oldStart + oldHeading.length).search(/\n## \d+\. /);
  const end = next < 0 ? md.length : oldStart + oldHeading.length + next;
  return { chapter: md.substring(oldStart, end), heading: oldHeading, oldTitle, found: false };
}

// 收集 conclusion 内所有 table 类型的 chart_data（含 main + charts[]）
function collectTables(conclusion) {
  const tables = [];
  if (conclusion.chart_type === 'table' && conclusion.chart_data) {
    tables.push({ type: 'table', data: conclusion.chart_data });
  }
  for (const sub of conclusion.charts || []) {
    if (sub.type === 'table') tables.push({ type: 'table', data: sub.data });
  }
  return tables;
}

// 收集章节内所有 sheet tokens（按出现顺序）
function collectFootnotes(conclusion) {
  const footnotes = [];
  if (conclusion.chart_data && conclusion.chart_data.footnote) {
    footnotes.push(conclusion.chart_data.footnote);
  }
  for (const sub of conclusion.charts || []) {
    const data = sub.data || sub.chart_data;
    if (data && data.footnote) footnotes.push(data.footnote);
  }
  return footnotes;
}

function matchDescription(chapter) {
  return chapter.match(/(?:## \d+\. [^\n]+\n)([\s\S]+?)(?=\n(?:!\[|<quote-container>|\*\*|<sheet))/);
}

function extractSheetTokens(chapter) {
  return [...chapter.matchAll(/<sheet token="([^"]+)"\/>/g)].map(m => m[1]);
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
  const conclusionId = parseInt(args['conclusion-id'], 10);
  const sheetOnly = !!args['sheet-only'];
  if (!docId || !reportPath || !conclusionId) {
    console.error('Usage: node bin/update-chapter.js --doc-id <id> --report <report.json> --conclusion-id <N>');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf-8'));
  const conclusion = report.conclusions.find(c => c.id === conclusionId);
  if (!conclusion) throw new Error(`报告无 conclusion id=${conclusionId}`);

  console.log(`✓ 增量更新 ${docId} 章节 ${conclusionId}「${conclusion.title}」`);

  // 1. 定位章节
  const md = fetchDoc(docId);
  const located = locateChapter(md, conclusionId, conclusion.title);
  const chapter = located.chapter;
  const heading = `## ${conclusionId}. ${conclusion.title}`;

  // 标题变化 → 用 "旧标题 + 描述首行" 作 ellipsis 双锚增量改名（不走 full publish）
  if (!located.found) {
    console.log(`  → 章节标题外科改名：「${located.oldTitle}」→「${conclusion.title}」`);
    const oldHeading = located.heading;
    // 取章节描述首行（非空）作 end 锚 —— fallback: 无 sheet/无 ** 的章节用第一个非空内容行
    let oldFirstDescLine = null;
    const oldDescMatch = matchDescription(chapter);
    if (oldDescMatch) {
      oldFirstDescLine = oldDescMatch[1].trim().split('\n')[0];
    } else {
      // 章节内既无 sheet 也无 ** 段标题（如纯 bullet 章节 5/6）
      const lines = chapter.split('\n');
      const headIdx = lines.findIndex(l => l.startsWith('## '));
      for (let i = headIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t) { oldFirstDescLine = t; break; }
      }
    }
    if (!oldFirstDescLine) {
      console.error(`    ✗ 找不到 description 首行作 ellipsis 末锚，无法外科改名`);
      process.exit(3);
    }
    try {
      replaceRangeEllipsis(docId, oldHeading, oldFirstDescLine, `${heading}\n${oldFirstDescLine}`);
      console.log(`    ✓ heading 已替换`);
    } catch (e) {
      console.error(`    ⚠ heading 替换失败：${e.message.split('\n').slice(0, 4).join(' | ')}`);
      console.error(`    fallback：走 full publish 才能完成标题改名`);
      process.exit(3);
    }
  }

  // 2. 收集 doc 现有 sheet tokens + report 新表
  const sheetTokens = extractSheetTokens(chapter);
  const newTables = collectTables(conclusion);

  if (sheetTokens.length !== newTables.length) {
    throw new Error(`章节 ${conclusionId} 表数不匹配（doc ${sheetTokens.length} 张 vs report ${newTables.length} 张），结构变化建议走全量 publish`);
  }
  console.log(`  ↪ 章节含 ${sheetTokens.length} 张 sheet block`);

  // 3. 更新每张 sheet（复用 block）
  for (let i = 0; i < newTables.length; i++) {
    const token = sheetTokens[i];
    const lastUnd = token.lastIndexOf('_');
    const spt = token.substring(0, lastUnd);
    const sid = token.substring(lastUnd + 1);
    const t = newTables[i].data;
    console.log(`  → sheet[${i}] 更新 (${t.rows.length + 1} 行 × ${t.columns.length} 列): ${token}`);
    applyTableStyle({
      token: spt, sheetId: sid,
      headers: t.columns, rows: t.rows, columnTypes: t.column_types,
      headerRows: t.header_rows,
      mergeRanges: t.merge_ranges,
      columnWidths: t.column_widths,
    });
  }

  // 4. 更新 description 文本（用 章节 heading 作 start anchor 确保唯一定位；含 heading 在 replace range 内）
  console.log(`  → description 更新`);
  if (sheetOnly) {
    console.log(`  → sheet-only: 已跳过 description / title / footnote 更新`);
    console.log(`✓ 完成。📎 https://www.feishu.cn/docx/${docId}`);
    return;
  }

  const oldDescMatch = matchDescription(chapter);
  if (oldDescMatch && conclusion.description) {
    const oldDesc = oldDescMatch[1].trim();
    const lines = oldDesc.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const oldLast = lines[lines.length - 1];
      const newContent = `${heading}\n${conclusion.description}`;
      try {
        replaceRangeEllipsis(docId, heading, oldLast, newContent);
      } catch (e) {
        console.warn(`    ⚠ description 替换失败：${e.message.split('\n').slice(0, 4).join(' | ')}`);
      }
    }
  }

  // 5. 更新每张表上方的 bold title（如有变化）
  for (let i = 0; i < newTables.length; i++) {
    const t = newTables[i].data;
    if (!t.title) continue;
    const token = sheetTokens[i];
    // 旧 title 紧贴在 sheet token 前一行 (**OLD**\n<sheet token=...)
    const tokenEscaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\*\\*([^*\\n]+)\\*\\*\\s*\n<sheet token="${tokenEscaped}"`);
    const m = chapter.match(re);
    if (m && m[1] !== t.title) {
      console.log(`  → 表标题更新 [sheet[${i}]]: 「${m[1]}」→「${t.title}」`);
      try {
        const [ta, tb] = lineToAnchors(`**${m[1]}**`);
        replaceRangeEllipsis(docId, ta, tb, `**${t.title}**`);
      } catch (e) {
        console.warn(`    ⚠ 表标题替换失败：${e.message.split('\n')[0]}`);
      }
    }
  }

  // 6. 更新每个 footnote（剥掉 * 标记匹配渲染文本；单行用首尾子串做两个不同锚）
  const footMatches = [...chapter.matchAll(/<quote-container>\s*([\s\S]+?)\s*<\/quote-container>/g)];
  const newFootnotes = collectFootnotes(conclusion);
  for (let i = 0; i < footMatches.length && i < newFootnotes.length; i++) {
    const footnote = newFootnotes[i];
    const oldInner = footMatches[i][1];
    const oldLines = oldInner.split('\n').map(l => l.trim()).filter(Boolean);
    if (oldLines.length === 0) continue;
    let startA, endA;
    if (oldLines.length === 1) {
      [startA, endA] = lineToAnchors(oldLines[0]);   // 单行：保留*标记、首尾不重叠
    } else {
      startA = oldLines[0]; endA = oldLines[oldLines.length - 1];  // 多行：首末行(含*)
    }
    const newLines = footnote.split('\n').map(l => l.trim()).filter(Boolean);
    const newInner = newLines.map(l => `*${l}*`).join('\n\n');
    console.log(`  → footnote[${i}] 更新 (${oldLines.length}→${newLines.length} 行)`);
    try {
      replaceRangeEllipsis(docId, startA, endA, newInner);
    } catch (e) {
      console.warn(`    ⚠ footnote[${i}] 替换失败：${e.message.split('\n')[0]}`);
    }
  }

  console.log(`✓ 完成。📎 https://www.feishu.cn/docx/${docId}`);

  // 跑 verify-doc 校验（SKIP_VERIFY=1 跳过）
  if (process.env.SKIP_VERIFY !== '1') {
    console.log('\n→ verify-doc 校验...');
    const verifyScript = path.resolve(__dirname, 'verify-doc.js');
    const res = spawnSync(process.execPath, [verifyScript, '--doc-id', docId, '--report', path.resolve(reportPath)], { encoding: 'utf-8' });
    for (const line of (res.stdout || '').split('\n').filter(Boolean)) console.log('  ' + line);
    if (res.status !== 0) {
      console.error('  ⚠ verify 未通过，请按上方 FAIL 项修复');
      process.exit(2);
    }
  }
}

main();
