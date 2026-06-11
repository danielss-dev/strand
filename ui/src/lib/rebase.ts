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
