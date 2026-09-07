// "添加家族" dialog + family icon helpers for 我的AI生涯.
//
// A custom family is either a DESKTOP app (user points at its log/data dir)
// or a CLI (user types the wake command; the backend auto-detects candidate
// history dirs under ~/.<cmd>, ~/.config/<cmd>, ... which we probe here and
// let the user pick). The icon is matched from the family name against the
// bundled tool-icon set, falling back to the app bird.

import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, MousePointerClick, RotateCcw, Search, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '../../hooks/useI18n';
import type { TKey } from '../../i18n';
import {
  aiCareerAddFamily,
  aiCareerProbeCli,
  aiCareerProbeDesktop,
  aiCareerProbeShortcut,
  type CareerFamily,
  type CliProbeResult,
} from '../../api/aiCareer';

/// Tool-icon stems we can auto-match a custom family name against.
const TOOL_ICON_STEMS = [
  'aider',
  'chatgptdesktop',
  'clashverge',
  'claude',
  'claudecode',
  'claudedesktop',
  'claudescience',
  'codex',
  'coffeecli',
  'cursor',
  'dsh',
  'geminidesktop',
  'grok',
  'hermes',
  'kilo',
  'kimicode',
  'mimocode',
  'openclaw',
  'opencode',
  'opencodedesktop',
  'openscience',
  'pi',
  'qwencode',
  'reversi',
  'trae',
  'traecn',
  'translator',
  'vibe-trading',
  'vscode',
  'workbuddy',
  'zcode',
];

/// Pick the best icon key for a family name: the longest tool stem the
/// normalised name starts with (case/space/punct-insensitive), else "default".
export function matchFamilyIcon(name: string): string {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return 'default';
  let best: string | null = null;
  for (const stem of TOOL_ICON_STEMS) {
    if (norm.startsWith(stem) && (best === null || stem.length > best.length)) {
      best = stem;
    }
  }
  return best ?? 'default';
}

export function FamilyIcon({ icon, name }: { icon: string; name: string }) {
  const key = icon && icon !== 'default' ? icon : null;
  const src = key ? `./icons/tools/${key}.svg` : '/brand/bird.png';
  const [current, setCurrent] = useState(src);
  return (
    <img
      src={current}
      alt={name}
      className="w-8 h-8 rounded-lg flex-shrink-0 object-contain"
      onError={() => {
        if (key && current.endsWith('.svg')) setCurrent(`./icons/tools/${key}.png`);
        else if (!key || current.endsWith('.png')) setCurrent('/brand/bird.png');
      }}
    />
  );
}

/// Human label for a backend store tag (literal keys so the i18n typing holds).
export function storeLabel(t: (k: TKey) => string, store: string): string {
  switch (store) {
    case 'none':
      return t('aiCareer.store.none');
    case 'custom-jsonl':
      return t('aiCareer.store.customJsonl');
    case 'dsh':
      return t('aiCareer.store.dsh');
    case 'opencode-db':
      return t('aiCareer.store.opencodeDb');
    case 'mimo-db':
      return t('aiCareer.store.mimoDb');
    case 'hermes-db':
      return t('aiCareer.store.hermesDb');
    case 'freebuff-desktop':
      return t('aiCareer.store.freebuffDesktop');
    case 'freebuff-cli':
      return t('aiCareer.store.freebuffCli');
    case 'claude-jsonl':
      return t('aiCareer.store.claudeJsonl');
    case 'codex-jsonl':
      return t('aiCareer.store.codexJsonl');
    case 'gemini-db':
      return t('aiCareer.store.gemini');
    default:
      return t('aiCareer.store.none');
  }
}

