import {
  createSafeAppError,
  type Cursor,
  parseCursor,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
  type Revision,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  type CanonicalListTeamLifecycleResult,
  type GetRuntimeStateProjectionRequest,
  type GetRuntimeStateProjectionResult,
  type GetTeamLifecycleSnapshotRequest,
  type GetTeamLifecycleSnapshotResult,
  type ListAliveTeamProjectionsRequest,
  type ListAliveTeamProjectionsResult,
  type ListTeamLifecycleInapplicable,
  type ListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleEntityInapplicable,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadFailureCode,
  type TeamLifecycleState,
} from '../../contracts/team-lifecycle-read';

import type { RuntimeStateProjectionReadPort } from '../../core/application/GetRuntimeStateProjection';
import type { TeamLifecycleSnapshotReadPort } from '../../core/application/GetTeamLifecycleSnapshot';
import type { AliveTeamProjectionsReadPort } from '../../core/application/ListAliveTeamProjections';
import type { TeamLifecycleReadSource } from '../../core/application/ListTeamLifecycle';

export type LegacyTeamReadAvailability =
  | 'current'
  | 'draft'
  | 'provisioning'
  | 'corrupt'
  | 'partial'
  | 'unavailable';

export interface LegacyTeamIdentityBinding {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly legacyTeamName: string;
  readonly displayName: string;
  readonly revision: Revision;
  readonly availability?: LegacyTeamReadAvailability;
}

export interface LegacyTeamBindingPage {
  readonly snapshotRevision: Revision;
  readonly bindings: readonly LegacyTeamIdentityBinding[];
  readonly nextCursor: Cursor | null;
}

export interface LegacyTeamIdentityReadPort {
  listTeamBindings(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ):
    | LegacyTeamBindingPage
    | TeamLifecycleReadFailure
    | ListTeamLifecycleInapplicable
    | Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure | ListTeamLifecycleInapplicable>;

  getTeamBinding(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ):
    | LegacyTeamIdentityBinding
    | TeamLifecycleReadFailure
    | TeamLifecycleEntityInapplicable
    | null
    | Promise<
        | LegacyTeamIdentityBinding
        | TeamLifecycleReadFailure
        | TeamLifecycleEntityInapplicable
        | null
      >;

  listAliveTeamBindings(
    legacyTeamNames: readonly string[],
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ):
    | LegacyTeamBindingPage
    | TeamLifecycleReadFailure
    | Promise<LegacyTeamBindingPage | TeamLifecycleReadFailure>;
}

export interface LegacyTeamDataReadPort {
  listTeams(context: QueryContext): unknown | Promise<unknown>;
  getTeamData(legacyTeamName: string, context: QueryContext): unknown | Promise<unknown>;
}

export interface LegacyTeamRuntimeReadPort {
  getRuntimeState(legacyTeamName: string, context: QueryContext): unknown | Promise<unknown>;
  getAliveTeams(context: QueryContext): unknown | Promise<unknown>;
}

/** Synchronous, side-effect-free admission policy evaluated before every legacy read. */
export interface LegacyTeamLifecycleReadPolicy {
  isAuthorized(context: QueryContext): boolean;
  nowMs(): number;
}

export interface LegacyTeamLifecycleReadSourceDependencies {
  readonly identities: LegacyTeamIdentityReadPort;
  readonly data: LegacyTeamDataReadPort;
  readonly runtime: LegacyTeamRuntimeReadPort;
  readonly policy: LegacyTeamLifecycleReadPolicy;
}

interface ParsedBinding {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly legacyTeamName: string;
  readonly displayName: string;
  readonly revision: Revision;
  readonly availability: LegacyTeamReadAvailability;
}

interface ParsedBindingPage {
  readonly snapshotRevision: Revision;
  readonly bindings: readonly ParsedBinding[];
  readonly nextCursor: Cursor | null;
}

