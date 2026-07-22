import { sanitizeRuntimeProjectionProcessCommand } from './RuntimeProjectionCommandRedaction';
import { projectRuntimeDiagnostics } from './RuntimeProjectionDiagnostics';

import type {
  RuntimeProjectionDiagnosticEvidence,
  RuntimeProjectionLivenessEvidence,
} from './RuntimeProjectionEvidence';
import type {
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
} from '@shared/types';

export { sanitizeRuntimeProjectionProcessCommand } from './RuntimeProjectionCommandRedaction';

export interface RuntimeProjectionLivenessOptions {
  nowMs?: number;
  heartbeatStaleAfterMs?: number;
}

export interface RuntimeProjectionLivenessProjection {
  alive: boolean;
  livenessKind: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  metricsPid?: number;
  runtimeSessionId?: string;
  runtimeLastSeenAt?: string;
  processCommand?: string;
  runtimeDiagnostic: string;
  runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics: string[];
}

export function isStrongRuntimeEvidence(
  value: { livenessKind?: TeamAgentRuntimeLivenessKind } | undefined
): boolean {
  return value?.livenessKind === 'confirmed_bootstrap' || value?.livenessKind === 'runtime_process';
}

const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 120_000;
function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIsoMs(value: string | undefined): number | undefined {
  const timestampMs = Date.parse(value ?? '');
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function normalizedIsoTimestamp(value: string | undefined): string | undefined {
  const trimmed = nonEmptyString(value);
  return parseIsoMs(trimmed) === undefined ? undefined : trimmed;
}

function heartbeatTimestamp(
  heartbeat: RuntimeProjectionLivenessEvidence['heartbeat']
): string | undefined {
  return (
    normalizedIsoTimestamp(heartbeat?.lastSeenAt) ??
    normalizedIsoTimestamp(heartbeat?.lastHeartbeatAt)
  );
}

function hasPersistedRuntimeEvidence(evidence: RuntimeProjectionLivenessEvidence): boolean {
  const registration = evidence.registration;
  return Boolean(
    nonEmptyString(registration?.agentId) ||
    nonEmptyString(registration?.tmuxPaneId) ||
    nonEmptyString(registration?.runtimeSessionId) ||
    registration?.backendType ||
    registration?.providerId ||
    positiveInteger(registration?.runtimePid)
  );
}

function isHeartbeatStale(
  evidence: RuntimeProjectionLivenessEvidence,
  options: RuntimeProjectionLivenessOptions
): boolean {
  const heartbeat = evidence.heartbeat;
  const lastSeenMs = parseIsoMs(heartbeatTimestamp(heartbeat));
  const nowMs = options.nowMs;
  if (lastSeenMs === undefined || nowMs === undefined || !Number.isFinite(nowMs)) {
    return false;
  }
  const staleAfterMs =
    heartbeat?.staleAfterMs ?? options.heartbeatStaleAfterMs ?? DEFAULT_HEARTBEAT_STALE_AFTER_MS;
  return Number.isFinite(staleAfterMs) && nowMs - lastSeenMs > staleAfterMs;
}

function buildProjection(
  params: {
    alive: boolean;
    livenessKind: TeamAgentRuntimeLivenessKind;
    runtimeDiagnostic: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    diagnostics?: readonly string[];
    pidSource?: TeamAgentRuntimePidSource;
    pid?: number;
    metricsPid?: number;
    runtimeSessionId?: string;
    runtimeLastSeenAt?: string;
    processCommand?: string;
  },
  diagnosticEvidence: RuntimeProjectionDiagnosticEvidence | undefined
): RuntimeProjectionLivenessProjection {
  const processCommand = sanitizeRuntimeProjectionProcessCommand(params.processCommand);
  const diagnosticProjection = projectRuntimeDiagnostics(
    {
      message: params.runtimeDiagnostic,
      severity: params.runtimeDiagnosticSeverity ?? 'info',
      diagnostics: params.diagnostics,
    },
    diagnosticEvidence
  );
  const runtimeDiagnostic = diagnosticProjection.runtimeDiagnostic ?? params.runtimeDiagnostic;
  return {
    alive: params.alive,
    livenessKind: params.livenessKind,
    ...(params.pidSource ? { pidSource: params.pidSource } : {}),
    ...(positiveInteger(params.pid) ? { pid: positiveInteger(params.pid) } : {}),
    ...(positiveInteger(params.metricsPid)
      ? { metricsPid: positiveInteger(params.metricsPid) }
      : {}),
    ...(nonEmptyString(params.runtimeSessionId)
      ? { runtimeSessionId: nonEmptyString(params.runtimeSessionId) }
      : {}),
    ...(nonEmptyString(params.runtimeLastSeenAt)
      ? { runtimeLastSeenAt: nonEmptyString(params.runtimeLastSeenAt) }
      : {}),
    ...(processCommand ? { processCommand } : {}),
    runtimeDiagnostic,
    runtimeDiagnosticSeverity: diagnosticProjection.runtimeDiagnosticSeverity ?? 'info',
    diagnostics: diagnosticProjection.diagnostics ?? [runtimeDiagnostic],
  };
}

function projectConfirmedBootstrap(
  params: {
    runtimeSessionId?: string;
    runtimeLastSeenAt?: string;
    runtimeDiagnostic?: string;
    diagnostics?: readonly string[];
  },
  diagnosticEvidence: RuntimeProjectionDiagnosticEvidence | undefined
): RuntimeProjectionLivenessProjection {
  return buildProjection(
    {
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeSessionId: params.runtimeSessionId,
      runtimeLastSeenAt: params.runtimeLastSeenAt,
      runtimeDiagnostic: params.runtimeDiagnostic ?? 'bootstrap confirmed',
      diagnostics: params.diagnostics ?? ['fresh runtime heartbeat confirmed bootstrap'],
    },
    diagnosticEvidence
  );
}

export function projectRuntimeLiveness(
  evidence: RuntimeProjectionLivenessEvidence,
  options: RuntimeProjectionLivenessOptions = {}
): RuntimeProjectionLivenessProjection {
  const runtimeSessionId =
    nonEmptyString(evidence.heartbeat?.runtimeSessionId) ??
    nonEmptyString(evidence.registration?.runtimeSessionId);
  const runtimeLastSeenAt = heartbeatTimestamp(evidence.heartbeat);
  const permissionBlocked =
    evidence.permission?.blocked === true ||
    (evidence.permission?.pendingPermissionRequestIds?.length ?? 0) > 0;

  if (permissionBlocked) {
    return buildProjection(
      {
        alive: false,
        livenessKind: 'permission_blocked',
        runtimeSessionId,
        runtimeDiagnostic: 'waiting for permission approval',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: ['permission approval pending'],
      },
      evidence.diagnostic
    );
  }

  const processPid = positiveInteger(evidence.process?.pid);
  const metricsPid = positiveInteger(evidence.process?.metricsPid);
  const heartbeatConfirmed = evidence.heartbeat?.bootstrapConfirmed === true;
  const freshConfirmedHeartbeat = heartbeatConfirmed && !isHeartbeatStale(evidence, options);
  if (evidence.process?.running === true) {
    if (evidence.process.identityVerified === true) {
      return buildProjection(
        {
          alive: true,
          livenessKind: 'runtime_process',
          pidSource: evidence.process.pidSource,
          pid: processPid,
          metricsPid,
          runtimeSessionId,
          runtimeLastSeenAt,
          processCommand: evidence.process.command,
          runtimeDiagnostic: 'runtime process detected',
          diagnostics: ['runtime process evidence is live'],
        },
        evidence.diagnostic
      );
    }

    if (freshConfirmedHeartbeat) {
      return projectConfirmedBootstrap(
        {
          runtimeSessionId,
          runtimeLastSeenAt,
          runtimeDiagnostic: 'bootstrap confirmed; process identity is unverified',
          diagnostics: [
            'fresh runtime heartbeat confirmed bootstrap',
            'runtime process is alive without verified runtime identity',
          ],
        },
        evidence.diagnostic
      );
    }

    return buildProjection(
      {
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pidSource: evidence.process.pidSource,
        pid: processPid,
        metricsPid,
        runtimeSessionId,
        processCommand: evidence.process.command,
        runtimeDiagnostic: 'runtime process candidate detected, but identity is unverified',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: ['runtime process is alive without verified runtime identity'],
      },
      evidence.diagnostic
    );
  }

  if (freshConfirmedHeartbeat) {
    return projectConfirmedBootstrap(
      {
        runtimeSessionId,
        runtimeLastSeenAt,
      },
      evidence.diagnostic
    );
  }

  if (heartbeatConfirmed) {
    return buildProjection(
      {
        alive: false,
        livenessKind: 'registered_only',
        pidSource: 'runtime_bootstrap',
        runtimeSessionId,
        runtimeLastSeenAt,
        runtimeDiagnostic: 'runtime heartbeat is stale',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: ['bootstrap evidence exists, but the heartbeat is stale'],
      },
      evidence.diagnostic
    );
  }

  const expectedPid = processPid ?? positiveInteger(evidence.registration?.runtimePid);
  if (expectedPid) {
    const processTableAvailable = evidence.process?.processTableAvailable !== false;
    return buildProjection(
      {
        alive: false,
        livenessKind: processTableAvailable ? 'stale_metadata' : 'registered_only',
        pidSource: evidence.process?.pidSource ?? 'persisted_metadata',
        pid: expectedPid,
        runtimeSessionId,
        runtimeDiagnostic: processTableAvailable
          ? 'persisted runtime pid is not alive'
          : 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: [
          processTableAvailable
            ? 'persisted runtime pid was not found in process table'
            : 'runtime pid could not be verified',
        ],
      },
      evidence.diagnostic
    );
  }

  if (hasPersistedRuntimeEvidence(evidence)) {
    return buildProjection(
      {
        alive: false,
        livenessKind: 'registered_only',
        runtimeSessionId,
        runtimeDiagnostic: 'registered runtime metadata without live process',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: ['member has persisted runtime metadata only'],
      },
      evidence.diagnostic
    );
  }

  return buildProjection(
    {
      alive: false,
      livenessKind: 'not_found',
      runtimeDiagnostic: 'runtime process not found',
      runtimeDiagnosticSeverity: 'warning',
      diagnostics: ['runtime process not found'],
    },
    evidence.diagnostic
  );
}
