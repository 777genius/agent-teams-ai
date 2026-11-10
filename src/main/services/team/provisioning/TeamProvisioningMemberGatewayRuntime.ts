import {
  applyGatewayMemberEnvPatch,
  buildClaudeGatewayMemberEnvPatch,
  buildCodexGatewayCustomProviderConfig,
  buildCodexGatewayMemberEnvPatch,
  buildOpenCodeGatewayArtifactConfigureInput,
  buildOpenCodeGatewayModelRoute,
  type MemberGatewayEnvPatch,
  type OpenCodeGatewayArtifactConfigureInput,
  type OpenCodeGatewayArtifactTarget,
  type ResolvedMemberGatewayConnection,
} from '@features/gateway-provider/main';
import {
  buildCodexCustomProviderConfigOverrides,
  buildCodexLaunchArgs,
} from '@main/services/runtime/ProviderConnectionService';
import { resolveTeamProviderId } from '@main/services/runtime/providerRuntimeEnv';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';

import { normalizeTeamMemberProviderId } from './TeamProvisioningMemberSpecs';

import type { ProviderModelLaunchIdentity, TeamCreateRequest, TeamProviderId } from '@shared/types';

/**
 * Per-member gateway runtime artifacts (Stage 3 of
 * docs/plans/gateway-provider-per-teammate-plan.md). Bindings resolve through
 * injected seams only; no provisioning -> gateway feature ownership leaks.
 */

export interface MemberGatewayRuntimeArgs {
  envPatch: MemberGatewayEnvPatch;
  configOverrides?: string[];
  codexForcedLoginMethod?: 'api';
  /** Opaque usage-source id snapshot taken before any direct spawn. */
  gatewayUsageRef?: string;
  /** OpenCode `<providerEntry>/<modelId>` route; travels to the member. */
  modelRoute?: string;
  beginLaunch?(): Promise<void>;
  abortUnspawnedLaunch?(): Promise<void>;
  confirmStopped?(): Promise<void>;
}

export interface MemberGatewayRuntimeOpenCodeConfigured {
  providerId: string;
  modelRoute: string;
}

export interface MemberGatewayRuntimeSeams {
  resolveMemberConnection(
    teamName: string,
    memberName: string,
    model?: string
  ): Promise<ResolvedMemberGatewayConnection | null>;
  configureOpenCodeLocalProvider(
    input: OpenCodeGatewayArtifactConfigureInput,
    target: OpenCodeGatewayArtifactTarget
  ): Promise<MemberGatewayRuntimeOpenCodeConfigured>;
  retireOpenCodeLocalProvider(input: {
    providerId: string;
    teamName: string;
    memberName: string;
    gatewayUsageRef: string;
  }): Promise<{ retired: boolean }>;
  snapshotLaunch?(input: {
    teamName: string;
    memberName: string;
    providerId: TeamProviderId;
    gatewayUsageRef?: string;
  }): Promise<string | void>;
  abortUnspawnedLaunch?(id: string): Promise<void>;
  confirmLaunchStopped?(id: string): Promise<void>;
  confirmNativeTeamStopped?(teamName: string): Promise<void>;
  markRuntimeArtifactActive(gatewayUsageRef: string): Promise<void>;
  markRuntimeArtifactRetired(gatewayUsageRef: string): Promise<void>;
}

function assertGatewayProviderSupported(providerId: TeamProviderId): void {
  if (providerId === 'gemini') {
    throw new Error('Gateway bindings support Claude, Codex and OpenCode teammates only.');
  }
}

export interface ResolveMemberGatewayRuntimeArgsInput {
  seams: MemberGatewayRuntimeSeams | null;
  teamName: string | null | undefined;
  memberName: string;
  providerId: TeamProviderId;
  model?: string | null;
  snapshotLaunch?: boolean;
}

/**
 * Resolve one member's gateway binding into per-runtime artifacts.
 * Native unbound members retain launch hooks to delimit gateway attribution;
 * route/auth overrides remain empty. No seam means no gateway integration.
 * The resolved source identity is snapshotted before any spawn.
 */
