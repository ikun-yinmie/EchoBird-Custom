// Two-step "放大" for the history/transcript dialogs.
//
// The zoom has up to three sizes: normal → enlarged (fills most of the window,
// rounded corners kept) → fill the whole app window. Whether "enlarged" is a
// useful step depends on the app window itself: when the whole window is
// already maximized, normal → enlarged → fill feels like two tiny nudges, so
// the intermediate step is skipped (normal ⇄ fill). When the window is NOT
// maximized the intermediate step stays, giving a real second enlarge — and
// the shrink direction mirrors both steps (fill → enlarged → normal).

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type DialogZoom = 0 | 1 | 2;

/// Panel class helpers shared by both dialogs.
export const ZOOM_BASE =
  'relative flex flex-col rounded-xl border border-cyber-border/40 bg-cyber-surface shadow-2xl overflow-hidden';
export const ZOOM_ENLARGED =
  'relative w-[min(92vw,1700px)] h-[90vh] flex flex-col rounded-xl border border-cyber-border/40 bg-cyber-surface shadow-2xl overflow-hidden';
export const ZOOM_FILL = 'relative w-full h-full flex flex-col bg-cyber-surface overflow-hidden';

export function useDialogZoom() {
  // Whether the WHOLE software window is currently maximized (filled screen).
  const [appMaximized, setAppMaximized] = useState(false);
  const [zoom, setZoom] = useState<DialogZoom>(0);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    const refresh = () => {
      win
        .isMaximized()
        .then((m) => {
          if (!disposed) setAppMaximized(m);
        })
        .catch(() => {});
    };
    refresh();
    let unlisten: (() => void) | undefined;
    win
      .onResized(() => {
        // Resize fires on manual drags too — query the real state each time.
        refresh();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  /// One step larger. With an already-maximized app window, "enlarged" ≈
  /// "fill", so jump straight to the full-window size.
  const zoomIn = () => {
    setZoom((z) => {
      if (z >= 2) return z;
      if (z === 0) return appMaximized ? 2 : 1;
      return 2;
    });
  };

  /// One step smaller (mirrors zoomIn — from fill it drops to "enlarged" when
  /// the window is not maximized, then back to the default size).
  const zoomOut = () => {
    setZoom((z) => {
      if (z === 0) return 0;
      if (z === 2) return appMaximized ? 0 : 1;
      return 0;
    });
  };

  const atMax = zoom >= 2;
  const atMin = zoom === 0;

  return { appMaximized, zoom, zoomIn, zoomOut, atMax, atMin };
}
