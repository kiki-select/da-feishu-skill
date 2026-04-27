# DA-feishu Skill

数据分析报告 → 飞书文档的端到端工作流。从业务背景输入开始，自动完成数据采集、深度分析、ECharts 图表渲染、飞书文档发布（含**内嵌电子表格**）、数据附表生成。

触发词：`/数据分析`

---

## 安装

把下面这段提示词整段粘贴给你的 Claude（Claude Code 或 Claude Desktop），它会按顺序跑完所有步骤：

```
da-feishu 是一个 Agent Skills，请按以下步骤依次帮我安装，每步执行完再进下一步，遇到错误立即停下并告知我：

1. 找到本地 skills 目录（项目级通常是 .claude/skills/，全局是 ~/.claude/skills/）

2. clone 仓库：
   git clone https://github.com/kiki-select/da-feishu-skill.git da-feishu

3. 进入目录安装 npm 依赖：
   cd da-feishu && npm install

4. 安装 lark-cli（飞书命令行工具），确保 `lark-cli` 在 PATH 中可用，验证：
   lark-cli --version

5. 启动飞书 OAuth 授权（会弹浏览器，让我登录）：
   lark-cli auth login --recommend

6. 安装数据源 skill funnydb（在同一个 skills 目录下）：
   git clone https://git.sofunny.io/data-analysis/funnydb-skills.git funnydb
   注：Windows 用户如果没装 WSL，先跑 `wsl --install --web-download`，重启后再继续这一步。新版 funnydb 自动授权，无需手动配置 API Key。

7. 全部完成后输出确认，并简单提示我下一步可以用 `/数据分析` 触发工作流。
```

### 非 Claude Code 用户（Codex / OpenCode / Aider / π 等）

Agent Skills 的 `name:` frontmatter + `/<skill>` 触发语法是 Claude 生态特有的，其他 Agent 工具**不识别 skills 目录**，但本仓库可以无缝降级使用：

1. **安装位置随意**：`git clone` 到任何目录都行（不需要 `.claude/skills/`），然后 `npm install`。
2. **让 Agent 读 SKILL.md**：把 `SKILL.md` 当作本项目的工作流说明书。常见做法：
   - Codex / OpenCode：项目根放一份 `AGENTS.md` 软链到 `SKILL.md`（`ln -s SKILL.md AGENTS.md`），它们会自动加载。
   - 其他工具：让 Agent 第一步 `cat SKILL.md` 读一遍，或手动贴进 system prompt。
3. **触发方式改成自然语言**：不能用 `/数据分析`，直接说「按 SKILL.md 的 9 步流程跑一份数据分析报告」即可。
4. **脚本与 Agent 框架无关**：`render-charts.js` / `publish-to-feishu.js` 是纯 Node 脚本，任何工具甚至不带 Agent 都能直接 `node scripts/xxx.js report.json` 跑。

依赖（lark-cli、funnydb）的安装步骤完全一致，与 Agent 工具无关。

---

## 前置依赖

### 1. 运行环境

- **Node.js** ≥ 18
- **npm install**（仓库根目录执行）

### 2. lark-cli（飞书命令行）

下载并安装 lark-cli，确保 `lark-cli` 在 PATH 中。然后授权飞书账号：

```bash
lark-cli auth login --recommend
```

授权后会拿到 OAuth token（refresh token 7 天，access token 2 小时，过期需重新登录）。

### 3. 数据源 skill（强烈推荐先装）

本 skill 只负责「分析方法论 + 图表 + 飞书发布」，**数据采集依赖外部数据源 skill**。

#### 3.1 macOS / Linux 安装 funnydb

把这段提示词整段交给 Claude：

```
funnydb-skills 是一个 Agent Skills，现在你要帮用户安装。请按以下命令克隆到你的 skills 目录：

git clone https://git.sofunny.io/data-analysis/funnydb-skills.git funnydb
```

新版 funnydb 已支持自动授权验证，**不需要手动配置 API Key**。

装好后验证：

```bash
cd <skills目录>/funnydb
bash scripts/funnydb post /api/v1/open/skillhub/tools/apps/list
# 能列出你有权限的 app 列表即成功
```

#### 3.2 Windows 用户：通过 WSL 桥接（重要）

**funnydb-cli 二进制只发 Linux/macOS 版本，Windows 必须通过 WSL 跑**。本仓库附带的 `scripts/funnydb` 是 Windows 侧的 shim，自动把调用转发进 WSL。原理：

