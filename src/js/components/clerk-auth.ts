/**
 * Clerk sign-in (env-gated, guest-first).
 *
 * When VITE_CLERK_PUBLISHABLE_KEY is set, Clerk powers the navbar Sign In button
 * and the signed-in user menu; the legacy auth modal is bypassed. With no key,
 * clerkEnabled() is false and main.ts falls back to the existing modal. Clerk's
 * JS is loaded dynamically so it never bloats the bundle when unused. Nothing is
 * gated behind login — accounts stay optional.
 */

import type { Clerk as ClerkType } from '@clerk/clerk-js';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

export function clerkEnabled(): boolean {
  return !!PUBLISHABLE_KEY;
}

let clerk: ClerkType | null = null;

export async function initClerkAuth(): Promise<void> {
  if (!PUBLISHABLE_KEY) return;
  try {
    const { Clerk } = await import('@clerk/clerk-js');
    clerk = new Clerk(PUBLISHABLE_KEY);
    await clerk.load({
      appearance: { variables: { colorPrimary: '#FF6B35' } },
    });
  } catch (e) {
    console.error('[clerk] failed to load:', e);
    return;
  }

  const loginBtn = document.getElementById('login-btn');
  const loginBtnMobile = document.getElementById('login-btn-mobile');
  const legacyUserMenu = document.getElementById('user-menu'); // legacy markup — hide it
  const area = document.getElementById('user-account-area');

  const openSignIn = (e: Event) => {
    e.preventDefault();
    clerk?.openSignIn();
  };
  loginBtn?.addEventListener('click', openSignIn);
  loginBtnMobile?.addEventListener('click', openSignIn);

  // Mount point for Clerk's UserButton (avatar + account menu + sign out).
  let mount = document.getElementById('clerk-user-button');
  if (!mount && area) {
    mount = document.createElement('div');
    mount.id = 'clerk-user-button';
    mount.className = 'ml-1 flex items-center';
    area.appendChild(mount);
  }
  legacyUserMenu?.classList.add('hidden');

  const sync = () => {
    const signedIn = !!clerk?.user;
    loginBtn?.classList.toggle('hidden', signedIn);
    loginBtnMobile?.classList.toggle('hidden', signedIn);
    if (!mount) return;
    if (signedIn) {
      mount.classList.remove('hidden');
      mount.innerHTML = '';
      clerk?.mountUserButton(mount as HTMLDivElement);
    } else {
      mount.classList.add('hidden');
      mount.innerHTML = '';
    }
  };

  clerk.addListener(sync);
  sync();
}
