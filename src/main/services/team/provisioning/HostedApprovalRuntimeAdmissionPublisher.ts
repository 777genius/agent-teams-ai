import { createHash } from 'node:crypto';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';

import {
  descriptorAnchoredRead,
  descriptorAnchoredReplace,
  descriptorAnchoredUnlink,
  validateTrustedDirectoryCapability,
} from './HostedApprovalRuntimeDescriptorStorage';

import type { TrustedDirectoryCapability } from './HostedApprovalRuntimeDescriptorStorage';
import type { RuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import type { OrchestratorSocketIdentity } from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';

export const HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE = 'hosted-approval-runtime-admission.v1.json';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/u;
const CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/u;
const ADMISSION_GENERATION = /^approval-admission-generation_([1-9][0-9]*)_owner_([1-9][0-9]*)$/u;

export interface HostedApprovalRuntimeOuterAuthority {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly restoreGeneration: number;
  readonly mountBinding: Readonly<{ mountGeneration: number; declaredRootHash: string }>;
}

export interface HostedApprovalRuntimeScope {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly authorityGeneration: string;
  readonly restoreGeneration: number;
}

export interface HostedApprovalRuntimeRoute {
  readonly routeId: string;
  readonly authority: RuntimePermissionApprovalIngressAuthority;
  readonly scope: HostedApprovalRuntimeScope;
  readonly memberName: string;
  readonly openCodeBinding: Readonly<{
    toolApprovalMode: 'manual';
    planGeneration: number;
    credentialGeneration: number;
    credentialId: string;
    runtimeInstanceId: string;
    deliveryOwnerId: string;
    openCodeArtifactDigest: `sha256:${string}`;
    sessionRecordFingerprint: string;
    liveEffectFingerprint: string;
  }>;
}

export interface HostedApprovalRuntimeOwnerIdentity {
  readonly teamId: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly socketPath: string;
  readonly socketIdentity: OrchestratorSocketIdentity;
  readonly processIdentity: Readonly<{ pid: number; startIdentity: string }>;
}

export interface HostedApprovalRuntimeCapability {
  readonly schemaVersion: 2;
  readonly protocol: 'agent-teams-hosted-approval-v2';
  readonly authentication: 'opencode-basic';
  readonly runtimeInstanceId: string;
  readonly configGeneration: string;
}

export interface AuthoritativeHostedApprovalRuntimeBinding {
  readonly outerAuthority: HostedApprovalRuntimeOuterAuthority;
  readonly routes: readonly HostedApprovalRuntimeRoute[];
  readonly memberIdsByName: Readonly<Record<string, string>>;
  readonly actorMembers: Readonly<Record<string, string>>;
  readonly owner: HostedApprovalRuntimeOwnerIdentity;
  readonly capability: HostedApprovalRuntimeCapability;
}

/** A single-use, authoritative reread fence supplied by product composition. */
export interface AuthoritativeHostedApprovalRuntimeBindingLease {
  readonly token: string;
  readonly binding: AuthoritativeHostedApprovalRuntimeBinding;
  consume(): Promise<AuthoritativeHostedApprovalRuntimeBinding | null>;
}

export interface HostedApprovalRuntimeAdmissionState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly generationHighWater: number;
  readonly authoritativeFingerprint: string;
}

export interface HostedApprovalRuntimeAdmissionStateStore {
  load(teamId: string): Promise<HostedApprovalRuntimeAdmissionState | null>;
  compareAndSwap(
    teamId: string,
    expectedRevision: number | null,
    next: HostedApprovalRuntimeAdmissionState
  ): Promise<boolean>;
}

export type HostedApprovalRuntimeLifecycle = Readonly<
  | { state: 'provisioning'; ownerGeneration: number }
  | { state: 'restart_required'; ownerGeneration: number; approvalGeneration: number }
  | {
      state: 'active';
      ownerGeneration: number;
      approvalGeneration: number;
      approvalDigest: `sha256:${string}`;
    }
>;

export type HostedApprovalRuntimePublication = Readonly<
  | { state: 'revoked'; reason: string }
  | {
      state: 'restart_required';
      approvalGeneration: number;
      approvalDigest: `sha256:${string}`;
      admissionDocumentDigest: `sha256:${string}`;
    }
  | {
      state: 'active';
      approvalGeneration: number;
      approvalDigest: `sha256:${string}`;
      admissionDocumentDigest: `sha256:${string}`;
      ownerGeneration: number;
    }
