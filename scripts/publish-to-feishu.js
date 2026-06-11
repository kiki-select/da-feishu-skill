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
const { validateReportFormat } = require('./report-builder');

let applyTableStyle;
let applyLarkTableAlign;

function loadLarkTableTools() {
  if (!applyTableStyle) {
    ({ applyTableStyle } = require('./sheet-styler'));
  }
  if (!applyLarkTableAlign) {
    ({ applyLarkTableAlign } = require('./patch-table-align'));
  }
}

const CHARTS_DIR = path.join(__dirname, 'charts');
const TMP_MD = path.join(__dirname, '_tmp_content.md');
const TMP_JSON = path.join(__dirname, '_tmp_data.json');

// ─── lark-cli 调用 ───

function larkCli(...args) {
  try {
    const output = spawnLarkCli(args);
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = e.message || ((e.stdout || '') + (e.stderr || ''));
    try { return JSON.parse(output); } catch { }
    console.error(`命令失败: lark-cli ${args.slice(0, 3).join(' ')}...\n${output.substring(0, 300)}`);
    return null;
  }
}

/**
 * 清空已有飞书文档的全部内容块（保留文档本身）
 * 使用 overwrite 模式替代 DELETE API（Windows 下 lark-cli DELETE 不工作）
 */
function clearDocContent(docId, replacementMd) {
  // 用 replacementMd 直接 overwrite 替代'先清空 + 再 append'两步法，避免 ZWS 留空 paragraph 导致标题与背景说明间空白
  const content = (replacementMd && replacementMd.length > 0) ? replacementMd : '​';
  fs.writeFileSync(TMP_MD, content, 'utf-8');
  try {
    spawnLarkCli(['docs', '+update', '--doc', docId, '--mode', 'overwrite', '--markdown', content]);
    console.log('   🗑️ 已通过 overwrite 模式清空文档内容');
  } catch (e) {
    console.error(`   ⚠️ overwrite 清空失败: ${(e.message || '').substring(0, 200)}`);
  }
}

/**
 * 创建飞书文档（通过 temp file 传递 markdown，避免 shell 解析）
 */
function createDoc(title, markdown) {
  fs.writeFileSync(TMP_MD, markdown, 'utf-8');
  try {
    const output = spawnLarkCli(['docs', '+create', '--title', title, '--markdown', markdown]);
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = e.message || ((e.stdout || '') + (e.stderr || ''));
    try { return JSON.parse(output); } catch { }
    console.error(`createDoc 失败:\n${output.substring(0, 300)}`);
    return null;
  }
}

function appendMarkdown(docId, markdown) {
  fs.writeFileSync(TMP_MD, markdown, 'utf-8');
  try {
    const output = spawnLarkCli(['docs', '+update', '--doc', docId, '--mode', 'append', '--markdown', markdown]);
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    const output = e.message || ((e.stdout || '') + (e.stderr || ''));
    try { return JSON.parse(output); } catch { }
    console.error(`appendMarkdown 失败:\n${output.substring(0, 300)}`);
    return null;
  }
}

/**
 * 在文档末尾创建空的内嵌 sheet block（block_type=30）。
 * 返回 { spreadsheetToken, sheetId, blockId }
 */
// Windows 上 lark-cli 是 .cmd 脚本，spawn shell:true 易因 `&` 等 cmd 元字符崩。
// 借鉴 sheet-styler 的修复：直接 spawn node 跑 lark-cli 的 JS 入口，shell:false 绕过 cmd。
const _path_for_lark_entry = require('path');
const _cp_for_lark_entry = require('child_process');
let LARK_CLI_ENTRY_PUB;

