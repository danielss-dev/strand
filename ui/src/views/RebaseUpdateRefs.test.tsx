import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { UpdateRefsToggle } from './RebaseUpdateRefs';

describe('UpdateRefsToggle', () => {
  it('renders an enabled checkbox when git supports --update-refs', () => {
    const html = renderToStaticMarkup(
      <UpdateRefsToggle supported enabled={false} busy={false} onChange={() => {}} />,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Update other branches (--update-refs)');
    expect(html).not.toContain('disabled');
  });

  it('disables the toggle with a tooltip when git is older than 2.38', () => {
    const html = renderToStaticMarkup(
      <UpdateRefsToggle supported={false} enabled busy={false} onChange={() => {}} />,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('Requires Git 2.38 or newer');
    expect(html).not.toContain('checked');
  });
});
