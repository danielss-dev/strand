import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ToastViewport } from '../components/ToastViewport';
import {
  LOCAL_GIT_OP_BUSY,
  checkoutCommitProgress,
  checkoutProgress,
  createLocalGitOpRunner,
  deleteRefProgress,
  stashApplyProgress,
  stashDropProgress,
  stashPopProgress,
  type ProgressUpdate,
} from './localGitOp';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function progressLog() {
  const events: string[] = [];
  let current: string | null = null;
  const setProgress = (update: ProgressUpdate) => {
    current = typeof update === 'function' ? update(current) : update;
    events.push(current ?? 'clear');
  };
  return { events, setProgress };
}

describe('local Git write progress', () => {
  it('paints checkout copy before work and clears after success', async () => {
    const { events, setProgress } = progressLog();
    const run = createLocalGitOpRunner({
      setProgress,
      onBusy: () => events.push('busy'),
      waitForPaint: async () => { events.push('paint'); },
    });

    await expect(run(checkoutProgress('feature/x'), async () => { events.push('work'); }))
      .resolves.toBe(true);

    expect(events).toEqual([
      'Checking out `feature/x`…',
      'paint',
      'work',
      'clear',
    ]);
  });

  it('covers remote-track, detached, and stash copy without a success toast', () => {
    expect(checkoutProgress('topic')).toBe('Checking out `topic`…');
    expect(checkoutCommitProgress()).toBe('Checking out commit…');
    expect(stashApplyProgress()).toBe('Applying stash…');
    expect(stashPopProgress()).toBe('Popping stash…');
    expect(stashDropProgress()).toBe('Dropping stash…');
    expect(deleteRefProgress('old')).toBe('Deleting `old`…');
  });

  it('clears in-progress copy when the write fails so an error toast can take over', async () => {
    const { events, setProgress } = progressLog();
    const run = createLocalGitOpRunner({
      setProgress,
      onBusy: () => events.push('busy'),
      waitForPaint: async () => {},
    });

    await expect(run(checkoutCommitProgress(), async () => {
      events.push('work');
      throw new Error('already checked out in worktree');
    })).rejects.toThrow('already checked out in worktree');

    expect(events).toEqual(['Checking out commit…', 'work', 'clear']);
  });

  it('refuses a second write with a busy signal instead of throwing', async () => {
    const gate = deferred();
    const onBusy = vi.fn();
    const run = createLocalGitOpRunner({
      setProgress: () => {},
      onBusy,
      waitForPaint: async () => {},
    });

    const first = run(checkoutProgress('a'), () => gate.promise);
    await Promise.resolve();
    await expect(run(checkoutProgress('b'), async () => {
      throw new Error('second write should not start');
    })).resolves.toBe(false);
    expect(onBusy).toHaveBeenCalledOnce();
    expect(LOCAL_GIT_OP_BUSY).toMatch(/already running/);
    gate.resolve();
    await expect(first).resolves.toBe(true);
  });

  it('does not steal an in-flight network pill', async () => {
    const { events, setProgress } = progressLog();
    const run = createLocalGitOpRunner({
      setProgress,
      onBusy: () => events.push('busy'),
      waitForPaint: async () => { events.push('paint'); },
      isBlocked: () => true,
    });

    await expect(run(checkoutProgress('x'), async () => { events.push('work'); }))
      .resolves.toBe(false);
    expect(events).toEqual(['busy']);
  });

  it('does not clear a newer network label if one arrives during the write', async () => {
    const { events, setProgress } = progressLog();
    const run = createLocalGitOpRunner({
      setProgress,
      onBusy: () => {},
      waitForPaint: async () => { setProgress('Fetching…'); },
    });
    await run(checkoutProgress('x'), async () => {});
    expect(events.at(-1)).toBe('Fetching…');
    expect(events).not.toContain('clear');
  });

  it('renders the network-style progress pill without a cancel control', () => {
    const html = renderToStaticMarkup(createElement(ToastViewport, {
      networkMessage: checkoutProgress('feature/x'),
      networkOperationId: null,
      toast: null,
      onCancelNetwork: () => {},
    }));
    expect(html).toContain('Checking out `feature/x`…');
    expect(html).toContain('toast progress');
    expect(html).not.toContain('toast-action');
  });
});
