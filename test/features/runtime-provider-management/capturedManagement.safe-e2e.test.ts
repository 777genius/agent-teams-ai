// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, it, vi } from 'vitest';

import { treeHash } from '../../../packages/legacy-agent-host/tests/fixtures/native-host';
import {
  RUNTIME_PROVIDER_MANAGEMENT_CANCEL_MODEL_TEST,
  RUNTIME_PROVIDER_MANAGEMENT_CLEAR_PROJECT_DEFAULT,
  RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_FORGET,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE,
  RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
} from '../../../src/features/runtime-provider-management/contracts';
import {
  createRuntimeProviderManagementFeature,
  registerRuntimeProviderManagementIpc,
  removeRuntimeProviderManagementIpc,
} from '../../../src/features/runtime-provider-management/main';
import {
  getDesktopProviderManagementPort,
  getDesktopProviderStatusPort,
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
  shutdownDesktopAgentBackend,
} from '../../../src/main/ipc/agentBackend';
import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
} from '../../../src/preload/constants/ipcChannels';

import type { TeamHostProfile } from '../../../packages/legacy-agent-host/dist/composition/TeamHost';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main';
import type * as Dto from '../../../src/features/runtime-provider-management/contracts';
import type {
  CliInstallationStatus,
  CliProviderStatus,
  IpcResult,
} from '../../../src/shared/types';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = async (path: string) => hash(await readFile(path));
const sourcePaths = [
  'src/features/runtime-provider-management/core/domain/managedProviderPreferences.ts',
  'src/features/runtime-provider-management/main/infrastructure/FileManagedProviderPreferences.ts',
  'src/features/runtime-provider-management/main/adapters/output/capturedManagementPreferences.ts',
  'src/features/runtime-provider-management/main/adapters/output/CapturedModelProbe.ts',
  'packages/legacy-agent-host/tests/fixtures/native-host.ts',
  'src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth.ts',
  'src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore.ts',
  'src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts',
  'src/features/runtime-provider-management/main/adapters/output/capturedManagementCatalog.ts',
  'src/features/runtime-provider-management/main/composition/createRuntimeProviderManagementFeature.ts',
  'src/features/runtime-provider-management/main/adapters/input/registerRuntimeProviderManagementIpc.ts',
  'src/features/agent-backend/main/composition/DesktopBackendFeature.ts',
  'src/features/agent-backend/main/infrastructure/CapturedProviderManagement.ts',
  'src/features/agent-backend/main/infrastructure/CapturedHostClient.ts',
  'src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor.ts',
  'src/main/ipc/agentBackend.ts',
  'src/main/ipc/cliInstaller.ts',
  'src/main/services/infrastructure/CliInstallerService.ts',
  'src/main/index.ts',
  'src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient.ts',
  'src/features/runtime-provider-management/core/application/RuntimeProviderStatusPort.ts',
  'src/shared/utils/providerStatusAuthority.ts',
  'src/renderer/store/slices/cliInstallerStatusReconciliation.ts',
  'test/features/runtime-provider-management/capturedManagement.safe-e2e.test.ts',
];

