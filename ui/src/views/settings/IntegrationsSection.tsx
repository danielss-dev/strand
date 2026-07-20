import { useState } from 'react';

import { Select } from '../../components/Select';
import {
  editorPresets,
  resolveTemplate,
  terminalPresets,
  type AppPreset,
} from '../../lib/integrations';
import { errMessage, tauri } from '../../lib/tauri';
import { useRepo } from '../../stores/repo';
import { useSettings, type ExternalTool } from '../../stores/settings';

/**
 * Integrations — the external editor (header "Open externally", palette
 * "Open in editor") and terminal (header Terminal button, palette "Open in
 * terminal"). Preset apps per platform plus a custom command template with
 * `{file}` / `{line}` / `{dir}` placeholders.
 */
export function IntegrationsSection() {
  const editorTool = useSettings((s) => s.editorTool);
  const terminalTool = useSettings((s) => s.terminalTool);
  const set = useSettings((s) => s.set);

  return (
    <section className="settings-section" aria-label="Integrations">
      <ToolPicker
        label="External editor"
        hint="Used by “Open externally” on files. Placeholders: {file}, {line}, {dir}."
        presets={editorPresets()}
        tool={editorTool}
        onChange={(t) => set('editorTool', t)}
        onTest={(template) => {
          const path = useRepo.getState().activePath;
          if (!path) throw new Error('Open a repository to test.');
          return tauri.repoOpenInEditor(path, null, null, template);
        }}
      />
      <ToolPicker
        label="Terminal"
        hint="Opens the repository folder. Placeholder: {dir}."
        presets={terminalPresets()}
        tool={terminalTool}
        onChange={(t) => set('terminalTool', t)}
        onTest={(template) => {
          const path = useRepo.getState().activePath;
          if (!path) throw new Error('Open a repository to test.');
          return tauri.repoOpenInTerminal(path, template);
        }}
      />
    </section>
  );
}

const CUSTOM = '__custom__';
const NONE = '__none__';

function ToolPicker({
  label,
  hint,
  presets,
  tool,
  onChange,
  onTest,
}: {
  label: string;
  hint: string;
  presets: AppPreset[];
  tool: ExternalTool;
  onChange: (tool: ExternalTool) => void;
  onTest: (template: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const selectValue = !tool ? NONE : tool.kind === 'custom' ? CUSTOM : tool.id;
  const template = resolveTemplate(tool, presets);

  function onSelect(value: string) {
    setStatus(null);
    if (value === NONE) onChange(null);
    else if (value === CUSTOM) {
      // Seed the custom template from the current preset so switching to
      // Custom is an edit, not a blank slate.
      onChange({ kind: 'custom', template: template ?? '' });
    } else onChange({ kind: 'preset', id: value });
  }

  async function test() {
    if (!template) return;
    setStatus(null);
    try {
      await onTest(template);
      setStatus('Launched.');
    } catch (e) {
      setStatus(errMessage(e));
    }
  }

  return (
    <div className="settings-field">
      <span className="settings-field-label">{label}</span>
      <div className="settings-row">
        <Select
          className="settings-select"
          aria-label={label}
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value={NONE}>None</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom command…</option>
        </Select>
        <button type="button" className="btn" disabled={!template} onClick={() => void test()}>
          Test
        </button>
      </div>
      {tool?.kind === 'custom' && (
        <input
          type="text"
          className="clone-input"
          aria-label={`${label} custom command`}
          placeholder="e.g. code -g {file}:{line}"
          value={tool.template}
          onChange={(e) => {
            setStatus(null);
            onChange({ kind: 'custom', template: e.target.value });
          }}
        />
      )}
      <p className="settings-hint">{status ?? hint}</p>
    </div>
  );
}
