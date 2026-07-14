import type { AiInputCoverage, AiProvider } from './types';

export interface AiRequestIdentity {
  opId: string;
  path: string;
  provider: AiProvider;
  target?: string;
}

export function aiRequestMatches(
  request: AiRequestIdentity,
  current: Omit<AiRequestIdentity, 'opId'>,
): boolean {
  return request.path === current.path
    && request.provider === current.provider
    && request.target === current.target;
}

export function otherAiProvider(provider: AiProvider): AiProvider {
  return provider === 'openai' ? 'anthropic' : 'openai';
}

export function aiCoverageLabel(coverage: AiInputCoverage, provider: AiProvider): string {
  const providerLabel = provider === 'openai' ? 'Codex' : 'Claude Code';
  const parts = [
    `Generated with ${providerLabel} · ${coverage.patchFiles} of ${coverage.patchFiles + coverage.omittedPatchFiles} patches included`,
  ];
  if (coverage.truncatedPatchFiles) parts.push(`${coverage.truncatedPatchFiles} truncated`);
  if (coverage.sensitiveExcludedFiles) parts.push(`${coverage.sensitiveExcludedFiles} sensitive excluded`);
  return `${parts.join('; ')}.`;
}
