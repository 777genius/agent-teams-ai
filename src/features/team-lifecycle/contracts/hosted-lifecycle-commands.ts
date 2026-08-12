import {
  type BootId,
  type DeploymentId,
  HOSTED_SCHEMA_VERSION,
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type RunId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

declare const hostedLifecycleCommandBrand: unique symbol;

type HostedLifecycleOpaqueValue<Name extends string> = string & {
  readonly [hostedLifecycleCommandBrand]: Name;
};

export type HostedLifecycleCommandId = HostedLifecycleOpaqueValue<'HostedLifecycleCommandId'>;
export type HostedLifecycleIdempotencyKey =
  HostedLifecycleOpaqueValue<'HostedLifecycleIdempotencyKey'>;

export const HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_LIFECYCLE_COMMAND_ACTIONS = Object.freeze([
  'launch',
  'cancel',
  'stop',
  'recover',
] as const);
export type HostedLifecycleCommandAction = (typeof HOSTED_LIFECYCLE_COMMAND_ACTIONS)[number];
export const HOSTED_LIFECYCLE_COMMAND_ROUTES = Object.freeze({
  controlState: '/api/hosted/v1/team-lifecycle/control-state',
  prepare: '/api/hosted/v1/team-lifecycle/prepare',
  progress: '/api/hosted/v1/team-lifecycle/progress',
  launch: '/api/hosted/v1/team-lifecycle/launch',
  cancel: '/api/hosted/v1/team-lifecycle/cancel',
  stop: '/api/hosted/v1/team-lifecycle/stop',
  recover: '/api/hosted/v1/team-lifecycle/recover',
} as const);
export const HOSTED_LIFECYCLE_CONTROL_STATE_ACTIONS = HOSTED_LIFECYCLE_COMMAND_ACTIONS;
export type HostedLifecycleControlStateAction =
  (typeof HOSTED_LIFECYCLE_CONTROL_STATE_ACTIONS)[number];

export const HOSTED_LIFECYCLE_CONFLICT_REASONS = Object.freeze([
  'authorization_changed',
  'boot_changed',
  'command_in_progress',
  'grant_revoked',
  'idempotency_mismatch',
  'stale_revision',
  'stale_run',
] as const);
export type HostedLifecycleConflictReason = (typeof HOSTED_LIFECYCLE_CONFLICT_REASONS)[number];

export interface HostedLifecycleCommandBase {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly idempotencyKey: HostedLifecycleIdempotencyKey;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision;
}

export interface HostedLifecycleLaunchCommand extends HostedLifecycleCommandBase {
  readonly action: 'launch';
}

export interface HostedLifecycleRunCommand extends HostedLifecycleCommandBase {
  readonly action: 'cancel' | 'stop' | 'recover';
  readonly runId: RunId;
}

export type HostedLifecycleCommand = HostedLifecycleLaunchCommand | HostedLifecycleRunCommand;

export type HostedLifecycleCommandBody =
  | Omit<HostedLifecycleLaunchCommand, 'action'>
  | Omit<HostedLifecycleRunCommand, 'action'>;

export interface HostedLifecycleCommandReceipt {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'accepted' | 'idempotent_replay';
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly resourceRevision: Revision;
}

export interface HostedLifecycleCommandConflict {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'conflict';
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly reason: HostedLifecycleConflictReason;
  readonly currentRevision: Revision | null;
}

export interface HostedLifecycleCommandNotFound {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'not_found';
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}

export interface HostedLifecycleCommandUnavailable {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'unavailable';
  readonly retryAfterMs: number | null;
}

/**
 * A durable owner has recorded the command but cannot yet prove a final postimage. These
 * outcomes must stay distinct from transport unavailability: retrying `started` as a fresh effect
 * or hiding `operator_required` can duplicate an external lifecycle operation.
 */
export interface HostedLifecycleCommandDurableStatus {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'started' | 'operator_required';
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}

export interface HostedLifecycleControlStateRequest {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}

export type HostedLifecyclePrepareRequest = HostedLifecycleControlStateRequest;
export type HostedLifecycleProgressRequest = HostedLifecycleControlStateRequest;

/** Exact browser projection returned only by the external lifecycle authority. */
export interface HostedLifecycleControlState {
  readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
  readonly kind: 'control_state';
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly runId: RunId | null;
  readonly resourceRevision: Revision;
  readonly availableActions: readonly HostedLifecycleControlStateAction[];
}

export type HostedLifecycleControlStateResult =
  | HostedLifecycleControlState
  | {
      readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
      readonly kind: 'not_found';
    }
  | HostedLifecycleCommandUnavailable
  | {
      readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
      readonly kind: 'invalid_request';
    };

export interface HostedLifecyclePreparedState extends Omit<HostedLifecycleControlState, 'kind'> {
  readonly kind: 'prepared';
  readonly lanes: readonly {
    readonly laneKey: string;
    readonly backend: 'provisioning_cli' | 'opencode';
    readonly status: 'ready';
  }[];
}

export interface HostedLifecycleRecentCommandStatus {
  readonly action: HostedLifecycleCommandAction;
  readonly commandId: HostedLifecycleCommandId;
  readonly result: HostedLifecycleCommandPublicResult;
}

/**
 * Server-owned recovery projection. The request intentionally carries no command locator or
 * idempotency material: after reload, reauthentication, response loss, or process replacement the
 * durable owner finds the actor/team's recent or non-terminal commands itself.
 */
export interface HostedLifecycleProvisioningStatus extends Omit<
  HostedLifecycleControlState,
  'kind'
> {
  readonly kind: 'provisioning_status';
  readonly recentCommands: readonly HostedLifecycleRecentCommandStatus[];
}

export type HostedLifecyclePrepareResult =
  | HostedLifecyclePreparedState
  | Exclude<HostedLifecycleControlStateResult, HostedLifecycleControlState>;

export type HostedLifecycleProgressResult =
  | HostedLifecycleProvisioningStatus
  | Exclude<HostedLifecycleControlStateResult, HostedLifecycleControlState>;

export type HostedLifecycleCommandPublicResult =
  | HostedLifecycleCommandReceipt
  | HostedLifecycleCommandConflict
  | HostedLifecycleCommandNotFound
  | HostedLifecycleCommandDurableStatus
  | HostedLifecycleCommandUnavailable;

export type HostedLifecycleCommandExecutionResult =
  | HostedLifecycleCommandPublicResult
  | {
      readonly schemaVersion: typeof HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION;
      readonly kind: 'invalid_request';
    };

export type HostedLifecycleCommandParseResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false };

