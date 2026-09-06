import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./userActions', () => ({ userActionMenu: () => ({ label: 'Actions' }) }));
import { openRepositoryTool, repositoryToolMenu } from './repositoryTools';

beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
});
describe('repository tool targets', () => {
  it('retains the clicked repository for settings and each import/export action', () => {
    const menu = repositoryToolMenu('D:/another repository');
    menu[0].onSelect?.();
    expect(window.dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({ init: { detail: { path: 'D:/another repository', tool: 'settings' } } }));
    const transfers = menu.find(item => item.label === 'Import / Export')!.submenu!;
    for (const [index, tool] of ['patch', 'bundle', 'export'].entries()) {
      transfers[index].onSelect?.();
      expect(window.dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({ init: { detail: { path: 'D:/another repository', tool } } }));
    }
  });
  it('keeps the chosen commit and bisect role rather than substituting HEAD', () => {
    openRepositoryTool({ path: '/repo', tool: 'bisect', revision: 'a'.repeat(40), rating: 'good' });
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ init: { detail: { path: '/repo', tool: 'bisect', revision: 'a'.repeat(40), rating: 'good' } } }));
  });
});
