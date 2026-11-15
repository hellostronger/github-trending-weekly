#!/usr/bin/env node
/**
 * 抓取 GitHub Trending 周榜，生成监控数据：
 *   data/latest.json            当前一周 Top 10（页面主展示）
 *   data/archive/<date>.json    按天归档（历史可回看）
 *   data/history.json           归档索引（页面「往期榜单」用）
 *
 * 数据来源：
 *   1. https://github.com/trending?since=weekly  —— 每个仓库自带 "N stars this week"（本周新增）
 *   2. GitHub REST API /repos/{owner}/{repo}      —— 累计 star、描述、语言、所属类型
 *
 * 可选环境变量：
 *   GITHUB_TOKEN      提升 API 限流（60 次/小时 -> 5000 次/小时）
 *   TRENDING_SINCE    weekly（默认）| daily | monthly
 *   TOP_N             取前几名，默认 10
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const TOP_N = Number(process.env.TOP_N || 10);
const SINCE = process.env.TRENDING_SINCE || 'weekly';
const TRENDING_URL = `https://github.com/trending?since=${SINCE}`;

/** org(小写) -> 展示名；没匹配上的 Organization 显示 login，个人账号显示「个人开发者」 */
const COMPANY_MAP = {
  meta: 'Meta',
  google: '谷歌',
  'google-deepmind': '谷歌 DeepMind',
  'google-gemini': '谷歌',
  anthropics: 'Anthropic',
  anthropic: 'Anthropic',
  vercel: 'Vercel',
  'vercel-labs': 'Vercel',
  openai: 'OpenAI',
  microsoft: '微软',
  huggingface: 'Hugging Face',
  'xai-org': 'xAI',
  'deepseek-ai': 'DeepSeek',
  'sherlock-project': 'Sherlock Project',
  QwenLM: '阿里通义',
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

/** 从 trending 页面按 <article> 块解析出仓库路径与 "N stars this week" */
function parseTrending(html, sinceWord) {
  const re = new RegExp(`([\\d,]+)\\s+stars this ${sinceWord}`, 'i');
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
  if (ownerType !== 'Organization') return '个人开发者';
  return COMPANY_MAP[login.toLowerCase()] ?? login;
}

async function main() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  console.log(`抓取 ${TRENDING_URL} ...`);
  const html = await fetchText(TRENDING_URL);
  const candidates = parseTrending(html, SINCE.replace(/ly$/, ''));
  if (candidates.length === 0) {
    throw new Error('Trending 页面解析结果为空（页面结构可能变化，请检查 parseTrending）');
  }
  console.log(`解析到 ${candidates.length} 个候选仓库，逐个调用 API 补充信息...`);

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
  const top = repos.slice(0, TOP_N).map((r, i) => ({
    rank: i + 1,
    repo: r.repo,
    title: TITLES[r.repo] || r.repo.split('/')[1],
    company: companyOf(r.ownerType, r.owner),
    weeklyStars: r.weeklyStars,
    stars: r.stars,
    description: r.description,
    language: r.language,
    url: r.url,
  }));
  if (top.length === 0) throw new Error('没有可用数据');

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const payload = {
    generatedAt: now.toISOString(),
    since: SINCE,
    topN: TOP_N,
    repos: top,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(path.join(ARCHIVE_DIR, `${date}.json`), JSON.stringify(payload, null, 2) + '\n');

  // 归档索引：按日期去重（同一天重复运行只保留最新），倒序排列
  const history = loadJson(path.join(DATA_DIR, 'history.json'), []);
  const entry = { date, since: SINCE, top1: top[0].repo, top1Title: top[0].title, top1Stars: top[0].stars };
  const others = history.filter((h) => h.date !== date || h.since !== SINCE);
  fs.writeFileSync(
    path.join(DATA_DIR, 'history.json'),
    JSON.stringify([entry, ...others].sort((a, b) => b.date.localeCompare(a.date)), null, 2) + '\n'
  );

  console.log(`\n本周 Top ${top.length}（${date}）:`);
  for (const r of top) {
    console.log(`  ${String(r.rank).padStart(2)}. ${r.repo.padEnd(45)} +${r.weeklyStars.toLocaleString('en-US')} (${r.stars.toLocaleString('en-US')}) ${r.company}`);
  }
  console.log(`\n已写入 data/latest.json、data/archive/${date}.json、data/history.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
