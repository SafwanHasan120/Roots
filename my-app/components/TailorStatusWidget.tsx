'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type TailorWidgetPhase = 'starting' | 'queued' | 'running' | 'done' | 'failed';

export interface TailorWidgetJob {
  id: string;
  company: string;
  role: string;
  phase: TailorWidgetPhase;
  message?: string;
}

const PHASE_LABEL: Record<Exclude<TailorWidgetPhase, 'failed'>, string> = {
  starting: 'Starting…',
  queued: 'In queue',
  running: 'Tailoring…',
  done: 'Ready',
};

interface Props {
  jobs: TailorWidgetJob[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * Corner status for in-flight tailor jobs.
 *
 * Portaled to the body: the listings panel animates with a transform, which
 * would otherwise pin a `fixed` child to the panel instead of the viewport.
 */
export default function TailorStatusWidget({ jobs, onOpen, onDismiss }: Props) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || jobs.length === 0) return null;

  return createPortal(
    <div
      className="fixed bottom-5 right-5 z-40 w-[min(18.5rem,calc(100vw-2.5rem))] spa-fade-up sm:bottom-6 sm:right-6"
      role="status"
      aria-live="polite"
    >
      <div className="overflow-hidden rounded-3xl border border-gray-200/80 bg-white/95 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_16px_40px_-12px_rgba(0,0,0,0.18)] backdrop-blur-xl">
        {jobs.length > 1 && (
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              {jobs.some((job) => job.phase === 'starting' || job.phase === 'queued' || job.phase === 'running')
                ? 'Tailoring'
                : 'Finished'}
            </p>
            <p className="text-xs tabular-nums text-gray-400">{jobs.length}</p>
          </div>
        )}
        <ul className="max-h-64 overflow-y-auto">
          {jobs.map((job) => (
            <li key={job.id} className="border-t border-gray-100 first:border-t-0">
              <JobRow job={job} onOpen={onOpen} onDismiss={onDismiss} />
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

function JobRow({
  job,
  onOpen,
  onDismiss,
}: {
  job: TailorWidgetJob;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const settled = job.phase === 'done' || job.phase === 'failed';
  const label = job.phase === 'failed' ? job.message || "Couldn't finish" : PHASE_LABEL[job.phase];

  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <StatusMark phase={job.phase} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900" title={job.company}>
          {job.company}
        </p>
        <p className="truncate text-xs text-gray-500" title={job.role}>
          {job.role}
        </p>
        {job.phase === 'done' ? (
          <button
            type="button"
            onClick={() => onOpen(job.id)}
            className="mt-1 text-xs font-medium text-accent transition-opacity hover:opacity-70"
          >
            {label}
          </button>
        ) : (
          <p
            className={`mt-1 text-xs ${job.phase === 'failed' ? 'line-clamp-2 text-red-600' : 'text-gray-500'}`}
            title={label}
          >
            {label}
          </p>
        )}
      </div>
      {settled && (
        <button
          type="button"
          onClick={() => onDismiss(job.id)}
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          aria-label={`Dismiss ${job.company}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function StatusMark({ phase }: { phase: TailorWidgetPhase }) {
  if (phase === 'done') {
    return (
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M5 12.5 9.5 17 19 7" />
        </svg>
      </span>
    );
  }

  if (phase === 'failed') {
    return (
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M12 7.5v6M12 16.5v.5" />
        </svg>
      </span>
    );
  }

  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-accent">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" opacity="0.2" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}
