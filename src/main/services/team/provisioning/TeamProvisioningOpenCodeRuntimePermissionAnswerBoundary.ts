import { buildOpenCodeRuntimeApprovalRequestId } from '../approvals/OpenCodeRuntimeApprovalProvider';
import {
  isTeamRuntimeProviderId,
  type TeamRuntimeMemberSpec,
  type TeamRuntimeProviderId,
} from '../runtime/TeamRuntimeAdapter';

import {
  asRuntimeRecord,
  optionalRuntimeString,
  requireRuntimeString,
} from './TeamProvisioningRuntimeMetadata';

import type { RuntimeToolApprovalEntry } from '../approvals/RuntimeToolApprovalCoordinator';
import type {
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeControlPort,
  RuntimePermissionAnswerDecision,
} from '../runtime-control';

export type TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary = Pick<
  OpenCodeRuntimeControlPort,
  'answerOpenCodeRuntimePermission'
>;

export interface TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts {
  answerRuntimeToolApproval(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    message?: string
  ): Promise<void>;
  nowIso(): string;
}

export function createTeamProvisioningOpenCodeRuntimePermissionAnswerBoundary(
  ports: TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts
): TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary {
  return {
    answerOpenCodeRuntimePermission: (raw) => answerOpenCodeRuntimePermission(raw, ports),
  };
}

export async function answerOpenCodeRuntimePermission(
  raw: unknown,
  ports: TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts
): Promise<OpenCodeRuntimeControlAck> {
  const payload = asRuntimeRecord(raw);
  const teamName = requireRuntimeString(payload.teamName, 'teamName');
  const runId = requireRuntimeString(payload.runId, 'runId');
  const laneId = requireRuntimeString(payload.laneId, 'laneId');
  const cwd = requireRuntimeString(payload.cwd ?? payload.projectPath, 'cwd');
  const memberName = requireRuntimeString(payload.memberName, 'memberName');
  const requestId = normalizeOpenCodeRuntimePermissionRequestId(
    requireRuntimeString(payload.providerRequestId ?? payload.requestId, 'requestId'),
    runId
  );
  const decision = normalizeRuntimePermissionAnswerDecision(payload.decision);

  await ports.answerRuntimeToolApproval(
    {
      providerId: 'opencode',
      providerRequestId: requestId,
      laneId,
      memberName,
      cwd,
      expectedMembers: normalizeRuntimePermissionExpectedMembers(payload.expectedMembers, cwd),
      approval: {
        requestId: buildOpenCodeRuntimeApprovalRequestId(runId, requestId),
        runId,
        teamName,
        providerId: 'opencode',
        source: memberName,
        toolName: optionalRuntimeString(payload.toolName) ?? 'OpenCodeTool',
        toolInput: normalizeRuntimePermissionToolInput(payload.toolInput, requestId),
        receivedAt: ports.nowIso(),
        runtimePermission: {
          providerId: 'opencode',
          laneId,
          memberName,
          providerRequestId: requestId,
          sessionId: optionalRuntimeString(payload.runtimeSessionId) ?? null,
        },
      },
    },
    decision === 'allow'
  );

  return {
    ok: true,
    providerId: 'opencode',
    teamName,
    runId,
    state: 'accepted',
    memberName,
    diagnostics: [],
    observedAt: ports.nowIso(),
  };
}

function normalizeRuntimePermissionAnswerDecision(value: unknown): RuntimePermissionAnswerDecision {
  if (value === 'allow' || value === 'reject') {
    return value;
  }
  throw new Error('OpenCode runtime permission answer decision must be allow or reject');
}

function normalizeOpenCodeRuntimePermissionRequestId(value: string, runId: string): string {
  const prefix = 'opencode:';
  const normalized = value.trim();

  if (normalized === prefix) {
    throw new Error('OpenCode runtime payload malformed requestId');
  }

  const runIdEnd = normalized.startsWith(prefix) ? normalized.indexOf(':', prefix.length) : -1;
  if (runIdEnd < 0) {
    return normalized;
  }

  const prefixedRunId = normalized.slice(prefix.length, runIdEnd).trim();
  const providerRequestId = normalized.slice(runIdEnd + 1).trim();
  if (!prefixedRunId || !providerRequestId) {
    throw new Error('OpenCode runtime payload malformed requestId');
  }
  return prefixedRunId === runId ? providerRequestId : normalized;
}

function normalizeRuntimePermissionExpectedMembers(
  value: unknown,
  fallbackCwd: string
): TeamRuntimeMemberSpec[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('OpenCode runtime permission expectedMembers must be an array');
  }
  return value.map((member, index) =>
    normalizeRuntimePermissionExpectedMember(member, index, fallbackCwd)
  );
}

function normalizeRuntimePermissionExpectedMember(
  value: unknown,
  index: number,
  fallbackCwd: string
): TeamRuntimeMemberSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenCode runtime permission expectedMembers[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const role = optionalRuntimeString(record.role);
  const workflow = optionalRuntimeString(record.workflow);
  return {
    name: requireRuntimeString(record.name, `expectedMembers[${index}].name`),
    ...(role ? { role } : {}),
    ...(workflow ? { workflow } : {}),
    providerId: normalizeRuntimeProviderId(record.providerId),
    cwd: optionalRuntimeString(record.cwd) ?? fallbackCwd,
  };
}

function normalizeRuntimeProviderId(value: unknown): TeamRuntimeProviderId {
  return isTeamRuntimeProviderId(value) ? value : 'opencode';
}

function normalizeRuntimePermissionToolInput(
  value: unknown,
  providerRequestId: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { provider: 'opencode', providerRequestId };
  }
  return {
    ...(value as Record<string, unknown>),
    provider: 'opencode',
    providerRequestId,
  };
}