const LEGACY_TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const WINDOWS_RESERVED_TEAM_NAMES = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const DISPLAY_NAME_PRIVATE_PATH = /^(?:\/|~\/|[A-Za-z]:\\)/;
const LEGACY_AVAILABILITIES = new Set<LegacyTeamReadAvailability>([
  'current',
  'draft',
  'provisioning',
  'corrupt',
  'partial',
  'unavailable',
]);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeLegacyTeamName(value: string): boolean {
  return LEGACY_TEAM_NAME.test(value) && !WINDOWS_RESERVED_TEAM_NAMES.has(value);
}

function hasDisplayNameControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function failure(
  code: TeamLifecycleReadFailureCode,
  reason: string,
  options: { readonly diagnosticId?: string; readonly retryAfterMs?: number } = {}
): TeamLifecycleReadFailure {
  const error = createSafeAppError({ code, reason, ...options });
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as TeamLifecycleReadFailure['error'],
    retryable: code === 'unavailable',
  });
}

function corruptSource(): TeamLifecycleReadFailure {
  return failure('internal', 'corrupt_source', {
    diagnosticId: 'team-lifecycle-legacy.corrupt-source',
  });
}

function partialSource(): TeamLifecycleReadFailure {
  return failure('unavailable', 'partial_source');
}

function unavailableSource(): TeamLifecycleReadFailure {
  return failure('unavailable', 'source_unavailable', { retryAfterMs: 1_000 });
}

function snapshotChanged(): TeamLifecycleReadFailure {
  return failure('conflict', 'snapshot_changed');
}

function forbidden(): TeamLifecycleReadFailure {
  return failure('forbidden', 'scope_not_authorized');
}

function cancelled(reason: 'request_cancelled' | 'deadline_exceeded'): TeamLifecycleReadFailure {
  return failure('cancelled', reason);
}

function policyFailure(): TeamLifecycleReadFailure {
  return failure('internal', 'policy_failure', {
    diagnosticId: 'team-lifecycle-legacy.policy-failure',
  });
}

function listProvisioning(): ListTeamLifecycleInapplicable {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'inapplicable',
    code: 'unsupported',
    reason: 'unknown_lifecycle_provisioning',
  });
}

function entityNotFound(): TeamLifecycleEntityInapplicable {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'inapplicable',
    code: 'not_applicable',
    reason: 'team_not_found',
  });
}

function entityProvisioning(): TeamLifecycleEntityInapplicable {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'inapplicable',
    code: 'unsupported',
    reason: 'unknown_lifecycle_provisioning',
  });
}

function isReadOutcome(
  value: unknown
): value is
  | TeamLifecycleReadFailure
  | ListTeamLifecycleInapplicable
  | TeamLifecycleEntityInapplicable {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  return kind === 'failure' || kind === 'inapplicable';
}

function parseDisplayName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    DISPLAY_NAME_PRIVATE_PATH.test(value) ||
    hasDisplayNameControlCharacter(value)
  ) {
    throw new TypeError();
  }
  return value;
}

function parseBinding(value: unknown): ParsedBinding {
  if (!isRecord(value)) throw new TypeError();
  const legacyTeamName = value.legacyTeamName;
  const availability = value.availability ?? 'current';
  if (
    typeof legacyTeamName !== 'string' ||
    !isSafeLegacyTeamName(legacyTeamName) ||
    !LEGACY_AVAILABILITIES.has(availability as LegacyTeamReadAvailability)
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
    legacyTeamName,
    displayName: parseDisplayName(value.displayName),
    revision: parseRevision(value.revision),
    availability: availability as LegacyTeamReadAvailability,
  });
}

