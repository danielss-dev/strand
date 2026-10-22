import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { t } from '../lib/i18n';
import { ConflictSuggestionReview } from './ConflictSuggestionReview';

const suggestion = {
  text: 'fn renamed_helper() {}',
  explanation: 'The incoming name matches the new call.',
  confidence: 'high' as const,
};

describe('ConflictSuggestionReview', () => {
  it('offers accept, edit, and reject without writing', () => {
    const html = renderToStaticMarkup(
      <ConflictSuggestionReview
        suggestion={suggestion}
        editing={false}
        draft=""
        rejected={false}
        onAccept={() => { throw new Error('accept must not run during render'); }}
        onEdit={() => { throw new Error('edit must not run during render'); }}
        onReject={() => { throw new Error('reject must not run during render'); }}
        onDraft={() => {}}
        onUseEdit={() => {}}
        onCancelEdit={() => {}}
      />,
    );
    expect(html).toContain(t('merge.ai.accept'));
    expect(html).toContain(t('merge.ai.edit'));
    expect(html).toContain(t('merge.ai.reject'));
    expect(html).toContain(t('merge.ai.confidence.high'));
    expect(html).toContain('The incoming name matches the new call.');
    expect(html).toContain('fn renamed_helper() {}');
  });

  it('warns on a truncated hunk and disables one-click Accept but keeps Edit', () => {
    const html = renderToStaticMarkup(
      <ConflictSuggestionReview
        suggestion={{ ...suggestion, truncated: true }}
        editing={false}
        draft=""
        rejected={false}
        onAccept={() => {}}
        onEdit={() => {}}
        onReject={() => {}}
        onDraft={() => {}}
        onUseEdit={() => {}}
        onCancelEdit={() => {}}
      />,
    );
    expect(html).toContain(t('merge.ai.truncated'));
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t('merge.ai.accept')}</button>`));
    expect(html).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t('merge.ai.edit')}</button>`));

    const full = renderToStaticMarkup(
      <ConflictSuggestionReview
        suggestion={{ ...suggestion, truncated: false }}
        editing={false}
        draft=""
        rejected={false}
        onAccept={() => {}}
        onEdit={() => {}}
        onReject={() => {}}
        onDraft={() => {}}
        onUseEdit={() => {}}
        onCancelEdit={() => {}}
      />,
    );
    expect(full).not.toContain(t('merge.ai.truncated'));
    expect(full).not.toContain('disabled=""');
  });

  it('shows the editable draft and a rejected hint', () => {
    const html = renderToStaticMarkup(
      <ConflictSuggestionReview
        suggestion={suggestion}
        editing
        draft={'fn helper() {}\nfn renamed_helper() {}'}
        rejected
        onAccept={() => {}}
        onEdit={() => {}}
        onReject={() => {}}
        onDraft={() => {}}
        onUseEdit={() => {}}
        onCancelEdit={() => {}}
      />,
    );
    expect(html).toContain(t('merge.ai.useEdit'));
    expect(html).toContain(t('merge.ai.rejectedHint'));
    expect(html).toContain('fn renamed_helper() {}');
    expect(html).not.toContain(`>${t('merge.ai.accept')}<`);
  });
});
