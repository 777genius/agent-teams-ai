import { join } from 'node:path';

import {
  type CompositeRuntimePlanHash,
  parseLaneId,
} from '@features/team-runtime-control/contracts';
import {
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressPresentedSecret,
  parseRuntimeIngressSessionId,
  RUNTIME_INGRESS_VERBS,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressPresentedSecret,
  type RuntimeIngressVerb,
} from '@features/team-runtime-control/core/domain/runtime-ingress';
import { createRuntimeIngressFeature } from '@features/team-runtime-control/main/composition/createRuntimeIngressFeature';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';

import type { RuntimeIngressHttpRequest } from '@features/team-runtime-control/contracts/runtime-ingress-http';
import type { RuntimePlanRef } from '@features/team-runtime-control/core/application/ports';
import type {
  RuntimeIngressAntiRollbackCheckpoint,
  RuntimeIngressAntiRollbackFenceResult,
  RuntimeIngressCredentialGenerationFence,
  RuntimeIngressDurableAntiRollbackFencePort,
} from '@features/team-runtime-control/core/application/runtime-ingress';
import type { RuntimeIngressRateLimitPolicy } from '@features/team-runtime-control/main/adapters/input/runtime-ingress/RuntimeIngressRateLimiter';
import type { RuntimeIngressStoreKeyring } from '@features/team-runtime-control/main/adapters/output/runtime-ingress/FileRuntimeIngressDurableStore';
import type {
  ConsumeRuntimeIngressRelaySecretResult,
  RuntimeIngressRelaySecretSource,
} from '@features/team-runtime-control/main/adapters/output/runtime-ingress/InheritedFdRuntimeIngressSecretSource';
import type { RuntimeIngressProcessIdentityProbe } from '@features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressFileStoreIo';
import type { RuntimeIngressFeatureClock } from '@features/team-runtime-control/main/composition/createRuntimeIngressFeature';

export const ISSUED_AT = '2026-07-27T10:00:00.000Z';
export const BOOTSTRAP_OBSERVED_AT = '2026-07-27T10:00:30.000Z';
export const ACCEPTED_AT = '2026-07-27T10:01:00.000Z';
export const ROTATED_AT = '2026-07-27T10:02:00.000Z';
export const REVOKED_AT = '2026-07-27T10:03:00.000Z';

export const CREDENTIAL_ID = parseRuntimeIngressCredentialId('credential:fixture:lane:1');
export const NEXT_CREDENTIAL_ID = parseRuntimeIngressCredentialId('credential:fixture:lane:2');
export const SESSION_ID = parseRuntimeIngressSessionId('runtime-session:fixture:1');
export const NEXT_SESSION_ID = parseRuntimeIngressSessionId('runtime-session:fixture:2');
export const SECRET = parseRuntimeIngressPresentedSecret(`fixture.${'a'.repeat(64)}`);
export const NEXT_SECRET = parseRuntimeIngressPresentedSecret(`fixture.${'b'.repeat(64)}`);
export const DELIVERY_OWNER_ID = parseMemberId(`member_${'c'.repeat(32)}`);

export const SCOPE: RuntimeIngressCredentialScope = Object.freeze({
  deploymentId: parseDeploymentId('deployment_runtime-ingress-adapter-fixture'),
  teamId: parseTeamId(`team_${'a'.repeat(32)}`),
  runId: parseRunId(`run_${'b'.repeat(32)}`),
  planGeneration: 7,
  laneId: parseLaneId('lane:opencode:fixture'),
  providerId: 'opencode',
  credentialGeneration: 1,
  allowedVerbs: RUNTIME_INGRESS_VERBS,
});

export const PLAN_REF: RuntimePlanRef = Object.freeze({
  teamId: SCOPE.teamId,
  runId: SCOPE.runId,
  generation: SCOPE.planGeneration,
  planHash: `sha256:${'d'.repeat(64)}` as CompositeRuntimePlanHash,
});

export const KEYRING: RuntimeIngressStoreKeyring = Object.freeze({
  activeCredentialDigestKeyVersion: 1,
  credentialDigestKeys: Object.freeze([
    Object.freeze({ version: 1, key: new Uint8Array(32).fill(17) }),
  ]),
  activeFingerprintKeyVersion: 'runtime-ingress-fixture-fingerprint-v1',
  fingerprintKeys: Object.freeze([
    Object.freeze({
      version: 'runtime-ingress-fixture-fingerprint-v1',
      key: new Uint8Array(32).fill(29),
    }),
  ]),
});

