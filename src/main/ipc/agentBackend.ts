import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hostTeamSelectionKey,
  STOPPED_TEAM_IMPORT_CHANNEL,
  TeamCreationRefusal,
} from '@features/agent-backend/contracts';
import {
  captureLegacyStoppedSource,
  createCapturedReviewWatch,
  createConfiguredHostTeam,
  createLaunchedHostTeam,
  DesktopBackendFeature,
  FileTeamModelProbeIntents,
  ForegroundModelChecks,
  importStoppedLegacyTeam,
  prepareCapturedTeamModels,
  prepareHostNotification,
  registerAgentBackendIpc,
  registerBackendConnectionsIpc,
  registerCapturedReviewWatchIpc,
} from '@features/agent-backend/main';
import { FileCodexAuthIntentStore } from '@features/runtime-provider-management/main';
import { createCapturedCodexFeatures } from '@features/runtime-provider-management/main';
import {
  createCapturedRuntimeProviderManagementClient,
  createCapturedRuntimeProviderStatusClient,
  FileProviderOAuthIntentStore,
} from '@features/runtime-provider-management/main';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { createLogger } from '@shared/utils/logger';
import { shell } from 'electron';

import { configureCapturedExtensionCommandRunner } from '../services/extensions/runtime/CapturedExtensionCommandLedger';
import { CapturedNativeExtensions } from '../services/extensions/runtime/CapturedNativeExtensions';
import { CapturedSkills } from '../services/extensions/skills/CapturedSkills';
import { CapturedSkillsCache } from '../services/extensions/skills/CapturedSkillsCache';
import { CapturedSkillsCollection } from '../services/extensions/skills/CapturedSkillsCollection';
import { getDevRendererLocation } from '../utils/rendererLocation';

import type { NativeExtensionCapture } from '../services/extensions/runtime/CapturedNativeExtensions';
import type { CapturedSkillsCapture } from '../services/extensions/skills/CapturedSkillsCollection';
import type { StoppedTeamImportResult } from '@features/agent-backend/contracts';
import type {
  CapturedReviewWatch,
  CapturedTeamModelRequest,
  LegacyStoppedSourceOwners,
} from '@features/agent-backend/main';
import type { ApplicationCommandRunner } from '@features/application-command-ledger';
import type { CodexAccountAuthMode } from '@features/codex-account/contracts';
import type { RuntimeProviderOAuthProgressDto } from '@features/runtime-provider-management/contracts';
import type {
  TeamCreateConfigResponse,
  TeamCreateResponse,
  TeamProvisioningPrepareContext,
  TeamProvisioningPrepareResult,
} from '@shared/types/team';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

interface BackendShellOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  getMainWindow(): BrowserWindow | null;
  getActiveContextId(): string;
  captureActiveSelection(): { contextId: string; isCurrent(): boolean };
  rendererIndexPath: string;
  userDataPath: string;
  /** Captured main-process environment, never renderer arguments. */
  env: Readonly<Record<string, string | undefined>>;
}

