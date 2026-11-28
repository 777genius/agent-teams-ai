import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, types as nodeUtilTypes } from 'node:util';
import {
  createOpenCodeV2OwnedSessionClient,
  readOpenCodeV2CheckpointSessionId,
} from '@agent-teams/provider-implementations/opencode';
import { createOpenCodeV2MemberProvider } from './OpenCodeV2MemberProvider.js';
import { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';
import { readOpenCodeV2Snapshot } from './OpenCodeV2ReadOnlySnapshot.js';
import type { OpenCodeV2ReadOnlyClient } from './OpenCodeV2ReadOnlySnapshot.js';
import type { OpenCodeV2EmbeddedReady } from './OpenCodeV2EmbeddedServer.js';
import { openCodeV2EmbeddedConfig } from './OpenCodeV2EmbeddedConfig.js';
import { attestOpenCodeV2ModelSelection } from './OpenCodeV2ModelSelection.js';
import { captureOpenCodeV2SessionCredential } from './OpenCodeV2SessionCredential.js';
import { captureOpenCodeV2Configuration } from './OpenCodeV2CapturedConfiguration.js';
import { AcceptedOpenCodeV2FileKey } from './OpenCodeV2SelectedFileKey.js';
import type { DeferredOpenCodeV2FileKey } from './OpenCodeV2SelectedFileKey.js';
import { runtimeDigest } from '../../runtime/identity.js';
import { capturedMcpSourceCurrent } from '../../mcp-catalog/capturedSource.js';
import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import {
  openCodeV2ImageMimes,
  openCodeV2MediaMimes,
  openCodeV2MediaRevision,
} from './OpenCodeV2MediaReceipt.js';
import type { NativeAttachmentCapabilities } from '../../attachments/attachmentTypes.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
import type { OpenCodeV2OwnedSession } from './OpenCodeV2OwnedSession.js';
import type { NativeInitialContextCapture } from './OpenCodeV2InitialContextReadback.js';
import type {
  OpenCodeV2OwnedSessionSelection,
  OpenCodeV2TransportConfig,
} from '@agent-teams/provider-implementations/opencode';

const unavailable = (): never => {
  throw new Error('OpenCode V2 embedded session unavailable');
};
type OwnedClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
type CheckpointResult = ReturnType<NonNullable<MemberProvider['checkpointBeforeClose']>>;
type FileKeyOriginal = AcceptedOpenCodeV2FileKey | Readonly<{ kind: 'legacy-checkpoint' }>;

function nativeCheckpoint(value: unknown) {
  const nativeSessionId = readOpenCodeV2CheckpointSessionId(value);
  const compatibility: unknown = Object.getOwnPropertyDescriptor(value, 'compatibility')?.value;
  if (typeof compatibility !== 'string') return unavailable();
  return { version: 1 as const, engine: 'opencode-v2' as const, nativeSessionId, compatibility };
}

function embeddedCheckpoint(value: unknown) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  )
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unavailable();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(fields, 'kind')) return { checkpoint: nativeCheckpoint(value) };
  const keys = ['kind', 'version', 'checkpoint', 'nativeFileKeyWitness'];
  const nativeFileKeyWitness: unknown = fields.nativeFileKeyWitness?.value;
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value')) ||
    fields.kind?.value !== 'opencode-v2-file-checkpoint' ||
    fields.version?.value !== 1 ||
    typeof nativeFileKeyWitness !== 'string'
  )
    return unavailable();
  return { checkpoint: nativeCheckpoint(fields.checkpoint?.value), nativeFileKeyWitness };
}

