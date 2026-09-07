// Day-click popup for 我的AI生涯 — “当天按小时的活动”, broken down per family.
//
// Clicking a heatmap day opens this dialog. Each visible family that had any
// activity that day comes back as its own 24-hour series from
// `ai_career_day_detail`. The two charts (请求数 and 约 Token 量) STACK the
// enabled families per hour (one colour per family); the legend toggles a
// family in/out, and hovering an hour shows that hour's family composition
// (values + share %).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { aiCareerDayDetail, type DayHourBucket, type FamilyHourSeries } from '../../api/aiCareer';
import { formatCompact, TOKENS_PER_BYTE } from './heatmapData';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

// Distinct hues that hold up on light + dark chrome; coral first so the first
// family echoes the heatmap accent.
const PALETTE = [
  '#e08a5a',
  '#6fa8e6',
  '#dcc35f',
  '#7fc98c',
  '#bd93e8',
  '#ee93ac',
  '#5fd0bd',
  '#b0a954',
  '#d9883f',
  '#8aa8d8',
];
const colorFor = (i: number): string => PALETTE[i % PALETTE.length];

type Metric = 'requests' | 'tokens';

interface Row {
  name: string;
  color: string;
  value: number;
  pct: number;
}

function StackedHourChart({
  label,
  metric,
  views,
  rowsAt,
  valueText,
}: {
  label: string;
  metric: Metric;
  views: { series: FamilyHourSeries; color: string }[];
  rowsAt: (hour: number) => Row[];
  valueText: (v: number) => string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    hour: number;
    x: number;
    y: number;
    width: number;
  } | null>(null);

  const valueOf = (b: DayHourBucket) =>
    metric === 'requests' ? b.requests : Math.round(b.bytes * TOKENS_PER_BYTE);

  const totals = useMemo(
    () =>
      HOURS.map((h) =>
        views.reduce(
          (sum, v) => sum + valueOf(v.series.buckets[h] ?? { hour: h, requests: 0, bytes: 0 }),
          0
        )
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [views, metric]
  );
  const max = Math.max(...totals, 1);
  const grand = totals.reduce((a, b) => a + b, 0);
  const rows = hover ? rowsAt(hover.hour) : null;

  // Tooltip geometry: laid out above the pointer, clamped to the chart.
  // Chart width is captured at hover time (no ref reads during render).
  const tipWidth = 220;
  const tipHeight = (rows?.length ?? 0) * 17 + 42;
  const tipLeft = hover
    ? Math.max(6, Math.min(hover.x - tipWidth / 2, hover.width - tipWidth - 6))
    : 0;
  const tipTop = hover ? (hover.y > tipHeight + 14 ? hover.y - tipHeight - 10 : hover.y + 14) : 0;

  return (
    <div ref={rootRef} className="relative flex flex-col" onMouseLeave={() => setHover(null)}>
      {/* Header: series name + grand total */}
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] font-mono font-bold tracking-wider text-cyber-text-secondary uppercase">
          {label}
        </span>
        <span className="text-[11px] text-cyber-text-muted tabular-nums">{valueText(grand)}</span>
      </div>

      {/* Stacked bars — one column per hour */}
      <div className="flex items-end gap-px h-24">
        {HOURS.map((h) => {
          const hourTotal = totals[h];
          if (hourTotal <= 0) {
            return <div key={h} className="flex-1 h-full" />;
          }
          const segs = views
            .map((v) => ({
              b: v.series.buckets[h] ?? { hour: h, requests: 0, bytes: 0 },
              v,
            }))
            .filter((s) => valueOf(s.b) > 0);
          return (
            <div
              key={h}
              className="flex-1 flex items-end h-full cursor-default"
              onMouseEnter={(e) => {
                const rect = rootRef.current?.getBoundingClientRect();
                setHover({
                  hour: h,
                  x: e.clientX - (rect?.left ?? 0),
                  y: e.clientY - (rect?.top ?? 0),
                  width: rect?.width ?? 600,
                });
              }}
            >
              <div className="w-full flex flex-col justify-end h-full">
                {segs.map((s, i) => {
                  const hPct = Math.max(4, (valueOf(s.b) / max) * 100);
                  return (
                    <div
                      key={s.v.series.family}
                      className={`w-full ${i === segs.length - 1 ? 'rounded-t-[2px]' : ''}`}
                      style={{ height: `${hPct}%`, background: s.v.color }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Hour ticks */}
      <div className="relative h-4 mt-0.5 select-none">
        {TICKS.map((h) => (
          <span
            key={h}
            className="absolute text-[9px] text-cyber-text-muted tabular-nums -translate-x-1/2"
            style={{ left: `${(h / 23) * 100}%` }}
          >
            {h}
          </span>
        ))}
        <span
          className="absolute text-[9px] text-cyber-text-muted tabular-nums"
          style={{ left: '100%' }}
        >
          24
        </span>
      </div>

      {/* Hover composition */}
      {rows && rows.length > 0 && (
        <div
          className="pointer-events-none absolute z-20 rounded-md border border-cyber-border/60 bg-cyber-elevated/95 px-2.5 py-1.5 shadow-xl"
          style={{ left: tipLeft, top: tipTop, width: tipWidth }}
        >
          <div className="text-[10px] font-mono font-bold text-cyber-text-secondary mb-1">
            {String(hover!.hour).padStart(2, '0')}:00
          </div>
          {rows.map((r) => (
            <div
              key={r.name}
              className="flex items-center gap-1.5 text-[11px] leading-[17px] text-cyber-text"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: r.color }}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="text-cyber-text-muted tabular-nums">{valueText(r.value)}</span>
              <span className="text-cyber-text-muted tabular-nums w-10 text-right">{r.pct}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DayDetailDialogProps {
  date: string; // YYYY-MM-DD (local)
  onClose: () => void;
}

export function DayDetailDialog({ date, onClose }: DayDetailDialogProps) {
  const { t, locale } = useI18n();
  const [series, setSeries] = useState<FamilyHourSeries[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fresh component per date (dialog re-mounts on open), so initial `loading`
  // already applies — no synchronous resets in the effect.
  useEffect(() => {
    let cancelled = false;
    aiCareerDayDetail(date)
      .then((list) => {
        if (cancelled) return;
        setSeries(list);
        setEnabled(new Set(list.map((s) => s.family)));
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
  }, [date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [y, m, d] = date.split('-').map(Number);
  const dateLabel = new Date(y, m - 1, d).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Stable colour per family (index into the returned list).
  const views = useMemo(() => series.map((s, i) => ({ series: s, color: colorFor(i) })), [series]);
  const enabledViews = views.filter((v) => enabled.has(v.series.family));

  const valueText = (metric: Metric) => (v: number) =>
    metric === 'requests' ? String(v) : `≈${formatCompact(v)}`;

  const rowsAt =
    (metric: Metric) =>
    (hour: number): Row[] => {
      const valueOf = (b: DayHourBucket) =>
        metric === 'requests' ? b.requests : Math.round(b.bytes * TOKENS_PER_BYTE);
      const entries = enabledViews
        .map((v) => {
          const b = v.series.buckets[hour];
          return { name: v.series.name, color: v.color, value: valueOf(b) };
        })
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);
      const total = entries.reduce((sum, e) => sum + e.value, 0);
      return entries.map((e) => ({
        ...e,
        pct: total > 0 ? Math.round((e.value / total) * 100) : 0,
      }));
    };

  const hasData = !loading && !error && series.length > 0;
  const requestsLabel = t('aiCareer.dayChartRequests');
  const tokensLabel = t('aiCareer.dayChartTokens');

  const toggle = (family: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-label={t('aiCareer.dayChartTitle').replace('{date}', dateLabel)}
        onContextMenu={(e) => e.preventDefault()}
        className="relative w-[700px] max-w-[94vw] flex flex-col rounded-xl border border-cyber-border/40 bg-cyber-surface shadow-2xl overflow-hidden"
      >
        <div className="h-[2px] w-full bg-cyber-accent/60" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-cyber-border/60">
          <span className="text-sm font-mono font-bold tracking-wider text-cyber-text">
            {t('aiCareer.dayChartTitle').replace('{date}', dateLabel)}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('btn.close')}
            className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[75vh] overflow-y-auto slim-scroll">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-cyber-text-secondary text-sm">
              <Loader2 size={16} className="animate-spin" />
              <span>{t('aiCareer.detecting')}</span>
            </div>
          )}
          {!loading && error && <p className="text-xs text-red-400 py-6 text-center">{error}</p>}
          {!loading && !error && !hasData && (
            <p className="text-xs text-cyber-text-secondary py-10 text-center">
              {t('aiCareer.dayChartNoData')}
            </p>
          )}

          {hasData && (
            <>
              {/* Legend — click a family chip to show/hide it in both charts */}
              <div className="flex flex-wrap items-center gap-1.5">
                {views.map((v) => {
                  const on = enabled.has(v.series.family);
                  const dayTotals = v.series.buckets.reduce(
                    (acc, b) => ({
                      requests: acc.requests + b.requests,
                      tokens: acc.tokens + Math.round(b.bytes * TOKENS_PER_BYTE),
                    }),
                    { requests: 0, tokens: 0 }
                  );
                  return (
                    <button
                      key={v.series.family}
                      type="button"
                      onClick={() => toggle(v.series.family)}
                      title={`${v.series.name} · ${dayTotals.requests} ${requestsLabel} · ${valueText(
                        'tokens'
                      )(dayTotals.tokens)}`}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                        on
                          ? 'border-cyber-border/60 text-cyber-text hover:bg-cyber-text/10'
                          : 'border-cyber-border/30 text-cyber-text-muted opacity-50 hover:opacity-80'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: v.color }}
                      />
                      <span className="max-w-[8rem] truncate">{v.series.name}</span>
                    </button>
                  );
                })}
              </div>

              {enabledViews.length === 0 && (
                <p className="text-xs text-cyber-text-secondary py-6 text-center">
                  {t('aiCareer.dayChartPickFamily')}
                </p>
              )}

              {enabledViews.length > 0 && (
                <>
                  <StackedHourChart
                    label={requestsLabel}
                    metric="requests"
                    views={enabledViews}
                    rowsAt={rowsAt('requests')}
                    valueText={valueText('requests')}
                  />
                  <StackedHourChart
                    label={tokensLabel}
                    metric="tokens"
                    views={enabledViews}
                    rowsAt={rowsAt('tokens')}
                    valueText={valueText('tokens')}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
