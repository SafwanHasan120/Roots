'use client';

import { useTailor } from '@/context/TailorContext';
import { Copy, Check, X, AlertCircle } from 'lucide-react';
import { useState, useCallback } from 'react';
import { computeLatexDiff, type DiffLine } from '@/lib/latexDiff';

function timeAgo(epochMs: number): string {
  const s = Math.floor((Date.now() - epochMs) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

function DiffLineComponent({ line }: { line: DiffLine }) {
  const baseClass = 'font-mono text-sm px-3 py-1.5 border-l-4';

  if (line.type === 'unchanged') {
    return (
      <div className={`${baseClass} border-l-gray-300 bg-gray-50/50 text-gray-700`}>
        {line.before}
      </div>
    );
  }

  if (line.type === 'changed') {
    return (
      <div className="space-y-1">
        <div className={`${baseClass} border-l-yellow-500 bg-yellow-50/70 text-yellow-800 line-through`}>
          {line.before}
        </div>
        <div className={`${baseClass} border-l-blue-500 bg-blue-50/70 text-blue-800`}>
          {line.after}
        </div>
      </div>
    );
  }

  if (line.type === 'removed') {
    return (
      <div className={`${baseClass} border-l-red-500 bg-red-50/70 text-red-800 line-through`}>
        {line.before}
      </div>
    );
  }

  // added
  return (
    <div className={`${baseClass} border-l-green-500 bg-green-50/70 text-green-800`}>
      {line.after}
    </div>
  );
}

export default function TailorModal() {
  const { viewTarget, closeView, getResult, clearResult } = useTailor();
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'latex' | 'diff'>('latex');

  const result = viewTarget ? getResult(viewTarget) : null;

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.latex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [result]);

  const handleReTailor = useCallback(() => {
    if (!viewTarget) return;
    clearResult(viewTarget);
    closeView();
  }, [viewTarget, clearResult, closeView]);

  if (!viewTarget || !result) return null;

  const diff = result.originalLatex
    ? computeLatexDiff(result.originalLatex, result.latex)
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tailor-modal-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={closeView}
        className="absolute inset-0 bg-gray-900/30 backdrop-blur-sm"
      />

      {/* Panel */}
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-gray-200/80 bg-white shadow-2xl spa-fade-up sm:rounded-3xl">
        {/* Degraded Banner */}
        {result.degraded && (
          <div className="flex items-start gap-3 border-b border-yellow-200 bg-yellow-50/80 px-6 py-4 sm:px-8">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600" />
            <div>
              <p className="text-sm font-medium text-yellow-900">Limited Job Information</p>
              <p className="text-sm text-yellow-800">
                The job description could not be fully read. Tailoring used the role title only.
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-5 sm:px-8 sm:py-6">
          <div className="flex-1">
            <h2
              id="tailor-modal-title"
              className="font-serif text-2xl font-semibold tracking-tight text-gray-900"
            >
              Tailored Resume
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Tailored {timeAgo(result.tailoredAt)}
              {' · '}
              {/* The stored artifact is deleted after 30 days by an S3 lifecycle
                  rule, so say so rather than letting a download silently 404. */}
              <span title="Tailored resumes are deleted from storage 30 days after they are created.">
                expires 30 days after tailoring
              </span>
            </p>

            {/* Coverage Metrics */}
            {(result.coverageBefore !== undefined || result.coverageAfter !== undefined) && (
              <div className="mt-3 flex items-center gap-4">
                {result.coverageBefore !== undefined && (
                  <div className="flex items-baseline gap-1">
                    <span className="text-xs font-medium text-gray-600">Coverage:</span>
                    <span className="text-sm font-semibold text-gray-900">
                      {result.coverageBefore}%
                    </span>
                  </div>
                )}
                {result.coverageBefore !== undefined && result.coverageAfter !== undefined && (
                  <>
                    <span className="text-xs text-gray-400">→</span>
                    <span className="text-sm font-semibold text-accent">
                      {result.coverageAfter}%
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={closeView}
            aria-label="Close"
            className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6 sm:px-8">
          <button
            onClick={() => setActiveTab('latex')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'latex'
                ? 'border-b-2 border-accent text-accent'
                : 'border-b-2 border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            LaTeX Code
          </button>
          {result.originalLatex && (
            <button
              onClick={() => setActiveTab('diff')}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'diff'
                  ? 'border-b-2 border-accent text-accent'
                  : 'border-b-2 border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              Changes
            </button>
          )}
        </div>

        {/* Body (scrollable) */}
        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {activeTab === 'latex' ? (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                  LaTeX Code
                </label>
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 transition-all hover:border-gray-300"
                >
                  {copied ? (
                    <>
                      <Check size={14} />
                      <span className="text-accent">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy size={14} />
                      Copy
                    </>
                  )}
                </button>
              </div>
              <pre className="w-full rounded-2xl border border-gray-200 bg-gray-50/60 px-4 py-3 font-mono text-sm leading-relaxed text-gray-700 overflow-x-auto">
                <code>{result.latex}</code>
              </pre>
            </div>
          ) : (
            <div>
              <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                Changed Bullets
              </div>
              <div className="space-y-1.5">
                {diff.length > 0 ? (
                  diff.map((line, idx) => <DiffLineComponent key={idx} line={line} />)
                ) : (
                  <p className="py-4 text-sm text-gray-500 italic">No changes detected</p>
                )}
              </div>

              {/* Legend */}
              <div className="mt-6 space-y-2 border-t border-gray-200 pt-4 text-xs text-gray-600">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded bg-green-500" />
                  <span>Added</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded bg-red-500" />
                  <span>Removed</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded bg-blue-500" />
                  <span>Changed</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded bg-gray-300" />
                  <span>Unchanged</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4 sm:px-8">
          <button
            type="button"
            onClick={handleReTailor}
            className="rounded-full border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-600 transition-all hover:border-gray-300 hover:text-gray-900"
          >
            Re-tailor
          </button>
          <button
            type="button"
            onClick={closeView}
            className="rounded-full bg-gray-900 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-accent hover:shadow-md"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
