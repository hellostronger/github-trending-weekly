# GitHub Trending 周榜监控

监控 GitHub Trending（周榜 + 日榜），自动生成「全球最受关注的开源项目」排行页面，并通过 GitHub Pages 发布。

页面效果：深色星空风格排行榜，支持 **周榜 / 日榜切换**，展示每期 Top 10 的项目名（中文）、所属公司、编程语言徽章、新增 Star、累计 Star 与累计 Star 趋势曲线，支持回看往期榜单和「趋势追踪」卡片区（上榜天数统计，点击卡片定位到榜单行）。

## 工作原理

```
GitHub Actions 定时任务（每天 UTC 02:00）
        │
        ▼
scripts/fetch-trending.mjs
        │  1. 抓取 github.com/trending?since=weekly（拿到每仓库「本周新增 Star」）
        │  2. 调用 GitHub REST API 补充：累计 Star / 描述 / 语言 / Owner 类型
        │  3. 按 data/titles.json 填中文标题，按脚本内 COMPANY_MAP 填所属公司
        ▼
data/latest.json + data/archive/<日期>.json + data/history.json
        │  （自动 git commit 存档）
        ▼
GitHub Pages 发布静态页面（index.html + assets/，读取 data/*.json 渲染）
```

## 快速开始（发布到你的 GitHub Pages）

1. 在 GitHub 新建一个仓库（如 `your-name/github-trending-weekly`），然后推送本项目：

   ```bash
   cd github-trending-weekly
   git init -b main
   git add -A
   git commit -m "init: github trending weekly monitor"
   git remote add origin https://github.com/<你的用户名>/github-trending-weekly.git
   git push -u origin main
   ```

2. 推送后 Actions 会自动运行一次。若 Pages 未自动开启，去仓库
   **Settings → Pages → Build and deployment → Source 选择 "GitHub Actions"**，
   然后在 Actions 页面手动 *Run workflow* 触发一次即可。

3. 稍等一两分钟，访问 `https://<你的用户名>.github.io/github-trending-weekly/` 就能看到页面。

之后每天北京时间 10:00 自动抓取一次并更新页面与数据存档（可在 Actions 页手动触发）。

## 本地运行

```bash
# 抓取数据（可选：设置 GITHUB_TOKEN 提升 API 限流，匿名 60 次/小时足够本脚本使用）
node scripts/fetch-trending.mjs

# 本地预览（任选一种）
python -m http.server 8000
npx serve .
# 浏览器打开 http://localhost:8000
```

## 时区说明

- 定时任务在 **UTC 02:00（北京时间 10:00）** 运行
- 页面显示的所有日期（副标题、归档索引、趋势数据点）统一按**北京时间**标注，存放在
  `generatedAtLocal` / 归档文件名中；避免凌晨时段 UTC 日期「落后一天」的困惑
- 页脚「最后更新」按**访问者本地时区**显示

## 国际化

页面右上角可切换 **中文 / EN**，偏好保存在浏览器本地；固定文案（表头、标题、简介、按钮等）全部跟随语言切换。

项目动态内容的数据字段是双语的：

| 字段 | 说明 |
| --- | --- |
| `title` | 中文标题：`data/titles.json` 手工映射 > LLM 自动翻译 > 回退英文名 |
| `descriptionZh` | 中文描述：LLM 自动翻译生成，无则回退英文原文 |
| `company` / `companyEn` | 所属公司中英文 |

**开启自动翻译**（可选）：在仓库 **Settings → Secrets and variables → Actions** 添加：

- `LLM_API_KEY`（必填）：任意 OpenAI 兼容接口的密钥
- `LLM_BASE_URL`（可选）：默认 `https://open.bigmodel.cn/api/paas/v4`（智谱）
- `LLM_MODEL`（可选）：默认 `glm-4-flash`（智谱免费模型）

配置后每次运行自动为榜单上的新仓库生成中文标题和描述，结果缓存在 `data/translations.json`（已翻译过的不会重复调用）。不配置也能正常运行，只是描述保持英文原文。

## 自定义

| 想改什么 | 改哪里 |
| --- | --- |
| 仓库中文名 | `data/titles.json`（键为 `owner/repo`；没有的仓库回退显示仓库名） |
| 所属公司映射 | `scripts/fetch-trending.mjs` 里的 `COMPANY_MAP`（未匹配的 Organization 显示 org 名，个人账号显示「个人开发者」） |
| 榜单范围 | 环境变量 `CHARTS`（默认 `weekly,daily`，可只留一个或加 `monthly`） |
| 榜单长度 | 环境变量 `TOP_N`（默认 10） |
| 日榜/周榜/月榜 | 环境变量 `TRENDING_SINCE`（默认 `weekly`），同时改 `index.html` 标题文案 |
| 抓取频率 | `.github/workflows/update.yml` 里的 `cron` |

## 数据文件

- `data/latest.json` —— 周榜，页面默认视图
- `data/latest-daily.json` —— 日榜，页面「日榜」tab 读取
- `data/archive/<日期>.json` —— 周榜按天归档（页面「往期榜单」回看）
- `data/archive/daily-<日期>.json` —— 日榜按天归档
- `data/history.json` —— 归档索引（周榜/日榜合并存放，按 `since` 字段区分）
- `data/trends.json` —— 趋势时间线：`仓库 -> [{date, since, stars, gained}]`，每天每榜 upsert 一个数据点，
  保留最近 180 天；页面按当前榜单类型渲染迷你趋势曲线和「趋势追踪」卡片区
- `data/translations.json` —— LLM 自动翻译缓存（`仓库 -> {title, desc}`），配置了 `LLM_API_KEY` 才会生成

## 常见问题

- **API 限流（HTTP 403）**：脚本匿名可用；如需提高额度，在仓库 Secrets 添加自己的
  `GITHUB_TOKEN`（工作流里用的是 Actions 自带 token，一般够用）。
- **抓取失败**：脚本内置 3 次重试；若仍失败，多为 github.com 网络抖动，下个周期会自动恢复。
- **Trending 页面结构变化导致解析为空**：调整 `scripts/fetch-trending.mjs` 的
  `parseTrending` 正则。
- **中文名显示英文**：把 `owner/repo` 加进 `data/titles.json` 即可；也可以接入任意 LLM API 自动翻译。

## License

MIT
