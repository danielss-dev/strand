import { describe, expect, it } from 'vitest';

import { jsonEqual, stable } from './stable';

describe('jsonEqual', () => {
  it('compares primitives', () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual(1, 2)).toBe(false);
    expect(jsonEqual('a', 'a')).toBe(true);
    expect(jsonEqual('a', 'b')).toBe(false);
    expect(jsonEqual(true, true)).toBe(true);
    expect(jsonEqual(true, false)).toBe(false);
    expect(jsonEqual(1, '1')).toBe(false);
  });

  it('treats null and undefined as distinct and only self-equal', () => {
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(undefined, undefined)).toBe(true);
    expect(jsonEqual(null, undefined)).toBe(false);
    expect(jsonEqual(null, 0)).toBe(false);
    expect(jsonEqual(undefined, '')).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(jsonEqual([], [])).toBe(true);
    expect(jsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(jsonEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual({ 0: 1 }, [1])).toBe(false);
  });

  it('compares nested objects structurally', () => {
    const a = { branches: [{ name: 'main', ahead: 0, upstream: { name: 'origin/main' } }], tags: [] };
    const b = { branches: [{ name: 'main', ahead: 0, upstream: { name: 'origin/main' } }], tags: [] };
    expect(jsonEqual(a, b)).toBe(true);
    expect(jsonEqual(a, { ...b, tags: [{ name: 'v1' }] })).toBe(false);
    expect(jsonEqual(a, { branches: [{ name: 'main', ahead: 1, upstream: { name: 'origin/main' } }], tags: [] })).toBe(false);
  });

  it('requires the same key set, not just matching values', () => {
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(jsonEqual({ a: undefined }, { b: undefined })).toBe(false);
  });
});

describe('stable', () => {
  it('keeps the previous reference when structurally equal', () => {
    const prev = [{ path: 'src/a.ts', status: 'MODIFIED' }];
    const next = [{ path: 'src/a.ts', status: 'MODIFIED' }];
    expect(stable(prev, next)).toBe(prev);
  });

  it('returns the next value when anything differs', () => {
    const prev = [{ path: 'src/a.ts', status: 'MODIFIED' }];
    const next = [{ path: 'src/a.ts', status: 'STAGED' }];
    expect(stable(prev, next)).toBe(next);
  });

  it('handles null previous values', () => {
    const next = { branch: 'main' };
    expect(stable<{ branch: string } | null>(null, next)).toBe(next);
  });
});
