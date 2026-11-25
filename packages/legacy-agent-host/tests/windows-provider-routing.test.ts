import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCodexMemberProvider } from '../dist/adapters/providers/CodexMemberProvider.js';
import { createOpenCodeMemberProvider } from '../dist/adapters/providers/OpenCodeMemberProvider.js';
import { HostWindowsLaunch } from '../dist/owned-process/HostWindowsLaunch.js';

import type { CapturedProcessPort } from '../dist/adapters/providers/CapturedProcess.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { WindowsServiceIntent } from '../dist/owned-process/retainedServiceContracts.js';

/** Public D factories are real; this boundary allocates no process and performs no HTTP request. */
function context(provider: 'codex' | 'opencode', scoped: boolean, retained: boolean): MemberProviderContext {
  const common = {
    teamId: 'TEST-team', memberId: 'lead', principalId: 'TEST-member', sessionId: 'TEST-session',
    generation: 1, configRevision: 'TEST-config', cwd: '/TEST-workspace', model: 'TEST-model',
    accountBinding: 'TEST-account', executable: { path: '/TEST-provider', sha256: 'a'.repeat(64) },
    environment: { HOME: '/TEST-home', CODEX_HOME: '/TEST-codex',
      XDG_CONFIG_HOME: '/TEST-config', XDG_DATA_HOME: '/TEST-data', XDG_CACHE_HOME: '/TEST-cache' },
    limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 65536, outputEvents: 256,
      pendingInteractions: 4, timeoutMs: 1000 },
    windowsBroker: { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64),
      arch: 'x64' as const, protocol: 1 as const,
      ...(scoped ? { capability: 'service-scopes-v1' as const } : {}) },
  };
  const profile: RuntimeMemberProfile = provider === 'codex'
    ? { ...common, provider, protocolRevision: '0.162.0',
      nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } }
    : { ...common, provider, protocolRevision: '1.18.35', endpoint: 'http://127.0.0.1:14321',
      nativeOptions: { providerId: 'TEST-provider', agent: 'build' } };
  return {
    profile,
    ...(retained ? { retainedWindowsLaunch: new HostWindowsLaunch(() => undefined) } : {}),
    request: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: profile.sessionId,
      generation: 1, configRevision: profile.configRevision, requiredCapabilities: ['text', 'tools'] },
    endpoint: { url: 'http://127.0.0.1:14322/TEST', bearerToken: 'TEST-private',
      binding: { backendId: 'TEST-backend', teamId: profile.teamId, teamName: 'TEST-team',
        runId: 'TEST-run', memberId: profile.memberId, generation: '1' },
      revoke() {}, async close() {} },
    connection: { execute() { throw new Error('TEST unexpected execute'); }, lookup: () => undefined,
      getTask() { throw new Error('TEST unexpected task'); }, listTasks: () => [] },
    instructions: 'TEST captured instructions', isCurrent: () => true, canAllocate: () => true,
    canCaptureRegisteredProcess: () => true, readCheckpoint: async () => undefined, onProgress() {},
  };
}

for (const providerName of ['codex', 'opencode'] as const) {
  test(`${providerName} forwards only its scoped original Windows service intent`, async () => {
    for (const [scoped, retained, physicalCapture] of [
      [true, true, true], [false, true, true], [true, false, true], [true, true, false],
    ] as const) {
      const selected = context(providerName, scoped, retained);
      const registrar = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
        memberId: 'lead', generation: '1' };
      const intent: WindowsServiceIntent = {
        mainEpoch: 'TEST-main', providerCapability: 'TEST-original',
        providerGeneration: 'a3b8fd25-57af-42e8-a3c4-feb65c614257',
        root: { pid: 123, birth: '0000000000000001' }, operationRef: 'TEST-capture',
        command: { operation: 'capture', pid: 456, registrar },
      };
      let captures = 0, cleanup = 0;
      const custody: CapturedProcessPort = {
        launch() { throw new Error('TEST no native launch permitted'); },
        isRunning: () => false, seal() {},
        async confirmStopped() { cleanup++; return true; },
        ...(physicalCapture ? { prepareRegisteredWindowsProcess(pid: number, captured: typeof registrar) {
          assert.equal(this, custody, 'The original custody object must remain bound');
          assert.equal(pid, 456);
          assert.equal(captured, registrar);
          captures++;
          return intent;
        } } : {}),
      };
      const createProcess = () => custody;
      const provider = providerName === 'codex'
        ? createCodexMemberProvider(selected, { createProcess })
        : createOpenCodeMemberProvider(selected, { createProcess,
          fetchImpl: async () => { throw new Error('TEST no native HTTP permitted'); } });
      if (scoped && retained && physicalCapture) {
        assert.equal(typeof provider.prepareRegisteredWindowsProcess, 'function');
        assert.equal(provider.prepareRegisteredWindowsProcess!(456, registrar), intent);
        assert.equal(captures, 1);
      } else {
        assert.equal(provider.prepareRegisteredWindowsProcess, undefined);
        assert.equal(captures, 0);
      }
      assert.equal(await provider.cleanup(), true);
      assert.equal(cleanup, 1);
    }
  });
}
