import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

/**
 * Minimal Markdown → React renderer for the file view's Preview tab.
 *
 * Hand-rolled on purpose: the output is React elements, never an HTML string,
 * so repo content can't inject markup into the IPC-privileged webview — no
 * sanitizer dependency to keep honest (raw HTML in the source renders as
 * literal text). Covers the GitHub subset real READMEs use: ATX + setext-h1
 * headings, fenced code, nested/task lists, block quotes, pipe tables,
 * thematic breaks, emphasis/strong/strikethrough, inline code, links, images
 * and `<…>` autolinks. Pure module (no store/tauri imports) so it stays
 * unit-testable — see the lib-not-views learning.
 */

export interface MarkdownHandlers {
  /** Every link click lands here; default navigation is always prevented —
   *  the webview must never navigate itself. */
  onLinkClick?: (href: string) => void;
  /** Renders an image; `src` is the raw target (may be repo-relative). */
  renderImage?: (src: string, alt: string, key: string) => ReactNode;
}

/** True when the path renders in the markdown preview. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

export function renderMarkdown(text: string, handlers: MarkdownHandlers = {}): ReactNode[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'), handlers, 'md');
}

// ─── blocks ───────────────────────────────────────────────────────────────

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const ATX_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const SETEXT_H1_RE = /^\s{0,3}=+\s*$/;

function parseBlocks(lines: string[], h: MarkdownHandlers, kb: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `${kb}.${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code — collected verbatim, no inline parsing.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const closeRe = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) body.push(lines[j++]);
      out.push(
        <pre className="md-pre" key={key()} data-lang={fence[2] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      i = j + 1;
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      const Tag = `h${atx[1].length}` as 'h1';
      out.push(<Tag key={key()}>{parseInline(atx[2], h, key())}</Tag>);
      i++;
      continue;
    }

    // Thematic break — before lists, or `- - -` reads as an item.
    if (HR_RE.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(lines[i++].replace(QUOTE_RE, ''));
      out.push(<blockquote className="md-quote" key={key()}>{parseBlocks(inner, h, key())}</blockquote>);
      continue;
    }

    if (ITEM_RE.test(line)) {
      const list = parseList(lines, i, h, key());
      out.push(list.node);
      i = list.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      const table = parseTable(lines, i, h, key());
      out.push(table.node);
      i = table.next;
      continue;
    }

    // Setext h1 (`Title` over `===`). `---` stays a thematic break.
    if (i + 1 < lines.length && SETEXT_H1_RE.test(lines[i + 1])) {
      out.push(<h1 key={key()}>{parseInline(line.trim(), h, key())}</h1>);
      i += 2;
      continue;
    }

    // Paragraph — soft line breaks join with a space.
    const para: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !startsBlock(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(<p key={key()}>{parseInline(para.join(' '), h, key())}</p>);
  }
  return out;
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) || ATX_RE.test(line) || HR_RE.test(line) ||
    QUOTE_RE.test(line) || ITEM_RE.test(line) || SETEXT_H1_RE.test(line)
  );
}

const leadingSpaces = (s: string): number => s.length - s.trimStart().length;

function parseList(
  lines: string[],
  start: number,
  h: MarkdownHandlers,
  kb: string,
): { node: ReactNode; next: number } {
  const first = ITEM_RE.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;

  // `cont` = the column where an item's continuation lines start; deeper
  // content (nested lists, wrapped text) is collected into `sub` and parsed
  // recursively, which is what makes nesting work.
  interface Item { text: string; sub: string[]; cont: number }
  const items: Item[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM_RE.exec(line);
    const cur = items[items.length - 1];
    if (m && m[1].length === indent) {
      if (items.length && /^\d/.test(m[2]) !== ordered) break; // marker switch = new list
      items.push({ text: m[3], sub: [], cont: indent + m[2].length + 1 });
      i++;
    } else if (m && m[1].length < indent) {
      break; // belongs to an outer list
    } else if (!line.trim()) {
      // Blank: the list continues only if it resumes with a same-level item
      // or an indented continuation; otherwise it's over.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const nm = ITEM_RE.exec(lines[j]);
      if (nm && nm[1].length === indent) { i = j; continue; }
      if (cur && leadingSpaces(lines[j]) >= cur.cont) { cur.sub.push(''); i++; continue; }
      break;
    } else {
      const lead = leadingSpaces(line);
      if (cur && (lead >= cur.cont || (m && m[1].length > indent))) {
        cur.sub.push(line.slice(Math.min(lead, cur.cont)));
        i++;
      } else break;
    }
  }

  const children = items.map((it, n) => {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
    return (
      <li key={`${kb}.${n}`} className={task ? 'md-task' : undefined}>
        {task && <input type="checkbox" checked={task[1] !== ' '} readOnly disabled tabIndex={-1} />}
        {parseInline(task ? task[2] : it.text, h, `${kb}.${n}`)}
        {it.sub.length > 0 && parseBlocks(it.sub, h, `${kb}.${n}s`)}
      </li>
    );
  });

  const node = ordered ? (
    <ol key={kb} start={startNum !== 1 ? startNum : undefined}>{children}</ol>
  ) : (
    <ul key={kb}>{children}</ul>
  );
  return { node, next: i };
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableDelim(line: string): boolean {
  if (!line.includes('-') || !/^[\s|:-]+$/.test(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function parseTable(
  lines: string[],
  start: number,
  h: MarkdownHandlers,
  kb: string,
): { node: ReactNode; next: number } {
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? ('center' as const) : c.endsWith(':') ? ('right' as const) : undefined,
  );
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }

  const cell = (c: string, j: number, tag: 'th' | 'td', rk: string) => {
    const Tag = tag as 'td';
    return (
      <Tag key={`${rk}.${j}`} style={aligns[j] ? { textAlign: aligns[j] } : undefined}>
        {parseInline(c, h, `${rk}.${j}`)}
      </Tag>
    );
  };

  const node = (
    <table className="md-table" key={kb}>
      <thead>
        <tr>{head.map((c, j) => cell(c, j, 'th', `${kb}h`))}</tr>
      </thead>
      {rows.length > 0 && (
        <tbody>
          {rows.map((r, n) => (
            // Rows are padded/truncated to the header width, like GitHub.
            <tr key={`${kb}r${n}`}>{head.map((_, j) => cell(r[j] ?? '', j, 'td', `${kb}r${n}`))}</tr>
          ))}
        </tbody>
      )}
    </table>
  );
  return { node, next: i };
}

// ─── inlines ──────────────────────────────────────────────────────────────

const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function parseInline(s: string, h: MarkdownHandlers, kb: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;
  const key = () => `${kb}.${k++}`;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };

  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && PUNCT_RE.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    // Code span — a backtick run closed by an equal run; content stays literal.
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const close = findRun(s, i + run.length, run);
      if (close !== -1) {
        let content = s.slice(i + run.length, close);
        if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && content.trim())
          content = content.slice(1, -1);
        flush();
        out.push(<code className="md-code" key={key()}>{content}</code>);
        i = close + run.length;
        continue;
      }
    }

    if (c === '!' && s[i + 1] === '[') {
      const cb = matchBracket(s, i + 1);
      const tgt = cb !== -1 ? parseLinkTarget(s, cb + 1) : null;
      if (tgt) {
        const alt = s.slice(i + 2, cb);
        flush();
        out.push(h.renderImage ? h.renderImage(tgt.href, alt, key()) : defaultImage(tgt.href, alt, key()));
        i = tgt.end;
        continue;
      }
    }

    if (c === '[') {
      const cb = matchBracket(s, i);
      const tgt = cb !== -1 ? parseLinkTarget(s, cb + 1) : null;
      if (tgt) {
        flush();
        out.push(makeLink(tgt.href, parseInline(s.slice(i + 1, cb), h, key()), h, key()));
        i = tgt.end;
        continue;
      }
    }

    if (c === '<') {
      const m = /^<(https?:\/\/[^<>\s]+)>/.exec(s.slice(i));
      if (m) {
        flush();
        out.push(makeLink(m[1], [m[1]], h, key()));
        i += m[0].length;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const em = tryEmphasis(s, i, c, h, key);
      if (em) {
        flush();
        out.push(em.el);
        i = em.end;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Next occurrence of `run` that is an *exact* run (not part of a longer one). */