function withoutHash(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Only the app's selected main frame may exercise configured backend handles. */
export function captureBackendSenderContext(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  expectedRendererUrl: string,
  getActiveContextId: () => string
): string | null {
  if (!window || window.isDestroyed()) return null;
  const contents = window.webContents;
  const expected = withoutHash(expectedRendererUrl);
  if (
    !expected ||
    contents.isDestroyed() ||
    event.sender !== contents ||
    !event.senderFrame ||
    event.senderFrame !== contents.mainFrame ||
    withoutHash(event.senderFrame.url) !== expected ||
    withoutHash(contents.getURL()) !== expected
  )
    return null;
  return getActiveContextId();
}

let active:
  | {
      feature: DesktopBackendFeature;
      removeHandlers: () => void;
      captureSelection: BackendShellOptions['captureActiveSelection'];
      captureSender: (event: IpcMainInvokeEvent) => string | null;
      selected: boolean;
      userDataPath: string;
      savedTeamChecks: ForegroundModelChecks;
      reviewWatch?: { window: BrowserWindow; bridge: CapturedReviewWatch };
    }
  | undefined;

function createCapturedSenderGuard(
  original: NonNullable<typeof active>,
  event: IpcMainInvokeEvent,
  contextId: string,
  contextSelection: ReturnType<BackendShellOptions['captureActiveSelection']> | undefined
): () => boolean {
  return () =>
    active === original &&
    original.captureSender(event) === contextId &&
    contextSelection?.isCurrent() === true;
}

let stoppedImportOwners:
  | { owners: LegacyStoppedSourceOwners; isCurrent(contextId: string): boolean }
  | undefined;
let desktopCommandRunner: ApplicationCommandRunner | null = null;
/** Composition supplies actual legacy owners; replacements revoke every prior source capture. */
export function configureDesktopStoppedImportOwners(
  owners: Omit<LegacyStoppedSourceOwners, 'launch'>,
  isCurrent: (contextId: string) => boolean
): void {
  stoppedImportOwners = { owners: { ...owners, launch: new TeamLaunchStateStore() }, isCurrent };
}
function stoppedImport(
  original: NonNullable<typeof active>,
  contextId: string,
  request: unknown,
  current: () => boolean
): Promise<StoppedTeamImportResult> {
  const captured = stoppedImportOwners;
  if (!original.selected || !captured || !captured.isCurrent(contextId))
    return Promise.resolve({ ok: false, reason: 'unsupported', outcome: 'not-dispatched' });
  const isCurrent = () =>
    active === original &&
    stoppedImportOwners === captured &&
    current() &&
    captured.isCurrent(contextId);
  return importStoppedLegacyTeam({
    feature: original.feature,
    contextId,
    request,
    guard: { isCurrent },
    owners: captured.owners,
    captureSource: (teamName) => captureLegacyStoppedSource(teamName, contextId, isCurrent),
  });
}

/** HTTP startup captures this shell/context once; replacement never silently selects a new owner. */
export function captureDesktopAgentBackendHttpScope() {
  const original = active;
  if (!original) return undefined;
  const contextSelection = original.captureSelection();
  const contextId = contextSelection.contextId;
  return Object.freeze({
    feature: original.feature,
    contextId,
    isCurrent: () => active === original && contextSelection?.isCurrent() === true,
    importStoppedTeam: (request: unknown) =>
      stoppedImport(
        original,
        contextId,
        request,
        () => active === original && contextSelection.isCurrent()
      ),
  });
}

/** Main's existing backup timer only; no renderer/backend/owner selector is accepted. */
export async function runDesktopHostBackup(mode: 'snapshot' | 'reconcile'): Promise<void> {
  const scope = captureDesktopAgentBackendHttpScope();
  if (!scope || !isDesktopAgentBackendSelected())
    throw new Error('Captured Host backup unavailable');
  const captured = await scope.feature.captureBackup(scope.contextId, {
    isCurrent: scope.isCurrent,
  });
  await captured.run(mode);
}

/** The existing Main backup owner keeps its timer; selection supplies only its captured Host callbacks. */
export function configureDesktopHostBackup(owner: {
  configureSelectedHostBackup(backup: { startup(): Promise<void>; tick(): Promise<void> }): void;
}): void {
  if (isDesktopAgentBackendSelected())
    owner.configureSelectedHostBackup({
      startup: () => runDesktopHostBackup('reconcile'),
      tick: () => runDesktopHostBackup('snapshot'),
    });
}

/** Main supplies the existing durable owners before backend UI mutations become available. */
export function configureDesktopBackendPersistence(
  backupOwner: Parameters<typeof configureDesktopHostBackup>[0],
  commandRunner: ApplicationCommandRunner | null
): void {
  desktopCommandRunner = commandRunner;
  configureCapturedExtensionCommandRunner(commandRunner);
  configureDesktopHostBackup(backupOwner);
}

export function isDesktopAgentBackendSelected(): boolean {
  return active?.selected ?? false;
}

/** Existing notification IPC retains the authenticated foreground and original Host handle. */
export async function captureDesktopHostNotification(event: IpcMainInvokeEvent, data: unknown) {
  const original = active,
    contextSelection = original?.captureSelection(),
    contextId = original?.captureSender(event);
  if (!original?.selected || !contextId || contextId !== contextSelection?.contextId)
    throw new Error('Captured Host notification context unavailable');
  const isCurrent = () =>
    active === original &&
    contextSelection.isCurrent() &&
    original.captureSender(event) === contextId;
  return prepareHostNotification(
    {
      initialize: () => original.feature.initialize(),
      isCurrent,
      connection: (handle) =>
        isCurrent() && original.feature.authorizeHandle(contextId, handle)
          ? original.feature
              .listBindings(contextId)
              .bindings.find((row) => row.handle.handleId === handle.handleId)
          : undefined,
      async readSnapshot(handle, current) {
        const result = await original.feature.facade.invoke(
          { handle, commandId: randomUUID(), operation: 'team.snapshot', payload: {} },
          { isCurrent: current }
        );
        if (
          !result.ok ||
          !result.value ||
          !('tasks' in result.value) ||
          !('members' in result.value)
        )
          throw new Error('Original Host notification source unavailable');
        return result.value;
      },
    },
    data
  );
}

/** Existing Create-config IPC captures the same selected shell, never a renderer owner selector. */
export async function createDesktopCapturedTeamConfiguration(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<TeamCreateConfigResponse> {
  const original = active,
    contextSelection = original?.captureSelection(),
    contextId = original?.captureSender(event);
  if (!original?.selected || !contextId)
    throw new Error('Captured Host creation context unavailable.');
  const isCurrent = createCapturedSenderGuard(original, event, contextId, contextSelection);
  return createConfiguredHostTeam({
    feature: original.feature,
    contextId,
    request,
    guard: { isCurrent },
  });
}

/** A Create operation captures the same shell/context for every private Host request. */
function captureCreationScope(event: IpcMainInvokeEvent) {
  const original = active,
    contextSelection = original?.captureSelection(),
    contextId = original?.captureSender(event);
  if (!original?.selected || !contextId)
    throw new Error('Captured Host creation context unavailable.');
  const isCurrent = createCapturedSenderGuard(original, event, contextId, contextSelection);
  return { feature: original.feature, contextId, guard: { isCurrent } };
}

export async function prepareDesktopCreatedTeam(
  event: IpcMainInvokeEvent,
  context: Extract<TeamProvisioningPrepareContext, { kind: 'create' }>,
  cwd?: string
): Promise<TeamProvisioningPrepareResult> {
  try {
    const scope = captureCreationScope(event);
    if (!context.draft || !cwd || context.draft.cwd !== cwd)
      throw new Error('Create draft workspace unavailable.');
    if (!context.preparationId) throw new Error('Create preparation unavailable.');
    return await scope.feature.prepareCreatedTeam(
      scope.contextId,
      context.preparationId,
      context.draft,
      scope.guard
    );
  } catch {
    return {
      ready: false,
      message:
        'Captured Host creation check unavailable. Refresh the unchanged form; no legacy checks were run.',
    };
  }
}

export async function createDesktopCapturedTeam(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<TeamCreateResponse> {
  let submitted = false;
  try {
    const scope = captureCreationScope(event);
    const target = await scope.feature.captureTeamCreation(scope.contextId, scope.guard);
    return await createLaunchedHostTeam({
      ...scope,
      target: {
        ...target,
        submit: (...args) => {
          submitted = true;
          return target.submit(...args);
        },
      },
      request,
    });
  } catch (error) {
    if (!submitted) throw new TeamCreationRefusal('unavailable', 'not-dispatched');
    throw error;
  }
}

/** Existing Team dialog checks retain this shell, context and handle through cleanup. */
export async function prepareDesktopCapturedTeam(
  event: IpcMainInvokeEvent,
  selection: string,
  request: CapturedTeamModelRequest
): Promise<TeamProvisioningPrepareResult> {
  const original = active;
  const capturedRequest = structuredClone(request);
  const contextSelection = original?.captureSelection();
  const contextId = original?.captureSender(event);
  const denied = { ready: false, message: 'Captured Host provisioning context is unavailable.' };
  if (!original?.selected || !contextId) return denied;
  const current = createCapturedSenderGuard(original, event, contextId, contextSelection);
  try {
    return await original.savedTeamChecks.run(
      JSON.stringify([contextId, selection, capturedRequest]),
      async (isLatest) => {
        await original.feature.initialize();
        if (!current() || !isLatest()) return denied;
        const connection = original.feature
          .listBindings(contextId)
          .bindings.find((entry) => hostTeamSelectionKey(entry.handle.handleId) === selection);
        if (!connection) return denied;
        const isCurrent = () =>
          isLatest() && current() && original.feature.authorizeHandle(contextId, connection.handle);
        return await prepareCapturedTeamModels({
          handle: connection.handle,
          request: capturedRequest,
          isCurrent,
          intents: new FileTeamModelProbeIntents(
            join(original.userDataPath, 'agent-backend', 'team-model-intents'),
            original.userDataPath
          ),
          backend: {
            invoke: (input) =>
              original.feature.facade.invoke(
                input,
                // Only cleanup may outlive foreground authority; it still addresses
                // the original authorized descriptor/handle and original probe ID.
                input.operation === 'team.launch.probe.cancel' ? undefined : { isCurrent }
              ),
          },
        });
      }
    );
  } catch {
    return denied;
  }
}

/** The selected path is exclusive, including partial/invalid configuration. */
export function getDesktopProviderManagementPort(oauth?: {
  openExternal(url: string): Promise<void>;
  emitProgress?(event: RuntimeProviderOAuthProgressDto): void;
}) {
  const original = active;
  if (!original?.selected) return undefined;
  return createCapturedRuntimeProviderManagementClient({
    captureClaude: (projectPath, isCurrent) => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.captureProviderManagement(
        contextId,
        projectPath,
        {
          isCurrent: () =>
            active === original &&
            contextSelection?.isCurrent() === true &&
            (isCurrent?.() ?? true),
        },
        'claude'
      );
    },
    capture: (projectPath, isCurrent) => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.captureProviderManagement(contextId, projectPath, {
        isCurrent: () =>
          active === original && contextSelection?.isCurrent() === true && (isCurrent?.() ?? true),
      });
    },
    ...(oauth
      ? {
          oauth: {
            ...oauth,
            intents: new FileProviderOAuthIntentStore(
              join(original.userDataPath, 'agent-backend', 'oauth-intents')
            ),
            restore: (targetId: string) => {
              const contextSelection = original.captureSelection();
              const contextId = contextSelection.contextId;
              return original.feature.restoreProviderManagement(contextId, targetId, {
                isCurrent: () => active === original && contextSelection?.isCurrent() === true,
              });
            },
          },
        }
      : {}),
  });
}

/** Finite existing Extensions choices, bound to the original sender and native Claude namespace. */
export const captureDesktopNativeExtensions: NativeExtensionCapture = (
  event,
  projectPath,
  selection
) => {
  const original = active;
  if (!original?.selected) return undefined;
  const isCurrent = captureDesktopStatusRequest(event);
  if (!isCurrent?.()) throw new Error('Original extension sender is unavailable');
  const context = original.captureSelection();
  return original.feature
    .captureProviderManagement(context.contextId, projectPath ?? null, { isCurrent }, 'claude')
    .then((owner) => CapturedNativeExtensions.capture(owner, selection));
};

const skillsCache = new CapturedSkillsCache();
/** Cached original sender/context and trusted descriptor choices; renderer paths grant no authority. */
export const captureDesktopSkills: CapturedSkillsCapture = (event, projectPath) => {
  const original = active;
  if (!original?.selected) return undefined;
  if (projectPath !== undefined && typeof projectPath !== 'string')
    throw new Error('Invalid Skills project selection');
  const current = captureDesktopStatusRequest(event);
  if (!current?.()) throw new Error('Original Skills sender is unavailable');
  const context = original.captureSelection();
  const key = JSON.stringify([event.sender.id, context.contextId, projectPath ?? null]);
  return skillsCache.capture(key, current, async () => {
    const choices = await original.feature.captureSkillsManagement(
      context.contextId,
      projectPath ?? null,
      { isCurrent: current }
    );
    const scopes = projectPath ? ['user' as const, 'project' as const] : ['user' as const];
    const roots = await Promise.all(
      choices.flatMap(({ rootKind, owner }) =>
        scopes.map((scope) =>
          CapturedSkills.capture({
            owner,
            contextId: context.contextId,
            scope,
            rootKind,
            trashItem: (path) => shell.trashItem(path),
          })
        )
      )
    );
    return new CapturedSkillsCollection(roots, current);
  });
};

/** Native Codex metadata uses an explicit runtime binding, including when another runtime is the default. */
export function getDesktopCodexFeatures(preferredAuthMode?: () => CodexAccountAuthMode) {
  const original = active;
  if (!original?.selected) return undefined;
  return createCapturedCodexFeatures(
    (projectPath) => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.captureProviderManagement(
        contextId,
        projectPath,
        {
          isCurrent: () => active === original && contextSelection?.isCurrent() === true,
        },
        'codex'
      );
    },
    new FileCodexAuthIntentStore(
      join(original.userDataPath, 'agent-backend', 'codex-auth-intents')
    ),
    preferredAuthMode
  );
}

