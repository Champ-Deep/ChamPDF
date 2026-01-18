/**
 * Profile Selector Modal Component
 *
 * Handles the profile selector modal UI for email-based profile management.
 * No authentication - just uses email as identifier for data isolation.
 * Shows special badge for Champions email domains.
 */

import { createIcons, icons } from 'lucide';
import {
  getCurrentProfile,
  getProfiles,
  setProfile,
  clearProfile,
  isChampionsEmail,
  isValidEmail,
  getAvatarColor,
  getInitial,
  type Profile,
} from '../utils/profile-manager.js';
import { toast } from '../utils/toast.js';

let isInitialized = false;
const profileChangeCallbacks: Array<(profile: Profile | null) => void> = [];

/**
 * Register a callback for profile changes
 */
export function onProfileChange(
  callback: (profile: Profile | null) => void
): void {
  profileChangeCallbacks.push(callback);
}

/**
 * Notify all registered callbacks of a profile change
 */
function notifyProfileChange(profile: Profile | null): void {
  profileChangeCallbacks.forEach((cb) => cb(profile));
}

/**
 * Initialize the profile modal and related UI elements
 */
export function initAuthModal(): void {
  if (isInitialized) return;
  isInitialized = true;

  setupModalHandlers();
  setupUserMenuHandlers();
  setupKeyboardNavigation();

  // Update UI for current profile state
  updateUIForProfile(getCurrentProfile());
}

/**
 * Set up keyboard navigation
 */
function setupKeyboardNavigation(): void {
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('auth-modal');
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
    }
  });
}

/**
 * Set up modal open/close handlers
 */
function setupModalHandlers(): void {
  const modal = document.getElementById('auth-modal');
  const loginBtn = document.getElementById('login-btn');
  const loginBtnMobile = document.getElementById('login-btn-mobile');
  const closeBtn = document.getElementById('close-auth-modal');
  const backdrop = document.getElementById('auth-backdrop');
  const emailInput = document.getElementById('auth-email') as HTMLInputElement;
  const useProfileBtn = document.getElementById('send-login-link');
  const guestBtn = document.getElementById('continue-as-guest');
  const championsBadge = document.getElementById('champions-badge');

  // Open modal handlers
  const openModal = () => {
    modal?.classList.remove('hidden');
    renderSavedProfiles();
    // Clear previous input and errors
    if (emailInput) emailInput.value = '';
    clearError();
    createIcons({ icons });
    // Focus email input
    setTimeout(() => emailInput?.focus(), 100);
  };

  loginBtn?.addEventListener('click', openModal);
  loginBtnMobile?.addEventListener('click', openModal);

  // Close modal handlers
  const closeModal = () => {
    modal?.classList.add('hidden');
  };

  closeBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);

  // Check for Champions email as user types
  emailInput?.addEventListener('input', () => {
    const isChampions = isChampionsEmail(emailInput.value);
    championsBadge?.classList.toggle('hidden', !isChampions);
    clearError();
  });

  // Use profile button handler
  useProfileBtn?.addEventListener('click', () => {
    const email = emailInput?.value?.trim();
    if (!email) {
      showError('Please enter your email address');
      return;
    }

    if (!isValidEmail(email)) {
      showError('Please enter a valid email address');
      return;
    }

    const profile = setProfile(email);
    updateUIForProfile(profile);
    notifyProfileChange(profile);
    closeModal();
    toast.success(`Switched to ${profile.email}`);
  });

  // Continue as guest handler
  guestBtn?.addEventListener('click', () => {
    clearProfile();
    updateUIForProfile(null);
    notifyProfileChange(null);
    closeModal();
    toast.info('Continuing as guest');
  });

  // Handle Enter key in email input
  emailInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      useProfileBtn?.click();
    }
  });
}

/**
 * Render saved profiles list in the modal
 */
