import type { Commit, FileContent, FileDiff, FileStatus, RepoMeta, Snapshot } from './types';

export type RemoteReadOp =
  | { kind: 'meta' | 'status' | 'snapshot' }
  | { kind: 'log'; limit: number; head_only: boolean }
  | { kind: 'diff'; source: { kind: 'since'; revision: string; full_context: boolean } }
  | { kind: 'review'; since: string; limit: number }
  | { kind: 'file_chunk'; path: string; offset: number; length: number; version: string | null };
export interface RemoteFileChunk { bytes: number[]; offset: number; next_offset: number; total: number; version: string }
export interface RemoteReview { base: string; head_before: string | null; head_after: string | null; status: FileStatus[]; log: Commit[]; diffs: FileDiff[] }
export type RemoteResult =
  | { kind: 'meta'; data: RepoMeta }
  | { kind: 'status'; data: FileStatus[] }
  | { kind: 'snapshot'; data: Snapshot }
  | { kind: 'log'; data: Commit[] }
  | { kind: 'diff'; data: FileDiff[] }
  | { kind: 'review'; data: RemoteReview }
  | { kind: 'file'; data: FileContent }
  | { kind: 'file_chunk'; data: RemoteFileChunk };
export interface RemoteEnvelope { schemaVersion: number; repository: string; result: RemoteResult }
export interface RemoteHealth { host: string; state: string; error: string | null }

export function remoteHost(address: string): string {
  try { return new URL(address).hostname.toLowerCase(); } catch { return ''; }
}
export function canonicalRemoteAddress(address: string, repository: string): string {
  if (!repository.startsWith('/') || repository.length > 4096 || /[\u0000-\u001f\\]/.test(repository)) throw new Error('Remote engine returned an invalid repository path.');
  return `ssh://${remoteHost(address)}${repository.split('/').map(encodeURIComponent).join('/')}`;
}
