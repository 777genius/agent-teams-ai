import {
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
} from '@features/runtime-instance-context';
import { type LegacyTeamRuntimeReadPort } from '@features/team-lifecycle/main';
import { WorkspaceMountBinding } from '@features/workspace-registry';
import { parseTeamId, type QueryContext, type TeamId } from '@shared/contracts/hosted';

const MAX_RUNTIME_EVIDENCE_TEAMS = 1_000;

export class Phase2RuntimeEvidenceUnavailableError extends Error {
  readonly name = 'Phase2RuntimeEvidenceUnavailableError';
  readonly code = 'phase2_runtime_evidence_unavailable';

  constructor() {
    super('phase2-read-runtime-evidence-unavailable');
  }
}

export interface Phase2RuntimeEvidenceScope {
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly deploymentId: string;
  readonly bootId: string;
}

export interface Phase2RuntimeIdentityEvidence {
  readonly teamId: TeamId;
  readonly legacyTeamName: string;
  readonly directoryFingerprint: string;
}

export interface Phase2AuthoritativeRuntimeEvidenceSource {
  readRuntimeState(input: {
    readonly scope: Phase2RuntimeEvidenceScope;
    readonly identity: Phase2RuntimeIdentityEvidence;
    readonly context: QueryContext;
  }):
    | { readonly teamId: TeamId; readonly isAlive: boolean }
    | Promise<{ readonly teamId: TeamId; readonly isAlive: boolean }>;
  listAliveTeamIds(input: {
    readonly scope: Phase2RuntimeEvidenceScope;
    readonly identities: readonly Phase2RuntimeIdentityEvidence[];
    readonly context: QueryContext;
  }): readonly TeamId[] | Promise<readonly TeamId[]>;
}

export interface MountBindingScopedRuntimeEvidencePortInput {
  readonly mountBinding: WorkspaceMountBinding;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly identitiesForCurrentSnapshot: () => readonly TeamIdentityRecord[];
  readonly nowMs: () => number;
  /** Omit unless a host-owned, mount-scoped authoritative runtime reader is available. */
  readonly source?: Phase2AuthoritativeRuntimeEvidenceSource;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function assertActive(context: QueryContext, nowMs: () => number): void {
  if (context.signal.aborted) throw new Error('phase2-read-request-cancelled');
  const now = nowMs();
  if (!Number.isSafeInteger(now) || now < 0 || now >= context.deadlineAtMs) {
    throw new Error('phase2-read-request-expired');
  }
}

async function activePortIo<TResult>(
  context: QueryContext,
  nowMs: () => number,
  operation: () => TResult | Promise<TResult>
): Promise<TResult> {
  assertActive(context, nowMs);
  try {
    const value = await operation();
    assertActive(context, nowMs);
    return value;
  } catch (error) {
    assertActive(context, nowMs);
    throw error;
  }
}

function identityEvidence(identityValue: TeamIdentityRecord): Phase2RuntimeIdentityEvidence {
  const identity = parseTeamIdentityRecord(identityValue);
  return Object.freeze({
    teamId: identity.teamId,
    legacyTeamName: identity.legacyKey,
    directoryFingerprint: identity.directoryFingerprint,
  });
}

class MountBindingScopedRuntimeEvidencePort implements LegacyTeamRuntimeReadPort {
  readonly #scope: Phase2RuntimeEvidenceScope;

  constructor(private readonly input: MountBindingScopedRuntimeEvidencePortInput) {
    const runtimeInstance = createRuntimeInstanceContext(input.runtimeInstance);
    if (
      !(input.mountBinding instanceof WorkspaceMountBinding) ||
      input.mountBinding.health === 'unavailable' ||
      input.mountBinding.bootId !== runtimeInstance.bootId ||
      typeof input.identitiesForCurrentSnapshot !== 'function' ||
      typeof input.nowMs !== 'function'
    ) {
      throw new TypeError('phase2-read-runtime-scope-invalid');
    }
    this.#scope = Object.freeze({
      workspaceId: input.mountBinding.workspaceId,
      mountGeneration: input.mountBinding.mountGeneration,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
    });
  }

  async getRuntimeState(legacyTeamName: string, context: QueryContext): Promise<unknown> {
    const identity = this.currentIdentities().find(
      (candidate) => candidate.legacyTeamName === legacyTeamName
    );
    if (!identity) throw new Error('phase2-read-team-outside-mount-binding');
    const source = this.input.source;
    if (!source) {
      assertActive(context, this.input.nowMs);
      throw new Phase2RuntimeEvidenceUnavailableError();
    }

    const value = await activePortIo(context, this.input.nowMs, () =>
      source.readRuntimeState({ scope: this.#scope, identity, context })
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !exactKeys(value, ['teamId', 'isAlive']) ||
      parseTeamId(value.teamId) !== identity.teamId ||
      typeof value.isAlive !== 'boolean'
    ) {
      throw new TypeError('phase2-read-runtime-evidence-invalid');
    }
    return Object.freeze({ teamName: legacyTeamName, isAlive: value.isAlive });
  }

  async getAliveTeams(context: QueryContext): Promise<unknown> {
    const identities = this.currentIdentities(true);
    const source = this.input.source;
    if (!source) {
      assertActive(context, this.input.nowMs);
      throw new Phase2RuntimeEvidenceUnavailableError();
    }

    const values = await activePortIo(context, this.input.nowMs, () =>
      source.listAliveTeamIds({ scope: this.#scope, identities, context })
    );
    if (!Array.isArray(values) || values.length > MAX_RUNTIME_EVIDENCE_TEAMS) {
      throw new TypeError('phase2-read-runtime-evidence-invalid');
    }
    const namesByTeamId = new Map(identities.map((identity) => [identity.teamId, identity]));
    const seen = new Set<TeamId>();
    const names: string[] = [];
    for (let index = 0; index < values.length; index += 1) {
      if (!Object.hasOwn(values, index)) {
        throw new TypeError('phase2-read-runtime-evidence-invalid');
      }
      const teamId = parseTeamId(values[index]);
      const identity = namesByTeamId.get(teamId);
      if (!identity || seen.has(teamId)) {
        throw new TypeError('phase2-read-runtime-evidence-invalid');
      }
      seen.add(teamId);
      names.push(identity.legacyTeamName);
    }
    names.sort();
    return Object.freeze(names);
  }

  private currentIdentities(activeOnly = false): readonly Phase2RuntimeIdentityEvidence[] {
    const identities = this.input.identitiesForCurrentSnapshot();
    if (!Array.isArray(identities) || identities.length > MAX_RUNTIME_EVIDENCE_TEAMS) {
      throw new TypeError('phase2-read-runtime-identity-snapshot-invalid');
    }
    const parsed = identities.map((identity) => parseTeamIdentityRecord(identity));
    return Object.freeze(
      (activeOnly ? parsed.filter((identity) => identity.state === 'active') : parsed).map(
        identityEvidence
      )
    );
  }
}

/**
 * Adapts explicit host-owned evidence to the legacy runtime port without ambient runtime discovery.
 * With no authoritative source the port throws a typed unavailable error; it never invents false
 * state or an empty alive set.
 */
export function createMountBindingScopedRuntimeEvidencePort(
  input: MountBindingScopedRuntimeEvidencePortInput
): LegacyTeamRuntimeReadPort {
  return new MountBindingScopedRuntimeEvidencePort(input);
}
