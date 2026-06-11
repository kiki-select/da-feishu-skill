// 通用报告构建器（DA-feishu）：从源头产出"格式正确"的 report.json，杜绝手写常犯的
// charts[] 字段名 / 率列非 percent / percent 值>1 / 柱图缺 skip_data_table 等错误。
// 用法见底部示例。所有产物可直接 render-charts.js + publish-to-feishu.js。

// 列类型：'text' | 'int' | 'number' | 'currency' | 'percent'
// 含率/占比/留存/胜率/转化/参与率/完成率/领取率 的列名默认推断为 percent（可显式覆盖）
const PCT = /率|占比|留存|胜率|转化|渗透|参与率|完成率|领取率/;
function inferType(label, sampleVals) {
  if (PCT.test(String(label))) return 'percent';
  const nums = sampleVals.filter(v => typeof v === 'number');
  if (nums.length && nums.every(v => Number.isInteger(v))) return 'int';
  if (nums.length) return 'number';
  return 'text';
}

// 表格：columns 可为 ['名',...] 或 [{label,type}]；rows 为二维数组；自动补 column_types、校验 percent
function table(title, columns, rows, footnote, opts = {}) {
  const labels = columns.map(c => (typeof c === 'string' ? c : c.label));
  const types = columns.map((c, i) => {
    if (typeof c === 'object' && c.type) return c.type;
    return inferType(labels[i], rows.map(r => r[i]));
  });
  // 校验 + 规范化 percent：值若 >1.5 视为传成了百分数，自动 /100 并告警
  rows.forEach((r, ri) => types.forEach((t, ci) => {
    if (t === 'percent' && typeof r[ci] === 'number' && r[ci] > 1.5) {
      console.warn(`[builder] 表「${title}」列「${labels[ci]}」第${ri + 1}行 ${r[ci]} 疑似百分数，自动转 ${r[ci] / 100}`);
      r[ci] = +(r[ci] / 100).toFixed(6);
    }
  }));
  const data = { title, columns: labels, rows, column_types: types, footnote };
  if (opts.column_widths) data.column_widths = opts.column_widths;
  if (opts.header_rows) data.header_rows = opts.header_rows;
  if (opts.merge_ranges) data.merge_ranges = opts.merge_ranges;
  return { type: 'table', data };
}

// 主图：bar/line/pie 等。series 为 {系列名:[...]}（百分比序列名建议带 (%)）。
function chart(chartType, title, x_labels, series, footnote, opts = {}) {
  const cd = { title, x_labels, series, footnote };
  if (opts.skipDataTable) cd.skip_data_table = true;
  return { chart_type: chartType, chart_data: cd };
}

// 组装一个 conclusion：main=主图(chart()返回) 或 主表(table()返回)；extraTables=附加表(table()返回)数组
// 主图为柱/饼且带附表时，自动给主图加 skip_data_table，避免自动追加裸数字表
function conclusion({ id, title, importance = 'medium', description, data_support, main, tables = [] }) {
  const c = { id, title, importance, description, data_support };
  if (main.type === 'table') {            // 主体就是表
    c.chart_type = 'table'; c.chart_data = main.data;
  } else {                                // 主体是图
    c.chart_type = main.chart_type; c.chart_data = main.chart_data;
    if (tables.length && ['bar', 'pie', 'scatter', 'bar_line'].includes(c.chart_type))
      c.chart_data.skip_data_table = true;
  }
  if (tables.length) c.charts = tables;    // 附表统一进 charts[]（type/data 结构，正确）
  return c;
}

function buildReport({ meta, context, summaryText, conclusions }) {
  const hi = conclusions.filter(c => c.importance === 'high').length;
  return { meta, context,
    summary: { overall: summaryText, total_conclusions: conclusions.length, high_importance_count: hi, source_files: [] },
    conclusions };
}

