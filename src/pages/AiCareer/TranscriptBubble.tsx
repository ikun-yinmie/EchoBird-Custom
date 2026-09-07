// One chat bubble of the transcript popup. AI answers (assistant role) carry
// a copy button and a fold toggle, so long replies can be pinned to a few
// lines while browsing history. The backend appends agentic-turn narration as
// a literal "<details>…</details>" block (Gemini transcript reconstruction);
// that markup is split out here and rendered as a proper collapsible
// "process notes" section instead of raw text.
//
// Copying grabs the reply body AND the notes section (tags stripped), so the
// clipboard never contains markup — even while the bubble is folded.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Copy, Cpu } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { ChatMsg } from '../../api/aiCareer';
import { copyText } from '../../utils/copyText';

/// Long replies start folded (browsing-friendly); shorter ones stay open.
const LONG_BODY = 700;
/// How many lines a folded reply keeps visible.
const CLAMP_LINES = 6;

/// Split the narration markup: everything before a trailing `<details>` block
/// is the reply body; the block's inner content (after an optional `<summary>`)
/// is the collapsible appendix.
function splitDetails(text: string): { body: string; appendix: string | null } {
  const tag = '<details>';
  const start = text.indexOf(tag);
  if (start === -1) return { body: text.trim(), appendix: null };
  const endTag = '</details>';
  const end = text.lastIndexOf(endTag);
  const innerFrom = start + tag.length;
  const rawInner = (end > innerFrom ? text.slice(innerFrom, end) : text.slice(innerFrom)).trim();
  const sumOpen = '<summary>';
  const sumAt = rawInner.indexOf(sumOpen);
  let inner = rawInner;
  if (sumAt >= 0) {
    const sumClose = '</summary>';
    const closeAt = rawInner.indexOf(sumClose, sumAt);
    inner = (
      closeAt > sumAt
        ? rawInner.slice(closeAt + sumClose.length)
        : rawInner.slice(sumAt + sumOpen.length)
    ).trim();
  }
  const body = text.slice(0, start).trim();
  return { body, appendix: inner.length > 0 ? inner : null };
}

export function TranscriptBubble({ msg }: { msg: ChatMsg }) {
  const { t, locale } = useI18n();
  const isAssistant = msg.role === 'assistant';

  const { body, appendix } = useMemo(() => splitDetails(msg.text), [msg.text]);
  const isLong = isAssistant && body.length > LONG_BODY;

  const [collapsed, setCollapsed] = useState(isLong);
  const [copied, setCopied] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  // Turns that produced no text at all (a bare mid-task prompt, or a store
  // that only recovered the user side) render nothing.
  if (body.length === 0 && !appendix) return null;

  const msgTime = (ts?: number): string => {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const onCopy = async () => {
    const clean = appendix ? `${body}\n\n${appendix}`.trim() : body;
    if (await copyText(clean)) {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    }
  };

  const toggleFold = () => setCollapsed((c) => !c);

  const clampStyle: CSSProperties | undefined = collapsed
    ? {
        display: '-webkit-box',
        WebkitLineClamp: CLAMP_LINES,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }
    : undefined;

  return (
    <div className="group/bubble flex items-start gap-2 mb-4">
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider flex-shrink-0 ${
          !isAssistant
            ? 'bg-cyber-accent/15 text-cyber-accent'
            : 'bg-cyber-text/10 text-cyber-text-secondary'
        }`}
      >
        {!isAssistant ? t('aiCareer.msgUser') : t('aiCareer.msgAssistant')}
      </span>
      <div className="min-w-0 flex-1">
        {(msg.ts || isAssistant) && (
          <div className="flex items-center gap-1.5 mb-1 text-[10px]">
            {msg.ts ? (
              <span className="text-cyber-text-muted tabular-nums">{msgTime(msg.ts)}</span>
            ) : null}
            {isAssistant && msg.model ? (
              <span
                title={msg.model}
                className="inline-flex items-center gap-1 min-w-0 max-w-[260px] rounded bg-cyber-accent/10 text-cyber-accent px-1.5 py-px font-mono font-medium truncate"
              >
                <Cpu size={9} className="flex-shrink-0" />
                <span className="truncate">{msg.model}</span>
              </span>
            ) : null}
            {isAssistant && (
              <span className="ml-auto flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/bubble:opacity-100 focus-within:opacity-100 transition-opacity">
                {isLong && (
                  <button
                    type="button"
                    onClick={toggleFold}
                    aria-label={collapsed ? t('aiCareer.chatExpand') : t('aiCareer.chatCollapse')}
                    title={collapsed ? t('aiCareer.chatExpand') : t('aiCareer.chatCollapse')}
                    className="p-0.5 rounded text-cyber-text-muted hover:text-cyber-accent hover:bg-cyber-accent/10 transition-colors"
                  >
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${collapsed ? '' : 'rotate-180'}`}
                    />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onCopy}
                  aria-label={copied ? t('aiCareer.chatCopied') : t('aiCareer.chatCopy')}
                  title={copied ? t('aiCareer.chatCopied') : t('aiCareer.chatCopy')}
                  className={`p-0.5 rounded transition-colors ${
                    copied
                      ? 'text-cyber-accent'
                      : 'text-cyber-text-muted hover:text-cyber-accent hover:bg-cyber-accent/10'
                  }`}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </span>
            )}
          </div>
        )}

        {/* Reply body — clamped when folded. */}
        {body.length > 0 && (
          <div
            className="text-[13px] leading-relaxed text-cyber-text whitespace-pre-wrap break-words select-text"
            style={clampStyle}
          >
            {body}
          </div>
        )}

        {/* Folded replies expose a visible "expand" handle (hover actions are
            hidden until the pointer is over the bubble). */}
        {isAssistant && isLong && collapsed && (
          <div className="mt-1">
            <button
              type="button"
              onClick={toggleFold}
              className="flex items-center gap-1 text-[11px] text-cyber-accent/90 hover:text-cyber-accent transition-colors"
            >
              <ChevronDown size={12} />
              {t('aiCareer.chatExpand')}
            </button>
          </div>
        )}

        {/* Narration appendix as a collapsible section, closed by default. */}
        {isAssistant && appendix && (
          <div className="mt-2 rounded-md border border-cyber-border/40 bg-cyber-elevated/40 overflow-hidden">
            <button
              type="button"
              onClick={() => setNotesOpen((o) => !o)}
              aria-expanded={notesOpen}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono tracking-wider text-cyber-text-secondary hover:text-cyber-text transition-colors"
            >
              <ChevronDown
                size={11}
                className={`flex-shrink-0 transition-transform ${notesOpen ? 'rotate-180' : ''}`}
              />
              {t('aiCareer.chatNotes')}
            </button>
            {notesOpen && (
              <div className="px-2.5 pb-2.5 pt-0.5 text-[12px] leading-relaxed text-cyber-text-secondary whitespace-pre-wrap break-words select-text border-t border-cyber-border/30">
                {appendix}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
