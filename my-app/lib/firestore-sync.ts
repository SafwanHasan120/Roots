import { db } from './firebase';
import { doc, setDoc, getDoc, collection, getDocs, deleteDoc, Timestamp } from 'firebase/firestore';
import type { ResumeSettings } from './types';

export interface TailorResult {
  internshipId: string;
  latex: string;
  tailoredAt: number;
  originalLatex?: string;
  coverageBefore?: number;
  coverageAfter?: number;
  degraded?: boolean;
  /** Advisory one-page estimate; 'unknown' means the template was unrecognised. */
  fitStatus?: 'fits' | 'over' | 'unknown';
  fitPt?: number;
  fitBudgetPt?: number;
}

/**
 * Convert an internship ID (which may be a URL) to a safe Firestore document ID
 * by hashing it to avoid special characters like "/" in Firestore paths
 */
export function getSafeDocId(internshipId: string): string {
  // Use a simple hash to convert the URL into a safe document ID
  let hash = 0;
  for (let i = 0; i < internshipId.length; i++) {
    const char = internshipId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36); // Base36 for a shorter string
}

/**
 * Save user's resume to Firestore at users/{uid}/private/resume
 */
export async function saveResumeToFirestore(uid: string, settings: ResumeSettings): Promise<void> {
  try {
    if (!uid) {
      throw new Error('No user UID provided');
    }
    const resumeRef = doc(db, 'users', uid, 'private', 'resume');
    await setDoc(resumeRef, {
      latex: settings.latex,
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error('Failed to save resume to Firestore:', { error, uid });
    // Don't throw - just log so app continues to work offline
  }
}

/**
 * Load user's resume from Firestore
 */
export async function loadResumeFromFirestore(uid: string): Promise<ResumeSettings | null> {
  try {
    const resumeRef = doc(db, 'users', uid, 'private', 'resume');
    const docSnap = await getDoc(resumeRef);

    if (!docSnap.exists()) {
      return null;
    }

    const data = docSnap.data();
    return {
      latex: data.latex || '',
    };
  } catch (error) {
    console.error('Failed to load resume from Firestore:', { error, uid });
    return null;
  }
}

/**
 * Save user's favorites to Firestore at users/{uid}/private/favorites
 */
export async function saveFavoritesToFirestore(uid: string, favorites: Set<string>): Promise<void> {
  try {
    if (!uid) {
      throw new Error('No user UID provided');
    }
    const favoritesRef = doc(db, 'users', uid, 'private', 'favorites');
    await setDoc(favoritesRef, {
      ids: Array.from(favorites),
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error('Failed to save favorites to Firestore:', { error, uid });
    // Don't throw - just log so app continues to work offline
  }
}

/**
 * Load user's favorites from Firestore
 */
export async function loadFavoritesFromFirestore(uid: string): Promise<Set<string> | null> {
  try {
    const favoritesRef = doc(db, 'users', uid, 'private', 'favorites');
    const docSnap = await getDoc(favoritesRef);

    if (!docSnap.exists()) {
      return null;
    }

    const data = docSnap.data();
    return new Set(data.ids || []);
  } catch (error) {
    console.error('Failed to load favorites from Firestore:', error);
    return null;
  }
}

/**
 * Save a tailor result to Firestore at users/{uid}/tailorResults/{docId}
 */
export async function saveTailorResultToFirestore(uid: string, result: TailorResult): Promise<void> {
  try {
    if (!uid) {
      throw new Error('No user UID provided');
    }
    const docId = getSafeDocId(result.internshipId);
    const tailorRef = doc(db, 'users', uid, 'tailorResults', docId);
    await setDoc(tailorRef, {
      internshipId: result.internshipId,
      latex: result.latex,
      originalLatex: result.originalLatex,
      coverageBefore: result.coverageBefore,
      coverageAfter: result.coverageAfter,
      degraded: result.degraded,
      // Firestore rejects `undefined`, so coerce rather than spreading the
      // optional fields straight through.
      fitStatus: result.fitStatus ?? null,
      fitPt: result.fitPt ?? null,
      fitBudgetPt: result.fitBudgetPt ?? null,
      tailoredAt: Timestamp.fromMillis(result.tailoredAt),
    });
  } catch (error) {
    const errorMsg = (error as any)?.message || JSON.stringify(error);
    console.error('Failed to save tailor result to Firestore:', {
      errorMsg,
      uid,
      internshipId: result.internshipId,
      fullError: error,
    });
  }
}

/**
 * Load all tailor results for a user from Firestore
 */
export async function loadTailorResultsFromFirestore(uid: string): Promise<Map<string, TailorResult>> {
  try {
    if (!uid) {
      return new Map();
    }
    const tailorCollection = collection(db, 'users', uid, 'tailorResults');
    const querySnap = await getDocs(tailorCollection);

    const results = new Map<string, TailorResult>();
    querySnap.forEach((docSnap) => {
      const data = docSnap.data();
      const result: TailorResult = {
        internshipId: data.internshipId,
        latex: data.latex || '',
        originalLatex: data.originalLatex,
        coverageBefore: data.coverageBefore,
        coverageAfter: data.coverageAfter,
        degraded: data.degraded,
        // Stored as null (Firestore rejects undefined) and absent entirely on
        // results predating fit estimation; both read back as undefined.
        fitStatus: data.fitStatus ?? undefined,
        fitPt: data.fitPt ?? undefined,
        fitBudgetPt: data.fitBudgetPt ?? undefined,
        tailoredAt: (data.tailoredAt as Timestamp)?.toMillis?.() || Date.now(),
      };
      results.set(data.internshipId, result);
    });

    return results;
  } catch (error) {
    console.error('Failed to load tailor results from Firestore:', { error, uid });
    return new Map();
  }
}

/**
 * Delete a tailor result from Firestore
 */
export async function deleteTailorResultFromFirestore(uid: string, internshipId: string): Promise<void> {
  try {
    if (!uid) {
      throw new Error('No user UID provided');
    }
    const docId = getSafeDocId(internshipId);
    const tailorRef = doc(db, 'users', uid, 'tailorResults', docId);
    await deleteDoc(tailorRef);
  } catch (error) {
    console.error('Failed to delete tailor result from Firestore:', { error, uid, internshipId });
  }
}
