#!/usr/bin/env node
// [通用版] 由 DA-activity/bin 通用化而来，供 DA-feishu 报告增量发布；DA-activity 原版不变
// 单章节级重建 v2 — cascade 模式，支持 image 章节
//
// 用法：
//   node scripts/republish-chapter.js \
//     --doc-id <id> \
//     --report <report.json> \
//     --conclusion-id <N> \
//     [--charts-dir <path>]    # 默认 ./charts
//     [--cascade]              # 强制启用 cascade（默认含 image 时自动开启）
//     [--no-verify]            # 跳过末尾 verify-doc 校验
//
// 模式：
//   v1 (insert_before)：章节内仅含 text + sheet 时用，仅动该章节（最高效 ~10 API）
//   v2 (cascade)：章节内含 image 时强制用，删 [chapter N 起, doc 末尾) + 顺序 append N..end 所有章节
//                  image 通过 media-insert 自然落入对应章节末尾，约 30+ API（仍比 full publish 80+ 省 60%+）
//
// 工作流程（cascade 模式）：
//   1. fetch doc blocks → 定位章节 N 起始 index（startIdx = chapter N heading 位置）
//   2. batch_delete [startIdx, doc 末尾)
//   3. 按 report.conclusions[N-1..] 顺序逐章 append：
//        - chapter 间隔 ​
//        - heading + description
//        - chart_data（main）→ table 走 sheet block / image 走 media-insert
//        - 各 footnote
//        - charts[] sub charts 同理
//   4. （除非 --no-verify）末尾自动跑 verify-doc.js 校验

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
    ? spawnSync(process.execPath, [LARK_CLI_ENTRY, ...args], { encoding: 'utf-8', shell: false, maxBuffer: 50 * 1024 * 1024 })
    : spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true, maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) {
    const err = (res.stderr || '').trim() || (res.stdout || '').trim() || `exit ${res.status}`;
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed: ${err.slice(0, 300)}`);
  }
  return res.stdout;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function locateChapterStart(rootChildren, chapterNum, chapterTitle) {
  let idx = rootChildren.findIndex(b =>
    HEADING_TYPES.has(b.block_type) && blockText(b).trim() === `${chapterNum}. ${chapterTitle}`
  );
  if (idx < 0) {
    idx = rootChildren.findIndex(b =>
      HEADING_TYPES.has(b.block_type) && new RegExp(`^${chapterNum}\\. `).test(blockText(b).trim())
    );
  }
  if (idx < 0) throw new Error(`未找到章节 ${chapterNum}「${chapterTitle}」`);
  return idx;
}

function batchDeleteChildren(docId, startIndex, endIndex) {
  if (endIndex <= startIndex) return;
  const body = JSON.stringify({ start_index: startIndex, end_index: endIndex });
  larkCli(['api', 'DELETE', `docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, '--data', body]);
}

// ─── 章节渲染 helper（复刻 publish-to-feishu.js 章节循环）───

const CHARTS_DIR_DEFAULT = path.resolve(__dirname, 'charts');

function normVal(v, t) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^[+-]/.test(s)) return s;
  if (t === 'percent') { const m = s.match(/^(-?\d+(?:\.\d+)?)%$/); if (m) return parseFloat(m[1]) / 100; }
  if (t === 'int' || t === 'number' || t === 'currency') { const n = Number(s.replace(/,/g, '')); if (!isNaN(n)) return n; }
  return s;
}

function normalizeRows(rows, columnTypes) {
  return rows.map(r => r.map((v, c) => normVal(v, columnTypes[c])));
}

async function appendMarkdown(docId, md) {
  larkCli(['docs', '+update', '--doc', docId, '--mode', 'append', '--markdown', md]);
  await sleep(300);
}

async function appendFootnote(docId, text) {
  if (!text) return;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => `*${l}*`).join('\n\n');
  await appendMarkdown(docId, `<quote-container>\n${lines}\n</quote-container>\n`);
}