export const PROCESS_INSTANCE_ID = `sha256:${'1'.repeat(64)}`;
export const REUSED_PROCESS_INSTANCE_ID = `sha256:${'2'.repeat(64)}`;

export class FixtureRuntimeIngressProcessIdentityProbe implements RuntimeIngressProcessIdentityProbe {
  private readonly liveInstances = new Map<number, string | null>();
  private afterNextIdentityRead:
    | { readonly pid: number; readonly callback: () => Promise<void> }
    | undefined;

  constructor(
    readonly currentPid = 1,
    currentInstanceId: string | null = PROCESS_INSTANCE_ID
  ) {
    this.liveInstances.set(currentPid, currentInstanceId);
  }

  setLive(pid: number, instanceId: string | null): void {
    this.liveInstances.set(pid, instanceId);
  }

  setDead(pid: number): void {
    this.liveInstances.delete(pid);
  }

  afterNextRead(pid: number, callback: () => Promise<void>): void {
    this.afterNextIdentityRead = { pid, callback };
  }

  isProcessAlive(pid: number): boolean {
    return this.liveInstances.has(pid);
  }

  async readProcessInstanceId(pid: number): Promise<string | null> {
    const result = this.liveInstances.get(pid) ?? null;
    const afterRead = this.afterNextIdentityRead;
    if (afterRead?.pid === pid) {
      this.afterNextIdentityRead = undefined;
      await afterRead.callback();
    }
    return result;
  }
}

export class FixedRuntimeIngressClock implements RuntimeIngressFeatureClock {
  constructor(private instant = ACCEPTED_AT) {}

  set(instant: string): void {
    this.instant = instant;
  }

  nowIso(): string {
    return this.instant;
  }

  nowEpochMs(): number {
    return Date.parse(this.instant);
  }
}

export class FixtureRelaySecretSource implements RuntimeIngressRelaySecretSource {
  consumeCount = 0;

  constructor(private readonly secret: RuntimeIngressPresentedSecret = SECRET) {}

  async consume(): Promise<ConsumeRuntimeIngressRelaySecretResult> {
    await Promise.resolve();
    this.consumeCount += 1;
    return this.consumeCount === 1
      ? { status: 'consumed', secret: this.secret }
      : { status: 'rejected' };
  }
}

export class InMemoryRuntimeIngressAntiRollbackFence implements RuntimeIngressDurableAntiRollbackFencePort {
  private snapshotGeneration = 0;
  private readonly lanes = new Map<string, RuntimeIngressCredentialGenerationFence>();
  private failNextNewGenerationAdvance = false;
  private afterNextNewGenerationAdvance: (() => Promise<void>) | undefined;
  validateCount = 0;
  advanceCount = 0;

  failNextSnapshotGenerationAdvance(): void {
    this.failNextNewGenerationAdvance = true;
  }

  afterNextSnapshotGenerationAdvance(callback: () => Promise<void>): void {
    this.afterNextNewGenerationAdvance = callback;
  }

  readCredentialGenerationFence(
    scope: RuntimeIngressCredentialScope
  ): RuntimeIngressCredentialGenerationFence | undefined {
    return this.lanes.get(fenceKey(scope));
  }

  async validate(
    checkpoint: RuntimeIngressAntiRollbackCheckpoint
  ): Promise<RuntimeIngressAntiRollbackFenceResult> {
    await Promise.resolve();
    this.validateCount += 1;
    if (checkpoint.snapshotGeneration < this.snapshotGeneration) return { status: 'rejected' };
    for (const candidate of checkpoint.credentialGenerationFences) {
      const previous = this.lanes.get(fenceKey(candidate));
      if (
        (previous && candidate.planHash !== previous.planHash) ||
        (previous && candidate.highestIssuedGeneration < previous.highestIssuedGeneration) ||
        (previous && candidate.revokedThroughGeneration < previous.revokedThroughGeneration) ||
        (previous &&
          candidate.activeGeneration !== null &&
          candidate.activeGeneration <= previous.revokedThroughGeneration)
      ) {
        return { status: 'rejected' };
      }
    }
    return { status: 'accepted' };
  }

