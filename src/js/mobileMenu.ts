import { categories, toolsByPillar, type Pillar } from './config/tools.js';

document.addEventListener('DOMContentLoaded', () => {
  // ── Mobile hamburger ───────────────────────────────────────────────────────
  const mobileMenuButton = document.getElementById('mobile-menu-button');
  const mobileMenu = document.getElementById('mobile-menu');
  const menuIcon = document.getElementById('menu-icon');
  const closeIcon = document.getElementById('close-icon');

  function closeMobileMenu() {
    mobileMenu?.classList.add('hidden');
    menuIcon?.classList.remove('hidden');
    closeIcon?.classList.add('hidden');
    mobileMenuButton?.setAttribute('aria-expanded', 'false');
  }

  if (mobileMenuButton && mobileMenu && menuIcon && closeIcon) {
    mobileMenuButton.addEventListener('click', () => {
      const isExpanded =
        mobileMenuButton.getAttribute('aria-expanded') === 'true';
      mobileMenu.classList.toggle('hidden');
      menuIcon.classList.toggle('hidden');
      closeIcon.classList.toggle('hidden');
      mobileMenuButton.setAttribute('aria-expanded', (!isExpanded).toString());
    });

    // B7 fix: close on both <a> and <button> clicks inside the mobile menu
    mobileMenu.querySelectorAll('a, button').forEach((el) => {
      el.addEventListener('click', closeMobileMenu);
    });

    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      if (
        !mobileMenu.contains(target) &&
        !mobileMenuButton.contains(target) &&
        !mobileMenu.classList.contains('hidden')
      ) {
        closeMobileMenu();
      }
    });
  }

  // ── Desktop mega-menu ──────────────────────────────────────────────────────
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function openDropdown(menu: HTMLElement, btn: HTMLElement) {
    if (closeTimer) clearTimeout(closeTimer);
    // Close all other dropdowns first
    document.querySelectorAll<HTMLElement>('.mega-menu').forEach((m) => {
      if (m !== menu) {
        m.classList.remove('open');
        m.previousElementSibling?.setAttribute('aria-expanded', 'false');
      }
    });
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown(menu: HTMLElement, btn: HTMLElement, delay = 0) {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }, delay);
  }

  function closeAllDropdowns() {
    if (closeTimer) clearTimeout(closeTimer);
    document.querySelectorAll<HTMLElement>('.mega-menu').forEach((m) => {
      m.classList.remove('open');
    });
    document.querySelectorAll<HTMLElement>('.pillar-nav-btn').forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  document
    .querySelectorAll<HTMLElement>('.pillar-dropdown-wrapper')
    .forEach((wrapper) => {
      const btn = wrapper.querySelector<HTMLElement>('.pillar-nav-btn');
      const menu = wrapper.querySelector<HTMLElement>('.mega-menu');
      if (!btn || !menu) return;

      wrapper.addEventListener('mouseenter', () => openDropdown(menu, btn));
      wrapper.addEventListener('mouseleave', () =>
        closeDropdown(menu, btn, 120)
      );

      btn.addEventListener('click', () => {
        if (menu.classList.contains('open')) {
          closeDropdown(menu, btn);
        } else {
          openDropdown(menu, btn);
        }
      });

      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (menu.classList.contains('open')) {
            closeDropdown(menu, btn);
          } else {
            openDropdown(menu, btn);
          }
        }
      });
    });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllDropdowns();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    const insideAnyWrapper = Array.from(
      document.querySelectorAll('.pillar-dropdown-wrapper')
    ).some((w) => w.contains(target));
    if (!insideAnyWrapper) closeAllDropdowns();
  });

  // ── Mobile pillar accordion ────────────────────────────────────────────────
  document
    .querySelectorAll<HTMLElement>('.mobile-pillar-toggle')
    .forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const section = toggle.closest<HTMLElement>('.mobile-pillar-section');
        if (!section) return;
        const content = section.querySelector<HTMLElement>(
          '.mobile-pillar-content'
        );
        const chevron = toggle.querySelector<HTMLElement>('.pillar-chevron');
        const isOpen = section.classList.contains('open');

        // Collapse all sections first
        document
          .querySelectorAll<HTMLElement>('.mobile-pillar-section')
          .forEach((s) => {
            s.classList.remove('open');
            const c = s.querySelector<HTMLElement>('.mobile-pillar-content');
            const ch = s.querySelector<HTMLElement>('.pillar-chevron');
            if (c) c.style.maxHeight = '0';
            if (ch) ch.style.transform = '';
          });

        // Expand the clicked section if it was closed
        if (!isOpen && content) {
          section.classList.add('open');
          content.style.maxHeight = content.scrollHeight + 'px';
          if (chevron) chevron.style.transform = 'rotate(180deg)';
        }
      });
    });

  // ── Active pillar detection ────────────────────────────────────────────────
  const currentPath = window.location.pathname;
  const currentPage = currentPath.split('/').pop()?.replace('.html', '') ?? '';

  if (currentPage) {
    const allTools = categories.flatMap((c) => c.tools);
    const matchedTool = allTools.find((t) => {
      const toolPage = t.href.split('/').pop()?.replace('.html', '') ?? '';
      return toolPage === currentPage;
    });

    if (matchedTool) {
      const pillarBtn = document.querySelector<HTMLElement>(
        `.pillar-nav-btn[data-pillar="${matchedTool.pillar}"]`
      );
      pillarBtn?.classList.add('is-active');
    }
  }

  // ── Populate mega-menu dropdowns ───────────────────────────────────────────
  const pillars: Pillar[] = ['documents', 'images', 'video'];
  const pillarHubHrefs: Record<Pillar, string> = {
    documents: 'documents.html',
    images: 'images.html',
    video: 'video.html',
  };
  const TOP_N = 8;

  pillars.forEach((pillar) => {
    const menuEl = document.getElementById(`mega-menu-${pillar}`);
    if (!menuEl) return;

    const topTools = toolsByPillar(pillar).slice(0, TOP_N);

    const grid = document.createElement('div');
    grid.className = 'mega-menu-grid';

    topTools.forEach((tool) => {
      const a = document.createElement('a');
      a.href = tool.href;
      a.className = 'mega-menu-item';

      const icon = document.createElement('i');
      icon.className = `ph ${tool.icon} text-orange-400 text-lg flex-shrink-0`;

      const span = document.createElement('span');
      span.textContent = tool.name;

      a.append(icon, span);
      grid.appendChild(a);
    });

    const viewAll = document.createElement('a');
    viewAll.href = pillarHubHrefs[pillar];
    viewAll.className = 'mega-menu-view-all';
    viewAll.textContent = 'View all →';

    menuEl.append(grid, viewAll);
  });

  // ── Populate mobile pillar tool lists ─────────────────────────────────────
  pillars.forEach((pillar) => {
    const listEl = document.getElementById(`mobile-pillar-tools-${pillar}`);
    if (!listEl) return;

    const topTools = toolsByPillar(pillar).slice(0, 6);
    topTools.forEach((tool) => {
      const a = document.createElement('a');
      a.href = tool.href;
      a.className = 'mobile-pillar-tool-link';

      const icon = document.createElement('i');
      icon.className = `ph ${tool.icon} text-orange-400 text-base flex-shrink-0`;

      const span = document.createElement('span');
      span.textContent = tool.name;

      a.append(icon, span);
      listEl.appendChild(a);
    });

    const viewAll = document.createElement('a');
    viewAll.href = pillarHubHrefs[pillar];
    viewAll.className = 'mobile-pillar-tool-link text-orange-400 font-medium';
    viewAll.textContent = 'View all →';
    listEl.appendChild(viewAll);
  });
});
