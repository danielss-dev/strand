import { describe, expect, it } from 'vitest';

interface NodeProcess {
  getBuiltinModule(name: 'fs'): {
    readFileSync(path: URL, encoding: 'utf8'): string;
  };
}

const { process } = globalThis as typeof globalThis & { process: NodeProcess };
const features = process
  .getBuiltinModule('fs')
  .readFileSync(new URL('../styles/features.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = features.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing ${selector} rule`);
  return match[1];
}

describe('Work terminal renderer visibility', () => {
  it('keeps the stable runtime layer visible and hides inactive panes individually', () => {
    expect(rule('.terminal-runtime-layer')).not.toContain('visibility: hidden');
    expect(rule('.work-terminal-pane')).toContain('visibility: hidden');
    expect(rule('.work-terminal-pane.visible')).toContain('visibility: visible');
  });
});
