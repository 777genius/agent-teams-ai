import {
  type AuthorityDeploymentId,
  type HostedAccessAuthorityPolicy,
  type HostedAuthMode,
  parseAuthKeyringId,
  parseAuthorityDeploymentId,
  parseAuthorityKeyMaterial,
} from '../../contracts';
import {
  type AuthKeyringEnvelope,
  HostedAccessAuthority,
  type HostedAccessAuthorityDependencies,
  type HostedAuthenticatedPrincipal,
  type HostedAuthHostPlatform,
  type HostedAuthLocalControlTransportFactory,
  HostedIdentityService,
  HostedLocalAdministration,
  HostedOidcAuthenticationProvider,
  HostedPersonalAuthenticationProvider,
  type HostedTeamWorkspaceAttribution,
  HostedWorkspaceAccessService,
  type OidcAuthenticationCapability,
  type OidcIdentityProvider,
  type PairingDrainProofPort,
  type PersonalAuthenticationCapability,
} from '../../core/application';
import {
  createInitialAuthorityState,
  freezeAuthorityState,
  type HostedAccessAuthorityState,
  type HostedHttpAuthorization,
} from '../../core/domain';
import { HostedAuthHttpController } from '../adapters/input/http/HostedAuthHttpController';
import { HostedAuthLocalControlServer } from '../adapters/input/local/HostedAuthLocalControlServer';
import { InternalStorageHostedAccessRepository } from '../adapters/output/InternalStorageHostedAccessRepository';
import {
  GenericOidcIdentityProvider,
  type GenericOidcRoleMapping,
  validateGenericOidcRoleMapping,
} from '../infrastructure/GenericOidcIdentityProvider';
import {
  NodeHostedIdentityCrypto,
  prepareHostedAuthSecretPaths,
  readProtectedHostedAuthSecret,
} from '../infrastructure/NodeHostedIdentityCrypto';
import {
  FileAuthKeyring,
  FileHostedPairingDrainProof,
  FilePairingChallengeDelivery,
  NodePersonalAuthorityCrypto,
} from '../infrastructure/NodePersonalAuthorityAdapters';

import { createHostedAuthenticatedHttpFacade } from './createHostedAuthenticatedHttpFacade';

