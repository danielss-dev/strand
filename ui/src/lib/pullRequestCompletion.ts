import type { PullRequestCompletion } from './types';

export function completionLabel(state: PullRequestCompletion): string {
  if (state.status === 'merged') return 'Merged';
  if (state.status === 'closed') return 'Closed';
  if (state.status === 'queued') return `In GitHub merge queue${state.position != null ? ` · position ${state.position}` : ''}`;
  if (state.status === 'waiting_for_policies') return state.kind === 'azure_auto_complete'
    ? 'Azure auto-complete enabled · waiting for policies'
    : 'GitHub auto-merge enabled · waiting for policies';
  return state.kind === 'github_queue' ? 'GitHub merge queue required'
    : state.kind === 'azure_auto_complete' ? 'Azure auto-complete off' : 'GitHub auto-merge off';
}

export function completionAction(state: PullRequestCompletion, enable: boolean): string {
  if (state.kind === 'github_queue') return enable ? 'Join merge queue' : state.status === 'queued' ? 'Leave merge queue' : 'Cancel auto-merge';
  if (state.kind === 'azure_auto_complete') return enable ? 'Enable auto-complete' : 'Cancel auto-complete';
  return enable ? 'Enable auto-merge' : 'Cancel auto-merge';
}
