import { invoke } from '@tauri-apps/api/core';
import type { ModelConfig } from './types';

export const SMART_ROUTER_CANDIDATE_LIMIT = 20;

export interface SmartRouterConfig {
  candidateIds: string[];
  usableCandidateCount: number;
  baseUrl: string;
  modelId: string;
  port: number;
  running: boolean;
}

export interface SmartRouterActivity {
  candidateId: string | null;
  active: boolean;
  sequence: number;
  updatedAtMs: number;
}

export interface SmartRouterTokenStat {
  internalId: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getSmartRouterConfig(): Promise<SmartRouterConfig> {
  return invoke('get_smart_router_config');
}

export async function getSmartRouterActivity(): Promise<SmartRouterActivity> {
  return invoke('get_smart_router_activity');
}

export async function setSmartRouterCandidates(candidateIds: string[]): Promise<SmartRouterConfig> {
  const result = await invoke<SmartRouterConfig>('set_smart_router_candidates', { candidateIds });
  window.dispatchEvent(new Event('models-changed'));
  return result;
}

export async function getSmartRouterCandidates(): Promise<ModelConfig[]> {
  return invoke('get_smart_router_candidates');
}

export async function getSmartRouterTokenStats(): Promise<SmartRouterTokenStat[]> {
  return invoke('get_smart_router_token_stats');
}

export async function resetSmartRouterTokenStats(internalId?: string): Promise<boolean> {
  const result = await invoke<boolean>('reset_smart_router_token_stats', {
    internalId: internalId ?? null,
  });
  return result;
}

export async function removeSmartRouterCandidate(internalId: string): Promise<SmartRouterConfig> {
  const result = await invoke<SmartRouterConfig>('remove_smart_router_candidate', { internalId });
  window.dispatchEvent(new Event('models-changed'));
  return result;
}
