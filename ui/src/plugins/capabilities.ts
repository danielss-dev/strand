import { errMessage, tauri } from '../lib/tauri';
import type { AiGenerationRequest, AiProvider, CommitMessageSuggestion } from '../lib/types';
import type { PluginPermission } from './manifest';

export class PluginPermissionError extends Error {
  constructor(readonly permission: PluginPermission) {
    super(`Plugin lacks permission: ${permission}`);
    this.name = 'PluginPermissionError';
  }
}

export interface RepositorySnapshot {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

/** Narrow, permission-checked API exposed to plugin surfaces. */
export class PluginCapabilityBroker {
  constructor(private readonly granted: ReadonlySet<PluginPermission>) {}

  has(permission: PluginPermission): boolean {
    return this.granted.has(permission);
  }

  require(permission: PluginPermission): void {
    if (!this.granted.has(permission)) throw new PluginPermissionError(permission);
  }

  async readRepository(
    path: string,
    branch: string | null,
    head: string | null,
    dirty: boolean,
  ): Promise<RepositorySnapshot | null> {
    this.require('repository.read');
    if (!path) return null;
    const parts = path.split(/[\\/]/).filter(Boolean);
    return {
      path,
      name: parts[parts.length - 1] ?? path,
      branch,
      head,
      dirty,
    };
  }

  async invokeAi(
    path: string,
    provider: AiProvider,
    model: string,
    request: AiGenerationRequest,
    openaiCli: string | null,
    anthropicCli: string | null,
  ): Promise<CommitMessageSuggestion> {
    this.require('ai.invoke');
    try {
      const outcome = await tauri.repoSuggestCommitMessage(
        path,
        provider,
        model,
        request,
        openaiCli,
        anthropicCli,
      );
      if (outcome.status === 'needs_confirmation') {
        throw new Error('Sensitive files require confirmation before AI can run.');
      }
      return outcome.suggestion;
    } catch (error) {
      throw new Error(errMessage(error));
    }
  }
}