function failure(): HostedLifecycleCommandParseResult<never> {
  return Object.freeze({ ok: false });
}

const OPAQUE_COMMAND_PATTERN = /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OPAQUE_IDEMPOTENCY_PATTERN = /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const BASE_WIRE_KEYS = Object.freeze([
  'schemaVersion',
  'commandId',
  'idempotencyKey',
  'workspaceId',
  'teamId',
  'expectedRevision',
] as const);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'action',
  'commandId',
  'workspaceId',
  'teamId',
  'runId',
  'resourceRevision',
] as const);
const CONFLICT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'action',
  'commandId',
  'workspaceId',
  'teamId',
  'reason',
  'currentRevision',
] as const);
const NOT_FOUND_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'action',
  'commandId',
  'workspaceId',
  'teamId',
] as const);
const DURABLE_STATUS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'action',
  'commandId',
  'workspaceId',
  'teamId',
] as const);
const UNAVAILABLE_KEYS = Object.freeze(['schemaVersion', 'kind', 'retryAfterMs'] as const);
const CONTROL_STATE_REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'workspaceId',
  'teamId',
] as const);
const CONTROL_STATE_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'workspaceId',
  'teamId',
  'deploymentId',
  'bootId',
  'runId',
  'resourceRevision',
  'availableActions',
] as const);
const PREPARED_STATE_KEYS = Object.freeze([...CONTROL_STATE_KEYS, 'lanes'] as const);
const PREPARED_LANE_KEYS = Object.freeze(['laneKey', 'backend', 'status'] as const);
const PROVISIONING_STATUS_KEYS = Object.freeze([...CONTROL_STATE_KEYS, 'recentCommands'] as const);
const RECENT_COMMAND_STATUS_KEYS = Object.freeze(['action', 'commandId', 'result'] as const);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseHostedLifecycleCommandId(value: unknown): HostedLifecycleCommandId {
  if (typeof value !== 'string' || !OPAQUE_COMMAND_PATTERN.test(value)) {
    throw new TypeError('hosted-lifecycle-command-id-invalid');
  }
  return value as HostedLifecycleCommandId;
}

export function parseHostedLifecycleIdempotencyKey(value: unknown): HostedLifecycleIdempotencyKey {
  if (typeof value !== 'string' || !OPAQUE_IDEMPOTENCY_PATTERN.test(value)) {
    throw new TypeError('hosted-lifecycle-idempotency-key-invalid');
  }
  return value as HostedLifecycleIdempotencyKey;
}

export function isHostedLifecycleCommandAction(
  value: unknown
): value is HostedLifecycleCommandAction {
  return HOSTED_LIFECYCLE_COMMAND_ACTIONS.includes(value as HostedLifecycleCommandAction);
}