function getLarkCliEntry() {
  if (LARK_CLI_ENTRY_PUB !== undefined) return LARK_CLI_ENTRY_PUB;
  if (process.platform !== 'win32') {
    LARK_CLI_ENTRY_PUB = null;
    return LARK_CLI_ENTRY_PUB;
  }
  try {
    const cmdPath = _cp_for_lark_entry.execSync('where lark-cli.cmd', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/)[0].trim();
    if (!cmdPath) {
      LARK_CLI_ENTRY_PUB = null;
      return LARK_CLI_ENTRY_PUB;
    }
    const npmDir = _path_for_lark_entry.dirname(cmdPath);
    const entry = _path_for_lark_entry.join(npmDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    LARK_CLI_ENTRY_PUB = fs.existsSync(entry) ? entry : null;
    return LARK_CLI_ENTRY_PUB;
  } catch {
    LARK_CLI_ENTRY_PUB = null;
    return LARK_CLI_ENTRY_PUB;
  }
}

function spawnLarkCli(args) {
  const { spawnSync } = require('child_process');
  let res;
  const entry = getLarkCliEntry();
  if (entry) {
    res = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf-8', shell: false });
  } else {
    res = spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true });
  }
  if (res.status !== 0) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')}... failed:\nSTDOUT: ${res.stdout || ''}\nSTDERR: ${res.stderr || ''}`);
  }
  return res.stdout;
}

function createSheetBlock(docId, rowSize = 2, colSize = 2) {
  // 创建时 row_size/column_size 硬上限 9（docx block API 限制）；超出部分创建后通过 sheet dimension_range 扩容。
  const initialRow = Math.min(rowSize, 9);
  const initialCol = Math.min(colSize, 9);
  const body = JSON.stringify({ index: -1, children: [{ block_type: 30, sheet: { row_size: initialRow, column_size: initialCol } }] });
  let output;
  try {
    output = spawnLarkCli(['api', 'POST', `docx/v1/documents/${docId}/blocks/${docId}/children`, '--data', body]);
  } catch (e) {
    throw new Error(`createSheetBlock failed (rowSize=${initialRow}, colSize=${colSize}): ${e.message}`);
  }
  const result = JSON.parse(output);
  const block = result.data.children[0];
  const fullToken = block.sheet.token;
  const lastUnderscore = fullToken.lastIndexOf('_');
  return {
    spreadsheetToken: fullToken.substring(0, lastUnderscore),
    sheetId: fullToken.substring(lastUnderscore + 1),
    blockId: block.block_id,
  };
}

// 创建后通过 sheets v2 dimension_range 扩行（突破 docx block 9 行硬限）
function expandSheetRows(spreadsheetToken, sheetId, addCount) {
  if (addCount <= 0) return;
  const body = JSON.stringify({ dimension: { sheetId, majorDimension: 'ROWS', length: addCount } });
  spawnLarkCli(['api', 'POST', `sheets/v2/spreadsheets/${spreadsheetToken}/dimension_range`, '--data', body]);
}

function expandSheetColumns(spreadsheetToken, sheetId, addCount) {
  if (addCount <= 0) return;
  const body = JSON.stringify({ dimension: { sheetId, majorDimension: 'COLUMNS', length: addCount } });
  spawnLarkCli(['api', 'POST', `sheets/v2/spreadsheets/${spreadsheetToken}/dimension_range`, '--data', body]);
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
    if (t === 'number' || t === 'currency') {
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
    const output = spawnLarkCli(['api', 'POST', `sheets/v2/spreadsheets/${token}/sheets_batch_update`, '--data', JSON.stringify(data)]);
    const parsed = JSON.parse(output);
    if (parsed.code === 0 && parsed.data && parsed.data.replies) {
      return parsed.data.replies[0].addSheet.properties.sheetId;
    }
    console.error(`addSheet 失败:`, parsed);
    return null;
  } catch (e) {
    console.error(`addSheet 异常: ${(e.message || '').substring(0, 200)}`);
    return null;
  }
}

/**
 * 向指定 sheet 写入数据 — 通过 temp file 传 JSON
 */
