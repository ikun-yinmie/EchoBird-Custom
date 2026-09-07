import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import {
  Box,
  Check,
  CircleHelp,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Route,
  X,
} from 'lucide-react';
import * as api from '../../api/tauri';
import type { FreeModelDirectory, FreeModelEntry } from '../../api/freeModels';
import { getModelIcon } from '../../components';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../hooks/useI18n';
import { useNavigationStore } from '../../stores/navigationStore';
import { useModelNexus } from '../ModelNexus/context';
import './FreeModels.css';

const NODE_COLUMN_GAP = 28;
const NODE_ROW_GAP = 56;
const HUB_TO_NODE_GAP = 72;
const HUB_ARROW_GAP = 4;
const HUB_ARROW_HEIGHT = 12;
const HUB_ARROW_LINE_GAP = 2;
const SCAN_STEP_MS = 230;
const SCAN_COMPLETE_MS = 320;
const ROUTER_ACTIVITY_POLL_MS = 750;
const ROUTER_ACTIVITY_GRACE_MS = 2200;

interface FreeModelsContextValue {
  catalog: FreeModelDirectory;
  models: FreeModelEntry[];
  customModels: RouteModelNode[];
  selectedIds: Set<string>;
  refreshing: boolean;
  scanProvider: string;
  scanProgress: number;
  routerBaseUrl: string;
  routerOnline: boolean;
  refresh: () => Promise<void>;
  addSelectedModel: (model: RouteModelInput) => Promise<void>;
  removeSelectedModel: (id: string) => Promise<void>;
}

interface RouteModelInput {
  internalId: string;
  name: string;
  baseUrl: string;
  modelId: string;
}

interface RouteModelNode {
  id: string;
  internalId: string;
  provider: string;
  modelId: string;
  baseUrl: string;
}

interface FreeModelProviderGroup {
  id: string;
  name: string;
  baseUrl: string;
  docsUrl: string;
  models: FreeModelEntry[];
}

interface RoutePath {
  id: string;
  d: string;
}

interface RouteArrow {
  x: number;
  y: number;
}

const FreeModelsContext = createContext<FreeModelsContextValue | null>(null);
const emptyCatalog: FreeModelDirectory = {
  version: 1,
  updatedAt: '',
  models: [],
};
const providerPriority = ['nvidia-nim', 'openrouter'];

function providerRank(model: FreeModelEntry): number {
  const rank = providerPriority.indexOf(model.providerId);
  return rank === -1 ? providerPriority.length : rank;
}