export async function resolveMemberGatewayRuntimeArgs(
  input: ResolveMemberGatewayRuntimeArgsInput
): Promise<MemberGatewayRuntimeArgs | null> {
  const teamName = input.teamName?.trim();
  if (!input.seams || !teamName) return null;
  const connection = await input.seams.resolveMemberConnection(
    teamName,
    input.memberName,
    (input.providerId === 'opencode'
      ? input.model?.replace(/^gateway-[a-z0-9_-]+-[a-f0-9]{12}\//, '')
      : input.model
    )?.trim() || undefined
  );
  let launchSnapshotId: string | void;
  const beginLaunch = async () => {
    if (input.snapshotLaunch === false || launchSnapshotId) return;
    launchSnapshotId = await input.seams!.snapshotLaunch?.({
      teamName,
      memberName: input.memberName,
      providerId: input.providerId,
      gatewayUsageRef: connection?.gatewayUsageRef,
    });
  };
  const abortUnspawnedLaunch = async () => {
    if (typeof launchSnapshotId === 'string')
      await input.seams!.abortUnspawnedLaunch?.(launchSnapshotId);
  };
  const confirmStopped = async () => {
    if (typeof launchSnapshotId === 'string')
      await input.seams!.confirmLaunchStopped?.(launchSnapshotId);
  };
  if (!connection) {
    // A native launch without a route closes the preceding gateway attribution window.
    return input.snapshotLaunch !== false &&
      input.seams.snapshotLaunch &&
      (input.providerId === 'anthropic' || input.providerId === 'codex')
      ? { envPatch: {}, beginLaunch, abortUnspawnedLaunch, confirmStopped }
      : null;
  }
  assertGatewayProviderSupported(input.providerId);

  if (input.providerId === 'opencode') {
    const artifact = buildOpenCodeGatewayArtifactConfigureInput(connection);
    if (!artifact) {
      throw new Error(
        `Gateway binding for teammate "${input.memberName}" needs a model before its OpenCode provider entry can be configured.`
      );
    }
    await input.seams.markRuntimeArtifactActive(connection.gatewayUsageRef);
    let configured: MemberGatewayRuntimeOpenCodeConfigured;
    try {
      configured = await input.seams.configureOpenCodeLocalProvider(
        artifact.input,
        artifact.target
      );
    } catch (error) {
      await abortUnspawnedLaunch?.();
      throw error;
    }
    return {
      beginLaunch,
      abortUnspawnedLaunch,
      confirmStopped,
      envPatch: {},
      gatewayUsageRef: connection.gatewayUsageRef,
      modelRoute: configured.modelRoute || buildOpenCodeGatewayModelRoute(artifact.input),
    };
  }

  if (input.providerId === 'codex') {
    const config = buildCodexGatewayCustomProviderConfig({ spec: connection.spec });
    return {
      beginLaunch,
      abortUnspawnedLaunch,
      confirmStopped,
      envPatch: buildCodexGatewayMemberEnvPatch({ apiKey: connection.apiKey }),
      configOverrides: buildCodexCustomProviderConfigOverrides({
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        model: config.model ?? '',
      }),
      codexForcedLoginMethod: 'api',
      gatewayUsageRef: connection.gatewayUsageRef,
    };
  }

  return {
    beginLaunch,
    abortUnspawnedLaunch,
    confirmStopped,
    envPatch: buildClaudeGatewayMemberEnvPatch(connection),
    gatewayUsageRef: connection.gatewayUsageRef,
  };
}

/**
 * The global provider catalog describes the user's default connection. A member
 * whose exact gateway credentials have already resolved uses that gateway's
 * selected model instead; the lead is validated separately by the caller.
 */
export function getRuntimeCatalogMembers(
  members: TeamCreateRequest['members'],
  memberArgsByMember: ReadonlyMap<string, MemberGatewayRuntimeArgs> | undefined
): TeamCreateRequest['members'] {
  return members.filter((member) => !memberArgsByMember?.get(member.name)?.gatewayUsageRef);
}

/** Read-only identity resolution before direct restart creates any launch artifacts. */
export async function resolveGatewayMemberLaunchIdentity(input: {
  seams: MemberGatewayRuntimeSeams | null;
  teamName: string;
  providerId: TeamProviderId;
  memberSpec: TeamCreateRequest['members'][number];
}): Promise<ProviderModelLaunchIdentity | null> {
  const model = input.memberSpec.model?.trim();
  const connection = await input.seams?.resolveMemberConnection(
    input.teamName,
    input.memberSpec.name,
    input.providerId === 'opencode'
      ? model?.replace(/^gateway-[a-z0-9_-]+-[a-f0-9]{12}\//, '')
      : model
  );
  if (!connection) return null;
  assertGatewayProviderSupported(input.providerId);
  const gatewayModel = connection.spec.model?.trim();
  if (!gatewayModel) throw new Error('A gateway teammate requires an explicit model.');
  return {
    providerId: input.providerId,
    providerBackendId: input.providerId === 'codex' ? 'codex-native' : null,
    billingMode: 'api',
    selectedModel: gatewayModel,
    selectedModelKind: 'explicit',
    resolvedLaunchModel: gatewayModel,
    catalogId: gatewayModel,
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: input.memberSpec.effort ?? null,
    resolvedEffort: input.memberSpec.effort ?? null,
    selectedFastMode: input.memberSpec.fastMode ?? 'inherit',
    resolvedFastMode: input.memberSpec.fastMode === 'on',
  };
}

/** Codex per-member overrides in the claude-bridge `--settings` JSON form. */
export function buildMemberCodexCliArgs(memberArgs: MemberGatewayRuntimeArgs): string[] {
  if (!memberArgs.configOverrides?.length) return [];
  return buildCodexLaunchArgs(null, memberArgs.codexForcedLoginMethod ?? 'api', {
    customProviderConfigOverrides: memberArgs.configOverrides,
  });
}

export interface DirectGatewaySpawnArgs {
  /** Final narrow env patch; callers re-apply it after every auth transform. */
  envPatch: MemberGatewayEnvPatch;
  /** Per-member Codex `--settings`/`-c` CLI args. */
  codexArgs: string[];
  beginLaunch?(): Promise<void>;
  abortUnspawnedLaunch?(): Promise<void>;
  confirmStopped?(): Promise<void>;
  gatewayUsageRef?: string;
  modelRoute?: string;
}

/**
 * Direct spawn application point (tmux restart / native process spawn). The
 * member env patch lands strictly after `applyDirectMemberRuntimeEnv` and
 * outside the team runtime settings bundle, so route/auth normalizers never
 * observe it. The returned patch must additionally win over any later
 * inherited-auth transform at the spawn boundary.
 */
export async function applyDirectGatewayArgs(
  host: { getMemberGatewayRuntimeSeams(): MemberGatewayRuntimeSeams | null },
  input: { teamName: string; configuredMember: { name: string } },
  memberSpec: { providerId?: unknown; model?: unknown },
  env: NodeJS.ProcessEnv
): Promise<DirectGatewaySpawnArgs | null> {
  const memberArgs = await resolveMemberGatewayRuntimeArgs({
    seams: host.getMemberGatewayRuntimeSeams(),
    teamName: input.teamName,
    memberName: input.configuredMember.name,
    providerId: resolveTeamProviderId(
      normalizeTeamMemberProviderId(memberSpec.providerId) ?? undefined
    ),
    model: typeof memberSpec.model === 'string' ? memberSpec.model : null,
  });
  if (!memberArgs) return null;
  applyGatewayMemberEnvPatch(env, memberArgs.envPatch);
  return {
    envPatch: memberArgs.envPatch,
    beginLaunch: memberArgs.beginLaunch,
    abortUnspawnedLaunch: memberArgs.abortUnspawnedLaunch,
    confirmStopped: memberArgs.confirmStopped,
    codexArgs: buildMemberCodexCliArgs(memberArgs),
    gatewayUsageRef: memberArgs.gatewayUsageRef,
    modelRoute: memberArgs.modelRoute,
  };
}

export class MemberGatewaySpawnCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberGatewaySpawnCompatibilityError';
  }
}

