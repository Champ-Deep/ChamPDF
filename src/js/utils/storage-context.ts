/**
 * Storage Context - Profile-scoped storage key management
 *
 * This module provides profile-scoped storage keys for localStorage and IndexedDB.
 * When a profile is active, storage keys are prefixed with a hashed email
 * to provide data isolation between profiles.
 */

import { getCurrentProfile, hashEmail } from './profile-manager.js';

/**
 * Get the current profile identifier for storage keys
 * Returns hashed email or null for guest mode
 */
function getProfileId(): string | null {
  const profile = getCurrentProfile();
  return profile ? hashEmail(profile.email) : null;
}

/**
 * Generate a profile-scoped localStorage key
 * @param baseKey - The base key name (e.g., 'champdf_signatures')
 * @returns Profile-scoped key (e.g., 'champdf_signatures_abc123') or base key for guests
 */
export function getStorageKey(baseKey: string): string {
  const profileId = getProfileId();
  if (profileId) {
    return `${baseKey}_${profileId}`;
  }
  return baseKey; // Guest mode uses base key
}

/**
 * Generate a profile-scoped IndexedDB database name
 * @param baseName - The base database name (e.g., 'champdf-signatures')
 * @returns Profile-scoped DB name (e.g., 'champdf-signatures-abc123') or base name for guests
 */
export function getDBName(baseName: string): string {
  const profileId = getProfileId();
  if (profileId) {
    return `${baseName}-${profileId}`;
  }
  return baseName; // Guest mode
}

// Keep backward compatibility exports
export function setCurrentUser(_userId: string | null): void {
  // No-op - profile is set via profile-manager
}

export function getCurrentUserId(): string | null {
  return getProfileId();
}

export function isUserLoggedIn(): boolean {
  return getProfileId() !== null;
}
