/** English source catalog. New UI copy belongs here before another locale is added. */
export const en = {
  'common.cancel': 'Cancel',
  'common.choose': 'Choose…',
  'common.close': 'Close',
  'common.removeRecent': 'Remove from recents',
  'common.fileCount.one': '{count} file',
  'common.fileCount.other': '{count} files',
  'nav.localChanges': 'Local Changes',
  'nav.review': 'Review',
  'nav.pullRequests': 'Pull Requests',
  'nav.allCommits': 'All Commits',
  'nav.reflog': 'Reflog',
  'nav.workspaceReview': 'Workspace Review',
  'nav.worktrees': 'Worktrees',
  'nav.branch': 'Branch',
  'nav.git': 'Git',
  'nav.files': 'Files',
  'nav.filterRefs': 'Filter branches, tags…',
  'nav.filterRefsLabel': 'Filter branches and tags',
  'files.createEntry': 'New file or folder',
  'files.newFile': 'New file',
  'files.newFolder': 'New folder',
  'files.showIgnored': 'Show ignored',
  'file.editorLabel': 'Edit {path}',
  'file.save': 'Save',
  'file.saving': 'Saving…',
  'file.saved': 'Saved',
  'file.unsaved': 'Unsaved changes',
  'file.saveFailed': 'Couldn’t save: {reason}',
  'file.largeReadOnly': 'Large file — showing the first part read-only.',
  'file.encodingReadOnly': 'This file is not UTF-8 text, so it is read-only.',
  'clone.title': 'Clone repository',
  'clone.paletteAction': 'Clone repository…',
  'clone.pickerTitle': 'Clone into…',
  'clone.securityNotice': 'Clone may run hooks installed by your Git template or system configuration. Only clone repositories and URLs you trust.',
  'clone.repositoryUrl': 'Repository URL',
  'clone.destinationFolder': 'Destination folder',
  'clone.noFolder': 'No folder chosen',
  'clone.folderName': 'Folder name',
  'clone.invalidFolder': 'Folder name must be a single folder, with no slashes or “..”.',
  'clone.destinationPrefix': 'Clones into',
  'clone.action': 'Clone',
  'updates.section': 'Updates',
  'updates.version': 'Version',
  'updates.browserPreview': 'Strand (browser preview)',
  'updates.available': 'Version {version} is available.',
  'updates.checking': 'Checking…',
  'updates.current': 'You’re on the latest version.',
  'updates.downloading': 'Downloading… {progress}',
  'updates.ready': 'Update installed — restart to finish.',
  'updates.error': 'Couldn’t reach the update server.',
  'updates.errorReason': 'Couldn’t reach the update server ({reason}).',
  'updates.downloadInstall': 'Download & install',
  'updates.restart': 'Restart now',
  'updates.check': 'Check for updates',
  'updates.downloadProgress': 'Download progress',
  'updates.automatic': 'Automatic updates',
  'updates.checkOnLaunch': 'Check for updates on launch',
  'updates.installAutomatically': 'Download and install automatically',
  'updates.restartHint': 'Updates apply on the next restart; Strand never restarts itself.',
  'settings.title': 'Settings',
  'settings.sections': 'Settings sections',
  'settings.done': 'Done',
  'settings.appearance': 'Appearance',
  'settings.diff': 'Diff',
  'settings.keyboard': 'Keyboard',
  'settings.git': 'Git',
  'settings.hosting': 'Hosting',
  'settings.integrations': 'Integrations',
  'settings.ai': 'AI',
  'settings.updates': 'Updates',
  'settings.privacy': 'Privacy',
  'settings.context.repoTabs': 'Repository tabs: move · first/last · close',
  'status.noRepository': 'No repository',
  'status.upToDate': 'Up to date',
  'status.ahead': '{count} ahead',
  'status.behind': '{count} behind',
  'status.diverged': 'Branches diverged',
  'status.conflicts': 'Conflicts need resolution',
  'status.changes': '{modified} modified · {staged} staged',
  'toast.cancelNetwork': 'Cancel network operation',
  'repo.close': 'Close repository',
  'repo.closeWorktree': 'Close worktree',
  'workspace.rename': 'Rename workspace',
  'workspace.delete': 'Delete workspace',
} as const;

export type MessageKey = keyof typeof en;
export type MessageValues = Readonly<Record<string, string | number>>;
type Locales = string | string[] | undefined;

function interpolate(message: string, values: MessageValues): string {
  return message.replace(/\{([a-zA-Z][\w]*)\}/g, (_, name: string) => {
    const value = values[name];
    if (value == null) throw new Error(`Missing localization value: ${name}`);
    return String(value);
  });
}

/** Resolve an English catalog entry and fail loudly when interpolation is incomplete. */
export function t(key: MessageKey, values: MessageValues = {}): string {
  return interpolate(en[key], values);
}

/** English plural selection; the API leaves room for more categories with future catalogs. */
export function plural(
  count: number,
  forms: { one: MessageKey; other: MessageKey },
  values: MessageValues = {},
  locales: Locales = formattingLocales(),
): string {
  const key = new Intl.PluralRules(locales).select(count) === 'one' ? forms.one : forms.other;
  return t(key, { count, ...values });
}

export function formattingLocales(): string[] | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.languages.length > 0 ? [...navigator.languages] : undefined;
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locales: Locales = formattingLocales(),
): string {
  return new Intl.NumberFormat(locales, options).format(value);
}

export function formatDateTime(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  locales: Locales = formattingLocales(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locales, options).format(date);
}

export function formatPercent(
  value: number,
  options?: Intl.NumberFormatOptions,
  locales: Locales = formattingLocales(),
): string {
  return formatNumber(value, { style: 'percent', maximumFractionDigits: 0, ...options }, locales);
}
