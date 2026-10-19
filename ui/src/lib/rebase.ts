import { t } from './i18n';
import type { RebaseAction } from './types';

/** A commit in the todo range (oldest→newest), as `loadRebaseTodo` lists it. */
export interface AutosquashInput {
  oid: string;
  subject: string;
}

/** One step of an autosquashed plan: the commit plus its derived verb. */
export interface AutosquashStep {
  oid: string;
  action: 'pick' | 'fixup' | 'squash';
}

/**
 * The `fixup!`/`squash!` prefix of a subject: the action comes from the
 * *first* prefix; matching strips stacked prefixes (`fixup! fixup! X`
 * targets `X`). `null` for a plain subject.
 */
function parsePrefix(subject: string): { action: 'fixup' | 'squash'; remainder: string } | null {
  const m = /^(fixup|squash)! /.exec(subject);
  if (!m) return null;
  let remainder = subject.slice(m[0].length);
  let mm;
  while ((mm = /^(fixup|squash)! /.exec(remainder))) remainder = remainder.slice(mm[0].length);
  return { action: m[1] as 'fixup' | 'squash', remainder };
}

/**
 * Mirror of `git rebase --autosquash` over a todo list (oldest first): each
 * `fixup! X` / `squash! X` commit moves to immediately after its target,
 * with the matching action; everything else stays a `pick` in place.
 *
 * Target resolution (earlier entries only, skipping ones that are themselves
 * fixup!/squash! commits): first whose subject exactly equals the remainder,
 * else first whose subject starts with it, else first whose oid starts with
 * it (the `fixup! <sha>` form). Multiple fixups of one target chain after it
 * in their original relative order; an unmatched fixup stays put as `pick`.
 *
 * Returns `null` when there's nothing to do — no fixup!/squash! subjects, or
 * none of them resolve to a target — so callers can skip rewriting the plan.
 */
export function autosquashPlan(entries: AutosquashInput[]): AutosquashStep[] | null {
  const parsed = entries.map((e) => parsePrefix(e.subject));
  if (!parsed.some(Boolean)) return null;

  // Resolve each fixup's target index (-1 = unmatched).
  const targetOf = entries.map((_e, i) => {
    const p = parsed[i];
    if (!p || !p.remainder) return -1;
    const earlier = (match: (j: number) => boolean) => {
      for (let j = 0; j < i; j++) if (!parsed[j] && match(j)) return j;
      return -1;
    };
    const exact = earlier((j) => entries[j].subject === p.remainder);
    if (exact !== -1) return exact;
    const prefix = earlier((j) => entries[j].subject.startsWith(p.remainder));
    if (prefix !== -1) return prefix;
    return earlier((j) => entries[j].oid.startsWith(p.remainder));
  });
  if (!targetOf.some((t) => t !== -1)) return null;

  // Fixups of each target, in original order (targets are never fixups
  // themselves, so one flat pass suffices — no chasing chains).
  const followers = new Map<number, number[]>();
  targetOf.forEach((t, i) => {
    if (t !== -1) followers.set(t, [...(followers.get(t) ?? []), i]);
  });

  const out: AutosquashStep[] = [];
  entries.forEach((e, i) => {
    if (targetOf[i] !== -1) return; // emitted under its target below
    out.push({ oid: e.oid, action: 'pick' });
    for (const f of followers.get(i) ?? []) {
      out.push({ oid: entries[f].oid, action: parsed[f]!.action });
    }
  });
  return out;
}

/** A local branch tip that might follow this rebase. */
export interface UpdateRefBranchInput {
  name: string;
  fullRef: string;
  tip: string;
  checkedOutElsewhere: boolean;
}

/**
 * One `update-ref` row in the plan. `afterStep` is the pick/reword/edit the
 * branch follows; `null` parks it on the rebase base.
 *
 * Mirrors `plan_update_refs` in `crates/strand-core/src/history.rs`: a branch
 * follows the last commit it contained that the plan still keeps. A dropped
 * tip falls back to that ancestor (not whatever happens to sit earlier in the
 * edited plan). Squash and fixup land on the combined commit. A branch checked
 * out in another worktree is shown and not moved.
 */
export interface PlannedUpdateRef {
  name: string;
  fullRef: string;
  afterStep: number | null;
  willMove: boolean;
}

export function planUpdateRefs(
  originalOids: readonly string[],
  steps: readonly { oid: string; action: RebaseAction }[],
  branches: readonly UpdateRefBranchInput[],
): PlannedUpdateRef[] {
  const planned: PlannedUpdateRef[] = [];
  for (const branch of branches) {
    if (!originalOids.includes(branch.tip)) continue;
    planned.push({
      name: branch.name,
      fullRef: branch.fullRef,
      afterStep: landingAnchor(originalOids, steps, branch.tip),
      willMove: !branch.checkedOutElsewhere,
    });
  }
  planned.sort((a, b) => a.name.localeCompare(b.name));
  return planned;
}

function landingAnchor(
  originalOids: readonly string[],
  steps: readonly { oid: string; action: RebaseAction }[],
  tip: string,
): number | null {
  const tipAt = originalOids.indexOf(tip);
  if (tipAt < 0) return null;
  let kept: string | null = null;
  for (const oid of originalOids.slice(0, tipAt + 1)) {
    const action = steps.find((step) => step.oid === oid)?.action ?? 'drop';
    if (action !== 'drop') kept = oid;
  }
  if (!kept) return null;
  const stepAt = steps.findIndex((step) => step.oid === kept);
  if (stepAt < 0) return null;
  const action = steps[stepAt].action;
  switch (action) {
    case 'pick':
    case 'reword':
    case 'edit':
      return stepAt;
    case 'squash':
    case 'fixup': {
      for (let index = stepAt - 1; index >= 0; index -= 1) {
        const earlier = steps[index].action;
        if (earlier === 'pick' || earlier === 'reword' || earlier === 'edit') return index;
      }
      return null;
    }
    case 'drop':
      return null;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Append the branches a finished rebase moved. An empty list leaves the message alone. */
export function withMovedBranches(message: string, moved: readonly string[]): string {
  if (moved.length === 0) return message;
  const base = message.endsWith('.') ? message : `${message}.`;
  return t('rebase.moved', { message: base, branches: moved.join(', ') });
}
