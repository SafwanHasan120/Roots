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

    // Write/skip based on content hash
    for (const listing of listings) {
      const id = normalizeListingId(listing.appUrl) || listing.id;
      const hash = hashContent(listing);
      const existingData = existing.get(id);

      if (existingData && existingData.hash === hash) {
        // No change; skip
        skipped++;
      } else {
        // New or changed; write
        await setDoc(doc(db, 'listings', id), { ...listing, hash });
        written++;
      }
    }

    // Mark missing listings as inactive
    for (const [id] of existing) {
      if (!listings.some((l) => normalizeListingId(l.appUrl) === id || l.id === id)) {
        const existingData = existing.get(id);
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
