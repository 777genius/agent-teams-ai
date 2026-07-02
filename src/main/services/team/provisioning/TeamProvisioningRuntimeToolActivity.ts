import type { ActiveToolCall, ToolActivityEventPayload } from '@shared/types';

export interface RuntimeToolActivityRunLike {
  activeToolCalls: Map<string, ActiveToolCall>;
  memberSpawnToolUseIds: Map<string, string>;
}

export interface ResetRuntimeToolActivityPorts {
  emitToolActivity(payload: ToolActivityEventPayload): void;
}

export interface ClearMemberSpawnToolTrackingPorts {
  appendMemberBootstrapDiagnostic(memberName: string, text: string): void;
}

export function resetRuntimeToolActivity(
  run: Pick<RuntimeToolActivityRunLike, 'activeToolCalls'>,
  memberName: string | undefined,
  ports: ResetRuntimeToolActivityPorts
): void {
  if (run.activeToolCalls.size === 0) {
    return;
  }

  if (!memberName) {
    run.activeToolCalls.clear();
    ports.emitToolActivity({ action: 'reset' });
    return;
  }

  let removed = false;
  for (const [toolUseId, active] of run.activeToolCalls.entries()) {
    if (active.memberName !== memberName) {
      continue;
    }
    run.activeToolCalls.delete(toolUseId);
    removed = true;
  }

  if (removed) {
    ports.emitToolActivity({ action: 'reset', memberName });
  }
}

export function clearMemberSpawnToolTracking(
  run: Pick<RuntimeToolActivityRunLike, 'memberSpawnToolUseIds'>,
  memberName: string,
  ports: ClearMemberSpawnToolTrackingPorts
): void {
  let removed = false;
  for (const [toolUseId, trackedMemberName] of run.memberSpawnToolUseIds.entries()) {
    if (trackedMemberName !== memberName) {
      continue;
    }
    run.memberSpawnToolUseIds.delete(toolUseId);
    removed = true;
  }

  if (removed) {
    ports.appendMemberBootstrapDiagnostic(
      memberName,
      'cleared stale spawn tool tracking before manual restart'
    );
  }
}
