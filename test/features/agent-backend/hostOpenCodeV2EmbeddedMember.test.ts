// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { MemberProviderContext } from '../../../packages/legacy-agent-host/src/adapters/providers/MemberProvider';
import type { OpenCodeV2OwnedSession } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2OwnedSession';

const controlled = vi.hoisted(() => ({
  client: (): unknown => {
    throw new Error('TEST client unset');
  },
  server: (): unknown => {
    throw new Error('TEST server unset');
  },
  capture: (_context: MemberProviderContext): void => {},
}));
vi.mock(
  '../../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/opencode.js',
  () => ({
    createOpenCodeV2OwnedSessionClient: () => controlled.client(),
    readOpenCodeV2CheckpointSessionId: () => {
      throw new Error('TEST unexpected checkpoint read');
    },
  })
);
vi.mock(
  '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.js',
  () => ({
    createOpenCodeV2EmbeddedServer: () => controlled.server(),
  })
);
vi.mock(
  '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedConfig.js',
  () => ({
    openCodeV2EmbeddedConfig: () => ({
      config: {},
      requiredToolNames: ['TEST-tool'],
      requiredServerNames: ['agent-teams'],
      selection: {
        agent: 'TEST-agent',
        model: { providerID: 'TEST-provider', id: 'TEST-model' },
        permissions: [],
      },
    }),
  })
);
vi.mock(
  '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2MemberProvider.js',
  () => ({
    createOpenCodeV2MemberProvider: (
      context: MemberProviderContext,
      owned: OpenCodeV2OwnedSession
    ) => {
      controlled.capture(context);
      return {
        factory: {
          async open() {
            if (!(await owned.probe(new AbortController().signal)))
              throw new Error('TEST refused probe');
            return { driver: {}, capabilities: ['text', 'attachments'] };
          },
        },
        seal() {},
        cleanup: () => owned.stopOwned(),
        isReady: () => true,
      };
    },
  })
);
import { createOpenCodeV2EmbeddedMemberProvider } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedMemberProvider';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(image = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-attachment-owner-')));
  roots.push(root);
  for (const name of ['config', 'data', 'workspace', 'home']) mkdirSync(join(root, name));
  const selection = {
    id: 'ses_TEST',
    agent: 'TEST-agent',
    model: { providerID: 'TEST-provider', id: 'TEST-model' },
    permissions: [],
  };
  let live = true;
  const ready = Object.freeze({ endpoint: 'http://127.0.0.1:12345', pid: 10, startIdentity: 'TEST-birth' });
  const stop = vi.fn(async () => { live = false; return true; }),
    resolve = vi.fn(async (binding: unknown) => ({ binding, bytes: new Uint8Array([1]) }));
  let callbackFailure: Error | undefined,
    disposalFailure = false,
    heldDisposal: Promise<void> | undefined;
  let disposalStarted = () => {};
  const client = {
    async identity() {
      if (callbackFailure) throw callbackFailure;
      return { pid: 10, version: '2.1.4' };
    },
    async createSession() {
      return selection;
    },
    async readSession() {
      return selection;
    },
    async savedPermissionsEmpty() {
      return true;
    },
    async builtinPluginsOnly() {
      return true;
    },
    async readMcp() {
      return [{ name: 'agent-teams', status: 'connected' }];
    },
    async readCatalog() {
      return {
        provider: { id: 'TEST-provider', name: 'TEST provider', activation: 'enabled' },
        defaultModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
        models: [
          {
            id: 'TEST-model',
            enabled: true,
            variants: ['default'],
            supportsTools: true,
            inputModalities: image ? ['text', 'image'] : ['text'],
          },
        ],
      };
    },
    async dispose() {
      disposalStarted();
      await heldDisposal;
      if (disposalFailure) throw new Error('TEST disposal failed');
    },
  };
  controlled.client = () => client;
  controlled.server = () => ({
    async start() {
      return ready;
    },
    isOriginalLive: (capture: unknown) => capture === ready && live,
    async readNativeCustody() {
      return live ? { pid: ready.pid, startIdentity: ready.startIdentity, version: '2.1.4',
        executablePath: '/TEST/bun', executableSha256: 'a'.repeat(64) } : undefined;
    },
    readPassword: () => 'TEST-private',
    stopOwned: stop,
    confirmStopped: stop,
  });
  let delegateContext: MemberProviderContext | undefined;
  controlled.capture = (context) => {
    delegateContext = context;
  };
  const request = {
    tenantId: 'TEST-tenant',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-r1',
    requiredCapabilities: ['text'],
  };
  const context = {
    profile: {
      provider: 'opencode',
      nativeGeneration: 'v2',
      protocolRevision: '2.1.4',
      embedded: { version: '2.1.4', externalDirectory: 'deny' },
      teamId: 'TEST-team',
      memberId: 'TEST-member',
      sessionId: request.sessionId,
      configRevision: request.configRevision,
      accountBinding: 'TEST-account',
      model: 'TEST-model',
      cwd: join(root, 'workspace'),
      endpoint: 'http://127.0.0.1:12345',
      nativeOptions: { providerId: 'TEST-provider' },
      limits: { timeoutMs: 1000 },
      executable: { path: '/TEST/bun', sha256: 'a'.repeat(64) },
      environment: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data') },
    },
    request,
    endpoint: {
      binding: { memberId: 'TEST-member' },
      getCatalogReceipt: () => ({
        sequence: 1,
        binding: { memberId: 'TEST-member' },
        toolNames: ['TEST-tool'],
      }),
    },
    instructions: 'TEST original context',
    isCurrent: () => true,
    canAllocate: () => true,
    attachments: {
      model: 'TEST-provider/TEST-model',
      revision: 'TEST-PNG-policy',
      mimeTypes: ['image/png'],
      resolve,
    },
  } as unknown as MemberProviderContext;
  const provider = createOpenCodeV2EmbeddedMemberProvider(context);
  return {
    provider,
    request,
    stop,
    resolve,
    attachments: () => delegateContext!.attachments!,
    fail(primary: Error) {
      callbackFailure = primary;
      disposalFailure = true;
    },
    holdDispose() {
      let release = () => {};
      heldDisposal = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        disposalStarted = done;
      });
      return { release, entered };
    },
  };
}

