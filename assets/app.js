/* 渲染 data/latest.json 与往期归档 */
'use strict';

const $ranking = document.getElementById('ranking');
const $subtitle = document.getElementById('subtitle');
const $updatedAt = document.getElementById('updated-at');
const $historySection = document.getElementById('history-section');
const $historyList = document.getElementById('history-list');

const fmt = (n) => Number(n).toLocaleString('en-US');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
    const row = el('a', 'row' + (r.rank <= 3 ? ' top3' : ''));
    row.href = r.url || `https://github.com/${r.repo}`;
    row.target = '_blank';
    row.rel = 'noopener';

    row.append(el('span', 'rank', String(r.rank)));

    const proj = el('span', 'proj');
    proj.append(el('span', 'name', r.title || r.repo));
    proj.append(el('span', 'path', r.repo));
    if (r.description) proj.append(el('span', 'desc', r.description));
    row.append(proj);

    row.append(el('span', 'company', r.company || ''));
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

async function initHistory() {
  try {
    const history = await loadJson('data/history.json');
    if (!Array.isArray(history) || history.length === 0) return;
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

(function init() {
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
  showLatest();
})();
