// "我的AI生涯" center page — editable avatar, five activity stats, the
// contribution heatmap, and the family cards (built-ins + custom families,
// served by the backend). The three blocks (stats, heatmap, cards) all span
// the same row width so they line up. Selecting a family card drives the
// right panel (AiCareerPanel) via the shared store.
//
// Family management lives here too: the trailing "+" tile opens the add-family
// dialog; each card can be hidden (drops out of stats/heatmap/history, easily
// undone from the 已隐藏 chips) and custom families can be deleted for real.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, History, Plus, RefreshCw, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '../../hooks/useI18n';
import { useAiCareerStore } from '../../stores/aiCareerStore';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  aiCareerDeleteFamily,
  aiCareerGetFamilies,
  aiCareerHeatmap,
  aiCareerSetFamilyHidden,
  aiCareerTokenBytes,
  getAvatar,
  setAvatar,
  type CareerFamily,
} from '../../api/aiCareer';
import {
  deriveStats,
  entriesToBuckets,
  formatCompact,
  TOKENS_PER_BYTE,
  type DayBuckets,
} from './heatmapData';
import { FamilyIcon, FamilyManageDialog, HiddenFamiliesDialog } from './FamilyManageDialog';
import { ContributionHeatmap } from './ContributionHeatmap';
import { DayDetailDialog } from './DayDetailDialog';
import { HistoryDialog } from './HistoryDialog';

// Hidden families render as up to this many inline restore chips; more than
// that collapses into a count badge that opens the restore dialog.
const MAX_INLINE_HIDDEN = 3;

const EMPTY_BUCKETS: DayBuckets = { messages: new Map(), sessions: new Map() };

// Default avatar — a small (320px, ~32KB WebP) image bundled in public/, so it
// shows instantly offline with no network/CDN dependency. Replaced by the
// user's own image once they pick one.
const DEFAULT_AVATAR = '/default-avatar.webp';

