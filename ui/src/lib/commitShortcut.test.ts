import { describe, expect, it, vi } from 'vitest';

import { handleCommitShortcut, type CommitShortcutEvent } from './commitShortcut';

const event = (over: Partial<CommitShortcutEvent> = {}): CommitShortcutEvent => ({
  key: '',
  metaKey: false,
  ctrlKey: false,
  preventDefault: vi.fn(),
  ...over,
});

describe('handleCommitShortcut', () => {
  it.each([
    ['Command', { metaKey: true }],
    ['Control', { ctrlKey: true }],
  ])('submits and prevents the default for %s+Enter', (_label, modifier) => {
    const e = event({ key: 'Enter', ...modifier });
    const submit = vi.fn();

    handleCommitShortcut(e, submit);

    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('leaves plain Enter untouched so a description can insert a newline', () => {
    const e = event({ key: 'Enter' });
    const submit = vi.fn();

    handleCommitShortcut(e, submit);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('leaves other modified keys untouched', () => {
    const e = event({ key: 'k', metaKey: true });
    const submit = vi.fn();

    handleCommitShortcut(e, submit);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
