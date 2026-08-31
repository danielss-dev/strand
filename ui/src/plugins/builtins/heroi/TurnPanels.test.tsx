import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { TurnFileChanges, TurnToolCalls } from './TurnPanels';
import type { HeroiActivityLike } from './turnArtifacts';

const activities: HeroiActivityLike[] = [
  {
    id: '1',
    label: 'Using Write',
    detail: JSON.stringify({ file_path: 'src/a.ts', content: 'x' }),
    state: 'done',
  },
  {
    id: '2',
    label: 'Using Bash',
    detail: 'pnpm test',
    state: 'done',
  },
  {
    id: '3',
    label: 'Editing files',
    detail: JSON.stringify({ changes: [{ path: 'docs/old.md', kind: 'delete' }] }),
    state: 'done',
  },
];

describe('TurnPanels', () => {
  it('lists added/changed/deleted files for the turn and groups tool calls in one control', () => {
    const onOpenPath = vi.fn();
    const files = renderToStaticMarkup(
      <TurnFileChanges
        activities={activities}
        projectPath="/repo"
        onOpenPath={onOpenPath}
      />,
    );
    expect(files).toContain('Files this turn');
    expect(files).toContain('Added');
    expect(files).toContain('src/a.ts');
    expect(files).toContain('Deleted');
    expect(files).toContain('docs/old.md');
    expect(files).not.toContain('Using Bash');

    const collapsed = renderToStaticMarkup(
      <TurnToolCalls
        messageId="m1"
        activities={activities}
        expanded={false}
        onToggleGroup={() => undefined}
        expandedActivities={new Set()}
        onToggleActivity={() => undefined}
      />,
    );
    expect(collapsed).toContain('Tool calls (3)');
    expect(collapsed).toContain('plugin-heroi-tool-group');
    expect(collapsed).not.toContain('Using Bash');
    expect(collapsed).not.toContain('Using Write');

    const expanded = renderToStaticMarkup(
      <TurnToolCalls
        messageId="m1"
        activities={activities}
        expanded
        onToggleGroup={() => undefined}
        expandedActivities={new Set()}
        onToggleActivity={() => undefined}
      />,
    );
    expect(expanded).toContain('Using Write');
    expect(expanded).toContain('Using Bash');
    expect(expanded).toContain('Editing files');
    // Still one outer group wrapper — not a stack of top-level activity blocks.
    expect(expanded.match(/class="plugin-heroi-tool-group"/g)?.length).toBe(1);
    expect(expanded.match(/class="plugin-heroi-activity /g)?.length).toBe(3);
  });
});
