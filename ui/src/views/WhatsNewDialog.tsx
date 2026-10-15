import { getVersion } from '@tauri-apps/api/app';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { t } from '../lib/i18n';
import { renderMarkdown } from '../lib/markdown';
import {
  fetchPullRequestBody,
  fetchStrandReleases,
  parseReleaseNotes,
  selectDefaultRelease,
  type ReleasePr,
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

export type PrBodyStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string };

export function WhatsNewPrAccordion({
  intro,
  prs,
  expanded,
  bodies,
  onToggle,
  onRetry,
}: {
  intro: string;
  prs: ReleasePr[];
  expanded: ReadonlySet<number>;
  bodies: Readonly<Record<number, PrBodyStatus>>;
  onToggle: (number: number) => void;
  onRetry: (number: number) => void;
}) {
  return (
    <div className="whats-new-notes">
      {intro ? <div className="markdown whats-new-intro">{renderMarkdown(intro, { onLinkClick: openReleaseLink })}</div> : null}
      <div className="whats-new-prs" role="list" aria-label={t('whatsNew.changes')}>
        {prs.map((pr) => {
          const open = expanded.has(pr.number);
          const body = bodies[pr.number] ?? { status: 'idle' as const };
          const panelId = `whats-new-pr-${pr.number}`;
          return (
            <div key={pr.number} className={'whats-new-pr' + (open ? ' open' : '')} role="listitem">
              <button
                type="button"
                className="whats-new-pr-header"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => onToggle(pr.number)}
              >
                <Icon name={open ? 'chev-down' : 'chev-right'} size={12} />
                <span className="whats-new-pr-title">{pr.title}</span>
              </button>
              {open ? (
                <div className="whats-new-pr-panel" id={panelId}>
                  <PrBodyPane status={body} onRetry={() => onRetry(pr.number)} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrBodyPane({ status, onRetry }: { status: PrBodyStatus; onRetry: () => void }) {
  switch (status.status) {
    case 'idle':
    case 'loading':
      return <EmptyState compact icon="refresh" spinning title={t('whatsNew.prLoading')} />;
    case 'error':
      return (
        <EmptyState
          compact
          icon="warning"
          title={t('whatsNew.prError')}
          hint={t('whatsNew.prErrorHint')}
          action={
            <button type="button" className="btn" onClick={onRetry}>
              {t('whatsNew.retry')}
            </button>
          }
        />
      );
    case 'ready':
      return status.text
        ? <div className="markdown">{renderMarkdown(status.text, { onLinkClick: openReleaseLink })}</div>
        : <EmptyState compact icon="file" title={t('whatsNew.prEmpty')} />;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function ReleaseNotes({
  notes,
  loadPullRequest = fetchPullRequestBody,
}: {
  notes: string;
  loadPullRequest?: (number: number) => Promise<string>;
}) {
  const parsed = useMemo(() => parseReleaseNotes(notes), [notes]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [bodies, setBodies] = useState<Record<number, PrBodyStatus>>({});
  const loadPullRequestRef = useRef(loadPullRequest);
  loadPullRequestRef.current = loadPullRequest;

  const loadBody = useCallback((number: number) => {
    setBodies((prev) => ({ ...prev, [number]: { status: 'loading' } }));
    void loadPullRequestRef.current(number)
      .then((text) => setBodies((prev) => ({ ...prev, [number]: { status: 'ready', text } })))
      .catch(() => setBodies((prev) => ({ ...prev, [number]: { status: 'error' } })));
  }, []);

  function onToggle(number: number) {
    const next = new Set(expanded);
    if (next.has(number)) {
      next.delete(number);
      setExpanded(next);
      return;
    }
    next.add(number);
    setExpanded(next);
    const current = bodies[number];
    if (!current || current.status === 'idle' || current.status === 'error') loadBody(number);
  }

  if (parsed.prs.length === 0) {
    return <div className="markdown">{renderMarkdown(notes, { onLinkClick: openReleaseLink })}</div>;
  }

  return (
    <WhatsNewPrAccordion
      intro={parsed.intro}
      prs={parsed.prs}
      expanded={expanded}
      bodies={bodies}
      onToggle={onToggle}
      onRetry={loadBody}
    />
  );
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
        ? <ReleaseNotes key={selected.version} notes={selected.notes} />
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