1. 把 Git Bash 路径 `/d/...` 加 `/mnt` 前缀转成 WSL 路径 `/mnt/d/...`
2. `MSYS_NO_PATHCONV=1` 阻止 Git Bash 把 WSL 路径再次转换
3. `sed 's/\r$//'` 去 Windows CRLF
4. WSL 内 `bash` 执行 `funnydb-original` 原生脚本
5. `FUNNYDB_CLI_BIN_DIR` 指向 skill 目录下的 `.bin/`，二进制按需下载

**安装步骤：**

```powershell
# 1. 启用 WSL（管理员 PowerShell，未装过的话）
wsl --install --web-download
# --web-download 直接从 GitHub 下载，绕过 Microsoft Store
# 重启电脑后默认装 Ubuntu
```

> ⚠️ 不加 `--web-download` 默认走 Microsoft Store，公司机器常被组策略 / 代理拦截返回 403。加上这个 flag 就好了。

```powershell
# 2. 进 WSL，准备依赖
wsl
sudo apt update && sudo apt install -y curl unzip

# 3. （回到 Git Bash）clone funnydb skill 到你的 skills 目录
cd <skills目录>
git clone https://git.sofunny.io/data-analysis/funnydb-skills.git funnydb
```

新版 funnydb 自动授权，**不需要手动写 API Key**。

**Windows shim 脚本**（如果你 clone 的版本里没有，把下面这段保存为 `scripts/funnydb` 替换原 `scripts/funnydb`）：

```bash
#!/usr/bin/env bash
# Windows → WSL shim for funnydb-cli
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WSL_SCRIPTS_DIR="/mnt${SCRIPT_DIR}"
WSL_SKILL_DIR="$(dirname "$WSL_SCRIPTS_DIR")"

QUOTED_ARGS=""
for arg in "$@"; do
  escaped="${arg//\'/\'\\\'\'}"
  QUOTED_ARGS="$QUOTED_ARGS '${escaped}'"
done

export MSYS_NO_PATHCONV=1
wsl -- bash -c "export FUNNYDB_CLI_BIN_DIR='${WSL_SKILL_DIR}/.bin'; sed 's/\r\$//' '${WSL_SCRIPTS_DIR}/funnydb-original' > /tmp/funnydb-run.sh && bash /tmp/funnydb-run.sh${QUOTED_ARGS}"
```

把原仓库的 `scripts/funnydb` 重命名为 `scripts/funnydb-original`，再放上面这段 shim。验证：

```bash
cd <skills目录>/funnydb
bash scripts/funnydb post /api/v1/open/skillhub/tools/apps/list
```

#### 3.3 其他数据源

如果你用自有 BI / SQL / CSV 上传等，跳过 funnydb，把 SKILL.md 中 Step 2 的数据采集环节替换为你的获取方式即可，**其他 Step 完全数据源无关**。

---

## 使用

### 触发

跟你的 Claude 说：

```
/数据分析
```

或者直接表达意图：

> 帮我分析下上周的活动数据，发个飞书报告

Claude 会按 SKILL.md 中的 9 步流程走：

1. 收集业务背景与分析诉求（含对比基准）
2. 数据采集
3. 深度分析（假设驱动 + 偏差检验）
4. 生成 report JSON
5. 渲染图表
6. 校验清单
7. 发布飞书文档
8. 修订
9. 交付（飞书文档链接 + 数据附表链接）

### 直接调用脚本

如果想跳过 AI 流程，自己写好 report JSON 后直接发布：

```bash
# 渲染图表
node scripts/render-charts.js reports/my-report.json

# 发布到飞书（首发）
node scripts/publish-to-feishu.js reports/my-report.json --data-dir=data/my-case

# 重发覆盖（URL 不变）
node scripts/publish-to-feishu.js reports/my-report.json \
  --data-dir=data/my-case \
  --doc-id=<原文档ID>
```

---

## 目录结构

