import { useEffect, useMemo, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { aiCoverageLabel, aiRequestMatches, otherAiProvider } from '../lib/aiGeneration';
import { repoAiStyle } from '../lib/db';
import { AI_AUTH_REQUIRED, errMessage, gitErrorHint, isCancelled, tauri } from '../lib/tauri';
import type {
  AiSensitiveDecision,
  AiSensitiveFile,
  AiInputCoverage,
  AiProvider,
  PullRequestCreateOutcome,
  PullRequestProvider,
  Refs,
} from '../lib/types';
import { useSettings } from '../stores/settings';

function targetBranches(refs: Refs | null, sourceBranch: string, knownTargets: string[]): string[] {
  const candidates = [
    ...knownTargets,
    ...(refs?.branches.map((branch) => branch.name) ?? []),
    ...(refs?.remote_branches.map((branch) => branch.branch) ?? []),
  ].filter((branch) => branch && branch !== sourceBranch);
  const unique = [...new Set(candidates)];
  return unique.sort((left, right) => {
    const rank = (branch: string) => branch === 'main' ? 0 : branch === 'master' ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
}

export function PullRequestCreateDialog({
  path,
  provider,
  sourceBranch,
  refs,
  knownTargets,
  commonDir,
  autoFill = false,
  onCreated,
  onClose,
}: {
  path: string;
  provider: PullRequestProvider;
  sourceBranch: string;
  refs: Refs | null;
  knownTargets: string[];
  commonDir: string;
  autoFill?: boolean;
  onCreated: (outcome: PullRequestCreateOutcome) => void;
  onClose: () => void;
}) {
  const aiProvider = useSettings((state) => state.aiProvider);
  const openaiModel = useSettings((state) => state.openaiModel);
  const anthropicModel = useSettings((state) => state.anthropicModel);
  const openaiCli = useSettings((state) => state.openaiCli);
  const anthropicCli = useSettings((state) => state.anthropicCli);
  const targets = useMemo(
    () => targetBranches(refs, sourceBranch, knownTargets),
    [knownTargets, refs, sourceBranch],
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetBranch, setTargetBranch] = useState(targets[0] ?? 'main');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensitivePrompt, setSensitivePrompt] = useState<{
    fingerprint: string;
    files: AiSensitiveFile[];
  } | null>(null);
  const [coverage, setCoverage] = useState<AiInputCoverage | null>(null);
  const [providerUsed, setProviderUsed] = useState<AiProvider | null>(null);
  const [undoDraft, setUndoDraft] = useState<{ title: string; description: string } | null>(null);
  const [retryProvider, setRetryProvider] = useState<AiProvider | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef<{ opId: string; path: string; target: string; provider: typeof aiProvider; model: string } | null>(null);
  const suggestingRef = useRef(false);
  const autoFillStartedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function cancelSuggestion() {
    const request = requestRef.current;
    requestRef.current = null;
    suggestingRef.current = false;
    setSuggesting(false);
    if (request) void tauri.repoCancelOp(request.opId);
  }

  function closeDialog() {
    cancelSuggestion();
    onClose();
  }

  useEffect(() => () => {
    const request = requestRef.current;
    requestRef.current = null;
    suggestingRef.current = false;
    if (request) void tauri.repoCancelOp(request.opId);
  }, [path, targetBranch, aiProvider, openaiCli, anthropicCli, openaiModel, anthropicModel]);

  async function submit() {
    if (busy || suggesting) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    if (!targetBranch.trim()) {
      setError('Target branch is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await tauri.repoPullRequestCreate(
        path,
        sourceBranch,
        targetBranch.trim(),
        title.trim(),
        description,
        draft,
      );
      onCreated(outcome);
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function fillWithAi(
    sensitiveDecision: AiSensitiveDecision = { mode: 'scan' },
    selectedProvider: AiProvider = aiProvider,
  ) {
    const target = targetBranch.trim();
    if (busy || suggestingRef.current) return;
    if (!target) {
      setError('Choose a target branch before generating pull request content.');
      return;
    }
    const opId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const model = selectedProvider === 'openai' ? openaiModel : anthropicModel;
    const request = { opId, path, target, provider: selectedProvider, model };
    requestRef.current = request;
    suggestingRef.current = true;
    setSuggesting(true);
    setError(null);
    setSensitivePrompt(null);
    setCoverage(null);
    setProviderUsed(null);
    setUndoDraft(null);
    setRetryProvider(null);
    try {
      const styleInstruction = await repoAiStyle.get(commonDir);
      if (requestRef.current !== request) return;
      const outcome = await tauri.repoSuggestPullRequest(
        path,
        target,
        selectedProvider,
        model,
        { opId, sensitiveDecision, styleInstruction },
        openaiCli,
        anthropicCli,
      );
      if (!mountedRef.current || requestRef.current !== request) return;
      if (outcome.status === 'needs_confirmation') {
        setSensitivePrompt({ fingerprint: outcome.fingerprint, files: outcome.sensitiveFiles });
        return;
      }
      if (outcome.provider !== selectedProvider || !aiRequestMatches(request, {
        path,
        provider: selectedProvider,
        target: targetBranch.trim(),
      })) return;
      setUndoDraft({ title, description });
      setTitle(outcome.suggestion.title);
      setDescription(outcome.suggestion.description);
      setCoverage(outcome.coverage);
      setProviderUsed(outcome.provider);
      window.requestAnimationFrame(() => titleRef.current?.focus());
    } catch (caught) {
      if (requestRef.current !== request || isCancelled(caught)) return;
      const message = gitErrorHint(caught);
      if (message.startsWith(AI_AUTH_REQUIRED)) {
        try {
          await tauri.aiProviderLogin(selectedProvider, openaiCli, anthropicCli);
          if (mountedRef.current) {
            setError('Sign-in started — complete it in the browser or CLI window, then click Fill with AI again.');
          }
        } catch (loginError) {
          if (mountedRef.current) setError(`Sign-in failed: ${gitErrorHint(loginError)}`);
        }
      } else if (mountedRef.current) {
        setError(`AI suggestion failed: ${message}`);
        setRetryProvider(otherAiProvider(selectedProvider));
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        suggestingRef.current = false;
        if (mountedRef.current) setSuggesting(false);
      }
    }
  }

  useEffect(() => {
    if (!autoFill || autoFillStartedRef.current || !targetBranch.trim()) return;
    autoFillStartedRef.current = true;
    void fillWithAi();
  }, [autoFill, targetBranch]);

  const providerLabel = provider === 'git_hub' ? 'GitHub' : 'Azure DevOps';
  const aiProviderLabel = aiProvider === 'openai' ? 'Codex' : 'Claude Code';
  const fieldsDisabled = busy || suggesting;
  const aiActionLabel = title.trim() || description.trim() ? 'Replace' : 'Fill';

  return (
    <Dialog
      title="Create pull request"
      icon="remote"
      size="sm"
      busy={busy}
      onClose={closeDialog}
      className="pr-create-dialog"
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={closeDialog}>Cancel</button>
          <button type="submit" form="pr-create-form" className="btn primary" disabled={busy || suggesting}>
            {busy ? 'Creating…' : 'Create pull request'}
          </button>
        </>
      }
    >
        <form id="pr-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="clone-body">
            <p className="stash-blurb">
              Create on {providerLabel} from <code>{sourceBranch}</code>. If the branch is not on the repository remote yet, Strand will push it first.
            </p>

            <div className="pr-ai-fill-row">
              <button
                type="button"
                className="btn pr-ai-fill"
                aria-busy={suggesting}
                disabled={busy || suggesting || !targetBranch.trim()}
                title={`${aiActionLabel} the editable title and description with ${aiProviderLabel}, using committed branch changes`}
                onClick={() => void fillWithAi()}
              >
                <Icon name={suggesting ? 'refresh' : 'sparkle'} size={13} className={suggesting ? 'spin' : undefined} />
                {suggesting ? 'Generating…' : `${aiActionLabel} with ${aiProviderLabel}`}
              </button>
              <span>Uses committed changes against the target branch.</span>
              {suggesting ? <button type="button" className="btn" onClick={cancelSuggestion}>Cancel</button> : null}
            </div>
            {coverage && providerUsed ? (
              <p className="settings-hint" role="status">
                {aiCoverageLabel(coverage, providerUsed)}
              </p>
            ) : null}
            {undoDraft ? (
              <button
                type="button"
                className="h-link"
                onClick={() => {
                  setTitle(undoDraft.title);
                  setDescription(undoDraft.description);
                  setUndoDraft(null);
                  setCoverage(null);
                  setProviderUsed(null);
                }}
              >
                Undo AI replacement
              </button>
            ) : null}

            <label className="clone-field">
              <span className="lbl">Title</span>
              <input
                ref={titleRef}
                autoFocus
                className="clone-input"
                value={title}
                disabled={fieldsDisabled}
                maxLength={512}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label className="clone-field">
              <span className="lbl">Target branch</span>
              <input
                className="clone-input"
                value={targetBranch}
                list="pr-target-branches"
                disabled={fieldsDisabled}
                onChange={(event) => setTargetBranch(event.target.value)}
              />
              <datalist id="pr-target-branches">
                {targets.map((branch) => <option key={branch} value={branch} />)}
              </datalist>
            </label>

            <label className="clone-field">
              <span className="lbl">Description</span>
              <textarea
                className="clone-input pr-create-description"
                value={description}
                disabled={fieldsDisabled}
                maxLength={65_536}
                placeholder="What changed, and why?"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>

            <label className="stash-check">
              <input
                type="checkbox"
                checked={draft}
                disabled={fieldsDisabled}
                onChange={(event) => setDraft(event.target.checked)}
              />
              <span>Create as draft</span>
            </label>

            {sensitivePrompt ? (
              <div className="clone-error" role="alert">
                <div>Potentially sensitive files require confirmation:</div>
                <ul>{sensitivePrompt.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul>
                <div className="settings-row">
                  <button type="button" className="btn primary" onClick={() => void fillWithAi({ mode: 'exclude', fingerprint: sensitivePrompt.fingerprint })}>Generate without them</button>
                  <button type="button" className="btn" onClick={() => void fillWithAi({ mode: 'include', fingerprint: sensitivePrompt.fingerprint })}>Include and generate</button>
                  <button type="button" className="btn" onClick={() => setSensitivePrompt(null)}>Cancel</button>
                </div>
              </div>
            ) : error ? (
              <div className="clone-error" role="alert">
                {error}
                {retryProvider ? (
                  <div><button type="button" className="h-link" onClick={() => void fillWithAi({ mode: 'scan' }, retryProvider)}>
                    Retry with {retryProvider === 'openai' ? 'Codex' : 'Claude Code'}
                  </button></div>
                ) : null}
              </div>
            ) : null}
          </div>
        </form>
    </Dialog>
  );
}
