/**
 * Search-first homepage (Option B) — renders the task pills, Browse pillar
 * filter, and the tool grid; wires the hero search + ⌘K command palette and the
 * light/dark theme toggle. Inner pages are unaffected (this only runs on the
 * homepage, where the new containers exist).
 */

import '@phosphor-icons/web/regular';
import {
  allTools,
  BROWSE_GROUPS,
  PRIVACY_META,
  type MetaTool,
  type BrowseGroup,
} from '../config/tool-meta.js';
import {
  initCommandPalette,
  openPalette,
} from '../components/command-palette.js';

const THEME_KEY = 'champdf:theme';
type ThemeName = 'dark' | 'light';

const TASKS: { label: string; icon: string; q: string }[] = [
  { label: 'Remove a watermark', icon: 'ph-eraser', q: 'watermark' },
  { label: 'Sign a PDF', icon: 'ph-pen-nib', q: 'sign' },
  { label: 'Summarize a video', icon: 'ph-list-bullets', q: 'transcript' },
  { label: 'Convert to PDF', icon: 'ph-file-arrow-down', q: 'convert' },
];

let activeFilter: 'all' | BrowseGroup = 'all';

function chipHtml(t: MetaTool): string {
  const m = PRIVACY_META[t.privacy];
  return `<span style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;height:22px;padding:0 9px;border-radius:9999px;font-family:var(--font-mono);font-size:10px;background:${m.bg};color:${m.fg};border:1px solid ${m.bd};"><i class="ph ${m.icon}" style="font-size:11px;"></i>${m.label}</span>`;
}

function cardHtml(t: MetaTool): string {
  const popular = t.popular
    ? `<span style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.08em;padding:2px 6px;border-radius:9999px;background:rgba(255,107,53,0.13);color:var(--ember);border:1px solid var(--amber-bd);">POPULAR</span>`
    : '';
  return `<a href="${t.href}" class="cham-card lift" style="position:relative;display:flex;gap:14px;align-items:flex-start;text-align:left;padding:18px;border-radius:14px;background:var(--s1);border:1px solid var(--bd1);text-decoration:none;">
    <span style="flex-shrink:0;display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:var(--s2);border:1px solid var(--bd1);"><i class="ph ${t.icon}" style="font-size:22px;color:var(--fg);"></i></span>
    <span style="min-width:0;flex:1;">
      <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-family:var(--font-display);font-weight:600;font-size:15px;color:var(--fg);">${t.name}</span>${popular}
      </span>
      <span style="display:block;font-size:13px;color:var(--fg3);line-height:1.45;margin-top:3px;">${t.subtitle}</span>
      ${chipHtml(t)}
    </span>
  </a>`;
}

function renderGrid() {
  const grid = document.getElementById('cham-grid');
  if (!grid) return;
  const tools =
    activeFilter === 'all'
      ? allTools
      : allTools.filter((t) => t.group === activeFilter);
  grid.innerHTML = tools.map(cardHtml).join('');
}

function renderFilter() {
  const wrap = document.getElementById('browse-filter');
  if (!wrap) return;
  wrap.innerHTML = BROWSE_GROUPS.map((g) => {
    const active = g.id === activeFilter;
    return `<button data-group="${g.id}" style="cursor:pointer;white-space:nowrap;font-size:13px;font-weight:500;padding:7px 14px;border-radius:9999px;border:1px solid ${active ? 'var(--ember)' : 'var(--bd1)'};background:${active ? 'var(--ember)' : 'var(--s1)'};color:${active ? '#fff' : 'var(--fg2)'};">${g.label}</button>`;
  }).join('');
  wrap
    .querySelectorAll<HTMLButtonElement>('button[data-group]')
    .forEach((b) => {
      b.addEventListener('click', () => {
        activeFilter = (b.dataset.group as 'all' | BrowseGroup) || 'all';
        renderFilter();
        renderGrid();
      });
    });
}

function renderTasks() {
  const wrap = document.getElementById('task-pills');
  if (!wrap) return;
  wrap.innerHTML = TASKS.map(
    (tk) =>
      `<button data-q="${tk.q}" class="lift" style="display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 15px;border-radius:9999px;background:var(--s2);border:1px solid var(--bd1);color:var(--fg);font-size:13.5px;font-weight:500;cursor:pointer;"><i class="ph ${tk.icon}" style="font-size:16px;color:var(--ember);"></i>${tk.label}</button>`
  ).join('');
  wrap.querySelectorAll<HTMLButtonElement>('button[data-q]').forEach((b) => {
    b.addEventListener('click', () => openPalette(b.dataset.q || ''));
  });
}

function currentTheme(): ThemeName {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: ThemeName) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (icon) icon.className = `ph ${theme === 'light' ? 'ph-sun' : 'ph-moon'}`;
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
}

function init() {
  applyTheme(currentTheme());
  renderTasks();
  renderFilter();
  renderGrid();

  document
    .getElementById('hero-search')
    ?.addEventListener('click', () => openPalette());
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next: ThemeName = currentTheme() === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  initCommandPalette();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
