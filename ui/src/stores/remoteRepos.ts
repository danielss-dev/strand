import { create } from 'zustand';
import { tauri, errMessage } from '../lib/tauri';
import { canonicalRemoteAddress, remoteHost, type RemoteEnvelope, type RemoteHealth, type RemoteReadOp, type RemoteResult } from '../lib/remoteRepos';
import type { Snapshot } from '../lib/types';

type Mode = 'status' | 'log' | 'diff' | 'review' | 'files';
interface State {
  address: string;
  health: string;
  error: string | null;
  busy: boolean;
  mode: Mode;
  since: string;
  snapshot: Snapshot | null;
  result: RemoteResult | null;
  generation: number;
  recents: string[];
  connect: (address: string) => Promise<void>;
  refresh: () => Promise<void>;
  disconnect: () => Promise<void>;
  selectMode: (mode: Mode, since?: string) => Promise<void>;
  healthEvent: (event: RemoteHealth) => void;
}
let generation = 0;
let refreshRun: Promise<void> | null = null;
let trailing = false;
const requests = new Set<string>();
function loadRecents(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('strand:ssh-recents:v1') ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('ssh://') && item.length < 8192).slice(0, 16) : []; } catch { return []; }
}
async function read(address: string, op: RemoteReadOp): Promise<RemoteEnvelope> {
  const id = crypto.randomUUID(); requests.add(id);
  try { return await tauri.remoteRepoRead(address, op, id); }
  finally { requests.delete(id); }
}
function cancelReads() { for (const id of requests) void tauri.remoteRepoCancel(id); }

export const useRemoteRepos = create<State>((set, get) => ({
  address: '', health: 'disconnected', error: null, busy: false, mode: 'status', since: 'HEAD', snapshot: null, result: null, generation: 0, recents: loadRecents(),
  connect: async (address) => {
    const old = get().address;
    const token = ++generation;
    cancelReads();
    set({ address, health: 'connecting', busy: true, error: null, snapshot: null, result: null, generation: token });
    try {
      if (old) await tauri.remoteRepoDisconnect(old);
      if (token !== generation) return;
      const meta = await read(address, { kind: 'meta' });
      if (token !== generation) return;
      const canonical = canonicalRemoteAddress(address, meta.repository);
      set({ address: canonical });
      // Subscribe before the first snapshot so there is no lost-write gap.
      await tauri.remoteRepoWatch(canonical, true);
      if (token !== generation) return;
      const recents = [canonical, ...get().recents.filter((item) => item !== canonical)].slice(0, 16);
      try { localStorage.setItem('strand:ssh-recents:v1', JSON.stringify(recents)); } catch { /* Inspection still works when storage is unavailable. */ }
      set({ health: 'connected', recents });
      await get().refresh();
    } catch (error) { if (token === generation) set({ health: 'disconnected', error: errMessage(error) }); }
    finally { if (token === generation) set({ busy: false }); }
  },
  refresh: () => {
    if (refreshRun) { trailing = true; return refreshRun; }
    refreshRun = (async () => {
      do {
        trailing = false;
        const token = generation;
        const { address, mode, since } = get();
        if (!address) return;
        set({ busy: true, error: null });
        try {
          const snapshot = await read(address, { kind: 'snapshot' });
          if (token !== generation || trailing) continue;
          if (snapshot.result.kind !== 'snapshot') throw new Error('Remote snapshot response has the wrong type.');
          const op: RemoteReadOp | null = mode === 'log' ? { kind: 'log', limit: 50, head_only: true }
            : mode === 'diff' ? { kind: 'diff', source: { kind: 'since', revision: 'HEAD', full_context: true } }
              : mode === 'review' ? { kind: 'review', since, limit: 50 } : null;
          const result = op ? (await read(address, op)).result : null;
          if (token !== generation || trailing) continue;
          await tauri.remoteRepoWatch(address, true); // Restore watch after a read reconnects.
          if (token !== generation || trailing) continue;
          set({ snapshot: snapshot.result.data, result, health: 'connected' });
        } catch (error) {
          if (token === generation) {
            const message = errMessage(error);
            set({ error: message, health: /^(connection|protocol|timeout|cancelled):/.test(message) ? 'disconnected' : get().health });
          }
        }
        finally { if (token === generation) set({ busy: false }); }
      } while (trailing);
    })().finally(() => { refreshRun = null; });
    return refreshRun;
  },
  disconnect: async () => {
    ++generation;
    trailing = false;
    cancelReads();
    const address = get().address;
    set({ health: 'disconnected', busy: false, generation, error: null });
    if (address) await tauri.remoteRepoDisconnect(address);
  },
  selectMode: async (mode, since) => {
    ++generation;
    set({ mode, since: since ?? get().since, result: null, generation });
    await get().refresh();
  },
  healthEvent: (event) => {
    if (event.host !== remoteHost(get().address)) return;
    const reconnect = event.state === 'disconnected' && get().health === 'connected' && !get().busy;
    set({ health: event.state, error: event.error });
    if (reconnect) void get().refresh();
  },
}));