function parseBase(value: Record<PropertyKey, unknown>, action: HostedLifecycleCommandAction) {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    action,
    commandId: parseHostedLifecycleCommandId(value.commandId),
    idempotencyKey: parseHostedLifecycleIdempotencyKey(value.idempotencyKey),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    expectedRevision: parseRevision(value.expectedRevision),
  });
}

export function parseHostedLifecycleCommand(
  actionValue: unknown,
  value: unknown
): HostedLifecycleCommandParseResult<HostedLifecycleCommand> {
  try {
    if (!isHostedLifecycleCommandAction(actionValue) || !isRecord(value)) return { ok: false };
    const keys = actionValue === 'launch' ? BASE_WIRE_KEYS : [...BASE_WIRE_KEYS, 'runId'];
    if (!hasExactKeys(value, keys) || value.schemaVersion !== HOSTED_SCHEMA_VERSION) {
      return { ok: false };
    }
    const base = parseBase(value, actionValue);
    const command =
      actionValue === 'launch'
        ? base
        : Object.freeze({ ...base, action: actionValue, runId: parseRunId(value.runId) });
    return Object.freeze({ ok: true, value: command as HostedLifecycleCommand });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function parseHostedLifecycleControlStateRequest(
  value: unknown
): HostedLifecycleCommandParseResult<HostedLifecycleControlStateRequest> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, CONTROL_STATE_REQUEST_KEYS) ||
      value.schemaVersion !== HOSTED_SCHEMA_VERSION
    ) {
      return failure();
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        workspaceId: parseWorkspaceId(value.workspaceId),
        teamId: parseTeamId(value.teamId),
      }),
    });
  } catch {
    return failure();
  }
}

export const parseHostedLifecyclePrepareRequest = parseHostedLifecycleControlStateRequest;
export const parseHostedLifecycleProgressRequest = parseHostedLifecycleControlStateRequest;

export function parseHostedLifecycleControlState(
  value: unknown,
  expected?: HostedLifecycleControlStateRequest & {
    readonly deploymentId: DeploymentId;
    readonly bootId: BootId;
  }
): HostedLifecycleCommandParseResult<HostedLifecycleControlState> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, CONTROL_STATE_KEYS) ||
      value.schemaVersion !== HOSTED_SCHEMA_VERSION ||
      value.kind !== 'control_state' ||
      !Array.isArray(value.availableActions) ||
      Reflect.ownKeys(value.availableActions).length !== value.availableActions.length + 1
    ) {
      return failure();
    }
    const workspaceId = parseWorkspaceId(value.workspaceId);
    const teamId = parseTeamId(value.teamId);
    const deploymentId = parseDeploymentId(value.deploymentId);
    const bootId = parseBootId(value.bootId);
    if (
      expected !== undefined &&
      (workspaceId !== expected.workspaceId ||
        teamId !== expected.teamId ||
        deploymentId !== expected.deploymentId ||
        bootId !== expected.bootId)
    ) {
      return failure();
    }
    const availableActions = value.availableActions.map((action) => {
      if (!isHostedLifecycleCommandAction(action)) throw new TypeError();
      return action;
    });
    if (new Set(availableActions).size !== availableActions.length) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        kind: 'control_state',
        workspaceId,
        teamId,
        deploymentId,
        bootId,
        runId: value.runId === null ? null : parseRunId(value.runId),
        resourceRevision: parseRevision(value.resourceRevision),
        availableActions: Object.freeze(availableActions),
      }),
    });
  } catch {
    return failure();
  }
}

function parseStateProjection(value: Record<PropertyKey, unknown>) {
  if (
    !Array.isArray(value.availableActions) ||
    Reflect.ownKeys(value.availableActions).length !== value.availableActions.length + 1
  ) {
    throw new TypeError();
  }
  const availableActions = value.availableActions.map((action) => {
    if (!isHostedLifecycleCommandAction(action)) throw new TypeError();
    return action;
  });
  if (new Set(availableActions).size !== availableActions.length) throw new TypeError();
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    deploymentId: parseDeploymentId(value.deploymentId),
    bootId: parseBootId(value.bootId),
    runId: value.runId === null ? null : parseRunId(value.runId),
    resourceRevision: parseRevision(value.resourceRevision),
    availableActions: Object.freeze(availableActions),
  });
}

