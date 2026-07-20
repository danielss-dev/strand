import { useEffect, useMemo, useState } from 'react';

import { Select } from '../../components/Select';
import { repoEmbeddedShell } from '../../lib/db';
import {
  embeddedShellFromValue,
  embeddedShellOptions,
  embeddedShellValue,
  SHELL_CUSTOM_VALUE,
} from '../../lib/embeddedShell';
import { t } from '../../lib/i18n';
import { mainPathFromCommonDir, pathKey, repoFamilyName } from '../../lib/repoIdentity';
import { errMessage, tauri } from '../../lib/tauri';
import type { EmbeddedShellChoice } from '../../lib/types';
import { useRepo } from '../../stores/repo';
import {
  TERMINAL_FONTS,
  TERMINAL_FONT_OPTIONS,
  useSettings,
  type TerminalFont,
} from '../../stores/settings';

const GLOBAL = '__global__';

export function TerminalSection() {
  const terminalFont = useSettings((state) => state.terminalFont);
  const terminalFontSize = useSettings((state) => state.terminalFontSize);
  const set = useSettings((state) => state.set);

  return (
    <section className="settings-section" aria-label={t('settings.terminal')}>
      <EmbeddedShellPicker />

      <div className="settings-field">
        <span className="settings-field-label">{t('settings.terminalAppearance')}</span>
        <div className="settings-rows">
          <div className="settings-frow">
            <span className="settings-frow-text">
              <span className="settings-field-label">{t('settings.terminalFont')}</span>
              <span className="settings-frow-hint">{t('settings.terminalFontHint')}</span>
            </span>
            <Select
              className="settings-select"
              aria-label={t('settings.terminalFont')}
              value={terminalFont}
              onChange={(event) => set('terminalFont', event.target.value as TerminalFont)}
            >
              {TERMINAL_FONT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </Select>
          </div>
          <label className="settings-frow">
            <span className="settings-frow-text">
              <span className="settings-field-label">{t('settings.terminalFontSize')}</span>
              <span className="settings-frow-hint">{t('settings.terminalFontSizeHint')}</span>
            </span>
            <span className="settings-number-wrap">
              <input
                className="settings-number"
                type="number"
                min={10}
                max={32}
                step={1}
                value={terminalFontSize}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) {
                    set('terminalFontSize', Math.min(32, Math.max(10, Math.round(value))));
                  }
                }}
                aria-label={t('settings.terminalFontSize')}
              />
              <span aria-hidden="true">px</span>
            </span>
          </label>
        </div>
        <div
          className="settings-terminal-preview"
          style={{ fontFamily: TERMINAL_FONTS[terminalFont], fontSize: terminalFontSize }}
          aria-label={t('settings.terminalPreview')}
        >
          <span className="settings-terminal-prompt">~/strand</span>
          <span> git status</span>
          <br />
          <span className="settings-terminal-output">On branch main · working tree clean</span>
        </div>
      </div>
    </section>
  );
}

