/**
 * Modal Animations
 * Entrance, exit, success celebrations, and error shakes
 */

import { gsap } from './gsap-init';
import { getAnimationConfig } from './utils';
import type { ModalAnimationType } from '../types/animations';

/**
 * Show modal with animation
 */
export function showModalAnimated(
  modal: HTMLElement,
  config: ModalAnimationType = {}
): void {
  const { animation = 'scale', duration = 0.4 } = config;

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const backdrop = modal;
  const content = modal.querySelector(
    '.bg-gray-800, .bg-white, .rounded-lg'
  ) as HTMLElement;

  // Backdrop fade
  gsap.from(
    backdrop,
    getAnimationConfig({
      opacity: 0,
      duration: duration * 0.7,
      ease: 'power2.out',
    })
  );

  // Content animation based on type
  if (content) {
    switch (animation) {
      case 'scale':
        gsap.from(
          content,
          getAnimationConfig({
            scale: 0.8,
            opacity: 0,
            duration,
            ease: 'back.out(1.2)',
          })
        );
        break;

      case 'slide-up':
        gsap.from(
          content,
          getAnimationConfig({
            y: 100,
            opacity: 0,
            duration,
            ease: 'power2.out',
          })
        );
        break;

      case 'bounce':
        gsap.from(
          content,
          getAnimationConfig({
            y: -100,
            opacity: 0,
            duration,
            ease: 'bounce.out',
          })
        );
        break;

      case 'fade':
      default:
        gsap.from(
          content,
          getAnimationConfig({
            opacity: 0,
            duration,
            ease: 'power2.out',
          })
        );
    }
  }
}

/**
 * Hide modal with animation
 */
export function hideModalAnimated(
  modal: HTMLElement,
  config: {
    duration?: number;
    onComplete?: () => void;
  } = {}
): void {
  const { duration = 0.3, onComplete } = config;

  const content = modal.querySelector(
    '.bg-gray-800, .bg-white, .rounded-lg'
  ) as HTMLElement;

  const timeline = gsap.timeline({
    onComplete: () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      onComplete?.();
    },
  });

  // Animate content and backdrop out
  if (content) {
    timeline.to(
      content,
      getAnimationConfig({
        scale: 0.9,
        opacity: 0,
        duration: duration * 0.8,
        ease: 'power2.in',
      }),
      0
    );
  }

  timeline.to(
    modal,
    getAnimationConfig({
      opacity: 0,
      duration,
      ease: 'power2.in',
    }),
    0
  );
}

/**
 * Success celebration animation
 * Creates particle burst effect
 */
export function celebrateSuccess(element: HTMLElement): void {
  const particles = 12;

  for (let i = 0; i < particles; i++) {
    const particle = document.createElement('div');
    particle.className = 'absolute w-2 h-2 rounded-full';
    particle.style.backgroundColor = '#e88b2d'; // Champions orange
    particle.style.left = '50%';
    particle.style.top = '50%';
    element.style.position = 'relative';
    element.appendChild(particle);

    const angle = (360 / particles) * i;
    const distance = 50 + Math.random() * 50;

    gsap.to(particle, {
      x: Math.cos((angle * Math.PI) / 180) * distance,
      y: Math.sin((angle * Math.PI) / 180) * distance,
      opacity: 0,
      duration: 0.8,
      ease: 'power2.out',
      onComplete: () => particle.remove(),
    });
  }

  // Icon scale animation
  const icon = element.querySelector(
    'i[data-lucide="check-circle"], i[data-lucide="check"]'
  );
  if (icon) {
    gsap.from(
      icon,
      getAnimationConfig({
        scale: 0,
        rotation: -180,
        duration: 0.6,
        ease: 'back.out(2)',
      })
    );
  }
}

/**
 * Error shake animation
 */
export function shakeError(element: HTMLElement): void {
  gsap.to(
    element,
    getAnimationConfig({
      x: -10,
      duration: 0.1,
      repeat: 5,
      yoyo: true,
      ease: 'power1.inOut',
      onComplete: () => {
        gsap.set(element, { x: 0 });
      },
    })
  );
}

/**
 * Pulse animation for attention
 */
export function pulseAttention(element: HTMLElement, count: number = 2): void {
  gsap.fromTo(
    element,
    { scale: 1 },
    getAnimationConfig({
      scale: 1.1,
      duration: 0.3,
      repeat: count * 2 - 1,
      yoyo: true,
      ease: 'power1.inOut',
    })
  );
}
