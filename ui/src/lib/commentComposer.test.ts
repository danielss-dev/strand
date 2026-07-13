import { describe, expect, it } from 'vitest';

import { applyCommentFormat } from './commentComposer';

describe('applyCommentFormat', () => {
  it('wraps selected text and keeps the content selected', () => {
    expect(applyCommentFormat('make this clear', 5, 9, 'bold')).toEqual({
      value: 'make **this** clear',
      selectionStart: 7,
      selectionEnd: 11,
    });
  });

  it('prefixes every selected line for lists', () => {
    const edit = applyCommentFormat('first\nsecond', 0, 12, 'numbered-list');
    expect(edit.value).toBe('1. first\n2. second');
    expect(edit.selectionStart).toBe(0);
    expect(edit.selectionEnd).toBe(edit.value.length);
  });

  it('selects the URL after inserting a screenshot', () => {
    const edit = applyCommentFormat('', 0, 0, 'image');
    expect(edit.value).toBe('![screenshot description](https://)');
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('https://');
  });

  it('uses a fenced block for multiline code', () => {
    expect(applyCommentFormat('one\ntwo', 0, 7, 'code').value).toBe('```\none\ntwo\n```');
  });
});
