import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
import { tauri } from './tauri';

beforeEach(() => invoke.mockReset());

it('carries the exact reviewed patch target and token over IPC without rewriting paths', async () => {
  const preview = { token: 'bytes-and-index', paths: ['space name.txt'], valid: true, messages: [], validation: '' };
  invoke.mockResolvedValueOnce(preview).mockResolvedValueOnce({ success: true, paused: false, output: '' });
  const result = await tauri.repoPatchPreview('C:/repo with spaces', 'C:/patch files/a.patch', 'index');
  await tauri.repoPatchImport('C:/repo with spaces', 'C:/patch files/a.patch', 'index', result.token);
  expect(invoke).toHaveBeenLastCalledWith('repo_patch_import', { path: 'C:/repo with spaces', source: 'C:/patch files/a.patch', target: 'index', token: 'bytes-and-index' });
});

it('keeps mailbox recovery distinct from rebase and propagates a stale-state rejection', async () => {
  invoke.mockRejectedValueOnce({ message: 'mailbox state changed; refresh before continuing' });
  await expect(tauri.repoMailboxAction('repo', 'skip', 'reviewed')).rejects.toMatchObject({ message: expect.stringContaining('changed') });
  expect(invoke).toHaveBeenCalledWith('repo_mailbox_action', { path: 'repo', action: 'skip', token: 'reviewed' });
});

it('imports the chosen advertised bundle ref into an explicit new branch', async () => {
  await tauri.repoBundleImport('repo', '/tmp/a.bundle', 'file stamp', 'refs/tags/v1', 'import/v1');
  expect(invoke).toHaveBeenCalledWith('repo_bundle_import', { path: 'repo', source: '/tmp/a.bundle', token: 'file stamp', sourceRef: 'refs/tags/v1', branch: 'import/v1' });
});
