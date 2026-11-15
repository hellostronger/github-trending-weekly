/* 渲染 data/latest.json、data/trends.json 与往期归档 */
'use strict';

const $ranking = document.getElementById('ranking');
const $subtitle = document.getElementById('subtitle');
const $updatedAt = document.getElementById('updated-at');
const $historySection = document.getElementById('history-section');
const $historyList = document.getElementById('history-list');
const $trendsSection = document.getElementById('trends-section');
const $trendsNote = document.getElementById('trends-note');
const $trendsList = document.getElementById('trends-list');

const fmt = (n) => Number(n).toLocaleString('en-US');

/* 常见语言颜色（仿 GitHub linguist） */
const LANG_COLORS = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  'C++': '#f34b7d',
  C: '#8b8b8b',
  Java: '#b07219',
  'C#': '#178600',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Vue: '#41b883',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Zig: '#ec915c',
  'Jupyter Notebook': '#DA5B0B',
  Dart: '#00B4AB',
  Lua: '#000080',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Svelte: '#ff3e00',
};
const langColor = (l) => LANG_COLORS[l] || '#8fa0d8';

/* trends.json：仓库 -> [{date, stars, weeklyStars}]；渲染榜单时用于画迷你曲线 */
let TRENDS = {};
let HISTORY = null;
const TITLE_BY_REPO = {};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 迷你趋势曲线（累计 star），不足 2 个数据点返回 null */
function sparklineSvg(points, w = 104, h = 30) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const vals = points.map((p) => p.stars);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
  const d = vals
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', String((points.length - 1) * step));
  dot.setAttribute('cy', String(y(vals[vals.length - 1]).toFixed(1)));
  dot.setAttribute('r', '2.5');
  const tip = document.createElementNS(NS, 'title');
  tip.textContent = `${points[0].date} → ${points[points.length - 1].date}：${fmt(vals[0])} → ${fmt(vals[vals.length - 1])} star`;
  svg.append(path, dot, tip);
  return svg;
}

function renderRanking(data, label) {
  $ranking.replaceChildren();
  const repos = data.repos || [];
  if (repos.length === 0) {
    $ranking.append(el('div', 'empty', '暂无数据'));
    return;
  }

  $subtitle.textContent = `GITHUB TRENDING ${data.since === 'daily' ? '日榜' : data.since === 'monthly' ? '月榜' : '周榜'} · ${label}`;
  document.getElementById('top-count').textContent = String(repos.length);

  for (const r of repos) {
    if (r.title) TITLE_BY_REPO[r.repo] = r.title;
    const row = el('a', 'row' + (r.rank <= 3 ? ' top3' : ''));
    row.href = r.url || `https://github.com/${r.repo}`;
    row.target = '_blank';
    row.rel = 'noopener';

    row.append(el('span', 'rank', String(r.rank)));

    const proj = el('span', 'proj');
    proj.append(el('span', 'name', r.title || r.repo));
    const pathline = el('span', 'pathline');
    pathline.append(el('span', 'path', r.repo));
    if (r.language) {
      const pill = el('span', 'lang');
      const dot = el('i');
      dot.style.background = langColor(r.language);
      pill.append(dot, el('span', null, r.language));
      pathline.append(pill);
    }
    proj.append(pathline);
    if (r.description) proj.append(el('span', 'desc', r.description));
    row.append(proj);

    row.append(el('span', 'company', r.company || ''));

    const trendCell = el('span', 'trend');
    const spark = sparklineSvg(TRENDS[r.repo]);
    if (spark) trendCell.append(spark);
    row.append(trendCell);

    row.append(el('span', 'delta', `+${fmt(r.weeklyStars)}`));
    row.append(el('span', 'stars', fmt(r.stars)));

    $ranking.append(row);
  }

  const when = new Date(data.generatedAt);
  $updatedAt.textContent = `数据来自 GitHub Trending · 最后更新：${isNaN(when) ? label : when.toLocaleString('zh-CN')}`;
}

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function showLatest() {
  try {
    const data = await loadJson('data/latest.json');
    renderRanking(data, data.generatedAt ? data.generatedAt.slice(0, 10) : '');
  } catch (err) {
    $ranking.replaceChildren(el('div', 'empty', `加载失败：${err.message}（请先运行 node scripts/fetch-trending.mjs 生成数据）`));
  }
}

/* —— 趋势追踪卡片区 —— */
function scrollToRepo(repo) {
  const row = [...document.querySelectorAll('#ranking .row .path')].find(
    (n) => n.textContent === repo
  );
  if (!row) return;
  const target = row.closest('.row');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash');
  void target.offsetWidth; // 强制 reflow，确保动画可重复触发
  target.classList.add('flash');
}