function writeSheetData(token, sheetId, data) {
  fs.writeFileSync(TMP_JSON, JSON.stringify(data), 'utf-8');
  try {
    const output = spawnLarkCli(['sheets', '+write', '--spreadsheet-token', token, '--sheet-id', sheetId, '--range', 'A1', '--values', JSON.stringify(data)]);
    try { return JSON.parse(output); } catch { return { ok: true, raw: output }; }
  } catch (e) {
    console.error(`writeSheetData 异常: ${(e.message || '').substring(0, 200)}`);
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
    spawnLarkCli(['api', 'POST', `sheets/v2/spreadsheets/${token}/sheets_batch_update`, '--data', JSON.stringify(data)]);
  } catch (e) {
    console.error(`renameSheet 异常: ${(e.message || '').substring(0, 200)}`);
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

// ────────────────────────────────────────────────────────────
// Pre-publish validators (DA-activity mode only)
// ────────────────────────────────────────────────────────────

function collectAllStrings(obj, results = [], path = '$') {
  if (obj == null) return results;
  if (typeof obj === 'string') {
    results.push({ path, value: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectAllStrings(item, results, `${path}[${i}]`));
  } else if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      collectAllStrings(obj[k], results, `${path}.${k}`);
    }
  }
  return results;
}

function validateNoLarkTable(report) {
  const errors = [];
  const strs = collectAllStrings(report);
  for (const { path, value } of strs) {
    if (value.includes('<lark-table')) {
      errors.push(
        `[B1] ${path} 出现 <lark-table>，DA-activity 强制内嵌 sheet。\n` +
        `     修复：在 report JSON 中改 chart_type:'table'，由 publish 自动建 sheet block。\n` +
        `     违规片段：${value.slice(0, 100).replace(/\n/g, ' ')}...`
      );
    }
  }
  return errors;
}

function validateFootnoteLineBreak(report) {
  const errors = [];
  const strs = collectAllStrings(report);
  const reSameLine = /\*[^*\n]+\*\s*\*[^*\n]+\*/;             // B2-a：同行多 italic spans
  const reItalicSpan = /\*([^*\n]{1,500})\*/g;                // B2-b：单 italic span 内多定义
  for (const { path, value } of strs) {
    if (!path.endsWith('.footnote')) continue;
    const lines = value.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // B2-a：同行 ≥2 个 *xxx* spans
      if (reSameLine.test(lines[i])) {
        errors.push(
          `[B2-a] ${path} 第 ${i + 1} 行 footnote 同行多 italic spans 未换行。\n` +
          `       修复：每条定义独立成行用 \\n 分隔，禁止同行多 *xxx* *yyy*。\n` +
          `       违规行：${lines[i].slice(0, 120)}`
        );
      }
      // B2-b：单 span 内含 ≥2 个 ；或 ; 且 span 长度 ≥50 字符 → 疑似多定义未拆
      reItalicSpan.lastIndex = 0;
      let m;
      while ((m = reItalicSpan.exec(lines[i])) !== null) {
        const span = m[1];
        if (span.length < 50) continue;
        const semicolonCount = (span.match(/[；;]/g) || []).length;
        if (semicolonCount >= 2) {
          errors.push(
            `[B2-b] ${path} 第 ${i + 1} 行 footnote 单 italic span 内含 ${semicolonCount} 个分号 + 长度 ${span.length} 字符，疑似多定义未拆。\n` +
            `       修复：把分号分隔的定义拆为多个独立 *xxx* span，每条 \\n 换行。\n` +
            `       违规 span：*${span.slice(0, 100)}${span.length > 100 ? '...' : ''}*`
          );
        }
      }
    }
  }
  return errors;
}

// B5：检查 conclusions 所需 chart PNG 在 charts/ 目录都存在
function validateChartFiles(report) {
  const errors = [];
  const conclusions = report.conclusions || [];
  const PNG_REQUIRED_TYPES = new Set(['bar', 'line', 'pie', 'scatter', 'bar_line']);
  for (const c of conclusions) {
    if (c.chart_type && PNG_REQUIRED_TYPES.has(c.chart_type)) {
      const fname = `conclusion_${c.id}_main.png`;
      const fpath = path.join(CHARTS_DIR, fname);
      if (!fs.existsSync(fpath)) {
        errors.push(
          `[B5] 缺图：${fname}（conclusion ${c.id}.${c.title}，chart_type=${c.chart_type}）。\n` +
          `     根因常见：改了 report JSON conclusions 顺序/数量但忘了重渲染。\n` +
          `     修复：cd <skill>/scripts && rm -f charts/conclusion_*.png && node render-charts.js <report.json>`
        );
      }
    }
    if (Array.isArray(c.charts)) {
      for (let i = 0; i < c.charts.length; i++) {
        const ch = c.charts[i];
        if (ch.type && PNG_REQUIRED_TYPES.has(ch.type)) {
          const fname = `conclusion_${c.id}_${i}.png`;
          const fpath = path.join(CHARTS_DIR, fname);
          if (!fs.existsSync(fpath)) {
            errors.push(
              `[B5] 缺图：${fname}（conclusion ${c.id}.${c.title} 子图 [${i}]，type=${ch.type}）。\n` +
              `     修复同上：重渲染。`
            );
          }
        }
      }
    }
  }
  return errors;
}

