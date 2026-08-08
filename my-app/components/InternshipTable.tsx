'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import Fuse from 'fuse.js';
import { useFavorites } from '@/context/FavoritesContext';
import { useAuth } from '@/context/AuthContext';
import { useTailor } from '@/context/TailorContext';
import { useResume } from '@/context/ResumeContext';
import { formatDateToMonthDay } from '@/lib/scraper';
import type { Internship } from '@/lib/types';

interface Props {
  internships: Internship[];
  showFavorites?: boolean;
  onlyFavorites?: boolean;
}

// 8 role buckets, matched by regex against i.role.
const ROLE_BUCKETS: { label: string; test: RegExp }[] = [
  { label: 'SWE', test: /software|swe|engineer|developer|full.?stack|backend|front.?end/i },
  { label: 'ML/AI', test: /machine learning|\bml\b|\bai\b|deep learning|nlp|computer vision|llm/i },
  { label: 'Data', test: /data (scien|analy|engineer)|analytics|\bbi\b|business intelligence/i },
  { label: 'Product', test: /product manage|\bpm\b|product intern/i },
  { label: 'Quant', test: /quant|trading|trader|research analyst/i },
  { label: 'DevOps/Infra', test: /devops|infra|platform|site reliability|\bsre\b|cloud|systems/i },
  { label: 'Hardware', test: /hardware|electrical|embedded|firmware|asic|\bfpga\b|chip|silicon/i },
  { label: 'Design/UX', test: /design|\bux\b|\bui\b|user experience|product design/i },
];

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/* ── Inline icons (no icon-library dependency) ─────────────────────── */
function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}
function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}
function HeartIcon({ filled, className }: { filled?: boolean; className?: string }) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
function CaretIcon({ direction, className }: { direction?: 'up' | 'down' | null; className?: string }) {
  if (direction === 'up') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M7 14l5-5 5 5z" />
      </svg>
    );
  }
  if (direction === 'down') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" opacity={0.3}>
      <path d="M7 10l5 5 5-5z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const PILL_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer select-none';
const PILL_ON = 'border-transparent bg-gray-900 text-white shadow-sm';
const PILL_OFF = 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900';

type SortDirection = 'asc' | 'desc' | null;

// A run of consecutive rows sharing a company. Adjacency (not a global
// company key) is deliberate: it folds repeats without reordering the list,
// so the active sort still decides where each run sits.
interface Group {
  key: string;
  company: string;
  companyUrl?: string;
  items: Internship[];
}

function groupByAdjacentCompany(rows: Internship[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    const prev = groups[groups.length - 1];
    // Case-insensitive so "TikTok"/"Tiktok" from different sources still fold.
    if (prev && prev.company.toLowerCase() === row.company.toLowerCase()) {
      prev.items.push(row);
      // Keep the first non-empty companyUrl in the run.
      if (!prev.companyUrl && row.companyUrl) prev.companyUrl = row.companyUrl;
    } else {
      groups.push({
        key: row.id,
        company: row.company,
        companyUrl: row.companyUrl,
        items: [row],
      });
    }
  }
  return groups;
}

// The date range spanned by a collapsed run, e.g. "August 4" or "Aug 1 – Aug 4".
function groupDateLabel(items: Internship[]): string {
  const stamps = items.map((i) => i.dateMs).filter((d) => d > 0);
  if (stamps.length === 0) return '—';
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const minLabel = formatDateToMonthDay(min);
  const maxLabel = formatDateToMonthDay(max);
  return minLabel === maxLabel ? maxLabel : `${minLabel} – ${maxLabel}`;
}

