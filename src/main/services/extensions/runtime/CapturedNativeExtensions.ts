import {
  nativeExtensionCommandSchema,
  nativeMcpDiagnosticsSchema,
  nativeMcpStateSchema,
  nativePluginStateSchema,
} from '@agent-teams/legacy-agent-host/extension-management';
import { captureNativeExtensionSelection } from '@features/runtime-provider-management/main';

import {
  capturedExtensionCommandRunner,
  runCapturedExtensionCommand,
} from './CapturedExtensionCommandLedger';

import type {
  NativeExtensionCommand,
  NativeExtensionTarget,
} from '@agent-teams/legacy-agent-host/extension-management';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type { ApplicationCommandRunner } from '@features/application-command-ledger';
import type { OperationResult } from '@shared/types/extensions';
import type { IpcMainInvokeEvent } from 'electron';

export interface NativeExtensionSelection {
  readonly panel: 'plugins' | 'mcp';
  readonly scope: NativeExtensionTarget['scope'];
}
export interface NativeExtensionMutation {
  execute(command: NativeExtensionCommand): Promise<OperationResult>;
}
export type NativeExtensionCapture = (
  event: IpcMainInvokeEvent,
  projectPath: string | undefined,
  selection: NativeExtensionSelection
) => Promise<CapturedNativeExtensions> | undefined;

function value(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true || !('value' in raw))
    throw new Error('Original extension request is unavailable');
  return raw.value;
}

/** Main-only original account/context target. Renderer supplies existing choices, never a native path. */
export class CapturedNativeExtensions implements NativeExtensionMutation {
  private constructor(
    private readonly owner: CapturedProviderManagement,
    private readonly target: NativeExtensionTarget,
    private readonly runner: ApplicationCommandRunner | null
  ) {}

  static async capture(
    owner: CapturedProviderManagement,
    selection: NativeExtensionSelection,
    runner: ApplicationCommandRunner | null = capturedExtensionCommandRunner()
  ): Promise<CapturedNativeExtensions> {
    const target = await captureNativeExtensionSelection(owner, selection);
    return new CapturedNativeExtensions(owner, target, runner);
  }

  private payload() {
    if (!this.owner.isCurrent()) throw new Error('Original extension selection changed');
    return {
      targetId: this.target.targetId,
      panel: this.target.panel,
      scope: this.target.scope,
    };
  }
  private check(result: NativeExtensionTarget): void {
    this.payload();
    if (
      result.profileId !== this.owner.profileId ||
      result.configRevision !== this.owner.configRevision ||
      result.targetId !== this.target.targetId ||
      result.panel !== this.target.panel ||
      result.scope !== this.target.scope
    )
      throw new Error('Original extension response changed');
  }
  async plugins() {
    if (this.target.panel !== 'plugins') throw new Error('Original plugin selection required');
    const result = nativePluginStateSchema.parse(
      value(await this.owner.request('extension.read', this.payload()))
    );
    this.check(result);
    return { entries: result.entries, installCounts: result.installCounts };
  }
  async mcp() {
    if (this.target.panel !== 'mcp') throw new Error('Original MCP selection required');
    const result = nativeMcpStateSchema.parse(
      value(await this.owner.request('extension.read', this.payload()))
    );
    this.check(result);
    return result.entries;
  }
  async diagnose() {
    if (this.target.panel !== 'mcp') throw new Error('Original MCP selection required');
    const result = nativeMcpDiagnosticsSchema.parse(
      value(await this.owner.request('extension.diagnose', this.payload()))
    );
    this.check(result);
    return result.entries;
  }
  async execute(raw: NativeExtensionCommand): Promise<OperationResult> {
    const command = nativeExtensionCommandSchema.parse(raw);
    this.payload();
    if (
      command.scope !== this.target.scope ||
      !command.action.startsWith(this.target.panel === 'plugins' ? 'plugin.' : 'mcp.')
    )
      throw new Error('Original extension scope changed');
    if (!this.runner) throw new Error('Durable extension command storage is unavailable');
    let result;
    try {
      result = await runCapturedExtensionCommand(this.runner, this.owner, this.target, command);
    } catch {
      return {
        state: 'error',
        error:
          'The original extension change is unconfirmed. Its original request has been retained.',
      };
    }
    this.check({ ...this.target, ...result });
    if (result.action !== command.action) throw new Error('Original extension intent changed');
    return result.phase === 'completed'
      ? { state: 'success' }
      : {
          state: 'error',
          error:
            result.phase === 'failed'
              ? 'The native extension command failed. Refresh its status before retrying.'
              : 'The original extension change is unconfirmed. Its original request has been retained.',
        };
  }
}
