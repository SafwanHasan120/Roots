import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import type { Internship } from './types';
import { createHash } from 'crypto';

interface ScrapeState {
  lastRunAt: number;
  perSource: Record<string, { etag?: string; sha?: string; lastOk?: number; failCount: number }>;
}

function hashContent(obj: any): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function normalizeListingId(appUrl: string): string {
  if (!appUrl) return '';
  try {
    const parsed = new URL(appUrl);
    return parsed.hostname.toLowerCase() + parsed.pathname;
  } catch {
    return appUrl;
  }
}

// Firestore rejects explicit `undefined` field values, which optional fields
// on Internship (companyUrl, expirationReason) legitimately produce.
function stripUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// Firestore document ids may not contain "/" and may not be empty.
function listingDocId(listing: Internship): string {
  const raw = normalizeListingId(listing.appUrl) || listing.id || '';
  return raw.replace(/\//g, '_');
}

export async function getScrapeState(): Promise<ScrapeState | null> {
  try {
    const docRef = doc(db, 'meta', 'scrapeState');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? (docSnap.data() as ScrapeState) : null;
  } catch (e) {
    console.error('Failed to read scrapeState:', e);
    return null;
  }
}

export async function writeListings(
  listings: Internship[],
  scrapeState?: ScrapeState
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;

  try {
    // Get existing listings to compare hashes
    const listingsRef = collection(db, 'listings');
    const existing = new Map<string, any>();
    try {
      const snap = await getDocs(listingsRef);
      snap.docs.forEach((d) => {
        existing.set(d.id, d.data());
      });
    } catch {
      // Collection doesn't exist yet
    }

    // Ids written here must match the ids the inactive-sweep compares against,
    // so both loops derive them through this one function.
    const writtenIds = new Set<string>();

    // Write/skip based on content hash
    for (const listing of listings) {
      const id = listingDocId(listing);
      // Firestore rejects empty ids. Skip rather than throw: one malformed
      // record must not abort the whole batch.
      if (!id) {
        console.warn('Skipping listing with empty id:', listing.company, listing.role);
        skipped++;
        continue;
      }
      writtenIds.add(id);

      const hash = hashContent(listing);
      const existingData = existing.get(id);

      if (existingData && existingData.hash === hash) {
        // No change; skip
        skipped++;
      } else {
        // New or changed; write
        await setDoc(doc(db, 'listings', id), stripUndefined({ ...listing, hash }));
        written++;
      }
    }

    // Mark missing listings as inactive
    for (const [id, existingData] of existing) {
      if (!writtenIds.has(id) && existingData.active !== false) {
        await setDoc(doc(db, 'listings', id), { ...existingData, active: false });
      }
    }

    return { written, skipped };
  } catch (e) {
    console.error('Failed to write listings:', e);
    throw e;
  }
}

export async function readListingsFromFirestore(): Promise<Internship[]> {
  try {
    const listingsRef = collection(db, 'listings');
    const snap = await getDocs(listingsRef);
    return snap.docs
      .map((d) => {
        const data = d.data();
        // Filter out inactive listings
        if (data.active === false) return null;
        // Remove internal hash field
        const { hash, active, ...listing } = data;
        return listing as Internship;
      })
      .filter((l) => l !== null);
  } catch (e) {
    console.error('Failed to read listings:', e);
    return [];
  }
}

export async function getInternshipById(internshipId: string): Promise<Internship | null> {
  try {
    const docRef = doc(db, 'listings', internshipId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      return null;
    }
    const data = docSnap.data();
    // Filter out inactive listings
    if (data.active === false) {
      return null;
    }
    // Remove internal hash field
    const { hash, active, ...listing } = data;
    return listing as Internship;
  } catch (e) {
    console.error('Failed to read internship:', e);
    return null;
  }
}
