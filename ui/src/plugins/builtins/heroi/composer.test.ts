import { describe, expect, it } from 'vitest';

import { appendFileMentions, composerTrigger, replaceComposerTrigger } from './composer';

describe('Heroi composer references', () => {
  it('finds file and skill triggers at the cursor', () => {
    expect(composerTrigger('review @src/ap', 'review @src/ap'.length)).toMatchObject({ marker: '@', query: 'src/ap' });
    expect(composerTrigger('/ver', 4)).toMatchObject({ marker: '/', query: 'ver' });
    expect(composerTrigger('https://strand.dev', 18)).toBeNull();
  });

  it('serializes selected files and skills for the provider prompt', () => {
    const trigger = composerTrigger('use /ver', 8)!;
    expect(replaceComposerTrigger('use /ver', trigger, {
      kind: 'skill', value: 'verify', detail: '',
    })).toEqual({ text: 'use $verify ', cursor: 12 });
    expect(appendFileMentions('review', ['src/App.tsx', 'docs/my file.md']))
      .toBe('review @src/App.tsx @"docs/my file.md" ');
  });
});