import type {
  HostedAuditEvent,
  HostedAuthConfiguration,
  HostedAuthModeResetResult,
} from '../../core/application/identityPorts';
import type { HostedAuthStorageGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MINIMUM_OIDC_SESSION_IDLE_MS = MINUTE;
const MAXIMUM_OIDC_SESSION_IDLE_MS = 60 * MINUTE;
const MINIMUM_OIDC_SESSION_ABSOLUTE_MS = 5 * MINUTE;
const MAXIMUM_OIDC_SESSION_ABSOLUTE_MS = DAY;

export async function authorizeHostedTeamConfigurationScope(
  dependencies: Readonly<{
    authentication: Pick<
      HostedAuthHttpController,
      'authenticatedPrincipalFor' | 'isHostedQueryAuthorized' | 'isHostedTaskMutationAuthorized'
    >;
    resolvePublicGrant: HostedWorkspaceAccessService['resolvePublicGrant'];
    resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  }>,
  request: object,
  scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
  mutation: boolean
): Promise<'authorized' | 'denied' | 'unavailable'> {
  const admitted = mutation
    ? await dependencies.authentication.isHostedTaskMutationAuthorized(request)
    : await dependencies.authentication.isHostedQueryAuthorized(request);
  const authenticated = dependencies.authentication.authenticatedPrincipalFor(request);
  if (!admitted || authenticated === null) return 'denied';
  try {
    const attribution =
      scope.teamId === undefined
        ? undefined
        : await dependencies.resolveTeamWorkspaceId?.(scope.teamId);
    if (scope.teamId !== undefined && attribution === undefined) return 'unavailable';
    if (attribution?.kind === 'unavailable') return 'unavailable';
    const grant = await dependencies.resolvePublicGrant(
      authenticated.principal.userId,
      scope.workspaceId
    );
    if (grant === null) return 'denied';
    return attribution === undefined ||
      attribution.kind === 'not_found' ||
      attribution.runtimeWorkspaceId === grant.runtimeWorkspaceId
      ? 'authorized'
      : 'denied';
  } catch {
    return 'unavailable';
  }
}

export const HOSTED_PERSONAL_POLICY: HostedAccessAuthorityPolicy = Object.freeze({
  pairingChallengeTtlMs: 10 * MINUTE,
  pairingMaxAttempts: 8,
  deviceIdleTtlMs: 30 * DAY,
  deviceAbsoluteTtlMs: 90 * DAY,
  deviceRenewalTtlMs: 30 * DAY,
  sessionIdleTtlMs: 15 * MINUTE,
  sessionAbsoluteTtlMs: 60 * MINUTE,
  sessionRenewalTtlMs: 15 * MINUTE,
  predecessorGraceMs: 30_000,
  predecessorMaxUses: 1,
  retainedDeviceGenerations: 3,
  compareAndSwapAttempts: 8,
});

export type HostedAccessEnvironment = Readonly<Record<string, string | undefined>>;

export interface CreateHostedAccessFeatureDependencies {
  readonly environment: HostedAccessEnvironment;
  readonly storage: HostedAuthStorageGateway;
  readonly dataDirectory: string;
  readonly hostPlatform: HostedAuthHostPlatform;
  readonly localControlTransportFactory: HostedAuthLocalControlTransportFactory;
  readonly drainProof?: PairingDrainProofPort;
  readonly noRuntimeMutationAtStartup?: true;
  readonly runWithBrowserStreamsDrained: <Value>(operation: () => Promise<Value>) => Promise<Value>;
  readonly authorizationPolicy?: (method: string, url: string) => HostedHttpAuthorization;
  readonly isLifecycleOwnerReady?: () => boolean;
  readonly isTaskBoardMutationRouteEnabled?: () => boolean;
  readonly isTeamMessageSendRouteEnabled?: () => boolean;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  /** Injected immutable process identity; auth never reads paths, PIDs, credentials, or tokens. */
  readonly runtimeInstance?: Pick<RuntimeInstanceContext, 'deploymentId' | 'bootId'> | null;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HostedAuthHttpFacade {
  readonly allowedOrigin: string;
  register(app: unknown): void;
  isWorkspaceRegistered(workspaceId: string): Promise<boolean>;
  projectWorkspaceId(request: unknown, runtimeWorkspaceId: string): Promise<string | null>;
  projectPayload(request: unknown, payload: unknown): Promise<unknown>;
  isEventStreamAuthorized(request: unknown): Promise<boolean>;
  projectEvent(request: unknown, channel: string, data: unknown): Promise<unknown | null>;
}

export interface HostedAuthenticatedHttpFacade extends HostedAuthHttpFacade {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  resolveGrantedRuntimeWorkspaceId(
    request: object,
    publicWorkspaceId: string
  ): Promise<string | null>;
  projectGrantedPublicWorkspaceId(
    request: object,
    runtimeWorkspaceId: string
  ): Promise<string | null>;
  isHostedQueryAuthorized(request: unknown): Promise<boolean>;
  isHostedTaskMutationAuthorized(request: unknown, teamId: TeamId): Promise<boolean>;
  isTeamWorkspaceAuthorized(request: unknown, teamId: TeamId): Promise<boolean>;
  isTeamWorkspaceEventAuthorized(
    request: unknown,
    teamId: TeamId,
    runtimeWorkspaceId: string
  ): Promise<boolean>;
  captureTeamWorkspaceGrantFence(
    request: unknown,
    teamId: TeamId,
    permission: 'hosted.query' | 'hosted.command'
  ): Promise<Readonly<{
    ownerEffectFence: Readonly<{
      grantRevision: string;
      identityChecksum: string;
    }>;
    revalidate(): Promise<boolean>;
  }> | null>;
  isTeamConfigurationScopeAuthorized(
    request: unknown,
    scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
    mutation: boolean
  ): Promise<'authorized' | 'denied' | 'unavailable'>;
}

export interface HostedAuthLocalControlHandle {
  close(): Promise<void>;
}

export interface HostedAccessFeature {
  readonly deploymentId: AuthorityDeploymentId;
  readonly restoreGeneration: number;
  readonly mode: HostedAuthMode;
  readonly http: HostedAuthenticatedHttpFacade;
  readonly localAdministration: HostedLocalAdministration;
  startLocalControl(socketPath: string): Promise<HostedAuthLocalControlHandle>;
}

interface HostedPublicAccessGate {
  tryEnter(): boolean;
  leave(): void;
  blockAndDrain(): Promise<void>;
  restore(): void;
  isActive(): boolean;
}

function createHostedPublicAccessGate(): HostedPublicAccessGate {
  let active = true;
  let admittedRequests = 0;
  const drainedWaiters = new Set<() => void>();
  const resolveDrained = (): void => {
    if (admittedRequests !== 0) return;
    for (const resolve of drainedWaiters) resolve();
    drainedWaiters.clear();
  };
  return Object.freeze({
    tryEnter: () => {
      if (!active) return false;
      admittedRequests += 1;
      return true;
    },
    leave: () => {
      if (admittedRequests <= 0) throw new Error('hosted_public_access_gate_unbalanced');
      admittedRequests -= 1;
      resolveDrained();
    },
    blockAndDrain: async () => {
      active = false;
      if (admittedRequests === 0) return;
      await new Promise<void>((resolve) => drainedWaiters.add(resolve));
    },
    restore: () => {
      active = true;
    },
    isActive: () => active,
  });
}

function resetAuthorityState(
  current: HostedAccessAuthorityState | null,
  binding: Parameters<typeof createInitialAuthorityState>[0]['binding'],
  keyringId: ReturnType<typeof parseAuthKeyringId>,
  resetGeneration: number
): HostedAccessAuthorityState {
  const initial = createInitialAuthorityState({ binding, keyringId });
  return freezeAuthorityState({
    ...initial,
    revision: current === null ? 0 : current.revision + 1,
    consumedResetGeneration: resetGeneration,
    operatorId: current?.operatorId ?? null,
  });
}

function pathIsAtOrWithin(
  candidate: string,
  directory: string,
  platform: HostedAuthHostPlatform
): boolean {
  let current = platform.join(candidate);
  const boundary = platform.join(directory);
  for (;;) {
    if (current === boundary) return true;
    const parent = platform.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function required(environment: HostedAccessEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`hosted_auth_config_missing:${name}`);
  return value;
}

function integer(environment: HostedAccessEnvironment, name: string, fallback: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return parsed;
}

function requiredNonNegativeInteger(environment: HostedAccessEnvironment, name: string): number {
  const value = required(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return parsed;
}

function boundedInteger(
  environment: HostedAccessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = integer(environment, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`hosted_auth_config_invalid:${name}`);
  }
  return value;
}

function oidcSessionPolicy(environment: HostedAccessEnvironment): {
  readonly sessionIdleTtlMs: number;
  readonly sessionAbsoluteTtlMs: number;
} {
  const sessionIdleTtlMs = boundedInteger(
    environment,
    'AUTH_SESSION_IDLE_MS',
    15 * MINUTE,
    MINIMUM_OIDC_SESSION_IDLE_MS,
    MAXIMUM_OIDC_SESSION_IDLE_MS
  );
  const sessionAbsoluteTtlMs = boundedInteger(
    environment,
    'AUTH_SESSION_ABSOLUTE_MS',
    8 * 60 * MINUTE,
    MINIMUM_OIDC_SESSION_ABSOLUTE_MS,
    MAXIMUM_OIDC_SESSION_ABSOLUTE_MS
  );
  if (sessionIdleTtlMs > sessionAbsoluteTtlMs) {
    throw new Error('hosted_auth_config_invalid:AUTH_SESSION_IDLE_MS');
  }
  return Object.freeze({ sessionIdleTtlMs, sessionAbsoluteTtlMs });
}

function csv(value: string | undefined): readonly string[] {
  return Object.freeze(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function authMode(environment: HostedAccessEnvironment): HostedAuthMode {
  const mode = required(environment, 'AUTH_MODE');
  if (mode !== 'personal' && mode !== 'oidc') {
    throw new Error('hosted_auth_config_invalid:AUTH_MODE');
  }
  return mode;
}

function roleMapping(environment: HostedAccessEnvironment): GenericOidcRoleMapping {
  const defaultRole = environment.OIDC_DEFAULT_ROLE ?? 'viewer';
  if (!['admin', 'member', 'viewer'].includes(defaultRole)) {
    throw new Error('hosted_auth_config_invalid:OIDC_DEFAULT_ROLE');
  }
  try {
    return validateGenericOidcRoleMapping({
      claimPath: environment.OIDC_ROLE_CLAIM ?? 'realm_access.roles',
      owner: csv(environment.OIDC_OWNER_ROLE_VALUES),
      admin: csv(environment.OIDC_ADMIN_ROLE_VALUES),
      member: csv(environment.OIDC_MEMBER_ROLE_VALUES),
      viewer: csv(environment.OIDC_VIEWER_ROLE_VALUES),
      defaultRole: defaultRole as 'admin' | 'member' | 'viewer',
    });
  } catch (error) {
    throw new Error(
      `hosted_auth_config_invalid:${error instanceof Error ? error.message : 'OIDC_ROLE_MAPPING'}`,
      { cause: error }
    );
  }
}

async function clientSecret(
  environment: HostedAccessEnvironment,
  platform: HostedAuthHostPlatform
): Promise<string | undefined> {
  if (environment.OIDC_CLIENT_SECRET !== undefined) {
    throw new Error('hosted_auth_config_forbidden:OIDC_CLIENT_SECRET');
  }
  if (environment.OIDC_CLIENT_SECRET_FILE) {
    return readProtectedHostedAuthSecret(environment.OIDC_CLIENT_SECRET_FILE, platform);
  }
  return undefined;
}

export async function createHostedAccessFeature(
  dependencies: CreateHostedAccessFeatureDependencies
): Promise<HostedAccessFeature> {
  const { environment } = dependencies;
  const mode = authMode(environment);
  const now = dependencies.now ?? Date.now;
  const oidcPolicy = mode === 'oidc' ? oidcSessionPolicy(environment) : null;
  const oidcRoleMapping = mode === 'oidc' ? roleMapping(environment) : null;
  if (mode === 'oidc' && environment.OIDC_CLIENT_SECRET !== undefined) {
    throw new Error('hosted_auth_config_forbidden:OIDC_CLIENT_SECRET');
  }
  const publicOrigin = required(environment, 'AUTH_PUBLIC_ORIGIN').replace(/\/$/, '');
  const parsedOrigin = new URL(publicOrigin);
  const allowInsecure =
    environment.NODE_ENV === 'test' && environment.AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS === '1';
  if (
    (parsedOrigin.protocol !== 'https:' && !allowInsecure) ||
    parsedOrigin.origin !== publicOrigin ||
    parsedOrigin.username !== '' ||
    parsedOrigin.password !== '' ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search !== '' ||
    parsedOrigin.hash !== ''
  ) {
    throw new Error('hosted_auth_config_invalid:AUTH_PUBLIC_ORIGIN');
  }
  if (environment.HOSTED_HTTPS_PORT !== undefined) {
    const hostedHttpsPort = boundedInteger(environment, 'HOSTED_HTTPS_PORT', 443, 1, 65_535);
    const publicOriginPort =
      parsedOrigin.port === ''
        ? parsedOrigin.protocol === 'https:'
          ? 443
          : 80
        : Number(parsedOrigin.port);
    if (publicOriginPort !== hostedHttpsPort) {
      throw new Error('hosted_auth_config_invalid:HOSTED_HTTPS_PORT');
    }
  }

  const binding = Object.freeze({
    deploymentId: parseAuthorityDeploymentId(required(environment, 'AUTH_DEPLOYMENT_ID')),
    restoreGeneration: requiredNonNegativeInteger(environment, 'AUTH_RESTORE_GENERATION'),
  });
  if (
    dependencies.runtimeInstance !== undefined &&
    dependencies.runtimeInstance !== null &&
    String(dependencies.runtimeInstance.deploymentId) !== String(binding.deploymentId)
  ) {
    throw new Error('hosted_auth_runtime_deployment_mismatch');
  }
  const pairingCodePath = environment.PAIRING_CODE_FILE ?? '/run/agent-teams/pairing.json';
  const secretPaths = await prepareHostedAuthSecretPaths(
    {
      dataDirectory: dependencies.dataDirectory,
      ...(environment.AUTH_IDENTITY_KEY_FILE === undefined
        ? {}
        : { identityKeyPath: environment.AUTH_IDENTITY_KEY_FILE }),
    },
    dependencies.hostPlatform
  );
  const personalKeyringPath = dependencies.hostPlatform.join(
    environment.AUTH_KEYRING_FILE ?? secretPaths.personalKeyringPath
  );
  if (
    !dependencies.hostPlatform.isAbsolute(personalKeyringPath) ||
    personalKeyringPath === dependencies.hostPlatform.join(secretPaths.identityKeyPath) ||
    pathIsAtOrWithin(
      personalKeyringPath,
      secretPaths.stagedKeyringDirectory,
      dependencies.hostPlatform
    )
  ) {
    throw new Error('hosted_auth_config_invalid:AUTH_KEYRING_FILE');
  }
  const identityCrypto = new NodeHostedIdentityCrypto(
    secretPaths.identityKeyPath,
    dependencies.hostPlatform
  );
  const personalCrypto = new NodePersonalAuthorityCrypto(dependencies.hostPlatform);
  const keyrings = new FileAuthKeyring(
    personalKeyringPath,
    secretPaths.stagedKeyringDirectory,
    dependencies.hostPlatform
  );
  const configuredDrainProof =
    dependencies.drainProof ??
    new FileHostedPairingDrainProof(
      environment.AUTH_DRAIN_EVIDENCE_FILE ?? '/run/agent-teams/drain-proof.json',
      { noRuntimeMutationAtStartup: dependencies.noRuntimeMutationAtStartup === true, now },
      dependencies.hostPlatform
    );
  const repository = new InternalStorageHostedAccessRepository(
    dependencies.storage,
    HOSTED_PERSONAL_POLICY
  );
  if (!(await repository.claimAuthMode(mode, now()))) {
    throw new Error('hosted_auth_mode_change_requires_host_reset');
  }
  let authConfiguration = await repository.readAuthConfiguration();
  if (authConfiguration === null || authConfiguration.mode !== mode) {
    throw new Error('hosted_auth_configuration_unavailable');
  }
  if (
    authConfiguration.secretsRotatedGeneration > authConfiguration.resetGeneration ||
    (authConfiguration.secretsRotatedGeneration === authConfiguration.resetGeneration &&
      authConfiguration.pendingPersonalKeyringId !== null) ||
    (authConfiguration.secretsRotatedGeneration < authConfiguration.resetGeneration &&
      authConfiguration.pendingPersonalKeyringId === null)
  ) {
    throw new Error('hosted_auth_mode_reset_recovery_invalid');
  }
  if (authConfiguration.secretsRotatedGeneration < authConfiguration.resetGeneration) {
    const pendingPersonalKeyringId = authConfiguration.pendingPersonalKeyringId!;
    const activated = await keyrings.activateStaged(pendingPersonalKeyringId);
    if (activated.status !== 'activated' && activated.status !== 'already_applied') {
      throw new Error('hosted_auth_mode_reset_recovery_failed');
    }
    try {
      await dependencies.hostPlatform.remove(pairingCodePath, { force: true });
      await dependencies.hostPlatform.remove(secretPaths.identityKeyPath, { force: true });
      await dependencies.hostPlatform.remove(secretPaths.stagedKeyringDirectory, {
        force: true,
        recursive: true,
      });
      await dependencies.hostPlatform.mkdir(secretPaths.stagedKeyringDirectory, 0o700);
      await identityCrypto.initialize();
    } catch {
      throw new Error('hosted_auth_mode_reset_recovery_failed');
    }
    if (
      !(await repository.markAuthSecretsRotated({
        mode,
        resetGeneration: authConfiguration.resetGeneration,
        pendingPersonalKeyringId,
      }))
    ) {
      throw new Error('hosted_auth_mode_reset_recovery_conflict');
    }
    authConfiguration = Object.freeze({
      ...authConfiguration,
      secretsRotatedGeneration: authConfiguration.resetGeneration,
      pendingPersonalKeyringId: null,
    });
  }

  let oidcIdentityProvider: OidcIdentityProvider | null = null;
  if (mode === 'oidc') {
    oidcIdentityProvider = new GenericOidcIdentityProvider({
      id: environment.OIDC_PROVIDER_ID ?? 'oidc',
      displayName: environment.OIDC_PROVIDER_NAME ?? 'Single sign-on',
      issuer: required(environment, 'OIDC_ISSUER'),
      clientId: required(environment, 'OIDC_CLIENT_ID'),
      clientSecret: await clientSecret(environment, dependencies.hostPlatform),
      redirectUri: `${publicOrigin}/api/auth/oidc/callback`,
      scopes: csv(environment.OIDC_SCOPES).length
        ? csv(environment.OIDC_SCOPES)
        : ['openid', 'profile', 'email'],
      roleMapping: oidcRoleMapping!,
      crypto: dependencies.hostPlatform,
      fetch: dependencies.fetch,
      now,
      allowInsecureHttpForTests: allowInsecure,
    });
  }

  const identities = new HostedIdentityService({
    repository,
    crypto: identityCrypto,
    provider: oidcIdentityProvider,
    now,
    policy: {
      oidcLoginTtlMs: 10 * MINUTE,
      sessionIdleTtlMs: oidcPolicy?.sessionIdleTtlMs ?? 15 * MINUTE,
      sessionAbsoluteTtlMs: oidcPolicy?.sessionAbsoluteTtlMs ?? 8 * 60 * MINUTE,
      restoreGeneration: binding.restoreGeneration,
    },
  });

  let authority: HostedAccessAuthority | null = null;
  if (mode === 'personal') {
    if (dependencies.drainProof === undefined && !dependencies.noRuntimeMutationAtStartup) {
      throw new Error('hosted_personal_drain_proof_required');
    }
    const authorityDrainProof: PairingDrainProofPort = Object.freeze({
      confirmDrained: (input: Parameters<PairingDrainProofPort['confirmDrained']>[0]) =>
        input.purpose === 'initial_pairing' &&
        authConfiguration.resetGeneration > 0 &&
        input.resetGeneration === authConfiguration.resetGeneration
          ? configuredDrainProof.confirmDrained({
              ...input,
              purpose: 'auth_mode_reset',
              targetAuthMode: 'personal',
            })
          : configuredDrainProof.confirmDrained(input),
    });
    const authorityDependencies: HostedAccessAuthorityDependencies = {
      repository,
      random: personalCrypto,
      crypto: personalCrypto,
      keyrings,
      challengeDelivery: new FilePairingChallengeDelivery(
        pairingCodePath,
        dependencies.hostPlatform
      ),
      drainProof: authorityDrainProof,
      clock: { now },
      policy: HOSTED_PERSONAL_POLICY,
    };
    authority = new HostedAccessAuthority(authorityDependencies);
    const initialized = await authority.initialize(binding);
    if (!initialized.ok) throw new Error(`hosted_personal_initialize_failed:${initialized.code}`);
    if (initialized.value.resetPending) {
      const pendingAuthority = await repository.load();
      const pendingResetGeneration =
        pendingAuthority.status === 'available'
          ? pendingAuthority.state.resetIntent?.resetGeneration
          : undefined;
      if (pendingResetGeneration === undefined) {
        throw new Error('hosted_personal_reset_recovery_unavailable');
      }
      const recovered = await authority.consumeResetGeneration(binding, pendingResetGeneration);
      if (!recovered.ok) {
        throw new Error(`hosted_personal_reset_recovery_failed:${recovered.code}`);
      }
    }
    const challenge = await authority.issueInitialChallenge(binding);
    if (!challenge.ok && challenge.code !== 'pairing_already_established') {
      throw new Error(`hosted_personal_challenge_failed:${challenge.code}`);
    }
  }

  let personal: PersonalAuthenticationCapability | null = null;
  let oidc: OidcAuthenticationCapability | null = null;
  if (mode === 'personal') {
    if (authority === null) throw new Error('hosted_personal_capability_unavailable');
    personal = new HostedPersonalAuthenticationProvider(binding, authority, identities);
  } else {
    if (oidcIdentityProvider === null) throw new Error('hosted_oidc_capability_unavailable');
    oidc = new HostedOidcAuthenticationProvider(oidcIdentityProvider.displayName, identities);
  }
  const authentication = personal ?? oidc;
  if (authentication === null) throw new Error('hosted_authentication_capability_unavailable');

  await repository.seedWorkspaces(
    await Promise.all(
      csv(environment.HOSTED_WORKSPACE_IDS).map(async (runtimeWorkspaceId) => ({
        runtimeWorkspaceId,
        workspaceId: await identities.createWorkspaceId(),
      }))
    ),
    now()
  );
  const publicAccessGate = createHostedPublicAccessGate();
  const performAuthModeReset = async (input: {
    readonly targetMode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly auditEvent: HostedAuditEvent;
  }): Promise<HostedAuthModeResetResult> => {
    const currentConfiguration: HostedAuthConfiguration | null =
      await repository.readAuthConfiguration();
    if (currentConfiguration?.mode !== mode) return 'mode_mismatch' as const;
    if (input.resetGeneration <= currentConfiguration.resetGeneration) {
      return 'generation_not_newer' as const;
    }
    const loaded = await repository.load();
    if (loaded.status === 'corrupt' || loaded.status === 'unavailable') {
      throw new Error('hosted_auth_authority_unavailable_for_mode_reset');
    }
    const currentAuthority = loaded.status === 'available' ? loaded.state : null;
    if (
      currentAuthority !== null &&
      input.resetGeneration <= currentAuthority.consumedResetGeneration
    ) {
      return 'generation_not_newer' as const;
    }
    const pendingPersonalKeyringId = parseAuthKeyringId(
      await personalCrypto.randomId('auth-keyring')
    );
    const envelope: AuthKeyringEnvelope = Object.freeze({
      format: 'hosted-access-keyring/v1',
      keyringId: pendingPersonalKeyringId,
      binding,
      createdAt: now(),
      hashKey: parseAuthorityKeyMaterial(await personalCrypto.randomSecret('hash-key', 32)),
      csrfKey: parseAuthorityKeyMaterial(await personalCrypto.randomSecret('csrf-key', 32)),
    });
    const staged = await keyrings.stageReplacement(envelope);
    if (staged.status !== 'staged' && staged.status !== 'already_applied') {
      throw new Error('hosted_auth_mode_reset_keyring_stage_failed');
    }
    return repository.resetAuthMode({
      currentMode: mode,
      targetMode: input.targetMode,
      resetGeneration: input.resetGeneration,
      resetAt: now(),
      expectedAuthorityRevision: currentAuthority?.revision ?? null,
      nextAuthorityState: resetAuthorityState(
        currentAuthority,
        binding,
        pendingPersonalKeyringId,
        input.resetGeneration
      ),
      pendingPersonalKeyringId,
      auditEvent: input.auditEvent,
    });
  };
  const localAdministration = new HostedLocalAdministration({
    mode,
    binding,
    authority,
    identities,
    repository,
    drainProof: configuredDrainProof,
    now,
    runWithBrowserStreamsDrained: dependencies.runWithBrowserStreamsDrained,
    blockPublicAccess: () => publicAccessGate.blockAndDrain(),
    restorePublicAccess: () => publicAccessGate.restore(),
    performAuthModeReset,
  });

  const workspaceAccess = new HostedWorkspaceAccessService(repository, binding.restoreGeneration);
  const httpController = new HostedAuthHttpController({
    mode,
    publicOrigin,
    secureCookies: !allowInsecure,
    authentication,
    personal,
    oidc,
    repository,
    restoreGeneration: binding.restoreGeneration,
    runtimeIdentity:
      dependencies.runtimeInstance === undefined || dependencies.runtimeInstance === null
        ? null
        : Object.freeze({
            deploymentId: dependencies.runtimeInstance.deploymentId,
            bootId: dependencies.runtimeInstance.bootId,
          }),
    sessionMaxAgeSeconds: Math.floor(
      (mode === 'personal'
        ? HOSTED_PERSONAL_POLICY.sessionAbsoluteTtlMs
        : oidcPolicy!.sessionAbsoluteTtlMs) / 1000
    ),
    deviceMaxAgeSeconds: Math.floor(HOSTED_PERSONAL_POLICY.deviceAbsoluteTtlMs / 1000),
    tryEnterPublicRequest: () => publicAccessGate.tryEnter(),
    leavePublicRequest: () => publicAccessGate.leave(),
    isPublicAccessActive: () => publicAccessGate.isActive(),
    ...(dependencies.authorizationPolicy === undefined
      ? {}
      : { authorizationPolicy: dependencies.authorizationPolicy }),
    ...(dependencies.isLifecycleOwnerReady === undefined
      ? {}
      : { isLifecycleOwnerReady: dependencies.isLifecycleOwnerReady }),
    ...(dependencies.isTaskBoardMutationRouteEnabled === undefined
      ? {}
      : { isTaskBoardMutationRouteEnabled: dependencies.isTaskBoardMutationRouteEnabled }),
    ...(dependencies.isTeamMessageSendRouteEnabled === undefined
      ? {}
      : { isTeamMessageSendRouteEnabled: dependencies.isTeamMessageSendRouteEnabled }),
    ...(dependencies.resolveTeamWorkspaceId === undefined
      ? {}
      : { resolveTeamWorkspaceId: dependencies.resolveTeamWorkspaceId }),
  });
  const http = createHostedAuthenticatedHttpFacade(
    httpController,
    workspaceAccess,
    (
      request: unknown,
      scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
      mutation: boolean
    ) =>
      authorizeHostedTeamConfigurationScope(
        {
          authentication: httpController,
          resolvePublicGrant: workspaceAccess.resolvePublicGrant.bind(workspaceAccess),
          ...(dependencies.resolveTeamWorkspaceId === undefined
            ? {}
            : { resolveTeamWorkspaceId: dependencies.resolveTeamWorkspaceId }),
        },
        request as object,
        scope,
        mutation
      )
  );

  return Object.freeze({
    deploymentId: binding.deploymentId,
    restoreGeneration: binding.restoreGeneration,
    mode,
    localAdministration,
    http,
    startLocalControl: async (socketPath: string) => {
      const server = new HostedAuthLocalControlServer({
        socketPath,
        administration: localAdministration,
        platform: dependencies.hostPlatform,
        transportFactory: dependencies.localControlTransportFactory,
      });
      await server.start();
      return Object.freeze({ close: () => server.close() });
    },
  });
}
