import { useEffect, useState } from 'react';

import { Icon } from './Icon';
import {
  detectFromFileContent,
  formatFileEncodingLabel,
  type FileEncodingInfo,
} from '../lib/fileEncoding';
import { t } from '../lib/i18n';
import { formatBinding } from '../lib/keys';
import { tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';

/** Encoding / line-ending chip. Renders nothing when detection has no honest label. */
export function StatusBarFileEncoding({ info }: { info: FileEncodingInfo | null }) {
  const label = formatFileEncodingLabel(info);
  if (!label) return null;
  return (
    <>
      <div className="sb-item" title={label}>{label}</div>
      <span className="sep">·</span>
    </>
  );
}

export function StatusBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);
  const selectedFile = useRepo((s) => s.selectedFile);
  const selectedFileIsDirectory = useRepo((s) => s.selectedFileIsDirectory);
  const selectedFileRevision = useRepo((s) => s.selectedFileRevision);
  const activePath = useRepo((s) => s.activePath);
  const diffsTick = useRepo((s) => s.diffsTick);
  const platform = useSettings((s) => s.platform);
  const [focusedWorktreePath, setFocusedWorktreePath] = useState<string | null>(null);
  const [encodingInfo, setEncodingInfo] = useState<FileEncodingInfo | null>(null);

  useEffect(() => {
    const onWorktreeFocus = (event: Event) => {
      setFocusedWorktreePath((event as CustomEvent<string | null>).detail);
    };
    window.addEventListener('strand:worktree-focus', onWorktreeFocus);
    return () => window.removeEventListener('strand:worktree-focus', onWorktreeFocus);
  }, []);

  useEffect(() => {
    if (!activePath || !selectedFile || selectedFileIsDirectory) {
      setEncodingInfo(null);
      return;
    }
    let cancelled = false;
    setEncodingInfo(null);
    tauri
      .repoFileContent(activePath, selectedFile, selectedFileRevision)
      .then((content) => {
        if (!cancelled) setEncodingInfo(detectFromFileContent(content));
      })
      .catch(() => {
        if (!cancelled) setEncodingInfo(null);
      });
    return () => { cancelled = true; };
  }, [activePath, selectedFile, selectedFileIsDirectory, selectedFileRevision, diffsTick]);

  const syncLabel = !meta
    ? t('status.noRepository')
    : status.some((entry) => entry.kind === 'CONFLICTED')
      ? t('status.conflicts')
      : meta.ahead > 0 && meta.behind > 0
        ? t('status.diverged')
        : meta.ahead > 0
          ? t('status.ahead', { count: meta.ahead })
          : meta.behind > 0
            ? t('status.behind', { count: meta.behind })
            : t('status.upToDate');

  const settingsShortcut = formatBinding('Mod+,', platform);
  const hasDrift = !!meta && (meta.ahead > 0 || meta.behind > 0);

  return (
    <div className="statusbar">
      <div className="sb-item" title={meta?.branch ?? undefined}>
        <Icon name="branch" size={11} />
        <span className="branch">{meta?.branch ?? '—'}</span>
      </div>
      {hasDrift && (
        <>
          <div className="sb-item" title={`${meta.ahead} ahead, ${meta.behind} behind`}>
            {meta.ahead > 0 && <span className="sb-ahead">{meta.ahead}↑</span>}
            {meta.behind > 0 && <span className="sb-behind">{meta.behind}↓</span>}
          </div>
          <span className="sep">·</span>
        </>
      )}
      <div className="sb-item">
        <Icon name="sync" size={11} />
        <span>{syncLabel}</span>
      </div>

      <div className="right">
        {focusedWorktreePath && (
          <div className="sb-item sb-worktree-path" title={focusedWorktreePath}>
            {focusedWorktreePath}
          </div>
        )}
        <StatusBarFileEncoding info={encodingInfo} />
        <button
          type="button"
          className="sb-item sb-gear"
          onClick={onOpenSettings}
          title={`${t('settings.title')} (${settingsShortcut})`}
          aria-label={t('settings.title')}
        >
          <Icon name="settings" size={12} />
        </button>
      </div>
    </div>
  );
}
