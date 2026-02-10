/**
 * Tool Page Animations
 * Reusable animations for drop zones, file lists, and progress indicators
 */

import { gsap } from './gsap-init';
import { getAnimationConfig } from './utils';

/**
 * Initialize drop zone animation
 * Adds pulse, drag-over, and drop feedback
 * @param dropZoneId - ID of the drop zone element
 * @returns Cleanup function to kill animations
 */
export function initDropZoneAnimation(
  dropZoneId: string = 'drop-zone'
): (() => void) | null {
  const dropZone = document.getElementById(dropZoneId);
  if (!dropZone) return null;

  // Initial fade-in animation
  gsap.from(
    dropZone,
    getAnimationConfig({
      scale: 0.98,
      opacity: 0,
      duration: 0.6,
      ease: 'power2.out',
      delay: 0.3,
    })
  );

  // Continuous subtle pulse (idle state)
  const pulseTimeline = gsap.timeline({ repeat: -1 });
  pulseTimeline
    .to(dropZone, {
      scale: 1.01,
      duration: 2,
      ease: 'sine.inOut',
    })
    .to(dropZone, {
      scale: 1,
      duration: 2,
      ease: 'sine.inOut',
    });

  // Drag over animation
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();

    // Pause pulse
    pulseTimeline.pause();

    // Animate to active state
    gsap.to(
      dropZone,
      getAnimationConfig({
        scale: 1.05,
        borderColor: '#c8232c',
        backgroundColor: '#1f2937',
        boxShadow: '0 0 30px rgba(200, 35, 44, 0.3)',
        duration: 0.3,
        ease: 'power2.out',
      })
    );
  };

  // Drag leave animation
  const handleDragLeave = () => {
    gsap.to(
      dropZone,
      getAnimationConfig({
        scale: 1,
        borderColor: '#4b5563',
        backgroundColor: '#111827',
        boxShadow: '0 0 0 rgba(200, 35, 44, 0)',
        duration: 0.3,
        ease: 'power2.in',
        onComplete: () => {
          pulseTimeline.resume();
        },
      })
    );
  };

  // Drop animation
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();

    // Stop pulse
    pulseTimeline.pause();

    // Success flash
    gsap
      .timeline()
      .to(dropZone, {
        scale: 0.95,
        backgroundColor: '#065f46', // green-800
        duration: 0.15,
      })
      .to(dropZone, {
        scale: 1,
        backgroundColor: '#1f2937',
        borderColor: '#4b5563',
        duration: 0.3,
      });
  };

  // Add event listeners
  dropZone.addEventListener('dragover', handleDragOver);
  dropZone.addEventListener('dragleave', handleDragLeave);
  dropZone.addEventListener('drop', handleDrop);

  // Return cleanup function
  return () => {
    pulseTimeline.kill();
    dropZone.removeEventListener('dragover', handleDragOver);
    dropZone.removeEventListener('dragleave', handleDragLeave);
    dropZone.removeEventListener('drop', handleDrop);
  };
}

/**
 * Animate a file being added to the list
 */
export function animateFileAdded(
  fileElement: HTMLElement,
  index: number = 0
): void {
  gsap.from(
    fileElement,
    getAnimationConfig({
      opacity: 0,
      x: -20,
      height: 0,
      duration: 0.4,
      delay: index * 0.05,
      ease: 'power2.out',
    })
  );
}

/**
 * Animate a file being removed from the list
 */
export function animateFileRemoved(
  fileElement: HTMLElement,
  onComplete: () => void
): void {
  gsap.to(
    fileElement,
    getAnimationConfig({
      opacity: 0,
      x: 20,
      height: 0,
      duration: 0.3,
      ease: 'power2.in',
      onComplete,
    })
  );
}

/**
 * Animate progress bar to target percentage
 */
export function animateProgress(
  progressElement: HTMLElement,
  targetPercentage: number,
  duration: number = 0.5
): void {
  gsap.to(
    progressElement,
    getAnimationConfig({
      width: `${targetPercentage}%`,
      duration,
      ease: 'power2.out',
    })
  );
}

/**
 * Animate circular progress with counter
 */
export function animateCircularProgress(
  progressElement: HTMLElement,
  targetPercentage: number,
  duration: number = 1.5
): void {
  const counter = { value: 0 };

  gsap.to(counter, {
    value: targetPercentage,
    duration,
    ease: 'power2.out',
    onUpdate: function () {
      const current = Math.round(counter.value);
      progressElement.textContent = `${current}%`;
    },
  });
}