function findRun(s: string, from: number, run: string): number {
  for (let j = from; j <= s.length - run.length; j++) {
    if (s.startsWith(run, j) && s[j - 1] !== run[0] && s[j + run.length] !== run[0]) return j;
  }
  return -1;
}

/** Index of the `]` matching `s[open] === '['`, honoring nesting and escapes. */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Parse `(dest "title")` at `from`; returns the bare destination. */
function parseLinkTarget(s: string, from: number): { href: string; end: number } | null {
  if (s[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) {
      let inner = s.slice(from + 1, i).trim();
      const title = /\s+("[^"]*"|'[^']*')$/.exec(inner);
      if (title) inner = inner.slice(0, title.index).trim();
      if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1);
      return { href: inner, end: i + 1 };
    }
  }
  return null;
}

function tryEmphasis(
  s: string,
  i: number,
  c: string,
  h: MarkdownHandlers,
  key: () => string,
): { el: ReactNode; end: number } | null {
  const double = s[i + 1] === c;
  if (c === '~' && !double) return null; // only ~~strikethrough~~
  if (c === '_' && i > 0 && /\w/.test(s[i - 1])) return null; // snake_case stays text
  const delim = double ? c + c : c;
  const from = i + delim.length;
  if (from >= s.length || /\s/.test(s[from])) return null; // opener must hug text
  let close = findDelim(s, from, delim, c);
  while (close !== -1 && /\s/.test(s[close - 1])) close = findDelim(s, close + delim.length, delim, c);
  if (close === -1) return null;
  if (c === '_' && close + delim.length < s.length && /\w/.test(s[close + delim.length])) return null;
  const inner = s.slice(from, close);
  if (!inner.trim()) return null;
  const children = parseInline(inner, h, key());
  const el =
    c === '~' ? <del key={key()}>{children}</del>
    : double ? <strong key={key()}>{children}</strong>
    : <em key={key()}>{children}</em>;
  return { el, end: close + delim.length };
}

