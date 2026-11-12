'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { User } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signUp = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        await createUserWithEmailAndPassword(auth, email, password);
      } catch (err) {
        throw mapFirebaseError(err);
      }
    },
    []
  );

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      throw mapFirebaseError(err);
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      await signOut(auth);
    } catch (err) {
      throw mapFirebaseError(err);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    signUp,
    signIn,
    logout,
    error,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

// Map Firebase error codes to user-friendly messages
function mapFirebaseError(error: unknown): Error {
  const err = error as { code?: string; message?: string };

  const errorMap: Record<string, string> = {
    'auth/email-already-in-use': 'This email is already registered. Please log in instead.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/weak-password': 'Password should be at least 6 characters long.',
    'auth/user-not-found': 'No account found with this email. Please register.',
    'auth/wrong-password': 'Incorrect password. Please try again.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/operation-not-allowed': 'This operation is not allowed. Please contact support.',
    'auth/too-many-requests': 'Too many failed login attempts. Please try again later.',
  };

  const code = err.code || '';
  const message = errorMap[code] || err.message || 'An error occurred. Please try again.';

  return new Error(message);
}
