import { describe, expect, it } from 'vitest';

import { autosquashPlan, type AutosquashInput } from './rebase';

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
