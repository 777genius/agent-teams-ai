import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';

export interface CursorAgentAtomicReapRequest {
  contractVersion: 1;
  reason: 'team-stop' | 'startup';
  ownedWorkspaceCwds: readonly string[];
  startedBeforeMs: number;
}

export interface CursorAgentAtomicReapResponse {
  contractVersion: 1;
  status: 'completed' | 'kept' | 'incomplete';
  killedPids: number[];
  diagnostics: string[];
}

export interface CursorAgentAtomicReapResult {
  contractVersion: 1;
  status: CursorAgentAtomicReapResponse['status'] | 'unsupported' | 'unknown';
  killedPids: number[];
  diagnostics: string[];
}

export interface CursorAgentAtomicReapInput extends CursorAgentAtomicReapRequest {
  /** App-only admission guard; never serialized into the runtime request. */
  canDispatch?: () => boolean;
}

export interface CursorAgentAtomicReapPort {
  reapUnleasedCursorAgentTrees(
    input: CursorAgentAtomicReapInput
  ): Promise<CursorAgentAtomicReapResult>;
}

function unavailable(
  status: 'unsupported' | 'unknown' | 'kept',
  diagnostic: string
): CursorAgentAtomicReapResult {
  return { contractVersion: 1, status, killedPids: [], diagnostics: [diagnostic] };
}

function isResponse(value: unknown): value is CursorAgentAtomicReapResponse {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  return (
    reply.contractVersion === 1 &&
    (reply.status === 'completed' || reply.status === 'kept' || reply.status === 'incomplete') &&
    Array.isArray(reply.killedPids) &&
    reply.killedPids.every(
      (pid: unknown) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
    ) &&
    new Set(reply.killedPids).size === reply.killedPids.length &&
    Array.isArray(reply.diagnostics) &&
    reply.diagnostics.every((entry: unknown) => typeof entry === 'string')
  );
}

/** No local process inspection, signals, or recovery retries belong in this port. */
export function createCursorAgentAtomicReapPort(
  executor: OpenCodeReadinessBridgeCommandExecutor
): CursorAgentAtomicReapPort {
  return {
    async reapUnleasedCursorAgentTrees(input) {
      try {
        if (input.canDispatch?.() === false) {
          return unavailable('kept', 'Skipped cursor-agent runtime reap: dispatch not admitted');
        }
        if (
          input.contractVersion !== 1 ||
          (input.reason !== 'team-stop' && input.reason !== 'startup') ||
          !Number.isFinite(input.startedBeforeMs) ||
          input.startedBeforeMs < 0 ||
          !Array.isArray(input.ownedWorkspaceCwds) ||
          input.ownedWorkspaceCwds.length === 0 ||
          !input.ownedWorkspaceCwds.every(
            (cwd) => typeof cwd === 'string' && cwd.trim().length > 0 && !cwd.includes('\0')
          )
        ) {
          return unavailable(
            'unknown',
            'Invalid cursor-agent runtime reap request; no command dispatched'
          );
        }
        const body: CursorAgentAtomicReapRequest = {
          contractVersion: 1,
          reason: input.reason,
          ownedWorkspaceCwds: [...input.ownedWorkspaceCwds],
          startedBeforeMs: input.startedBeforeMs,
        };
        const reply = await executor.execute<CursorAgentAtomicReapRequest, unknown>(
          'opencode.reapUnleasedCursorAgentTrees',
          body,
          { cwd: body.ownedWorkspaceCwds[0], timeoutMs: 15_000, canDispatch: input.canDispatch }
        );
        if (!reply || reply.ok !== true) {
          return unavailable(
            'unknown',
            'Cursor-agent runtime reap rejected or unavailable; outcome unknown'
          );
        }
        if (!isResponse(reply.data)) {
          return unavailable(
            'unknown',
            'Malformed cursor-agent runtime reap response; outcome unknown'
          );
        }
        return {
          contractVersion: 1,
          status: reply.data.status,
          killedPids: [...reply.data.killedPids],
          diagnostics: [...reply.data.diagnostics],
        };
      } catch (error) {
        return unavailable(
          'unknown',
          `Cursor-agent runtime reap failed; outcome unknown: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}

let configuredPort: CursorAgentAtomicReapPort | null = null;

export function configureCursorAgentAtomicReapBridge(
  executor: OpenCodeReadinessBridgeCommandExecutor | null
): void {
  configuredPort = executor === null ? null : createCursorAgentAtomicReapPort(executor);
}

export const DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT: CursorAgentAtomicReapPort = {
  reapUnleasedCursorAgentTrees(input) {
    return configuredPort
      ? configuredPort.reapUnleasedCursorAgentTrees(input)
      : Promise.resolve(
          unavailable('unsupported', 'Cursor-agent runtime reap bridge is not configured')
        );
  },
};
