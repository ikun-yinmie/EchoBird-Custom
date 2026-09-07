// "查看历史记录" dialog for 我的AI生涯. Right-clicking a family card opens
// it with THAT family preselected; chips add / drop other families and "清空"
// clears the selection (empty = every visible family on the backend). The
// toolbar combines a keyword (matched against titles AND chat bodies) with a
// date range — the "综合搜索".
//
// Results page in with CURSOR-based infinite scroll: each request continues
// where the previous page stopped (per-family consumed counts echoed back),
// so scrolling to the bottom never re-scans sessions earlier pages already
// walked past. Clicking a hit opens the full chat (TranscriptViewerDialog).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Folder,
  Loader2,
  Maximize,
  MessageSquareText,
  Minimize,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import {
  aiCareerSearchHistory,
  aiCareerSyncHistory,
  type CareerFamily,
  type HistoryHit,
  type HistorySyncResult,
  type HistorySyncScope,
} from '../../api/aiCareer';
import { FamilyIcon } from './FamilyManageDialog';
import { DatePickerField } from './DatePickerField';
import { TranscriptViewerDialog, type TranscriptTarget } from './TranscriptViewerDialog';
import { useDialogZoom, ZOOM_ENLARGED, ZOOM_FILL } from './useDialogZoom';

interface Props {
  /// Visible families to offer (hidden ones are already excluded upstream).
  families: CareerFamily[];
  /// The family the dialog was opened from (preselected).
  initialFamily: string;
  onClose: () => void;
}

/// Hits per page request (scrolling deeper requests the next page).
const PAGE = 100;

/// Epoch ms of a `SavedSession.saved_at` (the backend sends ms or seconds).
function parseSavedMs(savedAt: string): number {
  const parsed = Date.parse(savedAt);
  if (!isNaN(parsed)) return parsed;
  const num = Number(savedAt);
  if (!isNaN(num) && num > 0) return num < 1e11 ? num * 1000 : num;
  return NaN;
}

function toTarget(hit: HistoryHit): TranscriptTarget {
  return { family: hit.family, familyName: hit.family_name, session: hit.session };
}

/// Case-insensitive keyword highlighting (used on the result rows' title and
/// matched snippet). Emits plain spans + `<mark>` segments around every hit.
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      if (i < text.length) parts.push(<span key={key++}>{text.slice(i)}</span>);
      break;
    }
    if (at > i) parts.push(<span key={key++}>{text.slice(i, at)}</span>);
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-amber-400/30 text-inherit px-px">
        {text.slice(at, at + q.length)}
      </mark>
    );
    i = at + q.length;
  }
  return <>{parts}</>;
}

