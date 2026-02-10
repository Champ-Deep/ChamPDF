/**
 * Animation Utilities
 * Helper functions for accessibility, performance, and cleanup
 */

import { gsap, ScrollTrigger } from './gsap-init';
import type { AnimationConfig } from '../types/animations';

/**
 * Check if user prefers reduced motion
 */
export function shouldReduceMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Get animation config with reduced motion support
 * If user prefers reduced motion, returns near-instant animation config
 */
export function getAnimationConfig<T extends AnimationConfig>(config: T): T {
  if (shouldReduceMotion()) {
    return {
      ...config,
      duration: 0.01, // Almost instant
      ease: 'none',
    };
  }
  return config;
}

/**
 * Cleanup all GSAP animations and ScrollTriggers
 * Call this on page navigation or unmount
 */
export function cleanupAnimations(): void {
  // Kill all GSAP animations
  gsap.globalTimeline.clear();

  // Kill all ScrollTriggers
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
}

/**
 * Add GPU acceleration hint to element
 * Use sparingly - only for elements that will be animated
 */
export function enableGPUAcceleration(element: HTMLElement): void {
  element.style.willChange = 'transform, opacity';
  element.style.transform = 'translateZ(0)';
}

/**
 * Remove GPU acceleration hint after animation completes
 */
export function disableGPUAcceleration(element: HTMLElement): void {
  element.style.willChange = 'auto';
}

/**
 * Initialize cleanup on page unload
 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', cleanupAnimations);
}
