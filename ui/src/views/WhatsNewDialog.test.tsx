import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { t } from '../lib/i18n';
import type { StrandRelease } from '../lib/releases';
import { WhatsNewLayout, WhatsNewPrAccordion } from './WhatsNewDialog';

const releases: StrandRelease[] = [
  { tag: 'v1.7.7', version: '1.7.7', notes: '' },
  { tag: 'v1.7.6', version: '1.7.6', notes: '## Workbench\n\nOpen files from Review.' },
  { tag: 'v1.7.5', version: '1.7.5', notes: 'Healed blank taskbar pins.' },
];

function render(ui: JSX.Element): string {
  return renderToStaticMarkup(ui);
}

describe('WhatsNewLayout', () => {
  it('lists multiple versions newest first', () => {
    const html = render(
      <WhatsNewLayout
        state={{ status: 'ready', releases }}
        selectedVersion="1.7.7"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    const first = html.indexOf('1.7.7');
    const second = html.indexOf('1.7.6');
    const third = html.indexOf('1.7.5');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(html).toContain('role="tablist"');
  });

  it('selecting a version shows its notes', () => {
    const workbench = render(
      <WhatsNewLayout
        state={{ status: 'ready', releases }}
        selectedVersion="1.7.6"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(workbench).toContain('<h2');
    expect(workbench).toContain('Workbench');
    expect(workbench).toContain('Open files from Review.');
    expect(workbench).not.toContain('Healed blank taskbar pins.');
    expect(workbench).toContain('id="whats-new-tab-1.7.6"');
    expect(workbench).toContain('aria-selected="true"');

    const pins = render(
      <WhatsNewLayout
        state={{ status: 'ready', releases }}
        selectedVersion="1.7.5"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(pins).toContain('Healed blank taskbar pins.');
    expect(pins).not.toContain('Open files from Review.');
    expect(pins).toContain('id="whats-new-tab-1.7.5"');
  });

  it('shows an empty state when the selected version has no notes', () => {
    const html = render(
      <WhatsNewLayout
        state={{ status: 'ready', releases }}
        selectedVersion="1.7.7"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain(t('whatsNew.empty'));
    expect(html).toContain(t('whatsNew.emptyHint'));
    expect(html).not.toContain('Open files from Review.');
  });

  it('shows a recoverable error state', () => {
    const onRetry = vi.fn();
    const html = render(
      <WhatsNewLayout
        state={{ status: 'error' }}
        selectedVersion={null}
        onSelect={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(html).toContain(t('whatsNew.error'));
    expect(html).toContain(t('whatsNew.errorHint'));
    expect(html).toContain(t('whatsNew.retry'));
    expect(html).not.toContain('1.7.6');
  });
});

const prs = [
  { number: 145, url: 'https://github.com/danielss-dev/strand/pull/145', title: 'Open files in Workbench' },
  { number: 144, url: 'https://github.com/danielss-dev/strand/pull/144', title: 'Hide WSL console' },
];

describe('WhatsNewPrAccordion', () => {
  it('renders one collapsed item per PR', () => {
    const html = render(
      <WhatsNewPrAccordion
        intro="Right-click a file in **Local Changes**."
        prs={prs}
        expanded={new Set()}
        bodies={{}}
        onToggle={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('Open files in Workbench');
    expect(html).toContain('Hide WSL console');
    expect(html).toContain('Local Changes');
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(2);
    expect(html).not.toContain(t('whatsNew.prLoading'));
  });

  it('shows the cleaned PR body when an item is expanded', () => {
    const html = render(
      <WhatsNewPrAccordion
        intro=""
        prs={prs}
        expanded={new Set([145])}
        bodies={{ 145: { status: 'ready', text: '## Behaviour\n\nOpen the whole file in Work.' } }}
        onToggle={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<h2');
    expect(html).toContain('Behaviour');
    expect(html).toContain('Open the whole file in Work.');
    expect(html).not.toContain('Open in Web');
    expect(html).not.toContain('CURSOR_AGENT');
  });

  it('falls back to markdown when the release has no PR list', () => {
    const html = render(
      <WhatsNewLayout
        state={{ status: 'ready', releases }}
        selectedVersion="1.7.5"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('Healed blank taskbar pins.');
    expect(html).not.toContain('whats-new-pr-header');
    expect(html).not.toContain(t('whatsNew.changes'));
  });

  it('shows an empty description when the cleaned PR body is blank', () => {
    const html = render(
      <WhatsNewPrAccordion
        intro=""
        prs={prs}
        expanded={new Set([145])}
        bodies={{ 145: { status: 'ready', text: '' } }}
        onToggle={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain(t('whatsNew.prEmpty'));
  });

  it('shows a per-item error with retry', () => {
    const html = render(
      <WhatsNewPrAccordion
        intro=""
        prs={prs}
        expanded={new Set([144])}
        bodies={{ 144: { status: 'error' } }}
        onToggle={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain(t('whatsNew.prError'));
    expect(html).toContain(t('whatsNew.prErrorHint'));
    expect(html).toContain(t('whatsNew.retry'));
    expect(html).not.toContain('Open the whole file in Work.');
  });
});
