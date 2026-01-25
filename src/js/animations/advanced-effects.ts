/**
 * Advanced Animation Effects
 * Parallax, 3D transforms, magnetic cursor, gradient animations
 */

import { gsap } from './gsap-init';
import { ScrollTrigger } from './gsap-init';
import { shouldReduceMotion } from './utils';

/**
 * Parallax scroll effect for background elements
 * Elements move at different speeds to create depth
 */
export function initParallaxEffect(
  selector: string,
  speed: number = 0.5
): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element) => {
    gsap.to(element, {
      yPercent: -50 * speed,
      ease: 'none',
      scrollTrigger: {
        trigger: element,
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
      },
    });
  });
}

/**
 * 3D card flip effect on hover
 * Cards rotate in 3D space revealing back content
 */
export function init3DCardFlip(cardSelector: string): void {
  if (shouldReduceMotion()) return;

  const cards = document.querySelectorAll(cardSelector);

  cards.forEach((card) => {
    const cardElement = card as HTMLElement;

    // Set up 3D perspective
    cardElement.style.transformStyle = 'preserve-3d';
    cardElement.style.perspective = '1000px';

    cardElement.addEventListener('mouseenter', (e) => {
      const rect = cardElement.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((mouseY - centerY) / centerY) * -10; // Max 10deg tilt
      const rotateY = ((mouseX - centerX) / centerX) * 10;

      gsap.to(cardElement, {
        rotationX: rotateX,
        rotationY: rotateY,
        transformPerspective: 1000,
        duration: 0.3,
        ease: 'power2.out',
      });
    });

    cardElement.addEventListener('mousemove', (e) => {
      const rect = cardElement.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((mouseY - centerY) / centerY) * -10;
      const rotateY = ((mouseX - centerX) / centerX) * 10;

      gsap.to(cardElement, {
        rotationX: rotateX,
        rotationY: rotateY,
        duration: 0.15,
        ease: 'power2.out',
      });
    });

    cardElement.addEventListener('mouseleave', () => {
      gsap.to(cardElement, {
        rotationX: 0,
        rotationY: 0,
        duration: 0.4,
        ease: 'power2.out',
      });
    });
  });
}

/**
 * Magnetic cursor effect
 * Elements move toward cursor when nearby
 */
export function initMagneticCursor(
  selector: string,
  strength: number = 0.3
): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element) => {
    const el = element as HTMLElement;

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const deltaX = (e.clientX - centerX) * strength;
      const deltaY = (e.clientY - centerY) * strength;

      gsap.to(el, {
        x: deltaX,
        y: deltaY,
        duration: 0.3,
        ease: 'power2.out',
      });
    });

    el.addEventListener('mouseleave', () => {
      gsap.to(el, {
        x: 0,
        y: 0,
        duration: 0.5,
        ease: 'elastic.out(1, 0.3)',
      });
    });
  });
}

/**
 * Animated gradient background
 * Creates flowing gradient animation
 */
export function initAnimatedGradient(elementId: string): void {
  if (shouldReduceMotion()) return;

  const element = document.getElementById(elementId);
  if (!element) return;

  // Create gradient animation timeline
  const tl = gsap.timeline({ repeat: -1, yoyo: true });

  tl.to(element, {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    duration: 4,
    ease: 'sine.inOut',
  })
    .to(element, {
      background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
      duration: 4,
      ease: 'sine.inOut',
    })
    .to(element, {
      background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
      duration: 4,
      ease: 'sine.inOut',
    });
}

/**
 * Floating elements animation
 * Elements float up and down smoothly
 */
export function initFloatingElements(selector: string): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element, index) => {
    gsap.to(element, {
      y: '+=20',
      duration: 2 + index * 0.3, // Stagger the duration
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      delay: index * 0.2,
    });
  });
}

/**
 * Text reveal animation
 * Characters appear one by one with stagger
 */
export function initTextReveal(selector: string): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element) => {
    const text = element.textContent || '';
    element.textContent = '';

    const chars = text.split('');
    chars.forEach((char) => {
      const span = document.createElement('span');
      span.textContent = char === ' ' ? '\u00A0' : char;
      span.style.display = 'inline-block';
      span.style.opacity = '0';
      element.appendChild(span);
    });

    const spans = element.querySelectorAll('span');

    gsap.to(spans, {
      opacity: 1,
      y: 0,
      duration: 0.05,
      stagger: 0.03,
      ease: 'power2.out',
    });
  });
}

