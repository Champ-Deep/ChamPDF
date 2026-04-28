import { categories, type Pillar } from '../config/tools.js';
import { createIcons, icons } from 'lucide';
import '@phosphor-icons/web/regular';
import { initI18n, applyTranslations, rewriteLinks } from '../i18n/index.js';
import { renderToolGrid } from '../utils/render-tool-grid.js';
import { startBackgroundPreload } from '../utils/wasm-preloader.js';
import { initSignatureLibraryModal } from '../utils/signature-library-init.js';
import { initAuthModal } from '../components/auth-modal.js';
import {
  initToolCardsAnimation,
  initScrollReveals,
  initScrollToTopButton,
  updateActiveCategory as updateActiveCategoryAnimated,
} from '../animations/homepage-animations.js';
import { initAllMicroInteractions } from '../animations/micro-interactions.js';

const init = async () => {
  await initI18n();
  applyTranslations();

  const pillar = (document.body.dataset.pillar ?? 'documents') as Pillar;

  const filteredCategories = categories
    .map((cat) => ({
      ...cat,
      tools: cat.tools.filter((tool) => tool.pillar === pillar),
    }))
    .filter((cat) => cat.tools.length > 0);

  const toolGrid = document.getElementById('tool-grid');
  if (toolGrid) {
    renderToolGrid(filteredCategories, toolGrid);

    initToolCardsAnimation();
    initScrollReveals();
    initScrollToTopButton();
    initAllMicroInteractions();

    // Category nav
    const categoryNav = document.getElementById('category-nav');
    if (categoryNav) {
      const navContainer = categoryNav.querySelector('div');
      if (navContainer) {
        navContainer.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.className =
          'px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium whitespace-nowrap transition-colors';
        allBtn.textContent = 'All';
        allBtn.onclick = () => {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          updateActiveCategoryAnimated('all');
        };
        navContainer.appendChild(allBtn);

        filteredCategories.forEach((category) => {
          const categoryId = category.name.toLowerCase().replace(/\s+/g, '-');
          const btn = document.createElement('button');
          btn.className =
            'px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-medium whitespace-nowrap transition-colors';
          btn.textContent = category.name;
          btn.onclick = () => {
            const element = document.getElementById(categoryId);
            if (element) {
              const offset = 120;
              const elementPosition =
                element.getBoundingClientRect().top + window.pageYOffset;
              window.scrollTo({
                top: elementPosition - offset,
                behavior: 'smooth',
              });
              updateActiveCategoryAnimated(categoryId);
            }
          };
          navContainer.appendChild(btn);
        });
      }
    }

    // Search — scoped to this pillar
    const searchBar = document.getElementById(
      'search-bar'
    ) as HTMLInputElement | null;
    const categoryNavEl = document.getElementById('category-nav');
    const categoryGroups = toolGrid.querySelectorAll('.category-group');

    const searchResultsContainer = document.createElement('div');
    searchResultsContainer.id = 'search-results';
    searchResultsContainer.className =
      'hidden grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-6 col-span-full';
    toolGrid.insertBefore(searchResultsContainer, toolGrid.firstChild);

    if (searchBar) {
      searchBar.addEventListener('input', () => {
        const searchTerm = searchBar.value.toLowerCase().trim();

        if (!searchTerm) {
          searchResultsContainer.classList.add('hidden');
          searchResultsContainer.innerHTML = '';
          categoryNavEl?.classList.remove('hidden');
          categoryGroups.forEach((group) => {
            (group as HTMLElement).style.display = '';
          });
          return;
        }

        categoryNavEl?.classList.add('hidden');
        categoryGroups.forEach((group) => {
          (group as HTMLElement).style.display = 'none';
        });

        searchResultsContainer.innerHTML = '';
        searchResultsContainer.classList.remove('hidden');

        const seenIds = new Set<string>();
        const matched: HTMLElement[] = [];

        categoryGroups.forEach((group) => {
          group.querySelectorAll('.tool-card').forEach((card) => {
            const name = (
              card.querySelector('h3')?.textContent ?? ''
            ).toLowerCase();
            const subtitle = (
              card.querySelector('p')?.textContent ?? ''
            ).toLowerCase();
            const href = (card as HTMLAnchorElement).href ?? '';
            const id = href.split('/').pop()?.replace('.html', '') ?? name;

            if (
              (name.includes(searchTerm) || subtitle.includes(searchTerm)) &&
              !seenIds.has(id)
            ) {
              seenIds.add(id);
              matched.push(card.cloneNode(true) as HTMLElement);
            }
          });
        });

        if (matched.length === 0) {
          const emptyMsg = document.createElement('p');
          emptyMsg.className =
            'col-span-full text-center text-gray-400 py-16 text-lg';
          emptyMsg.textContent = `No tools found for "${searchTerm}"`;
          searchResultsContainer.appendChild(emptyMsg);
        } else {
          matched.forEach((el) => searchResultsContainer.appendChild(el));
          createIcons({ icons });
        }
      });

      window.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        const isMac = navigator.userAgent.toUpperCase().includes('MAC');
        if ((e.ctrlKey && key === 'k') || (isMac && e.metaKey && key === 'k')) {
          e.preventDefault();
          searchBar.focus();
        }
      });
    }
  }

  createIcons({ icons });
  startBackgroundPreload();
  initSignatureLibraryModal();
  initAuthModal();
  rewriteLinks();
};

window.addEventListener('load', init);
