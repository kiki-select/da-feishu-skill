#!/usr/bin/env node
// [通用版] 由 DA-activity/bin 通用化而来，供 DA-feishu 报告增量发布；DA-activity 原版不变
// 增量更新 callout 主要结论 — 不动其他章节内容
//
// 用法: node bin/update-callout.js --doc-id <id> --report <report.json>
//
// 实现：从 report.summary.overall 重建完整 callout markdown，用 selection-with-ellipsis
// 定位现 callout 区间（"<callout"..."</callout>"），整块替换。
//
// 这是单独一个 callout block 的全量重写（一次 lark-cli 调用），不影响章节正文。

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
    ? spawnSync(process.execPath, [LARK_CLI_ENTRY, ...args], { encoding: 'utf-8', shell: false })
    : spawnSync('lark-cli', args, { encoding: 'utf-8', shell: true });
  if (res.status !== 0) throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

function buildCalloutMarkdown(text) {
  // 复刻 publish-to-feishu.js 的 callout 构造逻辑
  let md = '<callout emoji="clipboard" background-color="light-orange">\n#### 主要结论\n';
  if (text) {
    if (text.includes('\n- ') || text.includes('\n**')) {
      const lines = text.split('\n');
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) {
          md += '\n';
          continue;
        }
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          md += `\n${trimmed}  \n`;
        } else if (/^\s*[-•] /.test(raw)) {
          md += `${raw}\n`;
        } else {
          md += `${trimmed}\n\n`;
        }
      }
    } else {
      for (const p of text.split(/[。；;]/).filter(s => s.trim())) {
        md += `- ${p.trim()}；\n`;
      }
    }
  }
  md += '</callout>';
  return md;
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
    console.error('Usage: node bin/update-callout.js --doc-id <id> --report <report.json>');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf-8'));
  const overall = report.summary && report.summary.overall;
  if (!overall) throw new Error('report.summary.overall 缺失');

  console.log(`✓ 增量更新 ${docId} 主要结论 callout`);

  const newCallout = buildCalloutMarkdown(overall);

  // selection-with-ellipsis 锚定整个 callout 块
  larkCli([
    'docs', '+update',
    '--doc', docId,
    '--mode', 'replace_range',
    '--selection-with-ellipsis', '<callout emoji="clipboard" background-color="light-orange">...</callout>',
    '--markdown', newCallout,
  ]);

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
