/**
 * publish-to-feishu.js
 *
 * 将 report JSON + 图表 PNG 发布为飞书文档。
 * 用法: node publish-to-feishu.js <report.json路径>
 * 前提: 已运行 render-charts.js 生成图表 PNG
 *
 * 文档结构（参照模板）：
 *   ### 背景说明（紧跟正文，无空行）
 *   --- + 数据口径定义
 *
 *   <callout> 主要结论（精炼要点）</callout>
 *
 *   ## 1. 章节标题（有序编号，主题式命名）
 *   - 章节总结（主 bullet + 子 bullet 展开）
 *   **表格/图表标题**
 *   <lark-table> 或 <image>
 *   <quote-container> 脚注
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { applyTableStyle } = require('./sheet-styler');

const CHARTS_DIR = path.join(__dirname, 'charts');
const TMP_MD = path.join(__dirname, '_tmp_content.md');
const TMP_JSON = path.join(__dirname, '_tmp_data.json');

// ─── lark-cli 调用 ───

function larkCli(...args) {
  try {
    const output = execFileSync('lark-cli', args, {
      encoding: 'utf-8', cwd: __dirname, shell: true, maxBuffer: 10 * 1024 * 1024,
    });
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    try { return JSON.parse(output); } catch { }
    console.error(`命令失败: lark-cli ${args.slice(0, 3).join(' ')}...\n${output.substring(0, 300)}`);
    return null;
  }
}

/**
 * 清空已有飞书文档的全部内容块（保留文档本身）
 * 使用 overwrite 模式替代 DELETE API（Windows 下 lark-cli DELETE 不工作）
 */