/**
 * A member gateway binding can only travel through a separate-process spawn
 * with per-member credentials: in-process teammates share the lead process env
 * and the anthropic api-key helper serves the lead key. Both combinations fail
 * at prepare with no fallback to the lead key.
 */
export function assertMemberGatewaySpawnCompatibility(input: {
  memberArgsByMember: ReadonlyMap<string, MemberGatewayRuntimeArgs> | undefined;
  usesAnthropicApiKeyHelper: boolean;
  teammateModeIsInProcess: boolean;
}): void {
  const boundMembers = [...(input.memberArgsByMember?.values() ?? [])].filter(
    (memberArgs) => memberArgs.gatewayUsageRef
  );
  if (boundMembers.length === 0) return;
  if (input.teammateModeIsInProcess) {
    throw new MemberGatewaySpawnCompatibilityError(
      'Teammates with gateway bindings require a separate-process spawn (tmux or native process); remove the in-process teammate mode or the gateway binding.'
    );
  }
  if (input.usesAnthropicApiKeyHelper) {
    throw new MemberGatewaySpawnCompatibilityError(
      'Gateway-bound teammates cannot run alongside the Anthropic API key helper; the helper serves the lead key and a member binding must not fall back to it.'
    );
  }
}

export interface MemberGatewayRuntimeSeamsAdapterDeps {
  resolveMemberConnection(
    teamName: string,
    memberName: string,
    model?: string
  ): Promise<ResolvedMemberGatewayConnection | null>;
  configureOpenCodeLocalProvider(
    input: OpenCodeGatewayArtifactConfigureInput,
    target: OpenCodeGatewayArtifactTarget
  ): Promise<MemberGatewayRuntimeOpenCodeConfigured>;
  retireOpenCodeLocalProvider(input: {
    providerId: string;
    teamName: string;
    memberName: string;
    gatewayUsageRef: string;
  }): Promise<{ retired: boolean }>;
  snapshotLaunch?(input: {
    teamName: string;
    memberName: string;
    providerId: TeamProviderId;
    gatewayUsageRef?: string;
  }): Promise<string | void>;
  abortUnspawnedLaunch?(id: string): Promise<void>;
  confirmLaunchStopped?(id: string): Promise<void>;
  confirmNativeTeamStopped?(teamName: string): Promise<void>;
  markRuntimeArtifactActive(gatewayUsageRef: string): Promise<void>;
  markRuntimeArtifactRetired(gatewayUsageRef: string): Promise<void>;
}

