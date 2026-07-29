export interface CommitShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault: () => void;
}

export function handleCommitShortcut(event: CommitShortcutEvent, submit: () => void) {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  submit();
}
