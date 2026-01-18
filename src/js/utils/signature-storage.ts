/**
 * Signature Storage Utility
 * Persists user signatures using localStorage (metadata) and IndexedDB (PNG images)
 *
 * Storage is user-scoped when authenticated:
 * - Guest mode: Uses base keys (shared)
 * - Authenticated: Uses user-prefixed keys (isolated per user)
 */

import { getStorageKey, getDBName } from './storage-context.js';

export interface SavedSignature {
  id: string;
  name: string;
  style: string;
  color: string;
  createdAt: number;
  isDefault: boolean;
}

// Base keys - will be prefixed with user ID when authenticated
const BASE_STORAGE_KEY = 'champdf_signatures';
const BASE_DB_NAME = 'champdf-signatures';
const DB_VERSION = 1;
const STORE_NAME = 'images';

/**
 * Get the user-scoped localStorage key for signatures
 */
function getSignatureStorageKey(): string {
  return getStorageKey(BASE_STORAGE_KEY);
}

/**
 * Get the user-scoped IndexedDB name for signature images
 */
function getSignatureDBName(): string {
  return getDBName(BASE_DB_NAME);
}

// ============================================
// localStorage: Signature Metadata
// ============================================

export function getSignatures(): SavedSignature[] {
  try {
    const stored = localStorage.getItem(getSignatureStorageKey());
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to parse signatures from localStorage', e);
  }
  return [];
}

export function saveSignatureMetadata(signature: SavedSignature): void {
  const signatures = getSignatures();
  const existingIndex = signatures.findIndex((s) => s.id === signature.id);

  if (existingIndex >= 0) {
    signatures[existingIndex] = signature;
  } else {
    signatures.push(signature);
  }

  localStorage.setItem(getSignatureStorageKey(), JSON.stringify(signatures));
}

export function deleteSignatureMetadata(id: string): void {
  const signatures = getSignatures().filter((s) => s.id !== id);
  localStorage.setItem(getSignatureStorageKey(), JSON.stringify(signatures));
}

export function setDefaultSignature(id: string): void {
  const signatures = getSignatures().map((s) => ({
    ...s,
    isDefault: s.id === id,
  }));
  localStorage.setItem(getSignatureStorageKey(), JSON.stringify(signatures));
}

export function getDefaultSignature(): SavedSignature | null {
  const signatures = getSignatures();
  return signatures.find((s) => s.isDefault) || signatures[0] || null;
}

// ============================================
// IndexedDB: Signature PNG Images
// ============================================

async function openSignatureDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getSignatureDBName(), DB_VERSION);

    request.onerror = () => {
      console.error('Failed to open signature IndexedDB', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function saveSignatureImage(
  id: string,
  blob: Blob
): Promise<void> {
  try {
    const db = await openSignatureDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(blob, id);

      request.onsuccess = () => {
        db.close();
        resolve();
      };

      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch (e) {
    console.error('Failed to save signature image to IndexedDB', e);
    throw e;
  }
}

export async function getSignatureImage(id: string): Promise<Blob | null> {
  try {
    const db = await openSignatureDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        db.close();
        resolve(request.result || null);
      };

      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch (e) {
    console.error('Failed to get signature image from IndexedDB', e);
    return null;
  }
}

export async function deleteSignatureImage(id: string): Promise<void> {
  try {
    const db = await openSignatureDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => {
        db.close();
        resolve();
      };

      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch (e) {
    console.error('Failed to delete signature image from IndexedDB', e);
    throw e;
  }
}

// ============================================
// Combined Operations
// ============================================

export async function saveSignature(
  signature: SavedSignature,
  imageBlob: Blob
): Promise<void> {
  saveSignatureMetadata(signature);
  await saveSignatureImage(signature.id, imageBlob);
}

export async function deleteSignature(id: string): Promise<void> {
  deleteSignatureMetadata(id);
  await deleteSignatureImage(id);
}

export async function getSignatureWithImage(
  id: string
): Promise<{ signature: SavedSignature; imageUrl: string } | null> {
  const signatures = getSignatures();
  const signature = signatures.find((s) => s.id === id);

  if (!signature) return null;

  const blob = await getSignatureImage(id);
  if (!blob) return null;

  const imageUrl = URL.createObjectURL(blob);
  return { signature, imageUrl };
}

export async function getAllSignaturesWithImages(): Promise<
  Array<{ signature: SavedSignature; imageUrl: string }>
> {
  const signatures = getSignatures();
  const results: Array<{ signature: SavedSignature; imageUrl: string }> = [];

  for (const signature of signatures) {
    const blob = await getSignatureImage(signature.id);
    if (blob) {
      results.push({
        signature,
        imageUrl: URL.createObjectURL(blob),
      });
    }
  }

  return results;
}
