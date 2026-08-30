import { describe, expect, it, vi } from 'vitest';

import {
  DuplicateWorkbenchCommandError,
  UnavailableWorkbenchCommandError,
  UnknownWorkbenchCommandError,
  WorkbenchCommandRegistry,
  type WorkbenchCommandContext,
  type WorkbenchCommandDefinition,
} from './commands';

const context: WorkbenchCommandContext = {
  surface: { id: 'strand.changes', instanceId: 'changes-1' },
  workspaceId: 'workspace-1',
  repositoryId: 'repository-1',
  worktreeId: 'worktree-1',
};

function command(id: WorkbenchCommandDefinition['id']): WorkbenchCommandDefinition {
  return { id, title: id, execute: () => id };
}

describe('WorkbenchCommandRegistry', () => {
  it('rejects duplicate command ids', () => {
    const registry = new WorkbenchCommandRegistry();
    registry.register(command('strand.changes.stage'));

    expect(() => registry.register(command('strand.changes.stage')))
      .toThrow(DuplicateWorkbenchCommandError);
  });

  it('lists commands in registration order', () => {
    const registry = new WorkbenchCommandRegistry();
    registry.register(command('strand.changes.stage'));
    registry.register(command('strand.worktree.create'));
    registry.register(command('plugin.example.inspect'));

    expect(registry.list().map(({ id }) => id)).toEqual([
      'strand.changes.stage',
      'strand.worktree.create',
      'plugin.example.inspect',
    ]);
  });

  it('returns execution results and forwards context and arguments', async () => {
    const registry = new WorkbenchCommandRegistry();
    const execute = vi.fn((_context: WorkbenchCommandContext, args?: unknown) => ({ accepted: args }));
    registry.register({ id: 'strand.changes.stage', title: 'Stage', execute });

    await expect(registry.execute('strand.changes.stage', context, { path: 'src/App.tsx' }))
      .resolves.toEqual({ accepted: { path: 'src/App.tsx' } });
    expect(execute).toHaveBeenCalledWith(context, { path: 'src/App.tsx' });
  });

  it('rejects execution when the command is unavailable in context', async () => {
    const registry = new WorkbenchCommandRegistry();
    const execute = vi.fn();
    registry.register({
      id: 'strand.changes.stage',
      title: 'Stage',
      isAvailable: ({ repositoryId }, args) => repositoryId != null && args === 'allowed',
      execute,
    });

    expect(registry.isAvailable('strand.changes.stage', context, 'blocked')).toBe(false);
    await expect(registry.execute('strand.changes.stage', context, 'blocked'))
      .rejects.toBeInstanceOf(UnavailableWorkbenchCommandError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('unregisters commands without disturbing the remaining order', async () => {
    const registry = new WorkbenchCommandRegistry();
    registry.register(command('strand.changes.stage'));
    registry.register(command('strand.worktree.create'));

    expect(registry.unregister('strand.changes.stage')).toBe(true);
    expect(registry.unregister('strand.changes.stage')).toBe(false);
    expect(registry.get('strand.changes.stage')).toBeUndefined();
    expect(registry.list().map(({ id }) => id)).toEqual(['strand.worktree.create']);
    await expect(registry.execute('strand.changes.stage', context))
      .rejects.toBeInstanceOf(UnknownWorkbenchCommandError);
  });

  it('rejects command ids without a namespace at runtime', () => {
    const registry = new WorkbenchCommandRegistry();
    const invalid = command('invalid' as WorkbenchCommandDefinition['id']);

    expect(() => registry.register(invalid)).toThrow(TypeError);
  });
});
