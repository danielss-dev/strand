/** Pick existing, distinct refs in stable local-then-remote order. */
export function compareBranchDefaults({ localNames, remoteNames, currentBranch, upstream }: {
  localNames: readonly string[];
  remoteNames: readonly string[];
  currentBranch: string | null;
  upstream: string | null;
}): { from: string; to: string } | null {
  const names = [...new Set([...localNames, ...remoteNames])];
  if (names.length < 2) return null;
  if (currentBranch && names.includes(currentBranch)) {
    const other = [upstream, 'main', 'master', ...names]
      .find((name): name is string => !!name && name !== currentBranch && names.includes(name))!;
    return { from: other, to: currentBranch };
  }
  return { from: names[0], to: names[1] };
}
