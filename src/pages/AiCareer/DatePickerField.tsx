// DatePickerField — a self-contained, cyber-themed date picker. Replaces the
// native `<input type="date">`, whose OS popup freezes/glitches in the Tauri
// webview and looks foreign next to the rest of the UI. Values travel as
// `YYYY-MM-DD` strings (empty = unset); min/max are also `YYYY-MM-DD`.
//
// The dropdown is a plain month grid rendered in-app: localized month/year
// title + weekday header, prev/next month arrows, Today / Clear shortcuts.
// Day-of-week order follows ISO (Monday first) with locale-derived labels.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';

const pad = (n: number) => String(n).padStart(2, '0');

export const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function todayISO(): string {
  const now = new Date();
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/// Parse `YYYY-MM-DD` (rejecting impossible dates like 02-30).
function parseISO(v: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, m: mo, d };
}

/// Weekday short labels ordered Monday-first (ISO). Derives them from the
/// known Mon..Sun dates of 2021-03-01..07 so they follow the user's locale.
function weekdayLabels(locale: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(2021, 2, 1 + i); // Mar 1 2021 = Monday
    out.push(d.toLocaleDateString(locale, { weekday: 'narrow' }));
  }
  return out;
}

/// `YYYY-MM-DD` -> localized display (e.g. 2026/09/06). Falls back to the
/// raw string when the date can't be parsed.
function formatISO(iso: string, locale: string): string {
  const p = parseISO(iso);
  if (!p) return iso;
  return new Date(p.y, p.m - 1, p.d).toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/// Days of a month view as a Monday-first array aligned to 7-wide rows; empty
/// cells are null.
function monthCells(y: number, m: number): (string | null)[] {
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Mon = 0
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = new Array(lead).fill(null);
  for (let d = 1; d <= days; d += 1) cells.push(toISO(y, m, d));
  return cells;
}

interface Props {
  value: string;
  onChange: (iso: string) => void;
  /// Muted text shown when no date is picked (usually the field label).
  placeholder: string;
  title?: string;
  /** Earliest selectable day (`''` = none). */
  minDate?: string;
  /** Latest selectable day (empty = today; never allows the future). */
  maxDate?: string;
  /** Which side the calendar drops from (default: right). */
  align?: 'left' | 'right';
  className?: string;
}

export function DatePickerField({
  value,
  onChange,
  placeholder,
  title,
  minDate = '',
  maxDate = '',
  align = 'right',
  className = '',
}: Props) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = parseISO(value) ?? parseISO(todayISO());
    return { y: base?.y ?? 2026, m: base?.m ?? 1 };
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-anchor the month view to the current value/today each time it opens.
  const toggleOpen = () => {
    if (!open) {
      const base = parseISO(value) ?? parseISO(todayISO());
      if (base) setView({ y: base.y, m: base.m });
    }
    setOpen((o) => !o);
  };

  // Close on outside press, and on Escape (capture + stopPropagation so the
  // HistoryDialog's own Escape-to-close listener doesn't also fire).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [open]);

  const today = useMemo(() => todayISO(), []);
  const min = minDate || '';
  const max = maxDate && maxDate < today ? maxDate : today;
  const weekdays = useMemo(() => weekdayLabels(locale), [locale]);
  const cells = useMemo(() => monthCells(view.y, view.m), [view.y, view.m]);
  const monthTitle = useMemo(
    () =>
      new Date(view.y, view.m - 1, 1).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
      }),
    [view.y, view.m, locale]
  );
  const atLatestMonth =
    view.y > Number(today.slice(0, 4)) ||
    (view.y === Number(today.slice(0, 4)) && view.m >= Number(today.slice(5, 7)));

  const canPick = (iso: string) => (!min || iso >= min) && (!max || iso <= max) && iso <= today;
  const disabledToday = !canPick(today);

  const prevMonth = () =>
    setView((v) => (v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 }));
  const nextMonth = () =>
    setView((v) => (v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 }));

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={toggleOpen}
        title={title ?? (value ? formatISO(value, locale) : placeholder)}
        aria-label={title ?? placeholder}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-8 w-full flex items-center gap-1 px-2 rounded-lg border text-[12px] transition-colors outline-none ${
          open
            ? 'border-cyber-accent/60 text-cyber-text'
            : 'border-cyber-border/50 text-cyber-text hover:border-cyber-border/80'
        } focus-visible:border-cyber-accent/60 bg-cyber-elevated`}
      >
        <span
          className={`flex-1 min-w-0 truncate text-left tabular-nums ${
            value ? '' : 'text-cyber-text-muted/80'
          }`}
        >
          {value ? formatISO(value, locale) : placeholder}
        </span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${
            value ? 'text-cyber-text-muted' : 'text-cyber-text-muted/60'
          }`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={title ?? placeholder}
          className={`absolute z-40 mt-1.5 w-[252px] rounded-xl border border-cyber-border/60 bg-cyber-surface shadow-2xl p-2.5 space-y-2 ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
        >
          {/* Month nav */}
          <div className="flex items-center justify-between px-0.5">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="‹"
              className="flex items-center justify-center w-6 h-6 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-[12px] font-bold text-cyber-text truncate">{monthTitle}</span>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="›"
              disabled={atLatestMonth}
              className="flex items-center justify-center w-6 h-6 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cyber-text-secondary transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-0.5">
            {weekdays.map((w, i) => (
              <span
                key={i}
                className="h-6 flex items-center justify-center text-[10px] text-cyber-text-muted"
              >
                {w}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((iso, i) => {
              if (!iso) return <span key={i} />;
              const ok = canPick(iso);
              const selected = iso === value;
              const isToday = iso === today;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!ok}
                  onClick={() => pick(iso)}
                  className={`h-7 flex items-center justify-center rounded-md text-[12px] tabular-nums transition-colors outline-none ${
                    selected
                      ? 'bg-cyber-accent text-cyber-surface font-bold'
                      : ok
                        ? 'text-cyber-text hover:bg-cyber-text/10'
                        : 'text-cyber-text-muted/35 cursor-not-allowed'
                  } ${
                    !selected && isToday && ok
                      ? 'ring-1 ring-inset ring-cyber-accent/50 text-cyber-accent'
                      : ''
                  }`}
                >
                  {iso.slice(8)}
                </button>
              );
            })}
          </div>

          {/* Today / Clear */}
          <div className="flex items-center justify-between pt-1.5 border-t border-cyber-border/40">
            <button
              type="button"
              onClick={() => pick(today)}
              disabled={disabledToday}
              className="px-2 py-1 rounded-md text-[11px] text-cyber-accent hover:bg-cyber-accent/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              {t('aiCareer.dateToday')}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
              >
                <X size={10} />
                {t('aiCareer.dateClear')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
