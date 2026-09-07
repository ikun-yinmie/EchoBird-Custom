import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  DragOverlay,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Server as ServerIcon,
  Box as BoxIcon,
  Eye,
  EyeOff,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { getModelIcon, EffortPulse } from '../../components';
import { useConfirm } from '../../components/ConfirmDialog';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { IS_WINDOWS } from '../../utils/platform';
import { DesktopContextMenu } from './DesktopContextMenu';
import { useI18n } from '../../hooks/useI18n';
import * as api from '../../api/tauri';
import type { CustomDesktopApp, ModelConfig, LocalTool } from '../../api/types';
import type { TKey } from '../../i18n';
import { useAppManager } from './context';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  getOfficialEndpoint,
  officialModelSentinel,
  type OfficialEndpoint,
} from '../../data/officialEndpoints';

// ===== Title actions (refresh) — mounted in the shared page title bar,
// keeping App Desktop consistent with the other pages =====

export const AppManagerTitleActions: React.FC = () => {
  const { t } = useI18n();
  const { scanTools, isScanning, showUninstalled, setShowUninstalled } = useAppManager();

  return (
    <div className="ml-auto flex-shrink-0 flex items-center gap-2">
      {/* Custom scan paths — opens ~/.echobird/tool-paths.json so users can
          register install locations EchoBird's bundled defaults missed.
          Icon buttons share the refresh button's chrome and height. */}
      <button
        onClick={() => {
          void api.openToolPathsConfig().catch(() => {});
        }}
        aria-label={t('btn.editPaths')}
        className="flex items-center justify-center w-9 h-9 border border-cyber-border/50 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
      >
        <Settings size={16} />
      </button>
      {/* Toggle the "未安装" section on the desktop. Eye = shown, eye-off =
          hidden (accent-tinted border + icon so the collapsed state reads). */}
      <button
        onClick={() => setShowUninstalled(!showUninstalled)}
        aria-label={
          showUninstalled ? t('aiDesktop.hideUninstalled') : t('aiDesktop.showUninstalled')
        }
        className={`flex items-center justify-center w-9 h-9 border rounded-md transition-colors outline-none ${
          showUninstalled
            ? 'border-cyber-border/50 text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10'
            : 'border-cyber-accent/50 text-cyber-accent hover:bg-cyber-accent/10'
        }`}
      >
        {showUninstalled ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
      <button
        onClick={scanTools}
        disabled={isScanning}
        className={`text-sm px-3 py-1.5 border rounded-md transition-colors flex items-center gap-2 outline-none ${
          !isScanning
            ? 'border-cyber-border/50 text-cyber-text hover:bg-cyber-text/10'
            : 'border-cyber-border text-cyber-text-muted cursor-not-allowed'
        }`}
      >
        <RefreshCw size={13} className={isScanning ? 'animate-spin' : ''} />
        {t('btn.refresh')}
      </button>
    </div>
  );
};

// ===== Main Content (App Desktop grid) =====

// Category order for the "未安装" (not installed) grouping. The installed
// section renders flat (no category headers per spec); only the uninstalled
// section groups by category with i18n titles.
const CATEGORY_ORDER = ['Desktop', 'IDE', 'CLI Code', 'Science', 'AutoTrading', 'Game', 'Utility'];

// Within Desktop, keep the fixed display order (Coffee CLI last).
const DESKTOP_ORDER: Record<string, number> = {
  claudedesktop: 0,
  chatgptdesktop: 1,
  geminidesktop: 2,
  coffeecli: 99,
};

const categoryRank = (cat?: string): number => {
  const idx = CATEGORY_ORDER.indexOf(cat || '');
  return idx === -1 ? 99 : idx;
};

// Within-category tiebreaker: Desktop keeps its fixed display order (Coffee
// CLI last); Science keeps OpenScience first (its model-config support is
// solid while Claude Science is macOS/Linux-only with thinner support).
const withinCategoryRank = (tool: LocalTool): number => {
  if (tool.category === 'Desktop') return DESKTOP_ORDER[tool.id] ?? 50;
  if (tool.category === 'Science') return tool.id === 'openscience' ? 0 : 1;
  return 0;
};

// Stable order across the desktop: category rank, then the within-category
// tiebreaker, then name.
const compareTools = (a: LocalTool, b: LocalTool): number => {
  const catDiff = categoryRank(a.category) - categoryRank(b.category);
  if (catDiff !== 0) return catDiff;
  const rankDiff = withinCategoryRank(a) - withinCategoryRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name);
};

const catLabelKey = (cat: string): TKey => {
  const map: Record<string, TKey> = {
    IDE: 'toolCat.ide',
    'CLI Code': 'toolCat.cli',
    AutoTrading: 'toolCat.autoTrading',
    Game: 'toolCat.game',
    Desktop: 'toolCat.desktop',
    Utility: 'toolCat.utility',
    Science: 'toolCat.science',
  };
  return map[cat] || (cat as TKey);
};

// Parent directory of a detected path, for "打开文件位置". Null when the
// detected path is a bare command ("opencode") or module ref ("python -m x")
// with no directory component — the menu item is disabled then.
export const desktopParentDir = (p: string): string | null => {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : null;
};

const HIDDEN_TOOLS_KEY = 'echobird_appmgr_hidden_tools';