>;

export interface HostedApprovalRuntimeAdmissionPublisherPorts {
  openTeamDirectory(teamName: string): Promise<TrustedDirectoryCapability>;
  acquireAuthoritativeBinding(
    teamName: string
  ): Promise<AuthoritativeHostedApprovalRuntimeBindingLease | null>;
  resolveExpectedOpenCodeArtifactDigest(teamName: string): Promise<`sha256:${string}` | null>;
  stateStore: HostedApprovalRuntimeAdmissionStateStore;
  /** Test-only adversarial interleaving, intentionally before the final authoritative reread. */
  beforeAuthoritativeReread?: () => Promise<void>;
}

interface CurrentPublication {
  readonly approvalGeneration: number;
  readonly publishedOwnerGeneration: number;
  readonly body: string;
  readonly approvalDigest: `sha256:${string}`;
  readonly admissionDocumentDigest: `sha256:${string}`;
}

export class HostedApprovalRuntimeAdmissionPublisher {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: HostedApprovalRuntimeAdmissionPublisherPorts) {}

  reconcile(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    return this.serialized(teamName, () => this.reconcileSerialized(teamName, lifecycle));
  }

  revoke(teamName: string, reason = 'stopped'): Promise<HostedApprovalRuntimePublication> {
    return this.serialized(teamName, async () => {
      const directory = await this.openDirectory(teamName);
      try {
        await descriptorAnchoredUnlink(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE);
      } finally {
        await directory.handle.close();
      }
      return Object.freeze({ state: 'revoked', reason });
    });
  }

  private async reconcileSerialized(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    let directory: TrustedDirectoryCapability | null = null;
    try {
      directory = await this.openDirectory(teamName);
      const lease = await this.ports.acquireAuthoritativeBinding(teamName);
      const artifactDigest = await this.ports.resolveExpectedOpenCodeArtifactDigest(teamName);
      if (
        !lease ||
        !IDENTIFIER.test(lease.token) ||
        !artifactDigest ||
        !SHA256.test(artifactDigest)
      ) {
        throw new TypeError('hosted-approval-runtime-authority-unavailable');
      }
      validateBinding(lease.binding, lifecycle.ownerGeneration, artifactDigest);
      if (lifecycle.state === 'active') {
        await this.ports.beforeAuthoritativeReread?.();
        const latest = await this.consumeLease(
          teamName,
          lease,
          lifecycle.ownerGeneration,
          artifactDigest
        );
        return await this.activate(directory, latest, lifecycle);
      }
      return await this.publish(directory, teamName, lease, lifecycle, artifactDigest);
    } catch (error) {
      if (directory) {
        await descriptorAnchoredUnlink(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE).catch(
          () => undefined
        );
      }
      return Object.freeze({
        state: 'revoked',
        reason: error instanceof Error ? error.message : 'hosted-approval-runtime-invalid',
      });
    } finally {
      await directory?.handle.close().catch(() => undefined);
    }
  }

  private async activate(
    directory: TrustedDirectoryCapability,
    binding: AuthoritativeHostedApprovalRuntimeBinding,
    lifecycle: Extract<HostedApprovalRuntimeLifecycle, { state: 'active' }>
  ): Promise<HostedApprovalRuntimePublication> {
    const current = await readCurrentPublication(directory);
    const state = await this.ports.stateStore.load(binding.outerAuthority.teamId);
    const fingerprint = fingerprintAuthoritativeBinding(binding);
    if (
      !current ||
      !state ||
      state.generationHighWater !== current.approvalGeneration ||
      state.authoritativeFingerprint !== fingerprint ||
      current.body !==
        canonicalAdmission(binding, current.approvalGeneration, current.publishedOwnerGeneration) ||
      lifecycle.approvalGeneration !== current.approvalGeneration ||
      lifecycle.approvalDigest !== current.approvalDigest ||
      lifecycle.ownerGeneration <= current.publishedOwnerGeneration
    ) {
      throw new Error('two-generation-admission-mismatch');
    }
    return Object.freeze({
      state: 'active',
      approvalGeneration: current.approvalGeneration,
      approvalDigest: current.approvalDigest,
      admissionDocumentDigest: current.admissionDocumentDigest,
      ownerGeneration: lifecycle.ownerGeneration,
    });
  }

  private async publish(
    directory: TrustedDirectoryCapability,
    teamName: string,
    lease: AuthoritativeHostedApprovalRuntimeBindingLease,
    lifecycle: Exclude<HostedApprovalRuntimeLifecycle, { state: 'active' }>,
    artifactDigest: `sha256:${string}`
  ): Promise<HostedApprovalRuntimePublication> {
    const fingerprint = fingerprintAuthoritativeBinding(lease.binding);
    const current = await readCurrentPublication(directory).catch(() => null);
    const state = await this.ports.stateStore.load(lease.binding.outerAuthority.teamId);
    if (
      current &&
      state &&
      state.generationHighWater === current.approvalGeneration &&
      state.authoritativeFingerprint === fingerprint &&
      lifecycle.ownerGeneration === current.publishedOwnerGeneration &&
      current.body ===
        canonicalAdmission(
          lease.binding,
          current.approvalGeneration,
          current.publishedOwnerGeneration
        )
    ) {
      if (
        lifecycle.state === 'restart_required' &&
        lifecycle.approvalGeneration !== current.approvalGeneration
      ) {
        throw new Error('two-generation-admission-mismatch');
      }
      await this.ports.beforeAuthoritativeReread?.();
      await this.consumeLease(teamName, lease, lifecycle.ownerGeneration, artifactDigest);
      return restartRequired(current);
    }

    const reserved = await this.reserveGeneration(lease.binding.outerAuthority.teamId, fingerprint);
    const body = canonicalAdmission(
      lease.binding,
      reserved.generationHighWater,
      lifecycle.ownerGeneration
    );
    await descriptorAnchoredReplace(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE, body, {
      beforeRename: async () => {
        await this.ports.beforeAuthoritativeReread?.();
        const [latestBinding, latestState] = await Promise.all([
          this.consumeLease(teamName, lease, lifecycle.ownerGeneration, artifactDigest),
          this.ports.stateStore.load(lease.binding.outerAuthority.teamId),
        ]);
        if (
          !latestState ||
          latestState.revision !== reserved.revision ||
          latestState.generationHighWater !== reserved.generationHighWater
        ) {
          throw new Error('hosted-approval-runtime-authority-drift');
        }
        if (fingerprintAuthoritativeBinding(latestBinding) !== fingerprint) {
          throw new Error('hosted-approval-runtime-authority-drift');
        }
      },
    });
    const published = await readCurrentPublication(directory);
    if (!published || published.body !== body) {
      throw new Error('hosted-approval-runtime-publication-invalid');
    }
    return restartRequired(published);
  }

  private async reserveGeneration(
    teamId: string,
    fingerprint: string
  ): Promise<HostedApprovalRuntimeAdmissionState> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.ports.stateStore.load(teamId);
      const next = Object.freeze({
        schemaVersion: 1 as const,
        revision: (current?.revision ?? 0) + 1,
        generationHighWater: (current?.generationHighWater ?? 0) + 1,
        authoritativeFingerprint: fingerprint,
      });
      if (await this.ports.stateStore.compareAndSwap(teamId, current?.revision ?? null, next)) {
        return next;
      }
    }
    throw new Error('hosted-approval-runtime-state-conflict');
  }

  private async consumeLease(
    teamName: string,
    lease: AuthoritativeHostedApprovalRuntimeBindingLease,
    ownerGeneration: number,
    artifactDigest: `sha256:${string}`
  ): Promise<AuthoritativeHostedApprovalRuntimeBinding> {
    const [latestBinding, latestArtifactDigest] = await Promise.all([
      lease.consume(),
      this.ports.resolveExpectedOpenCodeArtifactDigest(teamName),
    ]);
    if (!latestBinding || latestArtifactDigest !== artifactDigest) {
      throw new Error('hosted-approval-runtime-authority-drift');
    }
    validateBinding(latestBinding, ownerGeneration, artifactDigest);
    if (
      fingerprintAuthoritativeBinding(latestBinding) !==
      fingerprintAuthoritativeBinding(lease.binding)
    ) {
      throw new Error('hosted-approval-runtime-authority-drift');
    }
    return latestBinding;
  }

  private async openDirectory(teamName: string): Promise<TrustedDirectoryCapability> {
    if (!teamName.trim()) throw new TypeError('hosted-approval-runtime-team-invalid');
    const capability = await this.ports.openTeamDirectory(teamName);
    await validateTrustedDirectoryCapability(capability);
    return capability;
  }

  private serialized<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(teamName) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(teamName, next);
    const cleanup = () => {
      if (this.queues.get(teamName) === next) this.queues.delete(teamName);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

function restartRequired(current: CurrentPublication): HostedApprovalRuntimePublication {
  return Object.freeze({
    state: 'restart_required',
    approvalGeneration: current.approvalGeneration,
    approvalDigest: current.approvalDigest,
    admissionDocumentDigest: current.admissionDocumentDigest,
  });
}

export function buildHostedApprovalAuthoritySnapshot(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  approvalGeneration: number
): Readonly<{
  schemaVersion: 1;
  approvalGeneration: number;
  authorities: readonly RuntimePermissionApprovalIngressAuthority[];
}> {
  return Object.freeze({
    schemaVersion: 1,
    approvalGeneration,
    authorities: Object.freeze(
      [...binding.routes]
        .toSorted((left, right) => compareCanonical(left.routeId, right.routeId))
        .map((route) => parseRuntimePermissionApprovalIngressAuthority(route.authority))
    ),
  });
}

export function digestHostedApprovalAuthoritySnapshot(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  approvalGeneration: number
): `sha256:${string}` {
  return digestBytes(
    JSON.stringify(buildHostedApprovalAuthoritySnapshot(binding, approvalGeneration))
  );
}

function fingerprintAuthoritativeBinding(
  binding: AuthoritativeHostedApprovalRuntimeBinding
): string {
  const owner = { ...binding.owner, ownerGeneration: 0 };
  const memberIdsByName = Object.fromEntries(
    Object.entries(binding.memberIdsByName).toSorted(([left], [right]) =>
      compareCanonical(left, right)
    )
  );
  const canonical = JSON.stringify({
    admission: JSON.parse(canonicalAdmission(binding, 1, 1)),
    memberIdsByName,
    owner,
    capability: binding.capability,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function validateBinding(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  ownerGeneration: number,
  expectedArtifactDigest: string
): void {
  const { outerAuthority: outer, owner, capability } = binding;
  if (
    !exactKeys(binding, [
      'outerAuthority',
      'routes',
      'memberIdsByName',
      'actorMembers',
      'owner',
      'capability',
    ]) ||
    !exactKeys(outer, [
      'deploymentId',
      'bootId',
      'workspaceId',
      'teamId',
      'restoreGeneration',
      'mountBinding',
    ]) ||
    !exactKeys(outer.mountBinding, ['mountGeneration', 'declaredRootHash']) ||
    !exactKeys(owner, [
      'teamId',
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketPath',
      'socketIdentity',
      'processIdentity',
    ]) ||
    !exactKeys(owner.socketIdentity, ['device', 'inode', 'uid', 'gid', 'mode']) ||
    !exactKeys(owner.processIdentity, ['pid', 'startIdentity']) ||
    !exactKeys(capability, [
      'schemaVersion',
      'protocol',
      'authentication',
      'runtimeInstanceId',
      'configGeneration',
    ]) ||
    !IDENTIFIER.test(outer.deploymentId) ||
    !IDENTIFIER.test(outer.bootId) ||
    !IDENTIFIER.test(outer.workspaceId) ||
    !TEAM_ID.test(outer.teamId) ||
    !nonNegative(outer.restoreGeneration) ||
    !positive(outer.mountBinding.mountGeneration) ||
    !HEX_SHA256.test(outer.mountBinding.declaredRootHash) ||
    owner.teamId !== outer.teamId ||
    !OWNER_AUTHORITY.test(owner.ownerAuthority) ||
    !OWNER_SESSION.test(owner.ownerSessionId) ||
    owner.ownerGeneration !== ownerGeneration ||
    !owner.socketPath.startsWith('/') ||
    owner.socketPath.includes('\0') ||
    !socketIdentityValid(owner.socketIdentity) ||
    !positive(owner.processIdentity.pid) ||
    !IDENTIFIER.test(owner.processIdentity.startIdentity) ||
    capability.schemaVersion !== 2 ||
    capability.protocol !== 'agent-teams-hosted-approval-v2' ||
    capability.authentication !== 'opencode-basic' ||
    !RUNTIME_INSTANCE.test(capability.runtimeInstanceId) ||
    !CONFIG_GENERATION.test(capability.configGeneration) ||
    !Array.isArray(binding.routes) ||
    binding.routes.length === 0 ||
    binding.routes.length > 256
  ) {
    throw new TypeError('hosted-approval-runtime-binding-invalid');
  }
  validateRosterProjection(binding);
  const routeIds = new Set<string>();
  const sessions = new Set<string>();
  for (const route of binding.routes) {
    const authority = parseRuntimePermissionApprovalIngressAuthority(route.authority);
    const openCode = route.openCodeBinding;
    if (
      !exactKeys(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding']) ||
      !exactKeys(route.scope, [
        'principalId',
        'workspaceId',
        'teamId',
        'authorityGeneration',
        'restoreGeneration',
      ]) ||
      !exactKeys(openCode, [
        'toolApprovalMode',
        'planGeneration',
        'credentialGeneration',
        'credentialId',
        'runtimeInstanceId',
        'deliveryOwnerId',
        'openCodeArtifactDigest',
        'sessionRecordFingerprint',
        'liveEffectFingerprint',
      ]) ||
      !IDENTIFIER.test(route.routeId) ||
      !IDENTIFIER.test(route.memberName) ||
      routeIds.has(route.routeId) ||
      sessions.has(authority.sessionId) ||
      authority.deploymentId !== outer.deploymentId ||
      authority.teamId !== outer.teamId ||
      authority.providerId !== 'opencode' ||
      route.scope.workspaceId !== outer.workspaceId ||
      route.scope.teamId !== outer.teamId ||
      route.scope.restoreGeneration !== outer.restoreGeneration ||
      !ACTOR_ID.test(route.scope.principalId) ||
      !GENERATION.test(route.scope.authorityGeneration) ||
      binding.actorMembers[route.scope.principalId] !== authority.deliveryOwnerId ||
      binding.memberIdsByName[route.memberName] !== authority.deliveryOwnerId ||
      openCode.toolApprovalMode !== 'manual' ||
      openCode.planGeneration !== authority.planGeneration ||
      openCode.credentialGeneration !== authority.credentialGeneration ||
      openCode.credentialId !== authority.credentialId ||
      openCode.runtimeInstanceId !== authority.runtimeInstanceId ||
      openCode.runtimeInstanceId !== capability.runtimeInstanceId ||
      openCode.deliveryOwnerId !== authority.deliveryOwnerId ||
      openCode.openCodeArtifactDigest !== expectedArtifactDigest ||
      !HEX_SHA256.test(openCode.sessionRecordFingerprint) ||
      !HEX_SHA256.test(openCode.liveEffectFingerprint)
    ) {
      throw new TypeError('hosted-approval-runtime-route-invalid');
    }
    routeIds.add(route.routeId);
    sessions.add(authority.sessionId);
  }
}

function validateRosterProjection(binding: AuthoritativeHostedApprovalRuntimeBinding): void {
  const actors = Object.entries(binding.actorMembers);
  const members = Object.entries(binding.memberIdsByName);
  const actorValues = actors.map(([, memberId]) => memberId).toSorted();
  const memberValues = members.map(([, memberId]) => memberId).toSorted();
  if (
    actors.length === 0 ||
    actors.length !== members.length ||
    actors.some(([actorId, memberId]) => !ACTOR_ID.test(actorId) || !MEMBER_ID.test(memberId)) ||
    members.some(
      ([memberName, memberId]) => !IDENTIFIER.test(memberName) || !MEMBER_ID.test(memberId)
    ) ||
    new Set(actorValues).size !== actorValues.length ||
    new Set(memberValues).size !== memberValues.length ||
    actorValues.some((memberId, index) => memberId !== memberValues[index])
  ) {
    throw new TypeError('hosted-approval-runtime-actor-mapping-invalid');
  }
}

function canonicalAdmission(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  approvalGeneration: number,
  ownerGeneration: number
): string {
  const actorMembers = Object.fromEntries(
    Object.entries(binding.actorMembers).toSorted(([left], [right]) =>
      compareCanonical(left, right)
    )
  );
  const routes = [...binding.routes]
    .toSorted((left, right) => compareCanonical(left.routeId, right.routeId))
    .map((route) => ({
      routeId: route.routeId,
      authority: parseRuntimePermissionApprovalIngressAuthority(route.authority),
      scope: {
        principalId: route.scope.principalId,
        workspaceId: route.scope.workspaceId,
        teamId: route.scope.teamId,
        authorityGeneration: route.scope.authorityGeneration,
        restoreGeneration: route.scope.restoreGeneration,
      },
      memberName: route.memberName,
      openCodeBinding: {
        toolApprovalMode: route.openCodeBinding.toolApprovalMode,
        planGeneration: route.openCodeBinding.planGeneration,
        credentialGeneration: route.openCodeBinding.credentialGeneration,
        credentialId: route.openCodeBinding.credentialId,
        runtimeInstanceId: route.openCodeBinding.runtimeInstanceId,
        deliveryOwnerId: route.openCodeBinding.deliveryOwnerId,
        openCodeArtifactDigest: route.openCodeBinding.openCodeArtifactDigest,
        sessionRecordFingerprint: route.openCodeBinding.sessionRecordFingerprint,
        liveEffectFingerprint: route.openCodeBinding.liveEffectFingerprint,
      },
    }));
  return `${JSON.stringify({
    schemaVersion: 1,
    admissionGeneration: `approval-admission-generation_${approvalGeneration}_owner_${ownerGeneration}`,
    outerAuthority: {
      deploymentId: binding.outerAuthority.deploymentId,
      bootId: binding.outerAuthority.bootId,
      workspaceId: binding.outerAuthority.workspaceId,
      teamId: binding.outerAuthority.teamId,
      restoreGeneration: binding.outerAuthority.restoreGeneration,
      mountBinding: {
        mountGeneration: binding.outerAuthority.mountBinding.mountGeneration,
        declaredRootHash: binding.outerAuthority.mountBinding.declaredRootHash,
      },
    },
    routes,
    actorMembers,
  })}\n`;
}

async function readCurrentPublication(
  directory: TrustedDirectoryCapability
): Promise<CurrentPublication | null> {
  const body = await descriptorAnchoredRead(directory, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE);
  if (body === null) return null;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (
    !exactKeys(parsed, [
      'schemaVersion',
      'admissionGeneration',
      'outerAuthority',
      'routes',
      'actorMembers',
    ])
  ) {
    throw new TypeError('hosted-approval-runtime-publication-invalid');
  }
  const match =
    typeof parsed.admissionGeneration === 'string'
      ? ADMISSION_GENERATION.exec(parsed.admissionGeneration)
      : null;
  if (!match || `${JSON.stringify(parsed)}\n` !== body || !Array.isArray(parsed.routes)) {
    throw new TypeError('hosted-approval-runtime-publication-invalid');
  }
  const approvalGeneration = Number(match[1]);
  const authorities = parsed.routes.map((route) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError('hosted-approval-runtime-publication-invalid');
    }
    return parseRuntimePermissionApprovalIngressAuthority(
      (route as Record<string, unknown>).authority
    );
  });
  const snapshot = Object.freeze({ schemaVersion: 1 as const, approvalGeneration, authorities });
  return Object.freeze({
    approvalGeneration,
    publishedOwnerGeneration: Number(match[2]),
    body,
    approvalDigest: digestBytes(JSON.stringify(snapshot)),
    admissionDocumentDigest: digestBytes(body),
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function digestBytes(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function socketIdentityValid(identity: OrchestratorSocketIdentity): boolean {
  return (
    typeof identity.device === 'string' &&
    /^\d{1,32}$/u.test(identity.device) &&
    typeof identity.inode === 'string' &&
    /^\d{1,32}$/u.test(identity.inode) &&
    nonNegative(identity.uid) &&
    nonNegative(identity.gid) &&
    nonNegative(identity.mode) &&
    identity.mode <= 0o777
  );
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
