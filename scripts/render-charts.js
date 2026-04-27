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
  return {
    title: { text: data.title || '', left: 'center', textStyle: { fontSize: 16, color: '#3d3630' } },
    tooltip: { trigger: 'axis' },
    legend: { data: seriesKeys, top: 35, textStyle: { fontSize: 12 } },
    grid: { top: 75, bottom: rotate ? 60 : 35, left: 65, right: 30 },
    xAxis: { type: 'category', data: data.x_labels || [], axisLabel: { fontSize: 10, rotate } },
    yAxis: { type: 'value', name: data.yAxisName || '' },
    series: seriesKeys.map((key, i) => ({
      name: key,
      type: 'line',
      data: data.series[key],
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
}

main().catch(err => { console.error(err); process.exit(1); });
