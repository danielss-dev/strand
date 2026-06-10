import { useRef } from 'react';

/**
 * Shared primitives for the settings sections — the roving radiogroup
 * keyboard helper plus the small form controls (segmented radio row,
 * labeled checkbox) every section composes. Styles live in features.css
 * under "Settings dialog".
 *
 * Compact controls render as horizontal rows (label left, control right)
 * meant to live inside a `.settings-rows` hairline card, so the pane width
 * is used instead of stacking everything down the left edge.
 */

/** Roving arrow-key nav within a radiogroup: ←/→/↑/↓ move + select the
 * adjacent option, wrapping. Items tag themselves with `data-opt-id`. */
export function moveSelection<T extends { id: string }>(
  e: React.KeyboardEvent<HTMLDivElement>,
  options: readonly T[],
  currentId: string,
  select: (id: T['id']) => void,
  container: HTMLDivElement | null,
) {
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  if (!fwd && !back) return;
  e.preventDefault();
  const i = options.findIndex((o) => o.id === currentId);
  const base = i === -1 ? 0 : i;
  const next = options[(base + (fwd ? 1 : options.length - 1)) % options.length];
  select(next.id);
  requestAnimationFrame(() => {
    container?.querySelector<HTMLElement>(`[data-opt-id="${next.id}"]`)?.focus();
  });
}

/** Label plus optional hint — the left half of every settings row. */
function RowText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="settings-frow-text">
      <span className="settings-field-label">{label}</span>
      {hint && <span className="settings-frow-hint">{hint}</span>}
    </span>
  );
}

/** Segmented radio row (density, diff layout, indicators…): one Tab stop,
 * arrows move + select. */
export function SegRow<Id extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: readonly { id: Id; label: string }[];
  value: Id;
  onChange: (id: Id) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tabId = options.some((o) => o.id === value) ? value : options[0].id;
  return (
    <div className="settings-frow">
      <RowText label={label} hint={hint} />
      <div
        className="settings-seg"
        role="radiogroup"
        aria-label={label}
        ref={ref}
        onKeyDown={(e) => moveSelection(e, options, value, onChange, ref.current)}
      >
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={value === opt.id}
            data-opt-id={opt.id}
            tabIndex={opt.id === tabId ? 0 : -1}
            className={'settings-seg-btn' + (value === opt.id ? ' on' : '')}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Labeled checkbox row — text left, checkbox right. */
export function CheckRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="settings-frow settings-check">
      <RowText label={label} hint={hint} />
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Labeled `<select>` on the shared dialog styles. */
export function SelectRow<Id extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: readonly { id: Id; label: string }[];
  value: Id;
  onChange: (id: Id) => void;
}) {
  return (
    <div className="settings-frow">
      <RowText label={label} hint={hint} />
      <select
        className="settings-select"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as Id)}
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