export function parseHostedLifecyclePreparedState(
  value: unknown
): HostedLifecycleCommandParseResult<HostedLifecyclePreparedState> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, PREPARED_STATE_KEYS) ||
      value.schemaVersion !== HOSTED_SCHEMA_VERSION ||
      value.kind !== 'prepared' ||
      !Array.isArray(value.lanes) ||
      value.lanes.length < 1 ||
      value.lanes.length > 32
    ) {
      return failure();
    }
    const lanes = value.lanes.map((lane) => {
      if (
        !isRecord(lane) ||
        !hasExactKeys(lane, PREPARED_LANE_KEYS) ||
        typeof lane.laneKey !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/.test(lane.laneKey) ||
        (lane.backend !== 'provisioning_cli' && lane.backend !== 'opencode') ||
        lane.status !== 'ready'
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        laneKey: lane.laneKey,
        backend: lane.backend,
        status: 'ready' as const,
      });
    });
    if (new Set(lanes.map(({ laneKey }) => laneKey)).size !== lanes.length) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ...parseStateProjection(value),
        kind: 'prepared',
        lanes: Object.freeze(lanes),
      }),
    });
  } catch {
    return failure();
  }
}

export function parseHostedLifecycleProvisioningStatus(
  value: unknown
): HostedLifecycleCommandParseResult<HostedLifecycleProvisioningStatus> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, PROVISIONING_STATUS_KEYS) ||
      value.schemaVersion !== HOSTED_SCHEMA_VERSION ||
      value.kind !== 'provisioning_status' ||
      !Array.isArray(value.recentCommands) ||
      value.recentCommands.length > 16
    ) {
      return failure();
    }
    const recentCommands = value.recentCommands.map((entry) => {
      if (!isRecord(entry) || !hasExactKeys(entry, RECENT_COMMAND_STATUS_KEYS)) {
        throw new TypeError();
      }
      const result = parseHostedLifecycleCommandPublicResult(entry.result);
      if (
        !result.ok ||
        !isHostedLifecycleCommandAction(entry.action) ||
        result.value.kind === 'unavailable' ||
        result.value.action !== entry.action ||
        result.value.commandId !== entry.commandId
      ) {
        throw new TypeError();
      }
      if (result.value.workspaceId !== value.workspaceId || result.value.teamId !== value.teamId) {
        throw new TypeError();
      }
      return Object.freeze({
        action: entry.action,
        commandId: parseHostedLifecycleCommandId(entry.commandId),
        result: result.value,
      });
    });
    if (new Set(recentCommands.map(({ commandId }) => commandId)).size !== recentCommands.length) {
      return failure();
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ...parseStateProjection(value),
        kind: 'provisioning_status',
        recentCommands: Object.freeze(recentCommands),
      }),
    });
  } catch {
    return failure();
  }
}

function parseActionIdentity(value: Record<PropertyKey, unknown>) {
  if (!isHostedLifecycleCommandAction(value.action)) throw new TypeError();
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    action: value.action,
    commandId: parseHostedLifecycleCommandId(value.commandId),
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
  });
}

function parseRetryAfterMs(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60_000) {
    throw new TypeError();
  }
  return value as number;
}

export function parseHostedLifecycleCommandPublicResult(
  value: unknown
): HostedLifecycleCommandParseResult<HostedLifecycleCommandPublicResult> {
  try {
    if (!isRecord(value) || value.schemaVersion !== HOSTED_SCHEMA_VERSION) return { ok: false };
    if (value.kind === 'accepted' || value.kind === 'idempotent_replay') {
      if (!hasExactKeys(value, RECEIPT_KEYS)) return { ok: false };
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ...parseActionIdentity(value),
          kind: value.kind,
          runId: parseRunId(value.runId),
          resourceRevision: parseRevision(value.resourceRevision),
        }),
      });
    }
    if (value.kind === 'conflict') {
      if (
        !hasExactKeys(value, CONFLICT_KEYS) ||
        !HOSTED_LIFECYCLE_CONFLICT_REASONS.includes(value.reason as HostedLifecycleConflictReason)
      ) {
        return { ok: false };
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ...parseActionIdentity(value),
          kind: 'conflict',
          reason: value.reason as HostedLifecycleConflictReason,
          currentRevision:
            value.currentRevision === null ? null : parseRevision(value.currentRevision),
        }),
      });
    }
    if (value.kind === 'not_found') {
      if (!hasExactKeys(value, NOT_FOUND_KEYS)) return { ok: false };
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...parseActionIdentity(value), kind: 'not_found' }),
      });
    }
    if (value.kind === 'started' || value.kind === 'operator_required') {
      if (!hasExactKeys(value, DURABLE_STATUS_KEYS)) return { ok: false };
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...parseActionIdentity(value), kind: value.kind }),
      });
    }
    if (value.kind === 'unavailable') {
      if (!hasExactKeys(value, UNAVAILABLE_KEYS)) return { ok: false };
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
          kind: 'unavailable',
          retryAfterMs: parseRetryAfterMs(value.retryAfterMs),
        }),
      });
    }
    return Object.freeze({ ok: false });
  } catch {
    return Object.freeze({ ok: false });
  }
}
