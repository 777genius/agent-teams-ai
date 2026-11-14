import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createOpenCodeV2DriverFactory,
  createOpenCodeV2OwnedSessionClient,
} from '@agent-teams/provider-implementations/opencode';

import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import { selectOpenCodeV2ManagementModel } from '../../composition/openCodeV2ModelSelection.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';
import { openCodeManagementProfileSchema } from '../../management/profile.js';
import { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';
import { openCodeV2NoToolConfig, openCodeV2CoordinationConfig } from './OpenCodeV2EmbeddedConfig.js';
import { OpenCodeCoordinationEndpoint, coordinationServer, closeCoordinationByDeadline } from './OpenCodeCoordinationEndpoint.js';
import { captureCoordinationConfiguration, runNativeCoordination, readNativeCoordination } from './OpenCodeCoordinationProbe.js';
import { attestOpenCodeV2ModelSelection } from './OpenCodeV2ModelSelection.js';
import { captureOpenCodeV2SessionCredential } from './OpenCodeV2SessionCredential.js';
import { captureOpenCodeV2Configuration } from './OpenCodeV2CapturedConfiguration.js';

import type { NativeCoordinationObservation } from './OpenCodeCoordinationProbe.js';
import type { Session } from '@agent-teams/provider-session-contracts';
import type { ModelProbeInput, NativeModelProbe } from '../../management/ModelProbeOwner.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';
import type { OpenCodeV2OwnedSessionSelection, OpenCodeV2TransportConfig } from '@agent-teams/provider-implementations/opencode';

const unavailable = (): never => {
  throw new ManagementCommandError('held');
};
const prompt = 'Reply only OK. Do not use tools, access files or run commands.';

/**
 * One finite native mechanism under the existing ModelProbeOwner journal.
 * Preparation allocates nothing; only its durably admitted run may create a child.
 */
export function createOpenCodeV2ModelProbe(
  raw: OpenCodeManagementProfile,
  input: ModelProbeInput,
  isCurrent: () => boolean,
  options: { processCustody?: RegisteredProcessRootSource; coordination?: true;
    readiness?: { observeProvider?(provider: unknown): void; expectedProvider?: Record<string, unknown> } } = {}
): NativeModelProbe & { wasRejected(): boolean; coordinationObservation(): NativeCoordinationObservation | undefined } {
  const profile = selectOpenCodeV2ManagementModel(openCodeManagementProfileSchema.parse(raw), input);
  if (
    profile.nativeGeneration !== 'v2' ||
    profile.protocolRevision !== '2.1.4' ||
    !profile.embedded ||
    !profile.nativeModel ||
    input.limits ||
    input.modelContext !== undefined ||
    hasUntrustedOpenCodeBinaryOverride(profile.environment)
  )
    throw new ManagementCommandError('invalid');
  const { embedded } = profile;
  const captured = managementDigest({ profile, commandId: input.commandId,
    ...(options.readiness ? { readinessPhase: options.coordination ? 'coordination' : 'ordinary' } : {}) });
  const purposeBound = options.coordination || options.readiness !== undefined;
  const timeoutMs = purposeBound ? Math.min(profile.modelProbeTimeoutMs ?? 90000, 90000)
    : profile.modelProbeTimeoutMs ?? 90000;
  const directories = new Map<string, { dev: bigint; ino: bigint }>();
  try {
    for (const directory of [
      profile.cwd,
      ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(
        (key) => profile.environment[key]
      ),
    ]) {
      if (!directory || realpathSync(directory) !== directory) return unavailable();
      const stat = lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
      directories.set(directory, { dev: stat.dev, ino: stat.ino });
    }
  } catch {
    return unavailable();
  }
  const namespaceRoots = new Map<string, { dev: bigint; ino: bigint }>();
  const abort = new AbortController();
  let closed = false;
  let starting: Promise<void> | undefined;
  let running: Promise<boolean> | undefined;
  let closing: Promise<boolean> | undefined;
  let activeSignal: AbortSignal | undefined;
  let ownerCleanupUnknown = false;
  let rejected = false;
  let coordinationResult: NativeCoordinationObservation | undefined;
  const requests = new Set<Promise<void>>();
  let driver: Session | undefined;
  let server: ReturnType<typeof createOpenCodeV2EmbeddedServer> | undefined;
  let ready: Awaited<ReturnType<NonNullable<typeof server>['start']>> | undefined;
  let deadline = 0;
  const nativeSessionId = 'ses_' + captured.slice(0, 40);
  const contextCurrent = () => {
    if (
      closed ||
      abort.signal.aborted ||
      activeSignal?.aborted ||
      hasUntrustedOpenCodeBinaryOverride(process.env)
    )
      return false;
    try {
      if (!isCurrent()) return false;
      for (const [directory, identity] of directories) {
        const stat = lstatSync(directory, { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          realpathSync(directory) !== directory ||
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const coordination = options.coordination ? new OpenCodeCoordinationEndpoint() : undefined;
  const coordinationSource = coordination && !options.readiness
    ? captureCoordinationConfiguration(profile, input, contextCurrent) : undefined;
  const configuration = captureOpenCodeV2Configuration(profile, profile.nativeModel, contextCurrent);
  const noTool = openCodeV2NoToolConfig(profile, configuration.configuration);
  const configured = configuration.configuration;
  const observedProvider: Record<string, unknown> = configured ? {
    npm: typeof configured.package === 'string' ? configured.package.replace(/^aisdk:/, '') : undefined,
    options: configured.settings ?? {}, models: configured.models ?? {},
  } : {};
  if (options.readiness?.expectedProvider && managementDigest(observedProvider) !==
      managementDigest(options.readiness.expectedProvider)) return unavailable();
  let config: Record<string, unknown> = noTool.config;
  let selection: OpenCodeV2OwnedSessionSelection = noTool.selection;
  const credential = captureOpenCodeV2SessionCredential(profile, input.providerId,
    configuration.isCurrent);
  const current = coordinationSource
    ? () => credential.isCurrent() && coordinationSource.isCurrent() : credential.isCurrent;
  let nativeCredential: OpenCodeV2OwnedSessionSelection['credential'];
  const assertCurrent = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!current() || Date.now() >= deadline) unavailable();
  };
  async function beforeRequest(signal: AbortSignal): Promise<() => void> {
    assertCurrent(signal);
    // Reserve before the asynchronous native measurement. Shutdown fences new
    // admissions and drains these leases before aborting the Session transport.
    const settled = Promise.withResolvers<void>();
    requests.add(settled.promise);
    const release = () => {
      if (requests.delete(settled.promise)) settled.resolve();
    };
    try {
      const custody = await server?.readNativeCustody(AbortSignal.any([signal, abort.signal]));
      assertCurrent(signal);
      if (
        !custody ||
        !ready ||
        custody.pid !== ready.pid ||
        custody.startIdentity !== ready.startIdentity ||
        custody.version !== '2.1.4'
      )
        unavailable();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  const readPassword = () => {
    assertCurrent();
    if (!server) return unavailable();
    return server.readPassword();
  };
  async function withClient<T>(
    signal: AbortSignal,
    action: (client: ReturnType<typeof createOpenCodeV2OwnedSessionClient>, config: OpenCodeV2TransportConfig) => Promise<T>
  ): Promise<T> {
    assertCurrent(signal);
    if (!ready) return unavailable();
    const config: OpenCodeV2TransportConfig = {
      endpoint: ready.endpoint,
      directory: profile.cwd,
      nativeSessionId,
      version: '2.1.4',
      beforeRequest,
      readPassword,
      signal: AbortSignal.any([signal, abort.signal]),
      deadline,
    };
    const client = createOpenCodeV2OwnedSessionClient(config);
    let failed = false;
    let originalFailure: unknown;
    let result!: T;
    try {
      result = await action(client, config);
      assertCurrent(signal);
    } catch (error) {
      failed = true;
      originalFailure = error;
    }
    try {
      await client.dispose();
    } catch (error) {
      ownerCleanupUnknown = true;
      if (!failed) {
        failed = true;
        originalFailure = error;
      }
    }
    if (failed) throw originalFailure;
    return result;
  }
  async function namespace(root: string): Promise<string> {
    const directory = await mkdtemp(
      join(root, 'agent-teams-v2-probe-' + captured.slice(0, 16) + '-')
    );
    const stat = lstatSync(directory, { bigint: true });
    namespaceRoots.set(directory, { dev: stat.dev, ino: stat.ino });
    return directory;
  }
  async function start(signal: AbortSignal): Promise<void> {
    assertCurrent(signal);
    if (coordination) {
      coordinationSource?.beforeAllocation();
      await coordination.start(deadline, signal, current);
      assertCurrent(signal);
      ({ config, selection } = openCodeV2CoordinationConfig(profile, coordination, configuration.configuration));
    }
    const data = await namespace(profile.environment.XDG_DATA_HOME!);
    assertCurrent(signal);
    const configDirectory = await namespace(profile.environment.XDG_CONFIG_HOME!);
    assertCurrent(signal);
    server = createOpenCodeV2EmbeddedServer({
      profile,
      embedded,
      databasePath: join(data, 'probe.sqlite'),
      configDirectory,
      startupTimeoutMs: Math.min(profile.timeoutMs, purposeBound ? deadline - Date.now() : timeoutMs),
      canAllocate: current,
      ...(options.processCustody ? { processCustody: options.processCustody } : {}),
      config,
    });
    coordinationSource?.beforeAllocation();
    ready = await server.start(signal);
    assertCurrent(signal);
    await withClient(signal, async (client, wire) => {
      const identity = await client.identity();
      if (identity.pid !== ready!.pid || identity.version !== '2.1.4') return unavailable();
      nativeCredential = await credential.prepare(wire, client);
      await attestOpenCodeV2ModelSelection(client, selection.model,
        { signal, deadline, isCurrent: current });
      options.readiness?.observeProvider?.(observedProvider);
      assertCurrent(signal);
      await client.createSession({ ...selection, ...(nativeCredential ? { credential: nativeCredential } : {}) });
    });
    coordination?.bindSession(nativeSessionId);
    const binding = {
      tenantId: 'provider-management',
      projectId: profile.profileId,
      sessionId: input.commandId,
      generation: 1,
    };
    const factory = createOpenCodeV2DriverFactory({
      capabilities: coordination ? ['text', 'tools'] : ['text'],
      readCheckpoint: async () => unavailable(),
      resolveConfiguration: async (request) => {
        assertCurrent(signal);
        if (request.checkpointRef !== undefined || !ready) return undefined;
        return {
          binding,
          configRevision: profile.configRevision,
          endpoint: ready.endpoint,
          directory: profile.cwd,
          version: '2.1.4',
          nativeSessionId,
          trustedBinding: captured,
          accountBinding: profile.accountBinding,
          readPassword,
          beforeRequest,
          limits: {
            queuedInputs: 1,
            inputBytes: 1024,
            outputBytes: 32768,
            outputEvents: 128,
            pendingInteractions: 1,
            timeoutMs: purposeBound ? Math.max(1, deadline - Date.now()) : timeoutMs,
          },
          probe: async (probeSignal) =>
            withClient(probeSignal, async (client) => {
              const observed = await client.readSession();
              return (
                managementDigest({
                  agent: observed.agent,
                  model: observed.model,
                  permissions: observed.permissions,
                  ...(observed.credential ? { credential: observed.credential } : {}),
                }) === managementDigest({ ...selection, ...(nativeCredential ? { credential: nativeCredential } : {}) }) &&
                (await client.savedPermissionsEmpty()) &&
                (await client.builtinPluginsOnly()) &&
                await (async () => {
                  const mcp = await client.readMcp();
                  return coordination ? mcp.length === 1 && mcp[0]?.name === coordinationServer &&
                    mcp[0].status === 'connected' && coordination.catalogCurrent() : mcp.length === 0;
                })()
              );
            }),
          confirmStopped: () => server!.stopOwned(),
        };
      },
    });
    const opened = await factory.open({
      ...binding,
      configRevision: profile.configRevision,
      requiredCapabilities: coordination ? ['text', 'tools'] : ['text'],
    });
    driver = opened.driver;
    assertCurrent(signal);
  }
  async function run(signal: AbortSignal, originalDeadline?: number): Promise<boolean> {
    if (purposeBound && (originalDeadline === undefined || !Number.isSafeInteger(originalDeadline) ||
        originalDeadline <= Date.now() || originalDeadline - Date.now() > timeoutMs)) unavailable();
    deadline = purposeBound ? originalDeadline! : Date.now() + timeoutMs;
    const combined = AbortSignal.any([signal, abort.signal,
      AbortSignal.timeout(purposeBound ? Math.max(1, deadline - Date.now()) : timeoutMs)]);
    activeSignal = combined;
    starting = start(combined);
    await starting;
    assertCurrent(combined);
    if (!driver) return unavailable();
    if (coordination) {
      if (options.readiness) {
        coordinationResult = await readNativeCoordination(driver, nativeSessionId, coordination,
          captured, combined, deadline, current);
        return coordinationResult?.status === 'compatible';
      }
      return runNativeCoordination(driver, nativeSessionId, coordination, captured, combined, deadline, current);
    }
    const inputId = 'model-probe-' + captured.slice(0, 32);
    const operationRef = 'model-probe-operation-' + captured.slice(0, 32);
    const handed = await driver.submit({ inputId, operationRef, content: prompt });
    if (!handed.ok) return false;
    let hasText = false;
    for await (const event of driver.observe()) {
      assertCurrent(combined);
      if (
        event.sessionRef !== driver.sessionRef ||
        event.inputId !== inputId ||
        event.operationRef !== operationRef
      )
        return false;
      if (event.kind === 'text') hasText ||= event.text.trim().length > 0;
      else if (event.kind === 'result') {
        // V2 emits failed only for the original qualified execution.failed + idle
        // cut. Transport/cancellation/output failures are not a rejection proof.
        rejected = event.outcome === 'failed' && event.code === undefined;
        return event.outcome === 'succeeded' && hasText;
      }
      else if (event.kind !== 'usage') return false;
    }
    return false;
  }
  return {
    timeoutMs,
    wasRejected: () => rejected,
    coordinationObservation: () => coordinationResult === undefined ? undefined : { ...coordinationResult },
    run: (signal, originalDeadline) => (running ??= run(signal, originalDeadline)),
    close: originalDeadline => {
      closed = true;
      coordination?.seal();
      abort.abort();
      if (closing) return closing;
      const work = (async () => {
        await starting?.catch(() => {});
        // Rejected late custody checks cannot send credentials. Give their
        // original finite requests time to settle before SPI abort; a missing
        // release remains UNKNOWN and is never converted to a clean cancel.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let clean = false;
        try {
          clean = await Promise.race([
            Promise.all([...requests]).then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 5000,
                purposeBound ? Math.max(0, (originalDeadline ?? deadline) - Date.now()) : 5000));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        clean = clean && !ownerCleanupUnknown;
        try {
          if (driver) clean = (await driver.close()).cleanup === 'confirmed' && clean;
        } catch {
          clean = false;
        }
        try {
          if (server) clean = (await server.stopOwned()) && clean;
        } catch {
          clean = false;
        }
        if (coordination) {
          try { clean = await coordination.close() && clean; } catch { clean = false; }
        }
        if (!clean) return false;
        try {
          for (const [directory, identity] of namespaceRoots) {
            const stat = lstatSync(directory, { bigint: true });
            if (
              !stat.isDirectory() ||
              stat.isSymbolicLink() ||
              realpathSync(directory) !== directory ||
              stat.dev !== identity.dev ||
              stat.ino !== identity.ino
            )
              return false;
            await rm(directory, { recursive: true, force: true });
          }
          return true;
        } catch {
          return false;
        }
      })();
      closing = purposeBound ? closeCoordinationByDeadline(work, originalDeadline ?? deadline) : work;
      return closing;
    },
  };
}