function parseBindingPage(value: unknown): ParsedBindingPage {
  if (!isRecord(value)) throw new TypeError();
  const sourceBindings = value.bindings;
  if (!Array.isArray(sourceBindings)) throw new TypeError();
  const bindingCount = sourceBindings.length;
  if (bindingCount > 1_000) throw new TypeError();

  const bindings: ParsedBinding[] = [];
  bindings.length = bindingCount;
  const teamIds = new Set<TeamId>();
  const legacyNames = new Set<string>();
  for (let index = 0; index < bindingCount; index += 1) {
    if (!Object.hasOwn(sourceBindings, index)) throw new TypeError();
    const binding = parseBinding(sourceBindings[index]);
    if (teamIds.has(binding.teamId) || legacyNames.has(binding.legacyTeamName)) {
      throw new TypeError();
    }
    teamIds.add(binding.teamId);
    legacyNames.add(binding.legacyTeamName);
    Object.defineProperty(bindings, index, {
      configurable: true,
      enumerable: true,
      value: binding,
      writable: true,
    });
  }

  const nextCursorValue = value.nextCursor;
  return Object.freeze({
    snapshotRevision: parseRevision(value.snapshotRevision),
    bindings: Object.freeze(bindings),
    nextCursor: nextCursorValue === null ? null : parseCursor(nextCursorValue),
  });
}

function checkExpectedRevision(
  expectedRevision: Revision | null,
  actualRevision: Revision
): TeamLifecycleReadFailure | null {
  return expectedRevision !== null && expectedRevision !== actualRevision
    ? snapshotChanged()
    : null;
}

function availabilityFailure(
  availability: LegacyTeamReadAvailability
): TeamLifecycleReadFailure | null {
  if (availability === 'corrupt') return corruptSource();
  if (availability === 'partial') return partialSource();
  if (availability === 'unavailable') return unavailableSource();
  return null;
}

function parseLegacySummaries(value: unknown): ReadonlyMap<string, Record<PropertyKey, unknown>> {
  if (!Array.isArray(value)) throw new TypeError();
  const summaryCount = value.length;
  if (summaryCount > 2_000) throw new TypeError();
  const summaries = new Map<string, Record<PropertyKey, unknown>>();
  for (let index = 0; index < summaryCount; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError();
    const summary = value[index];
    if (!isRecord(summary) || typeof summary.teamName !== 'string') throw new TypeError();
    const legacyTeamName = summary.teamName;
    if (!isSafeLegacyTeamName(legacyTeamName) || summaries.has(legacyTeamName)) {
      throw new TypeError();
    }
    summaries.set(legacyTeamName, summary);
  }
  return summaries;
}

function listLifecycle(summary: Record<PropertyKey, unknown>): TeamLifecycleState {
  if (typeof summary.deletedAt === 'string') return 'deleted';
  if (summary.pendingCreate === true) return 'draft';
  if (summary.partialLaunchFailure === true) return 'degraded';
  return 'ready';
}

function snapshotLifecycle(value: unknown, legacyTeamName: string): TeamLifecycleState {
  if (!isRecord(value)) throw new TypeError();
  if (value.teamName !== legacyTeamName) throw new TypeError();
  const config = value.config;
  const warnings = value.warnings;
  const isAlive = value.isAlive;
  if (!isRecord(config)) throw new TypeError();
  if (typeof config.deletedAt === 'string') return 'deleted';
  if (Array.isArray(warnings) && warnings.length > 0) return 'degraded';
  if (isAlive === true) return 'running';
  return 'ready';
}

function parseRuntimeAlive(value: unknown, legacyTeamName: string): boolean {
  if (!isRecord(value)) throw new TypeError();
  const isAlive = value.isAlive;
  if (typeof isAlive !== 'boolean') throw new TypeError();
  if (value.teamName !== legacyTeamName) throw new TypeError();
  return isAlive;
}

function parseAliveLegacyNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError();
  const nameCount = value.length;
  if (nameCount > 1_000) throw new TypeError();
  const names: string[] = [];
  names.length = nameCount;
  const uniqueNames = new Set<string>();
  for (let index = 0; index < nameCount; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError();
    const name = value[index];
    if (typeof name !== 'string' || !isSafeLegacyTeamName(name) || uniqueNames.has(name)) {
      throw new TypeError();
    }
    uniqueNames.add(name);
    Object.defineProperty(names, index, {
      configurable: true,
      enumerable: true,
      value: name,
      writable: true,
    });
  }
  names.sort();
  return Object.freeze(names);
}

