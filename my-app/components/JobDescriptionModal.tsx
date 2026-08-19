'use client';

import { useEffect, useRef, useState } from 'react';

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
  message,
  onSubmit,
  onCancel,
}: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset between listings so a previous paste never leaks into a new prompt.
  useEffect(() => {
    if (open) {
      setText('');
      textareaRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LENGTH;
  const canSubmit = trimmed.length >= MIN_LENGTH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="jd-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
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

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          placeholder="Paste the full job description, including requirements and qualifications…"
          className="mt-4 w-full resize-y rounded-md border border-gray-300 p-3 font-mono text-sm text-gray-900 focus:border-gray-500 focus:outline-none"
        />

        <div className="mt-2 flex items-center justify-between text-xs">
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
  );
}
