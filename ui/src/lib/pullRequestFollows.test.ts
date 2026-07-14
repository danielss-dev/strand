import { describe, expect, it } from 'vitest';

import {
  activityErrorRecord,
  applyPullRequestFollow,
  applyPullRequestUnfollow,
} from './pullRequestFollows';

describe('pull request follow persistence', () => {
  const key = 'git_hub:acme/app:42';

  it('blocks automatic re-follow until a manual follow clears the mute', () => {
    expect(applyPullRequestFollow([key], key, false)).toEqual({ allowed: false, muted: [key] });
    expect(applyPullRequestFollow([key], key, true)).toEqual({ allowed: true, muted: [] });
  });

  it('mutes explicit unfollows but not terminal auto-removal', () => {
    expect(applyPullRequestUnfollow([], key, true)).toEqual([key]);
    expect(applyPullRequestUnfollow([], key, false)).toEqual([]);
  });

  it('retains the last successful baseline when a poll fails', () => {
    const snapshot = { id: 42, source_commit: 'abc' };
    const record = { snapshot, error: null };
    expect(activityErrorRecord(record, 'offline')).toEqual({ snapshot, error: 'offline' });
  });
});