export default function InternshipTable({ internships, showFavorites = true, onlyFavorites = false }: Props) {
  const [query, setQuery] = useState('');
  const [activeLocs, setActiveLocs] = useState<Set<string>>(new Set());
  const [activeRoles, setActiveRoles] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<SortDirection>(null);
  const [tailoring, setTailoring] = useState<Map<string, boolean>>(new Map());
  const [tailorErrors, setTailorErrors] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { isFavorite, toggleFavorite } = useFavorites();
  const { user } = useAuth();
  const { getResult, setResult, openView } = useTailor();
  const { settings: resumeSettings } = useResume();

  // Reset filters when switching to Favorites view
  useEffect(() => {
    if (onlyFavorites) {
      setQuery('');
      setActiveLocs(new Set());
      setActiveRoles(new Set());
      setSortDir(null);
    }
  }, [onlyFavorites]);

  const fuse = useMemo(
    () =>
      new Fuse(internships, {
        keys: [
          { name: 'company', weight: 0.4 },
          { name: 'role', weight: 0.4 },
          { name: 'location', weight: 0.2 },
        ],
        threshold: 0.3,
      }),
    [internships]
  );

  // Top 20 location tags by frequency.
  const locationTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const i of internships) {
      const parts = i.location
        .split(/,|\/|<br>/i)
        .map((p) => p.trim())
        .filter((p) => p && p !== '—');
      for (const p of parts) freq.set(p, (freq.get(p) ?? 0) + 1);
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([loc, count]) => ({ loc, count }));
  }, [internships]);

  const filtered = useMemo(() => {
    // query → fuse.search OR passthrough
    let rows = query.trim()
      ? fuse.search(query.trim()).map((r) => r.item)
      : internships;

    // filter activeLocs (match any active location substring)
    if (activeLocs.size > 0) {
      rows = rows.filter((i) => {
        const loc = i.location.toLowerCase();
        for (const a of activeLocs) if (loc.includes(a.toLowerCase())) return true;
        return false;
      });
    }

    // filter activeRoles (match any active bucket)
    if (activeRoles.size > 0) {
      rows = rows.filter((i) =>
        ROLE_BUCKETS.some((b) => activeRoles.has(b.label) && b.test.test(i.role))
      );
    }

    return rows;
  }, [query, fuse, internships, activeLocs, activeRoles]);

  // Apply sorting to filtered results
  const sorted = useMemo(() => {
    if (!sortDir) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const aDate = a.dateMs || 0;
      const bDate = b.dateMs || 0;
      return sortDir === 'asc' ? aDate - bDate : bDate - aDate;
    });
    return copy;
  }, [filtered, sortDir]);

  const groups = useMemo(() => groupByAdjacentCompany(sorted), [sorted]);

  // Collapse everything again when the result set changes: an id left over
  // from a previous filter would otherwise silently expand a new group.
  useEffect(() => {
    setExpanded(new Set());
  }, [query, activeLocs, activeRoles, sortDir]);

  const hasFilters = query.trim() !== '' || activeLocs.size > 0 || activeRoles.size > 0;
  const clearAll = () => {
    setQuery('');
    setActiveLocs(new Set());
    setActiveRoles(new Set());
  };

  const handleTailor = async (internship: Internship) => {
    if (!user) return;

    const internshipId = internship.id;
    console.log('[Tailor] Starting for internship:', internshipId);

    setTailoring((prev) => new Map(prev).set(internshipId, true));
    setTailorErrors((prev) => {
      const next = new Map(prev);
      next.delete(internshipId);
      return next;
    });

    try {
      console.log('[Tailor] Sending request to /api/tailor');
      const response = await fetch('/api/tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          internshipId,
          appUrl: internship.appUrl,
          latex: resumeSettings.latex,
          uid: user.uid,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        message?: string;
        latex?: string;
      };

      console.log('[Tailor] Response status:', response.status);
      console.log('[Tailor] Response data:', data);

      if (!response.ok) {
        const errorCode = data.error || 'unknown';
        let errorMessage = 'Something went wrong. Please try again.';

        if (errorCode === 'jd_scrape_failed') {
          errorMessage = "Couldn't read that job page. Try a different link.";
        } else if (errorCode === 'rate_limited') {
          errorMessage = 'Daily limit reached (5/5). Resets at midnight UTC.';
        }

        console.log('[Tailor] Error:', errorMessage);
        setTailorErrors((prev) => new Map(prev).set(internshipId, errorMessage));
        return;
      }

      if (data.latex) {
        console.log('[Tailor] Setting result with LaTeX length:', data.latex.length);
        setResult({
          internshipId,
          latex: data.latex,
          tailoredAt: Date.now(),
        });
        console.log('[Tailor] Result set successfully');
      } else {
        console.log('[Tailor] No LaTeX in response data');
        setTailorErrors((prev) =>
          new Map(prev).set(internshipId, 'No LaTeX returned from API')
        );
      }
    } catch (error) {
      console.error('[Tailor] Unexpected error:', error);
      setTailorErrors((prev) =>
        new Map(prev).set(internshipId, 'Something went wrong. Please try again.')
      );
    } finally {
      setTailoring((prev) => {
        const next = new Map(prev);
        next.delete(internshipId);
        return next;
      });
    }
  };

  return (
    <div className="spa-fade-up" style={{ animationDelay: '120ms' }}>
      {/* ── Control panel ─────────────────────────────────────────── */}
      <div className="rounded-3xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.08)] sm:p-7">
        {/* Search */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Search by company, role, or location…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-2xl border border-gray-200 bg-gray-50/60 py-3.5 pl-12 pr-4 text-sm text-gray-900 placeholder:text-gray-500 transition-all duration-300 focus:border-accent focus:bg-white focus:outline-none focus:ring-4 focus:ring-emerald-500/10"
          />
        </div>

        {/* Roles */}
        <div className="mt-6">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            Discipline
          </div>
          <div className="flex flex-wrap gap-2">
            {ROLE_BUCKETS.map((b) => {
              const on = activeRoles.has(b.label);
              return (
                <button
                  key={b.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActiveRoles((s) => toggle(s, b.label))}
                  className={`${PILL_BASE} ${on ? PILL_ON : PILL_OFF}`}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Locations */}
        <div className="mt-6">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            Location
          </div>
          <div className="flex flex-wrap gap-2">
            {locationTags.map(({ loc, count }) => {
              const on = activeLocs.has(loc);
              return (
                <button
                  key={loc}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActiveLocs((s) => toggle(s, loc))}
                  className={`${PILL_BASE} ${on ? PILL_ON : PILL_OFF}`}
                >
                  <PinIcon className={`h-3.5 w-3.5 ${on ? 'text-emerald-300' : 'text-gray-500'}`} />
                  {loc}
                  <span className={`ml-0.5 tabular-nums ${on ? 'text-white/60' : 'text-gray-500'}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Results meta bar ──────────────────────────────────────── */}
      <div className="mt-8 mb-4 flex items-center justify-between gap-4 px-1">
        <p className="text-sm text-gray-500">
          Showing{' '}
          <span className="font-semibold text-gray-900">{filtered.length.toLocaleString()}</span>{' '}
          of {internships.length.toLocaleString()} positions
        </p>
        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs font-medium text-gray-500 underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* ── Desktop table ─────────────────────────────────────────── */}
      <div className="hidden overflow-hidden rounded-3xl border border-gray-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.08)] md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/60">
              <th className="px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Company
              </th>
              <th className="px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Position
              </th>
              <th className="px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Location
              </th>
              <th className="px-6 py-4">
                <button
                  type="button"
                  onClick={() => {
                    if (sortDir === null) setSortDir('desc');
                    else if (sortDir === 'desc') setSortDir('asc');
                    else setSortDir(null);
                  }}
                  className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 hover:text-gray-700 transition-colors"
                  title="Click to sort by date"
                >
                  Posted
                  <CaretIcon direction={sortDir === 'desc' ? 'down' : sortDir === 'asc' ? 'up' : null} className="h-3.5 w-3.5" />
                </button>
              </th>
              <th className="px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Apply
              </th>
              {showFavorites && (
                <th className="px-6 py-4 text-center">
                  <HeartIcon className="h-4 w-4 text-gray-400 mx-auto" />
                </th>
              )}
              
              <th className="px-6 py-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Tailor
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isGroup = g.items.length > 1;
              const isOpen = expanded.has(g.key);

              // A folded run renders one summary row in place of its members.
              if (isGroup && !isOpen) {
                return (
                  <tr
                    key={g.key}
                    onClick={() => setExpanded((s) => toggle(s, g.key))}
                    className="group cursor-pointer border-b border-gray-100 transition-colors duration-150 last:border-0 hover:bg-emerald-50/40"
                  >
                    <td className="px-3 py-4 align-middle">
                      <span className="font-semibold text-gray-900 line-clamp-2">{g.company}</span>
                    </td>
                    <td className="px-3 py-4 align-middle" colSpan={2}>
                      <button
                        type="button"
                        aria-expanded={false}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded((s) => toggle(s, g.key));
                        }}
                        className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200"
                      >
                        <ChevronIcon className="h-3.5 w-3.5" />
                        {g.items.length} open positions
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 align-middle text-sm tabular-nums text-gray-500">
                      {groupDateLabel(g.items)}
                    </td>
                    <td className="px-2 py-4 align-middle text-sm text-gray-400">—</td>
                    {showFavorites && <td className="px-2 py-4" />}
                    <td className="px-3 py-4" />
                  </tr>
                );
              }

              return g.items.map((i, idx) => (
              <tr
                key={i.id}
                className={`group border-b border-gray-100 transition-colors duration-150 last:border-0 hover:bg-emerald-50/40 ${
                  isGroup ? 'bg-gray-50/40' : ''
                }`}
              >
                <td className="px-3 py-4 align-middle">
                  {/* Within an expanded run only the first row carries the
                      company name; the rest indent under it. */}
                  {isGroup && idx > 0 ? (
                    <span className="sr-only">{i.company}</span>
                  ) : isGroup ? (
                    <button
                      type="button"
                      aria-expanded={true}
                      onClick={() => setExpanded((s) => toggle(s, g.key))}
                      className="inline-flex items-center gap-1.5 text-left font-semibold text-gray-900 transition-colors hover:text-accent"
                    >
                      <ChevronIcon className="h-3.5 w-3.5 shrink-0 rotate-180 text-gray-400" />
                      <span className="line-clamp-2">{i.company}</span>
                    </button>
                  ) : i.companyUrl ? (
                    <a
                      href={i.companyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-gray-900 decoration-emerald-300 decoration-2 underline-offset-4 transition-colors hover:text-accent hover:underline line-clamp-2"
                    >
                      {i.company}
                    </a>
                  ) : (
                    <span className="font-semibold text-gray-900 line-clamp-2">{i.company}</span>
                  )}
                </td>
                <td className="px-3 py-4 align-middle text-sm text-gray-600">
                  {i.role}
                </td>
                <td className="px-3 py-4 align-middle">
                  <span className="inline-flex items-center gap-1.5 text-sm text-gray-500">
                    <PinIcon className="h-3.5 w-3.5 shrink-0 text-gray-300" />
                    {i.location}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-4 align-middle text-sm tabular-nums text-gray-500">
                  {formatDateToMonthDay(i.dateMs)}
                </td>
                <td className="px-2 py-4 align-middle">
                  {i.appUrl ? (
                    <a
                      href={i.appUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-all duration-200 hover:bg-accent hover:shadow-md"
                    >
                      Apply
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="text-xs text-gray-500">—</span>
                  )}
                </td>
                {showFavorites && (
                  <td className="px-2 py-4 align-middle text-center">
                    <button
                      type="button"
                      onClick={() => toggleFavorite(i.id)}
                      className="inline-flex items-center justify-center rounded-full p-1.5 transition-all duration-200 hover:bg-red-50"
                      title={isFavorite(i.id) ? 'Remove from favorites' : 'Add to favorites'}
                      aria-label={isFavorite(i.id) ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <HeartIcon filled={isFavorite(i.id)} className={`h-5 w-5 ${isFavorite(i.id) ? 'text-red-500' : 'text-gray-300 hover:text-red-400'}`} />
                    </button>
                  </td>
                )}
                <td className="px-3 py-4 align-middle">
                  {!user ? (
                    <Link
                      href="/login"
                      title="Sign in to use Tailor"
                      className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-all"
                    >
                      Sign In
                    </Link>
                  ) : !resumeSettings.latex.trim() ? (
                    <button
                      type="button"
                      disabled
                      title="Add resume first"
                      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-400"
                    >
                      <SparkIcon className="h-3.5 w-3.5" />
                      Add resume first
                    </button>
                  ) : getResult(i.id) ? (
                    <button
                      type="button"
                      onClick={() => openView(i.id)}
                      title="View tailored resume"
                      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 transition-all"
                    >
                      <SparkIcon className="h-3.5 w-3.5" />
                      View
                    </button>
                  ) : tailoring.get(i.id) ? (
                    <button
                      type="button"
                      disabled
                      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-400"
                    >
                      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Tailoring…
                    </button>
                  ) : tailorErrors.get(i.id) ? (
                    <button
                      type="button"
                      onClick={() => {
                        setTailorErrors((prev) => {
                          const next = new Map(prev);
                          next.delete(i.id);
                          return next;
                        });
                        handleTailor(i);
                      }}
                      title={tailorErrors.get(i.id)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-300 hover:bg-red-100 transition-all"
                    >
                      <SparkIcon className="h-3.5 w-3.5" />
                      Failed — retry?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleTailor(i)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent transition-all"
                    >
                      <SparkIcon className="h-3.5 w-3.5" />
                      Tailor
                    </button>
                  )}
                </td>
              </tr>
              ));
            })}
          </tbody>
        </table>

        {sorted.length === 0 && <EmptyState />}
      </div>

      {/* ── Mobile / tablet cards ─────────────────────────────────── */}
      <div className="space-y-3 md:hidden">
        {groups.map((g) => {
          const isGroup = g.items.length > 1;
          const isOpen = expanded.has(g.key);

          // Collapsed run: one tappable summary card, min-h-14 for touch.
          if (isGroup && !isOpen) {
            return (
              <button
                key={g.key}
                type="button"
                aria-expanded={false}
                onClick={() => setExpanded((s) => toggle(s, g.key))}
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border border-gray-200/80 bg-white p-5 text-left shadow-sm transition-colors active:bg-gray-50"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-gray-900">{g.company}</span>
                  <p className="mt-1 text-sm text-gray-500">
                    {g.items.length} open positions
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="whitespace-nowrap text-xs tabular-nums text-gray-500">
                    {groupDateLabel(g.items)}
                  </span>
                  <ChevronIcon className="h-4 w-4 text-gray-400" />
                </div>
              </button>
            );
          }

          return (
            <div key={g.key} className={isGroup ? 'space-y-2' : undefined}>
              {isGroup && (
                <button
                  type="button"
                  aria-expanded={true}
                  onClick={() => setExpanded((s) => toggle(s, g.key))}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border border-gray-200/80 bg-white px-5 py-4 text-left shadow-sm transition-colors active:bg-gray-50"
                >
                  <span className="font-semibold text-gray-900">{g.company}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
                    Hide
                    <ChevronIcon className="h-4 w-4 rotate-180 text-gray-400" />
                  </span>
                </button>
              )}

              <div className={isGroup ? 'space-y-2 border-l-2 border-gray-200 pl-3' : undefined}>
                {g.items.map((i) => (
          <div
            key={i.id}
            className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {isGroup ? (
                  <span className="sr-only">{i.company}</span>
                ) : i.companyUrl ? (
                  <a
                    href={i.companyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-gray-900 transition-colors hover:text-accent"
                  >
                    {i.company}
                  </a>
                ) : (
                  <span className="font-semibold text-gray-900">{i.company}</span>
                )}
                <p className="mt-1 text-sm leading-snug text-gray-600">{i.role}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="whitespace-nowrap text-xs tabular-nums text-gray-500">
                  {formatDateToMonthDay(i.dateMs)}
                </span>
                {showFavorites && (
                  <button
                    type="button"
                    onClick={() => toggleFavorite(i.id)}
                    className="inline-flex items-center justify-center rounded-full p-2 transition-all duration-200 hover:bg-red-50"
                    title={isFavorite(i.id) ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label={isFavorite(i.id) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <HeartIcon filled={isFavorite(i.id)} className={`h-4 w-4 ${isFavorite(i.id) ? 'text-red-500' : 'text-gray-300 hover:text-red-400'}`} />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-500">
              <PinIcon className="h-3.5 w-3.5 shrink-0 text-gray-300" />
              {i.location}
            </div>

            <div className="mt-4 flex items-center gap-2">
              {i.appUrl ? (
                <a
                  href={i.appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gray-900 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-accent"
                >
                  Apply
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span className="flex-1 text-center text-xs text-gray-500">No link</span>
              )}
              {!user ? (
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-xs font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-all"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
                  </svg>
                  Sign in
                </Link>
              ) : !resumeSettings.latex.trim() ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-400"
                >
                  <SparkIcon className="h-3.5 w-3.5" />
                  Add resume first
                </button>
              ) : getResult(i.id) ? (
                <button
                  type="button"
                  onClick={() => openView(i.id)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 transition-all"
                >
                  <SparkIcon className="h-3.5 w-3.5" />
                  View
                </button>
              ) : tailoring.get(i.id) ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-400"
                >
                  <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Tailoring…
                </button>
              ) : tailorErrors.get(i.id) ? (
                <button
                  type="button"
                  onClick={() => {
                    setTailorErrors((prev) => {
                      const next = new Map(prev);
                      next.delete(i.id);
                      return next;
                    });
                    handleTailor(i);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-600 hover:border-red-300 hover:bg-red-100 transition-all"
                >
                  <SparkIcon className="h-3.5 w-3.5" />
                  Failed — retry?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleTailor(i)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2.5 text-xs font-medium text-white hover:bg-accent transition-all"
                >
                  <SparkIcon className="h-3.5 w-3.5" />
                  Tailor
                </button>
              )}
            </div>
          </div>
                ))}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="rounded-2xl border border-gray-200/80 bg-white">
            <EmptyState />
          </div>
        )}
      </div>

    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
        <SearchIcon className="h-5 w-5 text-accent" />
      </div>
      <p className="mt-4 font-serif text-lg text-gray-900">No positions found</p>
      <p className="mt-1 max-w-xs text-sm text-gray-500">
        Try adjusting your search or clearing a filter to see more results.
      </p>
    </div>
  );
}
