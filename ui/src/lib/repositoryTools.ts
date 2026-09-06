import type { MenuItem } from '../components/ContextMenu';
import { userActionMenu } from './userActions';

export type RepositoryTool = 'settings' | 'signing' | 'lfs' | 'patch' | 'bundle' | 'export' | 'notes' | 'replace' | 'bisect' | 'gitflow' | 'history' | 'activity';
export interface RepositoryToolRequest {
  path: string;
  tool: RepositoryTool;
  revision?: string;
  rating?: 'good' | 'bad';
  lfsAction?: 'track' | 'lock' | 'locks';
  file?: string;
}
export const REPOSITORY_TOOL_EVENT = 'strand:repository-tool';
export function openRepositoryTool(request: RepositoryToolRequest) {
  window.dispatchEvent(new CustomEvent<RepositoryToolRequest>(REPOSITORY_TOOL_EVENT, { detail: request }));
}
export function repositoryToolMenu(path: string): MenuItem[] {
  const item = (label: string, tool: RepositoryTool): MenuItem => ({ label, onSelect: () => openRepositoryTool({ path, tool }) });
  return [
    item('Repository settings…', 'settings'),
    item('Git LFS…', 'lfs'),
    { label: 'Import / Export', submenu: [item('Apply patch or mailbox…', 'patch'), item('Import bundle…', 'bundle'), item('Export bundle…', 'export')] },
    { label: 'Advanced', submenu: [item('Replacement refs…', 'replace'), item('History and downloads…', 'history')] },
    item('Activity history…', 'activity'),
    userActionMenu({ path, target: { kind: 'repository' } }),
  ];
}