/** Same synchronous original evidence for live and already-sealed closing capture. */
export function captureOpenCodeV2EmbeddedCheckpoint(options: {
  result: CheckpointResult;
  source?: DeferredOpenCodeV2FileKey;
  proof?: AcceptedOpenCodeV2FileKey;
  nativeSessionId?: string;
  scopeDigest?: string;
}): CheckpointResult {
  const { result, source, proof } = options;
  if (!result.ok || !source) return result;
  try {
    if (
      !proof ||
      !AcceptedOpenCodeV2FileKey.matches(proof, source) ||
      proof.scopeDigest !== options.scopeDigest
    )
      return { ok: false, code: 'unavailable' };
    const checkpoint = nativeCheckpoint(result.value);
    if (checkpoint.nativeSessionId !== options.nativeSessionId)
      return { ok: false, code: 'unavailable' };
    if (proof.originalPolicy().kind === 'legacy') return result;
    return {
      ...result,
      value: {
        kind: 'opencode-v2-file-checkpoint',
        version: 1,
        checkpoint,
        nativeFileKeyWitness: proof.encoded,
      },
    };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** Retains this one authorized original; every delegate read returns through Runtime again. */
export async function prepareOpenCodeV2EmbeddedCheckpoint(options: {
  request: MemberProviderContext['request'];
  readCheckpoint: MemberProviderContext['readCheckpoint'];
  source?: DeferredOpenCodeV2FileKey;
  assertCurrent(): void;
}) {
  const originalRequest = options.request,
    request = structuredClone(originalRequest),
    reference = request.checkpointRef;
  if (!reference) return unavailable();
  const { readCheckpoint, source, assertCurrent } = options;
  let proof: AcceptedOpenCodeV2FileKey | undefined;
  const readOriginal = async (ref: string, input: MemberProviderContext['request']) => {
    assertCurrent();
    if (ref !== reference || !isDeepStrictEqual(input, request) || (proof && !proof.filesCurrent()))
      return unavailable();
    const value = await readCheckpoint(ref, input);
    assertCurrent();
    if (!isDeepStrictEqual(input, request) || (proof && !proof.filesCurrent()))
      return unavailable();
    return value;
  };
  const original = await readOriginal(reference, originalRequest);
  const parsed = embeddedCheckpoint(original);
  // Runtime returns detached JSON; capture every original field before crypto suspends.
  const snapshot = structuredClone(original);
  if (parsed.nativeFileKeyWitness !== undefined) {
    if (!source) return unavailable();
    proof = await AcceptedOpenCodeV2FileKey.retained(
      source,
      parsed.nativeFileKeyWitness,
      assertCurrent
    );
    assertCurrent();
    if (
      proof.originalPolicy().kind !== 'protected' ||
      !AcceptedOpenCodeV2FileKey.matches(proof, source)
    )
      return unavailable();
  }
  const read: MemberProviderContext['readCheckpoint'] = async (ref, input) => {
    const value = await readOriginal(ref, input);
    embeddedCheckpoint(value);
    if (!isDeepStrictEqual(value, snapshot)) return unavailable();
    return { ...parsed.checkpoint };
  };
  await read(reference, originalRequest);
  const fileKeyOriginal: FileKeyOriginal | undefined =
    proof ?? (source ? Object.freeze({ kind: 'legacy-checkpoint' as const }) : undefined);
  return {
    nativeSessionId: parsed.checkpoint.nativeSessionId,
    readCheckpoint: read,
    ...(fileKeyOriginal ? { fileKeyOriginal } : {}),
  };
}

/**
 * Native composition for one Runtime-owned child. Runtime retains admission,
 * command receipts and checkpoint ownership; this adapter has no durable ledger.
 */
export function createOpenCodeV2EmbeddedMemberProvider(
  context: MemberProviderContext
): MemberProvider {
  const selected = structuredClone(context.profile);
  if (
    selected.provider !== 'opencode' ||
    selected.nativeGeneration !== 'v2' ||
    selected.protocolRevision !== '2.1.4' ||
    !selected.embedded ||
    hasUntrustedOpenCodeBinaryOverride(selected.environment) ||
    hasUntrustedOpenCodeBinaryOverride(process.env) ||
    selected.mcpPolicyPlugin ||
    (selected.extraArgs?.length ?? 0) !== 0
  )
    return unavailable();
  const profile = selected,
    embedded = selected.embedded;
  const capturedRequest = runtimeDigest(context.request),
    capturedProfile = runtimeDigest(context.profile);
  const capturedEndpoint = runtimeDigest(context.endpoint.binding),
    instructions = context.instructions;
  const originalReadCheckpoint = context.readCheckpoint,
    readinessFileKey = context.readinessFileKey,
    assertReadinessCredential = context.assertReadinessCredential;
  const abort = new AbortController();
  let sealed = false,
    opened = false,
    cleanupUnknown = false,
    nativeImages = false,
    nativeDocuments = false;
  let delegate: MemberProvider | undefined;
  let server: ReturnType<typeof createOpenCodeV2EmbeddedServer> | undefined;
  let nativePin: Readonly<OpenCodeV2EmbeddedReady> | undefined;
  let nativeSessionId: string | undefined;
  let startup: Promise<void> | undefined;
  let initialAttempt:
    | Promise<Awaited<ReturnType<OpenCodeV2OwnedSession['installAndAttestInitialContext']>>>
    | undefined;
  const contextCurrent = () =>
    !sealed &&
    !cleanupUnknown &&
    !abort.signal.aborted &&
    context.isCurrent() &&
    runtimeDigest(context.request) === capturedRequest &&
    runtimeDigest(context.profile) === capturedProfile &&
    runtimeDigest(context.endpoint.binding) === capturedEndpoint &&
    context.instructions === instructions &&
    !hasUntrustedOpenCodeBinaryOverride(process.env) &&
    capturedMcpSourceCurrent(profile);
  const configuration = captureOpenCodeV2Configuration(
    profile,
    { providerId: profile.nativeOptions.providerId, modelId: profile.model },
    contextCurrent
  );
  const { config, selection, requiredToolNames, requiredServerNames } = openCodeV2EmbeddedConfig(
    context,
    configuration.configuration
  );
  const credential = captureOpenCodeV2SessionCredential(
    profile,
    profile.nativeOptions.providerId,
    configuration.isCurrent,
    configuration.key,
    configuration.selectedFile
  );
  const selectedFile = configuration.selectedFile;
  if (
    (readinessFileKey &&
      (!selectedFile || !AcceptedOpenCodeV2FileKey.matches(readinessFileKey, selectedFile))) ||
    (selectedFile && assertReadinessCredential && !readinessFileKey)
  )
    return unavailable();
  let fileKeyOriginal: FileKeyOriginal | undefined = readinessFileKey;
  const current = credential.isCurrent;
  let nativeCredential: OpenCodeV2OwnedSessionSelection['credential'];
  const matchesSelection = (observed: Awaited<ReturnType<OwnedClient['readSession']>>) =>
    runtimeDigest({
      agent: observed.agent,
      model: observed.model,
      permissions: observed.permissions,
      ...(observed.credential ? { credential: observed.credential } : {}),
    }) ===
    runtimeDigest({ ...selection, ...(nativeCredential ? { credential: nativeCredential } : {}) });
  const assertCurrent = () => {
    if (!current()) unavailable();
  };
  function captureClient(signal: AbortSignal, deadline: number) {
    assertCurrent();
    signal.throwIfAborted();
    if (!nativeSessionId || !server || !nativePin || !Number.isSafeInteger(deadline))
      return unavailable();
    const originalServer = server,
      originalPin = nativePin,
      sessionId = nativeSessionId;
    const check = () => {
      assertCurrent();
      signal.throwIfAborted();
      if (
        Date.now() >= deadline ||
        server !== originalServer ||
        nativePin !== originalPin ||
        nativeSessionId !== sessionId ||
        originalPin.endpoint !== profile.endpoint ||
        !originalServer.isOriginalLive(originalPin)
      )
        return unavailable();
    };
    const attest = async (requestSignal: AbortSignal) => {
      check();
      requestSignal.throwIfAborted();
      const custody = await originalServer.readNativeCustody(requestSignal);
      check();
      requestSignal.throwIfAborted();
      if (
        !custody ||
        custody.pid !== originalPin.pid ||
        custody.startIdentity !== originalPin.startIdentity ||
        custody.version !== '2.1.4' ||
        custody.executablePath !== profile.executable.path ||
        custody.executableSha256 !== profile.executable.sha256
      )
        return unavailable();
    };
    const wire: OpenCodeV2TransportConfig = {
      endpoint: originalPin.endpoint,
      directory: profile.cwd,
      version: '2.1.4',
      nativeSessionId: sessionId,
      readPassword: () => {
        check();
        return originalServer.readPassword();
      },
      beforeRequest: attest,
      signal: AbortSignal.any([signal, abort.signal]),
      deadline,
    };
    check();
    return { wire, check, attest };
  }
  async function withClient<T>(
    signal: AbortSignal,
    callback: (client: OwnedClient, config: OpenCodeV2TransportConfig) => Promise<T>,
    deadline = Date.now() + profile.limits.timeoutMs
  ): Promise<T> {
    const captured = captureClient(signal, deadline);
    const client = createOpenCodeV2OwnedSessionClient(captured.wire);
    let failed = false,
      failure: unknown,
      result!: T;
    try {
      result = await callback(client, captured.wire);
      captured.check();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await client.dispose();
    } catch (error) {
      cleanupUnknown = true;
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
    captured.check();
    return result;
  }
  async function withReadOnlyClient<T>(
    signal: AbortSignal,
    deadline: number,
    callback: (client: OpenCodeV2ReadOnlyClient) => Promise<T>
  ): Promise<T> {
    const captured = captureClient(signal, deadline);
    return readOpenCodeV2Snapshot(
      captured.wire,
      {
        assertCurrent: captured.check,
        assertCustody: captured.attest,
        cleanupUnknown: () => {
          cleanupUnknown = true;
        },
      },
      callback
    );
  }
  const attachmentSource = context.attachments,
    attachmentResolve = attachmentSource?.resolve,
    attachmentModel = attachmentSource?.model,
    attachmentRevision = attachmentSource?.revision,
    attachmentMimes = attachmentSource?.mimeTypes;
  const imageMimes = openCodeV2ImageMimes.filter((mime) => attachmentMimes?.includes(mime));
  const mediaMimes = openCodeV2MediaMimes.filter((mime) => attachmentMimes?.includes(mime));
  const attachments =
    mediaMimes.length &&
    attachmentResolve &&
    attachmentModel === `${profile.nativeOptions.providerId}/${profile.model}` &&
    attachmentRevision
      ? {
          model: attachmentModel,
          revision: attachmentRevision,
          mimeTypes: mediaMimes,
          async resolve(
            binding: Parameters<NonNullable<MemberProviderContext['attachments']>['resolve']>[0],
            signal: AbortSignal
          ) {
            assertCurrent();
            signal.throwIfAborted();
            const deadline = Date.now() + profile.limits.timeoutMs;
            const catalog = await withReadOnlyClient(signal, deadline, (client) =>
              client.readCatalog(profile.nativeOptions.providerId)
            );
            const model = catalog.models.find((row) => row.id === profile.model);
            const modality = binding.reference.mimeType === 'application/pdf' ? 'pdf' : 'image';
            if (!model?.enabled || !model.inputModalities.includes(modality)) return undefined;
            assertCurrent();
            signal.throwIfAborted();
            const value = await Reflect.apply(attachmentResolve, attachmentSource, [
              binding,
              signal,
            ]);
            assertCurrent();
            signal.throwIfAborted();
            return value;
          },
        }
      : undefined;
  if (attachmentSource && !attachments) return unavailable();
  async function namespace(root: string | undefined, name: string): Promise<string> {
    if (!root || (await realpath(root)) !== root || !(await lstat(root)).isDirectory())
      return unavailable();
    const directory = join(root, name);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      return unavailable();
    return directory;
  }
  async function start(signal: AbortSignal, deadline: number): Promise<void> {
    return (startup ??= (async () => {
      const check = () => {
        assertCurrent();
        signal.throwIfAborted();
        if (Date.now() >= deadline) unavailable();
      };
      check();
      if (!context.canAllocate() || !nativeSessionId) return unavailable();
      const namespaceId =
        'agent-teams-v2-' +
        runtimeDigest({
          teamId: profile.teamId,
          memberId: profile.memberId,
          sessionId: profile.sessionId,
        }).slice(0, 32);
      const data = await namespace(profile.environment.XDG_DATA_HOME, namespaceId);
      const configuration = await namespace(profile.environment.XDG_CONFIG_HOME, namespaceId);
      const databasePath = join(data, 'opencode.sqlite');
      const existing = await lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      // An uncertain earlier create is never adopted as a new allocation.
      if (context.request.checkpointRef ? !existing?.isFile() : existing !== undefined)
        return unavailable();
      check();
      server = createOpenCodeV2EmbeddedServer({
        profile,
        embedded,
        databasePath,
        configDirectory: configuration,
        config,
        ...(attachments ? { mediaSessionId: nativeSessionId } : {}),
        endpoint: profile.endpoint,
        canAllocate: () => current() && context.canAllocate(),
        canCaptureRegisteredProcess: () =>
          current() && (context.canCaptureRegisteredProcess?.() ?? context.isCurrent()),
        ...(context.processCustody ? { processCustody: context.processCustody } : {}),
        ...(selectedFile
          ? {
              selectedFile: {
                source: selectedFile,
                mode: context.request.checkpointRef ? ('restore' as const) : ('fresh' as const),
                ...(fileKeyOriginal ? { original: fileKeyOriginal } : {}),
              },
            }
          : {}),
      });
      const ready = await server.start(AbortSignal.any([signal, abort.signal]));
      check();
      nativePin = ready;
      const restored = await withReadOnlyClient(signal, deadline, async (client) => {
        const identity = await client.identity();
        if (identity.pid !== ready.pid || identity.version !== embedded.version)
          return unavailable();
        return context.request.checkpointRef ? await client.readSession() : undefined;
      });
      // Credential import and session creation retain their full-before-request
      // mutation transport; the read-only port cannot reach these methods.
      nativeCredential = await withClient(
        signal,
        (client, wire) =>
          credential.prepare(wire, client, restored, (integrationId) =>
            server!.selectedFileKey(ready, integrationId)
          ),
        deadline
      );
      if (assertReadinessCredential) {
        if (!nativeCredential) return unavailable();
        assertReadinessCredential(nativeCredential.scopeDigest);
        check();
      }
      await attestOpenCodeV2ModelSelection(
        {
          readCatalog: (providerId) =>
            withReadOnlyClient(signal, deadline, (client) => client.readCatalog(providerId)),
        },
        selection.model,
        { signal, deadline, isCurrent: current, requireTools: true }
      );
      const selected =
        restored ??
        (await withClient(
          signal,
          (client) =>
            client.createSession({
              ...selection,
              ...(nativeCredential ? { credential: nativeCredential } : {}),
            }),
          deadline
        ));
      check();
      if (!matchesSelection(selected)) return unavailable();
    })());
  }
  async function readContext(capture: NativeInitialContextCapture, signal: AbortSignal) {
    if (
      capture.nativeSessionId !== nativeSessionId ||
      capture.instructions !== instructions ||
      capture.configRevision !== profile.configRevision
    )
      return undefined;
    const value = {
      nativeSessionId,
      instructions: capture.instructions,
      roleInstructions: profile.nativeOptions.instructions ?? '',
      contextDigest: capture.contextDigest,
      configRevision: capture.configRevision,
    };
    const entries = await withClient(signal, (client) => client.instructions());
    if (
      entries.length !== 1 ||
      entries[0]?.key !== 'agent-teams-host' ||
      !isDeepStrictEqual(entries[0].value, value)
    )
      return undefined;
    // Generation is Host authority, while the native entry retains the stable
    // session/context. Cold recovery reads it without repeating the initial PUT.
    return {
      nativeSessionId: capture.nativeSessionId,
      contextDigest: capture.contextDigest,
      configRevision: capture.configRevision,
      generation: capture.generation,
    };
  }
  const owned: OpenCodeV2OwnedSession = {
    verifyMediaReceipt(proof) {
      return (
        current() &&
        nativePin !== undefined &&
        nativeSessionId === proof.sessionId &&
        server?.verifyMediaReceipt(nativePin, proof) === true
      );
    },
    requiredExternalDirectory: embedded.externalDirectory,
    readPassword: () => {
      assertCurrent();
      if (!server) return unavailable();
      return server.readPassword();
    },
    async probe(signal) {
      const deadline = Date.now() + profile.limits.timeoutMs;
      const scoped = AbortSignal.any([
        signal,
        abort.signal,
        AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      ]);
      await start(scoped, deadline);
      nativeImages = false;
      nativeDocuments = false;
      for (;;) {
        if (scoped.aborted || !current() || Date.now() >= deadline) return false;
        const accepted = await withReadOnlyClient(scoped, deadline, async (client) => {
          const identity = await client.identity();
          if (identity.pid !== nativePin?.pid || identity.version !== embedded.version)
            return undefined;
          const session = await client.readSession();
          if (
            !matchesSelection(session) ||
            !(await client.savedPermissionsEmpty()) ||
            !(await client.builtinPluginsOnly())
          )
            return undefined;
          const mcp = await client.readMcp();
          const receipt = context.endpoint.getCatalogReceipt?.();
          // Missing tools/list may still be warming up, but a refused original
          // allocation cannot become current through more native polling.
          if (receipt === undefined && context.canAllocate() !== true) return unavailable();
          if (
            !mcp.every((row) => row.status === 'connected') ||
            !isDeepStrictEqual(mcp.map((row) => row.name).sort(), requiredServerNames) ||
            receipt === undefined ||
            receipt.sequence <= 0 ||
            runtimeDigest(receipt.binding) !== capturedEndpoint ||
            runtimeDigest([...receipt.toolNames].sort()) !== runtimeDigest(requiredToolNames)
          )
            return undefined;
          const catalog = attachments
            ? await client.readCatalog(profile.nativeOptions.providerId)
            : undefined;
          const model = catalog?.models.find(
            (model) => model.id === profile.model && model.enabled
          );
          return {
            images: model?.inputModalities.includes('image') ?? false,
            documents: model?.inputModalities.includes('pdf') ?? false,
          };
        });
        // The result is detached and fully re-attested. A late successful read
        // cannot renew the original absolute launch/probe budget.
        if (scoped.aborted || !current() || Date.now() >= deadline) return false;
        if (accepted) {
          configuration.bindRunningSession();
          nativeImages = accepted.images;
          nativeDocuments = accepted.documents;
          return true;
        }
        await delay(50, undefined, { signal: scoped });
      }
    },
    readNativeCustody: (signal) => server?.readNativeCustody(signal) ?? Promise.resolve(undefined),
    async readNativeEffectivePermissions(signal) {
      const deadline = Date.now() + profile.limits.timeoutMs,
        pin = nativePin;
      if (!pin) return undefined;
      return withReadOnlyClient(signal, deadline, async (client) => {
        const session = await client.readSession();
        if (
          !matchesSelection(session) ||
          !(await client.savedPermissionsEmpty()) ||
          !(await client.builtinPluginsOnly())
        )
          return undefined;
        return {
          nativeSessionId: session.id,
          directory: session.directory,
          modelProviderId: session.model.providerID,
          modelId: session.model.id,
          modelVariant: session.model.variant ?? null,
          pid: pin.pid,
          startIdentity: pin.startIdentity,
          rules: session.permissions,
          policyIsolation: 'builtin-only-empty-saved' as const,
        };
      });
    },
    installAndAttestInitialContext(capture, signal) {
      return (initialAttempt ??= (async () => {
        if (!context.request.checkpointRef)
          await withClient(signal, (client) =>
            client.putInstruction('agent-teams-host', {
              nativeSessionId: capture.nativeSessionId,
              instructions: capture.instructions,
              roleInstructions: profile.nativeOptions.instructions ?? '',
              contextDigest: capture.contextDigest,
              configRevision: capture.configRevision,
            })
          );
        return readContext(capture, signal);
      })());
    },
    readAndAttestInitialContext: readContext,
    async stopOwned() {
      const stopped = await (server?.stopOwned() ?? Promise.resolve(true));
      return stopped && !cleanupUnknown;
    },
    async confirmStopped() {
      const stopped = await (server?.confirmStopped() ?? Promise.resolve(true));
      return stopped && !cleanupUnknown;
    },
  };
  const checkpoint = (result: CheckpointResult): CheckpointResult => {
    const proof = credential.fileProof();
    return captureOpenCodeV2EmbeddedCheckpoint({
      result,
      ...(selectedFile ? { source: selectedFile } : {}),
      ...(proof ? { proof } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(nativeCredential ? { scopeDigest: nativeCredential.scopeDigest } : {}),
    });
  };
  return {
    get attachmentCapabilities(): NativeAttachmentCapabilities {
      const images = !!attachments && current() && nativeImages && imageMimes.length > 0;
      const documents =
        !!attachments && current() && nativeDocuments && mediaMimes.includes('application/pdf');
      return {
        images,
        documents,
        textFiles: false,
        ...(attachments
          ? {
              nativeMedia: {
                revision: openCodeV2MediaRevision,
                mimeTypes: [
                  ...(images ? imageMimes : []),
                  ...(documents ? ['application/pdf' as const] : []),
                ],
                maxBytes: 4 * 1024 * 1024,
                maxCount: 5,
                maxTotalBytes: 8 * 1024 * 1024,
                videos: false as const,
              },
            }
          : {}),
      };
    },
    factory: {
      async open(request) {
        if (opened || runtimeDigest(request) !== capturedRequest || !context.canAllocate())
          return unavailable();
        opened = true;
        try {
          assertCurrent();
          const restored = request.checkpointRef
            ? await prepareOpenCodeV2EmbeddedCheckpoint({
                request,
                ...(selectedFile ? { source: selectedFile } : {}),
                readCheckpoint: (reference, input) =>
                  Reflect.apply(originalReadCheckpoint, context, [reference, input]),
                assertCurrent: () => {
                  assertCurrent();
                  if (runtimeDigest(request) !== capturedRequest || !context.canAllocate())
                    unavailable();
                },
              })
            : undefined;
          if (restored) fileKeyOriginal = restored.fileKeyOriginal;
          nativeSessionId = restored
            ? restored.nativeSessionId
            : 'ses_' +
              runtimeDigest({
                sessionId: profile.sessionId,
                memberId: profile.memberId,
                accountBinding: profile.accountBinding,
              }).slice(0, 40);
          if (
            profile.nativeSessionId &&
            (!request.checkpointRef || profile.nativeSessionId !== nativeSessionId)
          )
            return unavailable();
          assertCurrent();
          delegate = createOpenCodeV2MemberProvider(
            {
              ...context,
              ...(attachments ? { attachments } : {}),
              ...(restored ? { readCheckpoint: restored.readCheckpoint } : {}),
              isCurrent: current,
              canAllocate: () => current() && context.canAllocate(),
              profile: { ...profile, nativeSessionId },
            },
            owned
          );
          // The SPI validates the complete checkpoint before invoking lazy probe/start.
          const opened = await delegate.factory.open(request),
            source = opened.driver;
          return {
            ...opened,
            driver: { ...source, checkpoint: () => checkpoint(source.checkpoint()) },
          };
        } catch (error) {
          sealed = true;
          abort.abort();
          let stopped = false;
          try {
            stopped = await (delegate?.cleanup() ?? owned.stopOwned());
          } catch {
            cleanupUnknown = true;
          }
          if (!stopped || cleanupUnknown)
            throw new Error('OpenCode V2 embedded cleanup unknown', { cause: error });
          throw error;
        }
      },
    },
    captureRegisteredProcess: (pid, registrar) => {
      assertCurrent();
      if (!server) return unavailable();
      return server.captureRegisteredProcess(pid, registrar);
    },
    isReady: () => current() && (delegate?.isReady() ?? false),
    initialContextEvidence: () => (current() ? delegate?.initialContextEvidence?.() : undefined),
    checkpointBeforeClose: (sessionRef) =>
      checkpoint(
        delegate?.checkpointBeforeClose?.(sessionRef) ?? { ok: false, code: 'unavailable' }
      ),
    seal() {
      delegate?.seal();
      sealed = true;
      abort.abort();
    },
    async cleanup() {
      delegate?.seal();
      sealed = true;
      abort.abort();
      const stopped = await (delegate?.cleanup() ?? owned.stopOwned());
      return stopped && !cleanupUnknown;
    },
  };
}
