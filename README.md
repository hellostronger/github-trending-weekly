# GitHub Trending 周榜监控

监控 GitHub Trending 周榜，自动生成「本周全球最受关注的 10 个开源项目」排行页面，并通过 GitHub Pages 发布。

页面效果：深色星空风格排行榜，展示每期 Top 10 的项目名（中文）、所属公司、本周新增 Star、累计 Star，支持回看往期榜单。

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

## 自定义

| 想改什么 | 改哪里 |
| --- | --- |
| 仓库中文名 | `data/titles.json`（键为 `owner/repo`；没有的仓库回退显示仓库名） |
| 所属公司映射 | `scripts/fetch-trending.mjs` 里的 `COMPANY_MAP`（未匹配的 Organization 显示 org 名，个人账号显示「个人开发者」） |
| 榜单长度 | 环境变量 `TOP_N`（默认 10） |
| 日榜/周榜/月榜 | 环境变量 `TRENDING_SINCE`（默认 `weekly`），同时改 `index.html` 标题文案 |
| 抓取频率 | `.github/workflows/update.yml` 里的 `cron` |

## 数据文件

- `data/latest.json` —— 当前榜单，页面主视图读取
- `data/archive/<日期>.json` —— 每日归档，页面「往期榜单」回看
- `data/history.json` —— 归档索引

## 常见问题

- **API 限流（HTTP 403）**：脚本匿名可用；如需提高额度，在仓库 Secrets 添加自己的
  `GITHUB_TOKEN`（工作流里用的是 Actions 自带 token，一般够用）。
- **抓取失败**：脚本内置 3 次重试；若仍失败，多为 github.com 网络抖动，下个周期会自动恢复。
- **Trending 页面结构变化导致解析为空**：调整 `scripts/fetch-trending.mjs` 的
  `parseTrending` 正则。
- **中文名显示英文**：把 `owner/repo` 加进 `data/titles.json` 即可；也可以接入任意 LLM API 自动翻译。

## License

MIT
