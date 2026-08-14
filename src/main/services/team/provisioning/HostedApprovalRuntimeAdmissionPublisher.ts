import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

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
  readonly mountBinding: Readonly<{
    mountGeneration: number;
    declaredRootHash: string;
  }>;
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

/** Identity checked by trusted provisioning but deliberately absent from the consumer's exact schema. */
export interface HostedApprovalRuntimeOwnerIdentity {
  readonly teamId: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly socketPath: string;
  readonly socketIdentity: OrchestratorSocketIdentity;
  readonly processIdentity: Readonly<{
    pid: number;
    startIdentity: string;
  }>;
}

export interface HostedApprovalRuntimeCapability {
  readonly schemaVersion: 2;
  readonly protocol: 'agent-teams-hosted-approval-v2';
  readonly authentication: 'opencode-basic';
  readonly runtimeInstanceId: string;
  readonly configGeneration: string;
}

/** A projection returned only after all listed records have been authoritatively re-read. */
export interface AuthoritativeHostedApprovalRuntimeBinding {
  readonly outerAuthority: HostedApprovalRuntimeOuterAuthority;
  readonly routes: readonly HostedApprovalRuntimeRoute[];
  /** Exact roster projection used to bind human member names to immutable MemberIds. */
  readonly memberIdsByName: Readonly<Record<string, string>>;
  readonly actorMembers: Readonly<Record<string, string>>;
  readonly owner: HostedApprovalRuntimeOwnerIdentity;
  readonly capability: HostedApprovalRuntimeCapability;
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
    }
  | {
      state: 'active';
      approvalGeneration: number;
      approvalDigest: `sha256:${string}`;
      ownerGeneration: number;
    }
>;

export interface HostedApprovalRuntimeAdmissionPublisherPorts {
  /** Resolves the canonical private path for this immutable team partition. */
  resolveAdmissionPath(teamName: string): string;
  /** Returns null on any session/member/owner/process/capability uncertainty or drift. */
  resolveAuthoritativeBinding(
    teamName: string
  ): Promise<AuthoritativeHostedApprovalRuntimeBinding | null>;
  /** Returns the digest from the verified installed-runtime manifest, never a mutable version. */
  resolveExpectedOpenCodeArtifactDigest(teamName: string): Promise<`sha256:${string}` | null>;
  /** Test-only crash barrier after temp-file fsync and before atomic rename. */
  beforeCommit?: () => Promise<void>;
}

interface CurrentPublication {
  readonly approvalGeneration: number;
  readonly publishedOwnerGeneration: number;
  readonly body: string;
  readonly digest: `sha256:${string}`;
}

/**
 * Sole trusted writer for the per-team approval admission. Production composition remains opt-in:
 * constructing this publisher does not mount approval routes or enable any team.
 */
export class HostedApprovalRuntimeAdmissionPublisher {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeBindingFingerprints = new Map<string, string>();

  constructor(private readonly ports: HostedApprovalRuntimeAdmissionPublisherPorts) {}

  reconcile(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    return this.serialized(teamName, () => this.reconcileSerialized(teamName, lifecycle));
  }

  revoke(teamName: string, reason = 'stopped'): Promise<HostedApprovalRuntimePublication> {
    return this.serialized(teamName, async () => {
      await revokeAdmission(this.admissionPath(teamName));
      this.activeBindingFingerprints.delete(teamName);
      return Object.freeze({ state: 'revoked', reason });
    });
  }

  private async reconcileSerialized(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    const admissionPath = this.admissionPath(teamName);
    try {
      const [binding, expectedArtifactDigest] = await Promise.all([
        this.ports.resolveAuthoritativeBinding(teamName),
        this.ports.resolveExpectedOpenCodeArtifactDigest(teamName),
      ]);
      if (!binding || !expectedArtifactDigest || !SHA256.test(expectedArtifactDigest)) {
        throw new TypeError('hosted-approval-runtime-authority-unavailable');
      }
      validateBinding(binding, lifecycle, expectedArtifactDigest);
      const bindingFingerprint = fingerprintAuthoritativeBinding(binding);
      const activeBindingDrift =
        lifecycle.state === 'active' &&
        this.activeBindingFingerprints.has(teamName) &&
        this.activeBindingFingerprints.get(teamName) !== bindingFingerprint;
      const current = await readCurrentPublication(admissionPath);
      const nextGeneration = current ? current.approvalGeneration : 1;
      let candidate = canonicalAdmission(
        binding,
        nextGeneration,
        current?.publishedOwnerGeneration ?? lifecycle.ownerGeneration
      );
      if (current && current.body !== candidate) {
        candidate = canonicalAdmission(
          binding,
          current.approvalGeneration + 1,
          lifecycle.ownerGeneration
        );
      }
      if (current && activeBindingDrift && current.body === candidate) {
        candidate = canonicalAdmission(
          binding,
          current.approvalGeneration + 1,
          lifecycle.ownerGeneration
        );
      }
      const changed = current?.body !== candidate;
      if (changed) {
        await atomicWriteAsync(admissionPath, candidate, {
          mode: 0o600,
          durability: 'strict',
          syncDirectory: true,
          beforeCommit: async () => {
            const [latestBinding, latestArtifactDigest] = await Promise.all([
              this.ports.resolveAuthoritativeBinding(teamName),
              this.ports.resolveExpectedOpenCodeArtifactDigest(teamName),
            ]);
            if (!latestBinding || latestArtifactDigest !== expectedArtifactDigest) {
              throw new Error('hosted-approval-runtime-authority-drift');
            }
            validateBinding(latestBinding, lifecycle, expectedArtifactDigest);
            if (fingerprintAuthoritativeBinding(latestBinding) !== bindingFingerprint) {
              throw new Error('hosted-approval-runtime-authority-drift');
            }
            await this.ports.beforeCommit?.();
          },
        });
      }
      const publication = changed
        ? publicationFromBody(candidate)
        : (current as CurrentPublication);
      if (lifecycle.state !== 'active' || changed) {
        this.activeBindingFingerprints.delete(teamName);
        return Object.freeze({
          state: 'restart_required',
          approvalGeneration: publication.approvalGeneration,
          approvalDigest: publication.digest,
        });
      }
      if (
        changed ||
        lifecycle.approvalGeneration !== publication.approvalGeneration ||
        lifecycle.approvalDigest !== publication.digest ||
        lifecycle.ownerGeneration <= publication.publishedOwnerGeneration
      ) {
        if (!changed) await revokeAdmission(admissionPath);
        this.activeBindingFingerprints.delete(teamName);
        return Object.freeze({ state: 'revoked', reason: 'two-generation-admission-mismatch' });
      }
      this.activeBindingFingerprints.set(teamName, bindingFingerprint);
      return Object.freeze({
        state: 'active',
        approvalGeneration: publication.approvalGeneration,
        approvalDigest: publication.digest,
        ownerGeneration: lifecycle.ownerGeneration,
      });
    } catch (error) {
      await revokeAdmission(admissionPath);
      this.activeBindingFingerprints.delete(teamName);
      return Object.freeze({
        state: 'revoked',
        reason: error instanceof Error ? error.message : 'hosted-approval-runtime-invalid',
      });
    }
  }

