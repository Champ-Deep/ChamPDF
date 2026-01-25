/**
 * GSAP Initialization and Configuration
 * Registers plugins and sets global defaults for animations
 */

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';

// Register GSAP plugins
gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

// Set global defaults for consistent animations
gsap.defaults({
  ease: 'power2.out',
  duration: 0.6,
});

// Configure ScrollTrigger defaults
ScrollTrigger.defaults({
  toggleActions: 'play none none reverse',
  markers: false, // Set to true for debugging
});

// Export configured instances
export { gsap, ScrollTrigger, ScrollToPlugin };
