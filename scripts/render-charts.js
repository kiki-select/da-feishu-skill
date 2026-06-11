/**
 * render-charts.js
 *
 * 将 report JSON 中的图表数据渲染为 PNG 图片。
 * 用法: node render-charts.js <report.json路径>
 * 输出: charts/ 目录下按 conclusion_{id}_{index}.png 命名的图片
 */

const echarts = require('echarts');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CHART_COLORS = ['#2d5a4a', '#c45c3c', '#d4a853', '#8ba888', '#a0522d', '#6b8e7d', '#d98a5c'];
const WIDTH = 900;
const HEIGHT = 480;

function needsRotation(labels) {
  if (!labels || labels.length <= 20) return false;
  const avgLen = labels.reduce((s, l) => s + String(l).length, 0) / labels.length;
  return avgLen > 3 || labels.length > 25;
}

function buildLineOption(data) {
  const seriesKeys = Object.keys(data.series || {});
  const rotate = needsRotation(data.x_labels) ? 30 : 0;
  const dualAxis = !!(data.yAxisLeft || data.yAxisRight);
  // 单系列时图例与标题语义重复（如「DAU」），自动隐藏
  const showLegend = seriesKeys.length > 1;
  const hasTitle = !!(data.title && String(data.title).trim());
  // 动态 grid.top：title + legend 都没就贴边
  const gridTop = hasTitle && showLegend ? 75 : hasTitle ? 50 : showLegend ? 40 : 15;
  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'axis' },
    legend: showLegend ? { data: seriesKeys, top: 35, textStyle: { fontSize: 12 } } : { show: false },
    grid: { top: gridTop, bottom: rotate ? 60 : 35, left: 65, right: dualAxis ? 65 : 30 },
    xAxis: { type: 'category', data: data.x_labels || [], axisLabel: { fontSize: 10, rotate } },
    yAxis: dualAxis
      ? [
          { type: 'value', name: data.yAxisLeft || '', position: 'left' },
          { type: 'value', name: data.yAxisRight || '', position: 'right', splitLine: { show: false } },
        ]
      : { type: 'value', name: data.yAxisName || '' },
    series: seriesKeys.map((key, i) => ({
      name: key,
      type: 'line',
      data: data.series[key],
      yAxisIndex: dualAxis ? (i === 0 ? 0 : 1) : 0,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2.5 },
      itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
    })),
  };
}

function buildBarOption(data) {
  const xKey = data.xKey || 'name';
  let chartData = [];
  let seriesKeys = [];

  if (data.data && Array.isArray(data.data)) {
    chartData = data.data;
    seriesKeys = Object.keys(chartData[0] || {}).filter(k => k !== xKey);
  } else if (data.x_labels && data.series) {
    seriesKeys = Object.keys(data.series);
    chartData = data.x_labels.map((label, i) => {
      const item = { [xKey]: label };
      seriesKeys.forEach(k => { item[k] = data.series[k][i]; });
      return item;
    });
  }

  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'axis' },
    legend: { data: seriesKeys, top: 35, textStyle: { fontSize: 12 } },
    grid: { top: 75, bottom: 50, left: 65, right: 30 },
    xAxis: { type: 'category', data: chartData.map(d => d[xKey]), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: data.yAxisName || '' },
    series: seriesKeys.map((key, i) => ({
      name: key,
      type: 'bar',
      data: chartData.map(d => d[key]),
      itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length], borderRadius: [3, 3, 0, 0] },
    })),
  };
}

function buildPieOption(data) {
  const chartData = data.data || [];
  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', left: 'left', top: 50, textStyle: { fontSize: 12 } },
    series: [{
      type: 'pie',
      radius: ['35%', '65%'],
      center: ['55%', '55%'],
      data: chartData.map((item, i) => ({
        ...item,
        itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
      })),
      label: { formatter: '{b}\n{d}%', fontSize: 11 },
    }],
  };
}

function buildBarLineOption(data) {
  const barKeys = Object.keys(data.bar_series || {});
  const lineKeys = Object.keys(data.line_series || {});
  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'axis' },
    legend: { data: [...barKeys, ...lineKeys], top: 35, textStyle: { fontSize: 12 } },
    grid: { top: 75, bottom: 50, left: 65, right: 65 },
    xAxis: { type: 'category', data: data.x_labels || [], axisLabel: { fontSize: 10, rotate: data.x_labels && data.x_labels.length > 10 ? 30 : 0 } },
    yAxis: [
      { type: 'value', name: data.yAxisLeft || '', position: 'left' },
      { type: 'value', name: data.yAxisRight || '', position: 'right', splitLine: { show: false } },
    ],
    series: [
      ...barKeys.map((key, i) => ({
        name: key,
        type: 'bar',
        yAxisIndex: 0,
        data: data.bar_series[key],
        itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length], borderRadius: [3, 3, 0, 0] },
      })),
      ...lineKeys.map((key, i) => ({
        name: key,
        type: 'line',
        yAxisIndex: 1,
        data: data.line_series[key],
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2.5 },
        itemStyle: { color: CHART_COLORS[(barKeys.length + i) % CHART_COLORS.length] },
      })),
    ],
  };
}

