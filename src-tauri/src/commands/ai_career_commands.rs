//! Tauri command wrappers for the "我的AI生涯" (My AI Career) page.
//! Thin layer over [`crate::services::ai_career`]; the file I/O runs on the
//! blocking thread pool so it never stalls the IPC dispatcher.

use crate::services::ai_career::{
    self, AddFamilyDraft, CareerFamily, ChatTranscript, CliProbeResult, FamilyHourSeries,
    HeatmapEntry, HistoryPage, HistorySearchReq, HistorySyncReq, HistorySyncResult, SavedSession,
};

/// The full family list (built-ins + custom families), resolved for the
/// frontend grid. Hidden families are included but flagged so the UI can offer
/// an unhide affordance; aggregations exclude them.
#[tauri::command]
pub async fn ai_career_get_families() -> Result<Vec<CareerFamily>, String> {
    tauri::async_runtime::spawn_blocking(ai_career::get_families)
        .await
        .map_err(|e| format!("families task join failed: {e}"))
}

/// Auto-detect candidate history dirs for a CLI wake command (`~/.<cmd>`,
/// `~/.config/<cmd>`, `~/.local/share/<cmd>`, …). Only existing dirs are
/// returned, each tagged with its detected store layout.
#[tauri::command]
pub async fn ai_career_probe_cli(command: String) -> Result<Vec<CliProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::probe_cli(&command))
        .await
        .map_err(|e| format!("probe task join failed: {e}"))
}

/// Auto-scan well-known data roots for DESKTOP app stores (default installs
/// only). Returns existing dirs holding a recognisable layout, each tagged
/// with its store; dirs already covered by the built-ins or a custom family
/// are excluded. Non-default installs keep the manual folder pick.
#[tauri::command]
pub async fn ai_career_probe_desktop() -> Result<Vec<CliProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(ai_career::probe_desktop)
        .await
        .map_err(|e| format!("probe task join failed: {e}"))
}

/// Match a picked desktop shortcut / launcher (`.lnk`, `.desktop` or an
/// executable) to the well-known data dirs of the program it points at. Each
/// hit is tagged with its detected store layout; empty when nothing matches.
#[tauri::command]
pub async fn ai_career_probe_shortcut(path: String) -> Result<Vec<CliProbeResult>, String> {
    if path.trim().is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || ai_career::probe_shortcut(path))
        .await
        .map_err(|e| format!("probe task join failed: {e}"))
}

/// Register a custom family (name + desktop log dir OR cli command with
/// auto-detected dir). Errors carry a user-facing message.
#[tauri::command]
pub async fn ai_career_add_family(draft: AddFamilyDraft) -> Result<CareerFamily, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::add_custom_family(draft))
        .await
        .map_err(|e| format!("add family task join failed: {e}"))?
}

/// Hide/unhide a family (built-in or custom). Hidden families drop out of the
/// stats, heatmap, history lists and the visible card grid.
#[tauri::command]
pub async fn ai_career_set_family_hidden(id: String, hidden: bool) -> Result<CareerFamily, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::set_family_hidden(&id, hidden))
        .await
        .map_err(|e| format!("hide family task join failed: {e}"))?
}

/// Permanently delete a custom family (its registration + cached scan data).
/// Built-ins can only be hidden.
#[tauri::command]
pub async fn ai_career_delete_family(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::delete_family(&id))
        .await
        .map_err(|e| format!("delete family task join failed: {e}"))?
}

/// Hour-by-hour activity (messages + approx content bytes), one 24-hour
/// series per family with activity on the given local `YYYY-MM-DD`. Feeds the
/// day-click popup's stacked per-family chart.
#[tauri::command]
pub async fn ai_career_day_detail(day: String) -> Result<Vec<FamilyHourSeries>, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::day_detail(&day))
        .await
        .map_err(|e| format!("day detail task join failed: {e}"))
}

/// One page of a single family's session history, newest first. The frontend
/// requests one family at a time (the selected family card) and pages in more
/// on scroll via `offset`.
#[tauri::command]
pub async fn ai_career_family_history(
    family: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<SavedSession>, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::history_for_id(&family, offset, limit))
        .await
        .map_err(|e| format!("history task join failed: {e}"))?
}

/// Contribution-heatmap entries across all VISIBLE families (drives the
/// heatmap grid and the five summary stats, which the frontend derives from
/// these). Hidden families are excluded server-side.
#[tauri::command]
pub async fn ai_career_heatmap() -> Result<Vec<HeatmapEntry>, String> {
    tauri::async_runtime::spawn_blocking(ai_career::message_heatmap)
        .await
        .map_err(|e| format!("heatmap task join failed: {e}"))
}

/// Total on-disk byte size across all VISIBLE families' session files — the
/// frontend divides this by a bytes-per-token ratio for the approximate ("≈")
/// cumulative token count.
#[tauri::command]
pub async fn ai_career_token_bytes() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(ai_career::estimate_token_bytes)
        .await
        .map_err(|e| format!("token estimate task join failed: {e}"))
}

/// Multi-family history search (the 查看历史记录 dialog): keyword (title +
/// message body) × date window × family selection. Returns ONE newest-first
/// page; echo the returned `cursors` back to page deeper without re-scanning.
#[tauri::command]
pub async fn ai_career_search_history(req: HistorySearchReq) -> Result<HistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::search_history(&req))
        .await
        .map_err(|e| format!("search task join failed: {e}"))?
}

/// Full chat of one session, re-read from its on-disk layout. `file_path` is
/// the session file (dir layouts) or the db file (SQLite layouts — then
/// `session_token` is the row id).
#[tauri::command]
pub async fn ai_career_session_transcript(
    family: String,
    session_token: Option<String>,
    file_path: String,
) -> Result<Option<ChatTranscript>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_career::session_transcript(&family, session_token.as_deref(), &file_path)
    })
    .await
    .map_err(|e| format!("transcript task join failed: {e}"))?
}

/// Manual history sync (the history dialog): force a re-scan by dropping the
/// relevant caches — all of the selected families, one day, or one session
/// row (which returns the refreshed hit).
#[tauri::command]
pub async fn ai_career_sync_history(req: HistorySyncReq) -> Result<HistorySyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || ai_career::sync_history(&req))
        .await
        .map_err(|e| format!("sync task join failed: {e}"))?
}
