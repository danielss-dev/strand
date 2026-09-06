import { useEffect, useRef, useState } from 'react';
import '../../styles/user-actions.css';
import { Select } from '../../components/Select';
import { parseActionArgs, type UserAction } from '../../lib/userActions';
import { useSettings } from '../../stores/settings';

const fresh = (): UserAction => ({ id: crypto.randomUUID(), name: '', scope: 'repository', executable: 'git', args: ['status', '--short'], cwd: 'repository' });

export function UserActionsEditor({ focusOnMount = false }: { focusOnMount?: boolean }) {
  const actions = useSettings((state) => state.userActions);
  const [draft, setDraft] = useState(fresh);
  const [args, setArgs] = useState('["status", "--short"]');
  const [message, setMessage] = useState('');
  const savedRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = requestAnimationFrame(() => { savedRef.current?.focus(); savedRef.current?.scrollIntoView({ block: 'center' }); });
    return () => cancelAnimationFrame(frame);
  }, [focusOnMount]);
  function edit(action: UserAction) {
    setDraft({ ...action }); setArgs(JSON.stringify(action.args, null, 2)); setMessage('');
  }
  function save() {
    try {
      if (!draft.name.trim() || !draft.executable.trim()) throw new Error('Enter a name and executable.');
      const saved = { ...draft, name: draft.name.trim(), executable: draft.executable.trim(), args: parseActionArgs(args) };
      const current = useSettings.getState().userActions;
      if (current.length >= 100 && !current.some((action) => action.id === draft.id)) throw new Error('Limit of 100 saved actions reached.');
      useSettings.getState().set('userActions', [...current.filter((action) => action.id !== draft.id), saved]);
      setMessage('Action saved. Run it from its context menu or Quick Launch.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <div className="settings-field user-actions-editor">
      <h3>User actions</h3>
      <p className="settings-hint">Personal executable commands for repositories, refs, or working-tree files. These are separate from Workbench commands and bundled plugins.</p>
      <label className="settings-field-label">Saved action
        <Select ref={savedRef} className="settings-select" aria-label="Saved action" value={actions.some((action) => action.id === draft.id) ? draft.id : ''} onChange={(event) => {
          edit(actions.find((item) => item.id === event.target.value) ?? fresh());
        }}>
          <option value="">New action</option>
          {actions.map((action) => <option key={action.id} value={action.id}>{action.name} ({action.scope})</option>)}
        </Select>
      </label>
      <div className="user-actions-buttons"><button className="btn" onClick={() => edit(fresh())}>New action</button>
        <button className="btn danger" disabled={!actions.some((action) => action.id === draft.id)} onClick={() => {
          useSettings.getState().set('userActions', actions.filter((action) => action.id !== draft.id)); edit(fresh());
        }}>Delete action</button></div>
      <label className="settings-field-label">Action name<input className="clone-input" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="settings-field-label">Context
        <Select className="settings-select" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as UserAction['scope'], cwd: 'repository' })}>
          <option value="repository">Repository</option><option value="ref">Selected branch or tag</option><option value="file">Selected working-tree file</option>
        </Select>
      </label>
      <label className="settings-field-label">Executable<input className="clone-input" value={draft.executable} maxLength={4096} onChange={(event) => setDraft({ ...draft, executable: event.target.value })} /></label>
      <p className="settings-hint">Installed command or absolute executable path, without quotes. On Windows, use a native .exe; pass script paths as arguments to their interpreter.</p>
      <label className="settings-field-label">Arguments (JSON array)<textarea className="clone-input" rows={5} value={args} spellCheck={false} onChange={(event) => setArgs(event.target.value)} /></label>
      <p className="settings-hint">Each string is one argument, including empty strings. Placeholders: {'{repo}'}; file: {'{file}'}, {'{relativeFile}'}; ref: {'{ref}'}, {'{oid}'}. Double braces produce literal braces. Use -- before file operands where the tool supports it.</p>
      <label className="settings-field-label">Working directory
        <Select className="settings-select" value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value as UserAction['cwd'] })}>
          <option value="repository">Repository root</option>{draft.scope === 'file' && <option value="file-parent">Selected file’s parent</option>}
        </Select>
      </label>
      <p className="settings-hint">Runs with your account permissions. No shell is added. Keep placeholders out of interpreter code; pass them as script arguments. Every run requires a resolved preview.</p>
      <button className="btn primary" onClick={save}>Save action</button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
