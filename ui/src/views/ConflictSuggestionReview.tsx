import { t } from '../lib/i18n';
import type { ConflictConfidence, AiHunkSuggestion } from '../lib/conflictAi';

function confidenceLabel(level: ConflictConfidence): string {
  switch (level) {
    case 'low':
      return t('merge.ai.confidence.low');
    case 'medium':
      return t('merge.ai.confidence.medium');
    case 'high':
      return t('merge.ai.confidence.high');
    default: {
      const _never: never = level;
      return _never;
    }
  }
}

/**
 * Review controls for one AI hunk suggestion. Accept, edit, and reject only
 * notify the parent — this component never writes the file.
 */
export function ConflictSuggestionReview({
  suggestion,
  editing,
  draft,
  rejected,
  onAccept,
  onEdit,
  onReject,
  onDraft,
  onUseEdit,
  onCancelEdit,
}: {
  suggestion: AiHunkSuggestion;
  editing: boolean;
  draft: string;
  rejected: boolean;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
  onDraft: (value: string) => void;
  onUseEdit: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="mm-ai" role="region" aria-label={t('merge.ai.region')}>
      <p className="mm-ai-meta">
        {t('merge.ai.confidence', { level: confidenceLabel(suggestion.confidence) })}
        {rejected ? ` · ${t('merge.ai.rejectedHint')}` : ''}
      </p>
      <p className="mm-ai-explain">{suggestion.explanation}</p>
      {suggestion.truncated && <p className="mm-ai-truncated" role="note">{t('merge.ai.truncated')}</p>}
      {editing ? (
        <>
          <textarea
            className="mm-ai-edit"
            aria-label={t('merge.ai.editLabel')}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
          />
          <div className="mm-ai-btns">
            <button type="button" className="btn primary" onClick={onUseEdit}>{t('merge.ai.useEdit')}</button>
            <button type="button" className="btn" onClick={onCancelEdit}>{t('common.cancel')}</button>
          </div>
        </>
      ) : (
        <>
          <pre className="mm-ai-preview">{suggestion.text}</pre>
          <div className="mm-ai-btns">
            <button
              type="button"
              className="btn primary"
              disabled={suggestion.truncated}
              title={suggestion.truncated ? t('merge.ai.truncatedAccept') : undefined}
              onClick={onAccept}
            >
              {t('merge.ai.accept')}
            </button>
            <button type="button" className="btn" onClick={onEdit}>{t('merge.ai.edit')}</button>
            <button type="button" className="btn" onClick={onReject}>{t('merge.ai.reject')}</button>
          </div>
        </>
      )}
    </div>
  );
}
