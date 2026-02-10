/**
 * Homepage Animations
 * Tool cards, scroll reveals, category navigation
 */

import { gsap, ScrollTrigger } from './gsap-init';
import { animate } from './motion-init';
import { getAnimationConfig } from './utils';

/**
 * Initialize tool cards stagger animation
 * Animates cards in on page load with grid stagger pattern
 */
export function initToolCardsAnimation(): void {
  const cards = document.querySelectorAll('.tool-card');
  if (!cards.length) return;

  // Only animate cards that are initially visible (above the fold)
  // Cards below the fold will be handled by scroll reveals
  const cardsArray = Array.from(cards);
  const viewportHeight = window.innerHeight;

  const visibleCards = cardsArray.filter((card) => {
    const rect = (card as HTMLElement).getBoundingClientRect();
    return rect.top < viewportHeight;
  });

  if (visibleCards.length > 0) {
    // Set initial state only for visible cards
    gsap.set(visibleCards, {
      opacity: 0,
      y: 30,
      scale: 0.95,
    });

    // Stagger animation on load for visible cards only
    gsap.to(visibleCards, {
      ...getAnimationConfig({
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.6,
        ease: 'power2.out',
        delay: 0.2,
      }),
      stagger: {
        amount: 0.8,
        grid: 'auto' as any,
        from: 'start',
      },
    });
  }

  // Add hover animations to ALL cards with Motion One (more performant)
  cards.forEach((card) => {
    const cardElement = card as HTMLElement;

    cardElement.addEventListener('mouseenter', () => {
      animate(
        cardElement,
        { transform: 'scale(1.05) translateY(-8px)' } as any,
        { duration: 0.3, easing: 'ease-out' } as any
      );
    });

    cardElement.addEventListener('mouseleave', () => {
      animate(
        cardElement,
        { transform: 'scale(1) translateY(0)' } as any,
        { duration: 0.3, easing: 'ease-in-out' } as any
      );
    });
  });
}

/**
 * Initialize scroll reveal animations for category sections
 */
export function initScrollReveals(): void {
  const categoryGroups = document.querySelectorAll('.category-group');
  if (!categoryGroups.length) return;

  categoryGroups.forEach((group) => {
    // Only animate the category title (h2), not the whole group
    const categoryTitle = group.querySelector('h2');
    if (categoryTitle) {
      gsap.from(
        categoryTitle,
        getAnimationConfig({
          scrollTrigger: {
            trigger: group,
            start: 'top 85%',
            toggleActions: 'play none none none', // Only play once
          },
          opacity: 0,
          x: -30,
          duration: 0.6,
          ease: 'power2.out',
        })
      );
    }

    // Tool cards within category stagger in when scrolled into view
    const cards = group.querySelectorAll('.tool-card');
    if (cards.length) {
      // Check if cards are already visible (handled by initial animation)
      const viewportHeight = window.innerHeight;
      const groupRect = (group as HTMLElement).getBoundingClientRect();

      // Only add scroll trigger if group is below the fold
      if (groupRect.top > viewportHeight) {
        gsap.from(
          cards,
          getAnimationConfig({
            scrollTrigger: {
              trigger: group,
              start: 'top 80%',
              toggleActions: 'play none none none', // Only play once, don't reverse
            },
            opacity: 0,
            y: 30,
            stagger: 0.05,
            duration: 0.5,
            ease: 'power2.out',
          })
        );
      }
    }
  });
}

/**
 * Enhanced scroll-to-top button animation
 */
export function initScrollToTopButton(): void {
  const scrollToTopBtn = document.getElementById('scroll-to-top-btn');
  if (!scrollToTopBtn) return;

  let lastScrollY = window.scrollY;

  window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;

    if (currentScrollY < lastScrollY && currentScrollY > 300) {
      // Scrolling up and past threshold - show button
      gsap.to(
        scrollToTopBtn,
        getAnimationConfig({
          opacity: 1,
          y: 0,
          visibility: 'visible',
          duration: 0.3,
          ease: 'power2.out',
        })
      );
    } else {
      // Scrolling down or near top - hide button
      gsap.to(
        scrollToTopBtn,
        getAnimationConfig({
          opacity: 0,
          y: 40,
          duration: 0.3,
          ease: 'power2.in',
          onComplete: () => {
            scrollToTopBtn.style.visibility = 'hidden';
          },
        })
      );
    }

    lastScrollY = currentScrollY;
  });

  // Smooth scroll to top on click
  scrollToTopBtn.addEventListener('click', () => {
    gsap.to(window, {
      duration: 0.8,
      scrollTo: { y: 0 },
      ease: 'power2.inOut',
    });
  });
}

/**
 * Animated category navigation active states
 */
export function updateActiveCategory(categoryId: string): void {
  const categoryNav = document.getElementById('category-nav');
  if (!categoryNav) return;

  const buttons = categoryNav.querySelectorAll('button');

  buttons.forEach((btn, index) => {
    const isActive =
      (index === 0 && categoryId === 'all') ||
      btn.textContent?.toLowerCase().replace(/\s+/g, '-') === categoryId;

    if (isActive) {
      // Animate to active state
      gsap.to(
        btn,
        getAnimationConfig({
          backgroundColor: '#c8232c',
          color: '#ffffff',
          scale: 1.05,
          duration: 0.3,
        })
      );
    } else {
      // Animate to inactive state
      gsap.to(
        btn,
        getAnimationConfig({
          backgroundColor: '#374151',
          color: '#d1d5db',
          scale: 1,
          duration: 0.3,
        })
      );
    }
  });
}
