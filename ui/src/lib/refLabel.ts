/** Last path segment of a ref (`origin/foo/bar` → `bar`), full name on hover. */
export function refChipLabel(full: string): { label: string; title: string } {
  const segs = full.split('/').filter(Boolean);
  const label = segs[segs.length - 1] ?? full;
  return { label, title: full };
}