/**
 * Ripple effect on click
 * Creates expanding circle from click point
 */
export function initRippleEffect(selector: string): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element) => {
    element.addEventListener('click', (e) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);

      const x = (e as MouseEvent).clientX - rect.left - size / 2;
      const y = (e as MouseEvent).clientY - rect.top - size / 2;

      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      ripple.classList.add('ripple-effect');

      element.appendChild(ripple);

      gsap.fromTo(
        ripple,
        {
          scale: 0,
          opacity: 0.6,
        },
        {
          scale: 2,
          opacity: 0,
          duration: 0.6,
          ease: 'power2.out',
          onComplete: () => ripple.remove(),
        }
      );
    });
  });
}

/**
 * Staggered fade-in for lists
 * List items appear with cascading effect
 */
export function initStaggeredList(
  listSelector: string,
  itemSelector: string = 'li'
): void {
  if (shouldReduceMotion()) return;

  const lists = document.querySelectorAll(listSelector);

  lists.forEach((list) => {
    const items = list.querySelectorAll(itemSelector);

    gsap.from(items, {
      opacity: 0,
      y: 20,
      duration: 0.4,
      stagger: 0.1,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: list,
        start: 'top 80%',
      },
    });
  });
}

/**
 * Morphing shapes animation
 * SVG paths morph between different shapes
 */
export function initMorphingShape(pathId: string, shapes: string[]): void {
  if (shouldReduceMotion()) return;

  const path = document.getElementById(pathId);
  if (!path) return;

  let currentIndex = 0;

  setInterval(() => {
    currentIndex = (currentIndex + 1) % shapes.length;

    gsap.to(path, {
      attr: { d: shapes[currentIndex] },
      duration: 1.5,
      ease: 'power1.inOut',
    });
  }, 3000);
}

/**
 * Page transition effect
 * Smooth transition between pages
 */
export function initPageTransition(): void {
  if (shouldReduceMotion()) return;

  // Create overlay for page transitions
  const overlay = document.createElement('div');
  overlay.id = 'page-transition-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, #c8232c 0%, #e88b2d 100%);
    z-index: 9999;
    pointer-events: none;
    opacity: 0;
  `;
  document.body.appendChild(overlay);

  // Intercept navigation
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest(
      'a[href^="/"], a[href^="./"]'
    ) as HTMLAnchorElement;

    if (link && !link.hasAttribute('data-no-transition')) {
      e.preventDefault();

      gsap.to(overlay, {
        opacity: 1,
        duration: 0.4,
        ease: 'power2.in',
        onComplete: () => {
          window.location.href = link.href;
        },
      });
    }
  });

  // Fade out overlay on page load
  window.addEventListener('load', () => {
    gsap.to(overlay, {
      opacity: 0,
      duration: 0.4,
      ease: 'power2.out',
    });
  });
}

/**
 * Scroll-based color change
 * Element changes color based on scroll position
 */
export function initScrollColorChange(
  selector: string,
  colors: string[]
): void {
  if (shouldReduceMotion()) return;

  const elements = document.querySelectorAll(selector);

  elements.forEach((element) => {
    ScrollTrigger.create({
      trigger: element,
      start: 'top center',
      end: 'bottom center',
      onUpdate: (self) => {
        const progress = self.progress;
        const colorIndex = Math.floor(progress * (colors.length - 1));
        const nextColorIndex = Math.min(colorIndex + 1, colors.length - 1);
        const localProgress = (progress * (colors.length - 1)) % 1;

        gsap.to(element, {
          backgroundColor: gsap.utils.interpolate(
            colors[colorIndex],
            colors[nextColorIndex],
            localProgress
          ),
          duration: 0.3,
        });
      },
    });
  });
}

/**
 * Initialize all advanced effects
 */
export function initAllAdvancedEffects(): void {
  // Parallax for hero section elements
  initParallaxEffect('.parallax-slow', 0.3);
  initParallaxEffect('.parallax-medium', 0.5);
  initParallaxEffect('.parallax-fast', 0.7);

  // 3D card effects for tool cards
  init3DCardFlip('.tool-card-3d');

  // Magnetic effect for primary buttons
  initMagneticCursor('.btn-magnetic', 0.3);

  // Floating elements
  initFloatingElements('.floating-element');

  // Ripple effects on clickable elements
  initRippleEffect('.btn-ripple');

  // Page transitions
  initPageTransition();
}
