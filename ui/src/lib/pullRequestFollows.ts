export interface FollowIntent {
  allowed: boolean;
  muted: string[];
}

/** Manual follows clear a mute; automatic follows respect it. */
export function applyPullRequestFollow(
  muted: readonly string[],
  key: string,
  manual: boolean,
): FollowIntent {
  const isMuted = muted.includes(key);
  return {
    allowed: manual || !isMuted,
    muted: manual && isMuted ? muted.filter((item) => item !== key) : [...muted],
  };
}

/** Only an explicit user unfollow creates a persistent auto-follow mute. */
export function applyPullRequestUnfollow(
  muted: readonly string[],
  key: string,
  explicit: boolean,
): string[] {
  if (!explicit || muted.includes(key)) return [...muted];
  return [...muted, key];
}

export function activityErrorRecord<T extends { error: string | null }>(
  record: T,
  error: string,
): T {
  return { ...record, error };
}