  async advance(
    checkpoint: RuntimeIngressAntiRollbackCheckpoint
  ): Promise<RuntimeIngressAntiRollbackFenceResult> {
    this.advanceCount += 1;
    const advancesGeneration = checkpoint.snapshotGeneration > this.snapshotGeneration;
    if (this.failNextNewGenerationAdvance && advancesGeneration) {
      this.failNextNewGenerationAdvance = false;
      return { status: 'unavailable' };
    }
    const validation = await this.validate(checkpoint);
    if (validation.status !== 'accepted') return validation;
    this.snapshotGeneration = Math.max(this.snapshotGeneration, checkpoint.snapshotGeneration);
    for (const candidate of checkpoint.credentialGenerationFences) {
      const key = fenceKey(candidate);
      const previous = this.lanes.get(key);
      this.lanes.set(
        key,
        Object.freeze({
          ...candidate,
          highestIssuedGeneration: Math.max(
            previous?.highestIssuedGeneration ?? 0,
            candidate.highestIssuedGeneration
          ),
          revokedThroughGeneration: Math.max(
            previous?.revokedThroughGeneration ?? 0,
            candidate.revokedThroughGeneration
          ),
        })
      );
    }
    if (advancesGeneration && this.afterNextNewGenerationAdvance) {
      const callback = this.afterNextNewGenerationAdvance;
      this.afterNextNewGenerationAdvance = undefined;
      await callback();
    }
    return { status: 'accepted' };
  }
}

export interface FixtureRuntimeIngressStoreLimits {
  readonly maxSnapshotBytes?: number;
  readonly maxCredentials?: number;
  readonly maxSessions?: number;
  readonly maxCommands?: number;
  readonly maxEffects?: number;
  readonly maxCompactedCommands?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockRetryDelayMs?: number;
}

export interface FixtureRuntimeIngressRelayAuthority {
  readonly planRef: RuntimePlanRef;
  readonly deploymentId: RuntimeIngressCredentialScope['deploymentId'];
  readonly providerId: RuntimeIngressCredentialScope['providerId'];
  readonly laneId: RuntimeIngressCredentialScope['laneId'];
  readonly memberIds: readonly (typeof DELIVERY_OWNER_ID)[];
  readonly credentialGeneration: number;
  readonly allowedVerbs: readonly RuntimeIngressVerb[];
}

export class FixtureRuntimeIngressRelayAuthoritySource {
  resolveCount = 0;

  constructor(
    private readonly authority: FixtureRuntimeIngressRelayAuthority = Object.freeze({
      planRef: PLAN_REF,
      deploymentId: SCOPE.deploymentId,
      providerId: SCOPE.providerId,
      laneId: SCOPE.laneId,
      memberIds: Object.freeze([DELIVERY_OWNER_ID]),
      credentialGeneration: SCOPE.credentialGeneration,
      allowedVerbs: SCOPE.allowedVerbs,
    })
  ) {}

  async resolve(): Promise<
    | { readonly status: 'resolved'; readonly authority: FixtureRuntimeIngressRelayAuthority }
    | { readonly status: 'stale_plan' | 'unavailable' }
  > {
    await Promise.resolve();
    this.resolveCount += 1;
    return { status: 'resolved', authority: this.authority };
  }
}

export interface RuntimeIngressAdapterHarnessOptions {
  readonly allowedVerbs?: readonly RuntimeIngressVerb[];
  readonly bodyLimitBytes?: number;
  readonly rateLimitPolicy?: RuntimeIngressRateLimitPolicy;
  readonly secretSource?: FixtureRelaySecretSource;
  readonly relayAuthoritySource?: FixtureRuntimeIngressRelayAuthoritySource;
  readonly antiRollbackFence?: InMemoryRuntimeIngressAntiRollbackFence;
  readonly storeLimits?: FixtureRuntimeIngressStoreLimits;
}

