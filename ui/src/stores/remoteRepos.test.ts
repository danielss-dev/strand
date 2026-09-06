import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteEnvelope } from '../lib/remoteRepos';
import type { Snapshot } from '../lib/types';

const tauri = vi.hoisted(() => ({ remoteRepoRead: vi.fn(), remoteRepoCancel: vi.fn(), remoteRepoDisconnect: vi.fn(), remoteRepoWatch: vi.fn() }));
vi.mock('../lib/tauri', () => ({ tauri, errMessage: (e: unknown) => e instanceof Error ? e.message : String(e) }));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
import { useRemoteRepos } from './remoteRepos';
const initial = useRemoteRepos.getState();
const snapshot: Snapshot = {
  meta: { name: 'repo', path: '/repo', branch: 'main', head_oid: 'abc', ahead: 0, behind: 0, detached: false, operation: null, common_dir: '/repo/.git', is_linked_worktree: false },
  status: [], work_tree: [], refs: { branches: [], primary_branch: null, remote_branches: [], tags: [], remotes: [] }, submodules: [],
};
const envelope = (repository = '/repo'): RemoteEnvelope => ({ schemaVersion: 1, repository, result: { kind: 'snapshot', data: snapshot } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks();
  tauri.remoteRepoRead.mockReset().mockResolvedValue(envelope());
  tauri.remoteRepoWatch.mockReset().mockResolvedValue(undefined);
  tauri.remoteRepoDisconnect.mockResolvedValue(undefined);
  tauri.remoteRepoCancel.mockResolvedValue(undefined);
  useRemoteRepos.setState(initial, true);
});
afterEach(async () => { await useRemoteRepos.getState().disconnect(); });

describe('remote inspection lifecycle', () => {
  it('canonicalizes the remote identity and subscribes before the first snapshot', async () => {
    tauri.remoteRepoRead.mockResolvedValueOnce({ ...envelope('/space repo'), result: { kind: 'meta', data: snapshot.meta } });
    await useRemoteRepos.getState().connect('ssh://DevBox/alias');
    expect(useRemoteRepos.getState()).toMatchObject({ address: 'ssh://devbox/space%20repo', health: 'connected', snapshot, busy: false });
    expect(tauri.remoteRepoWatch.mock.invocationCallOrder[0]).toBeLessThan(tauri.remoteRepoRead.mock.invocationCallOrder[1]);
    expect(useRemoteRepos.getState().recents).toEqual(['ssh://devbox/space%20repo']);
  });

  it('coalesces a watch burst and publishes only the trailing snapshot', async () => {
    useRemoteRepos.setState({ address: 'ssh://box/repo', health: 'connected' });
    const old = deferred<RemoteEnvelope>();
    tauri.remoteRepoRead.mockReturnValueOnce(old.promise);
    const run = useRemoteRepos.getState().refresh();
    for (let n = 0; n < 30; n++) void useRemoteRepos.getState().refresh();
    old.resolve(envelope('/stale'));
    await run;
    expect(tauri.remoteRepoRead).toHaveBeenCalledTimes(2);
    expect(tauri.remoteRepoWatch).toHaveBeenCalledTimes(1);
    expect(useRemoteRepos.getState().snapshot).toEqual(snapshot);
  });

  it('ignores reads that complete after disconnect and does not reconnect on its own close event', async () => {
    useRemoteRepos.setState({ address: 'ssh://box/repo', health: 'connected' });
    const pending = deferred<RemoteEnvelope>();
    tauri.remoteRepoRead.mockReturnValueOnce(pending.promise);
    const run = useRemoteRepos.getState().refresh();
    await useRemoteRepos.getState().disconnect();
    useRemoteRepos.getState().healthEvent({ host: 'box', state: 'disconnected', error: null });
    pending.resolve(envelope()); await run;
    expect(tauri.remoteRepoCancel).toHaveBeenCalledTimes(1);
    expect(tauri.remoteRepoRead).toHaveBeenCalledTimes(1);
    expect(useRemoteRepos.getState()).toMatchObject({ health: 'disconnected', snapshot: null, busy: false });
  });

  it('switches hosts while the previous refresh is pending without publishing old data', async () => {
    useRemoteRepos.setState({ address: 'ssh://old/repo', health: 'connected' });
    const pending = deferred<RemoteEnvelope>();
    tauri.remoteRepoRead.mockReturnValueOnce(pending.promise);
    const run = useRemoteRepos.getState().refresh();
    const connect = useRemoteRepos.getState().connect('ssh://new/repo');
    await vi.waitFor(() => expect(tauri.remoteRepoWatch).toHaveBeenCalled());
    pending.resolve(envelope('/old')); await Promise.all([run, connect]);
    expect(useRemoteRepos.getState()).toMatchObject({ address: 'ssh://new/repo', health: 'connected', snapshot, busy: false });
    expect(tauri.remoteRepoRead.mock.calls.at(-1)?.[0]).toBe('ssh://new/repo');
  });

  it('reconnects once after an idle drop and leaves a final failure visible', async () => {
    useRemoteRepos.setState({ address: 'ssh://box/repo', health: 'connected' });
    tauri.remoteRepoRead.mockRejectedValue(new Error('connection: host unavailable'));
    useRemoteRepos.getState().healthEvent({ host: 'unrelated', state: 'disconnected', error: 'ignore' });
    expect(tauri.remoteRepoRead).not.toHaveBeenCalled();
    useRemoteRepos.getState().healthEvent({ host: 'box', state: 'disconnected', error: 'lost' });
    await vi.waitFor(() => expect(useRemoteRepos.getState().busy).toBe(false));
    useRemoteRepos.getState().healthEvent({ host: 'box', state: 'disconnected', error: 'final' });
    expect(tauri.remoteRepoRead).toHaveBeenCalledTimes(1);
    expect(useRemoteRepos.getState().health).toBe('disconnected');
  });

  it('keeps a healthy connection usable after an invalid review base', async () => {
    useRemoteRepos.setState({ address: 'ssh://box/repo', health: 'connected', snapshot });
    tauri.remoteRepoRead.mockResolvedValueOnce(envelope()).mockRejectedValueOnce(new Error('repository: invalid revision'));
    await useRemoteRepos.getState().selectMode('review', 'missing');
    expect(useRemoteRepos.getState()).toMatchObject({ health: 'connected', error: 'repository: invalid revision', busy: false, snapshot });
    await useRemoteRepos.getState().selectMode('status');
    expect(useRemoteRepos.getState()).toMatchObject({ mode: 'status', error: null });
  });
});
