import { osType } from './integrations';
import type { EmbeddedShellChoice } from './types';

export const SHELL_SYSTEM_VALUE = 'system';
export const SHELL_CUSTOM_VALUE = 'custom';

export interface EmbeddedShellOption {
  value: string;
  label: string;
  group: 'native' | 'wsl';
  choice: EmbeddedShellChoice;
}

const nativePresets: Record<'windows' | 'unix', Array<{ id: string; label: string }>> = {
  windows: [
    { id: 'pwsh', label: 'PowerShell 7' },
    { id: 'powershell', label: 'Windows PowerShell' },
    { id: 'cmd', label: 'Command Prompt' },
  ],
  unix: [
    { id: 'zsh', label: 'zsh' },
    { id: 'bash', label: 'bash' },
    { id: 'fish', label: 'fish' },
    { id: 'sh', label: 'sh' },
  ],
};

export function embeddedShellOptions(wslDistributions: readonly string[] = []): EmbeddedShellOption[] {
  const platform = osType() === 'windows' ? 'windows' : 'unix';
  return [
    {
      value: SHELL_SYSTEM_VALUE,
      label: 'System default',
      group: 'native',
      choice: { kind: 'system' },
    },
    ...nativePresets[platform].map(({ id, label }) => ({
      value: `preset:${id}`,
      label,
      group: 'native' as const,
      choice: { kind: 'preset' as const, id },
    })),
    ...wslDistributions.map((distribution) => ({
      value: `wsl:${encodeURIComponent(distribution)}`,
      label: `WSL · ${distribution}`,
      group: 'wsl' as const,
      choice: { kind: 'wsl' as const, distribution },
    })),
  ];
}

export function embeddedShellValue(choice: EmbeddedShellChoice): string {
  if (choice.kind === 'system') return SHELL_SYSTEM_VALUE;
  if (choice.kind === 'preset') return `preset:${choice.id}`;
  if (choice.kind === 'wsl') return `wsl:${encodeURIComponent(choice.distribution)}`;
  return SHELL_CUSTOM_VALUE;
}

export function embeddedShellFromValue(
  value: string,
  current: EmbeddedShellChoice,
): EmbeddedShellChoice {
  if (value === SHELL_SYSTEM_VALUE) return { kind: 'system' };
  if (value === SHELL_CUSTOM_VALUE) {
    return current.kind === 'custom' ? current : { kind: 'custom', command: '' };
  }
  if (value.startsWith('wsl:')) {
    return { kind: 'wsl', distribution: decodeURIComponent(value.slice(4)) };
  }
  return { kind: 'preset', id: value.replace(/^preset:/, '') };
}

export function embeddedShellLabel(choice: EmbeddedShellChoice): string {
  if (choice.kind === 'system') return 'System default';
  if (choice.kind === 'wsl') return `WSL · ${choice.distribution}`;
  if (choice.kind === 'custom') return choice.command.trim() || 'Custom command';
  return [...nativePresets.windows, ...nativePresets.unix]
    .find((preset) => preset.id === choice.id)?.label ?? choice.id;
}
