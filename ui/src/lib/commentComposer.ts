export type CommentFormat =
  | 'bold'
  | 'italic'
  | 'code'
  | 'quote'
  | 'bullet-list'
  | 'numbered-list'
  | 'task-list'
  | 'link'
  | 'image';

export interface CommentEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function wrapSelection(
  value: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): CommentEdit {
  const selected = value.slice(start, end) || placeholder;
  const replacement = `${prefix}${selected}${suffix}`;
  const selectionStart = start + prefix.length;
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    selectionStart,
    selectionEnd: selectionStart + selected.length,
  };
}

function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
): CommentEdit {
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(lineStart, lineEnd) || 'list item';
  const replacement = block.split('\n').map((line, index) => `${prefix(index)}${line}`).join('\n');
  return {
    value: value.slice(0, lineStart) + replacement + value.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length,
  };
}

/** Apply one Markdown toolbar action while preserving a useful editor selection. */
export function applyCommentFormat(
  value: string,
  start: number,
  end: number,
  format: CommentFormat,
): CommentEdit {
  switch (format) {
    case 'bold': return wrapSelection(value, start, end, '**', '**', 'bold text');
    case 'italic': return wrapSelection(value, start, end, '_', '_', 'italic text');
    case 'code': {
      const selected = value.slice(start, end);
      return selected.includes('\n')
        ? wrapSelection(value, start, end, '```\n', '\n```', 'code')
        : wrapSelection(value, start, end, '`', '`', 'code');
    }
    case 'quote': return prefixLines(value, start, end, () => '> ');
    case 'bullet-list': return prefixLines(value, start, end, () => '- ');
    case 'numbered-list': return prefixLines(value, start, end, (index) => `${index + 1}. `);
    case 'task-list': return prefixLines(value, start, end, () => '- [ ] ');
    case 'link': {
      const label = value.slice(start, end) || 'link text';
      const replacement = `[${label}](https://)`;
      const urlStart = start + label.length + 3;
      return {
        value: value.slice(0, start) + replacement + value.slice(end),
        selectionStart: urlStart,
        selectionEnd: urlStart + 'https://'.length,
      };
    }
    case 'image': {
      const alt = value.slice(start, end) || 'screenshot description';
      const replacement = `![${alt}](https://)`;
      const urlStart = start + alt.length + 4;
      return {
        value: value.slice(0, start) + replacement + value.slice(end),
        selectionStart: urlStart,
        selectionEnd: urlStart + 'https://'.length,
      };
    }
  }
}
