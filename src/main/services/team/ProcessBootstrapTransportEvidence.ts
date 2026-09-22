import type { PersistedTeamLaunchPhase } from '@shared/types';

export type ProcessBootstrapTransportEvent = Record<string, unknown>;

export type ProcessBootstrapTransportTerminalKind =
  | 'non_retryable_submit_rejection'
  | 'accepted_without_message_id'
  | 'process_exited_before_confirmation'
  | 'runtime_failed_before_confirmation';

export interface ProcessBootstrapTransportSummary {
  lastStage?: string;
  lastObservedAt?: string;
  submitted: boolean;
  hasProgress: boolean;
  terminalFailure?: {
    kind: ProcessBootstrapTransportTerminalKind;
    reason: string;
    observedAt?: string;
  };
}

export type ProcessBootstrapTransportProjectionPhase = 'active' | 'final';

// These helpers intentionally summarize process transport only. They explain
// where bootstrap got stuck, but never prove teammate readiness by themselves.
const MAX_TRANSPORT_DETAIL_CHARS = 500;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const TRANSPORT_STAGE_LABELS: Record<string, string> = {
  process_spawned: 'process spawned',
  stdout_attached: 'stdout attached',
  cli_started: 'CLI started',
  startup_checkpoint: 'startup checkpoint',
  runtime_ready: 'runtime ready',
  inbox_poller_ready: 'inbox poller ready',
  mailbox_bootstrap_written: 'bootstrap mailbox row written',
  bootstrap_prompt_observed: 'bootstrap prompt observed',
  bootstrap_submit_attempted: 'bootstrap submit attempted',
  bootstrap_submit_deferred: 'bootstrap submit deferred',
  bootstrap_submit_rejected: 'bootstrap submit rejected',
  bootstrap_submit_accepted_without_uuid: 'bootstrap submit accepted without message id',
  bootstrap_submitted: 'bootstrap submitted',
  failed: 'runtime failed',
  exited: 'runtime exited',
};

export function sanitizeProcessRuntimeEventFilePrefix(value: string): string {
  const normalized = String(value)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase();
  const normalizedStem =
    normalized
      .trim()
      .replace(/[. ]+$/g, '')
      .split('.')[0] ?? normalized;
  return normalizedStem && WINDOWS_RESERVED_BASENAMES.has(normalizedStem)
    ? `_${normalized}`
    : normalized;
}

export function deriveProcessTransportProjectionPhase(input: {
  launchPhase: PersistedTeamLaunchPhase;
  finalTimeoutReached?: boolean;
}): ProcessBootstrapTransportProjectionPhase {
  if (input.launchPhase !== 'active') {
    return 'final';
  }
  return input.finalTimeoutReached === true ? 'final' : 'active';
}

export function sanitizeProcessBootstrapTransportDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/g, '[redacted]')
    .replace(/\/[^\s"'`]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TRANSPORT_DETAIL_CHARS);
  return sanitized.length > 0 ? sanitized : undefined;
}

function eventType(event: ProcessBootstrapTransportEvent): string {
  return typeof event.type === 'string' ? event.type : '';
}

function eventTimestamp(event: ProcessBootstrapTransportEvent): string | undefined {
  return typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp))
    ? event.timestamp
    : undefined;
}

function stageLabel(event: ProcessBootstrapTransportEvent): string | undefined {
  const type = eventType(event);
  const label = TRANSPORT_STAGE_LABELS[type];
  if (!label) {
    return undefined;
  }
  const detail = sanitizeProcessBootstrapTransportDetail(event.detail);
  if (type === 'process_spawned' || type === 'stdout_attached' || type === 'cli_started') {
    return label;
  }
  return detail ? `${label}: ${detail}` : label;
}

function terminalFailureForEvent(
  event: ProcessBootstrapTransportEvent
): ProcessBootstrapTransportSummary['terminalFailure'] | undefined {
  const type = eventType(event);
  const label = stageLabel(event);
  const observedAt = eventTimestamp(event);
  if (type === 'failed') {
    return {
      kind: 'runtime_failed_before_confirmation',
      reason: label ?? 'runtime failed before bootstrap confirmation',
      observedAt,
    };
  }
  if (type === 'exited') {
    return {
      kind: 'process_exited_before_confirmation',
      reason: label ?? 'runtime exited before bootstrap confirmation',
      observedAt,
    };
  }
  if (type === 'bootstrap_submit_accepted_without_uuid') {
    return {
      kind: 'accepted_without_message_id',
      reason: label ?? 'bootstrap submit accepted without message id',
      observedAt,
    };
  }
  if (type === 'bootstrap_submit_rejected' && event.retryable === false) {
    return {
      kind: 'non_retryable_submit_rejection',
      reason: label ?? 'bootstrap submit rejected',
      observedAt,
    };
  }
  return undefined;
}

export function summarizeProcessBootstrapTransportEvents(
  events: readonly ProcessBootstrapTransportEvent[]
): ProcessBootstrapTransportSummary | null {
  if (events.length === 0) {
    return null;
  }
  let lastStage: string | undefined;
  let lastObservedAt: string | undefined;
  let submitted = false;
  let terminalFailure: ProcessBootstrapTransportSummary['terminalFailure'];

  for (const event of events) {
    const label = stageLabel(event);
    if (!label) {
      continue;
    }
    lastStage = label;
    lastObservedAt = eventTimestamp(event) ?? lastObservedAt;
    if (eventType(event) === 'bootstrap_submitted') {
      submitted = true;
    }
    terminalFailure = terminalFailureForEvent(event) ?? terminalFailure;
  }

  if (!lastStage && !terminalFailure) {
    return null;
  }
  return {
    ...(lastStage ? { lastStage } : {}),
    ...(lastObservedAt ? { lastObservedAt } : {}),
    submitted,
    hasProgress: Boolean(lastStage),
    ...(terminalFailure ? { terminalFailure } : {}),
  };
}

export function buildProcessBootstrapPendingDiagnostic(
  summary: ProcessBootstrapTransportSummary
): string {
  if (summary.submitted) {
    return summary.lastStage
      ? `Bootstrap prompt was submitted; waiting for bootstrap confirmation. Last transport stage: ${summary.lastStage}.`
      : 'Bootstrap prompt was submitted; waiting for bootstrap confirmation.';
  }

  return summary.lastStage
    ? `Bootstrap prompt has not been submitted yet. Last transport stage: ${summary.lastStage}.`
    : 'Bootstrap prompt has not been submitted yet.';
}

export function buildProcessBootstrapTimeoutDiagnostic(
  summary: ProcessBootstrapTransportSummary
): string {
  if (summary.submitted) {
    return summary.lastStage
      ? `Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout. Last transport stage: ${summary.lastStage}`
      : 'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.';
  }

  return summary.lastStage
    ? `Bootstrap prompt was not submitted before timeout. Last transport stage: ${summary.lastStage}`
    : 'Bootstrap prompt was not submitted before timeout.';
}
