'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Asks the user to paste a job description.
 *
 * Shown only when automatic extraction found nothing usable — client-rendered
 * boards (Workday and similar) serve their description via JavaScript, so there
 * is no text in the HTML to scrape. Rather than dead-ending, the user pastes it
 * and we tailor against that.
 *
 * No quota was consumed by the failed attempt, so submitting here costs the
 * same as the original request.
 */

interface Props {
  open: boolean;
  company: string;
  role: string;
  /** Listing URL, so the user can open the posting without dismissing this dialog. */
  appUrl?: string;
  /** Message from the worker explaining why we are asking. */
  message?: string;
  onSubmit: (jobDescription: string) => void;
  onCancel: () => void;
}

/** Below this, a paste is almost certainly a mis-copy rather than a description. */
const MIN_LENGTH = 120;

export default function JobDescriptionModal({
  open,
  company,
  role,
  appUrl,
  message,
  onSubmit,
  onCancel,
}: Props) {
  const [text, setText] = useState('');
  const [mounted, setMounted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Portal target only exists in the browser.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Reset between listings so a previous paste never leaks into a new prompt.
  // `mounted` is included because the textarea is portaled and does not exist
  // until the first client commit.
  useEffect(() => {
    if (open && mounted) {
      setText('');
      textareaRef.current?.focus();
    }
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  // Keep the dialog locked to the viewport while it is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open || !mounted) return null;

  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LENGTH;
  const canSubmit = trimmed.length >= MIN_LENGTH;

  return createPortal(
    <div className="fixed inset-0 z-[80] overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div
        className="relative flex min-h-full items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jd-modal-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}
      >
      <div
        className="my-4 flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="jd-modal-title"
          className="font-serif text-xl font-semibold tracking-tight text-gray-900"
        >
          Paste the job description
        </h2>

        <p className="mt-1 text-sm text-gray-500">
          {role} at {company}
        </p>

        <p className="mt-3 text-sm text-gray-600">
          {message ??
            "We couldn't read the job description from that page — some job boards load it with JavaScript. Paste it here and we'll tailor your resume against it."}
        </p>

        {appUrl ? (
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-gray-800"
          >
            Open job listing
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M7 17 17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </a>
        ) : null}

        <p className="mt-3 text-xs text-gray-500">
          Open the listing in a new tab, copy the description, then paste it below. This window stays open.
        </p>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder="Paste the full job description, including requirements and qualifications…"
          className="mt-4 min-h-0 w-full flex-1 resize-none overflow-auto rounded-md border border-gray-300 p-3 font-mono text-sm text-gray-900 focus:border-gray-500 focus:outline-none"
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
          <span className={tooShort ? 'text-amber-600' : 'text-gray-400'}>
            {trimmed.length === 0
              ? 'The more complete the description, the better the tailoring.'
              : tooShort
                ? `A bit short — ${MIN_LENGTH - trimmed.length} more characters needed.`
                : `${trimmed.length.toLocaleString()} characters`}
          </span>
          <span className="text-gray-400">This attempt did not use your daily limit.</span>
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(trimmed)}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Tailor resume
          </button>
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}