function clearDocContent(docId) {
  fs.writeFileSync(TMP_MD, '\u200b', 'utf-8');
  try {
    const output = execFileSync('bash', [
      '-c',
      `lark-cli docs +update --doc "${docId}" --mode overwrite --markdown "$(cat "${TMP_MD.replace(/\\/g, '/')}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    console.log('   🗑️ 已通过 overwrite 模式清空文档内容');
  } catch (e) {
    console.error(`   ⚠️ overwrite 清空失败: ${((e.stdout || '') + (e.stderr || '')).substring(0, 200)}`);
  }
}

/**
 * 创建飞书文档（通过 temp file 传递 markdown，避免 shell 解析）
 */
function createDoc(title, markdown) {
  fs.writeFileSync(TMP_MD, markdown, 'utf-8');
  try {
    const output = execFileSync('bash', [
      '-c',
      `lark-cli docs +create --title "${title}" --markdown "$(cat "${TMP_MD.replace(/\\/g, '/')}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    try { return JSON.parse(output); } catch { }
    console.error(`createDoc 失败:\n${output.substring(0, 300)}`);
    return null;
  }
}

function appendMarkdown(docId, markdown) {
  fs.writeFileSync(TMP_MD, markdown, 'utf-8');
  try {
    const output = execFileSync('bash', [
      '-c',
      `lark-cli docs +update --doc "${docId}" --mode append --markdown "$(cat "${TMP_MD.replace(/\\/g, '/')}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    try { return JSON.parse(output); } catch { }
    console.error(`appendMarkdown 失败:\n${output.substring(0, 300)}`);
    return null;
  }
}

/**
 * 在文档末尾创建空的内嵌 sheet block（block_type=30）。
 * 返回 { spreadsheetToken, sheetId, blockId }
 */
function createSheetBlock(docId, rowSize = 2, colSize = 2) {
  const body = JSON.stringify({ index: -1, children: [{ block_type: 30, sheet: { row_size: rowSize, column_size: colSize } }] });
  const tmpFile = path.join(__dirname, `_tmp_sheet_block_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, body, 'utf-8');
  try {
    const output = execFileSync('bash', [
      '-c',
      `lark-cli api POST "docx/v1/documents/${docId}/blocks/${docId}/children" --data "$(cat "${tmpFile.replace(/\\/g, '/')}")"`,
    ], { encoding: 'utf-8', cwd: __dirname });
    const result = JSON.parse(output);
    const block = result.data.children[0];
    const fullToken = block.sheet.token;
    const lastUnderscore = fullToken.lastIndexOf('_');
    return {
      spreadsheetToken: fullToken.substring(0, lastUnderscore),
      sheetId: fullToken.substring(lastUnderscore + 1),
      blockId: block.block_id,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * 推断列类型：根据数据值判断 text / int / number / percent。
 * 跳过差异行（值以 +/- 开头）做判断。
 * 日期类字符串（如 4/11、2026-04-11）强制识别为 text，避免飞书自动转日期触发警告。
 */
function inferColumnTypes(headers, rows) {
  const cols = headers.length;
  const types = [];
  const datePattern = /^\d{1,4}[\/\-]\d{1,2}([\/\-]\d{1,4})?(\s+\d{1,2}:\d{2}(:\d{2})?)?$/;
  for (let c = 0; c < cols; c++) {
    if (c === 0) { types.push('text'); continue; }
    const samples = rows
      .map(r => r[c])
      .filter(v => v !== null && v !== undefined && v !== '')
      .map(v => String(v).trim())
      .filter(s => !/^[+\-]/.test(s));
    if (samples.length === 0) { types.push('text'); continue; }
    if (samples.some(s => datePattern.test(s))) { types.push('text'); continue; }
    const allPercent = samples.every(s => /^\d+(\.\d+)?%$/.test(s));
    const allInt = samples.every(s => /^-?[\d,]+$/.test(s) && !s.includes('.'));
    const allNum = samples.every(s => /^-?[\d,]*\.?\d+$/.test(s));
    if (allPercent) types.push('percent');
    else if (allInt) types.push('int');
    else if (allNum) types.push('number');
    else types.push('text');
  }
  return types;
}

/**
 * 把表格 chart_data 转换为 applyTableStyle 需要的格式：
 * - "32.8%" → 0.328（percent 列）
 * - "4,732" → 4732（int 列）
 * - "+39.8%" / "-2.4%" → 保留字符串（classifyCell 会处理）
 */
function normalizeTableValues(rows, columnTypes) {
  return rows.map(row => row.map((v, c) => {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).trim();
    if (/^[+\-]/.test(s)) return s; // 差异格交给 classifyCell
    const t = columnTypes[c];
    if (t === 'percent') {
      const m = s.match(/^(-?\d+(?:\.\d+)?)%$/);
      if (m) return parseFloat(m[1]) / 100;
    }
    if (t === 'int') {
      const n = Number(s.replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
    if (t === 'number') {
      const n = Number(s.replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
    return s;
  }));
}

/**
 * 安全追加 bullet 列表：每条 bullet 单独 appendMarkdown 一次。
 *
 * 背景：lark-cli docs +update 在 append/replace_range/insert_after 等模式下，
 * 若 markdown 包含多条连续 `- ` bullet，会被折叠为单一 bullet，仅保留首行，
 * 后续行全部丢失（且接口仍返回 success:true，无报错）。
 *
 * 适用：所有非 callout 内的 bullet 列表（callout 是单 block，必须整块写入）。
 *
 * @param {string} docId
 * @param {string[]} bullets - 每条以 "- " 或 "  - " 开头的完整 bullet 行
 */
function appendBullets(docId, bullets) {
  for (const b of bullets) {
    const line = b.trim();
    if (!line) continue;
    appendMarkdown(docId, line + '\n');
  }
}

// ─── 格式化工具 ───

/**
 * 清洗 description 文本：
 * - 去掉 [结论点]、【结论点】
 * - 去掉 **核心证据链：** 等粗体段落标题行
 * - 去掉 **小结：** 及其后续内容
 * - 去掉所有 **加粗** 标记
 */
function cleanDescription(text) {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(/^[\[【]结论点[\]】]\s*/gm, '');
  cleaned = cleaned.replace(/\*\*小结[：:]\*\*[\s\S]*$/m, '');
  cleaned = cleaned.replace(/^\*\*[^*]+[：:]\*\*\s*$/gm, '');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * 将清洗后的 description 格式化为 bullet 列表。
 * 纯文本行 → 主 bullet（- ），已有 bullet 行 → 子 bullet（  - ）
 */
function formatDescription(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      // 已有 bullet → 变为子 bullet（缩进两格）
      result.push('  ' + trimmed);
    } else {
      // 纯文本 → 主 bullet
      result.push('- ' + trimmed);
    }
  }

  return result.join('\n') + '\n';
}

/**
 * 判断单元格值是否为数值型（含千分位、百分比、带符号数字）
 */
function isNumericCell(val) {
  if (typeof val === 'number') return true;
  if (typeof val !== 'string') return false;
  const s = val.trim();
  return /^[+\-]?[\d,]+(\.\d+)?(%|pp|min|次|人)?$/.test(s);
}

/**
 * 为变化率数值添加颜色标记：正值绿色，负值红色。
 * 匹配模式：+1.8%、-5.5%、+2.3pp、-0.8pp、+1,234、-567 等
 */
function colorizeCell(val) {
  if (typeof val !== 'string') return String(val == null ? '-' : val);
  const s = val.trim();
  if (/^-[\d,]+(\.\d+)?(%|pp|min|次|人)?$/.test(s)) {
    return `<text color="red">${s}</text>`;
  }
  if (/^\+[\d,]+(\.\d+)?(%|pp|min|次|人)?$/.test(s)) {
    return `<text color="green">${s}</text>`;
  }
  return s;
}

/**
 * 生成 <lark-table> 格式表格，每个 cell 单独设置 {align}：
 * - 表头：始终居中
 * - 数据行：数值右对齐，中文/文本居中
 * - 变化率自动着色：正值绿色，负值红色
 */
function toLarkTable(columns, rows, title, footnote) {
  const numRows = rows.length + 1;
  const numCols = columns.length;
  const colWidth = Math.floor(730 / numCols);
  const widths = columns.map(() => colWidth).join(',');

  const lines = [];
  if (title) lines.push(`**${title}**\n`);

  lines.push(`<lark-table rows="${numRows}" cols="${numCols}" header-row="true" column-widths="${widths}">`);
  lines.push('');

  // 表头行：全部居中
  lines.push('  <lark-tr>');
  for (const col of columns) {
    lines.push(`    <lark-td>\n      ${col}\n      {align="center"}\n    </lark-td>`);
  }
  lines.push('  </lark-tr>');

  // 数据行：数值右对齐，文本居中
  for (const row of rows) {
    lines.push('  <lark-tr>');
    for (const cell of row) {
      const cellStr = String(cell == null ? '-' : cell);
      const align = isNumericCell(cellStr) ? 'right' : 'center';
      const display = colorizeCell(cellStr);
      lines.push(`    <lark-td>\n      ${display}\n      {align="${align}"}\n    </lark-td>`);
    }
    lines.push('  </lark-tr>');
  }

  lines.push('</lark-table>');

  if (footnote) {
    lines.push('');
    lines.push(`<quote-container>\n*${footnote}*\n</quote-container>`);
  }

  return lines.join('\n');
}

/** 将 chart_data (table 类型) 转为 lark-table */
function tableDataToLarkTable(chartData) {
  if (!chartData || !chartData.columns || !chartData.rows) return '';
  return toLarkTable(chartData.columns, chartData.rows, chartData.title, chartData.footnote);
}

/** 将 chart series 数据转为 lark-table */
function chartSeriesToLarkTable(data) {
  if (!data || !data.x_labels || !data.series) return '';

  const seriesKeys = Object.keys(data.series);
  const columns = ['项目', ...seriesKeys];
  const rows = [];

  for (let i = 0; i < data.x_labels.length; i++) {
    const row = [data.x_labels[i]];
    seriesKeys.forEach(k => {
      const val = data.series[k][i];
      row.push(val == null ? '-' : typeof val === 'number' ? val.toLocaleString() : String(val));
    });
    rows.push(row);
  }

  return toLarkTable(columns, rows, data.title, data.footnote);
}

// ─── CSV 解析与数据附表 ───

/**
 * 解析 CSV 文件为 2D 数组，数值自动转为 number 类型
 */
function parseCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, ''); // 去 BOM
  const lines = content.trim().split('\n');
  return lines.map((line, lineIdx) => {
    return line.split(',').map(cell => {
      const trimmed = cell.trim();
      if (lineIdx === 0) return trimmed; // 表头保持字符串
      // 尝试转数值：纯数字、小数、负数
      if (trimmed !== '' && !isNaN(trimmed) && trimmed !== '') {
        const num = Number(trimmed);
        if (isFinite(num)) return num;
      }
      return trimmed;
    });
  });
}

/**
 * 收集 report 中所有 source_files（去重）
 */
function collectSourceFiles(report) {
  const seen = new Set();
  const files = [];
  for (const c of report.conclusions || []) {
    for (const sf of c.source_files || []) {
      if (sf.path && !seen.has(sf.path)) {
        seen.add(sf.path);
        files.push({ name: sf.name, path: sf.path });
      }
    }
  }
  return files;
}

/**
 * 通过 lark-cli 创建电子表格
 */
function createSpreadsheet(title) {
  return larkCli('sheets', '+create', '--title', title);
}

/**
 * 获取电子表格信息（含 sheet 列表）
 */
function getSpreadsheetInfo(token) {
  return larkCli('sheets', '+info', '--spreadsheet-token', token);
}

/**
 * 新增 sheet（工作表）— 通过 temp file 传 JSON 避免 shell 解析
 */
function addSheet(token, sheetTitle, index) {
  const data = { requests: [{ addSheet: { properties: { title: sheetTitle, index } } }] };
  fs.writeFileSync(TMP_JSON, JSON.stringify(data), 'utf-8');
  try {
    const tmpPath = TMP_JSON.replace(/\\/g, '/');
    const output = execFileSync('bash', [
      '-c',
      `lark-cli api POST "sheets/v2/spreadsheets/${token}/sheets_batch_update" --data "$(cat "${tmpPath}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(output);
    if (parsed.code === 0 && parsed.data && parsed.data.replies) {
      return parsed.data.replies[0].addSheet.properties.sheetId;
    }
    console.error(`addSheet 失败:`, parsed);
    return null;
  } catch (e) {
    console.error(`addSheet 异常: ${((e.stdout || '') + (e.stderr || '')).substring(0, 200)}`);
    return null;
  }
}

/**
 * 向指定 sheet 写入数据 — 通过 temp file 传 JSON
 */
function writeSheetData(token, sheetId, data) {
  fs.writeFileSync(TMP_JSON, JSON.stringify(data), 'utf-8');
  const tmpPath = TMP_JSON.replace(/\\/g, '/');
  try {
    const output = execFileSync('bash', [
      '-c',
      `lark-cli sheets +write --spreadsheet-token "${token}" --sheet-id "${sheetId}" --range "A1" --values "$(cat "${tmpPath}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    console.error(`writeSheetData 异常: ${((e.stdout || '') + (e.stderr || '')).substring(0, 200)}`);
    return null;
  }
}

/**
 * 重命名 sheet — 通过 temp file 传 JSON
 */
function renameSheet(token, sheetId, newTitle) {
  const data = { requests: [{ updateSheet: { properties: { sheetId, title: newTitle } } }] };
  fs.writeFileSync(TMP_JSON, JSON.stringify(data), 'utf-8');
  try {
    const tmpPath = TMP_JSON.replace(/\\/g, '/');
    execFileSync('bash', [
      '-c',
      `lark-cli api POST "sheets/v2/spreadsheets/${token}/sheets_batch_update" --data "$(cat "${tmpPath}")"`,
    ], { encoding: 'utf-8', cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.error(`renameSheet 异常: ${((e.stdout || '') + (e.stderr || '')).substring(0, 200)}`);
  }
}

/**
 * 发布数据附表到飞书电子表格
 * @param {object} report - report JSON
 * @param {string} dataDir - 数据目录
 * @param {string|null} existingToken - 复用已有附表 token（企业/个人 Feishu 切换时不要复用跨账号 token）
 */
function publishDataSheets(report, dataDir, existingToken) {
  const sourceFiles = collectSourceFiles(report);
  if (sourceFiles.length === 0) {
    console.log('   ⏭️ 无数据文件，跳过数据附表');
    return { token: null, url: null };
  }

  // 检查文件是否存在
  const validFiles = sourceFiles.filter(sf => {
    const fullPath = path.join(dataDir, sf.path);
    if (!fs.existsSync(fullPath)) {
      console.log(`   ⚠️ 数据文件不存在，跳过: ${sf.path}`);
      return false;
    }
    return true;
  });

  if (validFiles.length === 0) {
    console.log('   ⏭️ 所有数据文件不存在，跳过数据附表');
    return { token: null, url: null };
  }

  const title = ((report.meta && report.meta.title) || '数据分析报告') + ' - 数据附表';

  let token, sheetUrl;
  if (existingToken) {
    console.log(`   ♻️ 复用已有附表: ${existingToken}`);
    token = existingToken;
    sheetUrl = `https://feishu.cn/sheets/${existingToken}`;
  } else {
    console.log(`   📊 创建数据附表: ${title}`);
    const createResult = createSpreadsheet(title);
    if (!createResult || !createResult.ok) {
      console.error('   ❌ 数据附表创建失败', createResult);
      return { token: null, url: null };
    }
    token = createResult.data.spreadsheet_token;
    sheetUrl = createResult.data.url;
  }

  // 获取默认 sheet ID
  const info = getSpreadsheetInfo(token);
  const defaultSheetId = info && info.data && info.data.sheets && info.data.sheets.sheets
    ? info.data.sheets.sheets[0].sheet_id : null;

  for (let i = 0; i < validFiles.length; i++) {
    const sf = validFiles[i];
    const fullPath = path.join(dataDir, sf.path);
    const csvData = parseCSV(fullPath);

    // sheet 名取文件名（去后缀），截断到 30 字符（飞书限制）
    const sheetName = path.basename(sf.path, '.csv').substring(0, 30);

    let sheetId;
    if (i === 0 && defaultSheetId) {
      // 第一个文件写入默认 Sheet1 并重命名
      sheetId = defaultSheetId;
      renameSheet(token, sheetId, sheetName);
    } else {
      // 后续文件新增 sheet
      sheetId = addSheet(token, sheetName, i);
    }

    if (sheetId) {
      writeSheetData(token, sheetId, csvData);
      console.log(`   📋 [${i + 1}/${validFiles.length}] ${sheetName}`);
    } else {
      console.error(`   ❌ 无法创建 sheet: ${sheetName}`);
    }
  }

  return { token, url: sheetUrl };
}

/**
 * 追加发布历史归档（_publish_history.json）
 */
function appendPublishHistory(record) {
  const historyPath = path.join(__dirname, '..', 'reports', '_publish_history.json');
  let history = [];
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch { history = []; }
    if (!Array.isArray(history)) history = [];
  }
  history.push(record);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`   📚 已写入归档: ${historyPath}`);
}

// ─── 主流程 ───

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('用法: node publish-to-feishu.js <report.json路径>');
    process.exit(1);
  }

  const absPath = path.resolve(reportPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在: ${absPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  const title = (report.meta && report.meta.title) || '数据分析报告';

  console.log(`\n📄 发布报告: ${title}\n`);

  // 构建背景说明 markdown（仅含背景文本与小标题；定义 bullet 单独逐条插入避免折叠）
  let bgMd = '### 背景说明\n';
  if (report.context) {
    if (report.context.background) {
      bgMd += report.context.background + '\n';
    }
  }
  const definitions = (report.context && report.context.definitions) || [];
  const hasDefs = definitions.length > 0;
  if (hasDefs) {
    bgMd += '\n---\n\n**数据口径定义**\n';
  }

  // ── Step 1: 创建或复用文档 ──
  const docIdArg = process.argv.find(a => a.startsWith('--doc-id='));
  const existingDocId = docIdArg ? docIdArg.split('=')[1] : null;

  let docId;
  if (existingDocId) {
    // 复用已有文档：清空内容后重新写入
    console.log(`1️⃣  复用已有文档 ${existingDocId}，清空内容...`);
    docId = existingDocId;
    clearDocContent(docId);
    // 重新写入背景说明
    appendMarkdown(docId, bgMd);
  } else {
    // 新建文档
    console.log('1️⃣  创建飞书文档...');
    const createResult = createDoc(title, bgMd);
    if (!createResult || !createResult.ok) {
      console.error('文档创建失败', createResult);
      process.exit(1);
    }
    docId = createResult.data.doc_id;
  }

  // 定义 bullet 逐条追加（避免 lark-cli 多 bullet 折叠丢失）
  if (hasDefs) {
    appendBullets(
      docId,
      definitions.map(def => `- **${def.term}**：${def.desc}`),
    );
  }
  console.log(`   文档 ID: ${docId}`);

  const conclusions = report.conclusions || [];

  // ── Step 2: 主要结论（callout）──
  // 背景说明与 callout 之间加空行分隔
  console.log('2️⃣  写入主要结论（callout）...');
  appendMarkdown(docId, '\u200b\n');
  let summaryMd = '<callout emoji="clipboard" background-color="light-orange">\n';
  summaryMd += '#### 主要结论\n';

  if (report.summary && report.summary.overall) {
    const text = report.summary.overall;
    // Structured format: lines with **header** and - bullets
    if (text.includes('\n- ') || text.includes('\n**')) {
      const lines = text.split('\n').filter(s => s.trim());
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          // Module header — 前加空行确保飞书渲染为独立段落
          summaryMd += `\n${trimmed}\n`;
        } else if (trimmed.startsWith('- ')) {
          summaryMd += `${trimmed}\n`;
        } else {
          summaryMd += `- ${trimmed}\n`;
        }
      }
    } else {
      // Legacy format: split by 。；;
      const points = text.split(/[。；;]/).filter(s => s.trim());
      for (const p of points) {
        summaryMd += `- ${p.trim()}；\n`;
      }
    }
  }

  summaryMd += '</callout>\n';
  appendMarkdown(docId, summaryMd);

  // ── Step 3: 详细分析章节 ──
  console.log(`3️⃣  写入 ${conclusions.length} 个详细分析章节...\n`);

  for (let idx = 0; idx < conclusions.length; idx++) {
    const c = conclusions[idx];
    const chapterNum = idx + 1;

    // 章节间空行分隔（每章前都加，包括第一章与 callout 之间）
    appendMarkdown(docId, '\u200b\n');

    // 章节标题（有序编号）+ 描述（清洗后格式化为主/子 bullet，逐条追加避免折叠）
    appendMarkdown(docId, `## ${chapterNum}. ${c.title}\n`);
    if (c.description) {
      const cleaned = cleanDescription(c.description);
      const formatted = formatDescription(cleaned);
      const lines = formatted.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.length > 0);
      const bulletLines = lines.filter(l => /^\s*[-•] /.test(l));
      const nonBulletLines = lines.filter(l => !/^\s*[-•] /.test(l));
      if (nonBulletLines.length > 0) {
        // 非 bullet 文字段（罕见）整体追加
        appendMarkdown(docId, nonBulletLines.join('\n') + '\n');
      }
      if (bulletLines.length > 0) {
        appendBullets(docId, bulletLines);
      }
    }

    // ── 插入图表/表格 ──
    const insertChart = (chartFile, label, chartType, chartData) => {
      if (chartType === 'table' && chartData) {
        // 表格标题
        if (chartData.title) appendMarkdown(docId, `**${chartData.title}**\n`);

        // 创建内嵌 sheet block + 写值 + 应用样式
        const headers = chartData.columns;
        const rawRows = chartData.rows;
        const columnTypes = inferColumnTypes(headers, rawRows);
        const rows = normalizeTableValues(rawRows, columnTypes);
        try {
          const { spreadsheetToken, sheetId } = createSheetBlock(docId, rows.length + 1, headers.length);
          applyTableStyle({ token: spreadsheetToken, sheetId, headers, rows, columnTypes });
          console.log(`   📊 ${label} 内嵌 sheet 已创建 (${spreadsheetToken}_${sheetId})`);
        } catch (e) {
          console.error(`   ⚠️ ${label} 内嵌 sheet 创建失败，回退 lark-table:`, e.message.slice(0, 200));
          appendMarkdown(docId, tableDataToLarkTable(chartData) + '\n');
        }

        // 脚注
        if (chartData.footnote) {
          appendMarkdown(docId, `\n<quote-container>\n*${chartData.footnote}*\n</quote-container>\n`);
        }
        return;
      }

      // 图表标题
      if (chartData && chartData.title) {
        appendMarkdown(docId, `**${chartData.title}**\n`);
      }

      // 插入图表 PNG
      if (fs.existsSync(chartFile)) {
        const tmpFile = path.join(__dirname, `_tmp_chart_${label}.png`);
        fs.copyFileSync(chartFile, tmpFile);
        larkCli('docs', '+media-insert', '--doc', docId, '--file', `./_tmp_chart_${label}.png`, '--align', 'center');
        fs.unlinkSync(tmpFile);
        console.log(`   📊 ${label}.png 已插入`);
      }

      // 脚注
      if (chartData && chartData.footnote) {
        appendMarkdown(docId, `\n<quote-container>\n*${chartData.footnote}*\n</quote-container>\n`);
      }

      // 趋势图不追加数据表格
      if (chartType === 'line') {
        console.log(`   ⏭️ ${label} 为趋势图，跳过数据表格`);
        return;
      }

      // 非趋势图：追加数据表格（统一走内嵌 sheet）
      if (chartData && chartData.x_labels && chartData.series) {
        const xName = chartData.xAxisName || '项目';
        const seriesKeys = Object.keys(chartData.series);
        const headers = [xName, ...seriesKeys];
        const rawRows = chartData.x_labels.map((x, i) => {
          const row = [x];
          seriesKeys.forEach(k => {
            const v = chartData.series[k][i];
            row.push(v == null ? '' : v);
          });
          return row;
        });
        const columnTypes = inferColumnTypes(headers, rawRows);
        const rows = normalizeTableValues(rawRows, columnTypes);
        try {
          const { spreadsheetToken, sheetId } = createSheetBlock(docId, rows.length + 1, headers.length);
          applyTableStyle({ token: spreadsheetToken, sheetId, headers, rows, columnTypes });
          console.log(`   📊 ${label} 数据表内嵌 sheet 已创建 (${spreadsheetToken}_${sheetId})`);
        } catch (e) {
          console.error(`   ⚠️ ${label} 数据表 sheet 创建失败，回退 lark-table:`, e.message.slice(0, 200));
          appendMarkdown(docId, chartSeriesToLarkTable(chartData) + '\n');
        }
      }
    };

    // 主 chart_data
    if (c.chart_data) {
      const chartFile = path.join(CHARTS_DIR, `conclusion_${c.id}_main.png`);
      insertChart(chartFile, `conclusion_${c.id}_main`, c.chart_type, c.chart_data);
    }

    // 额外 charts[]
    if (c.charts && Array.isArray(c.charts)) {
      for (let i = 0; i < c.charts.length; i++) {
        const ch = c.charts[i];
        const chartFile = path.join(CHARTS_DIR, `conclusion_${c.id}_${i}.png`);
        insertChart(chartFile, `conclusion_${c.id}_${i}`, ch.type, ch.data);
      }
    }

    console.log(`   ✅ [${chapterNum}/${conclusions.length}] ${c.title}`);
  }

  // 清理临时文件
  if (fs.existsSync(TMP_MD)) fs.unlinkSync(TMP_MD);
  if (fs.existsSync(TMP_JSON)) fs.unlinkSync(TMP_JSON);

  console.log(`\n🎉 报告发布完成！`);
  console.log(`📎 飞书文档链接: https://www.feishu.cn/docx/${docId}`);

  // ── Step 4: 创建数据附表 ──
  console.log('\n4️⃣  创建数据附表...');
  // 数据目录：优先使用 --data-dir 参数，否则默认 ../data
  const dataDirArg = process.argv.find(a => a.startsWith('--data-dir='));
  const dataDir = dataDirArg
    ? path.resolve(dataDirArg.split('=')[1])
    : path.resolve(__dirname, '..', 'data');

  // 复用已有附表 token（仅同账号下有效，跨账号请勿传）
  const sheetTokenArg = process.argv.find(a => a.startsWith('--sheet-token='));
  const existingSheetToken = sheetTokenArg ? sheetTokenArg.split('=')[1] : null;

  const { token: sheetToken, url: sheetUrl } = publishDataSheets(report, dataDir, existingSheetToken);
  if (sheetUrl) {
    console.log(`📎 飞书数据附表链接: ${sheetUrl}`);
  }

  // ── Step 5: 写入发布历史归档 ──
  appendPublishHistory({
    timestamp: new Date().toISOString(),
    title,
    report_path: path.relative(path.resolve(__dirname, '..'), absPath).replace(/\\/g, '/'),
    doc_id: docId,
    doc_url: `https://www.feishu.cn/docx/${docId}`,
    sheet_token: sheetToken,
    sheet_url: sheetUrl,
    reused_doc: !!existingDocId,
    reused_sheet: !!existingSheetToken,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
