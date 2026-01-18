/**
 * Toast Notification Utility
 * Displays brief, non-intrusive notifications for user feedback
 */

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastOptions {
  message: string;
  type?: ToastType;
  duration?: number;
}

const TOAST_CONTAINER_ID = 'toast-container';

/**
 * Get or create the toast container
 */
function getToastContainer(): HTMLElement {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = TOAST_CONTAINER_ID;
    container.className =
      'fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Get icon SVG for toast type
 */
function getIcon(type: ToastType): string {
  switch (type) {
    case 'success':
      return '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
    case 'error':
      return '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
    case 'warning':
      return '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
    case 'info':
    default:
      return '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
  }
}

/**
 * Get color classes for toast type
 */
function getColorClasses(type: ToastType): string {
  switch (type) {
    case 'success':
      return 'bg-green-600 text-white';
    case 'error':
      return 'bg-red-600 text-white';
    case 'warning':
      return 'bg-yellow-500 text-gray-900';
    case 'info':
    default:
      return 'bg-gray-700 text-white';
  }
}

/**
 * Show a toast notification
 */
export function showToast(options: ToastOptions): void {
  const { message, type = 'info', duration = 3000 } = options;

  const container = getToastContainer();

  const toast = document.createElement('div');
  toast.className = `
    ${getColorClasses(type)}
    px-4 py-3 rounded-lg shadow-lg
    flex items-center gap-3
    pointer-events-auto
    transform translate-x-full opacity-0
    transition-all duration-300 ease-out
    max-w-sm
  `;

  toast.innerHTML = `
    <span class="flex-shrink-0">${getIcon(type)}</span>
    <span class="text-sm font-medium">${message}</span>
  `;

  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.remove('translate-x-full', 'opacity-0');
    toast.classList.add('translate-x-0', 'opacity-100');
  });

  // Remove after duration
  setTimeout(() => {
    toast.classList.remove('translate-x-0', 'opacity-100');
    toast.classList.add('translate-x-full', 'opacity-0');

    setTimeout(() => {
      toast.remove();
    }, 300);
  }, duration);
}

/**
 * Convenience methods
 */
export const toast = {
  success: (message: string, duration?: number) =>
    showToast({ message, type: 'success', duration }),
  error: (message: string, duration?: number) =>
    showToast({ message, type: 'error', duration }),
  warning: (message: string, duration?: number) =>
    showToast({ message, type: 'warning', duration }),
  info: (message: string, duration?: number) =>
    showToast({ message, type: 'info', duration }),
};
