import { create } from 'zustand';

import { pathKey } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequestList } from '../lib/types';

export interface BranchIntegrationRecord {
  status: 'loading' | 'loaded' | 'error';
  data: PullRequestList | null;
  error: string | null;
}

interface BranchIntegrationState {
  records: Record<string, BranchIntegrationRecord>;
  refresh(path: string, force?: boolean): Promise<void>;
}

const requests = new Map<string, Promise<void>>();

export const useBranchIntegration = create<BranchIntegrationState>((set, get) => ({
  records: {},

  async refresh(path, force = false) {
    const key = pathKey(path);
    const current = get().records[key];
    if (!force && current?.status === 'loaded') return;
    const pending = requests.get(key);
    if (pending) return pending;

    set((state) => ({
      records: {
        ...state.records,
        [key]: { status: 'loading', data: current?.data ?? null, error: null },
      },
    }));
    const request = tauri.repoPullRequests(path).then(
      (data) => set((state) => ({
        records: { ...state.records, [key]: { status: 'loaded', data, error: null } },
      })),
      (error) => set((state) => ({
        records: {
          ...state.records,
          [key]: { status: 'error', data: current?.data ?? null, error: errMessage(error) },
        },
      })),
    ).finally(() => {
      requests.delete(key);
    });
    requests.set(key, request);
    return request;
  },
}));
