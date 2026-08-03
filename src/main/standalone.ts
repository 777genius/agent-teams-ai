import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  createHostedCoordinationEventStream,
  type HostedCoordinationEventStream,
} from '@features/coordination-events/main';
import {
  createHostedAccessFeature,
  type CreateHostedAccessFeatureDependencies,
  type HostedAccessFeature,
} from '@features/hosted-access/main';
import { createRecentProjectsFeature } from '@features/recent-projects/main';
import { TEAM_LIFECYCLE_READ_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import {
  createQueryContext,
  type Cursor,
  type Revision,
  type TeamId,
} from '@shared/contracts/hosted';
import { createLogger } from '@shared/utils/logger';

import { createHostedCoordinationEventStreamAuthorizer } from './composition/hosted/hostedCoordinationEventStreamAuthorizer';
import {
  createHostedDiagnosticsComposition,
  type HostedDiagnosticsComposition,
} from './composition/hosted/hostedDiagnosticsComposition';
import { createHostedTaskBoardReadRouteFactory } from './composition/hosted/hostedTaskBoardReadComposition';
import {
  createOptionalTeamLifecycleCommandComposition,
  type TeamLifecycleCommandComposition,
} from './composition/hosted/teamLifecycleCommandComposition';
import {
  readTeamLifecycleReadBootstrapEnvironment,
  TeamLifecycleReadBootstrapSource,
} from './composition/hosted/teamLifecycleReadBootstrapSource';
import {
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
  createUnavailableTeamLifecycleReadHost,
  type TeamLifecycleReadAuthority,
  type TeamLifecycleReadHost,
} from './composition/hosted/teamLifecycleReadComposition';
import { createTeamLifecycleReadOnlyIdentitySource } from './composition/hosted/teamLifecycleReadOnlyIdentitySource';
import {
  type HostedWorkspaceEventBridge,
  registerHostedWorkspaceEventBridge,
  runWithEventStreamsDrained,
} from './http/events';
import { LocalFileSystemProvider } from './services/infrastructure/LocalFileSystemProvider';
import {
  getProjectsBasePath,
  getTodosBasePath,
  setClaudeBasePathOverride,
} from './utils/pathDecoder';

import type { HostedAuthStorageBackend, HttpServices } from './http';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { NotificationManager } from './services/infrastructure/NotificationManager';
import type { ServiceContext } from './services/infrastructure/ServiceContext';
import type { SshConnectionManager } from './services/infrastructure/SshConnectionManager';
import type { UpdaterService } from './services/infrastructure/UpdaterService';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { JsonWebKey } from 'node:crypto';
import type { Server, Socket } from 'node:net';

const logger = createLogger('Standalone');
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = parseInt(process.env.PORT ?? '3456', 10);
const CLAUDE_ROOT = process.env.CLAUDE_ROOT;
type HostedAuthHostPlatform = CreateHostedAccessFeatureDependencies['hostPlatform'];
type HostedAuthLocalControlTransportFactory =
  CreateHostedAccessFeatureDependencies['localControlTransportFactory'];
function createHostedAuthHostPlatform(): HostedAuthHostPlatform {
  const syncDirectory = async (path: string): Promise<void> => {
    const parent = await open(path, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  return Object.freeze({
    uid: process.getuid?.(),
    pid: process.pid,
    join: (...segments: readonly string[]) => join(...segments),
    dirname,
    isAbsolute,
    byteLength: (value: string) => Buffer.byteLength(value),
    mkdir: async (path: string, mode: number) => {
      await mkdir(path, { recursive: true, mode });
    },
    lstat,
    openReadOnlyNoFollow: async (path: string) => {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      const portableConstants = fsConstants as Readonly<Record<string, number | undefined>>;
      const closeOnExec =
        typeof portableConstants.O_CLOEXEC === 'number' ? portableConstants.O_CLOEXEC : 0;
      const handle = await open(path, fsConstants.O_RDONLY | noFollow | closeOnExec);
      return Object.freeze({
        stat: () => handle.stat(),
        readTextBounded: async (maximumBytes: number) => {
          if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
            throw new TypeError('hosted_auth_read_bound_invalid');
          }
          const bytes = Buffer.alloc(maximumBytes + 1);
          let offset = 0;
          for (;;) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
            if (offset > maximumBytes) throw new Error('hosted_auth_secret_too_large');
          }
          return bytes.subarray(0, offset).toString('utf8');
        },
        close: () => handle.close(),
      });
    },
    chmod,
    writeTextDurable: async (
      path: string,
      body: string,
      options: { readonly exclusive: boolean; readonly mode: number }
    ) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, options.exclusive ? 'wx' : 'w', options.mode);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(path));
    },
    rename: async (source: string, destination: string) => {
      await rename(source, destination);
      const sourceDirectory = dirname(source);
      const destinationDirectory = dirname(destination);
      await syncDirectory(destinationDirectory);
      if (sourceDirectory !== destinationDirectory) await syncDirectory(sourceDirectory);
    },
    remove: async (
      path: string,
      options?: { readonly force?: boolean; readonly recursive?: boolean }
    ) => {
      await rm(path, options);
      await syncDirectory(dirname(path));
    },
    randomBytes: (size: number) => randomBytes(size),
    base64UrlEncode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
    base64UrlDecode: (value: string) => Buffer.from(value, 'base64url'),
    hmacSha256: (key: Uint8Array, parts: readonly string[], encoding: 'hex' | 'base64url') => {
      const hmac = createHmac('sha256', key);
      for (const part of parts) hmac.update(part);
      return hmac.digest(encoding);
    },
    hkdfSha256: (input: Uint8Array, salt: Uint8Array, info: string, length: number) =>
      new Uint8Array(hkdfSync('sha256', input, salt, Buffer.from(info, 'utf8'), length)),
    sha256Base64Url: (value: string) => createHash('sha256').update(value).digest('base64url'),
    verifyOidcSignature: (input: {
      readonly algorithm: string;
      readonly jwk: Readonly<Record<string, unknown>>;
      readonly signingInput: string;
      readonly signature: Uint8Array;
    }) => {
      const digest = input.algorithm === 'EdDSA' ? null : `sha${input.algorithm.slice(-3)}`;
      const publicKey = createPublicKey({
        key: input.jwk as JsonWebKey,
        format: 'jwk',
      });
      const options = input.algorithm.startsWith('PS')
        ? {
            key: publicKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: Number(input.algorithm.slice(-3)) / 8,
          }
        : input.algorithm.startsWith('ES')
          ? { key: publicKey, dsaEncoding: 'ieee-p1363' as const }
          : publicKey;
      return verifySignature(digest, Buffer.from(input.signingInput), options, input.signature);
    },
    encryptAes256Gcm: (input: {
      readonly key: Uint8Array;
      readonly nonce: Uint8Array;
      readonly aad: string;
      readonly plaintext: string;
    }) => {
      const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
      cipher.setAAD(Buffer.from(input.aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
      return Object.freeze({ ciphertext, tag: cipher.getAuthTag() });
    },
    decryptAes256Gcm: (input: {
      readonly key: Uint8Array;
      readonly nonce: Uint8Array;
      readonly aad: string;
      readonly ciphertext: Uint8Array;
      readonly tag: Uint8Array;
    }) => {
      const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
      decipher.setAAD(Buffer.from(input.aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(input.tag));
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
    },
    secureEqual: (left: string, right: string) => {
      const leftBuffer = Buffer.from(left);
      const rightBuffer = Buffer.from(right);
      return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
    },
  });
}

function createHostedAuthLocalControlTransportFactory(
  platform: HostedAuthHostPlatform
): HostedAuthLocalControlTransportFactory {
  return Object.freeze({
    create: (options: Parameters<HostedAuthLocalControlTransportFactory['create']>[0]) => {
      let server: Server | null = null;
      const isSocketActive = (): Promise<boolean> =>
        new Promise((resolveActive) => {
          const socket = createConnection(options.socketPath);
          let settled = false;
          const finish = (active: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolveActive(active);
          };
          socket.setTimeout(250, () => finish(false));
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
        });
      const removeOwnedSocket = async (checkActive: boolean): Promise<void> => {
        try {
          const stat = await lstat(options.socketPath);
          if (!stat.isSocket() || (platform.uid !== undefined && stat.uid !== platform.uid)) {
            throw new Error('hosted_local_control_socket_path_occupied');
          }
          if (checkActive && (await isSocketActive())) {
            throw new Error('hosted_local_control_socket_path_occupied');
          }
          await rm(options.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
      const handleSocket = (
        socket: Socket,
        handler: (requestBody: string) => Promise<string>
      ): void => {
        let body = '';
        let receivedBytes = 0;
        let handled = false;
        socket.setEncoding('utf8');
        socket.setTimeout(options.requestTimeoutMs, () => socket.destroy());
        socket.on('data', (chunk: string) => {
          if (handled) return;
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > options.maximumRequestBytes) {
            handled = true;
            socket.end('{"ok":false,"code":"request_too_large"}\n');
            return;
          }
          body += chunk;
          const newline = body.indexOf('\n');
          if (newline < 0) return;
          handled = true;
          if (body.slice(newline + 1).trim().length !== 0) {
            socket.end('{"ok":false,"code":"request_invalid"}\n');
            return;
          }
          void handler(body.slice(0, newline))
            .then((result) => socket.end(result))
            .catch(() => socket.end('{"ok":false,"code":"internal_error"}\n'));
        });
        socket.on('error', () => undefined);
      };
      return Object.freeze({
        start: async (handler: (requestBody: string) => Promise<string>) => {
          if (server !== null) return;
          const socketDirectory = dirname(options.socketPath);
          await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
          const directoryStat = await lstat(socketDirectory);
          if (
            !directoryStat.isDirectory() ||
            directoryStat.isSymbolicLink() ||
            (platform.uid !== undefined && directoryStat.uid !== platform.uid)
          ) {
            throw new Error('hosted_local_control_socket_directory_invalid');
          }
          await chmod(socketDirectory, 0o700);
          await removeOwnedSocket(true);
          const nextServer = createServer((socket) => handleSocket(socket, handler));
          nextServer.maxConnections = 16;
          await new Promise<void>((resolveListening, reject) => {
            const onError = (error: Error): void => {
              nextServer.off('listening', onListening);
              reject(error);
            };
            const onListening = (): void => {
              nextServer.off('error', onError);
              resolveListening();
            };
            nextServer.once('error', onError);
            nextServer.once('listening', onListening);
            nextServer.listen(options.socketPath);
          });
          try {
            await chmod(options.socketPath, 0o600);
            server = nextServer;
          } catch (error) {
            await new Promise<void>((resolveClose) => nextServer.close(() => resolveClose()));
            await removeOwnedSocket(false);
            throw error;
          }
        },
        close: async () => {
          const activeServer = server;
          server = null;
          if (activeServer !== null) {
            await new Promise<void>((resolveClose, reject) => {
              activeServer.close((error) => (error ? reject(error) : resolveClose()));
            });
          }
          await removeOwnedSocket(false);
        },
      });
    },
  });
}
// Default CORS to allow all in standalone mode (Docker isolation replaces CORS)
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = process.env.AUTH_PUBLIC_ORIGIN ?? '*';
}
/** No-op UpdaterService stub — auto-updater requires Electron. */
const updaterServiceStub = {
  checkForUpdates: async () => {},
  downloadUpdate: async () => {},
  quitAndInstall: async () => {},
  setMainWindow: () => {},
} as unknown as UpdaterService;
/** No-op SshConnectionManager stub — SSH is managed per-user in the Electron app. */
const sshConnectionManagerStub = {
  getStatus: () => ({
    state: 'disconnected' as const,
    host: null,
    error: null,
    remoteProjectsPath: null,
  }),
  getProvider: () => new LocalFileSystemProvider(),
  isRemote: () => false,
  connect: async () => {},
  disconnect: () => {},
  testConnection: async () => ({ success: false, error: 'SSH not available in standalone mode' }),
  getConfigHosts: async () => [],
  resolveHostConfig: async () => null,
  dispose: () => {},
  on: () => sshConnectionManagerStub,
  off: () => sshConnectionManagerStub,
  emit: () => false,
} as unknown as SshConnectionManager;
let localContext: ServiceContext;
let notificationManager: NotificationManager;
let httpServer: HttpServer;
let configManager: { flush(): Promise<void> } | null = null;
let shutdownPromise: Promise<void> | null = null;
let hostedAuthStorageBackend: HostedAuthStorageBackend | null = null;
let hostedAccessFeature: HostedAccessFeature | null = null;
let hostedCoordinationEventStream: HostedCoordinationEventStream | null = null;
let hostedDiagnostics: HostedDiagnosticsComposition | null = null;
let hostedLifecycleCommands: TeamLifecycleCommandComposition | null = null;
let hostedWorkspaceEventBridge: HostedWorkspaceEventBridge | null = null;
let hostedAuthLocalControlHandle: { close(): Promise<void> } | null = null;
export interface StandaloneShutdownActions {
  stopHttpServer: () => Promise<void>;
  disposeLocalContext: () => void;
  flushConfig: () => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
}
export async function runStandaloneShutdownLifecycle(
  actions: StandaloneShutdownActions
): Promise<void> {
  actions.logInfo('Shutting down...');
  let exitCode = 0;
  const recordFailure = (label: string, error: unknown): void => {
    exitCode = 1;
    actions.setExitCode(1);
    actions.logError(`${label}:`, error);
  };
  try {
    await actions.stopHttpServer();
  } catch (error) {
    recordFailure('HTTP server shutdown failed', error);
  }
  try {
    actions.disposeLocalContext();
  } catch (error) {
    recordFailure('Local context shutdown failed', error);
  }
  try {
    await actions.flushConfig();
  } catch (error) {
    recordFailure('ConfigManager flush failed during shutdown', error);
  }
  if (exitCode === 0) {
    actions.logInfo('Shutdown complete');
  }
  actions.exit(exitCode);
}
type StandaloneShutdownSignal = 'SIGINT' | 'SIGTERM';
export function registerStandaloneShutdownSignalHandlers(input: {
  platform: NodeJS.Platform;
  onSignal: (signal: StandaloneShutdownSignal, listener: () => void) => void;
  shutdown: () => Promise<void>;
}): void {
  const requestShutdown = (): void => {
    void input.shutdown();
  };
  input.onSignal('SIGINT', requestShutdown);
  if (input.platform !== 'win32') {
    input.onSignal('SIGTERM', requestShutdown);
  }
}
function admitHostedReadRoot(reference: string): string {
  if (
    !isAbsolute(reference) ||
    resolve(reference) !== reference ||
    reference === resolve(reference, '/')
  ) {
    throw new TypeError('team-lifecycle-read-runtime-root-invalid');
  }
  return reference;
}
const teamLifecycleReadNowMs = (): number => Date.now();
function createTeamLifecycleReadQueryContext(
  authority: TeamLifecycleReadAuthority,
  requestSignal: AbortSignal
) {
  return createQueryContext({
    actorId: authority.actorId,
    sessionId: 'session_team-lifecycle-read-standalone',
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    requestId: `request_team-lifecycle-read-standalone-${++teamLifecycleReadRequestSequence}`,
    authorizedScope: authority.authorizedScope,
    deadlineAtMs: teamLifecycleReadNowMs() + 10_000,
    signal: requestSignal,
  });
}
let teamLifecycleReadRequestSequence = 0;
const HOSTED_TEAM_WORKSPACE_RESOLUTION_MAXIMUM_PAGES = 16;
/** Resolves team attribution through one bounded, revision-pinned canonical snapshot. */
export async function resolveHostedTeamWorkspaceId(
  host: TeamLifecycleReadHost,
  teamIdValue: TeamId
): Promise<string | null> {
  let cursor: Cursor | null = null;
  let expectedRevision: Revision | null = null;
  let resolvedWorkspaceId: string | null = null;
  try {
    for (let page = 0; page < HOSTED_TEAM_WORKSPACE_RESOLUTION_MAXIMUM_PAGES; page += 1) {
      const result = await host.listTeamLifecycle({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor,
        expectedRevision,
      });
      if (result.kind !== 'success') return null;
      if (expectedRevision !== null && result.snapshotRevision !== expectedRevision) return null;
      for (const item of result.items) {
        if (item.teamId !== teamIdValue) continue;
        if (resolvedWorkspaceId !== null) return null;
        resolvedWorkspaceId = item.workspaceId;
      }
      if (result.nextCursor === null) return resolvedWorkspaceId;
      cursor = result.nextCursor;
      expectedRevision = result.snapshotRevision;
    }
  } catch {
    return null;
  }
  return null;
}
async function start(): Promise<void> {
  logger.info('Starting standalone server...');
  const serializedHostedBootstrap = readTeamLifecycleReadBootstrapEnvironment(process.env);
  // AUTH_MODE is itself an explicit hosted deployment declaration. Never let
  // a Compose-hosted process fall through to the legacy standalone watcher
  // merely because the optional canonical team-lifecycle read envelope has
  // not been integrated by the outer lifecycle owner yet.
  const hostedMode = serializedHostedBootstrap !== undefined || process.env.AUTH_MODE !== undefined;
  let teamLifecycleReadHost: TeamLifecycleReadHost = createUnavailableTeamLifecycleReadHost();
  let hostedDiagnosticsRuntimeInstance: RuntimeInstanceContext | null = null;
  let createHostedTaskBoardReadRoutes:
    | ((access: HostedAccessFeature) => HttpServices['hostedTeamTaskBoardRoutes'])
    | null = null;
  if (hostedMode) {
    if (serializedHostedBootstrap === undefined) {
      // The v1 Compose profile has an administrator-mounted, read-only root
      // but no canonical team-lifecycle identity envelope yet. Admit the exact
      // mount and keep that feature unavailable; critically, this process
      // still takes the cache-only hosted path below and starts no ambient
      // filesystem watcher.
      if (CLAUDE_ROOT === undefined) throw new Error('hosted_claude_root_required');
      setClaudeBasePathOverride(admitHostedReadRoot(CLAUDE_ROOT));
    } else {
      // Hosted admission is complete before any ServiceContext/FileWatcher or HTTP service exists.
      // An invalid launcher envelope aborts startup; unavailable identity storage leaves only the
      // canonical read facet unavailable and never falls back to ambient discovery.
      const bootstrap = await new TeamLifecycleReadBootstrapSource({
        input: {
          readSerializedBootstrap: () => serializedHostedBootstrap,
        },
        nowMs: teamLifecycleReadNowMs,
      }).load();
      hostedDiagnosticsRuntimeInstance = bootstrap.runtimeInstance;
      const claudeRoot = admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference);
      const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference);
      setClaudeBasePathOverride(claudeRoot);
      const teamIdentityGateway = await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot });
      if (teamIdentityGateway) {
        try {
          const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
            authority: bootstrap.authority,
            mountBinding: bootstrap.mountBinding,
            runtimeInstance: bootstrap.runtimeInstance,
            teamIdentities: teamIdentityGateway,
            nowMs: teamLifecycleReadNowMs,
          });
          await readPorts.teamIdentities.listTeamIdentities();
          const composition = createTeamLifecycleReadComposition({
            authority: bootstrap.authority,
            ...readPorts,
            nowMs: teamLifecycleReadNowMs,
          });
          teamLifecycleReadHost = createTeamLifecycleReadHost(
            composition,
            createTeamLifecycleReadQueryContext
          );
          createHostedTaskBoardReadRoutes = createHostedTaskBoardReadRouteFactory({
            runtimeInstance: bootstrap.runtimeInstance,
            mountBinding: bootstrap.mountBinding,
            teamIdentities: teamIdentityGateway,
          });
        } catch {
          logger.warn(
            'Hosted team lifecycle identity admission unavailable; canonical reads remain disabled.'
          );
        }
      } else {
        logger.warn(
          'Hosted team lifecycle identity storage unavailable; canonical reads remain disabled.'
        );
      }
    }
  } else if (CLAUDE_ROOT) {
    setClaudeBasePathOverride(CLAUDE_ROOT);
    logger.info(`Using CLAUDE_ROOT: ${CLAUDE_ROOT}`);
  }
  // ConfigManager is intentionally obtained only after hosted/non-hosted root admission.
  // The dynamic module export is the same singleton used by the desktop composition.
  const { configManager: admittedConfigManager } =
    await import('./services/infrastructure/ConfigManager');
  configManager = admittedConfigManager;
  // Import services after applying CLAUDE_ROOT so ConfigManager picks up the correct base path.
  const [
    { createHostedAuthStorageBackend },
    { HttpServer },
    { NotificationManager },
    { ServiceContext },
  ] = await Promise.all([
    import('./http'),
    import('./services/infrastructure/HttpServer'),
    import('./services/infrastructure/NotificationManager'),
    import('./services/infrastructure/ServiceContext'),
  ]);
  const projectsDir = getProjectsBasePath();
  const todosDir = getTodosBasePath();

  logger.info(`Projects directory: ${projectsDir}`);
  logger.info(`Todos directory: ${todosDir}`);

  // Create local context (the only context in standalone mode)
  localContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
  });
  if (hostedMode) localContext.startCacheOnly();
  else localContext.start();

  // Initialize notification manager
  notificationManager = NotificationManager.getInstance();
  localContext.fileWatcher.setNotificationManager(notificationManager);

  // Create HTTP server
  httpServer = new HttpServer();
  const authDataDirectory = process.env.AUTH_DATA_DIR ?? '/data/.agent-teams';
  hostedAuthStorageBackend = createHostedAuthStorageBackend(authDataDirectory);
  const hostedAuthHostPlatform = createHostedAuthHostPlatform();
  hostedAccessFeature = await createHostedAccessFeature({
    environment: process.env,
    storage: hostedAuthStorageBackend.gateway,
    dataDirectory: authDataDirectory,
    hostPlatform: hostedAuthHostPlatform,
    localControlTransportFactory:
      createHostedAuthLocalControlTransportFactory(hostedAuthHostPlatform),
    // The hosted standalone composition owns no runtime/process mutation.
    // Destructive reset still requires a matching AR-owned evidence file.
    noRuntimeMutationAtStartup: true,
    runWithBrowserStreamsDrained: runWithEventStreamsDrained,
    resolveTeamWorkspaceId: (teamId) => resolveHostedTeamWorkspaceId(teamLifecycleReadHost, teamId),
  });
  hostedDiagnostics = createHostedDiagnosticsComposition({
    authentication: hostedAccessFeature.http,
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
    expectedDeploymentId: hostedAccessFeature.deploymentId,
  });
  hostedLifecycleCommands = createOptionalTeamLifecycleCommandComposition({
    authentication: hostedAccessFeature.http,
    runtimeInstance: hostedDiagnosticsRuntimeInstance,
    expectedDeploymentId: hostedAccessFeature.deploymentId,
    orchestratorSocketPath: process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET,
  });
  const hostedTeamTaskBoardRoutes = createHostedTaskBoardReadRoutes?.(hostedAccessFeature);
  hostedCoordinationEventStream = createHostedCoordinationEventStream({
    storage: hostedAuthStorageBackend.coordinationEvents,
    deploymentId: hostedAccessFeature.deploymentId,
    authorizer: createHostedCoordinationEventStreamAuthorizer(hostedAccessFeature.http),
  });
  hostedAuthLocalControlHandle = await hostedAccessFeature.startLocalControl(
    process.env.AUTH_CONTROL_SOCKET ?? '/run/agent-teams/control.sock'
  );
  const recentProjectsFeature = createRecentProjectsFeature({
    getActiveContext: () => localContext,
    getLocalContext: () => localContext,
    logger: createLogger('Feature:RecentProjects'),
  });
  // Hosted event admission binds every browser-visible event to one active,
  // administrator-registered workspace. SSE delivery then revalidates the
  // session and its current per-user grant before projecting an opaque ID.
  hostedWorkspaceEventBridge = registerHostedWorkspaceEventBridge({
    fileEvents: localContext.fileWatcher,
    notificationEvents: notificationManager,
    isWorkspaceRegistered: (runtimeWorkspaceId) =>
      hostedAccessFeature!.http.isWorkspaceRegistered(runtimeWorkspaceId),
    broadcast: (channel, data) => {
      httpServer!.broadcast(channel, data);
    },
  });

  // Build services for HTTP routes
  const services: HttpServices = {
    projectScanner: localContext.projectScanner,
    sessionParser: localContext.sessionParser,
    subagentResolver: localContext.subagentResolver,
    chunkBuilder: localContext.chunkBuilder,
    dataCache: localContext.dataCache,
    recentProjectsFeature,
    updaterService: updaterServiceStub,
    sshConnectionManager: sshConnectionManagerStub,
    teamLifecycleReadHost,
    hostedAuth: hostedAccessFeature.http,
    hostedCoordinationEventRoutes: hostedCoordinationEventStream,
    hostedDiagnosticsRoutes: hostedDiagnostics,
    ...(hostedLifecycleCommands === null
      ? {}
      : { hostedLifecycleCommandRoutes: hostedLifecycleCommands }),
    hostedTeamTaskBoardRoutes,
  };

  // No-op mode switch handler (no SSH in standalone)
  const modeSwitchHandler = async (): Promise<void> => {};

  // Start the server
  const port = await httpServer.start(services, modeSwitchHandler, PORT, HOST);
  logger.info(`Standalone server running at http://${HOST}:${port}`);
  logger.info('Open in your browser to view Claude Code sessions');
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = runStandaloneShutdownLifecycle({
    stopHttpServer: async () => {
      const failures: unknown[] = [];
      try {
        hostedLifecycleCommands?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedLifecycleCommands = null;
      try {
        hostedDiagnostics?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedDiagnostics = null;
      try {
        hostedCoordinationEventStream?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedCoordinationEventStream = null;
      try {
        await hostedWorkspaceEventBridge?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedWorkspaceEventBridge = null;
      try {
        await hostedAuthLocalControlHandle?.close();
      } catch (error) {
        failures.push(error);
      }
      hostedAuthLocalControlHandle = null;
      try {
        if (httpServer?.isRunning()) {
          await httpServer.stop();
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Hosted network surface shutdown failed');
      }
    },
    disposeLocalContext: () => {
      if (localContext) {
        localContext.dispose();
      }
    },
    flushConfig: async () => {
      // Keep ConfigManager as the final persistence drain before process exit.
      await configManager?.flush();
      await hostedAuthStorageBackend?.dispose();
      hostedAuthStorageBackend = null;
      hostedAccessFeature = null;
    },
    logInfo: (message) => logger.info(message),
    logError: (message, error) => logger.error(message, error),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    exit: (code) => process.exit(code),
  });

  return shutdownPromise;
}

// Signal Handlers
if (!process.env.VITEST) {
  // SIGINT works on all platforms (Ctrl+C), but SIGTERM does not exist on Windows.
  registerStandaloneShutdownSignalHandlers({
    platform: process.platform,
    onSignal: (signal, listener) => process.on(signal, listener),
    shutdown,
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  // Start
  void start().catch((error) => {
    logger.error('Standalone startup failed:', error);
    process.exitCode = 1;
    void shutdown();
  });
}
