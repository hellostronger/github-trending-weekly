#!/usr/bin/env node
/**
 * 抓取 GitHub Trending（周榜 + 日榜），生成监控数据：
 *   data/latest.json               周榜 Top N（页面默认视图）
 *   data/latest-daily.json         日榜 Top N
 *   data/archive/<date>.json       周榜按天归档（历史可回看）
 *   data/archive/daily-<date>.json 日榜按天归档
 *   data/history.json              归档索引（页面「往期榜单」用）
 *   data/trends.json               趋势时间线：仓库 -> [{date, since, stars, gained}]
 *
 * 数据来源：
 *   1. https://github.com/trending?since=weekly|daily —— 每个仓库自带 "N stars this week/day"
 *   2. GitHub REST API /repos/{owner}/{repo}           —— 累计 star、描述、语言、所属类型
 *
 * 可选环境变量：
 *   GITHUB_TOKEN   提升 API 限流（60 次/小时 -> 5000 次/小时）
 *   CHARTS         要抓的榜单，逗号分隔，默认 weekly,daily
 *   TOP_N          取前几名，默认 10
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const TOP_N = Number(process.env.TOP_N || 10);
const CHARTS = (process.env.CHARTS || 'weekly,daily')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => ['daily', 'weekly', 'monthly'].includes(s));
if (CHARTS.length === 0) CHARTS.push('weekly');

/** org(小写) -> 中英文展示名；没匹配上的 Organization 显示 login，个人账号显示「个人开发者/Individual」 */
const COMPANY_MAP = {
  meta: { zh: 'Meta', en: 'Meta' },
  google: { zh: '谷歌', en: 'Google' },
  'google-deepmind': { zh: '谷歌 DeepMind', en: 'Google DeepMind' },
  'google-gemini': { zh: '谷歌', en: 'Google' },
  anthropics: { zh: 'Anthropic', en: 'Anthropic' },
  anthropic: { zh: 'Anthropic', en: 'Anthropic' },
  vercel: { zh: 'Vercel', en: 'Vercel' },
  'vercel-labs': { zh: 'Vercel', en: 'Vercel' },
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  microsoft: { zh: '微软', en: 'Microsoft' },
  huggingface: { zh: 'Hugging Face', en: 'Hugging Face' },
  'xai-org': { zh: 'xAI', en: 'xAI' },
  'deepseek-ai': { zh: 'DeepSeek', en: 'DeepSeek' },
  'sherlock-project': { zh: 'Sherlock Project', en: 'Sherlock Project' },
  QwenLM: { zh: '阿里通义', en: 'Alibaba Qwen' },
};

/** 仓库中文名人工映射表：data/titles.json，没有的仓库回退到仓库名 */
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const TITLES = loadJson(path.join(DATA_DIR, 'titles.json'), {});

const UA = 'github-trending-weekly-monitor/1.0';
const TIMEOUT = AbortSignal.timeout(25_000);

/** /owner/repo 之外的站内链接一律排除 */
const HREF_BLACKLIST = /^(sponsors|stargazers|forks|issues|watchers|network|graphs|pulse|topics|features|collections|site|security|about|pricing|contact|api|docs|orgs|explore|trending|login|join|apps|codespaces|copilot|marketplace|sponsors-account)\b/;

async function fetchText(url, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: TIMEOUT,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (err) {
      lastErr = err;
      console.warn(`  第 ${i}/${retries} 次请求失败：${err.message}，稍后重试...`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`抓取失败 ${url}: ${lastErr.message}`);
}

async function ghApi(pathname) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: TIMEOUT });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API 失败 ${pathname} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 从 trending 页面按 <article> 块解析出仓库路径与 star 计数
 *  文案因榜单而异：周榜 "stars this week"、日榜 "stars today"（没有 this），
 *  所以用可选的 (?:this\s+)? 兼容两种 */
