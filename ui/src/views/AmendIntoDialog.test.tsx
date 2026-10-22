import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { t } from '../lib/i18n';
import type { AmendIntoPlan, RebaseEntry } from '../lib/types';
import { AmendIntoBody } from './AmendIntoDialog';

vi.mock('../stores/repo', () => ({
  useRepo: (selector: (state: { meta: null; amendInto: () => Promise<boolean> }) => unknown) =>
    selector({ meta: null, amendInto: async () => false }),
}));
vi.mock('../lib/tauri', () => ({
  tauri: { repoAmendIntoPlan: async () => null },
  errMessage: (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
}));

function entry(oid: string, subject: string, isMerge = false): RebaseEntry {
  return { oid, short: oid.slice(0, 7), subject, author: 'Test', is_merge: isMerge };
}

function plan(overrides: Partial<AmendIntoPlan> = {}): AmendIntoPlan {
  return {
    commits: [entry('aaa1111', 'c1'), entry('bbb2222', 'c2'), entry('ccc3333', 'c3')],
    pushed: false,
    has_merge: false,
    ...overrides,
  };
}

function render(body: AmendIntoPlan | null, loadError: string | null = null): string {
  return renderToStaticMarkup(
    <AmendIntoBody
      target="aaa1111"
      label="aaa1111"
      subject="c1"
      plan={body}
      loadError={loadError}
      error={null}
    />,
  );
}

describe('AmendIntoBody', () => {
  it('lists every commit the rewrite will touch', () => {
    const html = render(plan());
    expect(html).toContain(t('amendInto.rewritten'));
    expect(html).toContain('c1');
    expect(html).toContain('c2');
    expect(html).toContain('c3');
    expect(html.indexOf('c1')).toBeLessThan(html.indexOf('c2'));
    expect(html.indexOf('c2')).toBeLessThan(html.indexOf('c3'));
    expect(html).toContain(t('amendInto.target'));
    expect(html).not.toContain(t('amendInto.pushed'));
    expect(html).not.toContain(t('amendInto.merge'));
  });

  it('warns when the target is already on the upstream', () => {
    const html = render(plan({ pushed: true }));
    expect(html).toContain(t('amendInto.pushed'));
    expect(html).toContain('role="status"');
  });

  it('refuses a range that contains a merge commit', () => {
    const html = render(plan({
      has_merge: true,
      commits: [entry('aaa1111', 'c1'), entry('mmm4444', 'Merge branch feature', true), entry('ccc3333', 'c3')],
    }));
    expect(html).toContain(t('amendInto.merge'));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Merge branch feature');
  });
});
