---
name: da-feishu
description: |
  数据分析报告 → 飞书文档的端到端工作流。从业务背景输入开始，自动完成数据采集、深度分析、
  图表渲染、飞书文档发布（含内嵌 sheet 电子表格）。
  触发：用户使用 `/数据分析` 命令，或表达「做数据分析」「出分析报告」「发飞书报告」等意图。
---

# DA-feishu：数据分析飞书报告工作流

把任意业务背景的数据分析需求，端到端转换为标准化的飞书数据报告：业务输入 → 数据采集 → 深度分析 → ECharts 图表 → 飞书文档（含内嵌电子表格）+ 数据附表。

## 触发条件

- 用户使用 `/数据分析` 命令
- 用户表达「做数据分析」「出分析报告」「数据分析报告」「发飞书报告」「分析下 XXX」等意图

---

## 前置依赖

1. **Node.js ≥ 18** + 已 `npm install`（仓库根目录）
2. **lark-cli** 已安装并完成飞书 OAuth：`lark-cli auth login --recommend`
3. **数据源 skill**（任选其一）：
   - 推荐 [funnydb](https://git.sofunny.io/data-analysis/funnydb-skills.git) — 配套良好的数据平台 skill
   - 或：自有 BI / SQL / CSV 上传等任何能拿到结构化数据的方式
4. （可选）业务知识背景文档：放在 repo 根的 `knowledge.md` 中，让分析更贴近业务

---

## 完整执行流程

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8 → Step 9
收集背景  数据采集  深度分析  生成 JSON  渲染图表  校验清单  发布文档  (修订)  交付
```

### Step 1：收集业务背景与分析诉求

向用户确认 4 个核心问题：

| 问题 | 用途 |
|---|---|
| **业务背景** | 项目/产品名、业务模式、用户群体、当前阶段 |
| **核心问题** | 想回答什么？（如：上周活动效果如何？某指标为何下滑？） |
| **关注指标** | 重点关注哪些指标？（如：DAU、留存、转化率、ARPU…） |
| **对比基准** | 跟谁对比？（同期、上版本、行业基准、自身历史…） |

**强制规则**：没有对比基准就没有结论。必须确认对比方式后再进入下一步。

### Step 2：数据采集

根据数据源 skill 拉取数据，整理为 CSV：

- **CSV 强制 UTF-8 BOM 头**（`\xEF\xBB\xBF`），否则 Windows 中文乱码
- 文件命名：`<维度>_<指标>.csv`（如 `dau_trend.csv`、`retention_by_segment.csv`）
- 默认目录：`<repo根>/data/<case-name>/`（可在 publish 时通过 `--data-dir=` 覆盖）
- 每个 CSV 对应一个分析维度，字段含义清晰

### Step 3：深度分析

遵循 [references/](references/) 中的方法论：

1. **假设驱动**：将模糊问题转化为可验证假设（[hypothesis-driven-analysis.md](references/hypothesis-driven-analysis.md)）
2. **偏差检验**：辛普森悖论 / 幸存者偏差 / 相关≠因果 / 回归均值 / 基数效应（[cognitive-biases.md](references/cognitive-biases.md)）
3. **对比有基准**：每个数值结论必须有参照
4. **均值优先**：用时间段加权均值，不逐日罗列
5. **多维度交叉**：单一指标无法定论，至少 2-3 个相关指标交叉
6. **因果推演**：区分策略效果、自然波动、外部冲击
7. **结论先行**：先给判定，再用数据支撑（[data-storytelling.md](references/data-storytelling.md)）

### Step 4：生成 Report JSON

报告 JSON 结构（保存到 `reports/<case-name>.json`）：

```json
{
  "meta": { "title": "报告标题" },
  "context": {
    "background": "分析背景：业务场景、数据范围、对比基准",
    "definitions": ["术语1：定义", "术语2：定义"]
  },
  "summary": {
    "overall": "**模块A**\n- 结论 bullet\n\n**模块B**\n- 结论 bullet"
  },
  "conclusions": [
    {
      "id": 1,
      "title": "章节主题（不写结论式）",
      "description": "- 主 bullet\n  - 子 bullet（数据展开）",
      "chart_type": "table | line | bar | pie | bar_line | scatter",
      "chart_data": { "title": "...", "columns": [...], "rows": [...], "footnote": "..." },
      "charts": [ { "type": "table", "data": { ... } } ]
    }
  ]
}
```

**结论组织原则**：
- 每模块 3-5 条 bullet，超过 5 条必须合并
- 顺序：宏观判定 → 分项指标 → 细节定位
- 同类指标合并成单条 bullet（用分号串）
- 删定性词（"显著"/"全面优于"），让数字自己说话
- 不写行动建议（行动是业务方的 job，分析师只交付现象 + 定位）
- 未定位的现象统一收尾「原因待定位」，不强行套理论自证

### Step 5：图表渲染

```bash
node scripts/render-charts.js reports/<case-name>.json
```

输出 PNG 到 `scripts/charts/`。支持的 chart_type：

| 类型 | 用途 | 备注 |
|---|---|---|
| `line` | 趋势折线 | 下方不追加数据表 |
| `bar` | 柱状图 | 自动追加数据表（内嵌 sheet） |
| `pie` | 饼图 | 同上 |
| `bar_line` | 柱线混合双 Y 轴 | 右轴 splitLine: false |
| `scatter` | 散点图 | 同上 |
| `table` | 跳过 PNG，发布时创建**内嵌 sheet block**（详见末尾「内嵌 sheet 表格规范」） |

### Step 6：校验清单（**发布前必须逐项检查**）

#### 数据校验
- [ ] 描述中每个数值能从 chart_data / CSV 追溯
- [ ] 关键均值手动验算（加权均值 vs 算术均值）
- [ ] 各模块结论之间无矛盾
- [ ] 每个结论都有明确的对比基准

#### 格式校验
- [ ] 图表 PNG 尺寸正常（900×480），双 Y 轴图无重叠网格线
- [ ] 内嵌 sheet：指标作列、对象作行、单位放列名（不写在单元格）、列宽自动估算未被手动覆盖
- [ ] 数值检测：数值右对齐、文本居中、差异格 `+/-` 红绿着色正确
- [ ] 标题与各章节版本号/时间口径一致

#### 结构校验
- [ ] 低价值模块（结论"无异常、符合预期"且无定位）已删除或合并到摘要
- [ ] summary 模块顺序与 conclusions 顺序一致
- [ ] context.definitions 覆盖所有用到的专有术语

### Step 7：发布飞书文档

```bash
# 首发：新建文档 + 新建附表
node scripts/publish-to-feishu.js reports/<case-name>.json --data-dir=data/<case-name>

# 重发覆盖（URL 不变）：
node scripts/publish-to-feishu.js reports/<case-name>.json \
  --data-dir=data/<case-name> \
  --doc-id=<原文档ID>
# 注意：附表复用（--sheet-token=<token>）会因旧 sheet 已存在导致 addSheet 失败，
# 要刷新数据请省略 --sheet-token 让脚本新建附表。
```

自动完成：
1. 创建（或 overwrite 原）飞书文档：背景说明 → callout 主要结论 → 章节分析 → 图表/内嵌 sheet 表
2. 创建飞书数据附表：每个 CSV 一个 sheet
3. 输出文档 URL + 附表 URL

### Step 8：发布后修订

- **小调整**（修图、改文字、调格式）→ 用 `--doc-id=` overwrite 原文档，URL 不变
- **结构性大改**（重组章节、大量数据更新）→ 同上 overwrite，仍保持原 URL
- 仅在用户明确要求"换个新链接"时才重新生成

### Step 9：交付

输出给用户：
1. 飞书文档链接
2. 飞书数据附表链接
3. 关键发现摘要（SCR 叙事：情境-冲突-解决，3-5 句）

---

## 飞书文档排版规范

### 文档结构

```
### 背景说明（含术语定义，--- 前后留空行避免被解析为 setext heading）
（空行：\u200b\n）
<callout emoji="clipboard" background-color="light-orange">
主要结论（按模块分组）
</callout>
（空行）
## 1. 章节主题
描述（主 bullet + 子 bullet）
图表 / 内嵌 sheet
<quote-container>脚注</quote-container>
（空行）
## 2. ...
```

### 章节标题
- **主题式命名**（如「DAU 与留存表现」），不用结论式（如「DAU 同比下滑」）
- 结论放在章节内的 bullet 中

### 描述 bullet
- 主 bullet：`- `（顶格）
- 子 bullet：`  - `（缩进两格）
- 同段连续 bullet：中间用 `；` 结尾，最后一行用 `。` 结尾
- 描述格式：`指标: 改前值→改后值（变化率）`
- 数值精度：统一 1 位小数，整数不变
- 不使用 `**加粗**`，不出现「结论点」「核心证据链」「小结」等元标记

### summary.overall（callout 结论）
按模块分组，`**模块名**` 独立成行（前加 `\n` 形成段落），子 bullet 用 `- `。

### 颜色与图表
- 变化率自动着色：`+` 绿、`-` 红（内嵌 sheet 自动识别）
- 趋势图（line）下方不追加数据表
- 非趋势图下方自动追加内嵌 sheet 数据表
- 图表 PNG 通过 `lark-cli docs +media-insert --align center` 居中插入

---

## 内嵌 sheet 表格规范（**所有表格强制使用**）

> **强制规则**：报告中所有表格（章节内对比表、图表下方数据表、附属明细表）一律使用**内嵌 sheet block**（`block_type=30`），由 publish-to-feishu.js 自动调用 `scripts/sheet-styler.js` 的 `applyTableStyle()` 完成创建+样式。
>
> **不再使用** lark-table 原生 markdown 表格作为正式表格输出形式。lark-table 仅在 sheet 创建失败时兜底 fallback。
>
> 触发方式：在 report JSON 中将 `chart_type` 设为 `"table"`，配置 `chart_data: { title, columns, rows, footnote }`，其余完全交给 publish 流程，不需要手写任何表格 markdown。

### 表格结构强制规则

1. **指标作列、对象作行**：表头第一列是分类维度（时段 / 模式 / 区域 / 用户分层…），其余列每列一个指标。**禁止把指标放成行**。
   - 反例：`columns=[指标, A, B]`，rows=[`[DAU, ...]`, `[留存, ...]`]
   - 正例：`columns=[模式, DAU, 留存, 时长(min)]`，rows=[`[A, ...]`, `[B, ...]`]

2. **数值列写裸数值，单位放列名**：单元格只允许 number / 百分号字符串 / `+`/`-` 开头的差异格 / `≈0` 这种特殊符号。**禁止把单位写进单元格**（"1.8台"、"42.9min"、"126次" 都不行）。
   - 列名：`场均放置(台)`、`人均时长(min)`、`人均死亡(次)`
   - 单元格：`1.8`、`42.9`、`126`（裸数值）
   - 这样 `inferColumnTypes` 才能识别为数值列、应用千分位/小数 formatter、右对齐

3. **列宽自动按内容平展开**：默认调用 `autoColumnWidths()` 按表头+所有单元格的最大显示宽度估算（中文 14px/字、ASCII 8px/字 + 24px padding，clamp 到 [70, 300]）。**不要手传 `columnWidths`**，除非有特殊排版需求。

### columnTypes 取值

| 值 | 含义 | formatter | 对齐 | 示例显示 |
|---|---|---|---|---|
| `text` | 文本列 | `@`（强制文本，防自动转日期） | 居中 | `2026-04-15` |
| `int` | 整数 | `#,##0` | 右对齐 | `4,732` |
| `number` | 两位小数 | `#,##0.00` | 右对齐 | `4,732.50` |
| `percent` | 百分比（2 位） | `0.00%` | 右对齐 | `32.80%` |
| `percent0` | 百分比（整数） | `0%` | 右对齐 | `33%` |

**类型推断**：publish-to-feishu.js 的 `inferColumnTypes()` 会自动判断，一般无需手动指定。日期型字符串（`4/11`、`2026-04-15`）自动归为 text。

### 差异格自动识别

| 输入 | 写入值 | 显示 | 着色 |
|---|---|---|---|
| `'+100.6%'` | `1.006` (numeric) + `0.00%` | `100.60%` | 绿 `#2BA471` |
| `'-2.4%'` | `-0.024` + `0.00%` | `-2.40%` | 红 `#D83931` |
| `'+6.9pp'` | 文本 `+6.9pp` | `+6.9pp` | 绿 |
| `'-3.1pp'` | 文本 `-3.1pp` | `-3.1pp` | 红 |

### 已知约束（飞书 sheet API）

1. **formatter 白名单**：仅支持 `0%` / `0.00%` / `#,##0` / `#,##0.00` / `@` / 日期时间预设（[官方文档](https://open.feishu.cn/document/ukTMukTMukTM/uMjM2UjLzIjN14yMyYTN)），自定义 `0.0%`、`+0.00%;-0.00%` 全部被拒（lark-cli 静默 exit 1）
2. **百分比差只能 2 位小数**：纯 % 差异格强制 `100.60%`，无法显示为 `100.6%`
3. **pp 差异保留原精度**：因 pp 没有数值 formatter，写文本反而能保留 1 位小数
4. **`+` 前缀禁用 numeric 解析**：`"+100.6%"` 字符串永远是文本，必须主动转 `1.006` 才生效（已在 classifyCell 处理）
5. **appendStyle 是叠加非替换**：旧样式的 foreColor 不会被新 style 抹掉，必须显式传 `foreColor:'#000000'` 重置

### 默认样式

| 参数 | 值 |
|---|---|
| 表头底色 | `#F2F2F2` 浅灰 |
| 表头字体 | 加粗 + 居中 |
| 字号/行距 | `10pt/1.5` |
| 正向色 | `#2BA471` 绿 |
| 负向色 | `#D83931` 红 |
| 列宽 | 自动估算 [70, 300] |
| 冻结表头 | 否 |

---

## 关键文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 本文档 |
| `scripts/render-charts.js` | ECharts SSR → PNG |
| `scripts/publish-to-feishu.js` | 飞书文档发布主脚本（含内嵌 sheet 创建） |
| `scripts/sheet-styler.js` | 内嵌 sheet 样式应用器（applyTableStyle 等） |
| `references/*.md` | 数据分析方法论（假设驱动、偏差检验、可视化等） |
| `examples/*.json` | 报告 JSON 样例 |

---

## 数据源踩坑速查（适用于绝大多数 BI 平台）

| 问题 | 解决 |
|---|---|
| 时间字段名不统一（dt / date / event_date） | 查询前先 inspect schema，不猜 |
| 留存数据回填延迟 | 次留 +1 天、3 留 +2 天后再统计 |
| 当天数据不完整 | 排除未结束的当天，重算均值 |
| 同一对象多个名称 | 合并前做名称映射（如 AK-12 = AK12） |
| selector / 枚举类参数报错 | 不传该参数，使用面板/查询默认值 |

---

## 通用排版规范速查

| 规则 | 说明 |
|---|---|
| 文档结构 | `### 背景说明` → 空行 → `<callout>主要结论</callout>` → 空行 → `## N. 章节` |
| 章节标题 | 主题式命名，不结论式 |
| 描述格式 | `指标: 改前值→改后值（变化率）`，主 bullet + 子 bullet |
| 数值精度 | 统一 1 位小数，整数不变 |
| 表格 | **统一内嵌 sheet（block_type=30）**，自动应用样式 |
| 变化率 | `+` 绿、`-` 红（内嵌 sheet 自动识别 +/- 前缀） |
| 趋势图 | 下方不追加数据表 |
| 非趋势图 | 下方追加内嵌 sheet 数据表 |
| 脚注 | `<quote-container>` 紧跟图表/表格 |
| 章节间距 | 用 `'\u200b\n'` 零宽空格实现空行 |
| 描述清洗 | 去 `[结论点]`、`**粗体标记**`、`**小结：**` |
| summary | 按模块分组，`**模块名**` 独立成行（前加 `\n`），子 bullet 用 `- ` |