async function appendImage(docId, chartsDir, label) {
  const src = path.join(chartsDir, `${label}.png`);
  if (!fs.existsSync(src)) {
    console.warn(`  ⚠ PNG 缺失：${src}，跳过 image「${label}」`);
    return;
  }
  const tmpName = `_tmp_republish_${process.pid}_${label}.png`;
  const tmpPath = path.join(process.cwd(), tmpName);
  fs.copyFileSync(src, tmpPath);
  try {
    larkCli(['docs', '+media-insert', '--doc', docId, '--file', `./${tmpName}`, '--align', 'center']);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
  await sleep(300);
}

async function appendSheet(docId, table) {
  const headerRowCount = Array.isArray(table.header_rows) && table.header_rows.length ? table.header_rows.length : 1;
  const totalRows = table.rows.length + headerRowCount;
  const colCount = table.columns.length;
  const body = JSON.stringify({
    index: -1,
    children: [{ block_type: 30, sheet: { row_size: Math.min(totalRows, 9), column_size: Math.min(colCount, 9) } }]
  });
  const r = JSON.parse(larkCli(['api', 'POST', `docx/v1/documents/${docId}/blocks/${docId}/children`, '--data', body]));
  const full = r.data.children[0].sheet.token;
  const ix = full.lastIndexOf('_');
  const tok = full.substring(0, ix), sid = full.substring(ix + 1);
  if (totalRows > 9) {
    larkCli(['api', 'POST', `sheets/v2/spreadsheets/${tok}/dimension_range`, '--data',
      JSON.stringify({ dimension: { sheetId: sid, majorDimension: 'ROWS', length: totalRows - 9 } })]);
    await sleep(400);
  }
  if (colCount > 9) {
    larkCli(['api', 'POST', `sheets/v2/spreadsheets/${tok}/dimension_range`, '--data',
      JSON.stringify({ dimension: { sheetId: sid, majorDimension: 'COLUMNS', length: colCount - 9 } })]);
    await sleep(400);
  }
  const types = table.column_types;
  const normRows = normalizeRows(table.rows, types);
  // 3 次重试 applyTableStyle（API 偶发瞬时失败）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      applyTableStyle({
        token: tok,
        sheetId: sid,
        headers: table.columns,
        rows: normRows,
        columnTypes: types,
        headerRows: table.header_rows,
        mergeRanges: table.merge_ranges,
        columnWidths: table.column_widths,
      });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      console.warn(`  retry applyTableStyle (attempt ${attempt + 1}) ${e.message.slice(0, 60)}`);
      await sleep(2000);
    }
  }
  await sleep(400);
}

// 一个 chart_data → 完整章节渲染单元（含 bold title + sheet/image + footnote）
async function appendChartUnit(docId, chartsDir, chapterId, label, chartType, chartData) {
  if (chartType === 'table') {
    if (chartData.title) await appendMarkdown(docId, `**${chartData.title}**\n`);
    await appendSheet(docId, chartData);
    await appendFootnote(docId, chartData.footnote);
  } else {
    // image
    await appendImage(docId, chartsDir, label);
    await appendFootnote(docId, chartData.footnote);
  }
}

async function appendChapter(docId, chartsDir, chapterNum, conclusion) {
  if (true) {
    await appendMarkdown(docId, `\u200b\n## ${chapterNum}. ${conclusion.title}\n${conclusion.description || ''}\n`);
  } else
  await appendMarkdown(docId, `​\n## ${chapterNum}. ${conclusion.title}\n${conclusion.description || ''}\n`);
  // main chart
  if (conclusion.chart_data) {
    await appendChartUnit(docId, chartsDir, conclusion.id, `conclusion_${conclusion.id}_main`, conclusion.chart_type || 'table', conclusion.chart_data);
  }
  // sub charts
  if (Array.isArray(conclusion.charts)) {
    for (let i = 0; i < conclusion.charts.length; i++) {
      const sub = conclusion.charts[i];
      await appendChartUnit(docId, chartsDir, conclusion.id, `conclusion_${conclusion.id}_${i}`, sub.type, sub.data);
    }
  }
}

