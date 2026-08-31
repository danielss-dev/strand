import { useMemo } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { renderMarkdown } from '../../../lib/markdown';

/**
 * Chat-safe Markdown body for Heroi turns. Reuses Strand's first-party
 * React-element renderer (no HTML execution, theme via `.markdown` tokens).
 */
export function MessageMarkdown({ text }: { text: string }) {
  const nodes = useMemo(
    () => renderMarkdown(text, {
      onLinkClick: (href) => {
        if (/^(https?:|mailto:)/i.test(href)) void shellOpen(href);
      },
    }),
    [text],
  );
  return <div className="plugin-heroi-message-body markdown">{nodes}</div>;
}
