// 内嵌 sheet 样式应用器：spec-driven，一次性把整张表的对齐/格式/着色处理完
// 用法：applyTableStyle({ token, sheetId, headers, rows, columnTypes, diffRows })

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runCli(args) {
  const res = spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true });
  if (res.status !== 0) {
    throw new Error(`lark-cli ${args.join(' ').slice(0, 80)}... failed: ${res.stdout}\n${res.stderr}`);
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
  percent: '0.00%',
  percent0: '0%',
};

function callApi(token, body) {
  const out = runCli(['api', 'PUT', `"sheets/v2/spreadsheets/${token}/style"`, '--data', JSON.stringify(JSON.stringify(body))]);
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
  if (typeof value === 'number') {
    if (columnType === 'int') return Math.round(value).toLocaleString('en-US');
    if (columnType === 'number') return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (columnType === 'percent') return (value * 100).toFixed(2) + '%';
    if (columnType === 'percent0') return Math.round(value * 100) + '%';
    return String(value);
  }
  return String(value);
}

// 自动列宽：取表头/单元格最大显示宽度 + padding，clamp 到 [70, 300]
function autoColumnWidths(headers, rows, columnTypes) {
  return headers.map((h, c) => {
    let max = measureWidth(h);
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
  const str = String(value).trim();

  // 差异格：以 +/- 开头
  const diffMatch = str.match(/^([+\-])([0-9.]+)(%|pp|pt)?$/);
  if (diffMatch) {
    const sign = diffMatch[1];
    const num = parseFloat(diffMatch[2]);
    const unit = diffMatch[3] || '';
    const color = sign === '+' ? COLOR_GREEN : COLOR_RED;

    if (unit === '%') {
      // 纯百分比差 → 转 numeric (X% → X/100)，formatter "0.00%"
      const signed = sign === '-' ? -num / 100 : num / 100;
      return { value: signed, hAlign: ALIGN_RIGHT, formatter: '0.00%', foreColor: color };
    }
    // pp / pt / 无单位 → 保留文本，右对齐着色
    return { value: str, hAlign: ALIGN_RIGHT, formatter: null, foreColor: color };
  }

  // 显式声明 text 列 → 文本居中 + @ formatter（防飞书自动转日期/数字）
  if (columnType === 'text') {
    return { value: str, hAlign: ALIGN_CENTER, formatter: '@', foreColor: null };
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
 * @param {string[]} opts.headers - 第 1 行表头
 * @param {Array<Array>} opts.rows - 数据行（含差异行）
 * @param {string[]} opts.columnTypes - 每列类型：text|int|number|percent|percent0
 * @param {boolean} [opts.freezeHeader=false] - 是否冻结首行（默认不冻结）
 * @param {number[]} [opts.columnWidths] - 每列宽度（像素），未传则自动：text列 140，数值列 90
 */
function applyTableStyle({ token, sheetId, headers, rows, columnTypes, freezeHeader = false, columnWidths = null }) {
  const cols = headers.length;
  const totalRows = rows.length + 1;

  // 1. 写值（先写完再加样式，因为 formatter 需要 numeric value 才生效）
  const valuesMatrix = [headers.slice()];
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
    '--range', `"${writeRange.split('!')[1]}"`,
    '--values', JSON.stringify(JSON.stringify(valuesMatrix)),
  ]);

  // 2. 表头样式（粗体 + 居中 + 浅灰底）
  callApi(token, {
    appendStyle: {
      range: rangeOf(sheetId, 1, 0, 1, cols - 1),
      style: { font: { bold: true, fontSize: '10pt/1.5' }, hAlign: ALIGN_CENTER, vAlign: ALIGN_CENTER, backColor: COLOR_HEADER_BG },
    },
  });

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
        range: rangeOf(sheetId, 2, c, totalRows, c),
        style: baseStyle,
      },
    });
  }

  // 4. 差异单元格上色覆盖（+ 绿 / - 红，同时强制右对齐 + 单元格自己的 formatter 覆盖列默认）
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = classifyCell(rows[r][c], columnTypes[c]);
      if (cell.foreColor) {
        const overrideStyle = { hAlign: ALIGN_RIGHT, vAlign: ALIGN_CENTER, foreColor: cell.foreColor };
        if (cell.formatter) overrideStyle.formatter = cell.formatter;
        callApi(token, {
          appendStyle: {
            range: rangeOf(sheetId, r + 2, c, r + 2, c),
            style: overrideStyle,
          },
        });
      }
    }
  }

  // 5. 列宽（默认按内容自动估算；可通过 columnWidths 覆盖）
  const widths = columnWidths || autoColumnWidths(headers, rows, columnTypes);
  for (let c = 0; c < cols; c++) {
    try {
      runCli(['api', 'PUT', `"sheets/v2/spreadsheets/${token}/dimension_range"`, '--data',
        JSON.stringify(JSON.stringify({
          dimension: { sheetId, majorDimension: 'COLUMNS', startIndex: c + 1, endIndex: c + 1 },
          dimensionProperties: { visible: true, fixedSize: widths[c] },
        }))]);
    } catch (e) { console.warn(`列 ${c} 宽度设置失败:`, e.message.slice(0, 100)); }
  }

  // 6. 冻结表头（POST，不是 PUT）
  if (freezeHeader) {
    try {
      runCli(['api', 'POST', `"sheets/v2/spreadsheets/${token}/sheets_batch_update"`, '--data',
        JSON.stringify(JSON.stringify({ requests: [{ updateSheet: { properties: { sheetId, frozenRowCount: 1 } } }] }))]);
    } catch (e) { console.warn('冻结表头失败:', e.message.slice(0, 100)); }
  }
}

module.exports = { applyTableStyle, FORMATTERS, COLOR_GREEN, COLOR_RED, COLOR_HEADER_BG };

// CLI 自测：node sheet-styler.js
if (require.main === module) {
  const TEST_TOKEN = 'BJblsI2ZchgyFYtd6hZc950znIc';
  const TEST_SHEET = '5yIRd0';
  applyTableStyle({
    token: TEST_TOKEN,
    sheetId: TEST_SHEET,
    headers: ['时间段', '日均DAU', '新增次留', '参与率'],
    rows: [
      ['V62更新后', 4732, 0.328, 0.412],
      ['V62更新前', 2359, 0.259, 0.343],
      ['V61更新后', 3821, 0.297, 0.387],
      ['差异(VS更新前)', '+100.6%', '+6.9pp', '+20.1%'],
      ['差异(VS V61)', '+23.8%', '+3.1pp', '+6.5%'],
    ],
    columnTypes: ['text', 'int', 'percent', 'percent'],
  });
  console.log('✅ 测试完成');
}
