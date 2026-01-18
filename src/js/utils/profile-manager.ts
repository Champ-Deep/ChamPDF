/**
 * Simple client-side profile manager
 * Uses email as identifier - no authentication, just identification
 *
 * Storage is profile-scoped:
 * - Guest mode: Uses base keys (shared)
 * - With profile: Uses hashed-email-prefixed keys (isolated per profile)
 */

const CURRENT_PROFILE_KEY = 'champdf_current_profile';
const PROFILES_LIST_KEY = 'champdf_profiles';

export interface Profile {
  email: string;
  displayName?: string;
  createdAt: number;
}

/**
 * Hash email for use in storage keys (privacy - email not visible in DevTools)
 */
export function hashEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Get the currently active profile
 */
export function getCurrentProfile(): Profile | null {
  const email = localStorage.getItem(CURRENT_PROFILE_KEY);
  if (!email) return null;

  const profiles = getProfiles();
  return profiles.find((p) => p.email === email) || null;
}

/**
 * Get all saved profiles
 */
export function getProfiles(): Profile[] {
  try {
    const data = localStorage.getItem(PROFILES_LIST_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/**
 * Set the active profile (creates if doesn't exist)
 */
export function setProfile(email: string): Profile {
  const normalized = email.toLowerCase().trim();
  const profiles = getProfiles();

  let profile = profiles.find((p) => p.email === normalized);
  if (!profile) {
    profile = {
      email: normalized,
      createdAt: Date.now(),
    };
    profiles.push(profile);
    localStorage.setItem(PROFILES_LIST_KEY, JSON.stringify(profiles));
  }

  localStorage.setItem(CURRENT_PROFILE_KEY, normalized);
  return profile;
}

/**
 * Clear the current profile (go to guest mode)
 */
export function clearProfile(): void {
  localStorage.removeItem(CURRENT_PROFILE_KEY);
}

/**
 * Delete a profile and its associated data
 */
export function deleteProfile(email: string): void {
  const profiles = getProfiles().filter((p) => p.email !== email);
  localStorage.setItem(PROFILES_LIST_KEY, JSON.stringify(profiles));

  // If deleting current profile, clear it
  if (localStorage.getItem(CURRENT_PROFILE_KEY) === email) {
    clearProfile();
  }
}

/**
 * Check if email is a Champions domain
 */
export function isChampionsEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.includes('@champions.');
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Avatar color palette - vibrant, accessible colors
 */
const AVATAR_COLORS = [
  '#f97316', // orange
  '#3b82f6', // blue
  '#22c55e', // green
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f59e0b', // amber
  '#6366f1', // indigo
];

/**
 * Get a unique avatar color based on email
 * Same email always returns same color
 */
export function getAvatarColor(email: string): string {
  const hash = hashEmail(email);
  const index = hash.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

/**
 * Get user's initial from email
 */
export function getInitial(email: string): string {
  return email[0]?.toUpperCase() || '?';
}
