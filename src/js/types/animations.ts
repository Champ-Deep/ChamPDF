/**
 * Animation Configuration Types
 */

export interface AnimationConfig {
  duration?: number;
  ease?: string;
  delay?: number;
  stagger?: number;
}

export interface ScrollAnimationConfig extends AnimationConfig {
  trigger: string | HTMLElement;
  start?: string;
  end?: string;
  scrub?: boolean;
  toggleActions?: string;
}

export interface ModalAnimationType {
  animation?: 'fade' | 'scale' | 'slide-up' | 'bounce';
  duration?: number;
}

export interface StaggerConfig {
  amount?: number;
  grid?: 'auto' | [number, number];
  from?: 'start' | 'center' | 'end' | 'edges' | 'random' | number;
}
