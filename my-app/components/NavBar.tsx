'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useResume } from '@/context/ResumeContext';
import { useAuth } from '@/context/AuthContext';

export default function NavBar() {
  const router = useRouter();
  const { open } = useResume();
  const { user, loading, logout } = useAuth();
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    setIsProfileOpen(false);
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200/70 bg-white/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5 sm:px-8 lg:px-12">
        {/* Wordmark */}
        <div className="flex items-baseline gap-2.5">
          <Link href="/" className="hover:opacity-70 transition-opacity">
            <h1 className="font-serif text-[1.75rem] font-medium tracking-[-0.02em] text-gray-900">
              Roots
            </h1>
          </Link>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {/* Resume Settings */}
          <button
            type="button"
            onClick={open}
            className="group inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-300 hover:border-gray-300 hover:text-gray-900 hover:shadow-md sm:px-5"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 text-accent transition-transform duration-300 group-hover:scale-110"
              aria-hidden="true"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 13h6M9 17h4" />
            </svg>
            <span className="hidden sm:inline">Resume Settings</span>
            <span className="sm:hidden">Resume</span>
          </button>

          {/* Auth Section */}
          {loading ? (
            <div className="h-10 w-10 rounded-full border border-gray-200 bg-gray-50 animate-pulse" />
          ) : user ? (
            // User logged in — profile dropdown
            <div className="relative">
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-sm font-medium text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:shadow-md"
                title={user.email || 'User'}
              >
                {user.email?.[0].toUpperCase() || 'U'}
              </button>

              {/* Dropdown menu */}
              {isProfileOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-2xl border border-gray-200 bg-white shadow-lg">
                  <div className="border-b border-gray-100 px-4 py-3">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Account</p>
                    <p className="mt-1 truncate text-sm text-gray-900">{user.email}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            // User not logged in — sign in link
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:text-gray-900 hover:shadow-md sm:px-5"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
              </svg>
              <span className="hidden sm:inline">Sign In</span>
              <span className="sm:hidden">Sign In</span>
            </Link>
          )}
        </div>
      </nav>

      {/* Close dropdown when clicking outside */}
      {isProfileOpen && (
        <div
          className="fixed inset-0 z-[-1]"
          onClick={() => setIsProfileOpen(false)}
        />
      )}
    </header>
  );
}