const REQUIRED_CALLOUT_GROUPS = [
  '核心结论', '活动概况', '活动内容分析', '优化建议'
];

function validateCalloutGrouping(report) {
  const errors = [];
  const overall = (report.summary && report.summary.overall) || '';
  if (!overall) {
    errors.push(`[B3] report.summary.overall 为空，无法构造 callout 主要结论。`);
    return errors;
  }
  const headerRe = /(?:^|\n)\s*\*\*([^*\n]+)\*\*\s*(?:\n|$)/g;
  const foundGroups = [];
  const foundSet = new Set();
  let m;
  while ((m = headerRe.exec(overall)) !== null) {
    const g = m[1].trim();
    if (!foundSet.has(g)) {
      foundGroups.push(g);
      foundSet.add(g);
    }
  }
  const missing = REQUIRED_CALLOUT_GROUPS.filter(g => !foundSet.has(g));
  if (missing.length > 0) {
    errors.push(
      `[B3] callout 主要结论缺失必需分组：${missing.join(', ')}。\n` +
      `     已识别分组：${foundGroups.join(', ') || '(无)'}\n` +
      `     修复：见 SKILL.md「callout 主要结论分组规则」段；在 report.summary.overall 中按 **章节名** 标题行 + - bullet 形式补齐。`
    );
  }
  const foundRequiredInOrder = foundGroups.filter(g => REQUIRED_CALLOUT_GROUPS.includes(g));
  const expectedOrder = REQUIRED_CALLOUT_GROUPS.filter(g => foundSet.has(g));
  if (JSON.stringify(foundRequiredInOrder) !== JSON.stringify(expectedOrder)) {
    errors.push(
      `[B3] callout 必需分组顺序错乱。\n` +
      `     实际顺序：${foundRequiredInOrder.join(' → ')}\n` +
      `     期望顺序：${expectedOrder.join(' → ')}\n` +
      `     修复：调整 report.summary.overall 中 **xxx** 标题行的先后顺序。`
    );
  }
  return errors;
}

const CHAPTER_KEYWORDS = [
  { idx: 1, name: '大盘表现',     keywords: ['大盘'] },
  { idx: 2, name: '活动概况',     keywords: ['活动概况'] },
  { idx: 3, name: '效果归因',     keywords: ['效果归因', '归因'] },
  { idx: 4, name: '活动内容分析', keywords: ['活动内容', '内容分析', '内容层'] },
  { idx: 5, name: '优化建议',     keywords: ['优化建议', '下次优化'] },
];

function classifyConclusionTitle(title) {
  for (const c of CHAPTER_KEYWORDS) {
    if (c.keywords.some(k => title.includes(k))) return c;
  }
  return null;
}

