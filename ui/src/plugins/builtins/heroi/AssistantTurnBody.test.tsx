import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssistantTurnBody } from './AssistantTurnBody';
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
];

describe('AssistantTurnBody', () => {
  it('places tool calls above the markdown body, then files this turn', () => {
    const html = renderToStaticMarkup(
      <AssistantTurnBody
        messageId="m1"
        text={'## Reply\n\nDone.'}
        activities={activities}
        projectPath="/repo"
        toolsExpanded={false}
        onToggleGroup={() => undefined}
        expandedActivities={new Set()}
        onToggleActivity={() => undefined}
        onOpenPath={vi.fn()}
      />,
    );

    const toolsAt = html.indexOf('plugin-heroi-tool-group');
    const markdownAt = html.indexOf('plugin-heroi-message-body');
    const filesAt = html.indexOf('plugin-heroi-file-changes');

    expect(toolsAt).toBeGreaterThan(-1);
    expect(markdownAt).toBeGreaterThan(-1);
    expect(filesAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeLessThan(markdownAt);
    expect(markdownAt).toBeLessThan(filesAt);
    expect(html).toContain('Tool calls (2)');
    expect(html).toContain('<h2');
    expect(html).toContain('src/a.ts');
  });
});