function EmbeddedShellPicker() {
  const global = useSettings((state) => state.embeddedShell);
  const set = useSettings((state) => state.set);
  const tabs = useRepo((state) => state.tabs);
  const activeCommonDir = useRepo((state) => state.meta?.common_dir ?? null);
  const repositories = useMemo(() => {
    const families = new Map<string, { commonDir: string; label: string; path: string }>();
    for (const tab of tabs) {
      const key = pathKey(tab.meta.common_dir);
      if (!families.has(key)) {
        families.set(key, {
          commonDir: tab.meta.common_dir,
          label: repoFamilyName(tab.meta),
          path: mainPathFromCommonDir(tab.meta.common_dir) ?? tab.path,
        });
      }
    }
    return [...families.entries()].map(([key, repository]) => ({ key, ...repository }));
  }, [tabs]);
  const [selectedRepositoryKey, setSelectedRepositoryKey] = useState<string | null>(null);
  const selectedRepository = repositories.find(({ key }) => key === selectedRepositoryKey)
    ?? repositories.find(({ key }) => key === pathKey(activeCommonDir ?? ''))
    ?? repositories[0]
    ?? null;
  const [overrides, setOverrides] = useState<Record<string, EmbeddedShellChoice | null>>({});
  const selectedOverride = selectedRepository ? overrides[selectedRepository.key] ?? null : null;
  const [loadedRepositories, setLoadedRepositories] = useState<Set<string>>(() => new Set());
  const [wslDistributions, setWslDistributions] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const displayedWsl = [...wslDistributions];
  for (const choice of [global, ...Object.values(overrides)]) {
    if (choice?.kind === 'wsl'
      && !displayedWsl.some((item) => item.toLowerCase() === choice.distribution.toLowerCase())) {
      displayedWsl.push(choice.distribution);
    }
  }
  const options = embeddedShellOptions(displayedWsl);

  useEffect(() => {
    let cancelled = false;
    void tauri.terminalWslDistributions()
      .then((items) => { if (!cancelled) setWslDistributions(items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadedRepositories(new Set());
    void Promise.all(repositories.map(async (repository) => ({
      key: repository.key,
      choice: await repoEmbeddedShell.get(repository.commonDir),
    }))).then((items) => {
      if (cancelled) return;
      setOverrides(Object.fromEntries(items.map(({ key, choice }) => [key, choice])));
      setLoadedRepositories(new Set(items.map(({ key }) => key)));
    });
    return () => { cancelled = true; };
  }, [repositories]);

  const check = async (choice: EmbeddedShellChoice) => {
    setStatus(t('settings.shellChecking'));
    try {
      const result = await tauri.terminalShellCheck(choice);
      setStatus(result.available
        ? t('settings.shellAvailable', { path: result.executable ?? result.label })
        : t('settings.shellUnavailable', { reason: result.error ?? result.label }));
    } catch (error) {
      setStatus(t('settings.shellUnavailable', { reason: errMessage(error) }));
    }
  };

  const saveOverride = (key: string, commonDir: string, choice: EmbeddedShellChoice | null) => {
    setOverrides((current) => ({ ...current, [key]: choice }));
    setStatus(null);
    void repoEmbeddedShell.set(commonDir, choice);
  };

  return (
    <div className="settings-field settings-shells">
      <span className="settings-field-label">{t('settings.defaultShell')}</span>
      <p className="settings-hint">{t('settings.embeddedShellHint')}</p>
      <div className="settings-row">
        <ShellSelect
          label={t('settings.embeddedShellGlobal')}
          value={embeddedShellValue(global)}
          options={options}
          onChange={(value) => {
            set('embeddedShell', embeddedShellFromValue(value, global));
            setStatus(null);
          }}
        />
        <button type="button" className="btn" onClick={() => void check(global)}>{t('settings.shellCheck')}</button>
      </div>
      {global.kind === 'custom' && (
        <input
          className="clone-input"
          aria-label={t('settings.shellCustomGlobal')}
          value={global.command}
          placeholder={t('settings.shellCustomPlaceholder')}
          onChange={(event) => set('embeddedShell', { kind: 'custom', command: event.target.value })}
        />
      )}
      {status && <p className="settings-hint" role="status">{status}</p>}
      <span className="settings-field-label settings-shell-override">{t('settings.embeddedShellRepo')}</span>
      <p className="settings-hint">{t('settings.embeddedShellRepoHint')}</p>
      {repositories.length === 0 ? (
        <p className="settings-hint">{t('settings.embeddedShellRepoEmpty')}</p>
      ) : selectedRepository && (
        <>
          <div className="settings-repo-shell-pickers">
            <label className="settings-select-field">
              <span className="settings-select-caption">{t('settings.repository')}</span>
              <Select
                className="settings-select"
                aria-label={t('settings.repository')}
                value={selectedRepository.key}
                onChange={(event) => setSelectedRepositoryKey(event.target.value)}
              >
                {repositories.map((repository) => (
                  <option key={repository.key} value={repository.key}>{repository.label}</option>
                ))}
              </Select>
            </label>
            <label className="settings-select-field">
              <span className="settings-select-caption">{t('settings.shell')}</span>
              <ShellSelect
                label={t('settings.embeddedShellRepoLabel', { repo: selectedRepository.label })}
                value={selectedOverride ? embeddedShellValue(selectedOverride) : GLOBAL}
                options={options}
                allowGlobal
                disabled={!loadedRepositories.has(selectedRepository.key)}
                onChange={(value) => saveOverride(
                  selectedRepository.key,
                  selectedRepository.commonDir,
                  value === GLOBAL
                    ? null
                    : embeddedShellFromValue(value, selectedOverride ?? global),
                )}
              />
            </label>
          </div>
          <p className="settings-hint settings-repo-shell-path" title={selectedRepository.path}>
            {selectedRepository.path}
          </p>
          {selectedOverride?.kind === 'custom' && (
            <input
              className="clone-input settings-repo-shell-custom"
              aria-label={t('settings.shellCustomRepoLabel', { repo: selectedRepository.label })}
              value={selectedOverride.command}
              placeholder={t('settings.shellCustomPlaceholder')}
              onChange={(event) => saveOverride(
                selectedRepository.key,
                selectedRepository.commonDir,
                { kind: 'custom', command: event.target.value },
              )}
            />
          )}
        </>
      )}
    </div>
  );
}

function ShellSelect({
  label,
  value,
  options,
  allowGlobal = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: ReturnType<typeof embeddedShellOptions>;
  allowGlobal?: boolean;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const native = options.filter((option) => option.group === 'native');
  const wsl = options.filter((option) => option.group === 'wsl');
  return (
    <Select
      className="settings-select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {allowGlobal && <option value={GLOBAL}>{t('settings.shellUseGlobal')}</option>}
      <optgroup label={t('settings.shellNativeGroup')}>
        {native.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </optgroup>
      {wsl.length > 0 && (
        <optgroup label={t('settings.shellWslGroup')}>
          {wsl.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </optgroup>
      )}
      <option value={SHELL_CUSTOM_VALUE}>{t('settings.shellCustom')}</option>
    </Select>
  );
}
