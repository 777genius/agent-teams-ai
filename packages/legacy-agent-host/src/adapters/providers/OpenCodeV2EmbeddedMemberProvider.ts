import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createOpenCodeV2OwnedSessionClient,
  readOpenCodeV2CheckpointSessionId } from '@agent-teams/provider-implementations/opencode';
import { createOpenCodeV2MemberProvider } from './OpenCodeV2MemberProvider.js';
import { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';
import { openCodeV2EmbeddedConfig } from './OpenCodeV2EmbeddedConfig.js';
import { runtimeDigest } from '../../runtime/identity.js';
import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
import type { OpenCodeV2OwnedSession } from './OpenCodeV2OwnedSession.js';
import type { NativeInitialContextCapture } from './OpenCodeV2InitialContextReadback.js';

const unavailable = (): never => { throw new Error('OpenCode V2 embedded session unavailable'); };
type OwnedClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;

/**
 * Native composition for one Runtime-owned child. Runtime retains admission,
 * command receipts and checkpoint ownership; this adapter has no durable ledger.
 */
export function createOpenCodeV2EmbeddedMemberProvider(context: MemberProviderContext): MemberProvider {
  const selected = structuredClone(context.profile);
  if (selected.provider !== 'opencode' || selected.nativeGeneration !== 'v2' ||
      selected.protocolRevision !== '2.1.4' || !selected.embedded ||
      hasUntrustedOpenCodeBinaryOverride(selected.environment) ||
      hasUntrustedOpenCodeBinaryOverride(process.env) || selected.mcpPolicyPlugin ||
      selected.capturedMcpServers || selected.capturedMcpSource || selected.mcpCatalogSource ||
      (selected.extraArgs?.length ?? 0) !== 0) return unavailable();
  const profile = selected, embedded = selected.embedded;
  const capturedRequest = runtimeDigest(context.request), capturedProfile = runtimeDigest(context.profile);
  const capturedEndpoint = runtimeDigest(context.endpoint.binding), instructions = context.instructions;
  const { config, selection, requiredToolNames } = openCodeV2EmbeddedConfig(context);
  const abort = new AbortController();
  let sealed = false, opened = false, cleanupUnknown = false, nativeImages = false;
  let delegate: MemberProvider | undefined;
  let server: ReturnType<typeof createOpenCodeV2EmbeddedServer> | undefined;
  let nativePin: Readonly<{ pid: number; startIdentity: string }> | undefined;
  let nativeSessionId: string | undefined;
  let startup: Promise<void> | undefined;
  let initialAttempt: Promise<Awaited<ReturnType<OpenCodeV2OwnedSession['installAndAttestInitialContext']>>> | undefined;
  const current = () => !sealed && !cleanupUnknown && !abort.signal.aborted && context.isCurrent() &&
    runtimeDigest(context.request) === capturedRequest && runtimeDigest(context.profile) === capturedProfile &&
    runtimeDigest(context.endpoint.binding) === capturedEndpoint && context.instructions === instructions &&
    !hasUntrustedOpenCodeBinaryOverride(process.env);
  const assertCurrent = () => { if (!current()) unavailable(); };
  async function withClient<T>(signal: AbortSignal, callback: (client: OwnedClient) => Promise<T>): Promise<T> {
    assertCurrent();
    if (!nativeSessionId || !server || !nativePin) return unavailable();
    const client = createOpenCodeV2OwnedSessionClient({
      endpoint: profile.endpoint, directory: profile.cwd, version: '2.1.4', nativeSessionId,
      readPassword: () => { assertCurrent(); return server!.readPassword(); },
      beforeRequest: async requestSignal => {
        assertCurrent();
        const custody = await server!.readNativeCustody(requestSignal);
        assertCurrent(); requestSignal.throwIfAborted();
        if (!custody || custody.pid !== nativePin!.pid ||
            custody.startIdentity !== nativePin!.startIdentity ||
            custody.version !== '2.1.4' || custody.executablePath !== profile.executable.path ||
            custody.executableSha256 !== profile.executable.sha256) return unavailable();
      },
      signal: AbortSignal.any([signal, abort.signal]), deadline: Date.now() + profile.limits.timeoutMs,
    });
    let failed = false, failure: unknown, result!: T;
    try { result = await callback(client); assertCurrent(); }
    catch (error) { failed = true; failure = error; }
    try { await client.dispose(); }
    catch (error) { cleanupUnknown = true; if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
    assertCurrent(); signal.throwIfAborted(); return result;
  }
  const attachmentSource = context.attachments, attachmentResolve = attachmentSource?.resolve,
    attachmentModel = attachmentSource?.model, attachmentRevision = attachmentSource?.revision,
    attachmentMimes = attachmentSource?.mimeTypes;
  const attachments = attachmentMimes?.includes('image/png') && attachmentResolve &&
    attachmentModel === `${profile.nativeOptions.providerId}/${profile.model}` && attachmentRevision ? {
      model: attachmentModel, revision: attachmentRevision, mimeTypes: ['image/png'],
      async resolve(binding: Parameters<NonNullable<MemberProviderContext['attachments']>['resolve']>[0], signal: AbortSignal) {
        assertCurrent(); signal.throwIfAborted();
        const catalog = await withClient(signal, client => client.readCatalog(profile.nativeOptions.providerId));
        const model = catalog.models.find(row => row.id === profile.model);
        if (!model?.enabled || !model.inputModalities.includes('image')) return undefined;
        assertCurrent(); signal.throwIfAborted();
        const value = await Reflect.apply(attachmentResolve, attachmentSource, [binding, signal]);
        assertCurrent(); signal.throwIfAborted(); return value;
      },
    } : undefined;
  if (attachmentSource && !attachments) return unavailable();
  async function namespace(root: string | undefined, name: string): Promise<string> {
    if (!root || await realpath(root) !== root || !(await lstat(root)).isDirectory()) return unavailable();
    const directory = join(root, name);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) return unavailable();
    return directory;
  }
  async function start(signal: AbortSignal): Promise<void> {
    return startup ??= (async () => {
      assertCurrent();
      if (!context.canAllocate() || !nativeSessionId) return unavailable();
      const namespaceId = 'agent-teams-v2-' + runtimeDigest({
        teamId: profile.teamId, memberId: profile.memberId, sessionId: profile.sessionId,
      }).slice(0, 32);
      const data = await namespace(profile.environment.XDG_DATA_HOME, namespaceId);
      const configuration = await namespace(profile.environment.XDG_CONFIG_HOME, namespaceId);
      const databasePath = join(data, 'opencode.sqlite');
      const existing = await lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      // An uncertain earlier create is never adopted as a new allocation.
      if (context.request.checkpointRef ? !existing?.isFile() : existing !== undefined) return unavailable();
      assertCurrent();
      server = createOpenCodeV2EmbeddedServer({
        profile, embedded, databasePath, configDirectory: configuration, config,
        endpoint: profile.endpoint, canAllocate: () => current() && context.canAllocate(),
        canCaptureRegisteredProcess: () => current() &&
          (context.canCaptureRegisteredProcess?.() ?? context.isCurrent()),
        ...(context.processCustody ? { processCustody: context.processCustody } : {}),
      });
      const ready = await server.start(AbortSignal.any([signal, abort.signal]));
      assertCurrent();
      nativePin = Object.freeze({ pid: ready.pid, startIdentity: ready.startIdentity });
      await withClient(signal, async client => {
        const identity = await client.identity();
        if (identity.pid !== ready.pid || identity.version !== embedded.version) return unavailable();
        const selected = context.request.checkpointRef
          ? await client.readSession() : await client.createSession(selection);
        if (runtimeDigest({ agent: selected.agent, model: selected.model, permissions: selected.permissions }) !==
            runtimeDigest(selection)) return unavailable();
      });
    })();
  }
  async function readContext(capture: NativeInitialContextCapture, signal: AbortSignal) {
    if (capture.nativeSessionId !== nativeSessionId || capture.instructions !== instructions ||
        capture.configRevision !== profile.configRevision) return undefined;
    const value = { nativeSessionId, instructions: capture.instructions,
      roleInstructions: profile.nativeOptions.instructions ?? '',
      contextDigest: capture.contextDigest, configRevision: capture.configRevision };
    const entries = await withClient(signal, client => client.instructions());
    if (entries.length !== 1 || entries[0]?.key !== 'agent-teams-host' ||
        !isDeepStrictEqual(entries[0].value, value)) return undefined;
    // Generation is Host authority, while the native entry retains the stable
    // session/context. Cold recovery reads it without repeating the initial PUT.
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      configRevision: capture.configRevision, generation: capture.generation };
  }
  const owned: OpenCodeV2OwnedSession = {
    requiredExternalDirectory: embedded.externalDirectory,
    readPassword: () => { assertCurrent(); if (!server) return unavailable(); return server.readPassword(); },
    async probe(signal) {
      await start(signal);
      const deadline = Date.now() + profile.limits.timeoutMs;
      for (;;) {
        const accepted = await withClient(signal, async client => {
          const identity = await client.identity();
          const custody = await server!.readNativeCustody(signal);
          if (!custody || identity.pid !== custody.pid || identity.version !== custody.version) return false;
          const session = await client.readSession();
          if (runtimeDigest({ agent: session.agent, model: session.model, permissions: session.permissions }) !==
              runtimeDigest(selection) || !await client.savedPermissionsEmpty() ||
              !await client.builtinPluginsOnly()) return false;
          const mcp = await client.readMcp();
          const receipt = context.endpoint.getCatalogReceipt?.();
          return mcp.length === 1 && mcp[0]?.name === 'agent-teams' && mcp[0].status === 'connected' &&
            receipt !== undefined && receipt.sequence > 0 &&
            runtimeDigest(receipt.binding) === capturedEndpoint &&
            runtimeDigest([...receipt.toolNames].sort()) === runtimeDigest(requiredToolNames);
        });
        if (accepted) {
          if (attachments) {
            const catalog = await withClient(signal, client => client.readCatalog(profile.nativeOptions.providerId));
            assertCurrent(); signal.throwIfAborted();
            nativeImages = catalog.models.some(model => model.id === profile.model && model.enabled && model.inputModalities.includes('image'));
          }
          return true;
        }
        if (signal.aborted || !current() || Date.now() >= deadline) return false;
        await delay(50, undefined, { signal });
      }
    },
    readNativeCustody: signal => server?.readNativeCustody(signal) ?? Promise.resolve(undefined),
    async readNativeEffectivePermissions(signal) {
      return withClient(signal, async client => {
        const session = await client.readSession();
        const custody = await server!.readNativeCustody(signal);
        if (!custody || !await client.savedPermissionsEmpty() ||
            !await client.builtinPluginsOnly()) return undefined;
        return { nativeSessionId: session.id, directory: session.directory,
          modelProviderId: session.model.providerID, modelId: session.model.id,
          modelVariant: session.model.variant ?? null, pid: custody.pid,
          startIdentity: custody.startIdentity, rules: session.permissions,
          policyIsolation: 'builtin-only-empty-saved' };
      });
    },
    installAndAttestInitialContext(capture, signal) {
      return initialAttempt ??= (async () => {
        if (!context.request.checkpointRef) await withClient(signal, client => client.putInstruction(
          'agent-teams-host', { nativeSessionId: capture.nativeSessionId, instructions: capture.instructions,
            roleInstructions: profile.nativeOptions.instructions ?? '',
            contextDigest: capture.contextDigest, configRevision: capture.configRevision }
        ));
        return readContext(capture, signal);
      })();
    },
    readAndAttestInitialContext: readContext,
    async stopOwned() { const stopped = await (server?.stopOwned() ?? Promise.resolve(true)); return stopped && !cleanupUnknown; },
    async confirmStopped() { const stopped = await (server?.confirmStopped() ?? Promise.resolve(true)); return stopped && !cleanupUnknown; },
  };
  return {
    get attachmentCapabilities() {
      return { images: !!attachments && current() && nativeImages, documents: false, textFiles: false };
    },
    factory: { async open(request) {
      if (opened || runtimeDigest(request) !== capturedRequest || !context.canAllocate()) return unavailable();
      opened = true;
      try {
        assertCurrent();
        nativeSessionId = request.checkpointRef
          ? readOpenCodeV2CheckpointSessionId(await context.readCheckpoint(request.checkpointRef, request))
          : 'ses_' + runtimeDigest({ sessionId: profile.sessionId, memberId: profile.memberId,
              accountBinding: profile.accountBinding }).slice(0, 40);
        if (profile.nativeSessionId && (!request.checkpointRef || profile.nativeSessionId !== nativeSessionId))
          return unavailable();
        assertCurrent();
        delegate = createOpenCodeV2MemberProvider({ ...context,
          ...(attachments ? { attachments } : {}),
          isCurrent: current, canAllocate: () => current() && context.canAllocate(),
          profile: { ...profile, nativeSessionId } }, owned);
        // The SPI validates the complete checkpoint before invoking lazy probe/start.
        return await delegate.factory.open(request);
      } catch (error) {
        sealed = true; abort.abort();
        let stopped = false;
        try { stopped = await (delegate?.cleanup() ?? owned.stopOwned()); } catch { cleanupUnknown = true; }
        if (!stopped || cleanupUnknown) throw new Error('OpenCode V2 embedded cleanup unknown', { cause: error });
        throw error;
      }
    } },
    captureRegisteredProcess: (pid, registrar) => {
      assertCurrent(); if (!server) return unavailable();
      return server.captureRegisteredProcess(pid, registrar);
    },
    isReady: () => current() && (delegate?.isReady() ?? false),
    initialContextEvidence: () => current() ? delegate?.initialContextEvidence?.() : undefined,
    checkpointBeforeClose: sessionRef => delegate?.checkpointBeforeClose?.(sessionRef) ??
      { ok: false, code: 'unavailable' },
    seal() { delegate?.seal(); sealed = true; abort.abort(); },
    async cleanup() {
      delegate?.seal(); sealed = true; abort.abort();
      const stopped = await (delegate?.cleanup() ?? owned.stopOwned());
      return stopped && !cleanupUnknown;
    },
  };
}
