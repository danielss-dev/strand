export type PatchTarget = 'worktree' | 'index' | 'both' | 'mailbox';
export interface PatchPreview { token: string; paths: string[]; messages: string[]; valid: boolean; validation: string }
export interface MailboxState { token: string; current: string; total: string; author: string; conflicts: boolean }
export interface InterchangeOutcome { success: boolean; paused: boolean; output: string }
export interface BundlePreview { token: string; refs: Array<{ oid: string; name: string }>; prerequisites: string[]; valid: boolean; validation: string }
