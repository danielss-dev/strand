import { getVersion } from '@tauri-apps/api/app';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { t } from '../lib/i18n';
import { renderMarkdown } from '../lib/markdown';
import {
  fetchStrandReleases,
  selectDefaultRelease,
  type StrandRelease,
} from '../lib/releases';
import { isTauri } from '../lib/tauri';

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; releases: StrandRelease[] };

function openReleaseLink(href: string) {
  if (/^(https?:|mailto:)/i.test(href)) void shellOpen(href);
}

export function WhatsNewLayout({
  state,
  selectedVersion,
  onSelect,
  onRetry,
}: {
  state: LoadState;
  selectedVersion: string | null;
  onSelect: (version: string) => void;
  onRetry: () => void;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const releases = state.status === 'ready' ? state.releases : [];
  const selected = releases.find((r) => r.version === selectedVersion) ?? null;

  function onNavKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (releases.length === 0 || !selectedVersion) return;
    const i = releases.findIndex((r) => r.version === selectedVersion);
    let next: string | null = null;
    if (e.key === 'ArrowDown') next = releases[(i + 1) % releases.length].version;
    else if (e.key === 'ArrowUp') next = releases[(i + releases.length - 1) % releases.length].version;
    else if (e.key === 'Home') next = releases[0].version;
    else if (e.key === 'End') next = releases[releases.length - 1].version;
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    const id = next;
    requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLElement>(`[data-opt-id="${id}"]`)?.focus();
    });
  }

  let pane: ReactNode;
  switch (state.status) {
    case 'loading':
      pane = <EmptyState icon="refresh" spinning title={t('whatsNew.loading')} />;
      break;
    case 'error':
      pane = (
        <EmptyState
          icon="warning"
          title={t('whatsNew.error')}
          hint={t('whatsNew.errorHint')}
          action={
            <button type="button" className="btn" onClick={onRetry}>
              {t('whatsNew.retry')}
            </button>
          }
        />
      );
      break;
    case 'ready':
      pane = selected && selected.notes
        ? <div className="markdown">{renderMarkdown(selected.notes, { onLinkClick: openReleaseLink })}</div>
        : (
          <EmptyState
            icon="file"
            title={t('whatsNew.empty')}
            hint={t('whatsNew.emptyHint')}
          />
        );
      break;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }

  return (
    <div className="settings-layout">
      <div
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('whatsNew.versions')}
        ref={navRef}
        onKeyDown={onNavKeyDown}
      >
        {releases.map((release) => (
          <button
            key={release.version}
            type="button"
            role="tab"
            id={`whats-new-tab-${release.version}`}
            aria-selected={selectedVersion === release.version}
            aria-controls="whats-new-pane"
            data-opt-id={release.version}
            tabIndex={selectedVersion === release.version ? 0 : -1}
            className={'settings-nav-item' + (selectedVersion === release.version ? ' on' : '')}
            onClick={() => onSelect(release.version)}
          >
            {release.version}
          </button>
        ))}
      </div>
      <div
        className="settings-pane"
        id="whats-new-pane"
        role="tabpanel"
        aria-labelledby={selected ? `whats-new-tab-${selected.version}` : undefined}
      >
        {pane}
      </div>
    </div>
  );
}

export function WhatsNewDialog({
  onClose,
  loadReleases = fetchStrandReleases,
  currentVersion,
}: {
  onClose: () => void;
  loadReleases?: () => Promise<StrandRelease[]>;
  currentVersion?: string | null;
}) {
  const versionProvided = currentVersion !== undefined;
  const [appVersion, setAppVersion] = useState<string | null>(versionProvided ? currentVersion : null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const userSelected = useRef(false);

  useEffect(() => {
    if (versionProvided) {
      setAppVersion(currentVersion);
      return;
    }
    if (isTauri()) void getVersion().then(setAppVersion).catch(() => {});
  }, [versionProvided, currentVersion]);

  const load = useCallback(() => {
    userSelected.current = false;
    setSelectedVersion(null);
    setState({ status: 'loading' });
    void loadReleases()
      .then((releases) => {
        if (releases.length === 0) {
          setState({ status: 'error' });
          return;
        }
        setState({ status: 'ready', releases });
      })
      .catch(() => setState({ status: 'error' }));
  }, [loadReleases]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    setSelectedVersion((prev) => {
      if (userSelected.current && prev && state.releases.some((r) => r.version === prev)) return prev;
      return selectDefaultRelease(state.releases, appVersion)?.version ?? null;
    });
  }, [state, appVersion]);

  function onSelect(version: string) {
    userSelected.current = true;
    setSelectedVersion(version);
  }

  return (
    <Dialog
      title={t('whatsNew.title')}
      icon="history"
      size="xl"
      className="settings-dialog-lg"
      blockEscapeWhileBusy={false}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('whatsNew.done')}
        </button>
      }
    >
      <WhatsNewLayout
        state={state}
        selectedVersion={selectedVersion}
        onSelect={onSelect}
        onRetry={load}
      />
    </Dialog>
  );
}
