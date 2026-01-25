/**
 * Micro-Interactions
 * Button press effects, icon animations, and other small UI feedback
 */

import { animate } from './motion-init';
import { shouldReduceMotion } from './utils';

/**
 * Initialize button press animations
 * Adds press-down feedback to all buttons
 */
export function initButtonAnimations(): void {
  const buttons = document.querySelectorAll('.btn, .btn-gradient, button');

  buttons.forEach((button) => {
    const buttonElement = button as HTMLElement;

    // Press down effect
    buttonElement.addEventListener('mousedown', () => {
      if (shouldReduceMotion()) return;

      animate(
        buttonElement,
        { transform: 'scale(0.95)' } as any,
        { duration: 0.1, easing: 'ease-out' } as any
      );
    });

    // Release effect
    buttonElement.addEventListener('mouseup', () => {
      if (shouldReduceMotion()) return;

      animate(
        buttonElement,
        { transform: 'scale(1)' } as any,
        { duration: 0.2, easing: 'ease-out' } as any
      );
    });

    // Mouse leave (in case user drags off button)
    buttonElement.addEventListener('mouseleave', () => {
      if (shouldReduceMotion()) return;

      animate(
        buttonElement,
        { transform: 'scale(1)' } as any,
        { duration: 0.2, easing: 'ease-out' } as any
      );
    });
  });
}

/**
 * Initialize icon hover animations
 * Adds scale and rotation to Lucide icons on parent hover
 */
export function initIconAnimations(): void {
  const icons = document.querySelectorAll('[data-lucide]');

  icons.forEach((icon) => {
    const parent = icon.closest('button, a, .cursor-pointer');
    if (!parent) return;

    const iconElement = icon as HTMLElement;

    parent.addEventListener('mouseenter', () => {
      if (shouldReduceMotion()) return;

      animate(
        iconElement,
        { transform: 'scale(1.1) rotate(5deg)' } as any,
        { duration: 0.3, easing: 'ease-out' } as any
      );
    });

    parent.addEventListener('mouseleave', () => {
      if (shouldReduceMotion()) return;

      animate(
        iconElement,
        { transform: 'scale(1) rotate(0deg)' } as any,
        { duration: 0.3, easing: 'ease-in-out' } as any
      );
    });
  });
}

/**
 * Initialize search bar focus animations
 */
export function initSearchAnimations(): void {
  const searchBar = document.getElementById('search-bar');
  if (!searchBar) return;

  // Focus animation
  searchBar.addEventListener('focus', () => {
    if (shouldReduceMotion()) return;

    animate(
      searchBar,
      {
        transform: 'scale(1.02)',
        boxShadow: '0 0 0 3px rgba(200, 35, 44, 0.3)',
      } as any,
      { duration: 0.2 } as any
    );
  });

  // Blur animation
  searchBar.addEventListener('blur', () => {
    if (shouldReduceMotion()) return;

    animate(
      searchBar,
      {
        transform: 'scale(1)',
        boxShadow: '0 0 0 0px rgba(200, 35, 44, 0)',
      } as any,
      { duration: 0.2 } as any
    );
  });
}

/**
 * Initialize all micro-interactions
 * Call this once on page load
 */
export function initAllMicroInteractions(): void {
  initButtonAnimations();
  initIconAnimations();
  initSearchAnimations();
}
