'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

export default function RegisterPage() {
  const router = useRouter();
  const { user, loading, signUp, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (!loading && user) {
      router.push('/');
    }
  }, [user, loading, router]);

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setPasswordMismatch(false);

    // Client-side validation
    if (password !== confirmPassword) {
      setPasswordMismatch(true);
      return;
    }

    if (password.length < 6) {
      setLocalError('Password must be at least 6 characters long');
      return;
    }

    setIsLoading(true);

    try {
      await signUp(email, password);
      router.push('/');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to register');
    } finally {
      setIsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const displayError = localError || error;

  return (
    <main className="min-h-screen flex items-center justify-center bg-white px-5">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="font-serif text-3xl font-semibold text-gray-900">Create Account</h1>
          <p className="mt-2 text-sm text-gray-600">
            Join to save favorites and tailor job applications
          </p>
        </div>

        {/* Error Message */}
        {displayError && (
          <div className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-200 text-sm text-red-700">
            {displayError}
            <button
              onClick={() => {
                setLocalError(null);
                clearError();
              }}
              className="ml-2 font-medium hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSignUp} className="space-y-4">
          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-accent focus:bg-white focus:outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all"
              required
              disabled={isLoading}
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-accent focus:bg-white focus:outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all"
              required
              disabled={isLoading}
            />
            <p className="mt-1 text-xs text-gray-400">At least 6 characters</p>
          </div>

          {/* Confirm Password */}
          <div>
            <label htmlFor="confirmPassword" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className={`w-full rounded-2xl border px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-4 focus:bg-white transition-all ${
                passwordMismatch
                  ? 'border-red-200 bg-red-50 focus:border-red-500 focus:ring-red-500/10'
                  : 'border-gray-200 bg-gray-50 focus:border-accent focus:ring-emerald-500/10'
              }`}
              required
              disabled={isLoading}
            />
            {passwordMismatch && (
              <p className="mt-1 text-xs text-red-700">Passwords do not match</p>
            )}
          </div>

          {/* Register Button */}
          <button
            type="submit"
            disabled={isLoading || passwordMismatch}
            className="w-full rounded-full bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Creating account...' : 'Register'}
          </button>
        </form>

        {/* Login Link */}
        <p className="mt-8 text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in here
          </Link>
        </p>
      </div>
    </main>
  );
}