function buildScatterOption(data) {
  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'item' },
    grid: { top: 60, bottom: 50, left: 65, right: 30 },
    xAxis: { type: 'value', name: data.xLabel || '' },
    yAxis: { type: 'value', name: data.yLabel || '' },
    series: [{
      type: 'scatter',
      data: data.data || [],
      symbolSize: 8,
      itemStyle: { color: CHART_COLORS[0] },
    }],
  };
}

function buildOption(type, data) {
  // 预处理：column_types 中的 percent / percent0 列，把 0~1 小数转为 0~100 用于画图
  // 同时给 series 名加 "(%)" 后缀，明示 Y 轴/图例单位（visualization-rules: 轴标签必须标注单位）
  if (data && data.column_types) {
    const types = data.column_types;
    const scale = v => (v == null ? null : v * 100);
    const transform = (series) => {
      if (!series) return series;
      const keys = Object.keys(series);
      const newS = {};
      keys.forEach((k, i) => {
        const t = types[i + 1]; // index 0 是 x_labels 列
        if (t === 'percent' || t === 'percent0') {
          // 重命名加 (%) 后缀；如果用户已经加了就不重复
          const newKey = k.endsWith('(%)') ? k : `${k}(%)`;
          newS[newKey] = series[k].map(scale);
        } else {
          newS[k] = series[k];
        }
      });
      return newS;
    };
    data = { ...data };
    if (data.series) data.series = transform(data.series);
    if (data.bar_series) data.bar_series = transform(data.bar_series);
    if (data.line_series) data.line_series = transform(data.line_series);
  }
  switch (type) {
    case 'line': return buildLineOption(data);
    case 'bar': return buildBarOption(data);
    case 'pie': return buildPieOption(data);
    case 'bar_line': return buildBarLineOption(data);
    case 'scatter': return buildScatterOption(data);
    default: return null;
  }
}

async function renderToPNG(option, outPath) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: WIDTH, height: HEIGHT });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

async function verifyHighConclusionCharts(report, chartsDir) {
  const failures = [];
  const conclusions = report.conclusions || [];

  for (const c of conclusions) {
    if (c.importance !== 'high') continue;

    const expected = [];
    if (c.chart_type && c.chart_type !== 'table' && c.chart_data) {
      expected.push(`conclusion_${c.id}_main.png`);
    }
    if (Array.isArray(c.charts)) {
      c.charts.forEach((ch, i) => {
        if (ch.type && ch.type !== 'table') expected.push(`conclusion_${c.id}_${i}.png`);
      });
    }

    for (const filename of expected) {
      const filePath = path.join(chartsDir, filename);
      if (!fs.existsSync(filePath)) {
        failures.push(`结论 ${c.id} (${c.title}) 缺少 high 图表 ${filename}`);
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.size < 1024) {
        failures.push(`结论 ${c.id} (${c.title}) 图表 ${filename} 文件过小 (${stat.size} bytes)`);
        continue;
      }
      const meta = await sharp(filePath).metadata();
      if (!meta.width || !meta.height) {
        failures.push(`结论 ${c.id} (${c.title}) 图表 ${filename} 无有效尺寸`);
      }
    }
  }

  if (failures.length) {
    console.error('\nhigh 重要结论图核查失败：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }

  console.log('high 重要结论图核查通过');
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('用法: node render-charts.js <report.json路径>');
    process.exit(1);
  }

  const absPath = path.resolve(reportPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在: ${absPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  const chartsDir = path.join(__dirname, 'charts');
  if (!fs.existsSync(chartsDir)) fs.mkdirSync(chartsDir, { recursive: true });

  // 清理旧图表
  fs.readdirSync(chartsDir).filter(f => f.endsWith('.png')).forEach(f => fs.unlinkSync(path.join(chartsDir, f)));

  const conclusions = report.conclusions || [];
  let count = 0;

  for (const c of conclusions) {
    // 1. 主 chart_data（非 table 类型）
    if (c.chart_type && c.chart_type !== 'table' && c.chart_data) {
      const option = buildOption(c.chart_type, c.chart_data);
      if (option) {
        const filename = `conclusion_${c.id}_main.png`;
        await renderToPNG(option, path.join(chartsDir, filename));
        console.log(`  ✓ ${filename}`);
        count++;
      }
    }

    // 2. 额外 charts[] 数组
    if (c.charts && Array.isArray(c.charts)) {
      for (let i = 0; i < c.charts.length; i++) {
        const ch = c.charts[i];
        if (ch.type === 'table') continue;
        const option = buildOption(ch.type, ch.data || {});
        if (option) {
          const filename = `conclusion_${c.id}_${i}.png`;
          await renderToPNG(option, path.join(chartsDir, filename));
          console.log(`  ✓ ${filename}`);
          count++;
        }
      }
    }
  }

  console.log(`\n共生成 ${count} 张图表 → ${chartsDir}`);
  await verifyHighConclusionCharts(report, chartsDir);
}

main().catch(err => { console.error(err); process.exit(1); });
