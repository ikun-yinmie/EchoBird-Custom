// "我的AI生涯" (My AI Career) IPC layer — cross-tool session history,
// contribution heatmap, and profile avatar. Backed by the Rust
// `ai_career` service + `set_avatar` / `get_avatar` commands.

import { invoke } from '@tauri-apps/api/core';

/// A family id — one of the six built-ins ("claude", "codex", ...) or a
/// user-registered custom family id served by the backend.
export type AiCareerFamily = string;

/// One resolved family (built-in or custom) as rendered by the family grid.
/// Hidden families are still listed (flagged) so the UI can offer an unhide
/// affordance; every aggregation excludes them server-side.
export interface CareerFamily {
  id: AiCareerFamily;
  name: string;
  builtin: boolean;
  /// "builtin" | "desktop" | "cli".
  kind: string;
  command: string | null;
  /// Resolved store root (built-in defaults resolved on the backend).
  dir: string;
  /// Tool-icon key matched at add time; "default" when nothing matched.
  icon: string;
  /// Detected layout tag (claude-jsonl, codex-jsonl, opencode-db, ...).
  store: string;
  hidden: boolean;
}

/// One auto-detected candidate history dir for a CLI wake command.
export interface CliProbeResult {
  path: string;
  store: string;
}

export interface AddFamilyDraft {
  name: string;
  kind: 'desktop' | 'cli';
  command?: string;
  dir?: string;
  icon?: string;
}

export interface SavedSession {
  id: string;
  name: string;
  tool: string;
  cwd: string;
  session_token: string | null;
  saved_at: string;
  file_path: string | null;
  turn_count: number | null;
}

export interface HeatmapEntry {
  /// File mtime, seconds since the UNIX epoch.
  ts: number;
  /// Approximate message count for the session.
  count: number;
}

/// One hour bucket of a day (hour 0..23).
/// `bytes` is approximate content volume; the chart multiplies by the usual
/// bytes→token ratio for the "≈ tokens" series.
export interface DayHourBucket {
  hour: number;
  requests: number;
  bytes: number;
}

/// One family's 24-hour series for a day. Only families with activity on
/// that day are returned.
export interface FamilyHourSeries {
  family: string;
  name: string;
  buckets: DayHourBucket[];
}

/// One message of a chat transcript.
export interface ChatMsg {
  role: string; // "user" | "assistant"
  text: string;
  /// Epoch seconds when the store records it.
  ts?: number;
  /// Model that produced the message, when the store records one (per
  /// message, or the thread's model on every assistant bubble).
  model?: string;
}

/// Full chat of one session (the transcript popup).
export interface ChatTranscript {
  family: AiCareerFamily;
  family_name: string;
  session: SavedSession;
  messages: ChatMsg[];
}

/// Multi-family history-search request.
export interface HistorySearchReq {
  /// Empty = every visible family.
  family_ids: AiCareerFamily[];
  /// Keyword matched against session titles AND message bodies.
  query?: string;
  /// YYYY-MM-DD (local), inclusive.
  date_from?: string;
  /// YYYY-MM-DD (local), inclusive.
  date_to?: string;
  /** How many hits this page should return. */
  limit?: number;
  /** Per-family consumed counts from the previous page of the SAME filter. */
  cursors?: Record<string, number>;
}

/// One search hit — a session card in the history dialog.
export interface HistoryHit {
  family: AiCareerFamily;
  family_name: string;
  session: SavedSession;
  /// Window around the first body match (null for title-only / browse hits).
  snippet: string | null;
  /// Messages whose body matched the keyword (0 = title-only).
  match_count: number;
}

/// One page of merged, newest-first results. Paging is cursor-based: echo
/// `cursors` back on the next page of the same filter to continue without
/// re-scanning what earlier pages already walked past.
export interface HistoryPage {
  hits: HistoryHit[];
  cursors: Record<string, number>;
  /// Every candidate of every selected family was consumed — no more pages.
  done: boolean;
}

/// Manual history sync scope: "all" (the selected families' whole stores),
/// "day" (one YYYY-MM-DD of them), or "session" (one result row, which
/// returns a refreshed hit).
export type HistorySyncScope = 'all' | 'day' | 'session';

/// Request for a manual history sync (drops the relevant caches; the next
/// read re-scans from disk).
export interface HistorySyncReq {
  /// Empty = every visible family; exactly one id for a session sync.
  family_ids: AiCareerFamily[];
  scope: HistorySyncScope;
  /// scope "day": the local YYYY-MM-DD whose cached series should be dropped.
  day?: string;
  /// scope "session": keyword to re-match the refreshed row against.
  query?: string;
  /// scope "session": session file (dir layouts) or db file (SQLite layouts).
  file_path?: string;
  session_token?: string;
}

