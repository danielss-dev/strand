import { pathKey, repoFamilyName } from './repoIdentity';
import type { RecentRepo, RepoMeta } from './types';

export interface KnownRepository {
  path: string;
  name: string;
}

interface OpenRepository {
  path: string;
  meta: RepoMeta;
}

/**
 * Re-open persisted recents before offering them as workspace candidates.
 * Besides rejecting deleted paths, repoOpen gives us the canonical workdir
 * spelling that workspace membership expects.
 */
export async function validateRecentRepositories(
  recents: RecentRepo[],
  repoOpen: (path: string) => Promise<RepoMeta>,
): Promise<KnownRepository[]> {
  const unique = new Map<string, RecentRepo>();
  for (const recent of recents) {
    const key = pathKey(recent.path);
    if (!unique.has(key)) unique.set(key, recent);
  }

  const resolved = await Promise.all(
    [...unique.values()].map(async (recent): Promise<KnownRepository | null> => {
      try {
        const meta = await repoOpen(recent.path);
        return { path: meta.path, name: repoFamilyName(meta) };
      } catch {
        return null;
      }
    }),
  );

  const valid = new Map<string, KnownRepository>();
  for (const repository of resolved) {
    if (repository && !valid.has(pathKey(repository.path))) {
      valid.set(pathKey(repository.path), repository);
    }
  }
  return [...valid.values()];
}

/** Merge validated recents with currently-open main repositories by identity. */
export function mergeKnownRepositories(
  validatedRecents: KnownRepository[],
  tabs: OpenRepository[],
): KnownRepository[] {
  const known = new Map<string, KnownRepository>();
  for (const recent of validatedRecents) {
    if (!known.has(pathKey(recent.path))) known.set(pathKey(recent.path), recent);
  }
  for (const tab of tabs) {
    if (!tab.meta.is_linked_worktree && !known.has(pathKey(tab.path))) {
      known.set(pathKey(tab.path), {
        path: tab.path,
        name: repoFamilyName(tab.meta),
      });
    }
  }
  return [...known.values()];
}
