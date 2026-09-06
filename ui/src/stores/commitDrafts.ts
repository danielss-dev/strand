import type { SigningMode } from '../lib/types';
import { create } from 'zustand';

interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  signing: SigningMode;
  submitting: boolean;
  output: string;
  error: string | null;
}

export const emptyCommitDraft: CommitDraft = {
  subject: '', body: '', amend: false, signing: 'inherit', submitting: false, output: '', error: null,
};

/** Session drafts belong to a checkout, including while a hook is running. */
export const useCommitDrafts = create<{
  drafts: Record<string, CommitDraft>;
  patch(path: string, patch: Partial<CommitDraft>): void;
}>((set) => ({
  drafts: {},
  patch: (path, patch) => set((s) => ({
    drafts: { ...s.drafts, [path]: { ...(s.drafts[path] ?? emptyCommitDraft), ...patch } },
  })),
}));
