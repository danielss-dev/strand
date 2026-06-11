import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactNode } from 'react';

import { isMarkdownPath, renderMarkdown } from './markdown';

/** Depth-first flatten of a React node tree (elements + strings). */
function flatten(node: ReactNode, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (node == null || typeof node === 'boolean') return out;
  out.push(node);
  if (isValidElement(node)) flatten((node.props as { children?: ReactNode }).children, out);
  return out;
}

const els = (nodes: ReactNode, type: string) =>
  flatten(nodes).filter(
    (n): n is React.ReactElement => isValidElement(n) && n.type === type,
  );
const text = (nodes: ReactNode) =>
  flatten(nodes)
    .filter((n): n is string => typeof n === 'string')
    .join('');

describe('isMarkdownPath', () => {
  it('matches .md and .markdown, case-insensitively', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/notes.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('strand.svg')).toBe(false);
    expect(isMarkdownPath('file.mdx')).toBe(false);
  });
});

describe('renderMarkdown blocks', () => {
  it('renders ATX headings at their level', () => {
    const out = renderMarkdown('# One\n\n### Three');
    expect(els(out, 'h1')).toHaveLength(1);
    expect(els(out, 'h3')).toHaveLength(1);
    expect(text(els(out, 'h1')[0])).toBe('One');
  });

  it('keeps fenced code literal — no inline parsing inside', () => {
    const out = renderMarkdown('```js\n**not bold** <b>raw</b>\n```');
    const pre = els(out, 'pre');
    expect(pre).toHaveLength(1);
    expect(text(pre[0])).toBe('**not bold** <b>raw</b>');
    expect(els(out, 'strong')).toHaveLength(0);
  });

  it('normalizes CRLF input', () => {
    const out = renderMarkdown('# Hi\r\n\r\ntext\r\n');
    expect(els(out, 'h1')).toHaveLength(1);
    expect(text(els(out, 'p')[0])).toBe('text');
  });

  it('nests lists by indentation and renders task checkboxes', () => {
    const out = renderMarkdown('- [x] done\n  - sub item\n- plain');
    const topLis = els(out, 'li');
    expect(topLis).toHaveLength(3);
    const boxes = els(out, 'input');
    expect(boxes).toHaveLength(1);
    expect(boxes[0].props.checked).toBe(true);
    expect(els(out, 'ul')).toHaveLength(2); // outer list + the nested one
  });

  it('honors ordered-list start numbers', () => {
    const out = renderMarkdown('3. three\n4. four');
    const ol = els(out, 'ol');
    expect(ol).toHaveLength(1);
    expect(ol[0].props.start).toBe(3);
  });

  it('parses pipe tables, padding rows to the header width', () => {
    const out = renderMarkdown('| A | B |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |');
    expect(els(out, 'th')).toHaveLength(2);
    expect(els(out, 'td')).toHaveLength(4);
  });

  it('renders block quotes recursively', () => {
    const out = renderMarkdown('> # quoted\n> body');
    const q = els(out, 'blockquote');
    expect(q).toHaveLength(1);
    expect(els(q[0], 'h1')).toHaveLength(1);
  });

  it('treats --- as a thematic break, not a list', () => {
    const out = renderMarkdown('above\n\n---\n\nbelow');
    expect(els(out, 'hr')).toHaveLength(1);
    expect(els(out, 'ul')).toHaveLength(0);
  });
});

describe('renderMarkdown inlines', () => {
  it('renders emphasis, strong, strikethrough and inline code', () => {
    const out = renderMarkdown('*em* **strong** ~~gone~~ `code`');
    expect(text(els(out, 'em')[0])).toBe('em');
    expect(text(els(out, 'strong')[0])).toBe('strong');
    expect(text(els(out, 'del')[0])).toBe('gone');
    expect(text(els(out, 'code')[0])).toBe('code');
  });

  it('leaves snake_case identifiers alone', () => {
    const out = renderMarkdown('call repo_file_content here');
    expect(els(out, 'em')).toHaveLength(0);
    expect(text(out)).toContain('repo_file_content');
  });

  it('keeps markdown literal inside a code span', () => {
    const out = renderMarkdown('`a **b** c`');
    expect(text(els(out, 'code')[0])).toBe('a **b** c');
    expect(els(out, 'strong')).toHaveLength(0);
  });

  it('renders raw HTML as literal text (no element injection)', () => {
    const out = renderMarkdown('<script>alert(1)</script> & <img src=x>');
    expect(els(out, 'script')).toHaveLength(0);
    expect(els(out, 'img')).toHaveLength(0);
    expect(text(out)).toContain('<script>alert(1)</script>');
  });

  it('gives http(s) links a real href and routes clicks to the handler', () => {
    const clicks: string[] = [];
    const out = renderMarkdown('[site](https://example.com)', { onLinkClick: (h) => clicks.push(h) });
    const a = els(out, 'a')[0];
    expect(a.props.href).toBe('https://example.com');
    a.props.onClick({ preventDefault: () => {} });
    expect(clicks).toEqual(['https://example.com']);
  });

  it('withholds href from non-http targets but keeps them operable', () => {
    const out = renderMarkdown('[doc](./PRD.md)');
    const a = els(out, 'a')[0];
    expect(a.props.href).toBeUndefined();
    expect(a.props.tabIndex).toBe(0);
  });

  it('routes images through the renderImage handler', () => {
    const seen: string[] = [];
    renderMarkdown('![logo](./strand.png)', {
      renderImage: (src, alt, key) => {
        seen.push(`${src}|${alt}`);
        return <span key={key} />;
      },
    });
    expect(seen).toEqual(['./strand.png|logo']);
  });

  it('autolinks <https://…> URLs', () => {
    const out = renderMarkdown('see <https://strand.dev> now');
    expect(els(out, 'a')[0].props.href).toBe('https://strand.dev');
  });
});
