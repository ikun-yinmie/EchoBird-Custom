// Right panel for "我的AI生涯" — the selected family's session history.
// One family at a time (set by the family cards in AiCareerMain) keeps the
// payload small; rows page in on scroll via the backend `offset`. Scrolls
// with the wheel only — the scrollbar is hidden (slim-scroll) so the list
// doesn't shift when it appears. Loading shows skeleton rows, not text.
//
// react-hooks (v7) is strict here: no Date.now()/new Date()/ref reads during
// render, and no synchronous setState in an effect body. So the relative-time
// label is computed OFF render (when a page loads) and stored on each row, and
// the "switching family / refreshing" reset is a DERIVED `stale` flag rather
// than a synchronous state reset.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageSquareText } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useAiCareerStore } from '../../stores/aiCareerStore';
import { aiCareerFamilyHistory, type SavedSession } from '../../api/aiCareer';
import { TranscriptViewerDialog, type TranscriptTarget } from './TranscriptViewerDialog';

const PAGE = 30;
// Title-bar widths for skeleton rows — varied so the placeholder reads as a
// list of different-length titles rather than identical blocks.
const SKELETON_WIDTHS = ['72%', '58%', '80%', '52%', '68%', '76%', '61%'];

function parseSavedMs(savedAt: string): number {
  const parsed = Date.parse(savedAt);
  if (!isNaN(parsed)) return parsed;
  const num = Number(savedAt);
  if (!isNaN(num) && num > 0) return num < 1e11 ? num * 1000 : num;
  return Date.now();
}

// A loaded session plus its pre-rendered relative-time label, computed off
// render so the row stays pure (react-hooks/purity forbids Date.now() there).
interface Row extends SavedSession {
  rel: string;
}

function SkeletonRow({ w }: { w: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-cyber-border/40 bg-cyber-text/[0.02] px-3 py-2.5">
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-3 rounded bg-cyber-text/10 animate-pulse" style={{ width: w }} />
        <div className="h-2.5 w-2/5 rounded bg-cyber-text/10 animate-pulse" />
      </div>
    </div>
  );
}

