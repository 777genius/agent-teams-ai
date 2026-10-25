import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer';
import {
  isSupportedOpenCodeRuntimeBinaryPath,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { readOpenCodeBinaryOverride } from '@main/services/runtime/openCodeRuntimeBinaryEnv';
import { buildPassiveProviderStatusCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { getClaudeBasePath, getHomeDir } from '@main/utils/pathDecoder';
import { startUap } from '@uap/management-sdk/node';

import { ExtensionRuntimeGate } from '../../core/application/ExtensionRuntimeGate';
import { createLocalSkillMutationExecutor } from '../adapters/output/createLocalSkillMutationExecutor';
import {
  canonicalExtensionPath,
  captureAuthoringRoots,
  projectSkillAdmissionResources,
} from '../infrastructure/captureAuthoringRoots';
import { prepareSkillCopy } from '../infrastructure/prepareSkillCopy';
import { resolveExtensionLaunchContext } from '../infrastructure/resolveExtensionLaunchContext';
import { resolveSkillCopySources } from '../infrastructure/resolveSkillCopySources';
import { resolveUapExecutable } from '../infrastructure/resolveUapExecutable';

import { createExtensionManagementFeature } from './createExtensionManagementFeature';

import type { ExtensionClient, ExtensionSelection, ManagementPlan } from '../../contracts';
import type { CapturedExtensionEnvironment } from '../../core/application/ports';
import type { KnownAuthoringProject } from '../infrastructure/captureAuthoringRoots';
import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types/team';

export interface DesktopExtensionManagementDependencies {
  resourceRoot: string;
  isLocal(): boolean;
  activeClientIds(): Promise<ReadonlySet<ExtensionClient>>;
  savedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  knownProjects(): Promise<readonly KnownAuthoringProject[]>;
}
const CLIENTS: readonly ExtensionClient[] = ['claude', 'codex', 'opencode'];
function clientForProvider(value?: string): ExtensionClient | null {
  return value === 'anthropic'
    ? 'claude'
    : value === 'codex' || value === 'opencode'
      ? value
      : null;
}
async function nativeExecutable(client: ExtensionClient): Promise<string | null> {
  if (client === 'claude') return ClaudeBinaryResolver.resolveNative();
  if (client === 'codex') return CodexBinaryResolver.resolve();
  const explicit = readOpenCodeBinaryOverride(process.env);
  if (explicit && (await isSupportedOpenCodeRuntimeBinaryPath(explicit.binaryPath)))
    return explicit.binaryPath;
  return resolveVerifiedOpenCodeRuntimeBinaryPath();
}
async function profile(client: ExtensionClient) {
  const { env } = buildPassiveProviderStatusCliEnv({
    providerId: client === 'claude' ? 'anthropic' : client,
  });
  const home = env.HOME || env.USERPROFILE || getHomeDir();
  const root =
    client === 'claude'
      ? getClaudeBasePath()
      : client === 'codex'
        ? env.CODEX_HOME || path.join(home, '.codex')
        : env.OPENCODE_CONFIG_DIR ||
          path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  // Retain every profile's authority even when its executable is unavailable.
  // Root failures remain fatal; native discovery must not prepare unrelated launches.
  const captured = { client, configRoot: await canonicalExtensionPath(root) };
  try {
    const executable = await nativeExecutable(client);
    return { ...captured, ...(executable ? { executable: await realpath(executable) } : {}) };
  } catch {
    // Go exposes the unavailable target. Durable inspection still runs before launch.
    return captured;
  }
}

export function createDesktopExtensionManagement(deps: DesktopExtensionManagementDependencies) {
  const gate = new ExtensionRuntimeGate();
  const capture = async (
    selection: ExtensionSelection
  ): Promise<
    CapturedExtensionEnvironment & { profiles: Awaited<ReturnType<typeof profile>>[] }
  > => {
    if (!deps.isLocal())
      throw new Error('Universal extensions are available for local agent environments.');
    if (selection.scope !== 'user')
      throw new Error('Project extension installation is not supported by the pinned engine yet.');
    const profiles = await Promise.all(CLIENTS.map(profile));
    const authoring = await captureAuthoringRoots(profiles, selection, deps.knownProjects);
    const identity = createHash('sha256')
      .update(
        JSON.stringify({
          scope: selection.scope,
          profiles,
          authoringRoots: authoring.authoringRoots,
        })
      )
      .digest('hex');
    const affectedClients = (plan?: ManagementPlan): readonly string[] => {
      const ids = plan?.actions.map((action) => action.targetId) ?? [];
      return ids.length && ids.every((id) => CLIENTS.some((client) => client === id))
        ? ids
        : CLIENTS;
    };
    return {
      identity,
      profiles,
      selection,
      resources: [
        ...profiles.map((item) => item.configRoot),
        ...authoring.authoringRoots.map((root) => root.path),
      ],
      resourcesForPlan: (plan) => [
        ...profiles
          .filter((item) => affectedClients(plan).includes(item.client))
          .map((item) => item.configRoot),
        ...(plan.action === 'local_skill' ? authoring.authoringRoots.map((root) => root.path) : []),
      ],
      locateLocalSkill: authoring.locateLocalSkill,
      skillCopySources: (paths) => resolveSkillCopySources(paths, authoring.authoringRoots),
      prepareSkillCopy: (paths, destination) =>
        prepareSkillCopy(paths, authoring.authoringRoots, destination),
      label: `${selection.client === 'claude' ? 'Claude' : selection.client === 'codex' ? 'Codex' : 'OpenCode'} · User`,
      async assertCurrent() {
        if (
          !deps.isLocal() ||
          JSON.stringify(await Promise.all(CLIENTS.map(profile))) !== JSON.stringify(profiles) ||
          JSON.stringify(
            (await captureAuthoringRoots(profiles, selection, deps.knownProjects)).authoringRoots
          ) !== JSON.stringify(authoring.authoringRoots)
        ) {
          throw new Error(
            'The selected agent profile changed. Reopen Extensions and review a fresh plan.'
          );
        }
      },
      async assertInactive(plan) {
        const active = await deps.activeClientIds();
        if (affectedClients(plan).some((client) => active.has(client as ExtensionClient)))
          throw new Error(
            'Stop the active run using this agent profile before changing its extensions.'
          );
      },
      async connect() {
        const executable = await resolveUapExecutable(deps.resourceRoot);
        return startUap({
          executable,
          config: {
            contextId: identity,
            scope: selection.scope,
            targets: profiles.map((item) => ({ id: item.client, ...item })),
            authoringRoots: authoring.authoringRoots,
          },
        });
      },
    };
  };
  const feature = createExtensionManagementFeature({ capture }, gate);
  async function admitLaunch<T>(
    request: TeamCreateRequest | TeamLaunchRequest | Pick<TeamLaunchRequest, 'teamName'>,
    operation: () => Promise<T>,
    additionalProviders: readonly string[] = []
  ): Promise<T> {
    if (!deps.isLocal()) return operation();
    const saved = 'members' in request ? request : await deps.savedRequest(request.teamName);
    const launch = resolveExtensionLaunchContext(request, saved);
    const providers = launch.providers.length ? [...launch.providers, ...additionalProviders] : [];
    const clients =
      providers.length && providers.every((provider) => clientForProvider(provider))
        ? [...new Set(providers.map((provider) => clientForProvider(provider)!))]
        : [...CLIENTS];
    const captured = await capture({ client: clients[0], scope: 'user' });
    // Observe the shared durable environment before every launch. A previous
    // app or engine crash must not make an interrupted mutation disappear.
    const context = await feature.capture(captured.selection);
    await feature.environment({ contextId: context.contextId });
    return gate.launch(
      [
        ...captured.profiles
          .filter((item) => clients.includes(item.client))
          .map((item) => item.configRoot),
        ...(await Promise.all(launch.projectPaths.map(projectSkillAdmissionResources))).flat(),
      ],
      operation
    );
  }
  return { feature, admitLaunch, localSkills: createLocalSkillMutationExecutor(feature) };
}