/** Finite original foreground authority for status replies; no renderer-owned context selector. */
export function captureDesktopStatusRequest(event: IpcMainInvokeEvent): (() => boolean) | null {
  const original = active;
  const contextSelection = original?.captureSelection();
  const contextId = original?.captureSender(event);
  return original?.selected &&
    contextId &&
    contextId === contextSelection?.contextId &&
    contextSelection.isCurrent()
    ? () =>
        active === original &&
        original.captureSender(event) === contextId &&
        contextSelection?.isCurrent() === true
    : null;
}

export function getDesktopProviderStatusPort() {
  const original = active;
  if (!original?.selected) return undefined;
  const capture = (projectPath: string | null, isCurrent?: () => boolean) => {
    const contextSelection = original.captureSelection();
    const contextId = contextSelection.contextId;
    return original.feature.captureProviderManagement(contextId, projectPath, {
      isCurrent: () =>
        active === original && contextSelection?.isCurrent() === true && (isCurrent?.() ?? true),
    });
  };
  return createCapturedRuntimeProviderStatusClient({
    capture,
    captureClaude: (projectPath) => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.captureProviderManagement(
        contextId,
        projectPath,
        { isCurrent: () => active === original && contextSelection?.isCurrent() === true },
        'claude'
      );
    },
    captureCodex: (projectPath) => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.captureProviderManagement(
        contextId,
        projectPath,
        {
          isCurrent: () => active === original && contextSelection?.isCurrent() === true,
        },
        'codex'
      );
    },
    captureGuard: () => {
      const contextSelection = original.captureSelection();
      return () => active === original && contextSelection?.isCurrent() === true;
    },
    readHealth: () => {
      const contextSelection = original.captureSelection();
      const contextId = contextSelection.contextId;
      return original.feature.readRuntimeHealth(contextId, {
        isCurrent: () => active === original && contextSelection?.isCurrent() === true,
      });
    },
  });
}

