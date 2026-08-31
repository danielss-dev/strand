import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageMarkdown } from './MessageMarkdown';

describe('MessageMarkdown', () => {
  it('renders headings, lists, and fenced code instead of raw markdown source', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={[
        '## How it works',
        '',
        '- One',
        '- Two',
        '',
        '```ts',
        'const ok = true;',
        '```',
        '',
        'Use `inline` and **bold**.',
      ].join('\n')}
      />,
    );
    expect(html).toContain('<h2');
    expect(html).toContain('How it works');
    expect(html).toContain('<ul');
    expect(html).toContain('<pre');
    expect(html).toContain('const ok = true;');
    expect(html).toContain('<strong');
    expect(html).toContain('markdown');
    expect(html).not.toContain('## How it works');
  });
});
