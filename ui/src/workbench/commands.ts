export type WorkbenchCommandId = `${string}.${string}`;

export interface WorkbenchCommandContext {
  readonly surface: {
    readonly id: string;
    readonly instanceId: string;
  };
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly worktreeId?: string;
}

export interface WorkbenchCommandDefinition {
  readonly id: WorkbenchCommandId;
  readonly title: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  readonly isAvailable?: (context: WorkbenchCommandContext, args?: unknown) => boolean;
  readonly execute: (context: WorkbenchCommandContext, args?: unknown) => unknown | Promise<unknown>;
}

export class DuplicateWorkbenchCommandError extends Error {
  constructor(readonly commandId: WorkbenchCommandId) {
    super(`Workbench command "${commandId}" is already registered.`);
    this.name = 'DuplicateWorkbenchCommandError';
  }
}

export class UnknownWorkbenchCommandError extends Error {
  constructor(readonly commandId: WorkbenchCommandId) {
    super(`Workbench command "${commandId}" is not registered.`);
    this.name = 'UnknownWorkbenchCommandError';
  }
}

export class UnavailableWorkbenchCommandError extends Error {
  constructor(readonly commandId: WorkbenchCommandId) {
    super(`Workbench command "${commandId}" is unavailable in this context.`);
    this.name = 'UnavailableWorkbenchCommandError';
  }
}

export class WorkbenchCommandRegistry {
  private readonly commands = new Map<WorkbenchCommandId, WorkbenchCommandDefinition>();

  register(command: WorkbenchCommandDefinition): void {
    if (!isNamespacedCommandId(command.id)) {
      throw new TypeError(`Workbench command id "${command.id}" must be namespaced.`);
    }
    if (this.commands.has(command.id)) {
      throw new DuplicateWorkbenchCommandError(command.id);
    }
    this.commands.set(command.id, command);
  }

  unregister(commandId: WorkbenchCommandId): boolean {
    return this.commands.delete(commandId);
  }

  get(commandId: WorkbenchCommandId): WorkbenchCommandDefinition | undefined {
    return this.commands.get(commandId);
  }

  list(): readonly WorkbenchCommandDefinition[] {
    return [...this.commands.values()];
  }

  isAvailable(commandId: WorkbenchCommandId, context: WorkbenchCommandContext, args?: unknown): boolean {
    const command = this.commands.get(commandId);
    return command != null && (command.isAvailable?.(context, args) ?? true);
  }

  async execute(
    commandId: WorkbenchCommandId,
    context: WorkbenchCommandContext,
    args?: unknown,
  ): Promise<unknown> {
    const command = this.commands.get(commandId);
    if (!command) throw new UnknownWorkbenchCommandError(commandId);
    if (!(command.isAvailable?.(context, args) ?? true)) {
      throw new UnavailableWorkbenchCommandError(commandId);
    }
    return command.execute(context, args);
  }
}

function isNamespacedCommandId(value: string): value is WorkbenchCommandId {
  return /^[^.\s]+(?:\.[^.\s]+)+$/.test(value);
}
