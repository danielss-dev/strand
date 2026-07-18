import { Icon } from './Icon';
import { Presence } from './Presence';
import { t } from '../lib/i18n';

export interface ToastMessage {
  msg: string;
  kind: 'success' | 'error';
}

interface Props {
  networkMessage: string | null;
  networkOperationId: string | null;
  toast: ToastMessage | null;
  onCancelNetwork: (operationId: string) => void;
}

/** Visual notification stack plus one stable live region for screen readers. */
export function ToastViewport({
  networkMessage,
  networkOperationId,
  toast,
  onCancelNetwork,
}: Props) {
  return (
    <>
      {/* Mounting/unmounting visible pills is unreliable for screen readers,
          so the active message is mirrored through an always-present node. */}
      <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
        {toast?.msg ?? networkMessage ?? ''}
      </div>

      <Presence value={networkMessage}>
        {(message, exiting) => (
          <div
            className={`toast progress${exiting ? ' exiting' : ''}`}
            aria-hidden={networkOperationId && !exiting ? undefined : 'true'}
          >
            <span aria-hidden="true" className="icon-spin"><Icon name="refresh" size={13} /></span>
            <span aria-hidden="true">{message}</span>
            {networkOperationId && !exiting && (
              <button
                type="button"
                className="toast-action"
                aria-label={t('toast.cancelNetwork')}
                onClick={() => onCancelNetwork(networkOperationId)}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        )}
      </Presence>

      <Presence value={toast}>
        {(message, exiting) => (
          <div className={`toast${exiting ? ' exiting' : ''}`} aria-hidden="true">
            <span style={{ color: message.kind === 'error' ? 'var(--del)' : 'var(--add)' }}>
              <Icon name={message.kind === 'error' ? 'x' : 'check'} size={13} stroke={2.2} />
            </span>
            <span>{message.msg}</span>
          </div>
        )}
      </Presence>
    </>
  );
}
