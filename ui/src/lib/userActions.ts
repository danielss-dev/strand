import type { PaletteAction } from '../views/Palette';
import type { MenuItem } from '../components/ContextMenu';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { useWork } from '../stores/work';

export interface UserAction {
  id: string;
  name: string;
  scope: 'repository' | 'ref' | 'file';
  executable: string;
  args: string[];
  cwd: 'repository' | 'file-parent';
}
export interface ActionContext {
  path: string;
  target: { kind: 'repository' } | { kind: 'ref'; reference: string; oid: string } | { kind: 'file'; file: string };
}
export interface ActionPreview { executable: string; args: string[]; cwd: string }
export interface ActionOutcome {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  status: 'completed' | 'failed' | 'cancelled' | 'output-limit' | 'timed-out';
  truncated: boolean;
  duration_ms: number;
}
export interface ActionRequest { context: ActionContext; actionId?: string }
export const USER_ACTION_EVENT = 'strand:user-action';
export function openUserAction(context: ActionContext, actionId?: string) {
  window.dispatchEvent(new CustomEvent<ActionRequest>(USER_ACTION_EVENT, { detail: { context, actionId } }));
}
export function userActionMenu(context: ActionContext): MenuItem {
  const actions = useSettings.getState().userActions.filter((action) => action.scope === context.target.kind);
  return {
    label: 'Actions', icon: 'terminal',
    submenu: [...actions.map((action) => ({
      label: action.name, onSelect: () => openUserAction(context, action.id),
    })), { label: 'Manage user actions…', onSelect: () => window.dispatchEvent(new Event('strand:manage-user-actions')) }],
  };
}

/** Capture only the active surface's exact target, never an old file from
 * another view or the current branch in place of the selected ref. */
export function selectedActionContext(scope: UserAction['scope']): ActionContext | null {
  const state = useRepo.getState();
  const path = state.meta?.path;
  if (!path) return null;
  if (scope === 'repository') return { path, target: { kind: 'repository' } };
  if (scope === 'ref') {
    if (state.view !== 'commits') return null;
    const matches = (candidate: { full_name: string }) => candidate.full_name === state.selectedRef;
    const ref = state.refs.branches.find(matches) ?? state.refs.remote_branches.find(matches) ?? state.refs.tags.find(matches);
    return ref && ref.target === state.selectedCommit ? { path, target: { kind: 'ref', reference: ref.full_name, oid: ref.target } } : null;
  }
  if (state.view === 'work') {
    const work = useWork.getState().repos[path];
    const file = work?.tabs.find((tab) => tab.id === work.activeTabId);
    return file?.kind === 'file' && !file.revision && !file.isDirectory && !file.missing
      ? { path, target: { kind: 'file', file: file.path } } : null;
  }
  return state.view === 'file' && state.selectedFile && !state.selectedFileRevision && !state.selectedFileIsDirectory
    ? { path, target: { kind: 'file', file: state.selectedFile } } : null;
}

export function userActionPalette(actions: UserAction[], onStale: () => void): PaletteAction[] {
  const contexts = new Map<UserAction['scope'], ActionContext | null>();
  return actions.flatMap((action) => {
    if (!contexts.has(action.scope)) contexts.set(action.scope, selectedActionContext(action.scope));
    const context = contexts.get(action.scope);
    if (!context) return [];
    return [{ id: `user-action:${action.id}`, label: `User action: ${action.name}…`, group: 'Actions',
      keywords: 'custom executable script command', meta: action.scope,
      run: () => {
        // A palette result is a captured target. Refuse superseded results.
        if (JSON.stringify(context) !== JSON.stringify(selectedActionContext(action.scope))) { onStale(); return; }
        openUserAction(context, action.id);
      } } satisfies PaletteAction];
  });
}

export function parseActionArgs(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 128 || value.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || text.length > 24_000) {
    throw new Error('Arguments must be a JSON array of up to 128 strings / 24 KB.');
  }
  return value;
}
