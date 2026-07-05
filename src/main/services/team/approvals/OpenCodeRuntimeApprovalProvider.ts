import type {
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePendingApproval,
} from '../runtime/TeamRuntimeAdapter';
import type {
  RuntimeApprovalLaunchPolicy,
  RuntimeApprovalProviderPort,
  RuntimeToolApprovalAnswerInput,
  RuntimeToolApprovalEntry,
} from './RuntimeToolApprovalCoordinator';
import type { ToolApprovalRequest } from '@shared/types/team';

interface CollectOpenCodeRuntimeApprovalsInput {
  teamName: string;
  runId: string;
  laneId: string;
  cwd: string;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  expectedMembers: TeamRuntimeMemberSpec[];
  teamColor?: string;
  teamDisplayName?: string;
  nowIso?: () => string;
}

export class OpenCodeRuntimeApprovalProvider implements RuntimeApprovalProviderPort<
  { toolApprovalMode?: 'auto' | 'manual' },
  CollectOpenCodeRuntimeApprovalsInput
> {
  readonly providerId = 'opencode' as const;

  buildLaunchPolicy(
    skipPermissions: boolean,
    _context: { toolApprovalMode?: 'auto' | 'manual' } = {}
  ): RuntimeApprovalLaunchPolicy {
    return {
      providerId: this.providerId,
      mode: skipPermissions ? 'auto' : 'manual',
      config: {
        permission: skipPermissions ? 'allow' : 'ask',
      },
    };
  }

  collectPendingApprovals(input: CollectOpenCodeRuntimeApprovalsInput): RuntimeToolApprovalEntry[] {
    return collectOpenCodeRuntimeApprovalEntries(input);
  }

  async answerApproval(_input: RuntimeToolApprovalAnswerInput): Promise<void> {
    throw new Error('OpenCode approval answers are handled by the runtime adapter bridge.');
  }

  assertManualSupported(): void {
    return;
  }
}

export const openCodeRuntimeApprovalProvider = new OpenCodeRuntimeApprovalProvider();

export function collectOpenCodeRuntimeApprovalEntries(
  input: CollectOpenCodeRuntimeApprovalsInput
): RuntimeToolApprovalEntry[] {
  const entries: RuntimeToolApprovalEntry[] = [];
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  for (const [memberName, member] of Object.entries(input.members)) {
    for (const approval of collectOpenCodeRuntimePendingApprovals(member)) {
      const providerRequestId = approval.requestId.trim();
      if (!providerRequestId) {
        continue;
      }
      const requestId = buildOpenCodeRuntimeApprovalRequestId(input.runId, providerRequestId);
      const toolName = openCodeApprovalToolName(approval);
      const toolInput = openCodeApprovalToolInput(approval);
      const uiRequest: ToolApprovalRequest = {
        requestId,
        runId: input.runId,
        teamName: input.teamName,
        providerId: 'opencode',
        source: memberName,
        toolName,
        toolInput,
        receivedAt: nowIso(),
        teamColor: input.teamColor,
        teamDisplayName: input.teamDisplayName,
        runtimePermission: {
          providerId: 'opencode',
          laneId: input.laneId,
          memberName,
          providerRequestId,
          sessionId: approval.sessionId ?? member.sessionId ?? null,
        },
      };
      entries.push({
        providerId: 'opencode',
        approval: uiRequest,
        providerRequestId,
        laneId: input.laneId,
        memberName,
        cwd: input.cwd,
        expectedMembers: input.expectedMembers,
      });
    }
  }
  return entries;
}

function collectOpenCodeRuntimePendingApprovals(
  member: TeamRuntimeMemberLaunchEvidence
): TeamRuntimePendingApproval[] {
  const approvals = [...(member.pendingApprovals ?? []), ...(member.pendingPermissions ?? [])];
  const byRequestId = new Map<string, TeamRuntimePendingApproval>();
  for (const approval of approvals) {
    const requestId = approval.requestId.trim();
    if (!requestId || approval.providerId !== 'opencode' || byRequestId.has(requestId)) {
      continue;
    }
    byRequestId.set(requestId, { ...approval, requestId });
  }
  for (const requestId of member.pendingPermissionRequestIds ?? []) {
    const trimmed = requestId.trim();
    if (!trimmed || byRequestId.has(trimmed)) {
      continue;
    }
    byRequestId.set(trimmed, {
      providerId: 'opencode',
      requestId: trimmed,
      sessionId: member.sessionId ?? null,
      tool: null,
      title: null,
      kind: null,
    });
  }
  return Array.from(byRequestId.values());
}

export function buildOpenCodeRuntimeApprovalRequestId(
  runId: string,
  providerRequestId: string
): string {
  return `opencode:${runId}:${providerRequestId}`;
}

export function openCodeApprovalToolName(approval: TeamRuntimePendingApproval): string {
  const rawTool = approval.tool?.trim() || approval.kind?.trim() || approval.title?.trim();
  const normalized = rawTool?.toLowerCase();
  switch (normalized) {
    case 'bash':
    case 'shell':
    case 'terminal':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    default:
      return rawTool || 'OpenCodeTool';
  }
}

export function openCodeApprovalToolInput(
  approval: TeamRuntimePendingApproval
): Record<string, unknown> {
  const raw: Record<string, unknown> =
    approval.raw && typeof approval.raw === 'object' ? approval.raw : {};
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((value): value is string => typeof value === 'string')
    : undefined;
  const firstPattern = patterns?.[0];
  const title = approval.title?.trim();
  const input: Record<string, unknown> = {
    providerRequestId: approval.requestId,
    provider: 'opencode',
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    ...(approval.tool ? { tool: approval.tool } : {}),
    ...(approval.kind ? { kind: approval.kind } : {}),
    ...(title ? { title } : {}),
    ...(patterns?.length ? { patterns } : {}),
  };
  if (openCodeApprovalToolName(approval) === 'Bash' && firstPattern) {
    input.command = firstPattern;
  }
  return input;
}