function groupModelsForScan(models: FreeModelEntry[]): FreeModelEntry[][] {
  const groups = new Map<string, FreeModelEntry[]>();
  models.forEach((model) => {
    const id = `${model.providerId}:${model.baseUrl}`;
    const group = groups.get(id);
    if (group) group.push(model);
    else groups.set(id, [model]);
  });
  return [...groups.values()].sort((left, right) => providerRank(left[0]) - providerRank(right[0]));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useFreeModels() {
  const value = useContext(FreeModelsContext);
  if (!value) throw new Error('useFreeModels must be used within FreeModelsProvider');
  return value;
}

function shortModelName(modelId: string): string {
  const tail = modelId.split('/').pop() || modelId;
  return tail.length > 27 ? `${tail.slice(0, 24)}…` : tail;
}

export function FreeModelsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const activePage = useNavigationStore((state) => state.activePage);
  const [catalog, setCatalog] = useState<FreeModelDirectory>(emptyCatalog);
  const [customModels, setCustomModels] = useState<RouteModelNode[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [scanProvider, setScanProvider] = useState('');
  const [scanProgress, setScanProgress] = useState(0);
  const [routerBaseUrl, setRouterBaseUrl] = useState('127.0.0.1:53683/v1');
  const [routerRunning, setRouterRunning] = useState(false);
  const [usableCandidateCount, setUsableCandidateCount] = useState(0);
  const refreshInFlightRef = useRef(false);
  const routerMutationRef = useRef<Promise<void>>(Promise.resolve());
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const routerLoadedRef = useRef(false);
  const models = catalog.models;

  useEffect(() => {
    if (routerLoadedRef.current && activePage !== 'freeModels') return;
    let cancelled = false;
    Promise.all([api.getSmartRouterConfig(), api.getSmartRouterCandidates()])
      .then(([router, configuredModels]) => {
        if (cancelled) return;
        const modelsById = new Map(configuredModels.map((model) => [model.internalId, model]));
        const routeModels = router.candidateIds.flatMap((internalId) => {
          const model = modelsById.get(internalId);
          if (!model?.modelId || !model.baseUrl) return [];
          return [
            {
              id: internalId,
              internalId,
              provider: model.name,
              modelId: model.modelId,
              baseUrl: model.baseUrl,
            },
          ];
        });
        setCustomModels(routeModels);
        const next = new Set(router.candidateIds);
        selectedIdsRef.current = next;
        setSelectedIds((current) => {
          if (current.size === next.size && [...current].every((id) => next.has(id))) {
            return current;
          }
          return next;
        });
        setRouterBaseUrl(router.baseUrl.replace(/^https?:\/\//, ''));
        setRouterRunning(router.running);
        setUsableCandidateCount(router.usableCandidateCount);
        routerLoadedRef.current = true;
      })
      .catch((error) => console.error('Load smart router config failed:', error));
    return () => {
      cancelled = true;
    };
  }, [activePage]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setCatalog(emptyCatalog);
    setScanProvider('');
    setScanProgress(0);
    setRefreshing(true);
    try {
      const remote = await api.getFreeModelDirectory();
      if (!remote) {
        showToast('warning', t('freeModels.fetchFailed'));
        return;
      }

      const groups = groupModelsForScan(remote.models);
      const revealedModels: FreeModelEntry[] = [];
      for (const [index, group] of groups.entries()) {
        setScanProvider(group[0]?.provider ?? '');
        await wait(SCAN_STEP_MS);
        revealedModels.push(...group);
        setCatalog({ ...remote, models: [...revealedModels] });
        setScanProgress((index + 1) / groups.length);
      }
      await wait(SCAN_COMPLETE_MS);
    } catch (error) {
      console.error('Fetch free model directory failed:', error);
      showToast('error', t('freeModels.fetchFailed'));
    } finally {
      refreshInFlightRef.current = false;
      setScanProvider('');
      setScanProgress(0);
      setRefreshing(false);
    }
  }, [showToast, t]);

  const addSelectedModel = useCallback(async (model: RouteModelInput) => {
    const id = model.internalId;
    const addition = routerMutationRef.current
      .catch(() => undefined)
      .then(() => {
        const candidateIds = [...new Set([...selectedIdsRef.current, id])];
        return api.setSmartRouterCandidates(candidateIds);
      });
    routerMutationRef.current = addition.then(
      () => undefined,
      () => undefined
    );

    const router = await addition;
    if (!router.candidateIds.includes(id)) {
      throw new Error(`Smart Router rejected candidate: ${id}`);
    }

    const nextIds = new Set(router.candidateIds);
    selectedIdsRef.current = nextIds;
    setSelectedIds(nextIds);
    setCustomModels((current) => [
      ...current.filter((entry) => entry.id !== id),
      {
        id,
        internalId: model.internalId,
        provider: model.name,
        modelId: model.modelId,
        baseUrl: model.baseUrl,
      },
    ]);
    setRouterBaseUrl(router.baseUrl.replace(/^https?:\/\//, ''));
    setRouterRunning(router.running);
    setUsableCandidateCount(router.usableCandidateCount);
  }, []);

  const removeSelectedModel = useCallback(
    async (id: string) => {
      const removal = routerMutationRef.current
        .catch(() => undefined)
        .then(() => api.removeSmartRouterCandidate(id));
      routerMutationRef.current = removal.then(
        () => undefined,
        () => undefined
      );
      try {
        const router = await removal;
        const nextIds = new Set(router.candidateIds);
        selectedIdsRef.current = nextIds;
        setSelectedIds(nextIds);
        setCustomModels((current) => current.filter((model) => model.id !== id));
        setRouterBaseUrl(router.baseUrl.replace(/^https?:\/\//, ''));
        setRouterRunning(router.running);
        setUsableCandidateCount(router.usableCandidateCount);
      } catch (error) {
        console.error('Remove smart router candidate failed:', error);
        showToast('error', t('error.requestFailed'));
      }
    },
    [showToast, t]
  );

  return (
    <FreeModelsContext.Provider
      value={{
        catalog,
        models,
        customModels,
        selectedIds,
        refreshing,
        scanProvider,
        scanProgress,
        routerBaseUrl,
        routerOnline: routerRunning && usableCandidateCount > 0,
        refresh,
        addSelectedModel,
        removeSelectedModel,
      }}
    >
      {children}
    </FreeModelsContext.Provider>
  );
}

export function FreeModelsTitleActions() {
  const { t } = useI18n();
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!showHelp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHelp(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [showHelp]);

  return (
    <>
      <button
        type="button"
        onClick={() => setShowHelp(true)}
        className="flex items-center gap-1.5 text-sm font-mono px-3 py-1.5 border border-cyber-border rounded-button text-cyber-text hover:bg-cyber-text/10 transition-colors"
      >
        <CircleHelp size={13} />
        {t('freeModels.help')}
      </button>

      {showHelp && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowHelp(false)}
          />
          <div className="relative w-[520px] max-w-[90vw] border border-cyber-border/30 bg-cyber-surface shadow-2xl rounded-xl overflow-hidden">
            <div className="h-px w-full bg-cyber-border" />
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              aria-label={t('btn.close')}
              className="absolute right-5 top-5 text-cyber-text-secondary hover:text-cyber-text transition-colors"
            >
              <X size={18} />
            </button>

            <div className="px-6 pt-6 pb-6 pr-14 space-y-4">
              <div className="flex gap-3">
                <Route size={18} className="mt-0.5 flex-shrink-0 text-cyber-accent" />
                <div>
                  <div className="text-sm font-semibold text-cyber-text">
                    {t('freeModels.help.routerTitle')}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-cyber-text-secondary">
                    {t('freeModels.help.routerDesc')}
                  </p>
                </div>
              </div>

              <div className="h-px bg-cyber-border/60" />

              <div className="flex gap-3">
                <KeyRound size={18} className="mt-0.5 flex-shrink-0 text-cyber-accent" />
                <div>
                  <div className="text-sm font-semibold text-cyber-text">
                    {t('freeModels.help.useTitle')}
                  </div>
                  <ol className="mt-1 space-y-1.5 text-xs leading-5 text-cyber-text-secondary list-decimal list-inside">
                    <li>{t('freeModels.help.step1')}</li>
                    <li>{t('freeModels.help.step2')}</li>
                    <li>{t('freeModels.help.step3')}</li>
                  </ol>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="w-full border-t border-cyber-border px-4 py-3 text-[14px] font-semibold text-cyber-text hover:bg-cyber-text/10 transition-colors"
            >
              {t('btn.close')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function FreeModelsMain() {
  const { t } = useI18n();
  const { customModels, selectedIds, routerBaseUrl, routerOnline, removeSelectedModel } =
    useFreeModels();
  const selectedModels = useMemo(
    () => customModels.filter((model) => selectedIds.has(model.id)),
    [customModels, selectedIds]
  );
  const routerAnthropicBaseUrl = routerBaseUrl.replace(/\/v1\/?$/, '');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hubRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [routePaths, setRoutePaths] = useState<RoutePath[]>([]);
  const [activityPaths, setActivityPaths] = useState<RoutePath[]>([]);
  const [routeArrow, setRouteArrow] = useState<RouteArrow | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [routerActivity, setRouterActivity] = useState<api.SmartRouterActivity>({
    candidateId: null,
    active: false,
    sequence: 0,
    updatedAtMs: 0,
  });
  const [activityObservedAtMs, setActivityObservedAtMs] = useState(0);
  // Token usage tallied by the router proxy (per candidate + aggregate).
  const [routerTokenStats, setRouterTokenStats] = useState<api.SmartRouterTokenStat[]>([]);
  // Per-candidate latency probe results (per-node [测速]). -1 = tested & failed.
  const [nodeLatencies, setNodeLatencies] = useState<Record<string, number>>({});
  const [pingingNodeIds, setPingingNodeIds] = useState<Set<string>>(new Set());

  const pingNode = useCallback(async (node: RouteModelNode) => {
    setPingingNodeIds((prev) => {
      const next = new Set(prev);
      next.add(node.id);
      return next;
    });
    try {
      const result = await api.pingModel(node.internalId);
      setNodeLatencies((prev) => ({
        ...prev,
        [node.id]: result?.success ? result.latency : -1,
      }));
    } catch {
      setNodeLatencies((prev) => ({ ...prev, [node.id]: -1 }));
    } finally {
      setPingingNodeIds((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let errorReported = false;
    const pollActivity = async () => {
      try {
        const activity = await api.getSmartRouterActivity();
        if (!cancelled) {
          setRouterActivity(activity);
          setActivityObservedAtMs(Date.now());
        }
      } catch (error) {
        if (!cancelled && !errorReported) {
          errorReported = true;
          console.error('Load smart router activity failed:', error);
        }
      }
      try {
        const stats = await api.getSmartRouterTokenStats();
        if (!cancelled) {
          setRouterTokenStats(stats);
        }
      } catch (error) {
        if (!cancelled) console.error('Load smart router token stats failed:', error);
      }
    };
    void pollActivity();
    const timer = window.setInterval(() => void pollActivity(), ROUTER_ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const tokenByNode = useMemo(() => {
    const map: Record<string, number> = {};
    for (const stat of routerTokenStats) {
      map[stat.internalId] = (map[stat.internalId] || 0) + stat.inputTokens + stat.outputTokens;
    }
    return map;
  }, [routerTokenStats]);
  const totalTokens = useMemo(
    () => Object.values(tokenByNode).reduce((sum, tokens) => sum + tokens, 0),
    [tokenByNode]
  );

  const resetRouterTokens = useCallback(async (internalId?: string) => {
    try {
      await api.resetSmartRouterTokenStats(internalId);
      setRouterTokenStats(await api.getSmartRouterTokenStats());
    } catch (error) {
      console.error('Reset smart router token stats failed:', error);
    }
  }, []);

  const setNodeRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  }, []);

  const updatePaths = useCallback(() => {
    const stage = stageRef.current;
    const hub = hubRef.current;
    if (!stage || !hub) return;
    const stageBox = stage.getBoundingClientRect();
    const hubBox = hub.getBoundingClientRect();
    const endX = hubBox.left - stageBox.left + hubBox.width / 2;
    const endY = hubBox.bottom - stageBox.top;

    const entries = [...nodeRefs.current].map(([id, node]) => {
      const box = node.getBoundingClientRect();
      return {
        id,
        x: box.left - stageBox.left + box.width / 2,
        top: box.top - stageBox.top,
        bottom: box.bottom - stageBox.top,
      };
    });
    entries.sort((left, right) => left.top - right.top || left.x - right.x);

    const rows: (typeof entries)[] = [];
    for (const entry of entries) {
      const row = rows.find((candidate) => Math.abs(candidate[0].top - entry.top) < 12);
      if (row) row.push(entry);
      else rows.push([entry]);
    }

    const nextPaths: RoutePath[] = [];
    const nextActivityPaths: RoutePath[] = [];
    const parentById = new Map<string, (typeof entries)[number]>();
    const firstRow = rows[0];
    let nextArrow: RouteArrow | null = null;
    let routeBusY: number | null = null;
    let routeLineEndY: number | null = null;
    if (firstRow) {
      const arrowY = endY + HUB_ARROW_GAP;
      const lineEndY = arrowY + HUB_ARROW_HEIGHT + HUB_ARROW_LINE_GAP;
      routeLineEndY = lineEndY;
      if (firstRow.length === 1) {
        const entry = firstRow[0];
        nextPaths.push({
          id: entry.id,
          d: `M ${entry.x} ${entry.top - 3} V ${lineEndY}`,
        });
        nextArrow = { x: endX, y: arrowY };
      } else {
        const busY = endY + (firstRow[0].top - endY) / 2;
        routeBusY = busY;
        const firstX = firstRow[0].x;
        const lastX = firstRow[firstRow.length - 1].x;
        const busSegments = [];
        if (firstX < endX - 1) busSegments.push(`M ${firstX} ${busY} H ${endX}`);
        if (lastX > endX + 1) busSegments.push(`M ${lastX} ${busY} H ${endX}`);
        if (busSegments.length > 0) {
          nextPaths.push({
            id: 'hub-bus',
            d: busSegments.join(' '),
          });
        }
        nextPaths.push({
          id: 'hub-trunk',
          d: `M ${endX} ${busY} V ${lineEndY}`,
        });
        nextArrow = { x: endX, y: arrowY };
        firstRow.forEach((entry) => {
          nextPaths.push({
            id: entry.id,
            d: `M ${entry.x} ${entry.top - 3} V ${busY}`,
          });
        });
      }
    }

    rows.slice(1).forEach((row, rowIndex) => {
      const parentRow = rows[rowIndex];
      row.forEach((entry) => {
        const parent = parentRow.reduce((closest, candidate) =>
          Math.abs(candidate.x - entry.x) < Math.abs(closest.x - entry.x) ? candidate : closest
        );
        const bridgeY = parent.bottom + (entry.top - parent.bottom) / 2;
        parentById.set(entry.id, parent);
        nextPaths.push({
          id: entry.id,
          d:
            Math.abs(entry.x - parent.x) < 1
              ? `M ${entry.x} ${entry.top - 3} V ${parent.bottom + 3}`
              : `M ${entry.x} ${entry.top - 3} V ${bridgeY} H ${parent.x} V ${parent.bottom + 3}`,
        });
      });
    });

    if (firstRow && routeLineEndY !== null) {
      entries.forEach((entry) => {
        let current = entry;
        let d = `M ${entry.x} ${entry.top - 3}`;
        let parent = parentById.get(current.id);
        while (parent) {
          const bridgeY = parent.bottom + (current.top - parent.bottom) / 2;
          d +=
            Math.abs(current.x - parent.x) < 1
              ? ` V ${parent.bottom + 3}`
              : ` V ${bridgeY} H ${parent.x} V ${parent.bottom + 3}`;
          d += ` V ${parent.top - 3}`;
          current = parent;
          parent = parentById.get(current.id);
        }
        if (firstRow.length === 1) {
          d += ` V ${routeLineEndY}`;
        } else if (routeBusY !== null) {
          d += ` V ${routeBusY} H ${endX} V ${routeLineEndY}`;
        }
        nextActivityPaths.push({ id: entry.id, d });
      });
    }
    setCanvasSize({ width: stageBox.width, height: stageBox.height });
    setRoutePaths(nextPaths);
    setActivityPaths(nextActivityPaths);
    setRouteArrow(nextArrow);
  }, []);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(updatePaths);
    const stage = stageRef.current;
    if (!stage) return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(updatePaths);
    observer.observe(stage);
    if (hubRef.current) observer.observe(hubRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // Node content height changes when a latency probe lands, so recompute the
    // wiring after probe state settles too.
  }, [selectedModels, updatePaths, nodeLatencies, pingingNodeIds]);

  const activityIsVisible =
    routerActivity.candidateId !== null &&
    (routerActivity.active ||
      activityObservedAtMs - routerActivity.updatedAtMs < ROUTER_ACTIVITY_GRACE_MS);
  const activeRoutePath = activityIsVisible
    ? activityPaths.find((path) => path.id === routerActivity.candidateId)
    : undefined;
  const routeRowCount = selectedModels.length === 0 ? 0 : Math.ceil(selectedModels.length / 4);
  const stageMinHeight = Math.max(
    550,
    24 +
      118 +
      HUB_TO_NODE_GAP +
      routeRowCount * 72 +
      Math.max(0, routeRowCount - 1) * NODE_ROW_GAP +
      24
  );

  return (
    <div className="free-model-router h-full min-h-[620px] px-2 py-1">
      <div
        ref={stageRef}
        className="relative h-full pt-6 overflow-hidden"
        style={{ minHeight: stageMinHeight }}
      >
        <svg
          className="absolute inset-0 z-0 h-full w-full pointer-events-none"
          viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {routePaths.map((path) => (
            <path key={path.id} d={path.d} className="free-model-route-path" />
          ))}
          {activeRoutePath && (
            <path
              key={activeRoutePath.id}
              d={activeRoutePath.d}
              pathLength="1"
              className="free-model-route-glow"
            />
          )}
          {routeArrow && (
            <path
              d={`M ${routeArrow.x} ${routeArrow.y} L ${routeArrow.x - 6} ${routeArrow.y + HUB_ARROW_HEIGHT} H ${routeArrow.x + 6} Z`}
              className="free-model-route-arrow"
            />
          )}
        </svg>

        <div
          ref={hubRef}
          className={`free-model-router-hub relative z-10 mx-auto w-[min(270px,80%)] min-h-[118px] rounded-2xl flex flex-col items-center justify-center text-center px-4 py-3 cursor-default ${
            routerOnline ? 'is-running' : selectedModels.length > 0 ? 'is-unavailable' : ''
          }`}
        >
          <div className="whitespace-nowrap text-xl font-semibold text-cyber-text">
            {t('freeModels.router.title')}
          </div>
          <div className="mt-3 space-y-1.5 text-center text-[10px] font-mono free-model-router-state">
            <div className="whitespace-nowrap">OpenAI : {routerBaseUrl}</div>
            <div className="whitespace-nowrap">Anthropic : {routerAnthropicBaseUrl}</div>
            <div className="whitespace-nowrap flex items-center justify-center gap-1.5">
              <span>Tokens : {totalTokens.toLocaleString()}</span>
              {totalTokens > 0 && (
                <button
                  type="button"
                  onClick={() => void resetRouterTokens()}
                  title={t('btn.resetTokens')}
                  aria-label={t('btn.resetTokens')}
                  className="text-cyber-text-muted hover:text-cyber-accent transition-colors"
                >
                  <RefreshCw size={10} />
                </button>
              )}
            </div>
          </div>
        </div>

        {selectedModels.length === 0 ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-center pointer-events-none">
            <div>
              <div className="font-medium text-sm text-cyber-text">
                {t('freeModels.router.emptyTitle')}
              </div>
              <div className="mt-2 text-xs text-cyber-text-muted">
                {t('freeModels.router.emptyDesc')}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              className="free-model-node-grid relative z-10"
              style={{
                gridTemplateColumns:
                  selectedModels.length >= 4
                    ? 'repeat(4, minmax(0, 1fr))'
                    : `repeat(${selectedModels.length}, minmax(140px, 190px))`,
                columnGap: NODE_COLUMN_GAP,
                rowGap: NODE_ROW_GAP,
                marginTop: HUB_TO_NODE_GAP,
              }}
            >
              {selectedModels.map((model) => {
                return (
                  <div
                    key={model.id}
                    ref={(node) => setNodeRef(model.id, node)}
                    className="free-model-route-node group relative min-h-[72px] rounded-lg p-3 pr-10 text-left flex flex-col justify-center"
                  >
                    <button
                      type="button"
                      onClick={() => void removeSelectedModel(model.id)}
                      className="absolute right-2 top-2 h-7 w-7 rounded-md flex items-center justify-center text-cyber-text-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-cyber-text hover:bg-cyber-text/10 transition-all"
                      aria-label={`${t('btn.remove')} ${shortModelName(model.modelId)}`}
                    >
                      <X size={14} />
                    </button>
                    <div className="text-xs font-semibold text-cyber-text truncate">
                      {shortModelName(model.modelId)}
                    </div>
                    <div className="mt-1 text-[10px] text-cyber-text-muted truncate">
                      {model.provider}
                    </div>
                    {/* Approximate tokens routed through this candidate */}
                    {tokenByNode[model.id] ? (
                      <div className="mt-1 text-[10px] text-cyber-text-muted/80 truncate flex items-center gap-1.5">
                        <span>{tokenByNode[model.id].toLocaleString()} tok</span>
                        <button
                          type="button"
                          onClick={() => void resetRouterTokens(model.id)}
                          title={t('btn.resetTokens')}
                          aria-label={`${t('btn.resetTokens')} ${shortModelName(model.modelId)}`}
                          className="text-cyber-text-muted/60 hover:text-cyber-accent transition-colors"
                        >
                          <X size={9} />
                        </button>
                      </div>
                    ) : null}
                    {/* Per-node latency probe: [测速] */}
                    <div className="mt-1 flex items-center gap-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => void pingNode(model)}
                        disabled={pingingNodeIds.has(model.id)}
                        aria-label={`${t('btn.ping')} ${shortModelName(model.modelId)}`}
                        title={t('btn.ping')}
                        className="flex-shrink-0 text-cyber-text-muted hover:text-cyber-accent transition-colors disabled:opacity-50"
                      >
                        <RefreshCw
                          size={10}
                          className={pingingNodeIds.has(model.id) ? 'animate-spin' : ''}
                        />
                      </button>
                      {pingingNodeIds.has(model.id) ? (
                        <span className="text-[10px] text-cyber-text-muted">…</span>
                      ) : nodeLatencies[model.id] === -1 ? (
                        <span className="text-[10px] font-bold text-red-500">Error</span>
                      ) : nodeLatencies[model.id] !== undefined ? (
                        <span
                          className={`text-[10px] ${
                            nodeLatencies[model.id] < 200
                              ? 'text-green-500'
                              : nodeLatencies[model.id] < 500
                                ? 'text-yellow-500'
                                : 'text-red-500'
                          }`}
                        >
                          {nodeLatencies[model.id]}ms
                        </span>
                      ) : (
                        <span className="text-[10px] text-cyber-text-muted/70">
                          {t('model.notTested')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FreeModelProviderRow({
  group,
  selected,
  onAdd,
}: {
  group: FreeModelProviderGroup;
  selected: boolean;
  onAdd: () => void;
}) {
  const { t } = useI18n();
  const iconSrc = getModelIcon(group.name, '');
  const hostname = (() => {
    try {
      return new URL(group.baseUrl).hostname;
    } catch {
      return group.baseUrl;
    }
  })();
  const openDocs = () => shellOpen(group.docsUrl).catch(() => window.open(group.docsUrl, '_blank'));

  return (
    <div className="free-model-provider-enter relative flex items-stretch rounded overflow-hidden bg-cyber-surface">
      <button
        type="button"
        onClick={onAdd}
        aria-label={`${t('freeModels.addToRouter')}: ${group.name}`}
        aria-pressed={selected}
        className="group/left flex-1 min-h-[64px] bg-gradient-to-r from-transparent to-transparent hover:from-cyber-text/15 hover:to-transparent transition-[background-image] duration-200"
      />
      <button
        type="button"
        onClick={openDocs}
        aria-label={`${t('freeModels.docs')}: ${group.name}`}
        className="group/right flex-1 min-h-[64px] bg-gradient-to-l from-transparent to-transparent hover:from-cyber-text/15 hover:to-transparent transition-[background-image] duration-200"
      />

      <div className="pointer-events-none absolute inset-0 flex items-center gap-3 px-3">
        {selected ? (
          <Check
            size={22}
            strokeWidth={2.5}
            className="flex-shrink-0 text-cyber-accent group-hover/left:scale-110 transition-all"
          />
        ) : (
          <Plus
            size={22}
            strokeWidth={2.5}
            className="flex-shrink-0 text-cyber-text-muted group-hover/left:text-cyber-text group-hover/left:scale-110 transition-all"
          />
        )}
        <div className="flex-shrink-0">
          {iconSrc ? (
            <img
              src={iconSrc}
              alt=""
              className="w-6 h-6"
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="w-6 h-6 flex items-center justify-center text-cyber-text">
              <Box size={22} />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="text-sm font-bold truncate leading-none">{group.name}</div>
          <div className="text-[10px] text-cyber-text-secondary truncate leading-tight mt-1 opacity-70">
            {hostname}
          </div>
        </div>
        <ExternalLink
          size={18}
          strokeWidth={2.25}
          className="flex-shrink-0 text-cyber-text-muted group-hover/right:text-cyber-text group-hover/right:scale-110 transition-all"
        />
      </div>
    </div>
  );
}

export function FreeModelsPanel() {
  const { t } = useI18n();
  const { models, customModels, selectedIds, refreshing, scanProvider, scanProgress, refresh } =
    useFreeModels();
  const { setNewModelForm, setEditingModelId, setModelModalDestination, setShowAddModelModal } =
    useModelNexus();
  const providerGroups = useMemo(() => {
    const groups = new Map<string, FreeModelProviderGroup>();
    models.forEach((model) => {
      const id = `${model.providerId}:${model.baseUrl}`;
      const group = groups.get(id);
      if (group) group.models.push(model);
      else {
        groups.set(id, {
          id,
          name: model.provider,
          baseUrl: model.baseUrl,
          docsUrl: model.docsUrl,
          models: [model],
        });
      }
    });
    return [...groups.values()].sort((left, right) => {
      return providerRank(left.models[0]) - providerRank(right.models[0]);
    });
  }, [models]);

  const openProvider = useCallback(
    (group: FreeModelProviderGroup) => {
      const modelIds = group.models.map((model) => model.modelId);
      setNewModelForm({
        name: group.name,
        baseUrl: group.baseUrl,
        anthropicUrl: '',
        apiKey: '',
        modelId: modelIds[0] ?? '',
        modelIdOptions: modelIds,
      });
      setEditingModelId(null);
      setModelModalDestination('freeRouter');
      setShowAddModelModal(true);
    },
    [setEditingModelId, setModelModalDestination, setNewModelForm, setShowAddModelModal]
  );

  const openCustomModel = useCallback(() => {
    setNewModelForm({
      name: '',
      baseUrl: '',
      anthropicUrl: '',
      apiKey: '',
      modelId: '',
    });
    setEditingModelId(null);
    setModelModalDestination('freeRouter');
    setShowAddModelModal(true);
  }, [setEditingModelId, setModelModalDestination, setNewModelForm, setShowAddModelModal]);

  return (
    <div className="free-model-router h-full min-h-0 flex flex-col">
      <div className="h-10 px-2 flex items-center gap-2 bg-transparent">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className={`flex-1 h-9 px-3 text-[14px] font-semibold border rounded-button transition-colors flex items-center justify-center gap-2 ${
            !refreshing
              ? 'border-cyber-border text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10'
              : 'border-cyber-border text-cyber-text-muted cursor-not-allowed'
          }`}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {t('freeModels.fetch')}
        </button>
        <button
          type="button"
          onClick={openCustomModel}
          aria-label={t('freeModels.customAdd')}
          title={t('freeModels.customAdd')}
          className="w-9 h-9 flex items-center justify-center border border-cyber-border rounded-button text-cyber-text hover:bg-cyber-text/10 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
      {refreshing && (
        <div className="px-2 pb-2">
          <div className="h-1 rounded-full overflow-hidden bg-cyber-border/30">
            <div
              className="free-model-scan-progress h-full rounded-full bg-cyber-accent"
              style={{ width: `${Math.max(scanProgress, 0.04) * 100}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] text-cyber-text-secondary truncate">
            {scanProvider ? (
              <>
                {t('freeModels.scanning')}
                {scanProvider}
              </>
            ) : (
              <>
                {t('freeModels.scanConnecting')}
                <span className="free-model-scan-dots" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 p-2 overflow-y-auto">
        {providerGroups.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            {!refreshing && (
              <div className="text-xs text-cyber-text-muted text-center">
                {t('freeModels.fetchHint')}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {providerGroups.map((group) => (
              <FreeModelProviderRow
                key={group.id}
                group={group}
                selected={group.models.some((model) =>
                  customModels.some(
                    (routeModel) =>
                      selectedIds.has(routeModel.internalId) &&
                      routeModel.baseUrl === model.baseUrl &&
                      routeModel.modelId === model.modelId
                  )
                )}
                onAdd={() => openProvider(group)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