export function AiCareerPanel() {
  const { t, locale } = useI18n();
  const selectedFamily = useAiCareerStore((s) => s.selectedFamily);
  const familyNames = useAiCareerStore((s) => s.familyNames);
  const refreshKey = useAiCareerStore((s) => s.refreshKey);

  const [rows, setRows] = useState<Row[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<TranscriptTarget | null>(null);
  const offsetRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Identifies the family + refresh generation currently selected. When the
  // loaded data is for a different key, `stale` is true → show the skeleton
  // until the fresh page lands. Derived (not setState) so the load effect never
  // writes state synchronously (react-hooks/set-state-in-effect).
  const currentKey = `${selectedFamily}::${refreshKey}`;
  const stale = loadedKey !== currentKey;

  // Pure relative-time label: `nowMs` is captured off render and passed in, so
  // this never calls Date.now() / argless new Date() during render.
  const relativeTime = useCallback(
    (savedAt: string, nowMs: number): string => {
      const ms = parseSavedMs(savedAt);
      const diff = nowMs - ms;
      const d = new Date(ms);
      const now = new Date(nowMs);
      if (diff < 3_600_000) return t('aiCareer.timeJustNow');
      if (now.toDateString() === d.toDateString()) return t('aiCareer.timeToday');
      if (new Date(nowMs - 86_400_000).toDateString() === d.toDateString())
        return t('aiCareer.timeYesterday');
      const days = Math.floor(diff / 86_400_000);
      if (days < 7) return t('aiCareer.timeDaysAgo').replace('{days}', String(days));
      return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    },
    [t, locale]
  );

  const toRows = useCallback(
    (list: SavedSession[], nowMs: number): Row[] =>
      list.map((s) => ({ ...s, rel: relativeTime(s.saved_at, nowMs) })),
    [relativeTime]
  );

  // Load the first page for the current family/refresh. The reset is expressed
  // by the derived `stale` flag + a fresh fetch — no synchronous setState here.
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    // Hold the skeleton for a short minimum so a refresh is visibly "loading"
    // even for families that return instantly (few / unchanged sessions).
    const minDelay = new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    Promise.all([aiCareerFamilyHistory(selectedFamily, 0, PAGE), minDelay])
      .then(([list]) => {
        if (cancelled) return;
        setRows(toRows(list, now));
        offsetRef.current = list.length;
        setHasMore(list.length === PAGE);
        setLoadedKey(currentKey);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setHasMore(false);
        setLoadedKey(currentKey);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFamily, currentKey, toRows]);

  const loadMore = useCallback(() => {
    if (loadingMore || stale || !hasMore) return;
    setLoadingMore(true);
    const now = Date.now();
    aiCareerFamilyHistory(selectedFamily, offsetRef.current, PAGE)
      .then((list) => {
        setRows((prev) => [...prev, ...toRows(list, now)]);
        offsetRef.current += list.length;
        setHasMore(list.length === PAGE);
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  }, [selectedFamily, loadingMore, stale, hasMore, toRows]);

  useEffect(() => {
    if (stale || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [stale, hasMore, loadMore, rows.length]);

  // Copy the session's on-disk file path to the clipboard (like Coffee CLI's
  // copy-path button), with a brief Copy → Check confirmation on the row.
  const handleCopy = (e: React.MouseEvent, id: string, path: string | null) => {
    e.stopPropagation();
    if (!path) return;
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => {});
  };

  // First load / switching family / refreshing → skeleton rows (no text).
  if (stale) {
    return (
      <div className="h-full overflow-y-auto slim-scroll pr-1 pb-5 space-y-2">
        {SKELETON_WIDTHS.map((w, i) => (
          <SkeletonRow key={i} w={w} />
        ))}
      </div>
    );
  }

  // Empty (centered, matching the App Manager panel's style).
  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-cyber-text-secondary text-center">{t('aiCareer.noSessions')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto slim-scroll pr-1 pb-5 space-y-2">
      {rows.map((session) => {
        const meta = session.turn_count
          ? `${session.rel} · ${t('aiCareer.messages').replace('{count}', String(session.turn_count))}`
          : session.rel;
        return (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            title={t('aiCareer.openChat')}
            onClick={() =>
              setOpenTarget({
                family: session.tool,
                familyName: familyNames[session.tool],
                session,
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                setOpenTarget({
                  family: session.tool,
                  familyName: familyNames[session.tool],
                  session,
                });
              }
            }}
            className="group flex items-center gap-2 rounded-lg border border-cyber-border/40 bg-cyber-text/[0.02] px-3 py-2.5 hover:bg-cyber-text/[0.06] hover:border-cyber-border/80 cursor-pointer transition-colors outline-none"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-cyber-text truncate">{session.name}</div>
              <div className="text-[11px] text-cyber-text-secondary truncate mt-0.5">{meta}</div>
            </div>
            {session.file_path && (
              <button
                type="button"
                aria-label={t('aiCareer.copyPath')}
                onClick={(e) => handleCopy(e, session.id, session.file_path)}
                className="flex-shrink-0 p-1.5 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 opacity-0 group-hover:opacity-100 transition-all"
              >
                {copiedId === session.id ? (
                  <Check size={14} className="text-cyber-accent" />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            )}
            <MessageSquareText
              size={13}
              className="flex-shrink-0 text-cyber-text-muted opacity-0 group-hover:opacity-100 transition-all"
            />
          </div>
        );
      })}

      {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}

      {/* Loading more → a few skeleton rows at the tail. */}
      {loadingMore &&
        SKELETON_WIDTHS.slice(0, 3).map((w, i) => <SkeletonRow key={`more-${i}`} w={w} />)}

      {/* Chat transcript popup when a session row is clicked. */}
      {openTarget && (
        <TranscriptViewerDialog target={openTarget} onClose={() => setOpenTarget(null)} />
      )}
    </div>
  );
}