```
da-feishu/
├── SKILL.md                       # 工作流入口（触发后 Claude 跟随这份文档）
├── README.md                      # 本文件
├── package.json
├── scripts/
│   ├── render-charts.js           # ECharts SSR → PNG
│   ├── publish-to-feishu.js       # 飞书文档发布主脚本
│   ├── sheet-styler.js            # 内嵌 sheet 样式应用器（核心组件）
│   └── charts/                    # 图表 PNG 输出（运行后自动生成）
├── references/                    # 数据分析方法论
│   ├── hypothesis-driven-analysis.md
│   ├── cognitive-biases.md
│   ├── general-frameworks.md
│   ├── driver-tree-analysis.md
│   ├── data-storytelling.md
│   ├── data-interpretation.md
│   ├── visualization-rules.md
│   └── activity-evaluation-model.md
├── examples/                      # 报告 JSON 样例
├── reports/                       # 你的报告 JSON（运行时创建）
└── data/                          # 你的数据 CSV（运行时创建）
```

---

## 核心特性

### 1. 端到端自动化
业务背景输入 → 数据采集 → 分析 → 图表 → 飞书文档 + 数据附表，单次触发跑完。

### 2. 内嵌电子表格（block_type=30）
所有表格用飞书原生**内嵌 sheet block**（不是 markdown 表格），自动应用：
- 千分位 / 百分比 / 日期 formatter
- 表头浅灰底加粗居中
- 数值右对齐、文本居中
- 列宽按内容自动估算
- `+/-` 差异格自动绿/红着色

### 3. 标准化方法论
内置 `references/`：假设驱动分析、10 大认知偏差检查、驱动因子树、SCR 数据叙事、可视化规则等。

### 4. 文档可重发
通过 `--doc-id=` 覆盖原文档，URL 不变。修改报告后无需告知用户新链接。

---

## 报告 JSON 最简示例

```json
{
  "meta": { "title": "活动 X 效果分析" },
  "context": {
    "background": "活动 X 于 2026-04-01 至 2026-04-07 上线，针对核心玩家发放 Y 奖励。本报告对比活动期 vs 上一同期周的核心指标变动。",
    "definitions": ["活动期：2026-04-01~04-07", "对照期：2026-03-25~03-31"]
  },
  "summary": {
    "overall": "**核心结论**\n- DAU: 4,200→5,180（+23.3%），活动有效拉动\n- 次留: 38.2%→37.5%（-0.7pp），新增用户质量持平"
  },
  "conclusions": [
    {
      "id": 1,
      "title": "DAU 与新增表现",
      "description": "- 活动期日均 DAU 5,180（+23.3%），新增 1,240（+18.7%）；\n- 周末峰值 6,021，单日历史新高。",
      "chart_type": "table",
      "chart_data": {
        "title": "活动期 vs 对照期核心指标",
        "columns": ["时段", "DAU", "新增", "次留"],
        "rows": [
          ["活动期", 5180, 1240, 0.375],
          ["对照期", 4200, 1045, 0.382],
          ["差异", "+23.3%", "+18.7%", "-0.7pp"]
        ],
        "footnote": "数据来源：FunnyDB；次留为同期窗口加权均值"
      }
    }
  ]
}
```

---

## 故障排查

| 问题 | 解决 |
|---|---|
| `lark-cli: command not found` | 确认 lark-cli 安装且在 PATH 中 |
| `授权失败 / token 过期` | 重新执行 `lark-cli auth login --recommend` |
| 飞书文档创建成功但表格为空 | 检查 `chart_data.columns` 和 `rows` 长度是否一致 |
| 中文 CSV 在飞书附表乱码 | 写 CSV 时必须加 UTF-8 BOM 头（`\xEF\xBB\xBF`） |
| 内嵌 sheet 创建失败 | 查看 publish 日志，会自动回退到 lark-table；常见原因是 lark-cli 未授权 |
| ECharts 图表只显示标题 | 确认 `render-charts.js` 用的是 SVG SSR 模式，不是 canvas |
| `wsl --install` 报 403 / 卡 Store | 改用 `wsl --install --web-download` 从 GitHub 直接拉，绕过 Microsoft Store |
| Windows 调 funnydb 报 `command not found` 或路径错乱 | 确认 `scripts/funnydb` 是 WSL shim 版本，且原始脚本叫 `funnydb-original` |
| funnydb 调用 hang 住或授权失败 | 删除 skill 目录下 `.bin/` 让 CLI 重新下载二进制；如仍有问题按 funnydb skill 的提示重新走授权流程 |

更多细节见 [SKILL.md](SKILL.md) 末尾的「数据源踩坑速查」「内嵌 sheet 已知约束」章节。

---

## License

MIT