function parseTrending(html, sinceWord) {
  const re = new RegExp(`([\\d,]+)\\s+stars\\s+(?:this\\s+)?${sinceWord}`, 'i');
  const repos = [];
  for (const block of html.split('<article').slice(1)) {
    // 块内第一个非黑名单的 /owner/repo 链接才是仓库标题链接
    // （带 Sponsor 按钮的仓库，前面的链接可能是 /sponsors/xxx）
    const links = [...block.matchAll(/href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/g)]
      .map((m) => m[1])
      .filter((p) => !HREF_BLACKLIST.test(p));
    const repo = links[0];
    const weekly = block.match(re);
    if (!repo || !weekly) continue;
    repos.push({ repo, weeklyStars: Number(weekly[1].replace(/,/g, '')) });
  }
  // 去重并保持页面顺序
  const seen = new Set();
  return repos.filter((r) => (seen.has(r.repo) ? false : (seen.add(r.repo), true)));
}

function companyOf(ownerType, login) {
  if (ownerType !== 'Organization') return { zh: '个人开发者', en: 'Individual' };
  return COMPANY_MAP[login.toLowerCase()] ?? { zh: login, en: login };
}

/** 可选：LLM 自动翻译中文标题/描述（OpenAI 兼容接口）。配置 LLM_API_KEY 后生效。
 *  默认指向智谱开放平台 + glm-4-flash（免费模型），可用 LLM_BASE_URL / LLM_MODEL 覆盖。 */
