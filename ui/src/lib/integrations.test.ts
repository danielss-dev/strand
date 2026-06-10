import { describe, expect, it } from 'vitest';

import { editorPresets, resolveTemplate, terminalPresets } from './integrations';

describe('resolveTemplate', () => {
  const presets = editorPresets('macos');

  it('null tool resolves to null', () => {
    expect(resolveTemplate(null, presets)).toBeNull();
  });

  it('preset id resolves to its template', () => {
    expect(resolveTemplate({ kind: 'preset', id: 'vscode' }, presets)).toBe(
      'code -g {file}:{line}',
    );
  });

  it('unknown preset id (e.g. stored on another platform) resolves to null', () => {
    expect(resolveTemplate({ kind: 'preset', id: 'wt' }, presets)).toBeNull();
  });

  it('custom template passes through trimmed', () => {
    expect(resolveTemplate({ kind: 'custom', template: '  mate {file}  ' }, presets)).toBe(
      'mate {file}',
    );
  });

  it('blank custom template resolves to null', () => {
    expect(resolveTemplate({ kind: 'custom', template: '   ' }, presets)).toBeNull();
  });
});

describe('preset registries', () => {
  it('every editor preset mentions {file}', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      for (const p of editorPresets(os)) expect(p.template).toContain('{file}');
    }
  });

  it('every terminal preset mentions {dir}', () => {
    for (const os of ['macos', 'windows', 'linux'] as const) {
      for (const p of terminalPresets(os)) expect(p.template).toContain('{dir}');
    }
  });
});