function renderTrendCard(repo, pts) {
  const card = el('button', 'trend-card');
  card.type = 'button';

  const info = el('span', 'trend-info');
  info.append(el('span', 't1', TITLE_BY_REPO[repo] || repo.split('/')[1]));
  info.append(el('span', 'r', repo));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const meta = el('span', 'meta');
  meta.append(el('span', null, '上榜 '));
  meta.append(el('b', null, `${pts.length} 天`));
  meta.append(el('span', null, ` · ${fmt(first.stars)} → ${fmt(last.stars)} star`));
  info.append(meta);
  card.append(info);

  const spark = sparklineSvg(pts);
  if (spark) card.append(spark);

  card.addEventListener('click', () => scrollToRepo(repo));
  return card;
}

/* 加载趋势时间线数据（需在渲染榜单前调用，迷你曲线才有数据） */
async function loadTrends() {
  try {
    TRENDS = await loadJson('data/trends.json');
  } catch {
    TRENDS = {};
  }
}

/* 渲染趋势追踪卡片区（需在渲染榜单后调用，才能拿到中文标题） */
async function renderTrendsSection() {
  const entries = Object.entries(TRENDS)
    .map(([repo, pts]) => ({ repo, pts: [...pts].sort((a, b) => a.date.localeCompare(b.date)) }))
    .filter((e) => e.pts.length > 0)
    .sort((a, b) => b.pts.length - a.pts.length || b.pts.at(-1).stars - a.pts.at(-1).stars);
  if (entries.length === 0) return;

  $trendsSection.hidden = false;
  const growing = entries.filter((e) => e.pts.length >= 2).length;
  $trendsNote.textContent =
    growing > 0
      ? `已追踪 ${entries.length} 个上榜仓库 · 曲线为累计 Star 走势，点击卡片定位到榜单行`
      : `已追踪 ${entries.length} 个上榜仓库 · 趋势曲线将从积累第 2 天数据开始显示`;
  $trendsList.replaceChildren();
  for (const e of entries.slice(0, 8)) $trendsList.append(renderTrendCard(e.repo, e.pts));
}

async function initHistory() {
  try {
    const history = await loadJson('data/history.json');
    if (!Array.isArray(history) || history.length === 0) return;
    HISTORY = history;
    $historySection.hidden = false;
    $historyList.replaceChildren();
    for (const h of history) {
      const li = document.createElement('li');
      const btn = el('button');
      btn.append(el('span', 'date', h.date));
      btn.append(el('span', 't1', `TOP1 ${h.top1Title || h.top1 || ''}`));
      btn.addEventListener('click', () => showArchive(h.date));
      li.append(btn);
      $historyList.append(li);
    }
  } catch {
    /* 没有历史归档时静默隐藏 */
  }
}

/* 标题下的动态状态徽章：让访客一眼了解页面在做什么、数据有多新 */
function renderHeroStats() {
  const $stats = document.getElementById('hero-stats');
  if (!$stats) return;
  const days = Array.isArray(HISTORY) ? HISTORY.length : 0;
  const repos = Object.keys(TRENDS).length;
  const chip = (parts) => {
    const c = el('span', 'chip');
    for (const p of parts) c.append(p);
    return c;
  };
  const chips = [
    chip([el('span', null, '📅 已运行 '), el('b', null, `${days || 1} 天`)]),
    chip([el('span', null, '📦 累计追踪 '), el('b', null, `${repos} 个仓库`)]),
    chip([el('span', null, '⭐ 数据源 GitHub Trending')]),
    chip([el('span', null, '🕙 每天自动更新')]),
  ];
  $stats.replaceChildren(...chips);
}

async function showArchive(date) {
  $ranking.replaceChildren(el('div', 'loading', `加载 ${date} 归档…`));
  try {
    const data = await loadJson(`data/archive/${date}.json`);
    renderRanking(data, date);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    $ranking.replaceChildren(el('div', 'empty', `归档加载失败：${err.message}`));
  }
}

(async function init() {
  // 星空背景
  const sky = document.getElementById('stars');
  for (let i = 0; i < 140; i++) {
    const star = document.createElement('i');
    const size = Math.random() < 0.85 ? 1 + Math.random() * 1.4 : 2.5 + Math.random() * 1.5;
    star.style.width = star.style.height = `${size}px`;
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.animationDelay = `${(Math.random() * 3).toFixed(2)}s`;
    if (Math.random() < 0.12) star.className = 'gold';
    sky.append(star);
  }

  initHistory();
  await loadTrends();
  await showLatest();
  await renderTrendsSection();
  renderHeroStats();
})();
