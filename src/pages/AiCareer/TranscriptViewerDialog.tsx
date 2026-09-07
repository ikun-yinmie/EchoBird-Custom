// Chat-transcript popup for 我的AI生涯. Shows the FULL conversation of one
// session (read from its on-disk store by the backend) as a scrollable chat:
// role-labeled bubbles, per-message time when the store records it, plus a
// header with the session title, family and working directory. Reached from
// the history dialog and from a click on a right-panel session row.

import { useEffect, useState } from 'react';
import { Folder, Loader2, Maximize, MessageSquareText, Minimize, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { aiCareerSessionTranscript, type ChatMsg, type SavedSession } from '../../api/aiCareer';
import { TranscriptBubble } from './TranscriptBubble';
import { useDialogZoom, ZOOM_ENLARGED, ZOOM_FILL } from './useDialogZoom';

export interface TranscriptTarget {
  /// Family id ("claude", custom id, ...).
  family: string;
  /// Display name — optional; the backend response supplies it too.
  familyName?: string;
  session: SavedSession;
}

interface Props {
  target: TranscriptTarget;
  onClose: () => void;
}

/// Epoch ms of a `SavedSession.saved_at` (the backend sends ms or seconds).
function parseSavedMs(savedAt: string): number {
  const parsed = Date.parse(savedAt);
  if (!isNaN(parsed)) return parsed;
  const num = Number(savedAt);
  if (!isNaN(num) && num > 0) return num < 1e11 ? num * 1000 : num;
  return NaN;
}

export function TranscriptViewerDialog({ target, onClose }: Props) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [familyName, setFamilyName] = useState(target.familyName ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Two-step 放大: default → enlarged → fills the window. The intermediate
  // step is skipped while the whole app window is already maximized, and the
  // 缩小 direction mirrors the steps.
  const { zoom, zoomIn, zoomOut, atMax, atMin } = useDialogZoom();

  useEffect(() => {
    let cancelled = false;
    aiCareerSessionTranscript(
      target.family,
      target.session.file_path ?? '',
      target.session.session_token
    )
      .then((tr) => {
        if (cancelled) return;
        setMessages(tr?.messages ?? []);
        if (tr?.family_name) setFamilyName(tr.family_name);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape first shrinks the dialog one zoom step; further presses close it.
      if (zoom > 0) zoomOut();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoom, zoomOut]);

  const ms = parseSavedMs(target.session.saved_at);
  const savedLabel = !isNaN(ms)
    ? new Date(ms).toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  const panelClass =
    zoom === 2
      ? ZOOM_FILL
      : zoom === 1
        ? ZOOM_ENLARGED
        : 'relative w-[820px] max-w-[95vw] h-[80vh] flex flex-col rounded-xl border border-cyber-border/40 bg-cyber-surface shadow-2xl overflow-hidden';

  return (
    <div className="fixed inset-0 z-[9700] flex items-center justify-center">
      {zoom < 2 && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      )}
      <div
        role="dialog"
        aria-label={`${t('aiCareer.chatTitle')} · ${target.session.name}`}
        onContextMenu={(e) => e.preventDefault()}
        className={panelClass}
      >
        <div className="h-[2px] w-full bg-cyber-accent/60 flex-shrink-0" />

        {/* Header */}
        <div
          className={`flex items-start justify-between gap-3 pt-4 pb-3 border-b border-cyber-border/60 flex-shrink-0 ${
            zoom > 0 ? 'px-8' : 'px-5'
          }`}
        >
          <div className="min-w-0">
            <div className="text-sm font-mono font-bold tracking-wider text-cyber-text truncate">
              {target.session.name}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-cyber-text-secondary flex-wrap">
              {familyName && <span className="text-cyber-accent">{familyName}</span>}
              {savedLabel && <span>{savedLabel}</span>}
              {target.session.turn_count ? (
                <span>
                  {t('aiCareer.messages').replace('{count}', String(target.session.turn_count))}
                </span>
              ) : null}
              {target.session.cwd && (
                <span className="flex items-center gap-1 min-w-0 text-cyber-text-muted">
                  <Folder size={11} className="flex-shrink-0" />
                  <span className="truncate">{target.session.cwd}</span>
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* 放大: normal → enlarged → fill (skips the middle step while the
                whole app window is already maximized). */}
            <button
              type="button"
              onClick={zoomIn}
              disabled={atMax}
              aria-label={t('aiCareer.zoomIn')}
              title={t('aiCareer.zoomIn')}
              className="p-1.5 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors disabled:opacity-30 disabled:hover:text-cyber-text-muted disabled:hover:bg-transparent"
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
              className="p-1.5 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors disabled:opacity-30 disabled:hover:text-cyber-text-muted disabled:hover:bg-transparent"
            >
              <Minimize size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('btn.close')}
              className="p-1.5 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={`flex-1 overflow-y-auto slim-scroll py-4 ${zoom > 0 ? 'px-8' : 'px-5'}`}>
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-cyber-text-secondary text-sm">
              <Loader2 size={16} className="animate-spin" />
              <span>{t('aiCareer.historySearching')}</span>
            </div>
          )}
          {!loading && error && (
            <p className="text-xs text-red-400 py-10 text-center break-all">{error}</p>
          )}
          {!loading && !error && messages !== null && messages.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-cyber-text-secondary text-sm">
              <MessageSquareText size={20} className="opacity-60" />
              <span>{t('aiCareer.chatEmpty')}</span>
            </div>
          )}
          {!loading &&
            !error &&
            messages !== null &&
            messages.map((m, i) => <TranscriptBubble key={i} msg={m} />)}
        </div>
      </div>
    </div>
  );
}