function validateChapterOrder(report) {
  const errors = [];
  const conclusions = report.conclusions || [];
  if (conclusions.length === 0) {
    errors.push(`[B4] conclusions 数组为空。`);
    return errors;
  }
  const classified = [];
  for (let i = 0; i < conclusions.length; i++) {
    const c = classifyConclusionTitle(conclusions[i].title || '');
    if (!c) {
      errors.push(
        `[B4] conclusions[${i}].title="${conclusions[i].title}" 无法归类到 6 段任一章节。\n` +
        `     可用关键词：大盘 / 活动概况 / 效果归因 / 活动内容 / 亮点 / 不足 / 优化建议。`
      );
      classified.push(null);
    } else {
      classified.push(c);
    }
  }
  const requiredChapters = CHAPTER_KEYWORDS.filter(c => !c.optional);
  const presentIdx = new Set(classified.filter(Boolean).map(c => c.idx));
  const missing = requiredChapters.filter(c => !presentIdx.has(c.idx));
  if (missing.length > 0) {
    errors.push(
      `[B4] 必需章节缺失：${missing.map(c => `${c.idx}.${c.name}`).join(', ')}。\n` +
      `     修复：在 conclusions 数组中补齐章节（或缺数据时也要给空 conclusion + description 标注"本次未涉及，原因 XXX"）。`
    );
  }
  const actualOrder = classified.filter(Boolean).map(c => c.idx);
  const sortedOrder = [...actualOrder].sort((a, b) => a - b);
  if (JSON.stringify(actualOrder) !== JSON.stringify(sortedOrder)) {
    errors.push(
      `[B4] 章节顺序错乱。\n` +
      `     实际顺序：${actualOrder.map(i => CHAPTER_KEYWORDS.find(c => c.idx === i).name).join(' → ')}\n` +
      `     期望按 ①大盘 ②活动概况 ③效果归因 ④活动内容分析 ⑤优化建议 顺序（V1.3 = 5 章节，核心结论合并 callout，亮点&不足已废）。\n` +
      `     修复：调整 report.conclusions 数组元素顺序。`
    );
  }
  return errors;
}

// 通用格式强制（DA-feishu）：把手写 report.json 常犯的确定性格式错在发布前拦下
function validateGeneralFormat(report) {
  const errors = [...validateReportFormat(report)];
  const pctKw = /率|占比|留存|胜率|转化|渗透|参与率|完成率|领取率/;
  const checkTable = (cd, where) => {
    if (!cd || !Array.isArray(cd.columns) || !Array.isArray(cd.rows)) return;
    const ct = cd.column_types;
    if (!ct) { errors.push(`[FMT] ${where} 表缺 column_types（率列须 percent、单位进数值）`); return; }
    cd.columns.forEach((name, ci) => {
      if (pctKw.test(String(name)) && ct[ci] !== 'percent')
        errors.push(`[FMT] ${where} 列「${name}」含率/占比，column_types 为 ${ct[ci] || '缺'}，应为 percent`);
      if (ct[ci] === 'percent') {
        cd.rows.forEach((r, ri) => {
          const v = r[ci];
          if (typeof v === 'number' && v > 1.5)
            errors.push(`[FMT] ${where} 列「${name}」第${ri + 1}行值 ${v} > 1.5；percent 须传 0~1 小数（如 0.43 而非 43）`);
        });
      }
      // text 列的值其实是「纯数字+单位」(如 4.5s / 12秒 / 3.2万) → 居中且无法右对齐
      // 单位必须移到列名(如「时长均值(秒)」)、值传纯数字、类型改 float/int
      if (ct[ci] === 'text') {
        const unitRe = /^\s*-?\d+(?:\.\d+)?\s*(s|ms|秒|毫秒|分钟|min|h|小时|天|次|人|元|%|万|亿|pp)\s*$/i;
        const diffRe = /^\s*[+\-]\d+(?:\.\d+)?(?:%|pp|pt)\s*$/i;
        const bad = cd.rows.filter(r => unitRe.test(String(r[ci])) && !diffRe.test(String(r[ci])));
        if (bad.length)
          errors.push(`[FMT] ${where} 列「${name}」为 text 但值是「数字+单位」(如 ${String(bad[0][ci])})；单位须移到列名(如「${String(name)}(秒)」)、值传纯数字、column_types 改 float/int（数值居中=违规，必须右对齐）`);
      }
    });
  };
  (report.conclusions || []).forEach(c => {
    if (c.chart_type === 'table') checkTable(c.chart_data, `结论${c.id} 主表`);
    if (Array.isArray(c.charts)) {
      c.charts.forEach((ch, i) => {
        if (ch.chart_type || ch.chart_data)
          errors.push(`[FMT] 结论${c.id} charts[${i}] 用了 chart_type/chart_data，须改 type/data（否则子图被忽略、column_types 不生效）`);
        const t = ch.type || ch.chart_type, d = ch.data || ch.chart_data;
        if (t === 'table') checkTable(d, `结论${c.id} charts[${i}] 表`);
      });
      const hasTable = c.charts.some(ch => (ch.type || ch.chart_type) === 'table');
      if (['bar', 'pie', 'scatter', 'bar_line'].includes(c.chart_type) && hasTable && !(c.chart_data && c.chart_data.skip_data_table))
        errors.push(`[FMT] 结论${c.id} 柱/饼图已附显式表，主图 chart_data 须加 skip_data_table:true（否则自动追加裸数字重复表）`);
    }
  });
  return errors;
}

