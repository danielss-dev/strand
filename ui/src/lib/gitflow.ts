export interface FlowConfig { production: string; develop: string; feature: string; release: string; hotfix: string; version_tag: string }
export interface FlowState { enabled: boolean; config: FlowConfig; options: Record<string, string>; branches: Record<string, string>; current: string; head: string; operation: string | null; clean: boolean; conflicts: boolean; token: string }
export type FlowKind = 'feature' | 'release' | 'hotfix';
export type FlowAction = 'start' | 'finish' | 'continue_merge' | 'abort_merge';
export interface FlowPlan { kind: FlowKind; action: FlowAction; name: string; token: string; args: string[]; steps: string[] }
export interface FlowTool { available: boolean; version: string }
export interface FlowOutcome { success: boolean; output: string; state: FlowState }