/// What a sync dropped. A session sync carries the refreshed row in `hit`
/// (updated title / snippet / match count after re-reading the store).
/// `duration_ms` is the backend pass time; `affected_days` lists which cached
/// days were touched (for the all/day scopes).
export interface HistorySyncResult {
  cleared_bodies: number;
  cleared_counts: number;
  cleared_days: number;
  duration_ms: number;
  affected_days: string[];
  hit: HistoryHit | null;
}

/// The full family list (built-ins + customs), resolved by the backend.
export async function aiCareerGetFamilies(): Promise<CareerFamily[]> {
  return invoke('ai_career_get_families');
}

/// Auto-detect candidate history dirs for a CLI wake command.
export async function aiCareerProbeCli(command: string): Promise<CliProbeResult[]> {
  return invoke('ai_career_probe_cli', { command });
}

/// Auto-scan the well-known data roots for DESKTOP app stores (default
/// installs only; non-default installs fall back to the manual folder pick).
export async function aiCareerProbeDesktop(): Promise<CliProbeResult[]> {
  return invoke('ai_career_probe_desktop');
}

/// Match a picked desktop shortcut / launcher (`.lnk`, `.desktop` or an
/// executable) to the well-known data dirs of the program it points at,
/// each tagged with its detected store layout. Empty when nothing matches.
export async function aiCareerProbeShortcut(path: string): Promise<CliProbeResult[]> {
  return invoke('ai_career_probe_shortcut', { path });
}

/// Register a custom family. Errors carry a user-facing message.
export async function aiCareerAddFamily(draft: AddFamilyDraft): Promise<CareerFamily> {
  return invoke('ai_career_add_family', { draft });
}

/// Hide / unhide a family. Hidden families drop out of stats + lists.
export async function aiCareerSetFamilyHidden(
  id: AiCareerFamily,
  hidden: boolean
): Promise<CareerFamily> {
  return invoke('ai_career_set_family_hidden', { id, hidden });
}

/// Permanently delete a custom family.
export async function aiCareerDeleteFamily(id: AiCareerFamily): Promise<void> {
  return invoke('ai_career_delete_family', { id });
}

/// One page of a single family's session history, newest first. The page is
/// scanned + parsed on the Rust side; the caller pages in more via `offset`.
export async function aiCareerFamilyHistory(
  family: AiCareerFamily,
  offset: number,
  limit: number
): Promise<SavedSession[]> {
  return invoke('ai_career_family_history', { family, offset, limit });
}

/// Multi-family history search: keyword × date window × family selection.
/// Returns ONE newest-first page; pass the returned `cursors` back to page
/// deeper without re-scanning earlier sessions. `family_ids` empty = every
/// visible family.
export async function aiCareerSearchHistory(req: HistorySearchReq): Promise<HistoryPage> {
  return invoke('ai_career_search_history', { req });
}

/// Manual history sync: drop the caches behind the history/heatmap/day views
/// so the next read re-scans the selected families (whole store, one day, or
/// one session row — the latter returns the refreshed hit).
export async function aiCareerSyncHistory(req: HistorySyncReq): Promise<HistorySyncResult> {
  return invoke('ai_career_sync_history', { req });
}

/// Full chat of one session, re-read from its on-disk store. `filePath` is
/// the session file (dir layouts) or the db file (SQLite layouts).
export async function aiCareerSessionTranscript(
  family: AiCareerFamily,
  filePath: string,
  sessionToken: string | null
): Promise<ChatTranscript | null> {
  return invoke('ai_career_session_transcript', {
    family,
    filePath,
    sessionToken,
  });
}

/// Contribution-heatmap entries across all six families (210-day lookback).
export async function aiCareerHeatmap(): Promise<HeatmapEntry[]> {
  return invoke('ai_career_heatmap');
}

/// Hour-by-hour activity (messages + approx content bytes), one 24-hour
/// series per family with activity on the local `YYYY-MM-DD` day — drives the
/// day popup's stacked per-family chart.
export async function aiCareerDayDetail(day: string): Promise<FamilyHourSeries[]> {
  return invoke('ai_career_day_detail', { day });
}

/// Total on-disk byte size across all six families' session files. The
/// frontend divides this by a bytes-per-token ratio for an approximate ("≈")
/// cumulative token count — works even when a provider doesn't report real
/// usage (third-party models often log 0), since it measures content volume.
export async function aiCareerTokenBytes(): Promise<number> {
  return invoke('ai_career_token_bytes');
}

/// Set the profile avatar from a user-picked image file (re-encoded to a
/// 256px PNG on the Rust side).
export async function setAvatar(sourcePath: string): Promise<void> {
  return invoke('set_avatar', { sourcePath });
}

/// Read the stored avatar as a base64 PNG data URI, or `null` if unset.
export async function getAvatar(): Promise<string | null> {
  return invoke('get_avatar');
}
