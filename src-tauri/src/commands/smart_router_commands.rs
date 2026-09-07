use crate::models::model::ModelConfig;
use crate::services::smart_router::{self, PublicActivity, PublicConfig, TokenStat};

#[tauri::command]
pub fn get_smart_router_config() -> Result<PublicConfig, String> {
    smart_router::get_public_config()
}

#[tauri::command]
pub fn get_smart_router_activity() -> PublicActivity {
    smart_router::get_public_activity()
}

#[tauri::command]
pub fn set_smart_router_candidates(candidate_ids: Vec<String>) -> Result<PublicConfig, String> {
    smart_router::set_candidate_ids(candidate_ids)
}

#[tauri::command]
pub fn get_smart_router_candidates() -> Vec<ModelConfig> {
    smart_router::get_candidate_models()
}

#[tauri::command]
pub fn remove_smart_router_candidate(internal_id: String) -> Result<PublicConfig, String> {
    smart_router::remove_candidate(&internal_id)
}

#[tauri::command]
pub fn get_smart_router_token_stats() -> Vec<TokenStat> {
    smart_router::token_stats()
}

#[tauri::command]
pub fn reset_smart_router_token_stats(internal_id: Option<String>) -> bool {
    smart_router::reset_token_stats(internal_id);
    true
}