/// Radio-style list of probed candidate dirs (shared by the CLI auto-probe
/// and the desktop auto-scan) — click one to select it as the family's dir.
function CandidateList({
  probes,
  dir,
  onPick,
}: {
  probes: CliProbeResult[];
  dir: string;
  onPick: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1 pt-1">
      {probes.map((p) => (
        <button
          key={p.path}
          type="button"
          onClick={() => onPick(p.path)}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
            dir === p.path
              ? 'border-cyber-accent/70 bg-cyber-accent/10'
              : 'border-cyber-border/40 hover:bg-cyber-text/5'
          }`}
        >
          <span
            className={`w-3 h-3 rounded-full border flex-shrink-0 ${
              dir === p.path ? 'border-cyber-accent bg-cyber-accent' : 'border-cyber-text-muted'
            }`}
          />
          <span className="flex-1 min-w-0">
            <span className="block text-xs text-cyber-text truncate">{p.path}</span>
          </span>
          <span className="text-[10px] text-cyber-text-muted flex-shrink-0">
            {storeLabel(t, p.store)}
          </span>
        </button>
      ))}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function FamilyManageDialog({ open, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'desktop' | 'cli'>('desktop');
  const [dir, setDir] = useState('');
  const [command, setCommand] = useState('');
  const [probes, setProbes] = useState<CliProbeResult[]>([]);
  const [probed, setProbed] = useState(false);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const reset = () => {
    setName('');
    setKind('desktop');
    setDir('');
    setCommand('');
    setProbes([]);
    setProbed(false);
    setError('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string') setDir(picked);
  };

  const runProbe = async () => {
    const cmd = command.trim();
    if (!cmd) {
      setError(t('aiCareer.errCommandRequired'));
      return;
    }
    setError('');
    setProbing(true);
    try {
      const list = await aiCareerProbeCli(cmd);
      setProbes(list);
      setProbed(true);
      // Auto-select the first hit whose store isn't "none" if we have none yet.
      if (!dir) {
        const useful = list.find((p) => p.store !== 'none') ?? list[0];
        if (useful) setDir(useful.path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  // Scan the well-known desktop data roots. Manual only — the dialog never
  // probes on open, and results are suggestions (nothing is auto-selected),
  // mirroring the CLI flow where probing starts only after the user's action.
  const scanDesktop = async () => {
    setError('');
    setProbing(true);
    try {
      const list = await aiCareerProbeDesktop();
      setProbes(list);
      setProbed(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  // Pick a desktop shortcut / launcher file and let the backend match it to
  // the program's known data dirs. Results are suggestions with the same
  // auto-select-first-useful rule as the CLI probe.
  const pickShortcut = async () => {
    setError('');
    let picked: string | null = null;
    try {
      const r = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: 'launchers',
            extensions: ['lnk', 'desktop', 'exe', 'bat', 'cmd', 'app'],
          },
        ],
      });
      picked = typeof r === 'string' ? r : Array.isArray(r) ? r[0] : null;
    } catch {
      // Some file dialogs reject filters — retry without them.
      try {
        const r = await openDialog({ multiple: false, directory: false });
        picked = typeof r === 'string' ? r : Array.isArray(r) ? r[0] : null;
      } catch {
        /* dialog cancelled or unavailable */
      }
    }
    if (!picked) return;
    setProbing(true);
    try {
      const list = await aiCareerProbeShortcut(picked);
      setProbes(list);
      setProbed(true);
      if (!dir) {
        const useful = list.find((p) => p.store !== 'none') ?? list[0];
        if (useful) setDir(useful.path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    const cmd = command.trim();
    if (!trimmedName) {
      setError(t('aiCareer.errNameRequired'));
      return;
    }
    if (kind === 'desktop' && !dir) {
      setError(t('aiCareer.errDirRequired'));
      return;
    }
    if (kind === 'cli' && !cmd) {
      setError(t('aiCareer.errCommandRequired'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      await aiCareerAddFamily({
        name: trimmedName,
        kind,
        ...(kind === 'cli' ? { command: cmd } : {}),
        ...(dir ? { dir } : {}),
        icon: matchFamilyIcon(trimmedName),
      });
      reset();
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />

      {/* Dialog */}
      <div
        className="relative w-[480px] max-w-[92vw] border border-cyber-border/40 bg-cyber-surface shadow-2xl rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-[2px] w-full bg-cyber-border" />

        {/* Header */}
        <div className="px-5 pt-4 pb-3 flex items-center justify-between">
          <span className="text-sm font-mono font-bold tracking-wider text-cyber-text">
            {t('aiCareer.addFamily')}
          </span>
          <button
            type="button"
            onClick={close}
            className="p-1 rounded-md text-cyber-text-muted hover:text-cyber-text hover:bg-cyber-text/10 transition-colors"
            aria-label={t('btn.close')}
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-5 space-y-4 pb-5 max-h-[70vh] overflow-y-auto slim-scroll">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-mono font-bold tracking-wider text-cyber-text-secondary uppercase">
              {t('aiCareer.familyName')}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('aiCareer.namePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-cyber-elevated border border-cyber-border/50 rounded-lg text-cyber-text placeholder:text-cyber-text-muted outline-none focus:border-cyber-accent/60 transition-colors"
            />
            {/* Live icon preview */}
            <div className="flex items-center gap-2 text-[11px] text-cyber-text-secondary">
              <FamilyIcon icon={matchFamilyIcon(name)} name={name || ' '} />
              <span>{t('aiCareer.iconHint')}</span>
            </div>
          </div>

          {/* Kind */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              {(['desktop', 'cli'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    setProbed(false);
                    setProbes([]);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-mono font-bold tracking-wider transition-colors ${
                    kind === k
                      ? 'border-cyber-accent/70 bg-cyber-accent/10 text-cyber-accent'
                      : 'border-cyber-border/50 text-cyber-text-secondary hover:bg-cyber-text/5'
                  }`}
                >
                  {k === 'desktop' ? t('aiCareer.kindDesktop') : t('aiCareer.kindCli')}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-cyber-text-secondary leading-relaxed">
              {kind === 'desktop' ? t('aiCareer.desktopHint') : t('aiCareer.cliHint')}
            </p>
          </div>

          {kind === 'desktop' ? (
            /* Desktop: auto-scan default data roots + manual fallback */
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void scanDesktop()}
                  disabled={probing || busy}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyber-border/60 text-xs font-mono font-bold tracking-wider text-cyber-text hover:bg-cyber-text/5 disabled:opacity-50 transition-colors"
                >
                  {probing ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                  {probing ? t('aiCareer.detecting') : t('aiCareer.scanDesktop')}
                </button>
              </div>
              <p className="text-[11px] text-cyber-text-muted leading-relaxed">
                {t('aiCareer.desktopScanHint')}
              </p>

              {/* Second desktop path: pick a shortcut / launcher file and let
                  the backend auto-match it to the program's known stores. */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pickShortcut()}
                  disabled={probing || busy}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyber-border/60 text-xs font-mono font-bold tracking-wider text-cyber-text hover:bg-cyber-text/5 disabled:opacity-50 transition-colors"
                >
                  {probing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <MousePointerClick size={13} />
                  )}
                  {probing ? t('aiCareer.detecting') : t('aiCareer.pickShortcut')}
                </button>
              </div>
              <p className="text-[11px] text-cyber-text-muted leading-relaxed">
                {t('aiCareer.shortcutHint')}
              </p>

              {probed && probes.length > 0 && (
                <CandidateList probes={probes} dir={dir} onPick={setDir} />
              )}
              {probed && probes.length === 0 && (
                <p className="text-[11px] text-cyber-warning leading-relaxed">
                  {t('aiCareer.noDesktopDirs')}
                </p>
              )}

              {/* Manual fallback: non-default installs */}
              <button
                type="button"
                onClick={pickDir}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[11px] text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/5 transition-colors"
              >
                <FolderOpen size={12} />
                {t('aiCareer.pickDirManual')}
              </button>
              {dir && (
                <p className="text-[11px] text-cyber-text-secondary break-all leading-relaxed">
                  <span className="text-cyber-text-muted">{t('aiCareer.dirLabel')}：</span>
                  {dir}
                </p>
              )}
            </div>
          ) : (
            /* CLI: wake command + auto-detect + manual fallback */
            <div className="space-y-1.5">
              <label className="block text-[11px] font-mono font-bold tracking-wider text-cyber-text-secondary uppercase">
                {t('aiCareer.cliCommand')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  value={command}
                  onChange={(e) => {
                    setCommand(e.target.value);
                    setProbed(false);
                  }}
                  placeholder={t('aiCareer.commandPlaceholder')}
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-cyber-elevated border border-cyber-border/50 rounded-lg text-cyber-text placeholder:text-cyber-text-muted outline-none focus:border-cyber-accent/60 transition-colors"
                />
                <button
                  type="button"
                  onClick={runProbe}
                  disabled={probing || busy}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyber-border/60 text-xs font-mono font-bold tracking-wider text-cyber-text hover:bg-cyber-text/5 disabled:opacity-50 transition-colors"
                >
                  {probing ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                  {probing ? t('aiCareer.detecting') : t('aiCareer.detectDirs')}
                </button>
              </div>
              <p className="text-[11px] text-cyber-text-muted leading-relaxed">
                {t('aiCareer.probeHint')}
              </p>

              {probed && probes.length > 0 && (
                <CandidateList probes={probes} dir={dir} onPick={setDir} />
              )}
              {probed && probes.length === 0 && (
                <p className="text-[11px] text-cyber-warning leading-relaxed">
                  {t('aiCareer.noDirsFound')}
                </p>
              )}

              {/* Manual fallback for CLIs too */}
              <button
                type="button"
                onClick={pickDir}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[11px] text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/5 transition-colors"
              >
                <FolderOpen size={12} />
                {t('aiCareer.pickDirManual')}
              </button>
              {dir && (
                <p className="text-[11px] text-cyber-text-secondary break-all leading-relaxed">
                  <span className="text-cyber-text-muted">{t('aiCareer.dirLabel')}：</span>
                  {dir}
                </p>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
        </div>

        {/* Actions */}
        <div className="flex border-t border-cyber-border">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="flex-1 px-4 py-2.5 text-xs font-mono font-bold tracking-wider text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-elevated transition-all border-r border-cyber-border disabled:opacity-50"
          >
            {t('btn.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="flex-1 px-4 py-2.5 text-xs font-mono font-bold tracking-wider text-cyber-accent hover:bg-cyber-accent/10 transition-all disabled:opacity-50"
          >
            {t('btn.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// “已隐藏” restore dialog — mirrors the desktop-app hidden-tools dialog:
// click an item to restore it; custom families also get a corner delete (真删),
// built-ins can only be restored. Opened from the “+N” count badge.
interface HiddenFamiliesDialogProps {
  open: boolean;
  families: CareerFamily[];
  onClose: () => void;
  onRestore: (id: string) => void;
  onRestoreAll: () => void;
  onDelete: (fam: CareerFamily) => void;
}

export function HiddenFamiliesDialog({
  open,
  families,
  onClose,
  onRestore,
  onRestoreAll,
  onDelete,
}: HiddenFamiliesDialogProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Closed, or nothing hidden anymore (e.g. the last item was restored) → hide.
  if (!open || families.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-label={`${t('aiCareer.hidden')} (${families.length})`}
        onContextMenu={(e) => e.preventDefault()}
        className="relative w-[520px] max-w-[92vw] h-[40vh] flex flex-col rounded-xl border border-cyber-border bg-cyber-surface shadow-2xl overflow-hidden"
      >
        {/* Header: title + count + 全部恢复 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-cyber-border/60 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-cyber-text flex-shrink-0">
              {t('aiCareer.hidden')} ({families.length})
            </span>
            <button
              type="button"
              onClick={onRestoreAll}
              aria-label={t('aiCareer.hiddenRestoreAll')}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold border border-amber-500/70 text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
            >
              <RotateCcw size={12} />
              {t('aiCareer.hiddenRestoreAll')}
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('btn.close')}
            className="flex items-center justify-center w-7 h-7 rounded-md text-cyber-text-secondary hover:text-cyber-text hover:bg-cyber-text/10 transition-colors outline-none"
          >
            <X size={16} />
          </button>
        </div>

        {/* Hint strip */}
        <div className="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 border-b border-cyber-accent/25 bg-cyber-accent/10">
          <MousePointerClick size={14} className="flex-shrink-0 text-cyber-accent" />
          <span className="text-xs font-bold text-cyber-accent">
            {t('aiCareer.hiddenRestoreHint')}
          </span>
        </div>

        {/* Hidden family rows */}
        <div className="flex-1 overflow-y-auto pulse-scroll p-3 space-y-2">
          {families.map((fam) => (
            <div
              key={fam.id}
              className="relative group flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-cyber-border/40 bg-cyber-text/[0.02] hover:border-cyber-border/80 hover:bg-cyber-text/[0.05] transition-colors"
            >
              <button
                type="button"
                onClick={() => onRestore(fam.id)}
                title={t('aiCareer.unhide')}
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
              >
                <FamilyIcon icon={fam.icon} name={fam.name} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-cyber-text truncate">{fam.name}</span>
                  {fam.dir && (
                    <span className="block text-[11px] text-cyber-text-muted truncate">
                      {fam.dir}
                    </span>
                  )}
                </span>
                <RotateCcw
                  size={14}
                  className="flex-shrink-0 text-cyber-text-muted group-hover:text-cyber-accent transition-colors"
                />
              </button>
              {!fam.builtin && (
                <button
                  type="button"
                  onClick={() => onDelete(fam)}
                  aria-label={t('aiCareer.delete')}
                  title={t('aiCareer.delete')}
                  className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-red-500/15 text-red-400 hover:bg-red-500 hover:text-white transition-colors outline-none"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