// Icons hidden via the right-click "删除图标" item. Same localStorage pattern
// as the drag order above; the app itself stays installed.
export const loadHiddenTools = (): string[] => {
  try {
    const v = localStorage.getItem(HIDDEN_TOOLS_KEY);
    const arr: unknown = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export const saveHiddenTools = (ids: string[]): void => {
  try {
    localStorage.setItem(HIDDEN_TOOLS_KEY, JSON.stringify(ids));
  } catch {
    /* private mode */
  }
};

const DELETED_TOOLS_KEY = 'echobird_appmgr_deleted_tools';

// Tool ids hard-deleted via "删除": gone from the desktop AND the
// hidden row, surviving rescans. Restored manually from the "+" dialog.
export const loadDeletedTools = (): string[] => {
  try {
    const v = localStorage.getItem(DELETED_TOOLS_KEY);
    const arr: unknown = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export const saveDeletedTools = (ids: string[]): void => {
  try {
    localStorage.setItem(DELETED_TOOLS_KEY, JSON.stringify(ids));
  } catch {
    /* private mode */
  }
};

// Default entry name from a picked executable path: file stem without the
// extension ("code.exe" → "code", "/usr/bin/foo" → "foo").
export const customNameFromPath = (p: string): string => {
  const base = p.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  return stem || base;
};

// Localized display name — resolves per-locale `names` like ToolCard, but
// prefers `displayName` when present (the pre-localized label some tools
// carry), then falls back to the plain name.
const toolDisplayName = (tool: LocalTool, locale: string): string => {
  if (tool.displayName) return tool.displayName;
  if (tool.names && locale !== 'en') {
    return (
      tool.names[locale] ||
      tool.names[locale.split('-')[0]] ||
      Object.entries(tool.names).find(([k]) => k.startsWith(locale.split('-')[0]))?.[1] ||
      tool.name
    );
  }
  return tool.name;
};

interface DesktopIconProps {
  tool: LocalTool;
  selected: boolean;
  onClick: () => void;
  /** Right-click menu (installed desktop icons). */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** dnd-kit drag attributes/listeners (sortable tiles only). Applied to the
      button itself so the tile stays a single focusable control instead of
      nesting a button inside a role="button" wrapper. */
  dragProps?: React.HTMLAttributes<HTMLElement>;
}

// A desktop-style launcher tile: icon on top, name beneath. Clicking selects;
// the bottom bar holds the launch / install action. All icons render
// uniformly — which section an app sits in (已安装 / 未安装) tells the state.
const DesktopIcon: React.FC<DesktopIconProps> = ({
  tool,
  selected,
  onClick,
  onContextMenu,
  dragProps,
}) => {
  const { locale } = useI18n();
  const [iconSrc, setIconSrc] = useState<string>(`./icons/tools/${tool.id}.svg`);
  const displayName = toolDisplayName(tool, locale);

  const handleIconError = () => {
    setIconSrc((prev) => {
      if (prev.endsWith('.svg')) return `./icons/tools/${tool.id}.png`;
      if (tool.iconBase64 && prev !== tool.iconBase64) return tool.iconBase64;
      return '';
    });
  };

  return (
    <button
      {...dragProps}
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={displayName}
      className="flex flex-col items-center gap-1.5 px-1.5 py-3 w-full rounded-xl outline-none transition-colors select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-cyber-accent"
    >
      {/* The icon alone is the graphic — no tile background behind it; the
          icon itself renders at the tile size. */}
      <span className="relative flex items-center justify-center">
        {iconSrc ? (
          <img
            src={iconSrc}
            alt=""
            draggable={false}
            onError={handleIconError}
            className="w-14 h-14 object-contain"
          />
        ) : (
          <BoxIcon size={44} className="text-cyber-text-secondary" />
        )}
      </span>
      {/* Name wraps gracefully across up to two lines; the selected tile
          tints its label rather than drawing a highlight box. */}
      <span
        className={`text-xs leading-snug text-center w-full line-clamp-2 break-words ${
          selected ? 'text-cyber-accent' : 'text-cyber-text'
        }`}
      >
        {displayName}
      </span>
    </button>
  );
};

// Sortable wrapper for installed icons — drag to rearrange the desktop.
// The wrapper is the grid item; the tile inside fills it (w-full) so the
// drag handles and the click-to-select behavior stay aligned.
const SortableDesktopIcon: React.FC<DesktopIconProps> = ({
  tool,
  selected,
  onClick,
  onContextMenu,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tool.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // While dragging, fade the item at its sort position into a translucent
    // placeholder — that's the insertion indicator — while the DragOverlay
    // ghost carries the visuals following the cursor.
    opacity: isDragging ? 0.3 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex">
      <DesktopIcon
        tool={tool}
        selected={selected}
        onClick={onClick}
        onContextMenu={onContextMenu}
        dragProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
};

// Hidden row shows at most this many restore chips inline; the overflow
// lives behind the count badge that opens the restore dialog.
export const MAX_INLINE_HIDDEN = 3;

interface HiddenToolsDialogProps {
  tools: LocalTool[];
  onRestore: (id: string) => void;
  /** Hard delete (× badge): gone everywhere, restorable via the "+" dialog. */
  onPermanentDelete: (id: string) => void;
  /** Right-click an icon: restore / delete menu (same delete confirm). */
  onContextMenu: (tool: LocalTool, e: React.MouseEvent) => void;
  /** Batch restore from the header button: every hidden app returns. */
  onRestoreAll: () => void;
  /** Batch hard delete from the header button (confirm handled by caller). */
  onDeleteAll: () => void;
  onClose: () => void;
  t: (key: TKey) => string;
}

// Restore dialog for hidden desktop icons: 7 icons per row, fixed to one
// third of the window height, vertical scroll for the overflow. Left-click
// restores to the desktop; right-click offers restore / delete; the × badge
// hard-deletes; the header offers 全部恢复 / 全部删除 batch actions.
// Right-clicks on empty dialog area are swallowed.
export const HiddenToolsDialog: React.FC<HiddenToolsDialogProps> = ({
  tools,
  onRestore,
  onPermanentDelete,
  onRestoreAll,
  onDeleteAll,
  onContextMenu,
  onClose,
  t,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-label={`${t('desktopMenu.hidden')} (${tools.length})`}
        onContextMenu={(e) => e.preventDefault()}
        className="relative w-[640px] max-w-[92vw] h-[33vh] flex flex-col rounded-xl border border-cyber-border bg-cyber-surface shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-cyber-border/60 flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-bold text-cyber-text flex-shrink-0">
              {t('desktopMenu.hidden')} ({tools.length})
            </span>
            {tools.length > 0 && (
              <>
                <button
                  onClick={onRestoreAll}
                  aria-label={t('desktopMenu.restoreAll')}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold border border-amber-500/70 text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
                >
                  <RotateCcw size={12} />
                  {t('desktopMenu.restoreAll')}
                </button>
                <button
                  onClick={onDeleteAll}
                  aria-label={t('desktopMenu.deleteAll')}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold border border-red-500/80 text-red-400 hover:bg-red-500/15 transition-colors outline-none"
                >
                  <Trash2 size={12} />
                  {t('desktopMenu.deleteAll')}
                </button>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t('btn.cancel')}
            className="flex items-center justify-center w-7 h-7 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
          >
            <X size={16} />
          </button>
        </div>
        {tools.length > 0 && (
          <div className="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 border-b border-cyber-accent/25 bg-cyber-accent/10">
            <MousePointerClick size={15} className="flex-shrink-0 text-cyber-accent" />
            <span className="text-xs font-bold text-cyber-accent">
              {t('desktopMenu.clickToRestore')}
            </span>
          </div>
        )}
        <div className="flex-1 overflow-y-auto pulse-scroll p-3">
          <div className="grid grid-cols-7 gap-2 content-start">
            {tools.map((tool) => (
              <div key={tool.id} className="relative" onContextMenu={(e) => onContextMenu(tool, e)}>
                <DesktopIcon
                  tool={tool}
                  selected={false}
                  onClick={() => onRestore(tool.id)}
                  onContextMenu={(e) => e.preventDefault()}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onPermanentDelete(tool.id);
                  }}
                  aria-label={t('desktopMenu.permanentDelete')}
                  title={t('desktopMenu.permanentDelete')}
                  className="absolute top-1 right-1 flex items-center justify-center w-5 h-5 rounded-full bg-red-500/90 text-white hover:bg-red-500 transition-colors outline-none"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// Custom "+" entries render as plain desktop tiles: launch-only, no model
// config, icon falls back to the box glyph (no bundled svg exists for them).
const customAsTool = (c: CustomDesktopApp): LocalTool => ({
  id: c.id,
  name: c.name,
  displayName: c.name,
  category: 'Custom',
  installed: true,
  detectedPath: c.path,
  noModelConfig: true,
});

// Trailing "+" tile: left-click opens the add dialog. Intentionally NOT
// sortable and NOT right-clickable — it's an action, not an app.
const AddDesktopTile: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button
    onClick={onClick}
    aria-label={label}
    className="flex flex-col items-center gap-1.5 px-1.5 py-3 w-full rounded-xl outline-none transition-colors select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-cyber-accent"
  >
    <span className="flex items-center justify-center w-14 h-14 rounded-2xl border-2 border-dashed border-cyber-border text-cyber-text-secondary hover:border-cyber-accent hover:text-cyber-accent transition-colors">
      <Plus size={28} />
    </span>
    <span className="text-xs leading-snug text-center w-full line-clamp-2 break-words text-cyber-text-secondary">
      {label}
    </span>
  </button>
);

interface AddAppDialogProps {
  customs: CustomDesktopApp[];
  /** Hard-deleted scanned tools that can be restored. */
  deleted: LocalTool[];
  onAdd: (name: string, path: string) => void;
  onRemoveCustom: (id: string) => void;
  onRestoreDeleted: (id: string) => void;
  onClose: () => void;
  t: (key: TKey) => string;
}

// The "+" dialog: pick an executable via the OS-native file picker (with an
// address bar; Windows is filtered to executables), manage manually added
// entries, and restore hard-deleted scanned tools.
export const AddAppDialog: React.FC<AddAppDialogProps> = ({
  customs,
  deleted,
  onAdd,
  onRemoveCustom,
  onRestoreDeleted,
  onClose,
  t,
}) => {
  const [customName, setCustomName] = useState('');
  const [customPath, setCustomPath] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBrowse = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: IS_WINDOWS
          ? [{ name: 'Programs', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
          : undefined,
      });
      if (typeof picked === 'string' && picked) {
        setCustomPath(picked);
        setCustomName((prev) => prev || customNameFromPath(picked));
      }
    } catch {
      /* cancelled */
    }
  };

  const canAdd = customName.trim() !== '' && customPath.trim() !== '';
  const inputClass =
    'w-full px-3 py-2 text-sm rounded-md border border-cyber-border/50 bg-cyber-surface text-cyber-text outline-none focus:border-cyber-accent placeholder:text-cyber-text-muted';

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-label={t('addApp.title')}
        className="relative w-[560px] max-w-[92vw] max-h-[70vh] flex flex-col rounded-xl border border-cyber-border bg-cyber-surface shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-cyber-border/60 flex-shrink-0">
          <span className="text-sm font-bold text-cyber-text">{t('addApp.title')}</span>
          <button
            onClick={onClose}
            aria-label={t('btn.cancel')}
            className="flex items-center justify-center w-7 h-7 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto pulse-scroll p-4 space-y-5">
          <section className="space-y-2.5">
            <h4 className="text-xs font-bold text-cyber-text-secondary tracking-wider">
              {t('addApp.customSection')}
            </h4>
            <label className="block space-y-1.5">
              <span className="text-xs text-cyber-text-secondary">{t('addApp.nameLabel')}</span>
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t('addApp.namePlaceholder')}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-cyber-text-secondary">{t('addApp.pathLabel')}</span>
              <span className="flex gap-2">
                <input value={customPath} readOnly placeholder="…" className={inputClass} />
                <button
                  onClick={() => void handleBrowse()}
                  className="flex-shrink-0 px-3 py-2 text-sm rounded-md border border-cyber-border/50 text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
                >
                  {t('addApp.browse')}
                </button>
              </span>
            </label>
            <button
              disabled={!canAdd}
              onClick={() => {
                onAdd(customName.trim(), customPath.trim());
                setCustomName('');
                setCustomPath('');
              }}
              className="w-full py-2 rounded-lg bg-cyber-accent text-white text-sm font-bold hover:bg-cyber-accent-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors outline-none"
            >
              {t('addApp.add')}
            </button>
          </section>
          {customs.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-bold text-cyber-text-secondary tracking-wider">
                {t('addApp.mySection')}
              </h4>
              {customs.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cyber-text/5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold truncate">{c.name}</div>
                    <div className="text-[11px] text-cyber-text-secondary truncate opacity-70">
                      {c.path}
                    </div>
                  </div>
                  <button
                    onClick={() => onRemoveCustom(c.id)}
                    className="flex-shrink-0 text-xs text-red-400 hover:text-red-300 transition-colors outline-none"
                  >
                    {t('addApp.remove')}
                  </button>
                </div>
              ))}
            </section>
          )}
          {deleted.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-bold text-cyber-text-secondary tracking-wider">
                {t('addApp.deletedSection')}
              </h4>
              {deleted.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-cyber-text/5"
                >
                  <div className="flex-1 min-w-0 text-sm font-bold truncate">
                    {tool.displayName || tool.name}
                  </div>
                  <button
                    onClick={() => onRestoreDeleted(tool.id)}
                    className="flex-shrink-0 text-xs text-cyber-accent hover:opacity-80 transition-opacity outline-none"
                  >
                    {t('addApp.restore')}
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export const AppManagerMain: React.FC = () => {
  const { t, locale } = useI18n();
  const {
    detectedTools,
    isScanning,
    selectedTool,
    setSelectedTool,
    aiInstallableIds,
    showUninstalled,
    handleLaunch,
    setApplyError,
    customTools,
    addCustomTool,
    removeCustomTool,
  } = useAppManager();
  const confirm = useConfirm();
  // Active category tab for the "未安装" section. 'ALL' shows every
  // uninstalled app; the other tabs filter by category.
  const [activeUninstalledCat, setActiveUninstalledCat] = useState('ALL');

  // User-set order for installed icons, persisted across sessions. Tools not
  // in the saved order (newly installed) sink below the ordered ones.
  const [toolOrder, setToolOrder] = useState<string[]>(() => {
    try {
      const v = localStorage.getItem('echobird_appmgr_tool_order');
      return v ? (JSON.parse(v) as string[]) : [];
    } catch {
      return [];
    }
  });
  const saveToolOrder = (ids: string[]) => {
    setToolOrder(ids);
    try {
      localStorage.setItem('echobird_appmgr_tool_order', JSON.stringify(ids));
    } catch {
      /* private mode */
    }
  };

  // Icons hidden via the right-click "删除图标" item. Same persisted pattern
  // as the drag order; hidden tools render in the slim restore row below.
  const [hiddenTools, setHiddenTools] = useState<string[]>(loadHiddenTools);
  const hideTool = (id: string) => {
    setHiddenTools((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      saveHiddenTools(next);
      return next;
    });
  };
  const restoreTool = (id: string) => {
    setHiddenTools((prev) => {
      const next = prev.filter((x) => x !== id);
      saveHiddenTools(next);
      return next;
    });
  };

  // Hard-deleted tool ids ("删除"): hidden from the desktop and the
  // hidden row across rescans; restored manually from the "+" dialog.
  const [deletedTools, setDeletedTools] = useState<string[]>(loadDeletedTools);
  const deleteToolForever = (id: string) => {
    setHiddenTools((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      saveHiddenTools(next);
      return next;
    });
    setDeletedTools((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      saveDeletedTools(next);
      return next;
    });
  };
  const restoreDeletedTool = (id: string) => {
    setDeletedTools((prev) => {
      const next = prev.filter((x) => x !== id);
      saveDeletedTools(next);
      return next;
    });
  };

  const installed = useMemo(
    () => detectedTools.filter((tool) => tool.installed).sort(compareTools),
    [detectedTools]
  );
  const uninstalled = useMemo(
    () => detectedTools.filter((tool) => !tool.installed),
    [detectedTools]
  );

  // Apply the saved order on top of the default sort: known ids first in
  // saved order, then any freshly-detected tools in default order. Hidden
  // and hard-deleted icons are excluded — they render in the restore row /
  // "+" dialog instead. User-added "+" entries join the same pool so they
  // drag and persist like scanned tools.
  const customTiles = useMemo(() => customTools.map(customAsTool), [customTools]);
  const installedOrdered = useMemo(() => {
    const pool = [
      ...installed.filter((t) => !hiddenTools.includes(t.id) && !deletedTools.includes(t.id)),
      ...customTiles,
    ];
    const orderIndex = new Map(toolOrder.map((id, i) => [id, i]));
    const known = pool.filter((t) => orderIndex.has(t.id));
    const unknown = pool.filter((t) => !orderIndex.has(t.id));
    known.sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);
    return [...known, ...unknown];
  }, [installed, toolOrder, hiddenTools, deletedTools, customTiles]);

  const hiddenInstalled = useMemo(
    () =>
      [...installed, ...customTiles]
        .filter((t) => hiddenTools.includes(t.id) && !deletedTools.includes(t.id))
        .sort(compareTools),
    [installed, customTiles, hiddenTools, deletedTools]
  );

  // Hard-deleted scanned tools that still exist (for the "+" restore list).
  const deletedInstalled = useMemo(
    () => installed.filter((t) => deletedTools.includes(t.id)).sort(compareTools),
    [installed, deletedTools]
  );

  // Drag-reorder for installed icons — pointer with a 5px activation so
  // plain clicks still select; keyboard for a11y. On drop, reorder in place
  // and persist the full visible order (best-effort; a failed write just
  // reverts on next reload).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const activeId = String(event.active.id);
    const overId = String(event.over?.id ?? '');
    if (!overId || activeId === overId) return;
    const oldIndex = installedOrdered.findIndex((t) => t.id === activeId);
    const newIndex = installedOrdered.findIndex((t) => t.id === overId);
    if (oldIndex < 0 || newIndex < 0) return;
    saveToolOrder(arrayMove(installedOrdered, oldIndex, newIndex).map((t) => t.id));
  };
  const handleDragCancel = () => setActiveDragId(null);

  const activeDragTool = activeDragId ? installed.find((t) => t.id === activeDragId) : undefined;

  // Right-click menu state.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [menuMode, setMenuMode] = useState<'desktop' | 'hidden'>('desktop');
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const openMenu = useCallback(
    (tool: LocalTool, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-click also selects — the bottom bar then acts on the same app.
      setSelectedTool(tool.id);
      setMenuMode('desktop');
      setMenu({ id: tool.id, x: e.clientX, y: e.clientY });
    },
    [setSelectedTool]
  );

  // Right-click menu inside the hidden dialog: restore + delete only.
  const openHiddenMenu = useCallback((tool: LocalTool, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuMode('hidden');
    setMenu({ id: tool.id, x: e.clientX, y: e.clientY });
  }, []);

  const menuTool = menu
    ? (detectedTools.find((t) => t.id === menu.id) ?? customTiles.find((t) => t.id === menu.id))
    : undefined;

  const handleMenuLaunch = () => {
    if (!menu) return;
    const id = menu.id;
    closeMenu();
    setSelectedTool(id);
    void handleLaunch(id);
  };

  const handleMenuReveal = () => {
    const dir = menuTool?.detectedPath ? desktopParentDir(menuTool.detectedPath) : null;
    closeMenu();
    if (!dir) return;
    api
      .openFolder(dir)
      .catch((err) => setApplyError(err instanceof Error ? err.message : String(err)));
  };

  // Shared hard-delete flow for the desktop menu item and the hidden-dialog
  // × badge. Custom "+" entries drop their whole record; scanned tools move
  // to the hard-deleted list (restorable from the "+" dialog). Resolves true
  // when something was actually deleted.
  const confirmPermanentDelete = async (id: string): Promise<boolean> => {
    const target = detectedTools.find((t) => t.id === id) ?? customTiles.find((t) => t.id === id);
    const name = target ? toolDisplayName(target, locale) : id;
    const custom = customTools.find((c) => c.id === id);
    closeMenu();
    if (custom) {
      const ok = await confirm({
        title: t('desktopMenu.permanentDelete'),
        message: t('addApp.removeCustomConfirm').replace('{name}', name),
        confirmText: t('desktopMenu.permanentDelete'),
        type: 'danger',
      });
      if (ok) removeCustomTool(id);
      return ok;
    }
    const ok = await confirm({
      title: t('desktopMenu.permanentDelete'),
      message: t('desktopMenu.permanentDeleteConfirm').replace('{name}', name),
      confirmText: t('desktopMenu.permanentDelete'),
      type: 'danger',
    });
    if (ok) deleteToolForever(id);
    return ok;
  };

  // After a dialog-initiated delete, close the dialog when it just emptied.
  // No-op for desktop-menu deletes (hiddenOpen is false there).
  const finishDialogAfterDelete = (done: boolean) => {
    if (done && hiddenOpen && hiddenInstalled.length <= 1) setHiddenOpen(false);
  };

  const handleMenuPermanentDelete = () => {
    if (!menu) return;
    void confirmPermanentDelete(menu.id).then(finishDialogAfterDelete);
  };

  // Hidden-mode restore from the dialog's right-click menu.
  const handleHiddenRestore = () => {
    if (!menu) return;
    restoreTool(menu.id);
    closeMenu();
    if (hiddenInstalled.length <= 1) setHiddenOpen(false);
  };

  // Header batch actions of the hidden dialog: 全部恢复 puts every hidden
  // app back on the desktop at once; 全部删除 hard-deletes them all after a
  // single shared confirm — custom entries drop their record, scanned tools
  // move to the "+" dialog's restore list.
  const handleRestoreAllHidden = () => {
    closeMenu();
    for (const tool of hiddenInstalled) restoreTool(tool.id);
    setHiddenOpen(false);
  };

  const handleDeleteAllHidden = async () => {
    const targets = hiddenInstalled;
    closeMenu();
    if (targets.length === 0) return;
    const ok = await confirm({
      title: t('desktopMenu.permanentDelete'),
      message: t('desktopMenu.deleteAllConfirm').replace('{count}', String(targets.length)),
      confirmText: t('desktopMenu.permanentDelete'),
      type: 'danger',
    });
    if (!ok) return;
    for (const tool of targets) {
      const custom = customTools.find((c) => c.id === tool.id);
      if (custom) removeCustomTool(tool.id);
      else deleteToolForever(tool.id);
    }
    setHiddenOpen(false);
  };

  // Category tabs present among the uninstalled apps: the canonical order
  // first, then any unknown categories alphabetically.
  const uninstalledCats = useMemo(() => {
    const cats = Array.from(new Set(uninstalled.map((t) => t.category).filter(Boolean)));
    return [
      ...CATEGORY_ORDER.filter((cat) => cats.includes(cat)),
      ...cats.filter((cat) => !CATEGORY_ORDER.includes(cat)).sort(),
    ];
  }, [uninstalled]);

  // Apps shown under the active tab. AI-installable first, then the
  // within-category tiebreaker, then name.
  const visibleUninstalled = useMemo(() => {
    const list =
      activeUninstalledCat === 'ALL'
        ? uninstalled
        : uninstalled.filter((t) => t.category === activeUninstalledCat);
    return [...list].sort((a, b) => {
      const aAi = aiInstallableIds.includes(a.id) ? 0 : 1;
      const bAi = aiInstallableIds.includes(b.id) ? 0 : 1;
      if (aAi !== bAi) return aAi - bAi;
      const rankDiff = withinCategoryRank(a) - withinCategoryRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name);
    });
  }, [uninstalled, activeUninstalledCat, aiInstallableIds]);

  const renderIcon = (tool: LocalTool) => (
    <DesktopIcon
      key={tool.id}
      tool={tool}
      selected={selectedTool === tool.id}
      onClick={() => setSelectedTool(tool.id)}
    />
  );

  const gridClass = 'grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-2 gap-y-4';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {isScanning && detectedTools.length === 0 ? (
        <div className={gridClass}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl animate-pulse"
            >
              <span className="w-14 h-14 rounded-xl bg-cyber-border/30" />
              <span className="w-12 h-3 bg-cyber-border/30 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto pulse-scroll pr-1 scrollbar-stable">
          {/* Installed — flat draggable grid, no section header (per spec).
              The trailing "+" tile is always present (even with zero apps):
              left-click only, no drag, no right-click menu. */}
          <div className={showUninstalled && uninstalled.length > 0 ? 'mb-8' : ''}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext
                items={installedOrdered.map((t) => t.id)}
                strategy={rectSortingStrategy}
              >
                <div className={gridClass}>
                  {installedOrdered.map((tool) => (
                    <SortableDesktopIcon
                      key={tool.id}
                      tool={tool}
                      selected={selectedTool === tool.id}
                      onClick={() => setSelectedTool(tool.id)}
                      onContextMenu={(e) => openMenu(tool, e)}
                    />
                  ))}
                  <AddDesktopTile onClick={() => setAddOpen(true)} label={t('addApp.add')} />
                </div>
              </SortableContext>
              <DragOverlay>
                {activeDragTool && (
                  <div className="pointer-events-none opacity-70 scale-105 drop-shadow-lg">
                    <DesktopIcon tool={activeDragTool} selected={false} onClick={() => {}} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </div>

          {/* Hidden via right-click "删除图标" — up to 3 inline restore
              chips; the count badge opens the full restore dialog. */}
          {hiddenInstalled.length > 0 && (
            <div className="mb-8 flex items-center gap-2 flex-wrap px-1">
              <span className="text-xs text-cyber-text-muted flex-shrink-0">
                {t('desktopMenu.hidden')}
              </span>
              {hiddenInstalled.slice(0, MAX_INLINE_HIDDEN).map((tool) => (
                <button
                  key={tool.id}
                  onClick={() => restoreTool(tool.id)}
                  title={t('desktopMenu.restoreHint')}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-cyber-border/50 text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
                >
                  <RotateCcw size={12} />
                  <span className="max-w-[10rem] truncate">{toolDisplayName(tool, locale)}</span>
                </button>
              ))}
              {hiddenInstalled.length > MAX_INLINE_HIDDEN && (
                <button
                  onClick={() => setHiddenOpen(true)}
                  className="flex items-center justify-center min-w-7 h-7 px-2 rounded-full bg-cyber-accent/15 text-cyber-accent text-xs font-bold hover:bg-cyber-accent/25 transition-colors outline-none"
                >
                  {hiddenInstalled.length}
                </button>
              )}
            </div>
          )}

          {/* Not installed — category tabs switch the grid; hidden on demand
              via the eye toggle in the page title bar for a cleaner view */}
          {showUninstalled && uninstalled.length > 0 && (
            <section>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <h3 className="text-sm font-bold tracking-wider text-cyber-text flex-shrink-0">
                  {t('aiDesktop.notInstalled')}
                </h3>
                <span className="text-xs text-cyber-text-muted flex-shrink-0">
                  {uninstalled.length}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setActiveUninstalledCat('ALL')}
                    className={`px-3 py-1.5 text-[13px] transition-colors outline-none ${
                      activeUninstalledCat === 'ALL'
                        ? 'text-cyber-text font-bold border-b-2 border-cyber-border'
                        : 'text-cyber-text-secondary hover:text-cyber-text'
                    }`}
                  >
                    {t('toolCat.all')}
                  </button>
                  {uninstalledCats.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setActiveUninstalledCat(cat)}
                      className={`px-3 py-1.5 text-[13px] transition-colors outline-none ${
                        activeUninstalledCat === cat
                          ? 'text-cyber-text font-bold border-b-2 border-cyber-border'
                          : 'text-cyber-text-secondary hover:text-cyber-text'
                      }`}
                    >
                      {t(catLabelKey(cat))}
                    </button>
                  ))}
                </div>
              </div>
              <div className={gridClass}>{visibleUninstalled.map(renderIcon)}</div>
            </section>
          )}
        </div>
      )}
      {menu && menuTool && (
        <DesktopContextMenu
          t={t}
          x={menu.x}
          y={menu.y}
          canReveal={!!menuTool.detectedPath && desktopParentDir(menuTool.detectedPath) !== null}
          onLaunch={handleMenuLaunch}
          onReveal={handleMenuReveal}
          onHide={() => {
            hideTool(menu.id);
            closeMenu();
          }}
          onPermanentDelete={handleMenuPermanentDelete}
          onRestore={handleHiddenRestore}
          mode={menuMode}
          onClose={closeMenu}
        />
      )}
      {hiddenOpen && (
        <HiddenToolsDialog
          tools={hiddenInstalled}
          onRestore={(id) => {
            restoreTool(id);
            // Last one restored — nothing left to show, close the dialog.
            if (hiddenInstalled.length <= 1) setHiddenOpen(false);
          }}
          onRestoreAll={handleRestoreAllHidden}
          onDeleteAll={() => void handleDeleteAllHidden()}
          onPermanentDelete={(id) => {
            void confirmPermanentDelete(id).then(finishDialogAfterDelete);
          }}
          onContextMenu={(tool, e) => openHiddenMenu(tool, e)}
          onClose={() => setHiddenOpen(false)}
          t={t}
        />
      )}
      {addOpen && (
        <AddAppDialog
          customs={customTools}
          deleted={deletedInstalled}
          onAdd={(name, path) => addCustomTool({ id: `custom-${Date.now()}`, name, path })}
          onRemoveCustom={(id) => void confirmPermanentDelete(id)}
          onRestoreDeleted={restoreDeletedTool}
          onClose={() => setAddOpen(false)}
          t={t}
        />
      )}
    </div>
  );
};