// 收集 conclusion 内是否含 image
function hasImageCharts(conclusion) {
  if (conclusion.chart_type && conclusion.chart_type !== 'table' && conclusion.chart_data) return true;
  return (conclusion.charts || []).some(c => c.type && c.type !== 'table');
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

// ─── insert_before mode（v1，仅 text+sheet）保留为快速路径 ───

async function v1InsertBeforeMode(docId, report, conclusionId, chartsDir) {
  const conclusion = report.conclusions.find(c => c.id === conclusionId);
  console.log(`✓ v1 insert_before 模式（仅 text+sheet）: 章节 ${conclusionId}「${conclusion.title}」`);

  const blocks = listDocBlocks(docId);
  const rootChildren = getRootChildrenInOrder(blocks, docId);
  const startIdx = locateChapterStart(rootChildren, conclusionId, conclusion.title);

  // 找下一章节 heading
  let endIdx = rootChildren.length;
  let nextChapterTitle = null;
  for (let i = startIdx + 1; i < rootChildren.length; i++) {
    const b = rootChildren[i];
    if (HEADING_TYPES.has(b.block_type) && /^\d+\. /.test(blockText(b).trim())) {
      endIdx = i;
      nextChapterTitle = blockText(b).trim();
      break;
    }
  }
  if (!nextChapterTitle) throw new Error('本章节是 doc 末尾，无法 insert_before，请改用 --cascade 模式');

  console.log(`  ↪ 章节占 [${startIdx}, ${endIdx})，next chapter = ${nextChapterTitle}`);

  batchDeleteChildren(docId, startIdx, endIdx);
  console.log(`  ✓ 已删 ${endIdx - startIdx} 个旧 block`);

  // 构造文本 markdown（heading + desc + 每张 sheet 的 bold title + footnote）
  const heading = `## ${conclusionId}. ${conclusion.title}`;
  let chapterMd = `${heading}\n${conclusion.description || ''}\n`;
  const tables = [];
  if (conclusion.chart_type === 'table' && conclusion.chart_data) tables.push(conclusion.chart_data);
  for (const sub of (conclusion.charts || [])) {
    if (sub.type === 'table') tables.push(sub.data);
  }
  for (const t of tables) {
    if (t.title) chapterMd += `\n**${t.title}**\n`;
    if (t.footnote) {
      const lines = t.footnote.split('\n').map(l => l.trim()).filter(Boolean).map(l => `*${l}*`).join('\n\n');
      chapterMd += `<quote-container>\n${lines}\n</quote-container>\n`;
    }
  }

  // insert_before
  larkCli([
    'docs', '+update',
    '--doc', docId,
    '--mode', 'insert_before',
    '--selection-by-title', nextChapterTitle,
    '--markdown', chapterMd,
  ]);
  console.log(`  ✓ 文本部分已 insert_before「${nextChapterTitle}」`);

  // 对每张 sheet：找 bold title block 在 doc 内位置，在其后创建 sheet block
  for (const t of tables) {
    const curBlocks = listDocBlocks(docId);
    const curRoot = getRootChildrenInOrder(curBlocks, docId);
    let titleIdx = -1;
    for (let ci = 0; ci < curRoot.length; ci++) {
      if (curRoot[ci].block_type === 2 && blockText(curRoot[ci]) === t.title) { titleIdx = ci; break; }
    }
    if (titleIdx < 0) { console.warn(`  ⚠ sheet「${t.title}」bold title 未找到，跳过`); continue; }
    const headerRowCount = Array.isArray(t.header_rows) && t.header_rows.length ? t.header_rows.length : 1;
    const totalRows = t.rows.length + headerRowCount;
    const body = JSON.stringify({
      index: titleIdx + 1,
      children: [{ block_type: 30, sheet: { row_size: Math.min(totalRows, 9), column_size: Math.min(t.columns.length, 9) } }]
    });
    const r = JSON.parse(larkCli(['api', 'POST', `docx/v1/documents/${docId}/blocks/${docId}/children`, '--data', body]));
    const full = r.data.children[0].sheet.token;
    const ix = full.lastIndexOf('_');
    const tok = full.substring(0, ix), sid = full.substring(ix + 1);
    if (totalRows > 9) {
      larkCli(['api', 'POST', `sheets/v2/spreadsheets/${tok}/dimension_range`, '--data',
        JSON.stringify({ dimension: { sheetId: sid, majorDimension: 'ROWS', length: totalRows - 9 } })]);
    }
    if (t.columns.length > 9) {
      larkCli(['api', 'POST', `sheets/v2/spreadsheets/${tok}/dimension_range`, '--data',
        JSON.stringify({ dimension: { sheetId: sid, majorDimension: 'COLUMNS', length: t.columns.length - 9 } })]);
    }
    applyTableStyle({
      token: tok,
      sheetId: sid,
      headers: t.columns,
      rows: normalizeRows(t.rows, t.column_types),
      columnTypes: t.column_types,
      headerRows: t.header_rows,
      mergeRanges: t.merge_ranges,
      columnWidths: t.column_widths,
    });
    console.log(`  ✓ sheet「${t.title}」插入 (${totalRows} 行 × ${t.columns.length} 列, index=${titleIdx + 1})`);
  }
}

// ─── cascade mode（v2，支持 image）───

async function v2CascadeMode(docId, report, conclusionId, chartsDir) {
  const startConcIdx = report.conclusions.findIndex(c => c.id === conclusionId);
  if (startConcIdx < 0) throw new Error(`报告无 conclusion id=${conclusionId}`);
  const startConclusion = report.conclusions[startConcIdx];

  console.log(`✓ v2 cascade 模式: 从章节 ${conclusionId}「${startConclusion.title}」起重建到 doc 末尾`);
  console.log(`  ↪ 将重建 ${report.conclusions.length - startConcIdx} 个章节（cascade 影响范围）`);

  // 1. 定位 chapter N 起始 index
  const blocks = listDocBlocks(docId);
  const rootChildren = getRootChildrenInOrder(blocks, docId);
  const startIdx = locateChapterStart(rootChildren, conclusionId, startConclusion.title);

  // 2. 也删除 chapter N 之前的章节间隔（​ 空块），保持视觉整洁
  let actualStartIdx = startIdx;
  if (startIdx > 0 && rootChildren[startIdx - 1].block_type === 2) {
    const prevText = blockText(rootChildren[startIdx - 1]);
    if (prevText === '' || prevText === '​') actualStartIdx = startIdx - 1;
  }

  console.log(`  ↪ 删除 [${actualStartIdx}, ${rootChildren.length})，共 ${rootChildren.length - actualStartIdx} 个 block`);
  batchDeleteChildren(docId, actualStartIdx, rootChildren.length);
  await sleep(500);

  // 3. 按顺序 append chapter N..end
  for (let i = startConcIdx; i < report.conclusions.length; i++) {
    const c = report.conclusions[i];
    console.log(`  → 章节 ${c.id}「${c.title}」`);
    await appendChapter(docId, chartsDir, c.id, c);
  }
  console.log(`  ✓ cascade 重建完成`);
}

// ─── verify after publish ───

function runVerify(docId, reportPath) {
  const verifyScript = path.resolve(__dirname, 'verify-doc.js');
  if (!fs.existsSync(verifyScript)) {
    console.warn(`⚠ verify-doc.js 未找到，跳过校验`);
    return;
  }
  console.log('\n→ verify-doc 校验...');
  const res = spawnSync(process.execPath, [verifyScript, '--doc-id', docId, '--report', reportPath], { encoding: 'utf-8' });
  for (const line of (res.stdout || '').split('\n').filter(Boolean)) console.log('  ' + line);
  if (res.status !== 0) {
    console.error('  ⚠ verify 未通过');
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docId = args['doc-id'];
  const reportPath = args.report;
  const conclusionId = parseInt(args['conclusion-id'], 10);
  const chartsDir = args['charts-dir'] ? path.resolve(args['charts-dir']) : CHARTS_DIR_DEFAULT;
  if (!docId || !reportPath || !conclusionId) {
    console.error('Usage: node bin/republish-chapter.js --doc-id <id> --report <report.json> --conclusion-id <N> [--cascade] [--no-verify]');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf-8'));
  const conclusion = report.conclusions.find(c => c.id === conclusionId);
  if (!conclusion) throw new Error(`报告无 conclusion id=${conclusionId}`);

  // 决策：含 image 强制 cascade；否则用 v1 insert_before（更高效）
  const forceCascade = !!args.cascade;
  const containsImage = hasImageCharts(conclusion);
  const useCascade = forceCascade || containsImage;
  if (containsImage && !forceCascade) {
    console.log(`ℹ 章节含 image，自动启用 cascade 模式`);
  }

  if (useCascade) {
    await v2CascadeMode(docId, report, conclusionId, chartsDir);
  } else {
    await v1InsertBeforeMode(docId, report, conclusionId, chartsDir);
  }

  console.log(`\n✓ 完成。📎 https://www.feishu.cn/docx/${docId}`);

  if (!args['no-verify'] && process.env.SKIP_VERIFY !== '1') {
    runVerify(docId, path.resolve(reportPath));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