export async function createRuntimeIngressAdapterHarness(
  fixtureDirectory: string,
  options: RuntimeIngressAdapterHarnessOptions = {}
) {
  const clock = new FixedRuntimeIngressClock();
  const secretSource = options.secretSource ?? new FixtureRelaySecretSource();
  const antiRollbackFence =
    options.antiRollbackFence ?? new InMemoryRuntimeIngressAntiRollbackFence();
  const scope = Object.freeze({
    ...SCOPE,
    allowedVerbs: options.allowedVerbs ?? SCOPE.allowedVerbs,
  });
  const relayAuthoritySource =
    options.relayAuthoritySource ??
    new FixtureRuntimeIngressRelayAuthoritySource({
      planRef: PLAN_REF,
      deploymentId: scope.deploymentId,
      providerId: scope.providerId,
      laneId: scope.laneId,
      memberIds: [DELIVERY_OWNER_ID],
      credentialGeneration: scope.credentialGeneration,
      allowedVerbs: scope.allowedVerbs,
    });
  let requestSequence = 0;
  const featureDependencies = {
    snapshotPath: join(fixtureDirectory, 'runtime-ingress-state.json'),
    keyring: KEYRING,
    antiRollbackFence,
    relaySecretSource: secretSource,
    relayAuthoritySource,
    clock,
    bodyLimitBytes: options.bodyLimitBytes,
    storeLimits: options.storeLimits,
    rateLimitPolicy: options.rateLimitPolicy,
    nextRequestId: () => `runtime-request:fixture:${++requestSequence}`,
    randomBytes: (size: number) => new Uint8Array(size).fill(requestSequence + 41),
  };
  const feature = createRuntimeIngressFeature(featureDependencies);
  const issued = await feature.store.issueCredential({
    credentialId: CREDENTIAL_ID,
    presentedSecret: SECRET,
    scope,
    planRef: PLAN_REF,
    sessionId: SESSION_ID,
    deliveryOwnerId: DELIVERY_OWNER_ID,
    issuedAtIso: ISSUED_AT,
  });
  if (issued.status !== 'issued' && issued.status !== 'already_issued') {
    throw new Error(`runtime-ingress-fixture-issue-failed:${issued.status}`);
  }
  return {
    feature,
    clock,
    secretSource,
    relayAuthoritySource,
    antiRollbackFence,
    scope,
    issued,
  };
}

export function runtimeIngressRotation(
  generation: number,
  previousCredentialId: ReturnType<typeof parseRuntimeIngressCredentialId>
) {
  const suffix = String(generation);
  return Object.freeze({
    previousCredentialId,
    credentialId: parseRuntimeIngressCredentialId(`credential:fixture:rotation:${suffix}`),
    presentedSecret: parseRuntimeIngressPresentedSecret(
      `fixture.${generation.toString(16).padStart(64, '0')}`
    ),
    scope: Object.freeze({ ...SCOPE, credentialGeneration: generation }),
    planRef: PLAN_REF,
    sessionId: parseRuntimeIngressSessionId(`runtime-session:fixture:rotation:${suffix}`),
    deliveryOwnerId: DELIVERY_OWNER_ID,
    issuedAtIso: new Date(Date.parse(ISSUED_AT) + generation * 1_000).toISOString(),
    revocationReason: 'repeated-byte-bound-rotation',
  });
}

export function runtimeIngressBody(
  payload: Readonly<Record<string, unknown>> = { state: 'ready' },
  commandId = 'command:fixture:bootstrap:1',
  sequence = 1,
  observedAtIso = BOOTSTRAP_OBSERVED_AT
): string {
  return JSON.stringify({
    runtimeInstanceId: 'runtime-instance:fixture:1',
    commandId,
    sequence,
    observedAtIso,
    payload,
  });
}

function fenceKey(
  fence: RuntimeIngressCredentialGenerationFence | RuntimeIngressCredentialScope
): string {
  return JSON.stringify([
    fence.deploymentId,
    fence.teamId,
    fence.runId,
    fence.planGeneration,
    fence.laneId,
    fence.providerId,
  ]);
}

export function runtimeIngressHttpRequest(
  body = runtimeIngressBody(),
  overrides: Partial<RuntimeIngressHttpRequest> = {}
): RuntimeIngressHttpRequest {
  return {
    runId: SCOPE.runId,
    verb: 'runtime.bootstrap-checkin',
    credentialIdHeader: CREDENTIAL_ID,
    authorizationHeader: `Bearer ${SECRET}`,
    contentTypeHeader: 'application/json',
    contentLengthHeader: String(new TextEncoder().encode(body).byteLength),
    rawBody: body,
    ...overrides,
  };
}