// ===== Model List Section =====

interface ModelListSectionProps {
  selectedToolData: LocalTool;
  userModels: ModelConfig[];
  toolModelConfig: Record<string, string | null>;
  selectedTool: string | null;
  handleSelectModel: (toolId: string, modelId: string) => void;
  modelProtocolSelection: Record<string, 'openai' | 'anthropic'>;
  setModelProtocolSelection: React.Dispatch<
    React.SetStateAction<Record<string, 'openai' | 'anthropic'>>
  >;
  /** When set, the card whose model id matches plays a one-shot apply pulse
   *  (keyed by nonce so re-applying replays it). Omitted where unused. */
  appliedPulse?: { id: string; nonce: number } | null;
  t: (key: TKey) => string;
}

// The coral "effort pulse" played once on a model card the instant its config
// is applied (生效). It OVERLAYS the card (z-20, above the model info) and fills
// it, so for its ~11s it obscures the icon / name / URL, plays, then dissolves to
// reveal them again. It paints its own envelope-faded page-colour backdrop,
// carries its own timing, and unmounts when the trigger clears.
// pointer-events-none lets clicks fall through to the card.
// Apply sound, played in sync with the pulse for its whole ~11s. Different
// models will get different tracks later; for now every apply plays the
// "xiaomi" test track. The keyed remount (see the callers) restarts it on
// re-apply; unmounting (pulse cancelled, e.g. tool switch) stops it.
const APPLY_SOUND = '/sounds/xiaomi.mp3';
const ModelCardPulse: React.FC = () => {
  useEffect(() => {
    const audio = new Audio(APPLY_SOUND);
    audio.play().catch(() => {
      /* autoplay blocked or file missing — the visual still plays */
    });
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, []);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <EffortPulse fill oneShot />
    </div>
  );
};