function preValidate(report, mode) {
  if (process.env.SKIP_VALIDATE === '1') {
    console.warn('⚠️  SKIP_VALIDATE=1：跳过所有 pre-publish 检测');
    return;
  }

  let errors;
  if (mode === 'activity') {
    // 活动路径保持原样
    errors = [
      ...validateNoLarkTable(report),
      ...validateFootnoteLineBreak(report),
      ...validateCalloutGrouping(report),
      ...validateChapterOrder(report),
      ...validateChartFiles(report),
    ];
  } else {
    // DA-feishu 通用格式强制（之前完全没校验，导致手写格式错频发）
    errors = [
      ...validateGeneralFormat(report),
      ...validateNoLarkTable(report),
      ...validateFootnoteLineBreak(report),
      ...validateChartFiles(report),
    ];
  }
  if (errors.length === 0) {
    console.log(`✅ pre-publish 检测通过（${mode === 'activity' ? 'DA-activity' : 'DA-feishu'} mode）`);
    return;
  }

  console.error('\n========== pre-publish 检测失败 ==========');
  errors.forEach(e => console.error(e + '\n'));
  console.error('==========================================');
  console.error(`共 ${errors.length} 处违规，发布已拦截。`);
  console.error(`修复后重跑；如需紧急绕过可加环境变量：SKIP_VALIDATE=1 node publish-to-feishu.js ...`);
  process.exit(1);
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
    console.error('用法: node publish-to-feishu.js <report.json路径> [--mode=activity] [--data-dir=...] [--doc-id=...]');
    process.exit(1);
  }

  const modeArg = process.argv.find(a => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'default';

  const absPath = path.resolve(reportPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在: ${absPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  const title = (report.meta && report.meta.title) || '数据分析报告';

  console.log(`\n📄 发布报告: ${title}\n`);

  preValidate(report, mode);

  // --validate-only：只跑格式校验，不发布（用于测试/CI，避免无谓全量发布烧 token）
  if (process.argv.includes('--validate-only')) {
    console.log('\n🔎 --validate-only：仅校验，未发布。');
    return;
  }

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
    clearDocContent(docId, bgMd);
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
      const lines = text.split('\n');
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          summaryMd += '\n';
          continue;
        }
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          // Module header — 前加空行确保飞书渲染为独立段落
          summaryMd += `\n${trimmed}  \n`;
        } else if (/^\s*[-•] /.test(rawLine)) {
          // 保留原始缩进（含 2-space sub-bullet 缩进）让飞书 callout 渲染嵌套
          summaryMd += `${rawLine}\n`;
        } else {
          summaryMd += `${trimmed}\n\n`;
          // Structured summary 支持「**模块名** + 普通判断句 + - 指标 bullet」。
          summaryMd += `${trimmed}\n`;
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

    // 章节标题（有序编号）+ 描述（清洗后保留嵌套缩进，整块 append 让飞书原生渲染嵌套 bullet）
    appendMarkdown(docId, `## ${chapterNum}. ${c.title}\n`);
    if (c.description) {
      const cleaned = cleanDescription(c.description);
      // 不再走 formatDescription/appendBullets（会强 trim 失去嵌套缩进），整块 append
      // 经实测 lark-cli docs +update --mode append 完整支持 markdown 嵌套 bullet 渲染
      appendMarkdown(docId, cleaned + '\n');
    }

    // ── 插入图表/表格 ──
    const insertChart = (chartFile, label, chartType, chartData) => {
      if (chartType === 'table' && chartData) {
        // 表格标题
        if (chartData.title) appendMarkdown(docId, `**${chartData.title}**\n`);

        // 创建内嵌 sheet block + 写值 + 应用样式
        const headers = chartData.columns;
        const rawRows = chartData.rows;
        const columnTypes = chartData.column_types || inferColumnTypes(headers, rawRows);
        const rows = normalizeTableValues(rawRows, columnTypes);

        // 飞书 sheet block 硬限：column_size ≤ 9（block 创建 + 服务端硬限，无法绕过）
        // row_size ≤ 9 仅 block 创建限制，创建后可通过 sheets/v2 dimension_range 扩行 → 单块容长表
        if (headers.length > 9 && process.env.FORCE_LARK_TABLE_FALLBACK === '1') {
          loadLarkTableTools();
          const stripped = { ...chartData, title: undefined, footnote: undefined };
          appendMarkdown(docId, tableDataToLarkTable(stripped) + '\n');
          try {
            applyLarkTableAlign({ docId, headers, rows: rawRows, columnTypes });
            console.log(`   📊 ${label} lark-table ${headers.length}列已写入并补齐对齐`);
          } catch (e) {
            console.error(`   ⚠️ ${label} lark-table align patch 失败:`, e.message.slice(0, 200));
          }
        } else {
          try {
            loadLarkTableTools();
            const headerRowCount = Array.isArray(chartData.header_rows) && chartData.header_rows.length ? chartData.header_rows.length : 1;
            const totalRows = rows.length + headerRowCount;
            const { spreadsheetToken, sheetId } = createSheetBlock(docId, totalRows, headers.length);
            if (totalRows > 9) {
              expandSheetRows(spreadsheetToken, sheetId, totalRows - 9);
              console.log(`   ↪ ${label} 扩行 ${totalRows - 9} 至 ${totalRows} 行（突破 docx block 9 行硬限）`);
            }
            if (headers.length > 9) {
              expandSheetColumns(spreadsheetToken, sheetId, headers.length - 9);
              console.log(`   ↪ ${label} 扩列 ${headers.length - 9} 至 ${headers.length} 列（突破 docx block 9 列创建限制）`);
            }
            applyTableStyle({
              token: spreadsheetToken,
              sheetId,
              headers,
              rows,
              columnTypes,
              headerRows: chartData.header_rows,
              mergeRanges: chartData.merge_ranges,
              columnWidths: chartData.column_widths,
            });
            console.log(`   📊 ${label} 内嵌 sheet 已创建 (${spreadsheetToken}_${sheetId}, ${totalRows} 行)`);
          } catch (e) {
            console.error(`   ⚠️ ${label} 内嵌 sheet 创建失败，回退 lark-table:`, e.message.slice(0, 2000));
            const stripped = { ...chartData, title: undefined, footnote: undefined };
            appendMarkdown(docId, tableDataToLarkTable(stripped) + '\n');
            try { loadLarkTableTools(); applyLarkTableAlign({ docId, headers, rows: rawRows, columnTypes }); } catch {}
          }
        }

        // 脚注
        if (chartData.footnote) {
          // 多行 footnote 每行单独 *italic* 包裹，用空行分隔确保飞书 quote-container 渲染为独立行
          // 不带 leading \n（lark-cli append 会把 leading \n 解析成空 paragraph 块，导致表格与脚注之间出现空行）
          const footLines = chartData.footnote.split('\n').map(l => l.trim()).filter(Boolean);
          const footMd = footLines.map(l => `*${l}*`).join('\n\n');
          appendMarkdown(docId, `<quote-container>\n${footMd}\n</quote-container>\n`);
        }
        return;
      }

      // 图表标题：line/bar/pie/scatter 类型由 ECharts 渲染到 PNG 顶部，publish 不再额外写 markdown 粗体标题（避免重复）
      // 仅 table 类型由更上方的分支处理（chart_data.title 用作 sheet 上方 bold）

      // 插入图表 PNG
      if (fs.existsSync(chartFile)) {
        const tmpFile = path.join(__dirname, `_tmp_chart_${label}.png`);
        fs.copyFileSync(chartFile, tmpFile);
        larkCli('docs', '+media-insert', '--doc', docId, '--file', `./_tmp_chart_${label}.png`, '--align', 'center');
        fs.unlinkSync(tmpFile);
        console.log(`   📊 ${label}.png 已插入`);
      }

      // 脚注（不带 leading \n，避免空 paragraph 块）
      if (chartData && chartData.footnote) {
        const footLines = chartData.footnote.split('\n').map(l => l.trim()).filter(Boolean);
        const footMd = footLines.map(l => `*${l}*`).join('\n\n');
        appendMarkdown(docId, `<quote-container>\n${footMd}\n</quote-container>\n`);
      }

      // 趋势图不追加数据表格
      if (chartType === 'line') {
        console.log(`   ⏭️ ${label} 为趋势图，跳过数据表格`);
        return;
      }

      // 允许 chart_data.skip_data_table:true 跳过自动追加（用于章节内已单独提供数据表的场景）
      if (chartData && chartData.skip_data_table) {
        console.log(`   ⏭️ ${label} 配置 skip_data_table，跳过自动追加数据表`);
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
        const columnTypes = chartData.column_types || inferColumnTypes(headers, rawRows);
        const rows = normalizeTableValues(rawRows, columnTypes);
        try {
          loadLarkTableTools();
          const { spreadsheetToken, sheetId } = createSheetBlock(docId, rows.length + 1, headers.length);
          if (headers.length > 9) expandSheetColumns(spreadsheetToken, sheetId, headers.length - 9);
          applyTableStyle({ token: spreadsheetToken, sheetId, headers, rows, columnTypes, columnWidths: chartData.column_widths });
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
  const sheetSkip = process.argv.includes('--sheet-skip');

  let sheetToken = null, sheetUrl = null;
  if (sheetSkip && existingSheetToken) {
    sheetToken = existingSheetToken;
    sheetUrl = `https://feishu.cn/sheets/${existingSheetToken}`;
    console.log(`\n4️⃣  跳过附表更新，复用链接: ${sheetUrl}`);
  } else {
    const r = publishDataSheets(report, dataDir, existingSheetToken);
    sheetToken = r.token; sheetUrl = r.url;
    if (sheetUrl) console.log(`📎 飞书数据附表链接: ${sheetUrl}`);
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

  // ── Step 6: 自动跑 verify-doc 校验（复用同目录通用 verify 工具）──
  // 检测：章节数 / 章节顺序 / image数 / sheet数 / 空白块
  // 失败时 warn 并 exit 1（doc 已发布，仅提示需后续修复）
  // SKIP_VERIFY=1 跳过（debug / 已知 verify 工具不适配该报告时用）
  if (process.env.SKIP_VERIFY === '1') {
    console.log('\n⚠️  SKIP_VERIFY=1：跳过 publish 后校验');
  } else {
    const verifyScript = path.resolve(__dirname, 'verify-doc.js');
    if (!fs.existsSync(verifyScript)) {
      console.warn(`\n⚠️  verify-doc.js 未找到 (${verifyScript})，跳过校验`);
    } else {
      console.log('\n5️⃣  跑 verify-doc.js 校验 doc 结构...');
      const res = execFileSync('node', [verifyScript, '--doc-id', docId, '--report', absPath], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
      }).split('\n').filter(Boolean);
      for (const line of res) console.log('  ' + line);
    }
  }
}

main().catch(err => {
  // 区分主流程错误与 verify FAIL（verify 失败时 execFileSync 抛出含 stdout 的 Error）
  if (err && err.stdout) {
    const out = err.stdout.toString();
    console.log('\n⚠️  publish 已完成但 verify 校验未通过：\n');
    for (const line of out.split('\n').filter(Boolean)) console.log('  ' + line);
    console.error('\n请按 verify 输出的 FAIL 项修复，可手动 cascade 或调 update-chapter');
    process.exit(2);  // exit 2 = doc 已发但 verify 失败（区别于 exit 1 = 发布失败）
  }
  console.error(err);
  process.exit(1);
});