/** Next unescaped `delim` that isn't part of a longer same-char run (for `*`). */
function findDelim(s: string, from: number, delim: string, c: string): number {
  for (let j = from; j <= s.length - delim.length; j++) {
    if (!s.startsWith(delim, j) || s[j - 1] === '\\') continue;
    const after = s[j + delim.length] === c;
    if (delim.length === 1) {
      if (s[j - 1] !== c && !after) return j;
    } else if (!after) {
      return j;
    }
  }
  return -1;
}

function makeLink(href: string, children: ReactNode, h: MarkdownHandlers, key: string): ReactNode {
  const click = (e: MouseEvent) => {
    e.preventDefault();
    h.onLinkClick?.(href);
  };
  // Only safe schemes get a real href (middle-click / Enter never navigate a
  // javascript: or file: target); relative links stay keyboard-operable via
  // tabIndex + Enter.
  if (/^(https?:|mailto:)/i.test(href)) {
    return (
      <a key={key} className="md-link" href={href} title={href} onClick={click}>
        {children}
      </a>
    );
  }
  const keydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      h.onLinkClick?.(href);
    }
  };
  return (
    <a key={key} className="md-link" role="link" tabIndex={0} title={href} onClick={click} onKeyDown={keydown}>
      {children}
    </a>
  );
}

function defaultImage(src: string, alt: string, key: string): ReactNode {
  return /^(https?:|data:image\/)/i.test(src) ? (
    <img key={key} className="md-img" src={src} alt={alt} loading="lazy" />
  ) : (
    <span key={key} className="md-img-fallback">{alt || src}</span>
  );
}
