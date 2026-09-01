import { Dialog } from '../components/Dialog';

/**
 * Confirmation boundary for rewriting a remote branch. Strand only exposes
 * `--force-with-lease`: it refuses when the remote moved since the last fetch,
 * while plain `--force` is intentionally unavailable.
 */
export function ForcePushDialog({
  branch,
  upstream,
  onClose,
  onConfirm,
}: {
  branch: string;
  upstream: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title="Force push with lease"
      icon="arrow-up"
      role="alertdialog"
      size="sm"
      describedBy="force-push-description"
      blockEscapeWhileBusy={false}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" onClick={onConfirm}>Force push with lease</button>
        </>
      }
    >
      <div className="clone-body">
        <p id="force-push-description" className="stash-blurb">
          Rewrite <code>{upstream ?? branch}</code> with the local history of <code>{branch}</code>?
        </p>
        <div className="clone-error">
          This can replace commits on the remote. Strand uses <code>--force-with-lease</code>,
          so the push is refused if the remote changed since your last fetch.
        </div>
      </div>
    </Dialog>
  );
}
