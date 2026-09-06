// Reference-stabilizing helpers for store refreshes.
//
// Snapshot-style refreshes replace whole slices (`status`, `refs`,
// `workTree`, …) with freshly deserialized arrays on every tick, even when
// nothing changed — which defeats every downstream `useMemo`/selector and
// re-renders subscribers for identical data. `stable(prev, next)` returns
// `prev` when the two are structurally equal, so unchanged slices keep
// their identity across refreshes.

/**
 * Structural equality over JSON-shaped data (IPC payloads: plain objects,
 * arrays, primitives — no Dates/Maps/cycles). Early-exits on the first
 * difference, so the something-changed case stays cheap; the full walk only
 * runs when the values really are equal — exactly when it saves a rebuild.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) {
    if (!(k in bo) || !jsonEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** `next` when it differs structurally from `prev`, else `prev` unchanged. */
export function stable<T>(prev: T, next: T): T {
  return jsonEqual(prev, next) ? prev : next;
}

/** Keep unchanged row identities even when another row was edited or moved. */
export function stableRows<T>(prev: T[], next: T[], key: (row: T) => string): T[] {
  const byKey = new Map(prev.map((row) => [key(row), row]));
  const rows = next.map((row) => {
    const old = byKey.get(key(row));
    return old === undefined ? row : stable(old, row);
  });
  return rows.length === prev.length && rows.every((row, index) => row === prev[index])
    ? prev : rows;
}