/** Structural seam bundle assembled at the app shell (main/index.ts). */
export function createMemberGatewayRuntimeSeams(
  deps: MemberGatewayRuntimeSeamsAdapterDeps
): MemberGatewayRuntimeSeams {
  return {
    resolveMemberConnection: (teamName, memberName, model) =>
      deps.resolveMemberConnection(teamName, memberName, model),
    configureOpenCodeLocalProvider: (input, target) =>
      deps.configureOpenCodeLocalProvider(input, target),
    snapshotLaunch: (input) => deps.snapshotLaunch?.(input) ?? Promise.resolve(),
    abortUnspawnedLaunch: (id) => deps.abortUnspawnedLaunch?.(id) ?? Promise.resolve(),
    confirmLaunchStopped: (id) => deps.confirmLaunchStopped?.(id) ?? Promise.resolve(),
    confirmNativeTeamStopped: (teamName) =>
      deps.confirmNativeTeamStopped?.(teamName) ?? Promise.resolve(),
    retireOpenCodeLocalProvider: (input) => deps.retireOpenCodeLocalProvider(input),
    markRuntimeArtifactActive: (gatewayUsageRef) => deps.markRuntimeArtifactActive(gatewayUsageRef),
    markRuntimeArtifactRetired: (gatewayUsageRef) =>
      deps.markRuntimeArtifactRetired(gatewayUsageRef),
  };
}

/** Route app-owned OpenCode primary/secondary lanes through their launch-time binding. */
export async function resolveOpenCodeGatewayMemberModels(input: {
  seams: MemberGatewayRuntimeSeams | null;
  teamName: string;
  leadProviderId?: TeamProviderId;
  members: TeamCreateRequest['members'];
}): Promise<TeamCreateRequest['members']> {
  const members: TeamCreateRequest['members'] = [];
  for (const member of input.members) {
    const providerId = normalizeTeamMemberProviderId(member.providerId) ?? input.leadProviderId;
    if (providerId !== 'opencode' || isLeadMember(member)) {
      members.push(member);
      continue;
    }
    const gateway = await resolveMemberGatewayRuntimeArgs({
      seams: input.seams,
      teamName: input.teamName,
      memberName: member.name,
      providerId,
      model: member.model,
      snapshotLaunch: false,
    });
    members.push(gateway?.modelRoute ? { ...member, model: gateway.modelRoute } : member);
  }
  return members;
}

/** Best-effort cleanup only for confirmed spawn failures; preserve the original launch error. */
export async function abortUnspawnedGatewayMembers(
  members: ReadonlyMap<string, MemberGatewayRuntimeArgs> | undefined
): Promise<void> {
  await Promise.all(
    [...(members?.values() ?? [])].map(async (member) => {
      try {
        await member.abortUnspawnedLaunch?.();
      } catch (error) {
        createLogger('GatewayMemberLaunch').warn(
          `Could not close an unspawned gateway launch: ${String(error)}`
        );
      }
    })
  );
}

export async function beginGatewayMemberLaunches(
  members: ReadonlyMap<string, MemberGatewayRuntimeArgs> | undefined
): Promise<void> {
  for (const member of members?.values() ?? []) await member.beginLaunch?.();
}

/** Roll back only launches that never reached a child; preserve the original failure. */
export async function cleanupUnspawnedGatewayLaunch(
  args: Pick<DirectGatewaySpawnArgs, 'abortUnspawnedLaunch'> | null,
  streams: ReadonlyArray<{ destroy(): unknown }> = [],
  spawned = false
): Promise<void> {
  for (const stream of streams) stream.destroy();
  if (!spawned) {
    await args?.abortUnspawnedLaunch?.().catch((error: unknown) => {
      createLogger('GatewayMemberLaunch').warn(
        `Could not close an unspawned gateway launch: ${String(error)}`
      );
    });
  }
}