const LLM = {
  key: process.env.LLM_API_KEY || '',
  baseUrl: (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
  model: process.env.LLM_MODEL || 'glm-4-flash',
};

async function llmTranslate(items) {
  if (!LLM.key || items.length === 0) return {};
  const prompt = [
    '你是开源项目资讯编辑。为下列 GitHub 仓库各生成：中文短标题、一句中文描述、典型应用场景。',
    '要求：',
    '- title：不超过 12 个字，概括项目用途',
    '- desc：不超过 40 个字，一句话概括项目是什么',
    '- useCase：不超过 45 字，写清楚典型使用者与适合的应用场景，要具体不空泛，例如「适合需要本地化部署知识库问答的团队」',
    '只输出 JSON 数组，不要任何多余文字，格式：',
    '[{"repo":"owner/name","title":"...","desc":"...","useCase":"..."}]',
    '',
    '仓库列表：',
    JSON.stringify(items.map(({ repo, name, description }) => ({ repo, name, description }))),
  ].join('\n');
  const t0 = Date.now();
  const res = await fetch(`${LLM.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify({
      model: LLM.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  console.log(`  [LLM] 本批耗时约 ${Math.round((Date.now() - t0) / 1000)}s`);
  const text = data.choices?.[0]?.message?.content || '';
  const arr = extractJsonArray(text);
  const out = {};
  for (const it of arr) {
    if (it && it.repo && it.title) {
      out[it.repo] = {
        title: String(it.title).slice(0, 30),
        desc: String(it.desc || '').slice(0, 100),
        useCase: String(it.useCase || '').slice(0, 120),
      };
    }
  }
  return out;
}

/** 从模型输出中稳健地提取 JSON 数组：优先 ```json 代码块，其次首尾括号匹配 */
function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  throw new Error('LLM 输出中没有可解析的 JSON 数组');
}

/** 为一组仓库条目补齐中文翻译（缓存驱动 + 可选 LLM），原地更新 title / descriptionZh / useCaseZh */
const LLM_CHUNK_SIZE = 2; // 桥接接口响应慢，分小批请求并逐批落盘缓存，中断可续跑

async function applyTranslations(entries) {
  const trans = loadJson(path.join(DATA_DIR, 'translations.json'), {});
  // 缓存缺失，或缓存还没有 useCase 字段（旧缓存迁移）时需要请求 LLM
  const missing = entries.filter((r) => !trans[r.repo] || !trans[r.repo].useCase);
  if (missing.length > 0 && LLM.key) {
    let done = 0;
    try {
      for (let i = 0; i < missing.length; i += LLM_CHUNK_SIZE) {
        const chunk = missing.slice(i, i + LLM_CHUNK_SIZE);
        const result = await llmTranslate(
          chunk.map((r) => ({ repo: r.repo, name: r.repo.split('/')[1], description: r.description || '' }))
        );
        // 合并：已有缓存的仓库只补 useCase，保持 title/desc 稳定不跳动
        for (const [repo, val] of Object.entries(result)) {
          trans[repo] = trans[repo] ? { ...trans[repo], useCase: val.useCase } : val;
        }
        done += Object.keys(result).length;
        // 逐批落盘：即使后面的批次失败，前面的成果也不会丢
        fs.writeFileSync(
          path.join(DATA_DIR, 'translations.json'),
          JSON.stringify(trans, null, 2) + '\n'
        );
      }
      console.log(`LLM 翻译完成：${done}/${missing.length}`);
    } catch (err) {
      console.warn(`LLM 翻译部分失败（已完成 ${done}/${missing.length}，下次运行续跑）：${err.message}`);
    }
  }
  for (const r of entries) {
    const tr = trans[r.repo];
    if (!tr) continue;
    if (!TITLES[r.repo] && tr.title) r.title = tr.title; // 手工映射优先
    r.descriptionZh = tr.desc || null;
    r.useCaseZh = tr.useCase || null;
  }
}

const TREND_RETENTION_DAYS = 180;

const latestName = (since) => (since === 'weekly' ? 'latest.json' : `latest-${since}.json`);
const archiveName = (since, date) => (since === 'weekly' ? `${date}.json` : `${since}-${date}.json`);

/**
 * 趋势追踪：维护 仓库 -> [{date, since, stars, gained}] 时间线。
 * 数据点按 日期+榜单类型 upsert（同天同榜重复运行只保留最新）；
 * 并从历史归档回填，保证脚本升级后趋势数据也能补齐。
 */
function updateTrends(date, since, todayRepos) {
  const file = path.join(DATA_DIR, 'trends.json');
  const trends = loadJson(file, {});

  // 从归档回填缺失的数据点（旧格式的 <date>.json 归档都是周榜）
  try {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      const mDaily = f.match(/^daily-(\d{4}-\d{2}-\d{2})\.json$/);
      const mWeekly = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      const archSince = mDaily ? 'daily' : mWeekly ? 'weekly' : null;
      const archDate = (mDaily || mWeekly || [])[1];
      if (!archDate) continue;
      const snap = loadJson(path.join(ARCHIVE_DIR, f), null);
      if (!snap || !Array.isArray(snap.repos)) continue;
      for (const r of snap.repos) {
        trends[r.repo] ??= [];
        if (!trends[r.repo].some((p) => p.date === archDate && (p.since || 'weekly') === archSince)) {
          trends[r.repo].push({ date: archDate, since: archSince, stars: r.stars, gained: r.weeklyStars });
        }
      }
    }
  } catch {
    /* 归档缺失不影响主流程 */
  }

  for (const r of todayRepos) {
    trends[r.repo] ??= [];
    const point = { date, since, stars: r.stars, gained: r.weeklyStars };
    const i = trends[r.repo].findIndex((p) => p.date === date && (p.since || 'weekly') === since);
    if (i >= 0) trends[r.repo][i] = point;
    else trends[r.repo].push(point);
  }

  // 排序 + 只保留最近 N 天，避免无限膨胀
  const cutoff = new Date(Date.now() - TREND_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const repo of Object.keys(trends)) {
    trends[repo] = trends[repo]
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((p) => p.date >= cutoff);
    if (trends[repo].length === 0) delete trends[repo];
  }

  fs.writeFileSync(file, JSON.stringify(trends, null, 2) + '\n');
}

/** since -> trending 页面上的计数文案：日榜是 "stars today"（不是 "this day"） */
const SINCE_WORD = { daily: 'today', weekly: 'week', monthly: 'month' };

/** 抓取并构建一个榜单（since = weekly | daily | monthly），返回完整 payload */
async function buildChart(since, nowIso) {
  const url = `https://github.com/trending?since=${since}`;
  console.log(`抓取 ${url} ...`);
  const html = await fetchText(url);
  const candidates = parseTrending(html, SINCE_WORD[since] || since.replace(/ly$/, ''));
  if (candidates.length === 0) {
    throw new Error(`Trending(${since}) 页面解析结果为空（页面结构可能变化，请检查 parseTrending）`);
  }
  console.log(`[${since}] 解析到 ${candidates.length} 个候选仓库，逐个调用 API 补充信息...`);

  const repos = [];
  for (const { repo, weeklyStars } of candidates) {
    try {
      const info = await ghApi(`/repos/${repo}`);
      if (info.fork) continue;
      repos.push({
        repo,
        owner: info.owner.login,
        ownerType: info.owner.type,
        weeklyStars,
        stars: info.stargazers_count,
        description: info.description || '',
        language: info.language || '',
        url: info.html_url,
      });
    } catch (err) {
      console.warn(`  跳过 ${repo}: ${err.message}`);
    }
  }

  repos.sort((a, b) => b.weeklyStars - a.weeklyStars);
  const topRaw = repos.slice(0, TOP_N);

  // 中文名/中文描述：titles.json 手工映射优先，其次 LLM 自动翻译（缓存），否则回退英文名
  await applyTranslations(topRaw);

  const top = topRaw.map((r, i) => {
    const c = companyOf(r.ownerType, r.owner);
    return {
      rank: i + 1,
      repo: r.repo,
      title: TITLES[r.repo] || r.title || r.repo.split('/')[1],
      company: c.zh,
      companyEn: c.en,
      weeklyStars: r.weeklyStars,
      stars: r.stars,
      description: r.description,
      descriptionZh: r.descriptionZh || null,
      useCaseZh: r.useCaseZh || null,
      language: r.language,
      url: r.url,
    };
  });
  if (top.length === 0) throw new Error(`[${since}] 没有可用数据`);

  return { generatedAt: nowIso, since, topN: TOP_N, repos: top };
}

async function main() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  // 离线翻译模式：只为已生成的 latest 文件补翻译，不抓取（本地网络不佳时使用）
  if (process.argv.includes('--translate-only')) {
    for (const since of CHARTS) {
      const file = path.join(DATA_DIR, latestName(since));
      const latest = loadJson(file, null);
      if (!latest || !Array.isArray(latest.repos)) continue;
      await applyTranslations(latest.repos);
      fs.writeFileSync(file, JSON.stringify(latest, null, 2) + '\n');
    }
    console.log('离线翻译完成');
    return;
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const historyEntries = [];
  const failures = [];

  for (const since of CHARTS) {
    let payload;
    try {
      payload = await buildChart(since, now.toISOString());
    } catch (err) {
      // 单个榜单失败不拖垮整个运行：其他榜单照常产出，LLM 缓存也能落盘提交
      console.warn(`[${since}] 本期抓取失败，跳过：${err.message}`);
      failures.push(since);
      continue;
    }
    const top = payload.repos;

    fs.writeFileSync(path.join(DATA_DIR, latestName(since)), JSON.stringify(payload, null, 2) + '\n');
    fs.writeFileSync(
      path.join(ARCHIVE_DIR, archiveName(since, date)),
      JSON.stringify(payload, null, 2) + '\n'
    );
    historyEntries.push({ date, since, top1: top[0].repo, top1Title: top[0].title, top1Stars: top[0].stars });
    updateTrends(date, since, top);

    const label = since === 'daily' ? '今日' : since === 'monthly' ? '本月' : '本周';
    console.log(`\n${label} Top ${top.length}（${date}）:`);
    for (const r of top) {
      console.log(
        `  ${String(r.rank).padStart(2)}. ${r.repo.padEnd(45)} +${r.weeklyStars.toLocaleString('en-US')} (${r.stars.toLocaleString('en-US')}) ${r.company}`
      );
    }
  }

  if (failures.length === CHARTS.length) {
    throw new Error(`所有榜单抓取均失败：${failures.join(', ')}`);
  }

  // 归档索引：按 日期+榜单类型 去重，倒序排列
  const history = loadJson(path.join(DATA_DIR, 'history.json'), []);
  const others = history.filter(
    (h) => !historyEntries.some((n) => n.date === h.date && n.since === h.since)
  );
  fs.writeFileSync(
    path.join(DATA_DIR, 'history.json'),
    JSON.stringify([...historyEntries, ...others].sort((a, b) => b.date.localeCompare(a.date)), null, 2) +
      '\n'
  );
  console.log(`\n已写入 data/latest*.json、data/archive/、data/history.json、data/trends.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
