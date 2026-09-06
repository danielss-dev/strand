import { useEffect, useRef, useState } from 'react';
import '../../styles/user-actions.css';
import { Select } from '../../components/Select';
import { parseActionArgs, type UserAction } from '../../lib/userActions';
import { useSettings } from '../../stores/settings';

const fresh = (): UserAction => ({ id: crypto.randomUUID(), name: '', scope: 'repository', executable: 'git', args: ['status', '--short'], cwd: 'repository' });

export function UserActionsEditor({ focusOnMount = false }: { focusOnMount?: boolean }) {
  const actions = useSettings((state) => state.userActions);
  const [draft, setDraft] = useState(fresh);
  const [message, setMessage] = useState('');
  const savedRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = requestAnimationFrame(() => { savedRef.current?.focus(); savedRef.current?.scrollIntoView({ block: 'center' }); });
    return () => cancelAnimationFrame(frame);
  }, [focusOnMount]);
  function edit(action: UserAction) {
    setDraft({ ...action, args: [...action.args] }); setMessage('');
  }
  function save() {
    try {
      if (!draft.name.trim() || !draft.executable.trim()) throw new Error('Enter a name and executable.');
      const saved = { ...draft, name: draft.name.trim(), executable: draft.executable.trim(), args: parseActionArgs(JSON.stringify(draft.args)) };
      const current = useSettings.getState().userActions;
      if (current.length >= 100 && !current.some((action) => action.id === draft.id)) throw new Error('Limit of 100 saved actions reached.');
      useSettings.getState().set('userActions', [...current.filter((action) => action.id !== draft.id), saved]);
      setMessage('Action saved. Run it from its context menu or Quick Launch.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <div className="settings-field user-actions-editor">
      <h3>User actions</h3>
      <p className="settings-hint">Save commands you use often, then run them from a repository, branch, tag or file’s Actions menu.</p>
      <label className="settings-field-label">Saved action
        <Select ref={savedRef} className="settings-select" aria-label="Saved action" value={actions.some((action) => action.id === draft.id) ? draft.id : ''} onChange={(event) => {
          edit(actions.find((item) => item.id === event.target.value) ?? fresh());
        }}>
          <option value="">New action</option>
          {actions.map((action) => <option key={action.id} value={action.id}>{action.name} ({action.scope === 'ref' ? 'branch or tag' : action.scope})</option>)}
        </Select>
      </label>
      <div className="user-actions-buttons"><button className="btn" onClick={() => edit(fresh())}>New action</button>
        <button className="btn danger" disabled={!actions.some((action) => action.id === draft.id)} onClick={() => {
          useSettings.getState().set('userActions', actions.filter((action) => action.id !== draft.id)); edit(fresh());
        }}>Delete action</button></div>
      <label className="settings-field-label">Action name<input className="clone-input" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="settings-field-label">Show action for
        <Select className="settings-select" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as UserAction['scope'], cwd: 'repository' })}>
          <option value="repository">Repository</option><option value="ref">Selected branch or tag</option><option value="file">Selected working-tree file</option>
        </Select>
      </label>
      <label className="settings-field-label">Command or program<input className="clone-input" value={draft.executable} maxLength={4096} onChange={(event) => setDraft({ ...draft, executable: event.target.value })} /></label>
      <p className="settings-hint">Installed command or absolute executable path, without quotes. On Windows, use a native .exe; pass script paths as arguments to their interpreter.</p>
      <div className="user-action-arguments" role="group" aria-label="Command arguments">
        <span className="settings-field-label">Arguments</span>
        {draft.args.map((arg, index) => <div className="settings-row" key={index}>
          <input className="clone-input" aria-label={`Argument ${index + 1}`} value={arg} spellCheck={false}
            onChange={event => setDraft({ ...draft, args: draft.args.map((value, i) => i === index ? event.target.value : value) })} />
          <button type="button" className="btn" aria-label={`Remove argument ${index + 1}`}
            onClick={() => setDraft({ ...draft, args: draft.args.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        <button type="button" className="btn" disabled={draft.args.length >= 128} onClick={() => setDraft({ ...draft, args: [...draft.args, ''] })}>Add argument</button>
      </div>
      <p className="settings-hint">Each row is one argument. Spaces stay within that argument; a blank row passes an empty argument.</p>
      <details className="settings-disclosure"><summary>Use the selected repository, branch or file</summary>
        <p className="settings-hint">Insert {'{repo}'} for the repository path, {'{file}'} or {'{relativeFile}'} for the selected file, and {'{ref}'} or {'{oid}'} for the selected branch/tag or commit hash. Double braces insert literal braces. Use -- before file arguments when the command supports it.</p>
      </details>
      <label className="settings-field-label">Working directory
        <Select className="settings-select" value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value as UserAction['cwd'] })}>
          <option value="repository">Repository root</option>{draft.scope === 'file' && <option value="file-parent">Selected file’s parent</option>}
        </Select>
      </label>
      <p className="settings-hint">Runs with your account permissions. No shell is added. Keep placeholders out of interpreter code; pass them as script arguments. Review the command before each run.</p>
      <button className="btn primary" onClick={save}>Save action</button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