export function HistoryDialog({ families, initialFamily, onClose }: Props) {
  const { t, locale } = useI18n();

  // Preselect the family this dialog was opened from.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(families.some((f) => f.id === initialFamily) ? [initialFamily] : [])
  );
  const [keyword, setKeyword] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hits, setHits] = useState<HistoryHit[]>([]);
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  // Manual sync: scope popover + per-day picker + transient status line
  // (counts affected, day list, duration). `syncing` guards every entry so a
  // pass can never be double-fired.
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncDay, setSyncDay] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  const [syncDays, setSyncDays] = useState<string[]>([]);
  const [openTarget, setOpenTarget] = useState<TranscriptTarget | null>(null);
  // Two-step 放大: default → enlarged → fills the window. The intermediate
  // step is skipped while the whole app window is already maximized, and the
  // 缩小 direction mirrors the steps (fill → enlarged → default).
  const { zoom, zoomIn, zoomOut, atMax, atMin } = useDialogZoom();
  // Group the result list per family × working directory (grouped mode still
  // feeds off the same loaded `hits`; later pages simply grow existing or new
  // groups). Headers default to expanded; `collapsedGroups` remembers which
  // the user folded.
  const [grouped, setGrouped] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Scroll anchor: before a page is fetched we record where the reader is
  // (glued to the bottom, or the topmost visible row + its content offset).
  // After the appended page commits, we restore that spot so the growing
  // list never yanks the reading position.
  const anchorRef = useRef<{ stickBottom: boolean; anchorIndex: number; anchorRel: number } | null>(
    null
  );

  const familyById = useMemo(() => {
    const map = new Map<string, CareerFamily>();
    for (const f of families) map.set(f.id, f);
    return map;
  }, [families]);

  // Group the currently loaded hits by family × working directory. Rows within
  // a group keep their newest-first order; groups sort by family name then
  // directory so the list reads as stable folder blocks as more pages land.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { fam: string; famName: string; cwd: string; rows: { hit: HistoryHit; idx: number }[] }
    >();
    hits.forEach((hit, idx) => {
      const fam = hit.family;
      const famName = hit.family_name || '';
      const cwd = hit.session.cwd?.trim() || '';
      const key = `${fam}\u0001${cwd}`;
      let g = map.get(key);
      if (!g) {
        g = { fam, famName, cwd, rows: [] };
        map.set(key, g);
      }
      g.rows.push({ hit, idx });
    });
    const list = [...map.values()];
    for (const g of list) {
      g.rows.sort(
        (a, b) => parseSavedMs(b.hit.session.saved_at) - parseSavedMs(a.hit.session.saved_at)
      );
    }
    list.sort((a, b) => a.famName.localeCompare(b.famName) || a.cwd.localeCompare(b.cwd));
    return list;
  }, [hits]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGrouped = () => {
    setGrouped((g) => !g);
    setCollapsedGroups(new Set()); // fresh run starts fully expanded
  };

  const baseParams = useCallback(
    (withCursors: boolean) => ({
      family_ids: [...selected],
      query: keyword.trim() || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      limit: PAGE,
      ...(withCursors && Object.keys(cursors).length > 0 ? { cursors } : {}),
    }),
    [selected, keyword, dateFrom, dateTo, cursors]
  );

  // First search: browse the preselected family's latest sessions as soon as
  // the dialog opens. Later searches are triggered by 搜索 / Enter.
  useEffect(() => {
    let cancelled = false;
    aiCareerSearchHistory({ family_ids: [...selected], limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setHits(page.hits);
        setCursors(page.cursors);
        setDone(page.done);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) {
          setSearched(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explicit search (button / Enter): restart from page one with the current
  // filters. Reset the list immediately so the spinner state is visible.
  const runSearch = useCallback(async () => {
    setError('');
    setLoading(true);
    setHits([]);
    setDone(false);
    setCursors({});
    try {
      const page = await aiCareerSearchHistory({
        family_ids: [...selected],
        query: keyword.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        limit: PAGE,
      });
      setHits(page.hits);
      setCursors(page.cursors);
      setDone(page.done);
      setSearched(true);
    } catch (e) {
      setError(String(e));
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [selected, keyword, dateFrom, dateTo]);

  const submit = () => {
    void runSearch();
  };

  const todayISO = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // Open/close the sync popover; default the day picker to the filter's
  // single day when the range is one day, else today.
  const toggleSyncPanel = () => {
    if (!syncOpen) {
      setSyncDay(dateFrom && dateFrom === dateTo ? dateFrom : todayISO());
      setSyncNote('');
      setSyncDays([]);
    }
    setSyncOpen((open) => !open);
  };

  // Compose the completion line: full summary (counts + days + duration) or a
  // plain “done · ms” when there was nothing cached to drop.
  const syncSummaryText = useCallback(
    (res: HistorySyncResult, ms: number) => {
      const total = (res.cleared_bodies ?? 0) + (res.cleared_counts ?? 0) + (res.cleared_days ?? 0);
      const days = res.affected_days?.length ?? 0;
      if (total > 0 || days > 0) {
        return t('aiCareer.historySyncSummary')
          .replace('{count}', String(total))
          .replace('{days}', String(days))
          .replace('{ms}', String(ms));
      }
      return `${t('aiCareer.historySyncOk')} · ${ms} ms`;
    },
    [t]
  );

  // Next page — continues from the cursors of the last page. The reader's
  // spot is anchored first and restored after the appended rows commit.
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || done) return;
    const el = listRef.current;
    const stickBottom = !!el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    // Topmost visible row + its distance from the container's content top
    // (rect-based, so it works regardless of the row's offsetParent).
    const relTop = (c: HTMLElement, box: HTMLElement) =>
      c.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    let anchorIndex = -1;
    let anchorRel = 0;
    if (el && !stickBottom) {
      for (const child of Array.from(el.children)) {
        const c = child as HTMLElement;
        const idx = Number(c.dataset.index ?? '');
        if (!Number.isFinite(idx) || idx < 0) continue;
        if (c.getBoundingClientRect().bottom >= el.getBoundingClientRect().top + 1) {
          anchorIndex = idx;
          anchorRel = relTop(c, el);
          break;
        }
      }
    }
    anchorRef.current = { stickBottom, anchorIndex, anchorRel };
    setLoadingMore(true);
    try {
      const page = await aiCareerSearchHistory(baseParams(true));
      setHits((prev) => [...prev, ...page.hits]);
      setCursors(page.cursors);
      setDone(page.done);
      // Restore the anchored spot once the new rows are in the DOM: scroll by
      // however much the anchor row drifted so it lands back where it was.
      requestAnimationFrame(() => {
        const box = listRef.current;
        const a = anchorRef.current;
        anchorRef.current = null;
        if (!box || !a) return;
        if (a.stickBottom) {
          box.scrollTop = box.scrollHeight;
          return;
        }
        if (a.anchorIndex < 0) return;
        let target: HTMLElement | undefined;
        for (const child of Array.from(box.children)) {
          const c = child as HTMLElement;
          if (Number(c.dataset.index ?? '') === a.anchorIndex) {
            target = c;
            break;
          }
        }
        if (!target) return;
        const nowRel = relTop(target, box);
        box.scrollTop += nowRel - a.anchorRel;
      });
    } catch {
      anchorRef.current = null;
      // A failed page simply stops auto-loading; the list stays usable.
      setDone(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, done, baseParams]);

  // Keyboard: Enter in the keyword field commits; Escape closes (unless the
  // transcript popup is up, which handles its own Escape). Escape first
  // shrinks the dialog one zoom step; further presses close it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openTarget) return;
      if (zoom > 0) zoomOut();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, openTarget, zoom, zoomOut]);

  // Preload: the sentinel sits at the list's end; the observation band is
  // widened ~2 viewport heights BELOW the viewport, so the next page is
  // fetched as soon as the end of the list comes within ~2 screens of the
  // bottom edge — by the time the reader scrolls down, the page is already
  // there (the band expands 200% of the root height: remaining ≤ 2 screens).
  useEffect(() => {
    if (done || loading) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      // 200% of the list height below the viewport bottom ⇒ fire ~2 screens
      // before the reader actually reaches the end.
      { rootMargin: '0px 0px 200% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [done, loading, loadingMore, loadMore, hits.length]);

  const toggleFamily = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Manual sync — drop the selected families' caches and force a fresh
  // first page (whole family, or one local day for the day-level stats).
  // The elapsed time covers the backend pass AND the re-scanned first page.
  const doSync = useCallback(
    async (scope: Exclude<HistorySyncScope, 'session'>, day?: string) => {
      if (syncing) return;
      setSyncing(true);
      setSyncNote('');
      setSyncDays([]);
      const started = Date.now();
      try {
        const res = await aiCareerSyncHistory({
          family_ids: [...selected],
          scope,
          ...(scope === 'day' && day ? { day } : {}),
        });
        setSyncOpen(false);
        await runSearch(); // re-scan from a clean first page
        setSyncDays(res.affected_days ?? []);
        setSyncNote(syncSummaryText(res, Date.now() - started));
      } catch (e) {
        setSyncNote(String(e));
      } finally {
        setSyncing(false);
      }
    },
    [syncing, selected, runSearch, syncSummaryText]
  );

  // Per-row sync — re-read ONE session and swap the refreshed hit in place.
  const syncSession = useCallback(
    async (hit: HistoryHit, idx: number) => {
      if (syncing) return;
      setSyncing(true);
      setSyncNote('');
      setSyncDays([]);
      const started = Date.now();
      try {
        const res = await aiCareerSyncHistory({
          family_ids: [hit.family],
          scope: 'session',
          query: keyword.trim() || undefined,
          file_path: hit.session.file_path ?? undefined,
          session_token: hit.session.session_token ?? undefined,
        });
        const cleared = res.cleared_bodies + res.cleared_counts + res.cleared_days;
        const refreshed = res.hit;
        if (refreshed) {
          // Replace the row in place — its anchor stays put.
          setHits((prev) => prev.map((h, i) => (i === idx ? refreshed : h)));
        } else if (cleared > 0) {
          // The session can no longer be read — drop the row.
          setHits((prev) => prev.filter((_, i) => i !== idx));
        }
        if (refreshed || cleared > 0) {
          setSyncNote(syncSummaryText(res, Date.now() - started));
        }
      } catch (e) {
        setSyncNote(String(e));
      } finally {
        setSyncing(false);
      }
    },
    [syncing, keyword, syncSummaryText]
  );

  const selectAll = () => setSelected(new Set(families.map((f) => f.id)));
  const clearAll = () => setSelected(new Set());

  const toggleAll = selected.size === families.length && families.length > 0 ? clearAll : selectAll;

  const dateLabel = (hit: HistoryHit): string => {
    const ms = parseSavedMs(hit.session.saved_at);
    if (isNaN(ms)) return '';
    return new Date(ms).toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  // One result row (used by both the flat list and group contents).
  const rowView = (hit: HistoryHit, idx: number) => {
    const fam = familyById.get(hit.family);
    const metaBits = [hit.family_name, dateLabel(hit)];
    if (hit.match_count > 0) {
      metaBits.push(t('aiCareer.historyMatchCount').replace('{count}', String(hit.match_count)));
    }
    return (
      <div key={`${hit.family}\u0001${hit.session.id}`} data-index={idx} className="relative group">
        <button
          type="button"
          onClick={() => setOpenTarget(toTarget(hit))}
          title={t('aiCareer.openChat')}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 pr-9 rounded-lg border border-cyber-border/40 bg-cyber-text/[0.02] hover:border-cyber-border/80 hover:bg-cyber-text/[0.05] transition-colors text-left"
        >
          <div className="flex-shrink-0">
            <FamilyIcon icon={fam?.icon ?? 'default'} name={hit.family_name} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-cyber-text truncate">
              <Highlighted text={hit.session.name} query={keyword} />
            </div>
            <div className="text-[11px] text-cyber-text-secondary truncate mt-0.5">
              {metaBits.filter(Boolean).join(' · ')}
            </div>
            {hit.snippet && (
              <div className="text-[11px] text-cyber-text-muted italic truncate mt-0.5">
                <Highlighted text={hit.snippet} query={keyword} />
              </div>
            )}
          </div>
          <ChevronRight size={14} className="flex-shrink-0 text-cyber-text-muted" />
        </button>
        {/* Per-row manual sync: re-read this session from disk. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void syncSession(hit, idx);
          }}
          disabled={syncing}
          title={t('aiCareer.historySyncSessionTip')}
          aria-label={t('aiCareer.historySyncSessionTip')}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-cyber-text-muted opacity-0 group-hover:opacity-100 hover:text-cyber-accent hover:bg-cyber-accent/10 disabled:opacity-30 disabled:hover:text-cyber-text-muted disabled:hover:bg-transparent transition-all focus:opacity-100"
        >
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
    );
  };

  const dateRangeActive = dateFrom || dateTo;
  const hasAnyFilter = keyword.trim().length > 0 || dateRangeActive;

  const panelClass =
    zoom === 2
      ? ZOOM_FILL
      : zoom === 1
        ? ZOOM_ENLARGED
        : 'relative w-[860px] max-w-[95vw] h-[82vh] flex flex-col rounded-xl border border-cyber-border/40 bg-cyber-surface shadow-2xl overflow-hidden';

  return (
    <div className="fixed inset-0 z-[9600] flex items-center justify-center">
      {zoom < 2 && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      )}
      <div
        role="dialog"
        aria-label={t('aiCareer.historyTitle')}
        onContextMenu={(e) => e.preventDefault()}
        className={panelClass}
      >
        <div className="h-[2px] w-full bg-cyber-accent/60 flex-shrink-0" />

        {/* Header */}
        <div
          className={`flex items-center justify-between pt-4 pb-3 border-b border-cyber-border/60 flex-shrink-0 ${
            zoom > 0 ? 'px-8' : 'px-5'
          }`}
        >
          <span className="text-sm font-mono font-bold tracking-wider text-cyber-text">
            {t('aiCareer.historyTitle')}
          </span>
          <div className="flex items-center gap-1">
            {/* 放大: normal → enlarged → fill (skips the middle step while the
                whole app window is already maximized). */}
            <button
              type="button"
              onClick={zoomIn}
              disabled={atMax}
              aria-label={t('aiCareer.zoomIn')}
              title={t('aiCareer.zoomIn')}
              className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors disabled:opacity-30 disabled:hover:text-cyber-text-muted disabled:hover:bg-transparent"
            >
              <Maximize size={16} />
            </button>
            {/* 缩小: mirrors the enlarge steps (fill → enlarged → default). */}
            <button
              type="button"
              onClick={zoomOut}
              disabled={atMin}
              aria-label={t('aiCareer.zoomOut')}
              title={t('aiCareer.zoomOut')}
              className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors disabled:opacity-30 disabled:hover:text-cyber-text-muted disabled:hover:bg-transparent"
            >
              <Minimize size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('btn.close')}
              className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div
          className={`flex-shrink-0 pt-4 pb-3 border-b border-cyber-border/60 space-y-3 ${
            zoom > 0 ? 'px-8' : 'px-5'
          }`}
        >
          {/* Family multi-select chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {families.map((f) => {
              const on = selected.has(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleFamily(f.id)}
                  title={on ? `${f.name} ✓` : f.name}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                    on
                      ? 'border-cyber-accent/70 bg-cyber-accent/10 text-cyber-text'
                      : 'border-cyber-border/40 text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/5 opacity-70'
                  }`}
                >
                  <FamilyIcon icon={f.icon} name={f.name} />
                  <span className="max-w-[7rem] truncate">{f.name}</span>
                  {on && <span className="text-cyber-accent text-[9px]">✓</span>}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={toggleAll}
                className="px-2 py-1 rounded-md text-[11px] font-mono font-bold tracking-wider text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
              >
                {selected.size === families.length && families.length > 0
                  ? t('aiCareer.historyNone')
                  : t('aiCareer.historyAll')}
              </button>
            </div>
          </div>
          {selected.size === 0 && (
            <p className="text-[11px] text-cyber-warning leading-relaxed">
              {t('aiCareer.historyAllHint')}
            </p>
          )}

          {/* Keyword + date range (综合搜索) */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cyber-text-muted pointer-events-none"
              />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder={t('aiCareer.historyKeywordPlaceholder')}
                className="w-full pl-8 pr-3 py-2 text-[13px] bg-cyber-elevated border border-cyber-border/50 rounded-lg text-cyber-text placeholder:text-cyber-text-muted outline-none focus:border-cyber-accent/60 transition-colors"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <CalendarRange size={13} className="text-cyber-text-muted" />
              {/* Start date — capped by the end date (and never the future). */}
              <DatePickerField
                value={dateFrom}
                onChange={setDateFrom}
                placeholder={t('aiCareer.historyDateFrom')}
                title={t('aiCareer.historyDateFrom')}
                maxDate={dateTo || undefined}
                className="w-[8.25rem]"
              />
              <span className="text-[11px] text-cyber-text-muted">–</span>
              {/* End date — floored by the start date. */}
              <DatePickerField
                value={dateTo}
                onChange={setDateTo}
                placeholder={t('aiCareer.historyDateTo')}
                title={t('aiCareer.historyDateTo')}
                minDate={dateFrom || undefined}
                className="w-[8.25rem]"
              />
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-cyber-accent/60 text-cyber-accent text-xs font-mono font-bold tracking-wider hover:bg-cyber-accent/10 disabled:opacity-50 transition-colors flex-shrink-0"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              {t('aiCareer.historySearchBtn')}
            </button>
            <button
              type="button"
              onClick={toggleSyncPanel}
              disabled={syncing}
              title={t('aiCareer.historySync')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono font-bold tracking-wider transition-colors flex-shrink-0 ${
                syncOpen
                  ? 'border-cyber-accent/80 bg-cyber-accent/10 text-cyber-accent'
                  : 'border-cyber-border/50 text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/5'
              }`}
            >
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {t('aiCareer.historySync')}
            </button>
          </div>

          {/* Manual-sync popover: whole family or one day */}
          {syncOpen && (
            <div className="rounded-lg border border-cyber-border/50 bg-cyber-elevated/80 p-3 space-y-2 text-[12px]">
              <button
                type="button"
                onClick={() => void doSync('all')}
                disabled={syncing}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-cyber-border/50 text-cyber-text hover:bg-cyber-text/5 disabled:opacity-50 transition-colors text-left"
              >
                <span>{t('aiCareer.historySyncAll')}</span>
                <RefreshCw size={12} className="text-cyber-text-muted flex-shrink-0" />
              </button>
              <div className="flex items-center gap-2">
                <span className="text-cyber-text-secondary flex-shrink-0">
                  {t('aiCareer.historySyncDay')}
                </span>
                <DatePickerField
                  value={syncDay}
                  onChange={(v) => setSyncDay(v)}
                  placeholder={t('aiCareer.historySyncDate')}
                  title={t('aiCareer.historySyncDate')}
                  className="flex-1 min-w-0"
                />
                <button
                  type="button"
                  onClick={() => void doSync('day', syncDay)}
                  disabled={syncing || !syncDay}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyber-accent/60 text-cyber-accent text-xs font-mono font-bold tracking-wider hover:bg-cyber-accent/10 disabled:opacity-50 transition-colors flex-shrink-0"
                >
                  {syncing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  {t('aiCareer.historySyncExec')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-shrink-0 flex items-center gap-2 px-5 py-2 text-[11px] text-cyber-text-muted">
            <span>{t('aiCareer.historyCount').replace('{count}', String(hits.length))}</span>
            {hasAnyFilter && searched && hits.length > 0 && !done && (
              <span className="text-cyber-text-secondary/70">
                · {t('aiCareer.historyMoreHint')}
              </span>
            )}
            {loading && (
              <span className="flex items-center gap-1 text-cyber-accent">
                <Loader2 size={11} className="animate-spin" />
                {t('aiCareer.historySearching')}
              </span>
            )}
            {syncNote && (
              <span className="flex flex-col items-end gap-0.5 min-w-0 text-right">
                <span className="text-cyber-accent/90 truncate w-full text-right" title={syncNote}>
                  {syncNote}
                </span>
                {syncDays.length > 0 && (
                  <span
                    className="text-[10px] text-cyber-text-secondary/80 truncate w-full text-right"
                    title={syncDays.join(' · ')}
                  >
                    {t('aiCareer.historySyncDaysLabel')}:{` ${syncDays.slice(0, 12).join(' · ')}`}
                    {syncDays.length > 12 ? ' …' : ''}
                  </span>
                )}
              </span>
            )}
            {/* Toggle the flat newest-first list into per-family × working-dir
                group blocks (rows inside a group stay newest-first). */}
            <button
              type="button"
              onClick={toggleGrouped}
              aria-pressed={grouped}
              title={t('aiCareer.historyGroupByCwd')}
              className={`ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-mono font-bold tracking-wider transition-colors flex-shrink-0 ${
                grouped
                  ? 'border-cyber-accent/70 bg-cyber-accent/10 text-cyber-accent'
                  : 'border-cyber-border/40 text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/5'
              }`}
            >
              <Folder size={11} />
              {t('aiCareer.historyGroupByCwd')}
            </button>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto pulse-scroll px-3 pb-3 space-y-1">
            {loading && hits.length === 0 && !error && (
              <div className="flex items-center justify-center gap-2 py-14 text-cyber-text-secondary text-sm">
                <Loader2 size={16} className="animate-spin" />
                <span>{t('aiCareer.historySearching')}</span>
              </div>
            )}
            {!loading && searched && hits.length === 0 && !error && (
              <div className="flex flex-col items-center gap-2 py-14 text-cyber-text-secondary text-sm">
                <MessageSquareText size={22} className="opacity-60" />
                <span>{t('aiCareer.historyNoResults')}</span>
              </div>
            )}
            {!loading && error && (
              <p className="text-xs text-red-400 py-8 text-center break-all px-4">{error}</p>
            )}
            {!loading &&
              (grouped
                ? /* Grouped mode: per-family × working-directory blocks. */
                  groups.map((g) => {
                    const key = `${g.fam}\u0001${g.cwd}`;
                    const collapsed = collapsedGroups.has(key);
                    const fam = familyById.get(g.fam);
                    const newestLabel = dateLabel(g.rows[0].hit);
                    return (
                      <div
                        key={key}
                        className="rounded-lg border border-cyber-border/30 bg-cyber-text/[0.02] overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => toggleGroup(key)}
                          aria-expanded={!collapsed}
                          className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-cyber-text/[0.04] transition-colors"
                        >
                          <ChevronDown
                            size={13}
                            className={`flex-shrink-0 text-cyber-text-muted transition-transform ${
                              collapsed ? '-rotate-90' : ''
                            }`}
                          />
                          <span className="flex-shrink-0">
                            <FamilyIcon icon={fam?.icon ?? 'default'} name={g.famName} />
                          </span>
                          <span className="flex items-center gap-1 min-w-0 flex-1">
                            <Folder size={11} className="flex-shrink-0 text-cyber-accent/70" />
                            <span
                              className="text-[12px] text-cyber-text truncate"
                              title={g.cwd || undefined}
                            >
                              {g.cwd || t('aiCareer.historyNoCwd')}
                            </span>
                          </span>
                          <span className="text-[10px] text-cyber-text-muted flex-shrink-0 tabular-nums">
                            {t('aiCareer.historyGroupCount').replace(
                              '{count}',
                              String(g.rows.length)
                            )}
                          </span>
                          {newestLabel && (
                            <span className="text-[10px] text-cyber-text-muted flex-shrink-0 tabular-nums">
                              {newestLabel}
                            </span>
                          )}
                        </button>
                        {!collapsed && (
                          <div className="space-y-1 px-1.5 pb-1.5">
                            {g.rows.map(({ hit, idx }) => rowView(hit, idx))}
                          </div>
                        )}
                      </div>
                    );
                  })
                : hits.map((hit, idx) => rowView(hit, idx)))}

            {/* Infinite-scroll tail — a persistent “more coming” marker so the
                list never looks finished while pages remain: spinning +
                “正在加载更多…” while fetching, a pulsing hint when idle (the
                preload usually fetches ~2 screens early, so the reader sees
                the idle marker until the next page quietly lands). */}
            {!done && !loading && (
              <div
                ref={sentinelRef}
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 py-3 min-h-[2.75rem]"
              >
                {loadingMore ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-cyber-accent">
                    <Loader2 size={12} className="animate-spin" />
                    {t('aiCareer.historyLoadingMore')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[11px] text-cyber-text-muted">
                    <span className="flex gap-0.5">
                      <span className="w-1 h-1 rounded-full bg-cyber-text-muted animate-pulse" />
                      <span
                        className="w-1 h-1 rounded-full bg-cyber-text-muted animate-pulse"
                        style={{ animationDelay: '150ms' }}
                      />
                      <span
                        className="w-1 h-1 rounded-full bg-cyber-text-muted animate-pulse"
                        style={{ animationDelay: '300ms' }}
                      />
                    </span>
                    {t('aiCareer.historyMoreHint')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Transcript popup on top */}
        {openTarget && (
          <TranscriptViewerDialog target={openTarget} onClose={() => setOpenTarget(null)} />
        )}
      </div>
    </div>
  );
}