  private admissionPath(teamName: string): string {
    if (!teamName.trim()) throw new TypeError('hosted-approval-runtime-team-invalid');
    const admissionPath = this.ports.resolveAdmissionPath(teamName);
    if (
      !isAbsolute(admissionPath) ||
      admissionPath.includes('\0') ||
      normalize(admissionPath) !== admissionPath ||
      resolve(admissionPath) !== admissionPath ||
      basename(admissionPath) !== HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE
    ) {
      throw new TypeError('hosted-approval-runtime-path-invalid');
    }
    return admissionPath;
  }

  private serialized<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(teamName) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(teamName, next);
    void next.finally(() => {
      if (this.queues.get(teamName) === next) this.queues.delete(teamName);
    });
    return next;
  }
}

function fingerprintAuthoritativeBinding(
  binding: AuthoritativeHostedApprovalRuntimeBinding
): string {
  const canonical = JSON.stringify({
    admission: JSON.parse(canonicalAdmission(binding, 1, 1)) as unknown,
    memberIdsByName: binding.memberIdsByName,
    owner: binding.owner,
    capability: binding.capability,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function validateBinding(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  lifecycle: HostedApprovalRuntimeLifecycle,
  expectedArtifactDigest: string
): void {
  const { outerAuthority: outer, owner, capability } = binding;
  if (
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
    owner.ownerGeneration !== lifecycle.ownerGeneration ||
    !isAbsolute(owner.socketPath) ||
    resolve(owner.socketPath) !== owner.socketPath ||
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
  const actors = Object.entries(binding.actorMembers);
  const members = Object.entries(binding.memberIdsByName);
  if (
    actors.length === 0 ||
    actors.some(([actorId, memberId]) => !ACTOR_ID.test(actorId) || !MEMBER_ID.test(memberId)) ||
    members.length === 0 ||
    members.some(
      ([memberName, memberId]) => !IDENTIFIER.test(memberName) || !MEMBER_ID.test(memberId)
    ) ||
    new Set(members.map(([, memberId]) => memberId)).size !== members.length
  ) {
    throw new TypeError('hosted-approval-runtime-actor-mapping-invalid');
  }
  const routeIds = new Set<string>();
  const sessions = new Set<string>();
  for (const route of binding.routes) {
    const authority = parseRuntimePermissionApprovalIngressAuthority(route.authority);
    const openCode = route.openCodeBinding;
    if (
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
      authority: {
        deploymentId: route.authority.deploymentId,
        teamId: route.authority.teamId,
        runId: route.authority.runId,
        planGeneration: route.authority.planGeneration,
        laneId: route.authority.laneId,
        providerId: route.authority.providerId,
        credentialGeneration: route.authority.credentialGeneration,
        credentialId: route.authority.credentialId,
        sessionId: route.authority.sessionId,
        runtimeInstanceId: route.authority.runtimeInstanceId,
        deliveryOwnerId: route.authority.deliveryOwnerId,
      },
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

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readCurrentPublication(path: string): Promise<CurrentPublication | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return null;
    const body = await readFile(path, 'utf8');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const match =
      typeof parsed.admissionGeneration === 'string'
        ? ADMISSION_GENERATION.exec(parsed.admissionGeneration)
        : null;
    if (!match || canonicalExistingAdmission(parsed) !== body) return null;
    return Object.freeze({
      approvalGeneration: Number(match[1]),
      publishedOwnerGeneration: Number(match[2]),
      body,
      digest: digestBody(body),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function canonicalExistingAdmission(parsed: Record<string, unknown>): string {
  return `${JSON.stringify(parsed)}\n`;
}

function publicationFromBody(body: string): CurrentPublication {
  const parsed = JSON.parse(body) as { admissionGeneration: string };
  const match = ADMISSION_GENERATION.exec(parsed.admissionGeneration);
  if (!match) throw new TypeError('hosted-approval-runtime-generation-invalid');
  return Object.freeze({
    approvalGeneration: Number(match[1]),
    publishedOwnerGeneration: Number(match[2]),
    body,
    digest: digestBody(body),
  });
}

function digestBody(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

async function revokeAdmission(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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
