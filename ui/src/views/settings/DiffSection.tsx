import { Diff } from '../../components/Diff';
import { repoDiffMode } from '../../lib/db';
import { useRepo } from '../../stores/repo';
import {
  MONO_FONT_OPTIONS,
  useSettings,
  type DiffMode,
  type MonoFont,
} from '../../stores/settings';
import { CheckRow, SegRow, SelectRow } from './shared';

/** Diff — how code diffs render. Every control applies live; the preview
 * below renders through the same `Diff` wrapper as the real panes. */

const LAYOUT_OPTIONS: { id: DiffMode; label: string }[] = [
  { id: 'stacked', label: 'Stacked' },
  { id: 'split', label: 'Split' },
];

const INDICATOR_OPTIONS = [
  { id: 'classic', label: '+ / −' },
  { id: 'bars', label: 'Bars' },
  { id: 'none', label: 'None' },
] as const;

const DIFF_FONT_OPTIONS: { id: MonoFont | 'inherit'; label: string }[] = [
  { id: 'inherit', label: 'Same as mono font' },
  ...MONO_FONT_OPTIONS,
];

const SAMPLE_PATCH = `diff --git a/src/greet.ts b/src/greet.ts
index 83db48f..bf269f4 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,4 +1,5 @@
 export function greet(name: string) {
-  return 'Hello, ' + name;
+  const trimmed = name.trim();
+  return \`Hello, \${trimmed}!\`;
 }
`;

export function DiffSection() {
  const defaultLayout = useSettings((s) => s.defaultDiffLayout);
  const diffFont = useSettings((s) => s.diffFont);
  const lineNumbers = useSettings((s) => s.diffLineNumbers);
  const indicators = useSettings((s) => s.diffIndicators);
  const wordHighlight = useSettings((s) => s.diffWordHighlight);
  const set = useSettings((s) => s.set);

  // The default only steers repos without their own layout row, so changing
  // it re-themes the live pane only when the active repo has no override.
  async function setDefaultLayout(mode: DiffMode) {
    set('defaultDiffLayout', mode);
    const path = useRepo.getState().activePath;
    const override = path ? await repoDiffMode.get(path) : null;
    if (!override) set('diffMode', mode);
  }

  return (
    <section className="settings-section" aria-label="Diff">
      <SegRow
        label="Default layout"
        options={LAYOUT_OPTIONS}
        value={defaultLayout}
        onChange={(id) => void setDefaultLayout(id)}
      />
      <p className="settings-hint">
        Repos where you’ve toggled the layout in the header keep their own choice.
      </p>
      <SelectRow
        label="Diff font"
        options={DIFF_FONT_OPTIONS}
        value={diffFont}
        onChange={(id) => set('diffFont', id)}
      />
      <SegRow
        label="Change indicators"
        options={INDICATOR_OPTIONS}
        value={indicators}
        onChange={(id) => set('diffIndicators', id)}
      />
      <CheckRow
        label="Line numbers"
        checked={lineNumbers}
        onChange={(v) => set('diffLineNumbers', v)}
      />
      <CheckRow
        label="Highlight changed words"
        hint="Emphasize the changed part of a line, not just the line."
        checked={wordHighlight}
        onChange={(v) => set('diffWordHighlight', v)}
      />
      <div className="settings-field">
        <span className="settings-field-label">Preview</span>
        <div className="settings-diff-preview">
          <Diff patch={SAMPLE_PATCH} hideFileHeader />
        </div>
      </div>
    </section>
  );
}
