import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  captureRetainedLegacyRuntimeIdentity,
  captureRetainedLegacySourceConfiguration,
  RetainedLegacyLaunchRefusal,
  retainedLegacySourceOperationKey,
} from '@features/agent-backend/main';
import { createCodexAccountFeature } from '@features/codex-account/main';
import { createCodexModelCatalogFeature } from '@features/codex-model-catalog/main';
import { createCodexRuntimeInstallerFeature } from '@features/codex-runtime-installer/main';
import { createOpenCodeInputDeclarationResolver } from '@features/runtime-provider-management';
import {
  createRuntimeProviderManagementFeature,
  OpenCodeLocalProviderConnector,
} from '@features/runtime-provider-management/main';
import { persistNodeMemberSettingsRelaunch } from '@features/team-provisioning/main';
import { CliInstallerService } from '@main/services/infrastructure/CliInstallerService';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import {
  OpenCodeRuntimeInstallerService,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { getOpenCodeRuntimeResolverCacheGeneration } from '@main/services/infrastructure/openCodeRuntimeResolverCache';
import { readOpenCodeBinaryOverride } from '@main/services/runtime/openCodeRuntimeBinaryEnv';
import { withOriginalRuntimeScope } from '@main/services/runtime/OriginalRuntimeScope';
import { ProviderConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamDataWorkerClient } from '@main/services/team/TeamDataWorkerClient';
import {
  assertOptionalBoolean,
  parseCreateMembers,
  parseLaunchRequest,
} from '@main/services/team/TeamRequestValidation';
import { killProcessTreeAndWait } from '@main/utils/childProcess';
import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import {
  getAmbientCachedShellEnv,
  resolveInteractiveShellEnvBestEffort,
} from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';
import { parseTeamProvisioningContext } from '@shared/utils/teamProvisioningContext';

import { prepareLegacy } from '../ipc/teams/prepareLegacyProvisioningRequest';

import type {
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchValueMap,
} from '@features/agent-backend/contracts';
import type {
  CapturedLegacyStoppedSource,
  CapturedRetainedLegacyRuntime,
} from '@features/agent-backend/main';
import type { OriginalRuntimeScope } from '@main/services/runtime/OriginalRuntimeScope';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { TeamLaunchRequest, TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'node:child_process';

type Operation = Exclude<
  RetainedLegacyLaunchRequest,
  { action: 'open' | 'close' | 'closeIntent' | 'rebind' | 'cancelModels' }
>;
export interface RetainedLegacyRuntimeOwners {
  data: Pick<
    TeamDataService,
    | 'getSavedRequest'
    | 'replaceMembers'
    | 'runConfigurationOperation'
    | 'invalidateMessageFeed'
    | 'invalidateTeamRuntimeAdvisories'
  >;
  provisioning: Pick<
    TeamProvisioningService,
    | 'prepareForProvisioning'
    | 'launchTeam'
    | 'readStoppedTeamImportRuntimeFacts'
    | 'isTeamAlive'
    | 'hasProvisioningRun'
  >;
  onProgress?: (progress: TeamProvisioningProgress) => void;
}

export function retainedLegacyAccountPaths(env: NodeJS.ProcessEnv, project: string) {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || getClaudeBasePath();
  const codex = env.CODEX_HOME?.trim() || join(home, '.codex');
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  const data = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  const files = [
    join(claude, '.credentials.json'),
    join(claude, '.config.json'),
    join(claude, 'settings.json'),
    join(home, '.claude', '.config.json'),
    join(home, '.claude.json'),
    join(homedir(), '.claude', 'api-keys.json'),
    join(codex, 'auth.json'),
    join(codex, 'config.toml'),
    join(config, 'opencode', 'opencode.json'),
    join(config, 'opencode', 'opencode.jsonc'),
    join(config, 'opencode', 'config.json'),
    join(data, 'opencode', 'auth.json'),
    join(getAppDataPath(), 'runtimes', 'opencode', 'current.json'),
    join(getAppDataPath(), 'runtimes', 'codex', 'current.json'),
    join(project, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.local.json'),
    join(project, '.codex', 'config.toml'),
    join(project, 'opencode.json'),
    join(project, 'opencode.jsonc'),
    join(project, '.opencode', 'opencode.json'),
    join(project, '.opencode', 'opencode.jsonc'),
  ];
  if (env.GOOGLE_APPLICATION_CREDENTIALS)
    files.push(resolve(project, env.GOOGLE_APPLICATION_CREDENTIALS));
  if (env.OPENCODE_CONFIG?.trim()) files.push(env.OPENCODE_CONFIG.trim());
  if (files.some((file) => !isAbsolute(file))) throw new RetainedLegacyLaunchRefusal('unavailable');
  return { files, directories: [join(codex, 'accounts')] };
}

function readOriginalProcessSelection(): NodeJS.ProcessEnv {
  // Main publishes this derived endpoint during preparation. Child launches obtain it
  // from the current control resolver; publication does not change the selected account.
  const { CLAUDE_TEAM_CONTROL_URL: _controlPublication, ...selection } = process.env;
  return selection;
}

/** Captures the ordinary original runtime without replacing the application's selected Host. */
export async function captureDesktopRetainedLegacyRuntime(
  source: CapturedLegacyStoppedSource,
  current: () => boolean,
  owners: RetainedLegacyRuntimeOwners,
  selectedProjectPath?: string
): Promise<CapturedRetainedLegacyRuntime> {
  const configuration = captureRetainedLegacySourceConfiguration(source);
  const sourceCurrent = () => {
    if (!current()) throw new RetainedLegacyLaunchRefusal('source-changed');
    configuration.assertCurrent();
  };
  sourceCurrent();
  const saved = await owners.data.getSavedRequest(source.teamName);
  sourceCurrent();
  if (!saved?.cwd || !isAbsolute(saved.cwd)) throw new RetainedLegacyLaunchRefusal('not-eligible');
  const savedRequest = saved;
  const project = resolve(selectedProjectPath ?? saved.cwd);
  const configManager = ConfigManager.getInstance();
  const ambientBefore = JSON.stringify([
    readOriginalProcessSelection(),
    configManager.getConfig().runtime,
    configManager.getConfig().providerConnections,
  ]);
  const shellEnv = {
    ...(await resolveInteractiveShellEnvBestEffort({
      fallbackEnv: { ...process.env },
      background: false,
    })),
  };
  sourceCurrent();
  const processEnv = { ...process.env };
  const binaryPath = await ClaudeBinaryResolver.resolve();
  sourceCurrent();
  const [codexBinaryPath, nativeClaudeBinaryPath] = await Promise.all([
    CodexBinaryResolver.resolve(),
    ClaudeBinaryResolver.resolveNative(),
  ]);
  sourceCurrent();
  const openCodeBinaryPath =
    readOpenCodeBinaryOverride(processEnv, shellEnv)?.binaryPath ??
    (await resolveVerifiedOpenCodeRuntimeBinaryPath());
  sourceCurrent();
  if (
    !binaryPath ||
    JSON.stringify([
      readOriginalProcessSelection(),
      configManager.getConfig().runtime,
      configManager.getConfig().providerConnections,
    ]) !== ambientBefore
  )
    throw new RetainedLegacyLaunchRefusal('account-changed');
  const environment = { ...processEnv, ...shellEnv };
  const paths = retainedLegacyAccountPaths(environment, project);
  const readSelection = () => ({
    process: readOriginalProcessSelection(),
    shell: getAmbientCachedShellEnv(),
    root: getClaudeBasePath(),
    app: getAppDataPath(),
    runtime: configManager.getConfig().runtime,
    accounts: configManager.getConfig().providerConnections,
    orchestratorGeneration: ClaudeBinaryResolver.getCacheGeneration(),
    openCodeGeneration: getOpenCodeRuntimeResolverCacheGeneration(),
  });
  const assertIdentity = captureRetainedLegacyRuntimeIdentity({
    readSelection,
    accountFiles: paths.files,
    accountDirectories: paths.directories,
    executable: binaryPath,
    accountFileIdentity(file, bytes) {
      // Original bootstrap adds only permission rules here. Its own permission publication is
      // not an account change; all other existing settings remain part of the captured identity.
      if (file === join(project, '.claude', 'settings.local.json')) {
        const settings = bytes
          ? (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>)
          : {};
        const { permissions: _permissions, ...selection } = settings;
        return JSON.stringify(selection);
      }
      return bytes ?? 'absent';
    },
    additionalExecutables: [codexBinaryPath, nativeClaudeBinaryPath, openCodeBinaryPath].filter(
      (value): value is string => Boolean(value)
    ),
  });
  const logger = createLogger('RetainedOriginalRuntime');
  const account = createCodexAccountFeature({ logger, configManager });
  const codexModels = createCodexModelCatalogFeature({ logger, codexAccountFeature: account });
  const connections = new ProviderConnectionService();
  connections.setCodexAccountFeature(account);
  connections.setCodexModelCatalogFeature(codexModels);
  const management = createRuntimeProviderManagementFeature({
    getOpenCodeRuntimeGeneration: getOpenCodeRuntimeResolverCacheGeneration,
    localProviderConnector: new OpenCodeLocalProviderConnector({
      environment: () => ({ ...environment }),
      homePath: environment.HOME || homedir(),
    }),
  });
  const installer = new CliInstallerService();
  const opencodeRuntime = new OpenCodeRuntimeInstallerService();
  const codexRuntime = createCodexRuntimeInstallerFeature();
  const resolveInput = createOpenCodeInputDeclarationResolver(management.loadModels);
  let disposed = false,
    launchAdmitted = false,
    retiring = false;
  let pendingLaunch: TeamLaunchRequest | undefined;
  const children = new Set<ChildProcess>();
  const assertCurrent = () => {
    if (disposed) throw new RetainedLegacyLaunchRefusal('unavailable');
    sourceCurrent();
    assertIdentity();
  };
  const scopeBase = {
    sourceKey: retainedLegacySourceOperationKey(source),
    teamName: source.teamName,
    cacheNamespace: randomUUID(),
    binaryPath,
    codexBinaryPath,
    nativeClaudeBinaryPath,
    openCodeBinaryPath,
    processEnv: Object.freeze(processEnv),
    shellEnv: Object.freeze(shellEnv),
    providerConnections: connections,
    resolveOpenCodeInputDeclaration: resolveInput,
    assertCurrent,
    admitLaunch(teamName: string) {
      assertCurrent();
      if (teamName !== source.teamName || launchAdmitted || !pendingLaunch)
        throw new RetainedLegacyLaunchRefusal('intent-changed');
      configuration.admitLaunch(pendingLaunch);
      launchAdmitted = true;
    },
    registerChild(child: ChildProcess) {
      children.add(child);
      child.once('close', () => children.delete(child));
    },
    beginSourceWrite: (file: string, data: string | Buffer, permitted: boolean) =>
      configuration.beginWrite(file, data, permitted),
  } satisfies Omit<OriginalRuntimeScope, 'operation'>;
  const projectPath = (value: string | null | undefined): string => {
    if (value && resolve(value) !== project)
      throw new RetainedLegacyLaunchRefusal('account-changed');
    return project;
  };
  const invalidateRoster = () => {
    assertCurrent();
    TeamConfigReader.invalidateTeam(source.teamName);
    owners.data.invalidateMessageFeed(source.teamName);
    owners.data.invalidateTeamRuntimeAdvisories(source.teamName);
    const worker = getTeamDataWorkerClient();
    worker.invalidateTeamConfig(source.teamName);
    worker.invalidateMemberRuntimeAdvisory(source.teamName);
  };
  async function runOperation(request: Operation): Promise<unknown> {
    switch (request.action) {
      case 'read':
        return { ...structuredClone(savedRequest), cwd: project };
      case 'account':
        return account.refreshSnapshot({ includeRateLimits: false, forceRefreshToken: false });
      case 'opencodeRuntime':
        return opencodeRuntime.getStatus();
      case 'codexRuntime':
        return codexRuntime.getStatus();
      case 'status': {
        projectPath(request.projectPath);
        const status = await installer.getStatus({ providerStatusMode: 'defer' });
        assertCurrent();
        const providers = await Promise.all(
          status.providers.map(
            async (provider) =>
              (await installer.getProviderStatus(provider.providerId, { projectPath: project })) ??
              provider
          )
        );
        assertCurrent();
        return { ...status, providers };
      }
      case 'models':
        return management.loadModels({
          ...request.input,
          projectPath: projectPath(request.input.projectPath),
        });
      case 'directory':
        return management.loadProviderDirectory({
          ...request.input,
          projectPath: projectPath(request.input.projectPath),
        });
      case 'localProviders':
        return management.listLocalProviders({
          ...request.input,
          ...(request.input.scope === 'project'
            ? { projectPath: projectPath(request.input.projectPath) }
            : {}),
        });
      case 'scanLocalProviders':
        return management.scanLocalProviders(request.input);
      case 'prepare': {
        const args = request.args.map((value) => (value === null ? undefined : value));
        const context = parseTeamProvisioningContext(args[7]);
        if (context && (context.kind !== 'team' || context.teamName !== source.teamName))
          throw new RetainedLegacyLaunchRefusal('source-changed');
        const result = await prepareLegacy(
          async (cwd, options) => {
            projectPath(cwd);
            assertCurrent();
            return {
              success: true,
              data: await owners.provisioning.prepareForProvisioning(project, options),
            };
          },
          projectPath(typeof args[0] === 'string' ? args[0] : undefined),
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
          args[6]
        );
        if (!result.success || !result.data) throw new RetainedLegacyLaunchRefusal('invalid');
        return result.data;
      }
      case 'roster': {
        if (
          Object.keys(request.request).some(
            (key) => !['members', 'memberSettingsRelaunch'].includes(key)
          )
        )
          throw new RetainedLegacyLaunchRefusal('invalid');
        const members = parseCreateMembers(
          request.request.members,
          savedRequest.providerId ?? 'anthropic'
        );
        return owners.data.runConfigurationOperation(source.teamName, () =>
          configuration.mutate(async () => {
            assertCurrent();
            if (request.request.memberSettingsRelaunch !== undefined) {
              await persistNodeMemberSettingsRelaunch(
                source.teamName,
                members,
                request.request.memberSettingsRelaunch,
                {
                  isTeamAlive: (name) => {
                    assertCurrent();
                    return owners.provisioning.isTeamAlive(name);
                  },
                  hasProvisioningRun: (name) => {
                    assertCurrent();
                    return owners.provisioning.hasProvisioningRun(name);
                  },
                  invalidateWorkerCache: invalidateRoster,
                }
              );
            } else {
              await owners.data.replaceMembers(source.teamName, { members });
              assertCurrent();
              invalidateRoster();
            }
            assertCurrent();
            return null;
          })
        );
      }
      case 'launch': {
        if (request.request.teamName !== source.teamName)
          throw new RetainedLegacyLaunchRefusal('source-changed');
        const normalized = parseLaunchRequest(source.teamName, request.request);
        const syncModelsWithLead = assertOptionalBoolean(
          request.request.syncModelsWithLead,
          'syncModelsWithLead'
        );
        projectPath(normalized.cwd);
        return owners.data.runConfigurationOperation(source.teamName, () =>
          configuration.mutate(async () => {
            assertCurrent();
            pendingLaunch = {
              ...normalized,
              ...(syncModelsWithLead === undefined ? {} : { syncModelsWithLead }),
            };
            return owners.provisioning.launchTeam(pendingLaunch, owners.onProgress ?? (() => {}));
          })
        );
      }
    }
  }
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const result = await Promise.allSettled([
      management.shutdown(),
      account.dispose(),
      codexModels.dispose(),
      ...[...children].map((child) => killProcessTreeAndWait(child, 'SIGKILL')),
    ]);
    if (result.some((entry) => entry.status === 'rejected'))
      throw new RetainedLegacyLaunchRefusal('outcome-unknown');
  };
  return {
    projectPath: project,
    assertCurrent,
    cancelModels: (input) => management.cancelModelLoad(input),
    async run<K extends Operation['action']>(
      request: Extract<Operation, { action: K }>
    ): Promise<RetainedLegacyLaunchValueMap[K]> {
      assertCurrent();
      const result = await withOriginalRuntimeScope(
        { ...scopeBase, operation: request.action },
        () => runOperation(request)
      );
      assertCurrent();
      return result as RetainedLegacyLaunchValueMap[K];
    },
    async close() {
      if (retiring || disposed) return;
      retiring = true;
      const active = () =>
        Object.values(owners.provisioning.readStoppedTeamImportRuntimeFacts(source.teamName)).some(
          (value) => value !== 0
        );
      if (!launchAdmitted || !active()) return dispose();
      // The accepted original Launch owns deferred startup. Closing its dialog cannot revoke it.
      const timer = setInterval(() => {
        if (!active()) {
          clearInterval(timer);
          void dispose().catch(() => {});
        }
      }, 1_000);
      timer.unref();
    },
  };
}
