/**
 * ⌘K Command Palette — fuzzy tool search for the search-first homepage.
 *
 * Fuse.js over the full tool registry (weighted name > keywords > subtitle),
 * keyboard navigation, privacy chips, and a recent-tools list when the query is
 * empty. Open with ⌘K / Ctrl+K / "/" or by calling openPalette(). Self-contained:
 * builds its own overlay DOM on first open and attaches global key handlers via
 * initCommandPalette().
 */

import Fuse from 'fuse.js';
import {
  allTools,
  PRIVACY_META,
  PILLAR_LABEL,
  type MetaTool,
} from '../config/tool-meta.js';

const RECENT_KEY = 'champdf:recent-tools';
const MAX_RESULTS = 14;

const fuse = new Fuse(allTools, {
  includeScore: true,
  threshold: 0.42, // typo tolerance without going noisy
  ignoreLocation: true,
  keys: [
    { name: 'name', weight: 0.6 },
    { name: 'keywords', weight: 0.3 },
    { name: 'subtitle', weight: 0.15 },
    { name: 'category', weight: 0.05 },
  ],
});

let overlay: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLDivElement | null = null;
let isOpen = false;
let activeIndex = 0;
let current: MetaTool[] = [];

function recentTools(): MetaTool[] {
  try {
    const files: string[] = JSON.parse(
      localStorage.getItem(RECENT_KEY) || '[]'
    );
    const byFile = new Map(
      allTools.map((t) => [t.href.split('/').pop() || t.href, t])
    );
    return files
      .map((f) => byFile.get(f))
      .filter((t): t is MetaTool => !!t)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function pushRecent(tool: MetaTool) {
  try {
    const file = tool.href.split('/').pop() || tool.href;
    const prev: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const next = [file, ...prev.filter((f) => f !== file)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore storage errors */
  }
}

function chip(tool: MetaTool): string {
  const m = PRIVACY_META[tool.privacy];
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10px;padding:2px 8px;border-radius:9999px;background:${m.bg};color:${m.fg};border:1px solid ${m.bd};white-space:nowrap;"><i class="ph ${m.icon}" style="font-size:11px;"></i>${m.label}</span>`;
}

function render() {
  if (!listEl) return;
  if (current.length === 0) {
    listEl.innerHTML = `<div style="padding:28px;text-align:center;color:var(--fg3);font-size:14px;">No tool matches that yet.</div>`;
    return;
  }
  listEl.innerHTML = current
    .map((t, i) => {
      const active = i === activeIndex;
      return `<button data-idx="${i}" class="cp-row" style="width:100%;display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:${active ? 'var(--s2)' : 'transparent'};border:none;cursor:pointer;text-align:left;">
        <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--s2);border:1px solid var(--bd1);flex-shrink:0;"><i class="ph ${t.icon}" style="font-size:17px;color:var(--fg);"></i></span>
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-weight:600;font-size:14px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.name}</span>
          <span style="display:block;font-size:12px;color:var(--fg3);">${PILLAR_LABEL[t.group]}</span>
        </span>
        ${chip(t)}
      </button>`;
    })
    .join('');

  listEl.querySelectorAll<HTMLButtonElement>('.cp-row').forEach((row) => {
    row.addEventListener('click', () => {
      const i = Number(row.dataset.idx);
      if (!Number.isNaN(i)) go(current[i]);
    });
    row.addEventListener('mousemove', () => {
      const i = Number(row.dataset.idx);
      if (!Number.isNaN(i) && i !== activeIndex) {
        activeIndex = i;
        render();
      }
    });
  });
}

function search(query: string) {
  const q = query.trim();
  if (!q) {
    const recent = recentTools();
    current = recent.length
      ? recent
      : allTools.filter((t) => t.popular).slice(0, 8);
  } else {
    current = fuse.search(q, { limit: MAX_RESULTS }).map((r) => r.item);
  }
  activeIndex = 0;
  render();
}

function go(tool: MetaTool | undefined) {
  if (!tool) return;
  pushRecent(tool);
  window.location.href = tool.href;
}

function ensureDom() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'command-palette';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,0.55);display:none;align-items:flex-start;justify-content:center;padding:96px 20px 20px;backdrop-filter:blur(3px);';
  overlay.innerHTML = `
    <div id="cp-panel" style="width:100%;max-width:560px;border-radius:16px;overflow:hidden;background:var(--s1);border:1px solid var(--bd2);box-shadow:var(--shadow-xl);">
      <div style="display:flex;align-items:center;gap:11px;padding:0 16px;height:54px;border-bottom:1px solid var(--bd1);">
        <i class="ph ph-magnifying-glass" style="font-size:19px;color:var(--fg3);"></i>
        <input id="cp-input" placeholder="Type a tool, format, or task" autocomplete="off" spellcheck="false" style="flex:1;background:transparent;border:none;outline:none;color:var(--fg);font-family:var(--font-sans);font-size:15px;" />
        <kbd style="font-family:var(--font-mono);font-size:11px;padding:3px 8px;border-radius:6px;background:var(--s2);border:1px solid var(--bd1);color:var(--fg2);">esc</kbd>
      </div>
      <div id="cp-list" style="max-height:340px;overflow-y:auto;padding:8px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  inputEl = overlay.querySelector('#cp-input');
  listEl = overlay.querySelector('#cp-list');

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
  });
  inputEl?.addEventListener('input', () => search(inputEl!.value));
  inputEl?.addEventListener('keydown', onInputKey);
}

function onInputKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, current.length - 1);
    render();
    scrollActiveIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    render();
    scrollActiveIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(current[activeIndex]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
}

function scrollActiveIntoView() {
  listEl
    ?.querySelector<HTMLElement>(`.cp-row[data-idx="${activeIndex}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

export function openPalette(initialQuery = '') {
  ensureDom();
  if (!overlay || !inputEl) return;
  isOpen = true;
  overlay.style.display = 'flex';
  inputEl.value = initialQuery;
  search(initialQuery);
  // focus after paint
  requestAnimationFrame(() => inputEl?.focus());
}

export function closePalette() {
  if (!overlay) return;
  isOpen = false;
  overlay.style.display = 'none';
}

/** Attach global open shortcuts (⌘K / Ctrl+K / "/"). Call once per page. */
export function initCommandPalette() {
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      isOpen ? closePalette() : openPalette();
      return;
    }
    if (e.key === '/' && !isOpen && !isTypingTarget(e.target)) {
      e.preventDefault();
      openPalette();
    }
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}
