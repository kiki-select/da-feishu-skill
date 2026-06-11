// 内嵌 sheet 样式应用器：spec-driven，一次性把整张表的对齐/格式/着色处理完
// 用法：applyTableStyle({ token, sheetId, headers, rows, columnTypes, headerRows, mergeRanges, columnWidths })

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 关键修复：Windows 上不要走 cmd.exe `shell:true` 调 lark-cli.cmd —— 一旦 JSON 里有 `&` `|` 等
// cmd 元字符（如「中秋&国庆活动」），即使转义也容易出问题（cmd 的 `\"` 退引号 + 元字符切命令）。
// 直接 spawn node 跑 lark-cli 的真正入口脚本，args 通过 CreateProcess 直传，绕过 cmd 解析。
const LARK_CLI_ENTRY = (() => {
  if (process.platform !== 'win32') return null;
  const cmdPath = require('child_process').execSync('where lark-cli.cmd', { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
  if (!cmdPath) return null;
  const npmDir = path.dirname(cmdPath);
  const entry = path.join(npmDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  return fs.existsSync(entry) ? entry : null;
})();

function runCli(args) {
  let res;
  if (LARK_CLI_ENTRY) {
    res = spawnSync(process.execPath, [LARK_CLI_ENTRY, ...args], { encoding: 'utf-8', shell: false });
  } else {
    res = spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true });
  }
  if (res.status !== 0) {
    throw new Error(`lark-cli ${args.join(' ').slice(0, 80)}... failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return res.stdout;
}

const COLOR_GREEN = '#2BA471';
const COLOR_RED = '#D83931';
const COLOR_HEADER_BG = '#F2F2F2';

const ALIGN_LEFT = 0;
const ALIGN_CENTER = 1;
const ALIGN_RIGHT = 2;

const FORMATTERS = {
  text: '@',
  int: '#,##0',
  number: '#,##0.00',
  currency: '¥#,##0.00',
  percent: '0.00%',
  percent0: '0%',
};

function callApi(token, body) {
  const out = runCli(['api', 'PUT', `sheets/v2/spreadsheets/${token}/style`, '--data', JSON.stringify(body)]);
  return JSON.parse(out);
}

function callSheetsApi(method, endpoint, body) {
  const out = runCli(['api', method, endpoint, '--data', JSON.stringify(body)]);
  return JSON.parse(out);
}

function colLetter(idx) {
  let s = '';
  let n = idx;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

function rangeOf(sheetId, r1, c1, r2, c2) {
  return `${sheetId}!${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`;
}

function normalizeMergeRange(sheetId, range) {
  if (typeof range === 'string') {
    return range.includes('!') ? range : `${sheetId}!${range}`;
  }
  const startRow = range.startRow ?? range.start_row;
  const endRow = range.endRow ?? range.end_row;
  const startCol = range.startCol ?? range.start_col;
  const endCol = range.endCol ?? range.end_col;
  if ([startRow, endRow, startCol, endCol].some(v => v == null)) {
    throw new Error(`invalid merge range: ${JSON.stringify(range)}`);
  }
  return rangeOf(sheetId, startRow, startCol, endRow, endCol);
}

// 估算字符串显示宽度（像素）：中文/全角 14，ASCII 8
function measureWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef\u2e80-\u9fff]/.test(ch)) w += 14;
    else w += 8;
  }
  return w;
}

// 把数值按 formatter 渲染为飞书显示形式，用于宽度估算
function previewCell(value, columnType) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && columnType !== 'text' && /^[+\-][0-9.]+(%|pp|pt)$/.test(value.trim())) {
    return '';
  }
  if (typeof value === 'number') {
    if (columnType === 'int') return Math.round(value).toLocaleString('en-US');
    if (columnType === 'number') return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (columnType === 'currency') return '¥' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (columnType === 'percent') return (value * 100).toFixed(2) + '%';
    if (columnType === 'percent0') return Math.round(value * 100) + '%';
    return String(value);
  }
  return String(value);
}

// 自动列宽：取表头/单元格最大显示宽度 + padding，clamp 到 [70, 300]
function autoColumnWidths(headers, rows, columnTypes, headerRows = null) {
  return headers.map((h, c) => {
    const hasDisplayHeaders = Array.isArray(headerRows) && headerRows.length > 0;
    let max = hasDisplayHeaders ? 0 : measureWidth(h);
    if (hasDisplayHeaders) {
      for (const hr of headerRows) max = Math.max(max, measureWidth(hr[c] || ''));
    }
    for (const row of rows) {
      const display = previewCell(row[c], columnTypes[c]);
      max = Math.max(max, measureWidth(display));
    }
    return Math.max(70, Math.min(300, max + 24));
  });
}

// 推断单元格属性：返回 { value, hAlign, formatter, foreColor }
function classifyCell(value, columnType) {
  if (value === null || value === undefined || value === '') {
    return { value: '', hAlign: ALIGN_CENTER, formatter: null, foreColor: null };
  }
  // **关键：number 类型直接走 columnType formatter，不进入 diff 分支**
  // 否则 number -0.043 会被转成 string "-0.043" 误命中 diff 正则 → 红色文本，无 percent formatter
  if (typeof value === 'number') {
    if (columnType && FORMATTERS[columnType] !== undefined) {
      return { value, hAlign: ALIGN_RIGHT, formatter: FORMATTERS[columnType], foreColor: null };
    }
    return { value, hAlign: ALIGN_RIGHT, formatter: null, foreColor: null };
  }
  const str = String(value).trim();

  // 差异格：以 +/- 开头 + **必须有 %/pp/pt 单位**（避免裸负数被误判，per 2026-05-26 修复）
  const diffMatch = str.match(/^([+\-])([0-9.]+)(%|pp|pt)$/);
  if (diffMatch) {
    const sign = diffMatch[1];
    const num = parseFloat(diffMatch[2]);
    const unit = diffMatch[3];
    const color = sign === '+' ? COLOR_GREEN : COLOR_RED;

    // 差异格保留 + / - 符号和单位，避免列 formatter 把 +10.1% 显示成 10.10%。
    return { value: str, hAlign: ALIGN_RIGHT, formatter: '@', foreColor: color };
  }

  // 显式声明 text 列 → 内容是数值类字符串则右对齐，否则居中（防飞书自动转日期/数字）
  // 数值类匹配：纯数字 / 带千分位逗号 / 带小数 / 带 % 或 pp 或 pt 或 min 单位
  if (columnType === 'text') {
    const isNumericText = /^-?[\d,]+(\.\d+)?(%|pp|pt|min|天|次|元)?$/.test(str);
    return { value: str, hAlign: isNumericText ? ALIGN_RIGHT : ALIGN_CENTER, formatter: '@', foreColor: null };
  }

  // 数值列：根据 columnType 选 formatter
  if (columnType && FORMATTERS[columnType] !== undefined) {
    const num = typeof value === 'number' ? value : Number(str.replace(/,/g, ''));
    if (!isNaN(num)) {
      return { value: num, hAlign: ALIGN_RIGHT, formatter: FORMATTERS[columnType], foreColor: null };
    }
  }

  // 默认：文本居中
  return { value: str, hAlign: ALIGN_CENTER, formatter: null, foreColor: null };
}

/**
 * 一次性应用整张表的样式。
 * @param {object} opts
 * @param {string} opts.token - spreadsheet token
 * @param {string} opts.sheetId
 * @param {string[]} opts.headers - 逻辑列名（用于类型和默认表头）
 * @param {Array<Array>} opts.rows - 数据行（含差异行）
 * @param {string[]} opts.columnTypes - 每列类型：text|int|number|currency|percent|percent0
 * @param {Array<Array>} [opts.headerRows] - 可选多行展示表头；不传则用 headers 作为单行表头
 * @param {Array<string|object>} [opts.mergeRanges] - 可选合并区域，如 A1:A2、B1:D1
 * @param {boolean} [opts.freezeHeader=false] - 是否冻结首行（默认不冻结）
 * @param {number[]} [opts.columnWidths] - 每列宽度（像素），未传则自动：text列 140，数值列 90
 */
function applyTableStyle({ token, sheetId, headers, rows, columnTypes, headerRows = null, mergeRanges = null, freezeHeader = false, columnWidths = null }) {
  const cols = headers.length;
  const displayHeaders = Array.isArray(headerRows) && headerRows.length ? headerRows : [headers.slice()];
  const headerRowCount = displayHeaders.length;
  const totalRows = rows.length + headerRowCount;

  // 1. 写值（先写完再加样式，因为 formatter 需要 numeric value 才生效）
  const valuesMatrix = displayHeaders.map(row => row.slice());
  for (let r = 0; r < rows.length; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const cell = classifyCell(rows[r][c], columnTypes[c]);
      row.push(cell.value);
    }
    valuesMatrix.push(row);
  }
  const writeRange = rangeOf(sheetId, 1, 0, totalRows, cols - 1);
  runCli([
    'sheets', '+write',
    '--spreadsheet-token', token,
    '--sheet-id', sheetId,
    '--range', writeRange.split('!')[1],
    '--values', JSON.stringify(valuesMatrix),
  ]);

  // 2. 表头样式（粗体 + 居中 + 浅灰底）
  callApi(token, {
    appendStyle: {
      range: rangeOf(sheetId, 1, 0, headerRowCount, cols - 1),
      style: { font: { bold: true, fontSize: '10pt/1.5' }, hAlign: ALIGN_CENTER, vAlign: ALIGN_CENTER, backColor: COLOR_HEADER_BG },
    },
  });

  // 2.5 多维拆分表表头合并（失败不影响表格数据写入）
  if (Array.isArray(mergeRanges) && mergeRanges.length) {
    for (const mr of mergeRanges) {
      try {
        callSheetsApi('POST', `sheets/v2/spreadsheets/${token}/merge_cells`, {
          range: normalizeMergeRange(sheetId, mr),
          mergeType: 'MERGE_ALL',
        });
      } catch (e) {
        console.warn(`merge range failed: ${JSON.stringify(mr)} ${e.message.slice(0, 100)}`);
      }
    }
  }

  // 3. 数据列样式（按列分组：每列在所有数据行上的 formatter 一致；显式重置 foreColor 防止旧样式残留）
  for (let c = 0; c < cols; c++) {
    const colType = columnTypes[c];
    const formatter = FORMATTERS[colType] || null;
    const isText = colType === 'text';
    const baseStyle = {
      hAlign: isText ? ALIGN_CENTER : ALIGN_RIGHT,
      vAlign: ALIGN_CENTER,
      foreColor: '#000000',
    };
    if (formatter) baseStyle.formatter = formatter;
    callApi(token, {
      appendStyle: {
        range: rangeOf(sheetId, headerRowCount + 1, c, totalRows, c),
        style: baseStyle,
      },
    });
  }

  // 4. 差异单元格上色覆盖（+ 绿 / - 红，同时强制右对齐 + 单元格自己的 formatter 覆盖列默认）
  //    同时：text 列里的"数值类"文本单元格（如 "83.47" / "24.12"）也覆盖为右对齐，避免被列默认 center 拉走
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = classifyCell(rows[r][c], columnTypes[c]);
      if (cell.foreColor) {
        const overrideStyle = { hAlign: ALIGN_RIGHT, vAlign: ALIGN_CENTER, foreColor: cell.foreColor };
        if (cell.formatter) overrideStyle.formatter = cell.formatter;
        callApi(token, {
          appendStyle: {
            range: rangeOf(sheetId, r + headerRowCount + 1, c, r + headerRowCount + 1, c),
            style: overrideStyle,
          },
        });
      } else if (columnTypes[c] === 'text' && cell.hAlign === ALIGN_RIGHT) {
        // text 列里被识别为数值类字符串 → 单独右对齐覆盖
        callApi(token, {
          appendStyle: {
            range: rangeOf(sheetId, r + headerRowCount + 1, c, r + headerRowCount + 1, c),
            style: { hAlign: ALIGN_RIGHT, vAlign: ALIGN_CENTER, foreColor: '#000000' },
          },
        });
      }
    }
  }

  // 5. 列宽（默认按内容自动估算；可通过 columnWidths 覆盖）
  const widths = columnWidths || autoColumnWidths(headers, rows, columnTypes, displayHeaders);
  for (let c = 0; c < cols; c++) {
    try {
      runCli(['api', 'PUT', `sheets/v2/spreadsheets/${token}/dimension_range`, '--data',
        JSON.stringify({
          dimension: { sheetId, majorDimension: 'COLUMNS', startIndex: c + 1, endIndex: c + 1 },
          dimensionProperties: { visible: true, fixedSize: widths[c] },
        })]);
    } catch (e) { console.warn(`列 ${c} 宽度设置失败:`, e.message.slice(0, 100)); }
  }

  // 6. 冻结表头（POST，不是 PUT）
  if (freezeHeader) {
    try {
      runCli(['api', 'POST', `sheets/v2/spreadsheets/${token}/sheets_batch_update`, '--data',
        JSON.stringify({ requests: [{ updateSheet: { properties: { sheetId, frozenRowCount: headerRowCount } } }] })]);
    } catch (e) { console.warn('冻结表头失败:', e.message.slice(0, 100)); }
  }
}

module.exports = { applyTableStyle, FORMATTERS, COLOR_GREEN, COLOR_RED, COLOR_HEADER_BG };

// CLI 自测：node sheet-styler.js <spreadsheetToken> <sheetId>
if (require.main === module) {
  const TEST_TOKEN = process.argv[2] || '<spreadsheetToken>';
  const TEST_SHEET = process.argv[3] || '<sheetId>';
  applyTableStyle({
    token: TEST_TOKEN,
    sheetId: TEST_SHEET,
    headers: ['时间段', '指标A', '指标B', '占比'],
    rows: [
      ['本期', 4732, 0.328, 0.412],
      ['上期', 2359, 0.259, 0.343],
      ['去年同期', 3821, 0.297, 0.387],
      ['差异(VS 上期)', '+100.6%', '+6.9pp', '+20.1%'],
      ['差异(VS 去年同期)', '+23.8%', '+3.1pp', '+6.5%'],
    ],
    columnTypes: ['text', 'int', 'percent', 'percent'],
  });
  console.log('✅ 测试完成');
}