it('actual IPC facade → captured Desktop owner → standalone Host → separate TEST native process, without Team bootstrap or fork', async () => {
  const repo = resolve(import.meta.dirname, '../../..');
  const hostTrees = {
    sourceSha256: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
    distSha256: await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'),
  };
  const sourceHashes = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (path) => [path, await digest(join(repo, path))]))
  );
  const node = await realpath(
    join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
  );
  expect(await realpath(process.execPath)).toBe(node);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-oauth-host-desktop-management-')));
  console.log(`TEST management E2E receipt: ${join(root, 'desktop-management-receipt.json')}`);
  for (const name of [
    'home',
    'tmp',
    'workspace',
    'config',
    'data',
    'cache',
    'bin',
    'store',
    'userData',
    'preferences',
    'preferences/global',
    'preferences/project',
  ])
    await mkdir(join(root, name), { mode: 0o700 });
  const fixtureSource = join(
    repo,
    'packages/legacy-agent-host/tests/fixtures/management-opencode-process.ts'
  );
  const fixturePath = join(root, 'bin/TEST-opencode.ts');
  await writeFile(fixturePath, `#!${node}\n` + (await readFile(fixtureSource, 'utf8')), {
    mode: 0o700,
  });
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No TEST port');
  await new Promise<void>((done) => reservation.close(() => done()));
  const hostEntry = await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js'));
  const owner = {
    ownerId: 'TEST-owner',
    revision: 'TEST-v1',
    profileId: 'TEST-host',
    protocolVersion: 1 as const,
    buildId: 'TEST-desktop-management',
    storageRoot: join(root, 'store'),
    nodeSha256: await digest(node),
    hostEntrySha256: await digest(hostEntry),
  };
  const environment = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TEST_MANAGEMENT_FIXTURE_ROOT: root,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: {}, model: 'TEST-api/TEST-model' }),
  };
  const nativeProfile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    owner,
    teams: [],
    management: [
      {
        provider: 'opencode',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        accountBinding: 'TEST-account',
        cwd: join(root, 'workspace'),
        endpoint: `http://127.0.0.1:${address.port}`,
        timeoutMs: 10000,
        executable: { path: fixturePath, sha256: await digest(fixturePath) },
        environment,
      },
    ],
  };
  const nativeProfilePath = join(root, 'host-profile.json');
  const nativeBytes = JSON.stringify(nativeProfile);
  await writeFile(nativeProfilePath, nativeBytes, { mode: 0o600 });
  const ref = { ownerId: owner.ownerId, revision: owner.revision };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1,
    defaultOwner: ref,
    handles: [],
    owners: [
      {
        ...ref,
        storageRoot: owner.storageRoot,
        profile: {
          profileId: owner.profileId,
          nodeExecutable: node,
          nodeVersion: 'v24.21.0',
          nodeSha256: owner.nodeSha256,
          hostEntry,
          hostEntrySha256: owner.hostEntrySha256,
          expectedBuildId: owner.buildId,
          cwd: join(root, 'workspace'),
          env: {
            ...environment,
            LEGACY_AGENT_HOST_PROFILE_PATH: nativeProfilePath,
            LEGACY_AGENT_HOST_PROFILE_SHA256: hash(nativeBytes),
          },
          startupTimeoutMs: 10000,
          requestTimeoutMs: 15000,
          writeTimeoutMs: 5000,
          shutdownTimeoutMs: 10000,
        },
      },
    ],
    management: [
      {
        runtimeId: 'opencode',
        owner: ref,
        contextId: 'local',
        projectPath: null,
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        preferences: { projectRoot: null, globalRoot: join(root, 'preferences/global') },
      },
      {
        runtimeId: 'opencode',
        owner: ref,
        contextId: 'local',
        projectPath: join(root, 'workspace'),
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        preferences: {
          projectRoot: join(root, 'preferences/project'),
          globalRoot: join(root, 'preferences/global'),
        },
      },
    ],
  };
  const descriptorPath = join(root, 'desktop-descriptor.json');
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;
  let contextId = 'local';
  const rendererUrl = 'file:///TEST/renderer/index.html';
  const frame = { url: rendererUrl };
  const contents = { mainFrame: frame, getURL: () => rendererUrl, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const sender = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  for (const [key, value] of Object.entries({
    ...environment,
    CLAUDE_ROOT: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'home'),
    CODEX_HOME: join(root, 'config'),
  }))
    vi.stubEnv(key, value);
  const { CliInstallerService } =
    await import('../../../src/main/services/infrastructure/CliInstallerService');
  const {
    initializeCliInstallerHandlers,
    registerCliInstallerHandlers,
    removeCliInstallerHandlers,
  } = await import('../../../src/main/ipc/cliInstaller');
  const oauthProgress: Dto.RuntimeProviderOAuthProgressDto[] = [];
  const openedUrls: string[] = [];
  const connect = () => {
    registerDesktopAgentBackend({
      ipc,
      getMainWindow: () => window,
      getActiveContextId: () => contextId,
      captureActiveSelection: () => {
        const captured = contextId;
        return { contextId: captured, isCurrent: () => contextId === captured };
      },
      rendererIndexPath: '/TEST/renderer/index.html',
      userDataPath: join(root, 'userData'),
      env: {
        AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: descriptorPath,
        AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: hash(descriptorBytes),
      },
    });
    const port = getDesktopProviderManagementPort({
      openExternal: async (url) => {
        openedUrls.push(url);
      },
      emitProgress: (event) => {
        oauthProgress.push(event);
      },
    });
    expect(port).toBeDefined();
    const feature = createRuntimeProviderManagementFeature({ port });
    registerRuntimeProviderManagementIpc(ipc, feature);
    initializeCliInstallerHandlers(
      new CliInstallerService(Date.now, getDesktopProviderStatusPort())
    );
    registerCliInstallerHandlers(ipc);
    return feature;
  };
  const invoke = <T,>(channel: string, payload: unknown) =>
    handlers.get(channel)!({}, payload) as Promise<T>;
  let passed = false;
  let nativePids: number[] = [];
  let shutdowns = 0;
  const close = async () => {
    await shutdownDesktopAgentBackend();
    shutdowns++;
    removeRuntimeProviderManagementIpc(ipc);
    removeCliInstallerHandlers(ipc);
    removeDesktopAgentBackendHandlers();
  };
  try {
    connect();
    const invokeStatus = <T,>(channel: string, ...payload: unknown[]) =>
      handlers.get(channel)!(sender, ...payload) as Promise<IpcResult<T>>;
    const status = await invokeStatus<CliInstallationStatus>(CLI_INSTALLER_GET_STATUS);
    expect(status.success).toBe(true);
    if (!status.success || !status.data) throw new Error('TEST native status unavailable');
    expect(status.data).toMatchObject({
      installed: true,
      binaryPath: null,
      installedVersion: 'TEST-desktop-management',
      supportsSelfUpdate: false,
    });
    expect(status.data.providers.find((p) => p.providerId === 'opencode')).toMatchObject({
      authenticated: false,
      statusCheckOutcome: 'model_only',
      models: expect.arrayContaining(['TEST-api/TEST-model']),
    });
    expect(
      (await readFile(join(root, 'native-effects.ndjson'), 'utf8')).includes(
        'probe-session-created'
      )
    ).toBe(false);
    const deniedSender = await handlers.get(CLI_INSTALLER_GET_STATUS)!({}, {});
    expect(deniedSender).toMatchObject({ success: false });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[IPC:AgentBackend]',
      'Captured backend sender refused',
      { windowAvailable: true, mainSender: false, frameAvailable: false,
        mainFrame: false, frameUrl: false, contentsUrl: true }
    );
    vi.mocked(console.warn).mockClear();
    const directory = await invoke<Dto.RuntimeProviderManagementDirectoryResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
      { runtimeId: 'opencode' }
    );
    expect(directory.error).toBeUndefined();
    expect(directory.directory?.entries.map((row) => row.providerId)).toContain('TEST-api');
    const modelResult = await invoke<Dto.RuntimeProviderManagementModelsResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      { runtimeId: 'opencode', providerId: 'TEST-api' }
    );
    expect(modelResult.models?.models[0]).toMatchObject({
      modelId: 'TEST-api/TEST-model',
      availability: 'untested',
    });
    const setup = await invoke<Dto.RuntimeProviderManagementSetupFormResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
      { runtimeId: 'opencode', providerId: 'TEST-api' }
    );
    expect(setup.setupForm).toMatchObject({
      method: 'api',
      supported: true,
      secret: { required: true },
    });
    const connected = await invoke<Dto.RuntimeProviderManagementProviderResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
      { runtimeId: 'opencode', providerId: 'TEST-api', apiKey: 'TEST-api-key' }
    );
    expect(connected.error).toBeUndefined();
    expect(connected.provider?.state).toBe('connected');
    const authPath = join(root, 'data/opencode/auth.json');
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
      'TEST-api': { type: 'api', key: 'TEST-api-key' },
    });
    const forgotten = await invoke<Dto.RuntimeProviderManagementProviderResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_FORGET,
      { runtimeId: 'opencode', providerId: 'TEST-api' }
    );
    expect(forgotten.provider?.state).toBe('not-connected');
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({});
    const publicText = JSON.stringify([directory, modelResult, connected, forgotten]);
    for (const forbidden of [
      'TEST-api-key',
      'TEST-management',
      'TEST-account',
      'nodeExecutable',
      root,
    ])
      expect(publicText).not.toContain(forbidden);
    const oauthSetup = await invoke<Dto.RuntimeProviderManagementSetupFormResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
      { runtimeId: 'opencode', providerId: 'TEST-oauth-code' }
    );
    expect(oauthSetup.setupForm).toMatchObject({
      method: 'oauth',
      supported: true,
      authOptions: [expect.objectContaining({ methodIndex: 0, id: 'oauth:0', supported: true })],
    });
    const codeInput = {
      runtimeId: 'opencode',
      providerId: 'TEST-oauth-code',
      method: 'oauth',
      authMethodIndex: 0,
      authOptionId: 'oauth:0',
      oauthOperationId: 'TEST-main-code-flow',
    };
    const codePending = invoke<Dto.RuntimeProviderManagementProviderResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
      codeInput
    );
    await vi.waitFor(
      () =>
        expect(
          oauthProgress.some(
            (event) =>
              event.operationId === codeInput.oauthOperationId && event.phase === 'waiting-for-code'
          )
        ).toBe(true),
      { timeout: 10000 }
    );
    expect(
      await invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE, {
        operationId: codeInput.oauthOperationId,
        code: 'TEST-correct-code',
      })
    ).toEqual({ ok: true });
    expect((await codePending).provider?.state).toBe('connected');
    expect(JSON.parse(await readFile(authPath, 'utf8'))['TEST-oauth-code']?.type).toBe('oauth');
    expect(
      (
        await invoke<Dto.RuntimeProviderManagementProviderResponse>(
          RUNTIME_PROVIDER_MANAGEMENT_FORGET,
          { runtimeId: 'opencode', providerId: 'TEST-oauth-code' }
        )
      ).provider?.state
    ).toBe('not-connected');
    const autoInput = {
      ...codeInput,
      providerId: 'TEST-oauth-auto',
      oauthOperationId: 'TEST-main-auto-flow',
    };
    const autoPending = invoke<Dto.RuntimeProviderManagementProviderResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
      autoInput
    );
    await vi.waitFor(
      () =>
        expect(
          oauthProgress.some(
            (event) =>
              event.operationId === autoInput.oauthOperationId && event.phase === 'completing'
          )
        ).toBe(true),
      { timeout: 10000 }
    );
    expect(
      await invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL, {
        operationId: autoInput.oauthOperationId,
      })
    ).toEqual({ ok: true });
    expect((await autoPending).error).toBeDefined();
    await writeFile(join(root, 'release-auto'), 'TEST retired callback must never write');
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({});
    expect(openedUrls).toHaveLength(2);
    const journalDirectory = join(root, 'userData/agent-backend/oauth-intents');
    for (const name of await readdir(journalDirectory)) {
      const journal = await readFile(join(journalDirectory, name), 'utf8');
      for (const forbidden of ['TEST-private', 'TEST-correct-code', 'authorizationUrl', root])
        expect(journal).not.toContain(forbidden);
    }
    const safeProgress = JSON.stringify(oauthProgress);
    for (const forbidden of ['TEST-private', 'TEST-correct-code', 'authorizationUrl', root])
      expect(safeProgress).not.toContain(forbidden);
    const tested = await invoke<Dto.RuntimeProviderManagementModelTestResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
      {
        runtimeId: 'opencode',
        providerId: 'TEST-api',
        modelId: 'TEST-api/TEST-model',
        requestGroupId: 'TEST-probe-success',
      }
    );
    expect(tested.result).toMatchObject({ ok: true, availability: 'available' });
    expect(JSON.stringify(tested)).not.toContain('TEST-private-model-response');
    const blocked = invoke<Dto.RuntimeProviderManagementModelTestResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
      {
        runtimeId: 'opencode',
        providerId: 'TEST-api',
        modelId: 'TEST-api/TEST-blocked',
        requestGroupId: 'TEST-probe-blocked',
      }
    );
    await vi.waitFor(
      async () =>
        expect(
          (await readFile(join(root, 'native-effects.ndjson'), 'utf8')).includes(
            '"modelId":"TEST-blocked"'
          )
        ).toBe(true),
      { timeout: 10000 }
    );
    expect(
      await invoke(RUNTIME_PROVIDER_MANAGEMENT_CANCEL_MODEL_TEST, {
        requestGroupId: 'TEST-probe-blocked',
      })
    ).toEqual({ ok: true });
    expect((await blocked).error).toBeDefined();
    await writeFile(join(root, 'release-probe'), 'TEST cancelled model request cannot publish');
    const afterCancel = await readFile(join(root, 'native-effects.ndjson'), 'utf8');
    expect(
      afterCancel.split('\n').filter((line) => line.includes('"event":"model-response"'))
    ).toHaveLength(1);
    const projectPreferencePath = join(
      root,
      'preferences/project/agent-teams-runtime-preferences.json'
    );
    const globalPreferencePath = join(root, 'preferences/global/global-runtime-preferences.json');
    const preservedLimits = {
      'TEST-api/TEST-model': { contextTokens: 2048, outputTokens: 256, updatedAt: null },
    };
    await writeFile(
      globalPreferencePath,
      JSON.stringify({
        schemaVersion: 1,
        defaultModelId: 'TEST-api/TEST-blocked',
        modelLimitOverrides: preservedLimits,
        custom: 'TEST-global-preserved',
      }),
      { mode: 0o644 }
    );
    await writeFile(
      projectPreferencePath,
      JSON.stringify({
        schemaVersion: 2,
        defaultModelId: 'TEST-api/TEST-model',
        modelLimitOverrides: {},
        custom: 'TEST-project-preserved',
      }),
      { mode: 0o644 }
    );
    expect(
      (
        await invoke<Dto.RuntimeProviderManagementViewResponse>(RUNTIME_PROVIDER_MANAGEMENT_VIEW, {
          runtimeId: 'opencode',
          projectPath: join(root, 'workspace'),
        })
      ).view
    ).toMatchObject({ defaultModel: 'TEST-api/TEST-model', defaultModelSource: 'project' });
    expect(
      (
        await invoke<Dto.RuntimeProviderManagementViewResponse>(
          RUNTIME_PROVIDER_MANAGEMENT_CLEAR_PROJECT_DEFAULT,
          { runtimeId: 'opencode', projectPath: join(root, 'workspace') }
        )
      ).view
    ).toMatchObject({
      projectDefaultModel: null,
      defaultModel: 'TEST-api/TEST-blocked',
      defaultModelSource: 'all_projects',
    });
    const globalSaved = await invoke<Dto.RuntimeProviderManagementViewResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
      {
        runtimeId: 'opencode',
        providerId: 'TEST-api',
        modelId: 'TEST-api/TEST-model',
        scope: 'all_projects',
        projectPath: join(root, 'workspace'),
      }
    );
    expect(globalSaved.view).toMatchObject({
      projectPath: null,
      defaultModel: 'TEST-api/TEST-model',
      allProjectsDefaultModel: 'TEST-api/TEST-model',
    });
    expect(
      (
        await invoke<Dto.RuntimeProviderManagementViewResponse>(
          RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
          {
            runtimeId: 'opencode',
            providerId: 'TEST-api',
            modelId: 'TEST-api/TEST-model',
            scope: 'project',
            projectPath: join(root, 'workspace'),
          }
        )
      ).view
    ).toMatchObject({ defaultModelSource: 'project' });
    expect(JSON.parse(await readFile(globalPreferencePath, 'utf8'))).toMatchObject({
      modelLimitOverrides: preservedLimits,
      custom: 'TEST-global-preserved',
    });
    expect(JSON.parse(await readFile(projectPreferencePath, 'utf8'))).toMatchObject({
      custom: 'TEST-project-preserved',
    });
    const preferenceModels = await invoke<Dto.RuntimeProviderManagementModelsResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      { runtimeId: 'opencode', providerId: 'TEST-api', projectPath: join(root, 'workspace') }
    );
    expect(
      preferenceModels.models?.models.find((model) => model.modelId === 'TEST-api/TEST-model')
    ).toMatchObject({ default: true, managedContextTokens: 2048, managedOutputTokens: 256 });
    const configured = await invoke<Dto.RuntimeProviderManagementModelLimitsResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS,
      {
        runtimeId: 'opencode',
        providerId: 'TEST-api',
        modelId: 'TEST-api/TEST-model',
        projectPath: join(root, 'workspace'),
        contextTokens: 3072,
        outputTokens: 192,
      }
    );
    expect(configured.result).toMatchObject({
      saved: true,
      verified: true,
      contextTokens: 3072,
      outputTokens: 192,
    });
    expect(JSON.parse(await readFile(projectPreferencePath, 'utf8'))).toMatchObject({
      defaultModelId: 'TEST-api/TEST-model',
      custom: 'TEST-project-preserved',
      modelLimitOverrides: { 'TEST-api/TEST-model': { contextTokens: 3072, outputTokens: 192 } },
    });
    const testedSavedLimits = await invoke<Dto.RuntimeProviderManagementModelTestResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
      {
        runtimeId: 'opencode',
        providerId: 'TEST-api',
        modelId: 'TEST-api/TEST-model',
        projectPath: join(root, 'workspace'),
      }
    );
    expect(testedSavedLimits.result?.ok).toBe(true);
    const limitEffects = (await readFile(join(root, 'native-effects.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      limitEffects.filter(
        (event) => event.event === 'model-request-start' && event.effectiveLimits?.context === 3072
      )
    ).toEqual([
      expect.objectContaining({ effectiveLimits: { context: 3072, output: 192 } }),
      expect.objectContaining({ effectiveLimits: { context: 3072, output: 192 } }),
    ]);
    await close();
    connect();
    // Original control is restored from the private Main journal after process restart.
    expect(
      await invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL, {
        operationId: autoInput.oauthOperationId,
      })
    ).toEqual({ ok: true });
    expect(openedUrls).toHaveLength(2);
    expect(
      await invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE, {
        operationId: autoInput.oauthOperationId,
        code: 'TEST-stale-code',
      })
    ).toEqual(expect.objectContaining({ ok: false }));
    const restored = await invoke<Dto.RuntimeProviderManagementDirectoryResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
      { runtimeId: 'opencode' }
    );
    expect(restored.directory?.entries.find((row) => row.providerId === 'TEST-api')?.state).toBe(
      'not-connected'
    );
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({});
    expect(
      (
        await invoke<Dto.RuntimeProviderManagementViewResponse>(RUNTIME_PROVIDER_MANAGEMENT_VIEW, {
          runtimeId: 'opencode',
          projectPath: join(root, 'workspace'),
        })
      ).view
    ).toMatchObject({ defaultModelSource: 'project', defaultModel: 'TEST-api/TEST-model' });
    const restoredModels = await invoke<Dto.RuntimeProviderManagementModelsResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      { runtimeId: 'opencode', providerId: 'TEST-api', projectPath: join(root, 'workspace') }
    );
    expect(
      restoredModels.models?.models.find((model) => model.modelId === 'TEST-api/TEST-model')
    ).toMatchObject({
      managedContextTokens: 3072,
      managedOutputTokens: 192,
    });
    const verified = await invokeStatus<CliProviderStatus>(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'opencode'
    );
    expect(verified.success).toBe(true);
    if (!verified.success) throw new Error('TEST native verification unavailable');
    expect(verified.data?.modelAvailability).toContainEqual(
      expect.objectContaining({ modelId: 'TEST-api/TEST-model', status: 'available' })
    );
    expect(verified.data?.authenticated).toBe(false);
    contextId = 'foreign';
    const denied = await invoke<Dto.RuntimeProviderManagementDirectoryResponse>(
      RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
      { runtimeId: 'opencode' }
    );
    expect(denied.directory).toBeUndefined();
    expect(denied.error?.code).toBe('runtime-unhealthy');
    const foreign = await invokeStatus<CliInstallationStatus>(CLI_INSTALLER_GET_STATUS);
    if (foreign.success && foreign.data) {
      expect(foreign.data.installed).toBe(false);
      expect(foreign.data.providers.flatMap((p) => p.models)).toEqual([]);
    }
    const providerForeign = await invokeStatus<CliProviderStatus>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode'
    );
    if (providerForeign.success) expect(providerForeign.data?.models).toEqual([]);

    passed = true;
  } finally {
    await close();
    vi.unstubAllEnvs();
    const events = (await readFile(join(root, 'native-effects.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; pid: number });
    nativePids = [...new Set(events.map((event) => event.pid))];
    for (const pid of nativePids)
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    expect(events.filter((event) => event.event === 'credential-written')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'credential-forgotten')).toHaveLength(2);
    await writeFile(
      join(root, 'desktop-management-receipt.json'),
      JSON.stringify(
        {
          status: passed ? 'PASS' : 'INCOMPLETE',
          scope:
            'Main IPC facade / actual Host / TEST HTTP process only; no Electron controls, vendor OAuth, real account or model proof',
          nodeSha256: owner.nodeSha256,
          hostEntrySha256: owner.hostEntrySha256,
          fixtureSourceSha256: await digest(fixtureSource),
          sourceHashes,
          hostTrees,
          nativePids,
          nativePidsAbsent: true,
          shutdowns,
          events,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    for (const path of sourcePaths) expect(await digest(join(repo, path))).toBe(sourceHashes[path]);
  }
}, 60000);