export function registerDesktopAgentBackend(options: BackendShellOptions): void {
  if (active) throw new Error('Agent backend handlers already registered');
  const env = { ...options.env };
  const expectedRendererUrl =
    env.NODE_ENV === 'development'
      ? getDevRendererLocation(env).url
      : pathToFileURL(options.rendererIndexPath).href;
  const path = env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH;
  const sha256 = env.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256;
  const feature = new DesktopBackendFeature({
    // Partial/invalid configuration must fail closed, not select another backend.
    descriptor: path || sha256 ? { path: path ?? '', sha256: sha256 ?? '' } : null,
    bindingDirectory: join(options.userDataPath, 'agent-backend', 'bindings'),
    commandRunner: () => desktopCommandRunner,
    onInitializationFailure: (phase, code) =>
      createLogger('IPC:AgentBackend').warn('Captured backend initialization held', {
        phase,
        code,
      }),
  });
  let reportedSenderRefusal = false;
  const captureContext = (event: IpcMainInvokeEvent): string | null => {
    const window = options.getMainWindow();
    const context = captureBackendSenderContext(
      event,
      window,
      expectedRendererUrl,
      options.getActiveContextId
    );
    if (context === null && !reportedSenderRefusal) {
      reportedSenderRefusal = true;
      // Boolean equality witnesses only: no private URLs, project IDs or paths.
      try {
        const contents = window && !window.isDestroyed() ? window.webContents : null;
        createLogger('IPC:AgentBackend').warn('Captured backend sender refused', {
          windowAvailable: !!contents && !contents.isDestroyed(),
          mainSender: event.sender === contents,
          frameAvailable: !!event.senderFrame,
          mainFrame: !!contents && event.senderFrame === contents.mainFrame,
          frameUrl: withoutHash(event.senderFrame?.url ?? '') === withoutHash(expectedRendererUrl),
          contentsUrl:
            !!contents && withoutHash(contents.getURL()) === withoutHash(expectedRendererUrl),
        });
      } catch {
        /* An already destroyed frame remains refused. */
      }
    }
    return context;
  };
  const removeConnections = registerBackendConnectionsIpc(
    options.ipc,
    feature,
    captureContext,
    () => options.captureActiveSelection()
  );
  options.ipc.handle(STOPPED_TEAM_IMPORT_CHANNEL, (event, request: unknown) => {
    const original = active,
      contextSelection = original?.captureSelection(),
      contextId = captureContext(event);
    if (!original || !contextId)
      return { ok: false, reason: 'unsupported', outcome: 'not-dispatched' };
    return stoppedImport(
      original,
      contextId,
      request,
      () => contextSelection?.isCurrent() === true && captureContext(event) === contextId
    );
  });
  const removeOperations = registerAgentBackendIpc(
    options.ipc,
    feature.facade,
    async (event, request) => {
      const contextSelection = options.captureActiveSelection();
      const contextId = captureContext(event);
      if (!contextId) return false;
      await feature.initialize();
      const isCurrent = () =>
        contextSelection.isCurrent() &&
        captureContext(event) === contextId &&
        feature.authorizeHandle(contextId, request.handle);
      return isCurrent() ? { isCurrent } : false;
    }
  );
  const retireReplacedWatchWindow = () => {
    const original = active;
    if (
      original?.feature === feature &&
      original.reviewWatch &&
      original.reviewWatch.window !== options.getMainWindow()
    ) {
      original.reviewWatch.bridge.dispose();
      original.reviewWatch = undefined;
    }
  };
  const removeReviewWatch = registerCapturedReviewWatchIpc(options.ipc, {
    async captureWatch(event, request) {
      retireReplacedWatchWindow();
      const original = active;
      const window = options.getMainWindow();
      const contextSelection = options.captureActiveSelection();
      const contextId = captureBackendSenderContext(
        event,
        window,
        expectedRendererUrl,
        options.getActiveContextId
      );
      if (!original?.selected || original.feature !== feature || !window || !contextId) return null;
      const isCurrent = () =>
        active === original &&
        contextSelection.isCurrent() &&
        options.getMainWindow() === window &&
        captureBackendSenderContext(
          event,
          window,
          expectedRendererUrl,
          options.getActiveContextId
        ) === contextId &&
        feature.authorizeHandle(contextId, request.handle);
      await feature.initialize();
      if (!isCurrent()) return null;
      // The first admitted request captures its real window; shell registration may precede creation.
      if (!original.reviewWatch) {
        original.reviewWatch = {
          window,
          bridge: createCapturedReviewWatch({ facade: feature.facade, window }),
        };
        window.once('closed', () => {
          if (original.reviewWatch?.window === window) {
            original.reviewWatch.bridge.dispose();
            original.reviewWatch = undefined;
          }
        });
      }
      if (original.reviewWatch.window !== window) return null;
      return { bridge: original.reviewWatch.bridge, guard: { isCurrent } };
    },
    captureCleanup(event) {
      retireReplacedWatchWindow();
      const original = active;
      const window = options.getMainWindow();
      if (
        original?.feature !== feature ||
        !window ||
        !captureBackendSenderContext(event, window, expectedRendererUrl, options.getActiveContextId)
      )
        return null;
      return {
        owner: window.webContents.mainFrame,
        bridge: original.reviewWatch?.window === window ? original.reviewWatch.bridge : undefined,
      };
    },
  });
  active = {
    feature,
    captureSelection: options.captureActiveSelection,
    captureSender: captureContext,
    selected: Boolean(path || sha256),
    userDataPath: options.userDataPath,
    savedTeamChecks: new ForegroundModelChecks(),
    removeHandlers: () => {
      removeConnections();
      removeOperations();
      removeReviewWatch();
      options.ipc.removeHandler(STOPPED_TEAM_IMPORT_CHANNEL);
      active?.reviewWatch?.bridge.dispose();
    },
  };
}

/** Called at accepted shutdown entry, before any awaited cleanup step. */
export function shutdownDesktopAgentBackend(): Promise<void> {
  // shutdown() synchronously seals allocation/admission, including pending initialization.
  active?.reviewWatch?.bridge.dispose();
  const drain = active?.feature.shutdown();
  return drain ? drain.then(() => undefined) : Promise.resolve();
}

export function removeDesktopAgentBackendHandlers(): void {
  active?.removeHandlers();
  active = undefined;
  stoppedImportOwners = undefined;
  desktopCommandRunner = null;
}
