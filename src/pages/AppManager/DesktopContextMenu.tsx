// DesktopContextMenu — right-click menu for installed desktop icons.
// Phone-long-press equivalent: launch / reveal location / hide / delete.

import React, { useEffect, useRef, useState } from 'react';
import { Play, FolderOpen, EyeOff, XCircle, RotateCcw } from 'lucide-react';
import type { TKey } from '../../i18n';

export interface DesktopMenuStrings {
  t: (key: TKey) => string;
}

interface DesktopContextMenuProps extends DesktopMenuStrings {
  x: number;
  y: number;
  /** 'desktop' (4 actions) or 'hidden' (restore + delete only, for the
      hidden-tools dialog). Defaults to 'desktop'. */
  mode?: 'desktop' | 'hidden';
  /** False when detectedPath has no parent dir to reveal (bare command, pip module…). */
  canReveal: boolean;
  onLaunch: () => void;
  onReveal: () => void;
  onHide: () => void;
  /** Hard delete: gone from desktop and hidden list, restorable via "+". */
  onPermanentDelete: () => void;
  /** Hidden-mode only: restore to the desktop. */
  onRestore?: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 232;
const MENU_HEIGHT_EST = 240;

const itemClass = (disabled: boolean, danger: boolean): string =>
  `w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-left transition-colors outline-none ${
    disabled
      ? 'opacity-40 cursor-not-allowed text-cyber-text-secondary'
      : danger
        ? 'text-red-400 hover:bg-red-500/10'
        : 'text-cyber-text hover:bg-cyber-text/10'
  }`;

export const DesktopContextMenu: React.FC<DesktopContextMenuProps> = ({
  t,
  x,
  y,
  mode = 'desktop',
  canReveal,
  onLaunch,
  onReveal,
  onHide,
  onPermanentDelete,
  onRestore,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport after mount (menu size is known then).
  useEffect(() => {
    const el = menuRef.current;
    const w = el?.offsetWidth || MENU_WIDTH;
    const h = el?.offsetHeight || (mode === 'hidden' ? 120 : MENU_HEIGHT_EST);
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y, mode]);

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

  // Above the hidden dialog (9500) so the dialog's own right-click menu is
  // visible; still below the confirm dialog (9998) and toasts (9999).
  return (
    <div className="fixed inset-0 z-[9600]" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={menuRef}
        role="menu"
        className="fixed min-w-[232px] max-w-[280px] py-1.5 rounded-xl border border-cyber-border bg-cyber-surface shadow-2xl overflow-hidden"
        style={{ left: pos.left, top: pos.top }}
      >
        {mode === 'hidden' ? (
          <>
            <button role="menuitem" onClick={onRestore} className={itemClass(false, false)}>
              <RotateCcw size={15} className="flex-shrink-0 text-cyber-accent" />
              <span className="font-bold">{t('addApp.restore')}</span>
            </button>
            <button role="menuitem" onClick={onPermanentDelete} className={itemClass(false, true)}>
              <XCircle size={15} className="flex-shrink-0" />
              <span>{t('desktopMenu.permanentDelete')}</span>
            </button>
          </>
        ) : (
          <>
            <button role="menuitem" onClick={onLaunch} className={itemClass(false, false)}>
              <Play size={15} className="flex-shrink-0 text-cyber-accent" />
              <span className="font-bold">{t('btn.launchApp')}</span>
            </button>
            <button
              role="menuitem"
              onClick={canReveal ? onReveal : undefined}
              disabled={!canReveal}
              className={itemClass(!canReveal, false)}
            >
              <FolderOpen size={15} className="flex-shrink-0" />
              <span>{t('desktopMenu.reveal')}</span>
            </button>
            <div className="mx-3 my-1 border-t border-cyber-border/60" />
            <button role="menuitem" onClick={onHide} className={itemClass(false, false)}>
              <EyeOff size={15} className="flex-shrink-0" />
              <span>{t('desktopMenu.hideIcon')}</span>
            </button>
            <button role="menuitem" onClick={onPermanentDelete} className={itemClass(false, true)}>
              <XCircle size={15} className="flex-shrink-0" />
              <span>{t('desktopMenu.permanentDelete')}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