function renderSavedProfiles(): void {
  const section = document.getElementById('saved-profiles-section');
  const list = document.getElementById('saved-profiles-list');
  const profiles = getProfiles();
  const currentProfile = getCurrentProfile();

  if (!section || !list) return;

  if (profiles.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = '';

  profiles.forEach((profile) => {
    const isActive = currentProfile?.email === profile.email;
    const color = getAvatarColor(profile.email);
    const initial = getInitial(profile.email);

    const btn = document.createElement('button');
    btn.className = `
      w-full flex items-center gap-3 p-2 rounded-lg transition-colors text-left
      ${isActive ? 'bg-gray-600 ring-2 ring-orange-500' : 'bg-gray-700 hover:bg-gray-600'}
    `;
    btn.innerHTML = `
      <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0" style="background-color: ${color}">
        ${initial}
      </div>
      <span class="text-white text-sm truncate flex-1">${profile.email}</span>
      ${isActive ? '<svg class="w-4 h-4 text-orange-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' : ''}
    `;
    btn.addEventListener('click', () => {
      const p = setProfile(profile.email);
      updateUIForProfile(p);
      notifyProfileChange(p);
      document.getElementById('auth-modal')?.classList.add('hidden');
      toast.success(`Switched to ${p.email}`);
    });
    list.appendChild(btn);
  });
}

/**
 * Show error message in modal
 */
function showError(message: string): void {
  let errorMsg = document.getElementById('auth-error-msg');

  if (!errorMsg) {
    // Create error element if it doesn't exist
    const emailContainer = document
      .getElementById('auth-email')
      ?.closest('.mb-4');
    if (emailContainer) {
      errorMsg = document.createElement('p');
      errorMsg.id = 'auth-error-msg';
      errorMsg.className = 'text-red-400 text-xs mt-2';
      emailContainer.appendChild(errorMsg);
    }
  }

  if (errorMsg) {
    errorMsg.textContent = message;
    errorMsg.classList.remove('hidden');
  }
}

/**
 * Clear error message
 */
function clearError(): void {
  const errorMsg = document.getElementById('auth-error-msg');
  if (errorMsg) {
    errorMsg.classList.add('hidden');
  }
}

/**
 * Update UI based on profile state
 */
function updateUIForProfile(profile: Profile | null): void {
  // Desktop elements
  const loginBtn = document.getElementById('login-btn');
  const userMenu = document.getElementById('user-menu');
  const userInitial = document.getElementById('user-initial');
  const userEmail = document.getElementById('user-email');
  const avatarDesktop = userMenu?.querySelector(
    '.rounded-full'
  ) as HTMLElement | null;

  // Mobile elements
  const loginBtnMobile = document.getElementById('login-btn-mobile');
  const userMenuMobile = document.getElementById('user-menu-mobile');
  const userInitialMobile = document.getElementById('user-initial-mobile');
  const avatarMobile = userMenuMobile?.querySelector(
    '.rounded-full'
  ) as HTMLElement | null;

  if (profile) {
    // Profile is active - show user menu, hide login button
    loginBtn?.classList.add('hidden');
    loginBtnMobile?.classList.add('hidden');

    userMenu?.classList.remove('hidden');
    userMenuMobile?.classList.remove('hidden');

    const initial = getInitial(profile.email);
    const color = getAvatarColor(profile.email);

    if (userInitial) userInitial.textContent = initial;
    if (userInitialMobile) userInitialMobile.textContent = initial;
    if (userEmail) userEmail.textContent = profile.email;

    // Apply unique color to avatars
    if (avatarDesktop) avatarDesktop.style.backgroundColor = color;
    if (avatarMobile) avatarMobile.style.backgroundColor = color;
  } else {
    // Guest mode - show login button, hide user menu
    loginBtn?.classList.remove('hidden');
    loginBtnMobile?.classList.remove('hidden');

    userMenu?.classList.add('hidden');
    userMenuMobile?.classList.add('hidden');

    // Close any open dropdowns
    document.getElementById('user-dropdown')?.classList.add('hidden');
    document.getElementById('user-dropdown-mobile')?.classList.add('hidden');
  }

  createIcons({ icons });
}

/**
 * Set up user menu handlers (dropdown, logout/switch profile)
 */
function setupUserMenuHandlers(): void {
  // Desktop user menu toggle
  const userMenuBtn = document.getElementById('user-menu-btn');
  const userDropdown = document.getElementById('user-dropdown');

  userMenuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdown?.classList.toggle('hidden');
  });

  // Mobile user menu toggle
  const userMenuBtnMobile = document.getElementById('user-menu-btn-mobile');
  const userDropdownMobile = document.getElementById('user-dropdown-mobile');

  userMenuBtnMobile?.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdownMobile?.classList.toggle('hidden');
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    userDropdown?.classList.add('hidden');
    userDropdownMobile?.classList.add('hidden');
  });

  // Logout/Sign out handlers - clears profile
  const logoutBtn = document.getElementById('logout-btn');
  const logoutBtnMobile = document.getElementById('logout-btn-mobile');

  const handleLogout = () => {
    const currentProfile = getCurrentProfile();
    clearProfile();
    updateUIForProfile(null);
    notifyProfileChange(null);
    userDropdown?.classList.add('hidden');
    userDropdownMobile?.classList.add('hidden');

    // Show confirmation toast
    if (currentProfile) {
      toast.info('Signed out. Your data is saved for when you return.');
    }
  };

  logoutBtn?.addEventListener('click', handleLogout);
  logoutBtnMobile?.addEventListener('click', handleLogout);
}

/**
 * Open the profile modal programmatically
 */
export function openAuthModal(): void {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.classList.remove('hidden');
    renderSavedProfiles();
    createIcons({ icons });
    // Focus email input
    const emailInput = document.getElementById(
      'auth-email'
    ) as HTMLInputElement;
    setTimeout(() => emailInput?.focus(), 100);
  }
}

/**
 * Close the profile modal programmatically
 */
export function closeAuthModal(): void {
  const modal = document.getElementById('auth-modal');
  modal?.classList.add('hidden');
}
