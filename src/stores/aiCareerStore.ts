// AI-career page store — shares the selected tool family between the center
// page (family cards) and the right panel (session list), which App.tsx
// mounts in separate slots. Also carries the "refresh" signal: the title-bar
// refresh button bumps `refreshKey`, which both surfaces watch to re-scan
// disk (new sessions / messages created since the page first loaded).

import { create } from 'zustand';
import type { AiCareerFamily } from '../api/aiCareer';

interface AiCareerState {
  selectedFamily: AiCareerFamily;
  setSelectedFamily: (family: AiCareerFamily) => void;
  /// Display name per family id (visible families only) — lets the right
  /// panel label session rows / transcript popups without re-fetching.
  familyNames: Record<string, string>;
  setFamilyNames: (names: Record<string, string>) => void;
  refreshKey: number;
  refreshing: boolean;
  refresh: () => void;
  setRefreshing: (value: boolean) => void;
}

export const useAiCareerStore = create<AiCareerState>((set) => ({
  // Default to Claude so the right panel shows sessions immediately.
  selectedFamily: 'claude',
  setSelectedFamily: (family) => set({ selectedFamily: family }),
  familyNames: {},
  setFamilyNames: (names) => set({ familyNames: names }),
  refreshKey: 0,
  refreshing: false,
  refresh: () => set((s) => ({ refreshKey: s.refreshKey + 1, refreshing: true })),
  setRefreshing: (value) => set({ refreshing: value }),
}));
