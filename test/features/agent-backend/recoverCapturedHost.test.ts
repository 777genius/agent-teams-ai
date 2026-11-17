// @vitest-environment node
import { join, resolve } from 'node:path';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { BackendRoutingError, ownerKey } from '../../../src/features/agent-backend/main/application/backendBinding';
import { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import { captureHostPromptSuggestions } from '../../../src/features/agent-backend/main/composition/captureHostPromptSuggestions';
import { recoverCapturedHost } from '../../../src/features/agent-backend/main/composition/recoverCapturedHost';
import { CapturedHostClient } from '../../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { FileHandleBindingStore } from '../../../src/features/agent-backend/main/infrastructure/FileHandleBindingStore';
import { capturedHostProfileDigest } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

import type { BackendHostRecoveryRequest } from '../../../src/features/agent-backend/contracts/operations';
import type { CapturedBackendOwner } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { SelectedHostProfile } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import type { NativeNextPromptCandidate } from '../../../src/features/native-prompt-suggestions/contracts';

const probes = vi.hoisted(() => ({
  created: vi.fn<(
    client: import('../../../src/features/agent-backend/main/infrastructure/CapturedHostClient').CapturedHostClient,
    args: ConstructorParameters<typeof import('../../../src/features/agent-backend/main/infrastructure/CapturedHostClient').CapturedHostClient>
  ) => void>(),
  load: vi.fn<typeof import('../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor').loadDesktopBackendDescriptor>(),
  source: vi.fn<typeof import('../../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody').readMainWindowsCustodySource>(),
}));
vi.mock('../../../src/features/agent-backend/main/infrastructure/CapturedHostClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/features/agent-backend/main/infrastructure/CapturedHostClient')>();
  return { ...actual, CapturedHostClient: class extends actual.CapturedHostClient {
    constructor(...args: ConstructorParameters<typeof actual.CapturedHostClient>) {
      super(...args);
      probes.created(this, args);
    }
  } };
});
vi.mock('../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor', () => ({
  loadDesktopBackendDescriptor: probes.load,
}));
vi.mock('../../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody', () => ({
  readMainWindowsCustodySource: probes.source,
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const retained: RetainedWindowsCustody[] = [];
beforeEach(() => {
  probes.created.mockClear();
  probes.load.mockReset();
  probes.source.mockReset();
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(process, 'platform', platform);
  for (const [client] of probes.created.mock.calls)
    expect((await client.shutdown()).childExit).toBe('confirmed');
  for (const owner of retained.splice(0)) expect(await owner.close()).toBe(true);
});

/** Constructor-only clients and existing ports; no Host or Windows process is started. */
function fixture() {
  const directory = resolve('TEST-prompt-recovery');
  const profile: SelectedHostProfile = {
    profileId: 'TEST-captured-profile', nodeExecutable: join(directory, 'node'), nodeVersion: 'v24.21.0',
    nodeSha256: '1'.repeat(64), hostEntry: join(directory, 'host.mjs'), hostEntrySha256: '2'.repeat(64),
    expectedBuildId: 'TEST-build', cwd: directory, env: { HOME: directory },
    startupTimeoutMs: 3000, requestTimeoutMs: 1000, writeTimeoutMs: 1000, shutdownTimeoutMs: 100,
  };
  const owner = { ownerId: 'TEST-owner', revision: 'TEST-revision' };
  const scope = { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: 'TEST-team',
    runId: 'TEST-run', memberId: 'TEST-member', generation: 1 };
  const definition: DesktopBackendDescriptor['handles'][number] = {
    handleId: 'TEST-handle', owner, scope, contextId: 'TEST-context', label: 'TEST-team',
    members: [{ memberId: 'TEST-member', label: 'Worker' }],
  };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1, defaultOwner: owner, owners: [{ ...owner, storageRoot: directory, profile }],
    handles: [definition],
  };
  const router = new BackendOwnerRouter(new FileHandleBindingStore(join(directory, 'bindings')));
  const state: {
    current: boolean;
    foreground: boolean;
    descriptor: DesktopBackendDescriptor | undefined;
    router: BackendOwnerRouter | undefined;
    definitions: DesktopBackendDescriptor['handles'];
  } = { current: true, foreground: true, descriptor, router, definitions: descriptor.handles };
  const clients = new Map<string, CapturedBackendOwner>();
  const publish = vi.fn<(value: NativeNextPromptCandidate) => void>();
  const settings = {
    definitions: () => state.definitions,
    currentClient: (key: string) => clients.get(key)?.client,
    isCurrent: () => state.current,
    publish, enabled: true,
  };
  const optionsFor = captureHostPromptSuggestions(settings);
  const allocate = vi.fn(() => { throw new Error('TEST recovery must not allocate a provider'); });
  const nativeCustody = new RetainedWindowsCustody({
    profileId: profile.profileId, profileDigest: capturedHostProfileDigest(profile),
    selectBroker: allocate,
    async verifyLaunch() { throw new Error('TEST recovery must not launch a provider'); },
  });
  retained.push(nativeCustody);
  const firstOptions = optionsFor(owner);
  const original: CapturedBackendOwner = { ...owner, storageRoot: directory, nativeCustody,
    client: new CapturedHostClient(profile, nativeCustody, undefined, firstOptions) };
  clients.set(ownerKey(owner), original);
  const options: Parameters<typeof recoverCapturedHost>[2] = {
    selection: { path: join(directory, 'descriptor.json'), sha256: '3'.repeat(64) },
    descriptor: () => state.descriptor,
    router: () => state.router,
    definitions: () => state.definitions,
    clients,
    isCurrent: () => state.current,
    clientOptions: vi.fn(optionsFor),
  };
  const guard = { isCurrent: () => state.foreground };
  const request: BackendHostRecoveryRequest = {
    operation: 'host.recovery.capture', handle: { handleId: definition.handleId },
    commandId: 'TEST-original-recovery', payload: {},
  };
  probes.load.mockResolvedValue(descriptor);
  probes.source.mockReturnValue({ path: profile.hostEntry, sha256: profile.hostEntrySha256,
    source: { processCustody: { kind: 'main-windows-v1' } }, selected: [] });
  const starts = vi.spyOn(CapturedHostClient.prototype, 'start').mockImplementation(() => {
    throw new Error('TEST composition must not start a Host');
  });
  const route = vi.spyOn(router, 'recover').mockResolvedValue({ phase: 'captured',
    capability: '11111111-1111-4111-8111-111111111111' });
  return { state, clients, original, owner, nativeCustody, descriptor, definition,
    options, settings, firstOptions, guard, request, route, starts, publish, allocate };
}

const prompt = {
  provider: 'codex', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', memberName: 'Worker',
  generation: '1', suggestionId: 'TEST-suggestion', messageId: 'TEST-message', inputId: 'TEST-input',
  operationRef: 'TEST-operation', completedTurnRef: 'TEST-turn', text: 'Review the original changes',
};

it('forwards captured preferences, original custody and the same remaining function to a new client', async () => {
  const f = fixture();
  const replacement = vi.fn();
  Object.assign(f.settings, { enabled: false, publish: replacement });
  await expect(recoverCapturedHost(f.request, f.guard, f.options)).resolves.toMatchObject({ phase: 'captured' });
  const source = f.route.mock.calls[0]?.[1];
  if (!source) throw new Error('TEST original recovery source missing');
  expect(f.route.mock.calls[0]?.[2]).toBe(f.guard);
  expect(probes.created).toHaveBeenCalledTimes(1);
  expect(source.nativeCustody).toBe(f.nativeCustody);
  expect(source.isCurrent(f.original.client)).toBe(true);
  await source.verify(() => {
    if (!source.isCurrent(f.original.client)) throw new BackendRoutingError('hold');
  });
  expect(probes.load).toHaveBeenCalledWith(f.options.selection);
  expect(probes.source).toHaveBeenCalledWith(f.original.client.profile);
  const remaining = vi.fn(() => 1475);
  const candidate = source.create(remaining);
  const created = probes.created.mock.calls.at(-1);
  if (!created) throw new Error('TEST successor constructor missing');
  const [actual, args] = created;
  expect(actual).toBe(candidate);
  expect(args[0]).toBe(f.original.client.profile);
  expect(args[1]).toBe(f.nativeCustody);
  expect(args[2]).toBe(remaining);
  expect(remaining).not.toHaveBeenCalled();
  const nextOptions = args[3];
  const oldSink = f.firstOptions.onNativePromptSuggestion;
  const nextSink = nextOptions?.onNativePromptSuggestion;
  if (!oldSink || !nextSink || !nextOptions) throw new Error('TEST original prompt composition missing');
  expect(nextOptions.nativeNextPromptEnabled).toBe(true);
  expect(nextOptions).not.toBe(f.firstOptions);
  expect(nextSink).not.toBe(oldSink);
  oldSink(prompt, f.original.client);
  nextSink(prompt, candidate);
  expect(f.publish).toHaveBeenCalledTimes(1);
  source.install(f.original.client, candidate);
  expect(f.clients.get(ownerKey(f.owner))?.client).toBe(candidate);
  expect(source.isCurrent(f.original.client)).toBe(false);
  expect(source.isCurrent(candidate)).toBe(true);
  oldSink(prompt, f.original.client);
  expect(f.publish).toHaveBeenCalledTimes(1);
  nextSink(prompt, candidate);
  expect(f.publish).toHaveBeenCalledTimes(2);
  expect(replacement).not.toHaveBeenCalled();
  expect(probes.created).toHaveBeenCalledTimes(2);
  expect(f.starts).not.toHaveBeenCalled();
  expect(f.allocate).not.toHaveBeenCalled();
});

it.each(['feature', 'platform', 'duplicate-handle', 'custody', 'profile', 'storage-root'] as const)(
  'refuses stale %s recovery before creating options, a successor or a Host start', async reason => {
    const f = fixture();
    if (reason === 'feature') f.state.current = false;
    else if (reason === 'platform') Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    else if (reason === 'duplicate-handle') f.state.definitions = [f.definition, f.definition];
    else if (reason === 'custody') f.clients.set(ownerKey(f.owner), {
      ...f.owner, storageRoot: f.original.storageRoot, client: f.original.client,
    });
    else if (reason === 'profile') f.state.descriptor = { ...f.descriptor,
      owners: [{ ...f.descriptor.owners[0]!, profile: { ...f.original.client.profile, expectedBuildId: 'TEST-changed' } }] };
    else f.clients.set(ownerKey(f.owner), { ...f.original, storageRoot: join(f.original.storageRoot, 'changed') });
    await expect(recoverCapturedHost(f.request, f.guard, f.options)).rejects.toMatchObject({
      code: reason === 'feature' || reason === 'platform' ? 'unavailable' : 'hold',
      outcome: 'not-dispatched',
    });
    expect(f.options.clientOptions).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
    expect(probes.load).not.toHaveBeenCalled();
    expect(probes.created).toHaveBeenCalledTimes(1);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
  }
);

it('retains source verification error identity, post-await currentness and guarded installation', async () => {
  const f = fixture();
  await recoverCapturedHost(f.request, f.guard, f.options);
  const source = f.route.mock.calls[0]?.[1];
  if (!source) throw new Error('TEST original recovery source missing');
  const assertCurrent = () => {
    if (!source.isCurrent(f.original.client)) throw new BackendRoutingError('hold');
  };
  const rejected = new Error('TEST original descriptor failure');
  probes.load.mockRejectedValueOnce(rejected);
  await expect(source.verify(assertCurrent)).rejects.toBe(rejected);
  let complete!: (value: DesktopBackendDescriptor) => void;
  const deferred = new Promise<DesktopBackendDescriptor>(resolveDescriptor => { complete = resolveDescriptor; });
  probes.load.mockReturnValueOnce(deferred);
  const verifying = source.verify(assertCurrent);
  f.state.definitions = [{ ...f.definition, label: 'TEST-replaced-definition' }];
  complete(f.descriptor);
  await expect(verifying).rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
  expect(probes.source).not.toHaveBeenCalled();
  expect(probes.created).toHaveBeenCalledTimes(1);
  f.state.definitions = f.descriptor.handles;
  probes.source.mockReturnValueOnce(undefined);
  await expect(source.verify(assertCurrent)).rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
  const candidate = source.create(() => 1475);
  f.state.foreground = false;
  expect(() => source.install(f.original.client, candidate)).toThrow(BackendRoutingError);
  expect(f.clients.get(ownerKey(f.owner))).toBe(f.original);
  f.state.foreground = true;
  const replacement = { ...f.original };
  f.clients.set(ownerKey(f.owner), replacement);
  expect(() => source.install(f.original.client, candidate)).toThrow(BackendRoutingError);
  expect(f.clients.get(ownerKey(f.owner))).toBe(replacement);
  expect(f.starts).not.toHaveBeenCalled();
  expect(f.allocate).not.toHaveBeenCalled();
});
