import { describe, expect, it } from 'vitest';

import { applyRebaseSeed, autosquashPlan, planUpdateRefs, withMovedBranches, type AutosquashInput } from './rebase';

const e = (oid: string, subject: string): AutosquashInput => ({ oid, subject });

describe('autosquashPlan', () => {
  it('moves a single fixup under its target', () => {
    expect(
      autosquashPlan([e('a1', 'feat: one'), e('b2', 'feat: two'), e('c3', 'fixup! feat: one')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'c3', action: 'fixup' },
      { oid: 'b2', action: 'pick' },
    ]);
  });

  it('keeps two fixups of one target in their original order', () => {
    expect(
      autosquashPlan([
        e('a1', 'base'),
        e('b2', 'other'),
        e('c3', 'fixup! base'),
        e('d4', 'fixup! base'),
      ]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'c3', action: 'fixup' },
      { oid: 'd4', action: 'fixup' },
      { oid: 'b2', action: 'pick' },
    ]);
  });

  it('maps squash! to the squash action and fixup! to fixup', () => {
    expect(
      autosquashPlan([e('a1', 'base'), e('b2', 'squash! base'), e('c3', 'fixup! base')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'squash' },
      { oid: 'c3', action: 'fixup' },
    ]);
  });

  it('strips stacked prefixes for matching but keeps the first action', () => {
    expect(autosquashPlan([e('a1', 'base'), e('b2', 'squash! fixup! base')])).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'squash' },
    ]);
  });

  it('falls back to a subject-prefix match, then an oid-prefix match', () => {
    expect(autosquashPlan([e('a1', 'base commit here'), e('b2', 'fixup! base commit')])).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'fixup' },
    ]);
    expect(autosquashPlan([e('abc123', 'base'), e('b2', 'fixup! abc1')])).toEqual([
      { oid: 'abc123', action: 'pick' },
      { oid: 'b2', action: 'fixup' },
    ]);
  });

  it('prefers an exact subject match over an earlier prefix match', () => {
    expect(
      autosquashPlan([e('a1', 'base commit'), e('b2', 'base'), e('c3', 'fixup! base')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'pick' },
      { oid: 'c3', action: 'fixup' },
    ]);
  });

  it('leaves an unmatched fixup in place as pick', () => {
    expect(
      autosquashPlan([e('a1', 'base'), e('b2', 'fixup! nope'), e('c3', 'fixup! base')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'c3', action: 'fixup' },
      { oid: 'b2', action: 'pick' },
    ]);
  });

  it('returns null with no fixup/squash subjects', () => {
    expect(autosquashPlan([e('a1', 'one'), e('b2', 'two')])).toBeNull();
  });

  it('returns null when no fixup resolves to a target', () => {
    expect(autosquashPlan([e('a1', 'base'), e('b2', 'fixup! gone')])).toBeNull();
    // A fixup can't target a later commit.
    expect(autosquashPlan([e('a1', 'fixup! base'), e('b2', 'base')])).toBeNull();
  });

  it('targets the base commit for a fixup-of-a-fixup subject, chained in order', () => {
    expect(
      autosquashPlan([e('a1', 'base'), e('b2', 'fixup! base'), e('c3', 'fixup! fixup! base')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'fixup' },
      { oid: 'c3', action: 'fixup' },
    ]);
  });

  it('never resolves a target to another fixup commit', () => {
    // c3's remainder is "fixup"; a1's subject starts with it but a1 is itself
    // a fixup commit — resolution must skip it and land on b2.
    expect(
      autosquashPlan([e('a1', 'fixup! x'), e('b2', 'fixup it all'), e('c3', 'fixup! fixup')]),
    ).toEqual([
      { oid: 'a1', action: 'pick' },
      { oid: 'b2', action: 'pick' },
      { oid: 'c3', action: 'fixup' },
    ]);
  });
});

describe('planUpdateRefs', () => {
  const original = ['a', 'b', 'c'];
  const mid = { name: 'mid', fullRef: 'refs/heads/mid', tip: 'b', checkedOutElsewhere: false };
  const held = { name: 'held', fullRef: 'refs/heads/held', tip: 'b', checkedOutElsewhere: true };

  it('follows the last kept ancestor when the tip is dropped or squashed', () => {
    const dropped = planUpdateRefs(
      original,
      [
        { oid: 'c', action: 'pick' },
        { oid: 'b', action: 'drop' },
        { oid: 'a', action: 'pick' },
      ],
      [mid, held],
    );
    expect(dropped).toEqual([
      { name: 'held', fullRef: 'refs/heads/held', afterStep: 2, willMove: false },
      { name: 'mid', fullRef: 'refs/heads/mid', afterStep: 2, willMove: true },
    ]);

    const squashed = planUpdateRefs(
      original,
      [
        { oid: 'a', action: 'pick' },
        { oid: 'b', action: 'squash' },
        { oid: 'c', action: 'pick' },
      ],
      [mid, { name: 'lower', fullRef: 'refs/heads/lower', tip: 'a', checkedOutElsewhere: false }],
    );
    expect(squashed.map((line) => [line.name, line.afterStep, line.willMove])).toEqual([
      ['lower', 0, true],
      ['mid', 0, true],
    ]);
  });

  it('parks a fully dropped branch on the rebase base and follows a reorder', () => {
    expect(
      planUpdateRefs(
        original,
        [
          { oid: 'a', action: 'drop' },
          { oid: 'b', action: 'drop' },
          { oid: 'c', action: 'pick' },
        ],
        [mid],
      ),
    ).toEqual([{ name: 'mid', fullRef: 'refs/heads/mid', afterStep: null, willMove: true }]);

    expect(
      planUpdateRefs(
        original,
        [
          { oid: 'b', action: 'pick' },
          { oid: 'a', action: 'pick' },
          { oid: 'c', action: 'pick' },
        ],
        [mid],
      )[0].afterStep,
    ).toBe(0);
  });
});

describe('withMovedBranches', () => {
  it('lists the branches a finished rebase moved', () => {
    expect(withMovedBranches('Interactive rebase complete', [])).toBe('Interactive rebase complete');
    expect(withMovedBranches('Interactive rebase complete', ['stack-a', 'stack-b'])).toBe(
      'Interactive rebase complete. Moved stack-a, stack-b.',
    );
  });
});

describe('applyRebaseSeed', () => {
  const todo = [{ oid: 'a' }, { oid: 'b' }, { oid: 'c' }];

  it('moves a newer commit to just before an older one', () => {
    expect(applyRebaseSeed(todo, { move: ['c'], mode: 'reorder', anchor: 'b', place: 'before' })).toEqual([
      { oid: 'a', action: 'pick' },
      { oid: 'c', action: 'pick' },
      { oid: 'b', action: 'pick' },
    ]);
  });

  it('squashes the moved commits into the anchor', () => {
    expect(applyRebaseSeed(todo, { move: ['c'], mode: 'squash', anchor: 'b', place: 'after' })).toEqual([
      { oid: 'a', action: 'pick' },
      { oid: 'b', action: 'pick' },
      { oid: 'c', action: 'squash' },
    ]);
  });

  it('returns null when a dragged commit is outside the todo', () => {
    expect(applyRebaseSeed(todo, { move: ['missing'], mode: 'reorder', anchor: 'b', place: 'after' })).toBeNull();
    expect(applyRebaseSeed(todo, { move: ['b'], mode: 'squash', anchor: 'b', place: 'after' })).toBeNull();
  });
});