export class LegacyTeamLifecycleReadSource
  implements
    TeamLifecycleReadSource,
    TeamLifecycleSnapshotReadPort,
    RuntimeStateProjectionReadPort,
    AliveTeamProjectionsReadPort
{
  constructor(private readonly dependencies: LegacyTeamLifecycleReadSourceDependencies) {}

  private preflight(context: QueryContext): TeamLifecycleReadFailure | null {
    try {
      if (!this.dependencies.policy.isAuthorized(context)) return forbidden();
      if (context.signal.aborted) return cancelled('request_cancelled');
      const nowMs = this.dependencies.policy.nowMs();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return policyFailure();
      if (nowMs >= context.deadlineAtMs) return cancelled('deadline_exceeded');
      return null;
    } catch {
      return policyFailure();
    }
  }

  async listTeamLifecycle(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<CanonicalListTeamLifecycleResult> {
    const identityPreflight = this.preflight(context);
    if (identityPreflight) return identityPreflight;
    const pageValue = await this.dependencies.identities.listTeamBindings(request, context);
    if (isReadOutcome(pageValue)) {
      return pageValue as TeamLifecycleReadFailure | ListTeamLifecycleInapplicable;
    }

    let page: ParsedBindingPage;
    try {
      page = parseBindingPage(pageValue);
    } catch {
      return corruptSource();
    }
    const conflict = checkExpectedRevision(request.expectedRevision, page.snapshotRevision);
    if (conflict) return conflict;

    let summaryValue: unknown;
    try {
      const dataPreflight = this.preflight(context);
      if (dataPreflight) return dataPreflight;
      summaryValue = await this.dependencies.data.listTeams(context);
    } catch {
      return unavailableSource();
    }
    let summaries: ReadonlyMap<string, Record<PropertyKey, unknown>>;
    try {
      summaries = parseLegacySummaries(summaryValue);
    } catch {
      return corruptSource();
    }

    const items = [];
    for (const binding of page.bindings) {
      const availabilityOutcome = availabilityFailure(binding.availability);
      if (availabilityOutcome) return availabilityOutcome;
      if (binding.availability === 'provisioning') return listProvisioning();

      let lifecycle: TeamLifecycleState = 'draft';
      if (binding.availability !== 'draft') {
        const summary = summaries.get(binding.legacyTeamName);
        if (!summary) return partialSource();
        lifecycle = listLifecycle(summary);
      }
      items.push(
        Object.freeze({
          workspaceId: binding.workspaceId,
          teamId: binding.teamId,
          displayName: binding.displayName,
          lifecycle,
          revision: binding.revision,
        })
      );
    }

    return Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: page.snapshotRevision,
      items: Object.freeze(items),
      nextCursor: page.nextCursor,
    });
  }

  async getTeamLifecycleSnapshot(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult> {
    const identityPreflight = this.preflight(context);
    if (identityPreflight) return identityPreflight;
    const bindingValue = await this.dependencies.identities.getTeamBinding(request, context);
    if (bindingValue === null) return entityNotFound();
    if (isReadOutcome(bindingValue)) {
      return bindingValue as TeamLifecycleReadFailure | TeamLifecycleEntityInapplicable;
    }

    let binding: ParsedBinding;
    try {
      binding = parseBinding(bindingValue);
    } catch {
      return corruptSource();
    }
    if (binding.workspaceId !== request.workspaceId || binding.teamId !== request.teamId) {
      return corruptSource();
    }
    const conflict = checkExpectedRevision(request.expectedRevision, binding.revision);
    if (conflict) return conflict;
    const availabilityOutcome = availabilityFailure(binding.availability);
    if (availabilityOutcome) return availabilityOutcome;
    if (binding.availability === 'provisioning') return entityProvisioning();

    let lifecycle: TeamLifecycleState = 'draft';
    if (binding.availability !== 'draft') {
      let dataValue: unknown;
      try {
        const dataPreflight = this.preflight(context);
        if (dataPreflight) return dataPreflight;
        dataValue = await this.dependencies.data.getTeamData(binding.legacyTeamName, context);
      } catch {
        return unavailableSource();
      }
      try {
        lifecycle = snapshotLifecycle(dataValue, binding.legacyTeamName);
      } catch {
        return corruptSource();
      }
    }

    return Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: binding.revision,
      snapshot: Object.freeze({
        workspaceId: binding.workspaceId,
        teamId: binding.teamId,
        displayName: binding.displayName,
        lifecycle,
        revision: binding.revision,
      }),
    });
  }

  async getRuntimeStateProjection(
    request: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult> {
    const identityPreflight = this.preflight(context);
    if (identityPreflight) return identityPreflight;
    const bindingValue = await this.dependencies.identities.getTeamBinding(request, context);
    if (bindingValue === null) return entityNotFound();
    if (isReadOutcome(bindingValue)) {
      return bindingValue as TeamLifecycleReadFailure | TeamLifecycleEntityInapplicable;
    }

    let binding: ParsedBinding;
    try {
      binding = parseBinding(bindingValue);
    } catch {
      return corruptSource();
    }
    if (binding.workspaceId !== request.workspaceId || binding.teamId !== request.teamId) {
      return corruptSource();
    }
    const conflict = checkExpectedRevision(request.expectedRevision, binding.revision);
    if (conflict) return conflict;
    const availabilityOutcome = availabilityFailure(binding.availability);
    if (availabilityOutcome) return availabilityOutcome;
    if (binding.availability === 'provisioning') return entityProvisioning();

    let isAlive = false;
    if (binding.availability !== 'draft') {
      let runtimeValue: unknown;
      try {
        const runtimePreflight = this.preflight(context);
        if (runtimePreflight) return runtimePreflight;
        runtimeValue = await this.dependencies.runtime.getRuntimeState(
          binding.legacyTeamName,
          context
        );
      } catch {
        return unavailableSource();
      }
      try {
        isAlive = parseRuntimeAlive(runtimeValue, binding.legacyTeamName);
      } catch {
        return corruptSource();
      }
    }

    return Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: binding.revision,
      projection: Object.freeze({
        workspaceId: binding.workspaceId,
        teamId: binding.teamId,
        isAlive,
        revision: binding.revision,
      }),
    });
  }

  async listAliveTeamProjections(
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult> {
    const runtimePreflight = this.preflight(context);
    if (runtimePreflight) return runtimePreflight;
    let aliveValue: unknown;
    try {
      aliveValue = await this.dependencies.runtime.getAliveTeams(context);
    } catch {
      return unavailableSource();
    }
    let legacyTeamNames: readonly string[];
    try {
      legacyTeamNames = parseAliveLegacyNames(aliveValue);
    } catch {
      return corruptSource();
    }

    const identityPreflight = this.preflight(context);
    if (identityPreflight) return identityPreflight;
    const pageValue = await this.dependencies.identities.listAliveTeamBindings(
      legacyTeamNames,
      request,
      context
    );
    if (isReadOutcome(pageValue)) return pageValue as TeamLifecycleReadFailure;

    let page: ParsedBindingPage;
    try {
      page = parseBindingPage(pageValue);
    } catch {
      return corruptSource();
    }
    const conflict = checkExpectedRevision(request.expectedRevision, page.snapshotRevision);
    if (conflict) return conflict;
    const aliveNames = new Set(legacyTeamNames);
    const items = [];
    for (const binding of page.bindings) {
      if (binding.availability !== 'current' || !aliveNames.has(binding.legacyTeamName)) {
        return corruptSource();
      }
      items.push(
        Object.freeze({
          workspaceId: binding.workspaceId,
          teamId: binding.teamId,
          isAlive: true,
          revision: binding.revision,
        })
      );
    }

    return Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: page.snapshotRevision,
      items: Object.freeze(items),
      nextCursor: page.nextCursor,
    });
  }
}