export const ModelListSection: React.FC<ModelListSectionProps> = ({
  selectedToolData,
  userModels,
  toolModelConfig,
  selectedTool,
  handleSelectModel,
  modelProtocolSelection,
  setModelProtocolSelection,
  appliedPulse,
  t,
}) => {
  const toolProtocols = useMemo(
    () => selectedToolData.apiProtocol || ['openai', 'anthropic'],
    [selectedToolData.apiProtocol]
  );

  // Approximate aggregate token usage flowing through the Auto Router proxy,
  // surfaced on its card. Polled lightly while this section is mounted.
  const [routerTokenStats, setRouterTokenStats] = useState<api.SmartRouterTokenStat[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const stats = await api.getSmartRouterTokenStats();
        if (alive) setRouterTokenStats(stats);
      } catch {
        /* router not running / not reachable — keep last known */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const totalRoutedTokens = routerTokenStats.reduce(
    (sum, stat) => sum + stat.inputTokens + stat.outputTokens,
    0
  );

  const { smartRouterModels, localModels, cloudModels } = useMemo(() => {
    const compatible = userModels.filter((model) => {
      const hasOpenAI = toolProtocols.includes('openai') && !!model.baseUrl;
      const hasAnthropic = toolProtocols.includes('anthropic') && !!model.anthropicUrl;
      return hasOpenAI || hasAnthropic;
    });
    return {
      smartRouterModels: compatible.filter((m) => m.internalId === 'smart-router'),
      localModels: compatible.filter((m) => m.internalId === 'local-server'),
      cloudModels: compatible.filter(
        (m) => m.internalId !== 'local-server' && m.internalId !== 'smart-router'
      ),
    };
  }, [userModels, toolProtocols]);

  const renderModelCard = (model: (typeof userModels)[0], badge?: 'smart' | 'local') => {
    const isSelected = selectedTool ? toolModelConfig[selectedTool] === model.internalId : false;
    const isLocalModel = model.internalId === 'local-server' || model.internalId === 'smart-router';

    const modelHasBoth = !!(model.baseUrl && model.anthropicUrl);
    const toolSupportsBoth =
      toolProtocols.includes('openai') && toolProtocols.includes('anthropic');
    const showSwitcher = modelHasBoth && toolSupportsBoth;

    let currentProtocol = 'openai';
    if (toolSupportsBoth) {
      // Default to the protocol the model's URL actually speaks (see
      // applyModelConfig for the matching apply-side default). A single-URL model
      // must not inherit toolProtocols[0] — that would display (and apply) an
      // OpenAI-only model as Anthropic, 404-ing at call time. Only a both-URL
      // model keeps the toolProtocols[0] default, since its ⇄ switcher can change it.
      const defaultProtocol = modelHasBoth
        ? toolProtocols[0] === 'anthropic'
          ? 'anthropic'
          : 'openai'
        : model.anthropicUrl
          ? 'anthropic'
          : 'openai';
      currentProtocol = modelProtocolSelection[model.internalId] || defaultProtocol;
    } else {
      currentProtocol = toolProtocols[0];
    }

    const displayUrl =
      currentProtocol === 'anthropic'
        ? model.anthropicUrl || model.baseUrl
        : model.baseUrl || model.anthropicUrl;
    const apiPath = (() => {
      try {
        const url = new URL(displayUrl || '');
        const path = url.pathname === '/' ? '' : url.pathname;
        return url.host + path;
      } catch {
        return displayUrl || 'No URL Configured';
      }
    })();

    // Resolve icon from the MODEL ID only — mirror the model-nexus 配置 tab
    // (ModelCard.tsx). Passing the platform name (e.g.「千问AI平台」) here
    // matched the platform rule and showed qianwen.png even when the model
    // id was glm-5.2. The 官方端点 card below keeps name-based resolution
    // because ep.name is the vendor's own endpoint name, not a platform card.
    const iconSrc = getModelIcon('', model.modelId || '');

    return (
      <div
        key={model.internalId}
        className={`relative overflow-hidden p-3 rounded-card cursor-pointer transition-colors flex items-center gap-3 border ${
          isSelected
            ? 'bg-cyber-elevated border-transparent'
            : 'bg-cyber-surface border-transparent hover:bg-cyber-elevated'
        }`}
        onClick={() => selectedTool && handleSelectModel(selectedTool, model.internalId)}
      >
        {appliedPulse && appliedPulse.id === model.internalId && (
          <ModelCardPulse key={appliedPulse.nonce} />
        )}
        {/* Left: Radio + Icon */}
        <div className="relative z-10 flex items-center gap-3 flex-shrink-0">
          <div
            className={`w-[16px] h-[16px] rounded-full border-2 flex items-center justify-center ${
              isSelected ? 'border-cyber-accent' : 'border-cyber-border'
            }`}
          >
            {isSelected && <div className="w-[8px] h-[8px] rounded-full bg-cyber-accent" />}
          </div>
          {iconSrc ? (
            <img
              src={iconSrc}
              alt=""
              className="w-6 h-6"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : isLocalModel ? (
            <div className="w-6 h-6 flex items-center justify-center text-cyber-accent">
              <ServerIcon size={22} />
            </div>
          ) : (
            <div className="w-6 h-6 flex items-center justify-center text-cyber-text">
              <BoxIcon size={22} />
            </div>
          )}
        </div>

        {/* Right: Two-row layout */}
        <div className="relative z-10 flex-1 min-w-0 flex flex-col justify-center min-h-[2.5rem] py-0.5">
          <div className="flex items-center gap-2">
            <div className="text-sm font-bold truncate leading-none flex-1 min-w-0">
              {model.name || 'Untitled Model'}
            </div>
            {badge && (
              <span
                className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                  badge === 'smart'
                    ? 'bg-cyber-accent/10 text-cyber-accent'
                    : 'bg-cyber-text/10 text-cyber-text-secondary'
                }`}
              >
                {t(badge === 'smart' ? 'agent.badge.smart' : 'agent.badge.local')}
              </span>
            )}
            {showSwitcher && (
              <span
                className="text-[10px] font-mono cursor-pointer select-none flex-shrink-0 transition-colors text-cyber-text-muted/60 hover:text-cyber-text"
                onClick={(e) => {
                  e.stopPropagation();
                  const newProtocol = currentProtocol === 'openai' ? 'anthropic' : 'openai';
                  setModelProtocolSelection((prev) => ({
                    ...prev,
                    [model.internalId]: newProtocol,
                  }));
                }}
              >
                {currentProtocol === 'openai' ? 'OpenAI' : 'Anthropic'}{' '}
                <span className="text-[8px]">⇄</span>
              </span>
            )}
          </div>
          <div className="text-[10px] text-cyber-text-secondary truncate leading-tight mt-1 opacity-70">
            {apiPath}
            {model.internalId === 'smart-router' && totalRoutedTokens > 0
              ? ` · ${totalRoutedTokens.toLocaleString()} tok`
              : ''}
          </div>
        </div>
      </div>
    );
  };

  // Official-endpoint card — first item, like cc-switch's "Claude Official"
  const official = selectedTool ? getOfficialEndpoint(selectedTool) : undefined;
  const officialSentinel = selectedTool ? officialModelSentinel(selectedTool) : '';
  const isOfficialPending = !!(selectedTool && toolModelConfig[selectedTool] === officialSentinel);

  const renderOfficialCard = (ep: OfficialEndpoint) => {
    const apiPath = (() => {
      try {
        const url = new URL(
          ep.protocol === 'anthropic' ? ep.anthropicUrl || ep.baseUrl : ep.baseUrl
        );
        const path = url.pathname === '/' ? '' : url.pathname;
        return url.hostname + path;
      } catch {
        return ep.baseUrl;
      }
    })();

    // Use provider icon (Claude/OpenAI etc.) based on official endpoint name
    const iconSrc = getModelIcon(ep.name, ep.modelId);

    return (
      <div
        className={`relative overflow-hidden p-3 rounded-card cursor-pointer transition-colors flex items-center gap-3 border ${
          isOfficialPending
            ? 'bg-cyber-elevated border-transparent'
            : 'bg-cyber-surface border-transparent hover:bg-cyber-elevated'
        }`}
        onClick={() => selectedTool && handleSelectModel(selectedTool, officialSentinel)}
      >
        {appliedPulse && appliedPulse.id === officialSentinel && (
          <ModelCardPulse key={appliedPulse.nonce} />
        )}
        <div className="relative z-10 flex items-center gap-3 flex-shrink-0">
          <div
            className={`w-[16px] h-[16px] rounded-full border-2 flex items-center justify-center ${
              isOfficialPending ? 'border-cyber-accent' : 'border-cyber-border'
            }`}
          >
            {isOfficialPending && <div className="w-[8px] h-[8px] rounded-full bg-cyber-accent" />}
          </div>
          {iconSrc ? (
            <img
              src={iconSrc}
              alt=""
              className="w-6 h-6"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="w-6 h-6 rounded bg-cyber-text/15 flex items-center justify-center text-cyber-text">
              <BoxIcon size={14} />
            </div>
          )}
        </div>
        <div className="relative z-10 flex-1 min-w-0 flex flex-col justify-center min-h-[2.5rem] py-0.5">
          <div className="flex items-center gap-2">
            <div className="text-sm font-bold truncate leading-none flex-1 min-w-0">{ep.name}</div>
            <span className="text-xs font-mono text-cyber-text-secondary/60 flex-shrink-0 pointer-events-none select-none">
              {t('agent.restore')}
            </span>
          </div>
          <div className="text-[10px] text-cyber-text-secondary truncate leading-tight mt-1 opacity-70">
            {apiPath}
          </div>
        </div>
      </div>
    );
  };

  // Fully empty: no local models, no cloud models, no official endpoint.
  // Show only the centered placeholder — the "select model for X" heading
  // would be misleading when there's nothing to select anyway.
  const isEmpty =
    cloudModels.length === 0 &&
    !official &&
    localModels.length === 0 &&
    smartRouterModels.length === 0;
  if (isEmpty) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
        <BoxIcon size={28} className="text-cyber-text opacity-25" />
        <p className="text-base text-cyber-text-secondary font-mono leading-relaxed">
          {t('agent.noModelsTitle')}
          <br />
          {t('agent.noModelsHintPre')}{' '}
          <span className="text-cyber-text font-bold">{t('nav.modelNexus')}</span>{' '}
          {t('agent.noModelsHintPost')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {smartRouterModels.map((model) => renderModelCard(model, 'smart'))}
      {localModels.map((model) => renderModelCard(model, 'local'))}
      {official && renderOfficialCard(official)}
      {cloudModels.map((model) => renderModelCard(model))}
    </div>
  );
};

// A single routing toggle: label + switch + themed help glyph with an
// interactive tooltip. Used for the Codex / Claude-Desktop "API Router"
// toggle and the Codex-only "Responses" toggle. The tooltip stays open while
// the pointer is over the glyph OR the tooltip itself.
interface RoutingToggleProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function RoutingToggle({ label, hint, checked, onChange }: RoutingToggleProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending close timer on unmount so it can't fire after teardown.
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );

  const showTip = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // Small grace delay so moving the pointer from "?" across the gap into the
  // tooltip doesn't dismiss it.
  const scheduleHide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };

  return (
    <div className="flex items-center">
      <span className="text-xs text-cyber-text-secondary mr-2 whitespace-nowrap">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cyber-accent mr-2 ${
          checked ? 'bg-cyber-accent' : 'bg-cyber-border'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-all duration-200 ${
            checked ? 'translate-x-[18px] shadow-[0_1px_2px_rgba(0,0,0,0.35)]' : 'translate-x-1'
          }`}
        />
      </button>
      {/* Help glyph — themed, interactive tooltip (not the native browser one).
          onMouseEnter/Leave on this wrapper covers both the glyph and the
          tooltip (a descendant), so the tooltip stays open while hovered. */}
      <span
        className="relative inline-flex items-center"
        onMouseEnter={showTip}
        onMouseLeave={scheduleHide}
      >
        <span
          aria-label={hint}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-cyber-elevated font-sans text-xs font-medium leading-none text-cyber-text-secondary cursor-help select-none hover:bg-cyber-accent/15 hover:text-cyber-accent transition-colors"
        >
          ?
        </span>
        <span
          role="tooltip"
          className={`absolute right-0 top-full z-[100] mt-1.5 w-72 rounded border border-cyber-accent/40 bg-cyber-elevated px-3 py-2 text-[11px] leading-relaxed text-cyber-text shadow-cyber-card backdrop-blur-sm transition-opacity ${
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {/* Caret — rotated square poking up out of the tooltip's top edge. */}
          <span
            aria-hidden="true"
            className="absolute -top-1 right-2 h-2 w-2 rotate-45 border-l border-t border-cyber-accent/40 bg-cyber-elevated"
          />
          {hint}
        </span>
      </span>
    </div>
  );
}

// ===== Right Panel (config panel with tabs) =====

export const AppManagerPanel: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedToolData,
    selectedTool,
    userModels,
    toolModelConfig,
    handleSelectModel,
    modelProtocolSelection,
    setModelProtocolSelection,
    appliedPulse,
    codexResponsesPassthrough,
    setCodexResponsesPassthrough,
    codexWebSearch,
    setCodexWebSearch,
    claudeDesktopRelayMode,
    setClaudeDesktopRelayMode,
    claudeCodeRelayMode,
    setClaudeCodeRelayMode,
    claude1mMode,
    setClaude1mMode,
  } = useAppManager();

  // API Router ("relay-mode") toggle: shown for Claude Desktop AND Claude Code
  // (each binds its own relay flag). Codex CLI / ChatGPT desktop instead show the
  // Responses + Web Search toggles below. All of these toggles are
  // independent — there is no mutual exclusion among them.
  const isCodexApp = selectedTool === 'codex' || selectedTool === 'chatgptdesktop';
  const isClaudeDesktopApp = selectedTool === 'claudedesktop';
  const isClaudeCodeApp = selectedTool === 'claudecode';
  // Codex dropped the API Router toggle (it has Web Search now); relay is shown
  // for Claude Desktop + Claude Code, each binding its own flag.
  const showRelayToggle = isClaudeDesktopApp || isClaudeCodeApp;
  const showWebSearchToggle = isCodexApp;
  const showResponsesToggle = isCodexApp;
  const relayModeValue = isClaudeDesktopApp ? claudeDesktopRelayMode : claudeCodeRelayMode;
  const setRelayModeValue = isClaudeDesktopApp ? setClaudeDesktopRelayMode : setClaudeCodeRelayMode;
  // 1M-context toggle: Claude Code ONLY, and only once API Router is on. Hidden
  // in bridge mode (bridge writes no model id — CC's built-in claude-* ids
  // already budget the full window, so [1m] would be moot) and for Claude
  // Desktop (its 1M support comes from the backend profile in bridge mode).
  const show1mToggle = isClaudeCodeApp && claudeCodeRelayMode;

  return (
    <>
      {/* Header */}
      <div className="h-10 px-2 flex items-center justify-between bg-transparent">
        <div className="flex gap-1">
          <span className="px-3 py-1.5 text-xs font-bold text-cyber-text">
            {t('agent.modelsTab')}
          </span>
        </div>
        {selectedToolData && (
          <span className="text-[10px] text-cyber-text">{selectedToolData.name}</span>
        )}
      </div>

      {/* Toggle row: mounted when ANY toggle applies — Codex shows the
          Responses + Web Search toggles; Claude Desktop and Claude Code show the
          API Router toggle, and Claude Code additionally shows a 1M toggle when
          API Router is on. Each toggle inside is INDIVIDUALLY gated and binds
          to the flag for the selected app (relayModeValue / setRelayModeValue
          resolve per-app), so no cross-wiring between Codex / Claude Desktop /
          Claude Code. For apps with no toggles nothing renders and the model
          list below claims the space — the user preferred no reserved gap when
          toggles are absent. */}
      {(showResponsesToggle || showWebSearchToggle || showRelayToggle || show1mToggle) && (
        <div className="px-3 h-9 flex items-center gap-2">
          {showResponsesToggle && (
            <RoutingToggle
              key="responses"
              label={t('agent.codexResponsesLabel')}
              hint={t('agent.codexResponsesHint')}
              checked={codexResponsesPassthrough}
              onChange={setCodexResponsesPassthrough}
            />
          )}
          {showWebSearchToggle && (
            <RoutingToggle
              key="websearch"
              label={t('agent.codexWebSearchLabel')}
              hint={t('agent.codexWebSearchHint')}
              checked={codexWebSearch}
              onChange={setCodexWebSearch}
            />
          )}
          {showRelayToggle && (
            <RoutingToggle
              key="relay"
              label={t('agent.codexRelayLabel')}
              hint={t('agent.codexRelayHint')}
              checked={relayModeValue}
              onChange={setRelayModeValue}
            />
          )}
          {show1mToggle && (
            <RoutingToggle
              key="1m"
              label="1M"
              hint={t('agent.claude1mHint')}
              checked={claude1mMode}
              onChange={setClaude1mMode}
            />
          )}
        </div>
      )}

      <div className="flex-1 p-2 overflow-y-auto">
        {selectedToolData ? (
          // Not installed yet — no model to configure; the bottom bar's
          // "一键安装" already covers the action, so just state the state.
          !selectedToolData.installed ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
              <BoxIcon size={28} className="text-cyber-text opacity-25" />
              <p className="text-base text-cyber-text-secondary font-mono leading-relaxed">
                {t('aiDesktop.notInstalled')}
              </p>
            </div>
          ) : selectedToolData.noModelConfig ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
              <BoxIcon size={28} className="text-cyber-text opacity-25" />
              <p className="text-base text-cyber-text-secondary font-mono leading-relaxed">
                {t('agent.noModelConfig')}
              </p>
            </div>
          ) : (
            <div className="space-y-2 h-full">
              <ModelListSection
                selectedToolData={selectedToolData}
                userModels={userModels}
                toolModelConfig={toolModelConfig}
                selectedTool={selectedTool}
                handleSelectModel={handleSelectModel}
                modelProtocolSelection={modelProtocolSelection}
                setModelProtocolSelection={setModelProtocolSelection}
                appliedPulse={appliedPulse}
                t={t}
              />
            </div>
          )
        ) : (
          <div className="h-full flex items-center justify-center">
            <p className="text-cyber-text-secondary text-center">{t('agent.selectTool')}</p>
          </div>
        )}
      </div>
    </>
  );
};

// ===== Bottom Bar (launch area) =====

export const AppManagerBottom: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedTool,
    selectedToolData,
    toolModelConfig,
    launchAfterApply,
    setLaunchAfterApply,
    isLaunching,
    agreedConfigPolicy,
    setAgreedConfigPolicy,
    handleLaunch,
    onGoToMother,
  } = useAppManager();

  const noModelConfig = !!selectedToolData?.noModelConfig;
  // An uninstalled tool flips the primary action to "一键安装" — one click
  // walks the user to the One-Click Install (Mother) page prefilled with the
  // install prompt. Model config / launch are meaningless until the tool is
  // actually on the machine.
  const isUninstalled = !!selectedToolData && !selectedToolData.installed;
  const hasModelSelected = !!(selectedTool && toolModelConfig[selectedTool]);
  // What will a click actually do?
  //  - "Apply" runs only when the user picked a model AND agreed to the config-write policy.
  //  - "Launch" runs whenever launchAfterApply is on, or unconditionally for desktop/no-config apps.
  // Many tools already work out of the box, so launching without picking a model must stay enabled —
  // forcing model selection just to start a CLI was the long-standing bug.
  const willApply = !noModelConfig && agreedConfigPolicy && hasModelSelected;
  const willLaunch = launchAfterApply || noModelConfig;
  const buttonDisabled =
    !selectedToolData || isLaunching || (!isUninstalled && !willApply && !willLaunch);

  // Uninstalled → install flow; otherwise the existing launch/apply flow.
  const handlePrimaryClick = () => {
    if (isUninstalled && selectedToolData) {
      onGoToMother(selectedTool!, selectedToolData.displayName || selectedToolData.name);
      return;
    }
    void handleLaunch();
  };

  return (
    <div className="flex-shrink-0 flex flex-col mt-2">
      <div className="mx-2 border-t border-cyber-border"></div>
      <div className="flex items-center justify-end gap-8 px-6 py-5">
        {/* Page-aware hint copy: AppManager warns against closing EchoBird mid-
            session (Codex / Claude config swap stays applied while we run);
            "我的AI项目" instead tells the user to crib from Reversi/Translator
            models.json when Vibe-Coding their own AI project. */}
        <PageAwareHint />
        {/* Launch button */}
        {/* Launch button */}
        <button
          onClick={handlePrimaryClick}
          disabled={buttonDisabled}
          className={`w-64 h-14 text-lg font-bold font-mono tracking-widest transition-colors flex-shrink-0 rounded-lg cjk-btn border shadow-lg ${
            buttonDisabled
              ? 'bg-cyber-border text-cyber-text-secondary border-transparent shadow-none cursor-not-allowed'
              : 'bg-cyber-accent text-white border-cyber-accent hover:bg-cyber-accent-secondary hover:border-cyber-accent-secondary shadow-cyber-accent/30'
          }`}
        >
          {isUninstalled
            ? t('btn.installOneClick')
            : willLaunch
              ? t('btn.launchApp')
              : t('btn.modifyOnly')}
        </button>
        {/* Checkboxes — for tools that don't support model config (desktop apps,
                    IDE plugins) or aren't installed yet the boxes stay visible but go
                    gray + un-clickable, so the layout doesn't shift and the user
                    understands why the toggles are inert. */}
        <div
          className={`flex flex-col gap-2 ${
            noModelConfig || isUninstalled ? 'opacity-40 pointer-events-none' : ''
          }`}
        >
          {/* Apply & Launch checkbox */}
          <label
            className={`flex items-center gap-2 select-none ${noModelConfig ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            onClick={() => {
              if (!noModelConfig) setLaunchAfterApply(!launchAfterApply);
            }}
          >
            <div
              className={`w-3.5 h-3.5 border flex items-center justify-center transition-all flex-shrink-0 ${
                launchAfterApply
                  ? 'border-cyber-border bg-cyber-text/20'
                  : 'border-cyber-border hover:border-cyber-text-muted'
              }`}
            >
              {launchAfterApply && (
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 10 10"
                  fill="none"
                  className="text-cyber-text"
                >
                  <path
                    d="M2 5L4 7L8 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <span
              className={`text-xs font-mono transition-colors ${launchAfterApply ? 'text-cyber-text' : 'text-cyber-text-secondary'}`}
            >
              {t('agent.applyAndLaunch')}
            </span>
          </label>
          {/* Config policy agreement */}
          <label
            className={`flex items-center gap-2 select-none ${noModelConfig ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            onClick={() => {
              if (!noModelConfig) setAgreedConfigPolicy(!agreedConfigPolicy);
            }}
          >
            <div
              className={`w-3.5 h-3.5 border flex items-center justify-center transition-all flex-shrink-0 ${
                agreedConfigPolicy
                  ? 'border-cyber-border bg-cyber-text/20'
                  : 'border-cyber-border hover:border-cyber-text-muted'
              }`}
            >
              {agreedConfigPolicy && (
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 10 10"
                  fill="none"
                  className="text-cyber-text"
                >
                  <path
                    d="M2 5L4 7L8 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <span
              className={`text-xs font-mono transition-colors ${agreedConfigPolicy ? 'text-cyber-text' : 'text-cyber-text-secondary'}`}
            >
              {t('agent.appliedVia')}
            </span>
          </label>
        </div>
      </div>
    </div>
  );
};

// Orange instructional copy shown at the bottom-left of the launch row.
// Branches on activePage so the same AppManagerBottom can serve both
// "应用桌面" and "我的AI项目" without duplicating the rest of the row.
const PageAwareHint: React.FC = () => {
  const { t } = useI18n();
  const activePage = useNavigationStore((s) => s.activePage);
  const key = activePage === 'myProjects' ? 'hint.myProjects' : 'hint.devInvite';
  return <div className="flex-1 text-[15px] font-medium text-cyber-accent">{t(key)}</div>;
};

// ===== Apply Error Modal =====

export const AppManagerErrorModal: React.FC = () => {
  const { t } = useI18n();
  const { applyError, setApplyError } = useAppManager();

  if (!applyError) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setApplyError(null)}
      />
      <div className="relative w-[360px] max-w-[90vw] border border-red-500/40 bg-cyber-surface shadow-2xl rounded-xl overflow-hidden">
        <div className="h-[2px] w-full bg-red-500/60" />
        <div className="px-5 pt-4 pb-2 flex items-center gap-2">
          <svg
            className="w-4 h-4 text-red-400 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-sm font-mono font-bold tracking-wider text-red-400">
            API Key Warning
          </span>
        </div>
        <div className="px-5 pb-5">
          <p className="text-xs text-cyber-text-secondary leading-relaxed font-mono">
            {applyError}
          </p>
        </div>
        <div className="flex border-t border-cyber-border">
          <button
            onClick={() => setApplyError(null)}
            className="flex-1 px-4 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-all"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