function validateReportFormat(report) {
  const errors = [];
  const conclusions = report && Array.isArray(report.conclusions) ? report.conclusions : [];
  if (!report || typeof report !== 'object') return ['[builder] report 必须是对象'];
  if (!report.meta || !report.meta.title) errors.push('[builder] meta.title 缺失');
  if (!report.summary || typeof report.summary.overall !== 'string') errors.push('[builder] summary.overall 缺失');
  if (!conclusions.length) errors.push('[builder] conclusions 为空');

  const checkTable = (data, where) => {
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      errors.push(`[builder] ${where} table 缺 columns/rows`);
      return;
    }
    if (!Array.isArray(data.column_types)) {
      errors.push(`[builder] ${where} table 缺 column_types`);
      return;
    }
    if (Array.isArray(data.header_rows)) {
      data.header_rows.forEach((row, ri) => {
        if (!Array.isArray(row) || row.length !== data.columns.length) {
          errors.push(`[builder] ${where} header_rows[${ri}] length 必须等于 columns.length`);
        }
      });
    }
    if (Array.isArray(data.column_widths) && data.column_widths.length !== data.columns.length) {
      errors.push(`[builder] ${where} column_widths length 必须等于 columns.length`);
    }
    data.columns.forEach((name, ci) => {
      const t = data.column_types[ci];
      if (PCT.test(String(name)) && t !== 'percent') {
        errors.push(`[builder] ${where} 列「${name}」应为 percent`);
      }
      if (t === 'percent') {
        data.rows.forEach((row, ri) => {
          const v = row[ci];
          if (typeof v === 'number' && v > 1.5) {
            errors.push(`[builder] ${where} 列「${name}」第 ${ri + 1} 行 percent 应为 0~1 小数，当前 ${v}`);
          }
        });
      }
    });
  };

  conclusions.forEach((c, i) => {
    const where = `结论${c.id || i + 1}`;
    if (!c.id) errors.push(`[builder] conclusions[${i}] 缺 id`);
    if (!c.title) errors.push(`[builder] ${where} 缺 title`);
    if (!c.description) errors.push(`[builder] ${where} 缺 description`);
    if (!c.data_support) errors.push(`[builder] ${where} 缺 data_support`);
    if (!c.chart_type) errors.push(`[builder] ${where} 缺 chart_type`);
    if (!c.chart_data) errors.push(`[builder] ${where} 缺 chart_data`);
    if (c.chart_type === 'table') checkTable(c.chart_data, `${where} 主表`);

    if (Array.isArray(c.charts)) {
      c.charts.forEach((ch, idx) => {
        if (ch.chart_type || ch.chart_data) {
          errors.push(`[builder] ${where} charts[${idx}] 必须使用 type/data，不能使用 chart_type/chart_data`);
        }
        if ((ch.type || ch.chart_type) === 'table') checkTable(ch.data || ch.chart_data, `${where} charts[${idx}]`);
      });
      const hasExplicitTable = c.charts.some(ch => (ch.type || ch.chart_type) === 'table');
      if (hasExplicitTable && ['bar', 'pie', 'scatter', 'bar_line'].includes(c.chart_type) && !(c.chart_data && c.chart_data.skip_data_table)) {
        errors.push(`[builder] ${where} 主图已有显式附表，chart_data.skip_data_table 必须为 true`);
      }
    }
  });

  return errors;
}

module.exports = { table, chart, conclusion, buildReport, validateReportFormat };

/* 示例：
const B = require('./report-builder');
const c2 = B.conclusion({ id:2, title:'指标X 趋势', importance:'high',
  description:'...', data_support:'...',
  main: B.chart('line','各分组指标X逐日',['05/15','05/16'],{'分组A':[44,45],'分组B':[46,48]},'5/29起为某变更上线'),
  tables: [ B.table('变更前后对比（同口径）', ['分组','变更前','变更后','变化'],
              [['分组B',0.454,0.500,'+4.6pp']], '前5/22–24、后5/29–31') ]
});
*/