test('rejected owned-client disposal stays UNKNOWN while physical stop preserves the original callback failure', async () => {
  const f = fixture(),
    primary = new Error('TEST original callback failure');
  f.fail(primary);
  await expect(f.provider.factory.open(f.request)).rejects.toMatchObject({
    message: 'OpenCode V2 embedded cleanup unknown',
    cause: primary,
  });
  expect(f.stop).toHaveBeenCalled();
  expect(await f.provider.cleanup()).toBe(false);
  expect(f.provider.isReady()).toBe(false);
  expect(f.resolve).not.toHaveBeenCalled();
});

test('seal during catalog disposal cannot call the original attachment byte resolver', async () => {
  const f = fixture();
  await f.provider.factory.open(f.request);
  expect(f.provider.attachmentCapabilities).toEqual({
    images: true,
    documents: false,
    textFiles: false,
  });
  const held = f.holdDispose();
  const pending = f
    .attachments()
    .resolve(
      {} as Parameters<NonNullable<MemberProviderContext['attachments']>['resolve']>[0],
      new AbortController().signal
    );
  const rejected = expect(pending).rejects.toThrow('OpenCode V2 embedded session unavailable');
  await held.entered;
  f.provider.seal();
  held.release();
  await rejected;
  expect(f.resolve).not.toHaveBeenCalled();
  expect(await f.provider.cleanup()).toBe(true);
});

test('image capability is absent before native catalog attestation and disabled for a text-only model', async () => {
  const f = fixture(false);
  expect(f.provider.attachmentCapabilities?.images).toBe(false);
  await f.provider.factory.open(f.request);
  expect(f.provider.attachmentCapabilities).toEqual({
    images: false,
    documents: false,
    textFiles: false,
  });
  expect(
    await f
      .attachments()
      .resolve(
        {} as Parameters<NonNullable<MemberProviderContext['attachments']>['resolve']>[0],
        new AbortController().signal
      )
  ).toBeUndefined();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(await f.provider.cleanup()).toBe(true);
});