export function AiCareerMain() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const selectedFamily = useAiCareerStore((s) => s.selectedFamily);
  const setSelectedFamily = useAiCareerStore((s) => s.setSelectedFamily);
  const setFamilyNames = useAiCareerStore((s) => s.setFamilyNames);
  const refreshKey = useAiCareerStore((s) => s.refreshKey);
  const refresh = useAiCareerStore((s) => s.refresh);
  const setRefreshing = useAiCareerStore((s) => s.setRefreshing);

  const [families, setFamilies] = useState<CareerFamily[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [buckets, setBuckets] = useState<DayBuckets>(EMPTY_BUCKETS);
  const [avatar, setAvatarUrl] = useState<string | null>(null);
  const [tokenBytes, setTokenBytes] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; fam: CareerFamily } | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [dayDetail, setDayDetail] = useState<string | null>(null);
  // The history dialog — remembers which family the user right-clicked so it
  // can preselect that family's sessions.
  const [history, setHistory] = useState<{ family: string } | null>(null);

  const visibleFamilies = useMemo(() => families.filter((f) => !f.hidden), [families]);
  const hiddenFamilies = useMemo(() => families.filter((f) => f.hidden), [families]);

  // Family list — fetched on mount + whenever the refresh button bumps
  // refreshKey (a hide/delete/add also bumps it). While we're here, make sure
  // the selected family is still a visible one (it may have been hidden or
  // deleted elsewhere).
  useEffect(() => {
    let cancelled = false;
    aiCareerGetFamilies()
      .then((list) => {
        if (cancelled) return;
        setFamilies(list);
        const visible = list.filter((f) => !f.hidden);
        // Let the right panel / transcript popups label sessions by name.
        const names: Record<string, string> = {};
        for (const f of list) names[f.id] = f.name;
        setFamilyNames(names);
        const current = useAiCareerStore.getState().selectedFamily;
        if (visible.length > 0 && !visible.some((f) => f.id === current)) {
          setSelectedFamily(visible[0].id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey, setSelectedFamily, setFamilyNames]);

  // Heatmap + stats — fetched on mount and whenever the refresh button bumps
  // refreshKey, re-scanning disk for new sessions/messages. Hidden families
  // are already excluded server-side.
  useEffect(() => {
    let cancelled = false;
    aiCareerHeatmap()
      .then((entries) => {
        if (!cancelled) setBuckets(entriesToBuckets(entries));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    aiCareerTokenBytes()
      .then((b) => {
        if (!cancelled) setTokenBytes(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey, setRefreshing]);

  // Avatar — loaded once.
  useEffect(() => {
    getAvatar()
      .then(setAvatarUrl)
      .catch(() => {});
  }, []);

  const stats = useMemo(() => deriveStats(buckets), [buckets]);

  const handleEditAvatar = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (typeof picked !== 'string') return;
      await setAvatar(picked);
      setAvatarUrl(await getAvatar());
    } catch {
      /* user cancelled or the file wasn't a decodable image */
    }
  }, []);

  const hideFamily = useCallback(
    async (id: string) => {
      try {
        await aiCareerSetFamilyHidden(id, true);
      } catch {
        /* surface nothing — the card stays put */
      } finally {
        refresh();
      }
    },
    [refresh]
  );

  const unhideFamily = useCallback(
    async (id: string) => {
      try {
        await aiCareerSetFamilyHidden(id, false);
      } catch {
        /* ignore */
      } finally {
        refresh();
      }
    },
    [refresh]
  );

  const deleteFamily = useCallback(
    async (fam: CareerFamily) => {
      const ok = await confirm({
        title: t('aiCareer.delete'),
        message: t('aiCareer.confirmDelete').replace('{name}', fam.name),
        confirmText: t('aiCareer.delete'),
        cancelText: t('btn.cancel'),
        type: 'danger',
      });
      if (!ok) return;
      try {
        await aiCareerDeleteFamily(fam.id);
      } catch {
        /* keep the card */
      } finally {
        refresh();
      }
    },
    [confirm, refresh, t]
  );

  const handleFamilyContextMenu = useCallback(
    (e: React.MouseEvent, fam: CareerFamily) => {
      e.preventDefault();
      // Select the family too, so follow-up actions (delete / future history
      // dialog) start from this card.
      setSelectedFamily(fam.id);
      setCtxMenu({ x: e.clientX, y: e.clientY, fam });
    },
    [setSelectedFamily]
  );

  const estTokens = Math.round(tokenBytes * TOKENS_PER_BYTE);
  const statCards: ReadonlyArray<{ label: string; value: string }> = [
    { label: t('aiCareer.stat.sessions'), value: formatCompact(stats.totalSessions) },
    { label: t('aiCareer.stat.messages'), value: formatCompact(stats.totalMessages) },
    { label: t('aiCareer.stat.tokens'), value: formatCompact(estTokens) },
    { label: t('aiCareer.stat.activeDays'), value: formatCompact(stats.activeDays) },
    { label: t('aiCareer.stat.longestStreak'), value: formatCompact(stats.longestStreak) },
  ];

  return (
    <div className="max-w-3xl mx-auto min-h-full flex flex-col items-center justify-center gap-10 py-2">
      {/* Avatar — defaults to the app icon; click the avatar itself to pick a
          local image (stored as ~/.echobird/avatar.png). No edit-icon / tooltip
          chrome by design; a subtle hover dim hints it's clickable. */}
      <button type="button" onClick={handleEditAvatar} className="group cursor-pointer">
        <div className="w-40 h-40 rounded-full overflow-hidden border border-cyber-border/60 bg-cyber-surface flex items-center justify-center transition-opacity group-hover:opacity-85">
          <img
            src={avatar || DEFAULT_AVATAR}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.src.endsWith('/brand/bird.png')) img.src = '/brand/bird.png';
            }}
          />
        </div>
      </button>
      {/* Five activity stats */}
      <div className="grid grid-cols-5 gap-3 w-full">
        {statCards.map((c) => (
          <div
            key={c.label}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-cyber-border/40 bg-cyber-surface px-2 py-4"
          >
            <span className="text-3xl font-bold text-cyber-text tabular-nums">{c.value}</span>
            <span className="text-xs text-cyber-text-secondary text-center leading-tight">
              {c.label}
            </span>
          </div>
        ))}
      </div>
      {/* Contribution heatmap — full row width, lines up with the stats above.
          Clicking an active day opens the per-hour activity popup. */}
      <div className="w-full">
        <ContributionHeatmap
          buckets={buckets}
          onDayClick={(date, count) => {
            if (count > 0) setDayDetail(date);
          }}
        />
      </div>
      {/* Family cards — 3 per row, inheriting the Model Nexus / App Manager
          grid rhythm. Selecting one drives the right-side session list. The
          trailing "+" tile opens the add-family dialog. Hover a card for the
          hide (and, for custom families, delete) actions. */}
      <div className="w-full space-y-3">
        <div className="grid grid-cols-3 gap-3 w-full">
          {visibleFamilies.map((f) => {
            const selected = selectedFamily === f.id;
            return (
              <div
                key={f.id}
                onContextMenu={(e) => handleFamilyContextMenu(e, f)}
                className={`group relative flex items-center gap-2.5 p-4 border bg-cyber-surface rounded-card transition-colors ${
                  selected ? 'border-cyber-accent' : 'border-transparent hover:bg-cyber-elevated'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedFamily(f.id)}
                  className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                >
                  <FamilyIcon icon={f.icon} name={f.name} />
                  <span className="text-[15px] font-medium whitespace-nowrap text-cyber-text">
                    {f.name} {t('aiCareer.familySuffix')}
                  </span>
                </button>
                {/* Hover actions — hide (all) / delete (custom only) */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    aria-label={t('aiCareer.hide')}
                    title={t('aiCareer.hide')}
                    onClick={() => hideFamily(f.id)}
                    className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
                  >
                    <EyeOff size={13} />
                  </button>
                  {!f.builtin && (
                    <button
                      type="button"
                      aria-label={t('aiCareer.delete')}
                      title={t('aiCareer.delete')}
                      onClick={() => deleteFamily(f)}
                      className="p-1 rounded-md text-cyber-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add family tile */}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center justify-center gap-2 p-4 border border-dashed border-cyber-border/60 rounded-card text-cyber-text-secondary hover:text-cyber-accent hover:border-cyber-accent/60 hover:bg-cyber-accent/5 transition-colors"
          >
            <Plus size={16} />
            <span className="text-[15px] font-medium">{t('aiCareer.addFamily')}</span>
          </button>
        </div>

        {/* Hidden families — up to MAX_INLINE_HIDDEN restore chips; more
            collapses into a count badge that opens the restore dialog. */}
        {hiddenFamilies.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap pt-1 px-1">
            <span className="text-[11px] font-mono font-bold tracking-wider text-cyber-text-muted uppercase flex-shrink-0">
              {t('aiCareer.hidden')}
            </span>
            {hiddenFamilies.slice(0, MAX_INLINE_HIDDEN).map((f) => (
              <button
                key={f.id}
                type="button"
                title={t('aiCareer.unhide')}
                onClick={() => unhideFamily(f.id)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full border border-cyber-border/50 bg-cyber-text/[0.03] text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
              >
                <RotateCcw size={11} />
                <span className="max-w-[8rem] truncate">{f.name}</span>
              </button>
            ))}
            {hiddenFamilies.length > MAX_INLINE_HIDDEN && (
              <button
                type="button"
                onClick={() => setHiddenOpen(true)}
                aria-label={`${t('aiCareer.hidden')} (${hiddenFamilies.length})`}
                className="flex items-center justify-center min-w-7 h-7 px-2 rounded-full bg-cyber-accent/15 text-cyber-accent text-xs font-bold hover:bg-cyber-accent/25 transition-colors outline-none"
              >
                {hiddenFamilies.length}
              </button>
            )}
          </div>
        )}
      </div>
      <FamilyManageDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={refresh} />
      {/* Day activity popup — per-hour requests + approx tokens. */}
      {dayDetail && <DayDetailDialog date={dayDetail} onClose={() => setDayDetail(null)} />}

      {/* Hidden-families dialog (restore all / per-item restore, delete for
          custom families) — reached from the count badge. */}
      <HiddenFamiliesDialog
        open={hiddenOpen}
        families={hiddenFamilies}
        onClose={() => setHiddenOpen(false)}
        onRestore={(id) => unhideFamily(id)}
        onRestoreAll={async () => {
          // Restore sequentially — each call rewrites the shared registry, so
          // concurrent calls would race and drop flags (see backend lock too).
          const ids = hiddenFamilies.map((f) => f.id);
          setHiddenOpen(false);
          for (const id of ids) {
            try {
              await aiCareerSetFamilyHidden(id, false);
            } catch {
              /* keep going with the rest */
            }
          }
          refresh();
        }}
        onDelete={(fam) => deleteFamily(fam)}
      />

      {/* Right-click menu on a family card: view history / hide / delete. */}
      {ctxMenu && (
        <FamilyContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          family={ctxMenu.fam}
          onClose={() => setCtxMenu(null)}
          onHistory={() => {
            setCtxMenu(null);
            setHistory({ family: ctxMenu.fam.id });
          }}
          onHide={() => {
            setCtxMenu(null);
            hideFamily(ctxMenu.fam.id);
          }}
          onDelete={() => {
            setCtxMenu(null);
            deleteFamily(ctxMenu.fam);
          }}
        />
      )}

      {/* Multi-family history dialog (查看历史记录). */}
      {history && (
        <HistoryDialog
          families={visibleFamilies}
          initialFamily={history.family}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

// Title-bar refresh button (rendered by App.tsx in the page-title actions
// slot, like AI 资讯 / 明星项目). Bumps the store's refreshKey to re-scan.
export function AiCareerTitleActions() {
  const { t } = useI18n();
  const refresh = useAiCareerStore((s) => s.refresh);
  const refreshing = useAiCareerStore((s) => s.refreshing);
  return (
    <button
      type="button"
      onClick={refresh}
      disabled={refreshing}
      className={`text-sm px-3 py-1.5 border rounded-md transition-colors flex items-center gap-2 ${
        !refreshing
          ? 'border-cyber-border/50 text-cyber-text hover:bg-cyber-text/10'
          : 'border-cyber-border text-cyber-text-muted cursor-not-allowed'
      }`}
    >
      <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
      {t('btn.refresh')}
    </button>
  );
}

// Right-click menu for a family card. Mirrors the DesktopContextMenu chrome:
// fixed overlay that swallows the webview's native menu, clamped to the
// viewport, dismissed on Escape / outside pointer press.
function FamilyContextMenu({
  x,
  y,
  family,
  onClose,
  onHistory,
  onHide,
  onDelete,
}: {
  x: number;
  y: number;
  family: CareerFamily;
  onClose: () => void;
  onHistory: () => void;
  onHide: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport after mount (menu size is known then).
  useEffect(() => {
    const el = menuRef.current;
    const w = el?.offsetWidth || 220;
    const h = el?.offsetHeight || 150;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y]);

  // Dismiss on Escape or any pointer press outside the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[9600]" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={menuRef}
        role="menu"
        className="fixed min-w-[232px] max-w-[280px] py-1.5 rounded-xl border border-cyber-border bg-cyber-surface shadow-2xl overflow-hidden"
        style={{ left: pos.left, top: pos.top }}
      >
        {/* Header: icon + family name */}
        <div className="flex items-center gap-2 px-3.5 py-2">
          <FamilyIcon icon={family.icon} name={family.name} />
          <span className="min-w-0 truncate text-[13px] font-bold text-cyber-text">
            {family.name}
          </span>
        </div>
        <div className="mx-3 my-1 border-t border-cyber-border/60" />

        <button
          role="menuitem"
          onClick={onHistory}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-left text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
        >
          <History size={15} className="flex-shrink-0" />
          <span>{t('aiCareer.historyView')}</span>
        </button>

        <button
          role="menuitem"
          onClick={onHide}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-left text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
        >
          <EyeOff size={15} className="flex-shrink-0" />
          <span>{t('aiCareer.hide')}</span>
        </button>

        {!family.builtin && (
          <button
            role="menuitem"
            onClick={onDelete}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-left text-red-400 hover:bg-red-500/10 transition-colors outline-none"
          >
            <XCircle size={15} className="flex-shrink-0" />
            <span>{t('aiCareer.delete')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
