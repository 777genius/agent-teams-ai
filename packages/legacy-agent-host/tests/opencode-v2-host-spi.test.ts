import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { MemberProviderContext } from '../src/adapters/providers/MemberProvider.ts';
import type { OpenCodeV2OwnedSession } from '../src/adapters/providers/OpenCodeV2MemberProvider.ts';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';

const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const { runtimeProfileSchema } = await import(sourceMode
  ? '../src/composition/runtimeProfile.ts'
  : '../dist/composition/runtimeProfile.js');
const { createOpenCodeV2MemberProvider } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeV2MemberProvider.ts'
  : '../dist/adapters/providers/OpenCodeV2MemberProvider.js');
const { finalizeOpenCodeV2ObserverAfterClose, guardOpenCodeV2ObserverCleanup } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeV2ObserverCleanup.ts'
  : '../dist/adapters/providers/OpenCodeV2ObserverCleanup.js');
const { createOpenCodeMemberProvider } = await import(sourceMode
  ? '../src/adapters/providers/OpenCodeMemberProvider.ts'
  : '../dist/adapters/providers/OpenCodeMemberProvider.js');
const { applyLaunchConfiguration } = await import(sourceMode
  ? '../src/composition/launchConfiguration.ts'
  : '../dist/composition/launchConfiguration.js');

// Synthetic TEST-only fixtures use canonical paths of the current OS.
// These do not attest a real native process or qualify the Desktop product.
function v2Profile() {
  const separator = process.platform === 'win32' ? String.fromCharCode(92) : '/';
  const root = process.platform === 'win32'
    ? 'C:' + separator + 'TEST-only-opencode-v2' : '/TEST-only-opencode-v2';
  return {
    provider: 'opencode' as const,
    nativeGeneration: 'v2' as const,
    protocolRevision: '2.0.21' as const,
    cwd: root,
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, root + separator + key])),
    executable: { path: root + separator + 'native-engine', sha256: 'a'.repeat(64) },
    teamId: 'test-team',
    memberId: 'test-member',
    principalId: 'test-principal',
    sessionId: 'test-session',
    generation: 1,
    configRevision: 'test-revision',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    endpoint: 'http://127.0.0.1:14321',
    nativeSessionId: 'ses_TESTowned',
    limits: {
      queuedInputs: 2, inputBytes: 8192, outputBytes: 8192,
      outputEvents: 100, pendingInteractions: 2, timeoutMs: 1000,
    },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build' },
  };
}

// The runtime schema is intentionally stricter than the old vendor's
// source-only test fixture. Windows must not be approved by a POSIX mock.
function nativeV2Profile() {
  const original = v2Profile();
  if (process.platform !== 'win32') return original;
  const separator = String.fromCharCode(92);
  const root = 'C:' + separator + 'TEST-only-opencode-v2';
  return {
    ...original, cwd: root,
    executable: { ...original.executable, path: root + separator + 'native-engine' },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map((key) => [key, root + separator + key])),
  };
}

// The existing V1 capture stays POSIX-only even on Windows.
function v1Profile() {
  return {
    ...v2Profile(), nativeGeneration: undefined, protocolRevision: '1.19.4' as const,
    nativeSessionId: undefined, cwd: '/TEST-only-opencode-v2',
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, '/TEST-only-opencode-v2/' + key])),
    executable: { path: '/TEST-only-opencode-v2/native-engine', sha256: 'a'.repeat(64) },
  };
}

function request(): OpenConfig {
  return {
    tenantId: 'test-tenant', projectId: 'test-project', sessionId: 'test-session',
    generation: 1, configRevision: 'test-revision',
    requiredCapabilities: ['text'],
  };
}

function context(profile = v2Profile(), open = request()): MemberProviderContext {
  return {
    profile: profile as MemberProviderContext['profile'],
    request: open,
    endpoint: { binding: { backendId: 'test-backend', teamId: 'test-team', runId: 'test-run', memberId: 'test-member', generation: 'test-generation' } },
    instructions: 'TEST-only role, team and workspace instructions',
    isCurrent: () => true,
    canAllocate: () => true,
    onProgress: () => {},
    readCheckpoint: async () => undefined,
  } as unknown as MemberProviderContext;
}

function testNativeCustody() {
  return {
    executablePath: v2Profile().executable.path,
    executableSha256: v2Profile().executable.sha256,
    pid: 17001,
    startIdentity: 'TEST-start-1',
    version: '2.0.21',
  };
}

function testNativePermissionReadback(rules: unknown) {
  const custody = testNativeCustody();
  return { nativeSessionId: v2Profile().nativeSessionId,
    pid: custody.pid, startIdentity: custody.startIdentity, rules };
}

function owner(probeOk: boolean, effective: 'deny' | 'ask' | 'allow' = 'deny') {
  const calls = { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 };
  const captured: OpenCodeV2OwnedSession = {
    requiredExternalDirectory: 'deny',
    readPassword() { calls.password++; return 'TEST-only-password'; },
    async probe() { calls.probe++; return probeOk; },
    async readNativeCustody() { return testNativeCustody(); },
    async readNativeEffectivePermissions() {
      calls.permissions++;
      return testNativePermissionReadback([
        { action: 'external_directory', resource: '*', effect: effective },
      ]);
    },
    async installAndAttestInitialContext(capture) {
      calls.context++;
      return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
        generation: capture.generation, configRevision: capture.configRevision };
    },
    async stopOwned() { calls.stop++; return true; },
    async confirmStopped() { calls.stopped++; return true; },
  };
  return { calls, captured };
}

test('V2 rejects accessor-backed native owner methods before getter can forge policy', () => {
  for (const name of [
    'readPassword', 'probe', 'readNativeCustody', 'readNativeEffectivePermissions',
    'installAndAttestInitialContext', 'stopOwned', 'confirmStopped',
  ] as const) {
    const { captured, calls } = owner(true);
    let getterCalls = 0;
    let forgedPermissionCalls = 0;
    Object.defineProperty(captured, name, {
      get() {
        getterCalls++;
        captured.readNativeEffectivePermissions = async () => {
          forgedPermissionCalls++;
          return testNativePermissionReadback([
            { action: 'external_directory', resource: '*', effect: 'deny' },
          ]);
        };
        return async () => 'TEST-forged-owner-callback';
      },
    });
    assert.throws(() => createOpenCodeV2MemberProvider(context(), captured),
      /data-property native owner callbacks/,
      `native owner ${name} getter is not a trustworthy callback bundle`);
    assert.equal(getterCalls, 0, 'native callback getter must not execute');
    assert.equal(forgedPermissionCalls, 0, 'no forged policy readback is installed or used');
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 },
      'rejected owner must not run native operations');
  }
});

test('V2 rejects Proxy native owner receivers and prototype chains before descriptor traps', () => {
  for (const placement of ['receiver', 'prototype'] as const) {
    const { captured, calls } = owner(true, 'allow');
    let descriptorTraps = 0;
    let prototypeTraps = 0;
    let forgedPermissionReads = 0;
    const proxied = new Proxy(captured, {
      getOwnPropertyDescriptor(target, name) {
        descriptorTraps++;
        // Pre-fix, the trap could replace a later callback before capture.
        target.readNativeEffectivePermissions = async () => {
          forgedPermissionReads++;
          return testNativePermissionReadback([
            { action: 'external_directory', resource: '*', effect: 'deny' },
          ]);
        };
        return Reflect.getOwnPropertyDescriptor(target, name);
      },
      getPrototypeOf(target) {
        prototypeTraps++;
        return Reflect.getPrototypeOf(target);
      },
    });
    const suspect = placement === 'receiver' ? proxied :
      Object.create(proxied) as OpenCodeV2OwnedSession;
    assert.throws(() => createOpenCodeV2MemberProvider(context(), suspect),
      /data-property native owner callbacks/,
      placement + ' must fail before a Proxy trap can forge the native owner');
    assert.equal(descriptorTraps, 0, 'never run an untrusted descriptor trap');
    assert.equal(prototypeTraps, 0, 'never run an untrusted prototype trap');
    assert.equal(forgedPermissionReads, 0, 'no forged native DENY readback');
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 },
      'rejected owner cannot acquire or mutate a native process');
  }
});

test('V2 rejects Proxy-wrapped Host and native owner callbacks before invoking their apply traps', () => {
  for (const boundary of ['Host authority', 'native owner'] as const) {
    const { captured, calls } = owner(false);
    const host = context();
    let forgedCalls = 0;
    if (boundary === 'Host authority') {
      host.isCurrent = new Proxy(() => false, {
        apply() { forgedCalls++; return true; },
      });
    } else {
      captured.probe = new Proxy(captured.probe, {
        apply() { forgedCalls++; return Promise.resolve(true); },
      });
    }
    assert.throws(() => createOpenCodeV2MemberProvider(host, captured),
      new RegExp('data-property ' + boundary + ' callbacks'),
      'a callable Proxy must not forge a current Host lease or successful native probe');
    assert.equal(forgedCalls, 0, 'reject before calling the Proxy apply trap');
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 },
      'a rejected callback must never acquire native authority');
  }
});

test('V2 accepts prototype data methods while retaining the original owner receiver', async () => {
  const { captured, calls } = owner(true);
  // A class-style owner can expose methods on its prototype. The Host must
  // bind them to the actual instance, not to the prototype or a late swap.
  const instance = Object.create(captured) as OpenCodeV2OwnedSession & {
    probeCalls: number;
  };
  instance.probeCalls = 0;
  captured.probe = async function (this: typeof instance) {
    this.probeCalls++;
    return true;
  };
  const provider = createOpenCodeV2MemberProvider(context(), instance);
  captured.probe = async () => false; // Retained method must survive this swap.
  const opened = await provider.factory.open(request());
  try {
    assert.equal(provider.isReady(), true);
    assert.equal(instance.probeCalls, 1, 'captured method uses the original instance receiver');
    assert.equal(calls.context, 1, 'native context is installed once');
    assert.equal(calls.password, 0, 'no credentials needed for initial admission');
  } finally {
    await opened.driver.close();
    assert.equal(await provider.cleanup(), true);
  }
  assert.equal(calls.stop, 1, 'only the captured TEST owner is stopped');
});

test('V2 policy getter cannot swap native permission or cleanup callbacks before capture', async () => {
  const { captured, calls } = owner(true);
  let forgedPermissions = 0;
  let forgedStops = 0;
  // The original native owner is unsafe: external-directory ALLOW.
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return testNativePermissionReadback([
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ]);
  };
  // Accessing the policy property itself installs fake DENY readback and a
  // fake stop callback. An adapter that binds methods after this getter
  // accepts the untrusted permission proof and can misreport custody.
  Object.defineProperty(captured, 'requiredExternalDirectory', {
    get() {
      captured.readNativeEffectivePermissions = async () => {
        forgedPermissions++;
        return testNativePermissionReadback([
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ]);
      };
      captured.stopOwned = async () => { forgedStops++; return true; };
      return 'deny';
    },
  });
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/,
    'the policy getter cannot launder an originally unsafe owner into readiness');
  assert.equal(calls.probe, 1);
  assert.equal(calls.permissions, 1, 'the original ALLOW readback must be rejected');
  assert.equal(forgedPermissions, 0, 'never trust the swapped DENY method');
  assert.equal(calls.context, 0, 'no native instruction mutation');
  assert.equal(calls.password, 0, 'no credentials are accessed');
  assert.equal(calls.stop, 1, 'the original TEST-owned stop callback is used');
  assert.equal(forgedStops, 0, 'never invoke the forged cleanup callback');
  assert.equal(await provider.cleanup(), true);
});

test('V2 rejects forged per-function bind even when a fake reader reports DENY', async () => {
  const { captured, calls } = owner(true, 'allow');
  const original = captured.readNativeEffectivePermissions;
  let forgedBinds = 0;
  Object.defineProperty(original, 'bind', {
    value: () => {
      forgedBinds++;
      return async () => testNativePermissionReadback([
        { action: 'external_directory', resource: '*', effect: 'deny' },
      ]);
    },
  });
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(forgedBinds, 0);
  assert.equal(calls.permissions, 1, 'must invoke the original ALLOW policy reader');
  assert.equal(calls.context, 0, 'unsafe policy cannot install context');
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1);
});

test('V2 owner callback metadata cannot mutate permissions or physical stop during capture',
  async () => {
    // Binding a callable reads its own .length and .name. Neither property
    // belongs to the native owner trust boundary: metadata getters must not
    // execute while capturing any of the seven callback identities.
    for (const callback of [
      'readPassword', 'probe', 'readNativeCustody', 'readNativeEffectivePermissions',
      'installAndAttestInitialContext', 'stopOwned', 'confirmStopped',
    ] as const) {
      for (const property of ['length', 'name'] as const) {
        const { captured, calls } = owner(true, 'allow');
        const original = captured[callback];
        let metadataReads = 0;
        let forgedPermissions = 0;
        let forgedStops = 0;
        Object.defineProperty(original, property, {
          configurable: true,
          get() {
            metadataReads++;
            captured.readNativeEffectivePermissions = async () => {
              forgedPermissions++;
              return testNativePermissionReadback([
                { action: 'external_directory', resource: '*', effect: 'deny' },
              ]);
            };
            captured.stopOwned = async () => { forgedStops++; return true; };
            return property === 'name' ? 'forged-metadata' : 0;
          },
        });
        const provider = createOpenCodeV2MemberProvider(context(), captured);
        await assert.rejects(() => provider.factory.open(request()),
          /opencode.driver.dependency-unavailable/,
          'original native ALLOW must not be laundered into a forged DENY policy');
        assert.equal(metadataReads, 0, callback + '.' + property + ' getter must never run');
        assert.equal(calls.permissions, 1, 'only original ALLOW reader is invoked');
        assert.equal(forgedPermissions, 0, 'no forged permission readback');
        assert.equal(calls.context, 0, 'no native mutation under untrusted policy');
        assert.equal(calls.password, 0, 'no credentials before native admission');
        assert.equal(calls.stop, 1, 'stop only original TEST-owned process');
        assert.equal(forgedStops, 0, 'no forged physical cleanup callback');
        assert.equal(await provider.cleanup(), true);
      }
    }
  });

test('V2 Host authority function metadata cannot substitute a revoked allocation lease', async () => {
  for (const callback of ['isCurrent', 'canAllocate'] as const) {
    for (const property of ['name', 'length'] as const) {
      const input = context();
      input.isCurrent = () => true;
      input.canAllocate = () => false;
      const { captured, calls } = owner(true);
      let metadataReads = 0;
      let forgedChecks = 0;
      Object.defineProperty(input[callback], property, {
        configurable: true,
        get() {
          metadataReads++;
          // The old bind(isCurrent) read metadata before capturing canAllocate,
          // letting this getter replace a denied allocation with a forged one.
          input.canAllocate = () => { forgedChecks++; return true; };
          return property === 'name' ? 'forged-lease' : 0;
        },
      });
      const provider = createOpenCodeV2MemberProvider(input, captured);
      await assert.rejects(() => provider.factory.open(request()),
        /opencode\.driver\.invalid-config/,
        'the originally denied allocation must never become an authorized launch');
      assert.equal(metadataReads, 0, callback + '.' + property + ' getter must not execute');
      assert.equal(forgedChecks, 0, 'no forged Host authority invoked');
      assert.equal(calls.probe, 0, 'reject before native process identity readback');
      assert.equal(calls.permissions, 0, 'reject before native permission readback');
      assert.equal(calls.context, 0, 'no native instruction mutation');
      assert.equal(calls.password, 0, 'no native credentials');
      assert.equal(await provider.cleanup(), true);
      assert.equal(calls.stop, 1, 'retire only the captured TEST-owned process');
    }
  }
});

test('V2 Host refuses truthy non-boolean lease results before any native admission',
  async () => {
    const invalidResults: ReadonlyArray<{ name: string; value: unknown }> = [
      { name: 'unawaited false Promise', value: Promise.resolve(false) },
      { name: 'false-shaped object', value: { authorized: false } },
      { name: 'numeric truthy', value: 1 },
    ];
    for (const callback of ['isCurrent', 'canAllocate'] as const) {
      for (const invalid of invalidResults) {
        const input = context();
        input[callback] = (() => invalid.value) as unknown as () => boolean;
        const { captured, calls } = owner(true);
        const provider = createOpenCodeV2MemberProvider(input, captured);
        await assert.rejects(() => provider.factory.open(request()),
          /opencode\.driver\.invalid-config/,
          callback + ' cannot authorize a native process with ' + invalid.name);
        assert.equal(provider.isReady(), false, 'invalid Host lease is permanently revoked');
        assert.equal(calls.probe, 0, 'no native probe with non-boolean Host authority');
        assert.equal(calls.permissions, 0, 'no native permission readback');
        assert.equal(calls.context, 0, 'no native context mutation');
        assert.equal(calls.password, 0, 'no native credentials');
        assert.equal(await provider.cleanup(), true, 'only the TEST owner is cleaned up');
        assert.equal(calls.stop, 1, 'no duplicate native process stop');
      }
    }
  });

test('V2 rejects accessor-backed Host authority without executing the getter', () => {
  for (const callback of ['isCurrent', 'canAllocate'] as const) {
    const input = context();
    const { captured, calls } = owner(true);
    let getterReads = 0;
    Object.defineProperty(input, callback, {
      configurable: true,
      get() {
        getterReads++;
        return () => true;
      },
    });
    assert.throws(() => createOpenCodeV2MemberProvider(input, captured),
      /data-property/, 'Host authority must be a captured data-property callback');
    assert.equal(getterReads, 0, 'no Host getter side effect during capture');
    assert.equal(calls.probe, 0, 'no native access before Host authority capture');
    assert.equal(calls.password, 0, 'no credentials before Host authority capture');
  }
});

test('V2 owner policy getter cannot replace captured Host authority callbacks', async () => {
  const input = context();
  let lease = true;
  input.isCurrent = () => lease;
  input.canAllocate = () => lease;
  const { captured, calls } = owner(true);
  Object.defineProperty(captured, 'requiredExternalDirectory', {
    get() {
      lease = false;
      input.isCurrent = () => true;
      input.canAllocate = () => true;
      return 'deny';
    },
  });
  const provider = createOpenCodeV2MemberProvider(input, captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode\.driver\.invalid-config/,
    'a revoked captured Host lease must prevent native admission');
  assert.equal(calls.probe, 0);
  assert.equal(calls.permissions, 0);
  assert.equal(calls.context, 0);
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1);
});

test('V2 admission cannot accept forged permission readback swapped during owner probe', async () => {
  const { captured, calls } = owner(true);
  let forgedPermissionCalls = 0;
  // The original captured owner reports external-directory ALLOW. A probe
  // swaps the method for a counterfeit DENY reader before Host reads it.
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return testNativePermissionReadback([
      { action: 'external_directory', resource: '*', effect: 'allow' },
    ]);
  };
  captured.probe = async () => {
    calls.probe++;
    captured.readNativeEffectivePermissions = async () => {
      forgedPermissionCalls++;
      return testNativePermissionReadback([
        { action: 'external_directory', resource: '*', effect: 'deny' },
      ]);
    };
    return true;
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/,
    'a changed owner method cannot forge native permission policy');
  assert.equal(calls.probe, 1);
  assert.equal(calls.permissions, 1, 'only the original native readback is trusted');
  assert.equal(forgedPermissionCalls, 0);
  assert.equal(calls.context, 0, 'no initial native mutation under false DENY');
  assert.equal(calls.password, 0, 'no credentials to unqualified native engine');
  assert.equal(calls.stop, 1, 'only the original TEST-owned process is retired');
  assert.equal(await provider.cleanup(), true);
});

test('V2 owner method binding retains receiver but cannot launder mutable helper policy',
  async () => {
    // Binding protects the original method identity, NOT its receiver's
    // mutable helpers. The native permission readback must still reject ALLOW.
    type ReceiverOwner = OpenCodeV2OwnedSession & {
      nativeEffect: 'allow' | 'deny';
      nativePolicyHelper(): 'allow' | 'deny';
    };
    const { captured, calls } = owner(true);
    const receiver = captured as ReceiverOwner;
    receiver.nativeEffect = 'deny';
    receiver.nativePolicyHelper = function (this: ReceiverOwner) {
      return this.nativeEffect;
    };
    let forgedCalls = 0;
    captured.readNativeEffectivePermissions = async function (this: OpenCodeV2OwnedSession) {
      calls.permissions++;
      return testNativePermissionReadback([
        { action: 'external_directory', resource: '*',
          effect: (this as ReceiverOwner).nativePolicyHelper() },
      ]);
    };
    captured.probe = async function (this: OpenCodeV2OwnedSession) {
      calls.probe++;
      const originalReceiver = this as ReceiverOwner;
      originalReceiver.nativeEffect = 'allow';
      // A replacement method falsely claims DENY. The captured original
      // reader must instead use its receiver's live helper and fail closed.
      originalReceiver.readNativeEffectivePermissions = async () => {
        forgedCalls++;
        return testNativePermissionReadback([
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ]);
      };
      return true;
    };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    await assert.rejects(() => provider.factory.open(request()),
      /opencode.driver.dependency-unavailable/);
    assert.equal(calls.probe, 1);
    assert.equal(calls.permissions, 1, 'original receiver-bound reader runs');
    assert.equal(forgedCalls, 0, 'swapped receiver method is never called');
    assert.equal(calls.context, 0, 'mutable helper ALLOW cannot authorize instructions');
    assert.equal(calls.password, 0, 'no credentials after unsafe native policy');
    assert.equal(calls.stop, 1, 'only captured TEST owner is stopped');
    assert.equal(await provider.cleanup(), true);
  });

test('V2 admission never follows a replaced native credential callback',
  { timeout: 10000 }, async () => {
    let requests = 0;
    const observedAuthorization: Array<string | undefined> = [];
    const server = createServer((req, response) => {
      requests++;
      observedAuthorization.push(req.headers.authorization);
      response.writeHead(503);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const profile = v2Profile();
    profile.endpoint = 'http://127.0.0.1:' + address.port;
    const { captured, calls } = owner(true);
    let forgedPasswordCalls = 0;
    captured.probe = async () => {
      calls.probe++;
      captured.readPassword = () => {
        forgedPasswordCalls++;
        return 'TEST-forged-password';
      };
      return true;
    };
    const provider = createOpenCodeV2MemberProvider(context(profile), captured);
    let opened: Awaited<ReturnType<typeof provider.factory.open>> | undefined;
    try {
      opened = await provider.factory.open(request());
      assert.equal(provider.isReady(), true);
      await opened.driver.submit({
        inputId: 'TEST-credential-method-swap', operationRef: 'TEST-credential-method-swap-op',
        content: 'TEST only, no model execution',
      });
      assert.equal(forgedPasswordCalls, 0, 'transport never reads swapped owner credentials');
      assert.equal(calls.password, 1, 'original owner is read exactly once');
      assert.ok(requests >= 1, 'the original credential path reached the TEST HTTP peer');
      const expectedAuthorization = 'Basic ' +
        Buffer.from('opencode:TEST-only-password').toString('base64');
      assert.deepEqual(observedAuthorization, Array(requests).fill(expectedAuthorization),
        'all TEST HTTP requests use captured original owner credentials');
    } finally {
      await opened?.driver.close();
      await provider.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
    assert.equal(calls.stop, 1, 'only the captured TEST owner is stopped');
  });

test('V2 never coerces an untrusted native credential into HTTP Basic authorization',
  { timeout: 10000 }, async () => {
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(500);
      response.end();
    });
    let requests = 0;
    let coerced = 0;
    const profile = v2Profile();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    profile.endpoint = 'http://127.0.0.1:' + address.port;
    const { captured, calls } = owner(true);
    captured.readPassword = () => {
      calls.password++;
      return {
        toString() {
          coerced++;
          return 'TEST-untrusted-credential';
        },
      } as unknown as string;
    };
    const provider = createOpenCodeV2MemberProvider(context(profile), captured);
    let opened: Awaited<ReturnType<typeof provider.factory.open>> | undefined;
    try {
      opened = await provider.factory.open(request());
      assert.equal(provider.isReady(), true);
      let accepted = false;
      try {
        accepted = (await opened.driver.submit({
          inputId: 'TEST-untrusted-password', operationRef: 'TEST-untrusted-password-op',
          content: 'TEST only, no model execution',
        })).ok;
      } catch {
        // The Session SPI may reject an invalid owner credential outright.
      }
      assert.equal(accepted, false, 'an invalid credential cannot authorize a native POST');
      assert.equal(coerced, 0, 'never invoke the forged credential toString');
      assert.equal(requests, 0, 'no HTTP request can use an untrusted credential');
      assert.equal(calls.password, 1, 'a failed credential projection is not retried');
      assert.equal(provider.isReady(), false, 'the TEST owner is quarantined');
      assert.equal(await provider.cleanup(), true);
      assert.equal(calls.stop, 1, 'stop only the captured TEST-owned process');
    } finally {
      await opened?.driver.close();
      await provider.cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  });

test('V2 profile is explicit and cannot inherit V1 plugin, auto-permission, argv or version', () => {
  const valid = nativeV2Profile();
  assert.equal(runtimeProfileSchema.safeParse({ members: [valid] }).success, true);
  for (const invalid of [
    { ...valid, protocolRevision: '1.19.4' },
    { ...valid, protocolRevision: '2.1.4' },
    { ...valid, nativeGeneration: undefined },
    { ...valid, nativeSessionId: undefined },
    { ...valid, mcpPolicyPlugin: { path: '/TEST-only-plugin', sha256: 'b'.repeat(64) } },
    { ...valid, capturedMcpServers: {} },
    // Historical Claude MCP catalog and V1 source snapshots must not be
    // smuggled into a generation-selected V2 profile via the common fields.
    { ...valid, mcpCatalogSource: { claudeConfigPath: '/TEST-only/v1-claude.json' } },
    { ...valid, capturedMcpSource: {
      userConfigPath: '/TEST-only/v1-user.json', projectPath: '/TEST-only/v1-project',
      policy: { mode: 'inheritScopes' },
    } },
    { ...valid, nativeOptions: { ...valid.nativeOptions, toolApprovalMode: 'auto' } },
    { ...valid, extraArgs: ['--install-v1-plugin'] },
    { ...valid, environment: { ...valid.environment,
      OPENCODE_BIN_PATH: '/TEST-untrusted/native' } },
    { ...valid, environment: { ...valid.environment,
      opencode_bin_path: '/TEST-untrusted/lowercase-native' } },
    { ...valid, environment: { ...valid.environment,
      OpenCode_Bin_Path: '/TEST-untrusted/mixed-case-native' } },
  ]) assert.equal(runtimeProfileSchema.safeParse({ members: [invalid] }).success, false,
    JSON.stringify(invalid));
  assert.equal(runtimeProfileSchema.safeParse({ members: [
    { ...v1Profile(),
      environment: { ...v1Profile().environment, OPENCODE_BIN_PATH: '/TEST-only-V1-legacy-path' } },
  ] }).success, true, 'unchanged V1 default remains valid');
});

test('native V2 captures canonical OS paths without widening legacy V1 paths', () => {
  const base = v2Profile();
  const windows = process.platform === 'win32';
  const winSep = String.fromCharCode(92);
  const root = windows ? 'C:' + winSep + 'TEST-owned-v2' : '/TEST-owned-v2';
  const namespace = (suffix: string) => root + (windows ? winSep : '/') + suffix;
  const selected = {
    ...base, cwd: root, executable: { ...base.executable, path: namespace('opencode.exe') },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map((key) => [key, namespace(key)])),
  };
  assert.equal(runtimeProfileSchema.safeParse({ members: [selected] }).success, true,
    'V2 needs a canonical, real native path on its own OS');
  // A normalized path cannot stand in for a trusted captured workspace.
  for (const invalid of [
    { ...selected, cwd: namespace('..') },
    { ...selected, executable: { ...selected.executable, path: namespace('..') } },
    { ...selected, environment: { ...selected.environment, HOME: namespace('..') } },
    ...(windows ? [
      { ...selected, cwd: root + winSep + 'trailing. ' },
      { ...selected, executable: { ...selected.executable, path: 'C:relative.exe' } },
      { ...selected, environment: { ...selected.environment, XDG_CACHE_HOME: winSep.repeat(2) + 'server' + winSep + 'share' } },
    ] : []),
  ]) assert.equal(runtimeProfileSchema.safeParse({ members: [invalid] }).success, false,
    'V2 must reject noncanonical native namespace paths');
  const legacy = { ...selected, nativeGeneration: undefined, protocolRevision: '1.19.4',
    nativeSessionId: undefined };
  if (windows) {
    assert.equal(runtimeProfileSchema.safeParse({ members: [legacy] }).success, false,
      'do not expand legacy V1 path policy for Windows');
    const v1Posix = v1Profile();
    assert.equal(runtimeProfileSchema.safeParse({ members: [v1Posix] }).success, true);
  } else {
    assert.equal(runtimeProfileSchema.safeParse({ members: [legacy] }).success, true);
  }
});

test('corrected private V2 driver accepts canonical Windows TEST profile after captured owner proof', async () => {
  if (process.platform !== 'win32') return;
  const profile = nativeV2Profile();
  assert.equal(runtimeProfileSchema.safeParse({ members: [profile] }).success, true);
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(profile), captured);
  const opened = await provider.factory.open(request());
  try {
    assert.equal(provider.isReady(), true, 'synthetic owner admission, not native qualification');
    assert.equal(calls.probe, 1, 'corrected private driver reaches captured TEST owner');
    assert.equal(calls.context, 1, 'initial TEST context attested once');
    assert.equal(calls.stop, 0, 'no premature stop on valid canonical path');
    assert.equal(calls.password, 0, 'TEST admission does not touch credentials');
  } finally {
    await opened.driver.close();
    assert.equal(await provider.cleanup(), true);
  }
});

test('V2 launch rejects unproven model/variant changes and V1 permission modes', () => {
  const base = runtimeProfileSchema.parse({ members: [nativeV2Profile()] }).members[0]!;
  const unsupported = [
    { permissions: 'manual' }, { permissions: 'bypass' },
    { model: 'TEST-next-model' }, { model: 'TEST-provider/TEST-next-model' },
    { model: 'FOREIGN-provider/TEST-model' },
    { model: 'TEST-model' }, // Unqualified ID has no catalog provider provenance.
    { effort: 'high' }, { effort: 'none' },
  ] as const;
  for (const choice of unsupported) {
    assert.throws(() => applyLaunchConfiguration(base, choice), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'invalid' &&
      'reason' in error && error.reason === 'launch-option-unsupported',
    `Unattested V2 launch option was accepted: ${JSON.stringify(choice)}`);
  }
  // The exact provider-qualified model is the only explicit V2 selection
  // that can be compared with this captured profile; bare IDs are ambiguous.
  const selectedQualified = applyLaunchConfiguration(base, {
    model: 'TEST-provider/TEST-model',
  });
  assert.equal(selectedQualified.provider, 'opencode');
  if (selectedQualified.provider !== 'opencode') throw new Error('Expected OpenCode profile');
  assert.equal(selectedQualified.model, base.model);
  assert.equal(selectedQualified.nativeOptions.toolApprovalMode, undefined);
  assert.equal(selectedQualified.nativeOptions.variant, undefined);
  // The raw selection is ambiguous: provider TEST-provider's model
  // TEST-model has the same spelling as native model TEST-provider/TEST-model.
  // Reject it without UI provenance; its doubly-qualified alias is distinct.
  const nestedBase = runtimeProfileSchema.parse({ members: [{
    ...nativeV2Profile(), model: 'TEST-provider/TEST-model',
  }] }).members[0]!;
  assert.throws(() => applyLaunchConfiguration(nestedBase, {
    model: 'TEST-provider/TEST-model',
  }), (error: unknown) => error instanceof Error && 'reason' in error &&
    error.reason === 'launch-option-unsupported',
  'ambiguous model selections must fail closed');
  const nestedSelected = applyLaunchConfiguration(nestedBase, {
    model: 'TEST-provider/TEST-provider/TEST-model',
  });
  assert.equal(nestedSelected.model, nestedBase.model);
  assert.equal(nestedSelected.nativeOptions.variant, undefined);
  // A catalog alias may be longer than a single 256-character ID. Only the
  // qualified alias of the ACTUAL captured V2 model is admitted at that size.
  const longProvider = 'p'.repeat(180);
  const longModel = 'm'.repeat(160);
  const longBase = runtimeProfileSchema.parse({ members: [{
    ...nativeV2Profile(), model: longModel,
    nativeOptions: { ...nativeV2Profile().nativeOptions, providerId: longProvider },
  }] }).members[0]!;
  const longAlias = `${longProvider}/${longModel}`;
  assert.ok(longAlias.length > 256);
  assert.equal(applyLaunchConfiguration(longBase, { model: longAlias }).model, longModel);
  for (const [profile, model] of [
    [longBase, longAlias + '-different'],
    [longBase, 'x'.repeat(350)],
    [runtimeProfileSchema.parse({ members: [v1Profile()] }).members[0]!, longAlias],
  ] as const) {
    assert.throws(() => applyLaunchConfiguration(profile, { model }),
      (error: unknown) => error instanceof Error && 'reason' in error &&
        error.reason === 'launch-option-unsupported',
      'an oversized model string must not broaden V1 or switch the captured V2 model');
  }
  assert.throws(
    () => applyLaunchConfiguration(nestedBase, { model: 'TEST-provider/OTHER-model' }),
    (error: unknown) => error instanceof Error && 'reason' in error &&
      error.reason === 'launch-option-unsupported',
    'a different model must still fail closed even with a provider prefix',
  );
  // A saved variant is not native proof. An explicit matching effort is
  // unsupported until the owned engine's effective variant can be attested.
  const capturedVariantBase = runtimeProfileSchema.parse({ members: [{
    ...nativeV2Profile(),
    nativeOptions: { ...nativeV2Profile().nativeOptions, variant: 'high' },
  }] }).members[0]!;
  for (const choice of [
    {},
    { model: 'TEST-provider/TEST-model' },
  ]) {
    const selected = applyLaunchConfiguration(capturedVariantBase, choice);
    assert.equal(selected.provider, 'opencode');
    if (selected.provider !== 'opencode') throw new Error('Expected OpenCode profile');
    assert.equal(selected.nativeGeneration, 'v2');
    assert.equal(selected.model, capturedVariantBase.model);
    assert.equal(selected.nativeOptions.variant, 'high',
      'implicit launch must preserve captured variant without changing it');
    assert.equal(selected.nativeOptions.toolApprovalMode, undefined,
      'implicit launch must not inherit V1 auto/manual approvals');
    assert.deepEqual(selected.executable, capturedVariantBase.executable,
      'implicit launch cannot substitute pinned native engine');
    assert.equal(selected.nativeSessionId, capturedVariantBase.nativeSessionId);
  }
  for (const choice of [
    { effort: 'high' },
    { model: 'TEST-model', effort: 'high' },
    { model: 'TEST-provider/TEST-model', effort: 'high' },
  ]) {
    assert.throws(() => applyLaunchConfiguration(capturedVariantBase, choice),
      (error: unknown) => error instanceof Error && 'reason' in error &&
        error.reason === 'launch-option-unsupported',
      'matching effort alone cannot attest actual native variant');
  }
  for (const choice of [
    { effort: 'low' },
    { model: 'TEST-next-model', effort: 'high' },
    { model: 'TEST-model', effort: 'high', permissions: 'manual' },
    { model: 'TEST-provider/TEST-model', effort: 'high', permissions: 'bypass' },
    { model: 'TEST-model', effort: 'high', fastMode: true },
    { model: 'TEST-model', effort: 'high', context: 'one-million' },
  ]) {
    assert.throws(() => applyLaunchConfiguration(capturedVariantBase, choice),
      (error: unknown) => error instanceof Error &&
        'reason' in error && error.reason === 'launch-option-unsupported',
      `Unattested combined V2 launch option was accepted: ${JSON.stringify(choice)}`);
  }
  const v1 = runtimeProfileSchema.parse({ members: [v1Profile()] }).members[0]!;
  const legacyChoice = applyLaunchConfiguration(v1, {
    model: 'TEST-next-model', effort: 'high', permissions: 'manual',
  });
  assert.equal(legacyChoice.provider, 'opencode');
  if (legacyChoice.provider !== 'opencode') throw new Error('Expected OpenCode profile');
  assert.equal(legacyChoice.model, 'TEST-next-model');
  assert.equal(legacyChoice.nativeOptions.variant, 'high');
  assert.equal(legacyChoice.nativeOptions.toolApprovalMode, 'manual',
    'historical V1 launch choices remain unchanged');
});

test('V1 factory refuses a generation-selected V2 member before starting a server', () => {
  assert.throws(() => createOpenCodeMemberProvider(context()), /V2 cannot run through/);
});

test('V2 adapter rejects V1, unsupported versions and V1 plugin before owner access', () => {
  const { captured, calls } = owner(true);
  const fixture = v2Profile();
  for (const bad of [
    { ...fixture, nativeGeneration: undefined },
    { ...fixture, protocolRevision: '2.1.4' },
    { ...fixture, mcpPolicyPlugin: { path: '/TEST-only-plugin', sha256: 'a'.repeat(64) } },
    { ...fixture, mcpCatalogSource: { claudeConfigPath: '/TEST-only/v1-claude.json' } },
    { ...fixture, capturedMcpSource: {
      userConfigPath: '/TEST-only/v1-user.json', projectPath: '/TEST-only/v1-project',
      policy: { mode: 'inheritScopes' },
    } },
    { ...fixture, environment: { ...fixture.environment,
      OPENCODE_BIN_PATH: '/TEST-untrusted/native' } },
    { ...fixture, environment: { ...fixture.environment,
      opencode_bin_path: '/TEST-untrusted/alias-native' } },
  ]) {
    assert.throws(() => createOpenCodeV2MemberProvider(
      context(bad as typeof fixture), captured), /separate native profile/);
  }
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 });
});

test('V2 rejects foreign Host request and MCP endpoint capture before native owner access', () => {
  const { captured, calls } = owner(true);
  const base = v2Profile();
  const foreignRequest = [
    { ...request(), sessionId: 'TEST-other-session' },
    { ...request(), generation: 2 },
    { ...request(), configRevision: 'TEST-other-revision' },
  ];
  for (const input of foreignRequest) {
    assert.throws(() => createOpenCodeV2MemberProvider(context(base, input), captured),
      /separate native profile/, 'foreign Runtime request must not adopt native V2 capture');
  }
  for (const key of ['teamId', 'memberId'] as const) {
    const foreign = context(base);
    Object.assign(foreign.endpoint.binding, { [key]: 'TEST-foreign-' + key });
    assert.throws(() => createOpenCodeV2MemberProvider(foreign, captured),
      /separate native profile/, 'foreign MCP endpoint must not adopt native V2 capture');
  }
  assert.deepEqual(calls, {
    probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0,
  }, 'all foreign captures must fail before owner callbacks or native mutation');
});

test('V2 owner policy getter cannot replace validated Host request and profile', () => {
  const ctx = context(nativeV2Profile());
  const { captured, calls } = owner(true);
  // The original code read the owner's property after validation but before
  // cloning the profile or recording Host request identity.
  Object.defineProperty(captured, 'requiredExternalDirectory', {
    get() {
      Object.assign(ctx.request, { generation: 2 });
      Object.assign(ctx.profile, { protocolRevision: '2.1.4' });
      return 'deny';
    },
  });
  assert.throws(() => createOpenCodeV2MemberProvider(ctx, captured),
    /immutable Host capture/,
    'native owner callback must not relabel a validated V2 allocation');
  assert.deepEqual(calls, {
    probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0,
  }, 'owner-driven profile drift must fail before native I/O');
});

test('ready V2 Host revokes on selected profile or initial instructions drift', async () => {
  for (const mutate of [
    (ctx: MemberProviderContext) => { Object.assign(ctx.profile, { protocolRevision: '2.1.4' }); },
    (ctx: MemberProviderContext) => { ctx.instructions += ' TEST-injected-new-context'; },
  ]) {
    const ctx = context(nativeV2Profile());
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(ctx, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    mutate(ctx);
    assert.equal(provider.isReady(), false, 'modified Host selection cannot retain native authority');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(await provider.cleanup(), true);
    assert.equal((await opened.driver.close()).cleanup, 'confirmed');
    assert.equal(calls.stop, 1, 'only the original TEST-owned process can be stopped');
    assert.equal(calls.password, 0, 'revoked capture never reads native credentials');
  }
});

test('inherited OPENCODE_BIN_PATH refuses V2 admission before owner access', () => {
  const previous = process.env.OPENCODE_BIN_PATH;
  try {
    process.env.OPENCODE_BIN_PATH = '/TEST-parent/foreign-engine';
    const { captured, calls } = owner(true);
    assert.throws(() => createOpenCodeV2MemberProvider(context(), captured),
      /separate native profile/);
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN_PATH;
    else process.env.OPENCODE_BIN_PATH = previous;
  }
});

test('lowercase inherited V2 executable override refuses admission before owner access', () => {
  const previous = process.env.opencode_bin_path;
  try {
    process.env.opencode_bin_path = '/TEST-parent/lowercase-foreign-engine';
    const { captured, calls } = owner(true);
    assert.throws(() => createOpenCodeV2MemberProvider(context(), captured),
      /separate native profile/);
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 });
  } finally {
    if (previous === undefined) delete process.env.opencode_bin_path;
    else process.env.opencode_bin_path = previous;
  }
});

test('inherited OPENCODE_BIN_PATH appearing after readiness permanently revokes V2 owner', async () => {
  const previous = process.env.OPENCODE_BIN_PATH;
  delete process.env.OPENCODE_BIN_PATH;
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  let opened: Awaited<ReturnType<typeof provider.factory.open>> | undefined;
  try {
    opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    process.env.OPENCODE_BIN_PATH = '/TEST-parent/late-foreign-engine';
    assert.equal((await opened.driver.checkReadiness()).ok, false);
    assert.equal(provider.isReady(), false);
    delete process.env.OPENCODE_BIN_PATH;
    assert.equal((await opened.driver.checkReadiness()).ok, false,
      'clearing an inherited override cannot revive the old native lease');
    assert.equal(calls.context, 1, 'never replay native instructions');
    assert.equal(calls.stop, 1, 'only the captured TEST owner is stopped once');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN_PATH;
    else process.env.OPENCODE_BIN_PATH = previous;
    if (opened) await opened.driver.close();
    await provider.cleanup();
  }
  assert.equal(calls.stopped, 1, 'physical stop confirmation must be observed');
});

test('lowercase inherited override appearing after readiness permanently retires V2 custody', async () => {
  const previous = process.env.opencode_bin_path;
  delete process.env.opencode_bin_path;
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  let opened: Awaited<ReturnType<typeof provider.factory.open>> | undefined;
  try {
    opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    process.env.opencode_bin_path = '/TEST-parent/lowercase-late-override';
    assert.equal((await opened.driver.checkReadiness()).ok, false);
    delete process.env.opencode_bin_path;
    assert.equal(provider.isReady(), false, 'clearing a foreign override never renews authority');
    assert.equal(calls.context, 1, 'no replay of initial native context');
    assert.equal(calls.stop, 1, 'only the TEST-owned process is stopped once');
  } finally {
    if (previous === undefined) delete process.env.opencode_bin_path;
    else process.env.opencode_bin_path = previous;
    if (opened) await opened.driver.close();
    await provider.cleanup();
  }
  assert.equal(calls.stopped, 1);
});

test('native V2 credentials cannot authorize a request after synchronous owner environment drift',
  { timeout: 10000 }, async () => {
    const previous = process.env.OPENCODE_BIN_PATH;
    const profile = v2Profile();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(500);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    profile.endpoint = 'http://127.0.0.1:' + address.port;
    const { captured, calls } = owner(true);
    captured.readPassword = () => {
      calls.password++;
      // Simulate a hostile inherited launcher override appearing DURING
      // credential projection, after the transport already began admission.
      process.env.OPENCODE_BIN_PATH = '/TEST-only/untrusted-native-override';
      return 'TEST-only-password';
    };
    let opened: Awaited<ReturnType<ReturnType<typeof createOpenCodeV2MemberProvider>['factory']['open']>> | undefined;
    try {
      const provider = createOpenCodeV2MemberProvider(context(profile), captured);
      opened = await provider.factory.open(request());
      assert.equal(provider.isReady(), true);
      const response = await opened.driver.submit({
        inputId: 'TEST-late-env', operationRef: 'TEST-late-env-op',
        content: 'must not reach an external native HTTP peer',
      });
      assert.equal(response.ok, false, 'a late executable override must refuse submission');
      assert.equal(requests, 0, 'a credential callback may not authorize even the first native GET');
      assert.equal(calls.password, 1, 'do not retry credentials after the failed projection');
      assert.equal(calls.stop, 1, 'only the original captured TEST-owned engine is stopped');
      assert.equal(provider.isReady(), false);
      assert.equal(await provider.cleanup(), true);
    } finally {
      await opened?.driver.close();
      if (previous === undefined) delete process.env.OPENCODE_BIN_PATH;
      else process.env.OPENCODE_BIN_PATH = previous;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    }
  });

test('V2 private SPI refuses mismatched request before native probe and credentials', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open({
    ...request(), configRevision: 'forged',
  }), /opencode.driver.invalid-config/);
  assert.equal(provider.isReady(), false);
  assert.equal(calls.probe, 0);
  assert.equal(calls.password, 0);
  assert.equal(calls.stop, 1, 'failed open retires owned process immediately');
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 native probe failure HOLDs without submission and physically stops its owner', async () => {
  const { captured, calls } = owner(false);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(calls.probe, 1);
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(calls, { probe: 1, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 rejects truthy non-boolean native probe receipts without credentials or mutation',
  async () => {
    for (const malformed of [{ ready: false }, 1]) {
      const { captured, calls } = owner(true);
      captured.probe = async () => { calls.probe++; return malformed as unknown as boolean; };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      await assert.rejects(() => provider.factory.open(request()),
        /opencode.driver.dependency-unavailable/,
        'native probe may qualify only with the primitive boolean true');
      assert.equal(provider.isReady(), false);
      assert.equal(calls.probe, 1);
      assert.equal(calls.permissions, 0, 'do not read native permissions after malformed probe');
      assert.equal(calls.context, 0, 'do not install initial native instructions');
      assert.equal(calls.password, 0, 'do not disclose credentials');
      assert.equal(await provider.cleanup(), true);
      assert.equal(calls.stop, 1, 'stop only the selected TEST-owned engine once');
    }
  });

test('V2 TEST-owned probe uses existing Session SPI; stop is idempotent and revokes readiness', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(opened.driver.sessionRef.length > 0, true);
  assert.equal(provider.isReady(), true);
  assert.equal(calls.probe, 1);
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1);
  // A successful first installation is never submitted again by later
  // readiness checks: duplicated native mutations are unsafe after lost ACK.
  await opened.driver.checkReadiness();
  await opened.driver.checkReadiness();
  assert.equal(calls.context, 1, 're-probe must not replay native instruction installation');
  assert.deepEqual(provider.initialContextEvidence?.(), {
    kind: 'native-configuration',
    contextDigest: (await import('node:crypto')).createHash('sha256')
      .update('TEST-only role, team and workspace instructions').digest('hex'),
    generation: 'test-generation', configRevision: 'test-revision',
  });
  assert.equal(calls.password, 0, 'no credentials are read by a simulated readiness probe');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'same TEST owner stopped once');
  assert.equal(calls.stopped, 1);
});

test('V2 rejects mutually matching malformed custody digests before native owner access', () => {
  for (const sha256 of ['invalid', 'A'.repeat(64), 'g'.repeat(64)]) {
    const profile = nativeV2Profile();
    const { captured, calls } = owner(true);
    captured.readNativeCustody = async () => ({
      ...testNativeCustody(), executableSha256: sha256,
    });
    assert.throws(() => createOpenCodeV2MemberProvider(context({
      ...profile, executable: { ...profile.executable, sha256 },
    }), captured), /separate native profile and owner/);
    assert.deepEqual(calls,
      { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 },
      'invalid matched digest must fail before any native owner access');
  }
});

test('V2 rejects array-coerced SHA256 before touching owner policy', () => {
  const base = nativeV2Profile();
  const { captured, calls } = owner(true);
  let policyReads = 0;
  Object.defineProperty(captured, 'requiredExternalDirectory', {
    get() { policyReads++; return 'deny'; },
  });
  const forgedDigest = ['a'.repeat(64)] as unknown as string;
  assert.throws(() => createOpenCodeV2MemberProvider(context({
    ...base, executable: { ...base.executable, sha256: forgedDigest },
  }), captured), /separate native profile and owner/);
  assert.equal(policyReads, 0);
  assert.deepEqual(calls,
    { probe: 0, permissions: 0, context: 0, password: 0, stop: 0, stopped: 0 });
});

test('actual native custody must match captured executable, digest, protocol and physical PID', async () => {
  const original = testNativeCustody();
  for (const bad of [
    { ...original, executablePath: '/TEST-only-opencode-v2/npm-wrapper' },
    { ...original, executableSha256: 'b'.repeat(64) },
    { ...original, version: '2.1.4' },
    { ...original, pid: 0 },
    { ...original, pid: Number.NaN },
    { ...original, startIdentity: '' },
  ]) {
    const { captured, calls } = owner(true);
    captured.readNativeCustody = async () => bad;
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.probe, 1);
    assert.equal(calls.permissions, 0, 'no permission read before actual native custody');
    assert.equal(calls.context, 0, 'no native instruction mutation with a wrong process');
    assert.equal(calls.password, 0);
    assert.equal(calls.stop, 1, 'only the TEST owner retires its own capture');
    assert.equal(await provider.cleanup(), true);
  }
});

test('a reused mutable custody readback cannot hide a native PID or binary swap', async () => {
  // TEST owner accidentally returns the SAME object from both reads. A later
  // mutation must not make the original identity comparison follow the swap.
  for (const mutation of ['pid', 'binary'] as const) {
    const { captured, calls } = owner(true);
    const sharedReadback = { ...testNativeCustody() };
    captured.readNativeCustody = async () => sharedReadback;
    captured.readNativeEffectivePermissions = async () => {
      calls.permissions++;
      if (calls.permissions === 2) {
        if (mutation === 'pid') {
          sharedReadback.pid++;
          sharedReadback.startIdentity = 'TEST-start-swapped';
        } else {
          sharedReadback.executableSha256 = 'b'.repeat(64);
        }
      }
      return testNativePermissionReadback([
        { action: 'external_directory', resource: '*', effect: 'deny' },
      ]);
    };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    await assert.rejects(() => provider.factory.open(request()),
      /opencode.driver.dependency-unavailable/,
      'a mutated owner readback must not admit an unpinned native engine');
    assert.equal(calls.permissions, 2, 'mutation occurs after initial admission readback');
    assert.equal(calls.context, 1, 'native context is never installed twice');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'only this TEST owner is retired');
    assert.equal(await provider.cleanup(), true);
  }
});

test('post-instruction custody getter cannot hide transient Host lease revocation', async () => {
  const ctx = context();
  const { captured, calls } = owner(true);
  const nativeCustody = testNativeCustody();
  let reads = 0;
  let finalPathReads = 0;
  let progressCalls = 0;
  // The previous implementation checked current() BEFORE reading final
  // custody getters, then invoked onProgress() BEFORE its next authority
  // check. Progress could mask the revoked Host profile.
  captured.readNativeCustody = async () => {
    reads++;
    if (reads === 1) return nativeCustody;
    return {
      ...nativeCustody,
      get executablePath() {
        finalPathReads++;
        Object.assign(ctx.profile, { protocolRevision: '2.1.4' });
        return nativeCustody.executablePath;
      },
    };
  };
  ctx.onProgress = () => {
    progressCalls++;
    Object.assign(ctx.profile, { protocolRevision: '2.0.21' });
  };
  const provider = createOpenCodeV2MemberProvider(ctx, captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/,
    'final receipt projection must recheck authority before progress');
  assert.equal(reads, 2, 'initial and final native custody both observed');
  assert.equal(finalPathReads, 0, 'Host never executes an untrusted custody getter');
  assert.equal(progressCalls, 0, 'progress cannot restore authority before its recheck');
  assert.equal(calls.context, 1, 'native context mutation never replayed');
  assert.equal(calls.permissions, 2, 'both native policy readbacks preceded final custody');
  assert.equal(calls.password, 0, 'no credentials after revoked capture');
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'only this TEST-owned native process stopped once');
});

test('V2 rejects getter-backed native executable digests before the first mutation', async () => {
  const { captured, calls } = owner(true);
  let custodyReads = 0;
  let digestReads = 0;
  captured.readNativeCustody = async () => {
    custodyReads++;
    if (custodyReads > 1) return { ...testNativeCustody(), executableSha256: 'b'.repeat(64) };
    return {
      ...testNativeCustody(),
      get executableSha256() {
        digestReads++;
        return digestReads <= 2 ? 'a'.repeat(64) : 'b'.repeat(64);
      },
    };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/,
    'post-validation getter changes cannot redefine the admitted binary');
  assert.equal(digestReads, 0, 'Host must not execute a mutable digest getter');
  assert.equal(custodyReads, 1, 'untrusted initial readback stops native qualification');
  assert.equal(calls.context, 0, 'invalid first custody cannot install native context');
  assert.equal(provider.isReady(), false);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1);
});

test('V2 permission readbacks must bind to the captured session and process before and after context PUT', async () => {
  for (const phase of ['initial', 'final'] as const) {
    for (const mismatch of ['session', 'pid', 'start'] as const) {
      const { captured, calls } = owner(true);
      const original = captured.readNativeEffectivePermissions;
      let reads = 0;
      captured.readNativeEffectivePermissions = async (signal) => {
        const proof = await original(signal);
        assert.ok(proof);
        reads++;
        if ((phase === 'final' && reads !== 2) ||
            (phase === 'initial' && reads !== 1)) return proof;
        return {
          ...proof,
          ...(mismatch === 'session' ? { nativeSessionId: 'ses_FOREIGN' } : {}),
          ...(mismatch === 'pid' ? { pid: proof.pid + 1 } : {}),
          ...(mismatch === 'start' ? { startIdentity: 'TEST-foreign-start' } : {}),
        };
      };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      await assert.rejects(() => provider.factory.open(request()),
        /opencode.driver.dependency-unavailable/,
        `Native permission ${phase} ${mismatch} identity must fail closed`);
      assert.equal(reads, phase === 'final' ? 2 : 1);
      assert.equal(calls.context, phase === 'final' ? 1 : 0,
        'a foreign initial readback must not install native instructions');
      assert.equal(provider.isReady(), false);
      assert.equal(provider.initialContextEvidence?.(), undefined);
      assert.equal(calls.password, 0, 'a foreign permission scope cannot read credentials');
      assert.equal(calls.stop, 1, 'only the selected TEST-owned process is stopped');
      assert.equal(await provider.cleanup(), true);
    }
  }
});

test('V2 Host revokes a ready capture when the actual PID/start identity changes', async () => {
  const { captured, calls } = owner(true);
  let custody = testNativeCustody();
  let reads = 0;
  captured.readNativeCustody = async () => { reads++; return custody; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.equal(reads, 2);
  custody = { ...custody, pid: custody.pid + 1 };
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  custody = testNativeCustody();
  assert.equal((await opened.driver.checkReadiness()).ok, false,
    'restoring the old PID cannot renew a revoked capture');
  assert.equal(reads, 3, 'a revoked process has no further native authority');
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1, 'no replay of previously acknowledged instructions');
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('native permission drift revokes an already ready V2 SPI member, with no replay', async () => {
  const { captured, calls } = owner(true);
  let effective: 'deny' | 'allow' = 'deny';
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return testNativePermissionReadback([
        { action: 'external_directory', resource: '*', effect: effective },
      ]);
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.notEqual(provider.initialContextEvidence?.(), undefined);

  effective = 'allow';
  const recheck = await opened.driver.checkReadiness();
  assert.equal(recheck.ok, false, 'the real native permission readback no longer satisfies deny');
  assert.equal(provider.isReady(), false, 'cached readiness must not survive failed recheck');
  assert.equal(provider.initialContextEvidence?.(), undefined,
    'old native instruction evidence must not survive permission drift');

  effective = 'deny';
  const next = await opened.driver.checkReadiness();
  assert.equal(next.ok, false, 'once revoked, restoring policy cannot revive the same capture');
  assert.equal(calls.permissions, 3, 'revoked owner must not perform more native reads');
  assert.equal(calls.context, 1, 'no mutation replay during re-attestation');
  assert.equal(calls.stop, 1, 'permission drift must stop the original TEST owner immediately');
  assert.equal(calls.stopped, 1, 'physical cleanup confirmed before exposing HOLD');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'stop only the original TEST owner once');
});

test('V2 Host snapshots request and endpoint identity across native admission callbacks', async () => {
  for (const mutation of ['request-revision', 'endpoint-generation'] as const) {
    const nativeContext = context();
    const { captured, calls } = owner(true);
    if (mutation === 'request-revision') {
      captured.probe = async () => {
        calls.probe++;
        Object.assign(nativeContext.request, { configRevision: 'TEST-foreign-revision' });
        return true;
      };
    } else {
      captured.installAndAttestInitialContext = async (capture) => {
        calls.context++;
        Object.assign(nativeContext.endpoint.binding, { generation: 'TEST-foreign-generation' });
        // An untrusted owner can echo the mutated live binding. It is not
        // evidence for the generation captured before native installation.
        return { ...capture, generation: 'TEST-foreign-generation' };
      };
    }
    const provider = createOpenCodeV2MemberProvider(nativeContext, captured);
    await assert.rejects(() => provider.factory.open(request()),
      /opencode.driver.dependency-unavailable/,
      'a mutated Host request or binding must not admit a native V2 session');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.context, mutation === 'endpoint-generation' ? 1 : 0,
      'changed request identity must fail before the native context mutation');
    assert.equal(await provider.cleanup(), true);
    assert.equal(calls.stop, 1, 'only the original TEST owner is stopped once');
    assert.equal(calls.stopped, 1, 'original TEST process is physically stopped');
  }
});


test('V2 Host detects endpoint binding mutation even when native ACK echoes original capture', async () => {
  const host = context();
  const { captured, calls } = owner(true);
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    Object.assign(host.endpoint.binding, { generation: 'TEST-foreign-generation' });
    // A valid-looking original ACK cannot authorize a mutated Host endpoint.
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(host, captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/);
  assert.equal(calls.context, 1);
  assert.equal(calls.password, 0);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1);
  assert.equal(calls.stopped, 1);
});

test('native probe loss after initial Host readiness revokes the capture permanently', async () => {
  const { captured, calls } = owner(true);
  let available = true;
  captured.probe = async () => { calls.probe++; return available; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  available = false;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  available = true;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  assert.equal(calls.probe, 2, 'failed native identity must not be reacquired');
  assert.equal(calls.context, 1);
  assert.equal(calls.stop, 1, 'lost native identity must stop the owned engine');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('lost Host allocation authority during recheck cannot resurrect cached V2 readiness', async () => {
  const { captured, calls } = owner(true);
  const input = context();
  let canAllocate = true;
  input.canAllocate = () => canAllocate;
  const provider = createOpenCodeV2MemberProvider(input, captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  canAllocate = false;
  assert.equal((await opened.driver.checkReadiness()).ok, false);
  canAllocate = true;
  assert.equal(provider.isReady(), false, 'stale attestation cannot revive when Host lease returns');
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.stop, 1, 'lost allocation stops the original TEST-owned process');
  assert.equal(calls.context, 1, 'initial native instructions are never replayed');
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('throwing Host authority guard permanently revokes a ready V2 native owner', async () => {
  for (const failedGuard of ['binding', 'allocation'] as const) {
    const input = context();
    let unavailable = false;
    input.isCurrent = () => {
      if (failedGuard === 'binding' && unavailable) throw new Error('TEST binding unavailable');
      return true;
    };
    input.canAllocate = () => {
      if (failedGuard === 'allocation' && unavailable) throw new Error('TEST lease unavailable');
      return true;
    };
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(input, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    unavailable = true;
    assert.equal(provider.isReady(), false,
      'an exception from either Host authority callback is not affirmative custody');
    unavailable = false;
    assert.equal(provider.isReady(), false, 'recovering the callback cannot renew the captured PID');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.deepEqual(await opened.driver.submit({
      inputId: 'TEST-guard-error', operationRef: 'TEST-guard-error-op',
      content: 'must not reach the native engine',
    }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
    assert.equal(await provider.cleanup(), true);
    assert.equal(calls.stop, 1, 'only the TEST-owned process is stopped once');
    assert.equal(calls.permissions, 2, 'no native policy readback after Host authority fails');
    assert.equal(calls.context, 1, 'never replay initial instructions');
    assert.equal(calls.password, 0, 'revoked credentials are never read');
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  }
});

test('transient authority loss observed without native recheck cannot revive V2 readiness', async () => {
  for (const lost of ['allocation', 'binding'] as const) {
    const { captured, calls } = owner(true);
    const input = context();
    let allocated = true;
    let bound = true;
    input.canAllocate = () => allocated;
    input.isCurrent = () => bound;
    const provider = createOpenCodeV2MemberProvider(input, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    assert.notEqual(provider.initialContextEvidence?.(), undefined);

    if (lost === 'allocation') allocated = false;
    else bound = false;
    assert.equal(provider.isReady(), false, 'one observed lapse revokes the capture');
    allocated = true;
    bound = true;
    assert.equal(provider.isReady(), false, 'restored Host authority cannot renew a V2 capture');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal((await opened.driver.checkReadiness()).ok, false);
    assert.equal(await provider.cleanup(), true);
    assert.equal(calls.stop, 1, 'only the original TEST-owned process is stopped once');
    assert.equal(calls.stopped, 1, 'physical stop must be confirmed');
    assert.equal(calls.context, 1, 'no second native instructions installation');
    assert.equal(calls.permissions, 2, 'revoked owner must not read native policy again');
  }
});


test('policy relaxed during native instructions cannot pass final Host admission', async () => {
  const { captured, calls } = owner(true);
  let effect: 'deny' | 'allow' = 'deny';
  captured.readNativeEffectivePermissions = async () => {
    calls.permissions++;
    return testNativePermissionReadback([
      { action: 'external_directory', resource: '*', effect },
    ]);
  };
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    effect = 'allow';
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.permissions, 2, 'post-PUT native policy readback is mandatory');
  assert.equal(calls.context, 1, 'never replay instruction mutation');
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
});

test('PID changed during native instructions cannot inherit initial-context authority', async () => {
  const { captured, calls } = owner(true);
  let custody = testNativeCustody();
  let reads = 0;
  captured.readNativeCustody = async () => { reads++; return custody; };
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    custody = { ...custody, pid: custody.pid + 1 };
    return { nativeSessionId: capture.nativeSessionId, contextDigest: capture.contextDigest,
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(reads, 2, 'actual native PID must be remeasured after PUT');
  assert.equal(calls.permissions, 2);
  assert.equal(calls.context, 1);
  assert.equal(calls.stop, 1);
  assert.equal(await provider.cleanup(), true);
});

test('V2 native-effective allow cannot satisfy captured deny, even after a successful native probe', async () => {
  const { captured, calls } = owner(true, 'allow');
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('V2 revoked Host lease cannot read a checkpoint after async configuration selection', async () => {
  const restored = { ...request(), checkpointRef: 'TEST-stale-checkpoint' };
  const input = context(v2Profile(), restored);
  const { captured, calls } = owner(true);
  let authorized = true;
  let revocationQueued = false;
  let storageReads = 0;
  input.isCurrent = () => authorized;
  input.canAllocate = () => {
    if (authorized && !revocationQueued) {
      revocationQueued = true;
      // Config resolution is async: native D reads the checkpoint only after
      // this microtask. The previous Host bridge called storage without a
      // fresh lease check, even though native admission later failed.
      queueMicrotask(() => { authorized = false; });
    }
    return authorized;
  };
  input.readCheckpoint = async () => {
    storageReads++;
    return { version: 1, engine: 'opencode-v2' };
  };
  const provider = createOpenCodeV2MemberProvider(input, captured);
  await assert.rejects(() => provider.factory.open(restored),
    /opencode.driver.checkpoint-missing/);
  assert.equal(revocationQueued, true, 'race must occur after config selection');
  assert.equal(storageReads, 0, 'revoked Host lease must not read even invalid checkpoint bytes');
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
});

test('V2 cold restore retains the original Host checkpoint reader across native policy mutation', async () => {
  const firstOwner = owner(true);
  const first = createOpenCodeV2MemberProvider(context(), firstOwner.captured);
  const firstSession = await first.factory.open(request());
  const checkpoint = firstSession.driver.checkpoint();
  assert.equal(checkpoint.ok, true);
  if (!checkpoint.ok) throw new Error('TEST original checkpoint was not captured');
  assert.deepEqual(await firstSession.driver.close(),
    { logicallyClosed: true, cleanup: 'confirmed' });

  const next = { ...request(), generation: 2, checkpointRef: 'TEST-owned-resume' };
  const nextContext = context({ ...v2Profile(), generation: 2 }, next);
  Object.assign(nextContext.endpoint.binding, { generation: 'test-generation-2', runId: 'test-restart' });
  let originalReads = 0;
  let forgedReads = 0;
  nextContext.readCheckpoint = async () => { originalReads++; return checkpoint.value; };
  const secondOwner = owner(true);
  Object.defineProperty(secondOwner.captured, 'requiredExternalDirectory', {
    get() {
      // This getter runs after Host capture but before the D driver requests
      // storage. The native owner must not redirect the selected Host store.
      nextContext.readCheckpoint = async () => { forgedReads++; return undefined; };
      return 'deny';
    },
  });
  const second = createOpenCodeV2MemberProvider(nextContext, secondOwner.captured);
  const resumed = await second.factory.open(next);
  assert.equal(originalReads, 1, 'only the original Host storage reader ran');
  assert.equal(forgedReads, 0, 'no forged storage callback can replace it');
  assert.equal(secondOwner.calls.probe, 1, 'legitimate cold resume reaches native probe');
  assert.equal(secondOwner.calls.password, 0, 'cold restore never submits a model turn');
  assert.deepEqual(await resumed.driver.close(),
    { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(secondOwner.calls.stop, 1, 'only captured TEST-owned process retired');
});

test('V2 native probe cannot replace the captured Host progress revocation callback', async () => {
  const input = context();
  let authorized = true;
  let originalProgress = 0;
  let forgedProgress = 0;
  input.isCurrent = () => authorized;
  input.onProgress = () => { originalProgress++; authorized = false; };
  const { captured, calls } = owner(true);
  captured.probe = async () => {
    calls.probe++;
    input.onProgress = () => { forgedProgress++; };
    return true;
  };
  const provider = createOpenCodeV2MemberProvider(input, captured);
  await assert.rejects(() => provider.factory.open(request()),
    /opencode.driver.dependency-unavailable/,
    'original progress-induced lease revocation must prevent a ready V2 engine');
  assert.equal(originalProgress, 1, 'original captured callback must revoke lease');
  assert.equal(forgedProgress, 0, 'replaced callback must not run');
  assert.equal(provider.isReady(), false);
  assert.equal(calls.context, 1, 'native initial context mutation is never retried');
  assert.equal(calls.password, 0, 'no credentials after lost Host authority');
  assert.equal(calls.stop, 1, 'stop only this captured TEST child');
  assert.equal(await provider.cleanup(), true);
});

test('V2 cold checkpoint compatibility survives a new generation but never a foreign member',
  async () => {
    const firstOwner = owner(true);
    const first = createOpenCodeV2MemberProvider(context(), firstOwner.captured);
    const opened = await first.factory.open(request());
    const checkpoint = opened.driver.checkpoint();
    if (!checkpoint.ok) throw new Error('original TEST V2 checkpoint was not captured');
    const original = checkpoint.value;
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(firstOwner.calls.stop, 1, 'original native owner is physically retired');

    // A Stage1 restore retains member/session identity but allocates a new
    // generation, possibly with a different Team runId.
    const next = { ...request(), generation: 2, checkpointRef: 'TEST-native-v2-checkpoint' };
    const nextProfile = { ...v2Profile(), generation: 2 };
    const nextContext = context(nextProfile, next);
    Object.assign(nextContext.endpoint.binding, {
      generation: 'test-generation-2', runId: 'test-new-run',
    });
    let checkpointReads = 0;
    nextContext.readCheckpoint = async () => { checkpointReads++; return original; };
    const nextOwner = owner(true);
    const second = createOpenCodeV2MemberProvider(nextContext, nextOwner.captured);
    const resumed = await second.factory.open(next);
    assert.equal(second.isReady(), true, 'selected V2 checkpoint opens on a new Host generation');
    assert.equal(checkpointReads, 1, 'read existing checkpoint only once');
    assert.equal(nextOwner.calls.context, 1, 'new native context installed exactly once');
    assert.equal(nextOwner.calls.password, 0, 'checkpoint never submits a model input');
    assert.deepEqual(await resumed.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(nextOwner.calls.stop, 1, 'only the new TEST owner is stopped');

    const foreignContext = context({ ...nextProfile, memberId: 'test-foreign-member' }, next);
    Object.assign(foreignContext.endpoint.binding, {
      memberId: 'test-foreign-member',
      generation: 'test-generation-2', runId: 'test-new-run',
    });
    foreignContext.readCheckpoint = async () => original;
    const foreignOwner = owner(true);
    const foreign = createOpenCodeV2MemberProvider(foreignContext, foreignOwner.captured);
    await assert.rejects(() => foreign.factory.open(next),
      /opencode.driver.checkpoint-incompatible/,
      'native V2 checkpoint must not be adopted by another member');
    assert.equal(foreignOwner.calls.probe, 0, 'reject foreign checkpoint before native probe');
    assert.equal(foreignOwner.calls.password, 0, 'no credentials for foreign checkpoint');
    assert.equal(await foreign.cleanup(), true);
    assert.equal(foreignOwner.calls.stop, 1);
  });

test('V2 cold checkpoint rejects foreign tenant, project, account, workspace, backend and endpoint', async () => {
  const originalOwner = owner(true);
  const originalProvider = createOpenCodeV2MemberProvider(context(), originalOwner.captured);
  const initial = await originalProvider.factory.open(request());
  const saved = initial.driver.checkpoint();
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error('missing original TEST checkpoint');
  assert.deepEqual(await initial.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });

  const baseRequest = { ...request(), generation: 2, checkpointRef: 'TEST-cold-foreign-checkpoint' };
  const baseProfile = { ...v2Profile(), generation: 2 };
  const cases: ReadonlyArray<{
    name: string;
    requestPatch?: Partial<OpenConfig>;
    profilePatch?: Partial<ReturnType<typeof v2Profile>>;
    backendId?: string;
  }> = [
    { name: 'tenant', requestPatch: { tenantId: 'test-other-tenant' } },
    { name: 'project', requestPatch: { projectId: 'test-other-project' } },
    { name: 'account', profilePatch: { accountBinding: 'TEST-other-account' } },
    { name: 'workspace', profilePatch: { cwd: v2Profile().cwd + '-other' } },
    { name: 'backend', backendId: 'test-other-backend' },
    { name: 'native endpoint', profilePatch: { endpoint: 'http://127.0.0.1:14322' } },
  ];
  for (const candidate of cases) {
    const nextRequest = { ...baseRequest, ...candidate.requestPatch };
    const nextContext = context({ ...baseProfile, ...candidate.profilePatch }, nextRequest);
    if (candidate.backendId) Object.assign(nextContext.endpoint.binding, { backendId: candidate.backendId });
    let reads = 0;
    nextContext.readCheckpoint = async () => { reads++; return saved.value; };
    const owned = owner(true);
    const provider = createOpenCodeV2MemberProvider(nextContext, owned.captured);
    await assert.rejects(() => provider.factory.open(nextRequest),
      /opencode.driver.checkpoint-incompatible/,
      `foreign ${candidate.name} must not adopt a saved native V2 session`);
    assert.equal(reads, 1, `foreign ${candidate.name} reads only the selected checkpoint`);
    assert.equal(owned.calls.probe, 0, `foreign ${candidate.name} is rejected before native process probe`);
    assert.equal(owned.calls.permissions, 0, 'no native permissions requested for a foreign checkpoint');
    assert.equal(owned.calls.password, 0, 'no credentials accessed for a foreign checkpoint');
    assert.equal(owned.calls.stop, 1, 'only the captured TEST owner is retired');
    assert.equal(await provider.cleanup(), true);
  }
});

test('V1 checkpoint identity is rejected before V2 native probe or permission readback', async () => {
  const { captured, calls } = owner(true);
  const restoredRequest = { ...request(), checkpointRef: 'cp1-TEST-v1' };
  const input = context(v2Profile(), restoredRequest);
  input.readCheckpoint = async () => ({
    version: 1, engine: 'opencode-v1', nativeSessionId: 'ses_TESTowned', compatibility: 'a'.repeat(64),
  });
  const provider = createOpenCodeV2MemberProvider(input, captured);
  await assert.rejects(() => provider.factory.open(restoredRequest), /opencode.driver.checkpoint-incompatible/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 0, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'failed restore must not repeatedly signal an owner');
});

test('native V2 submit preflight failure revokes Host readiness without replay or second owner stop', async () => {
  const { captured, calls } = owner(true);
  // Deterministic credential failure before any fetch. This exercises the
  // real private V2 Session SPI queue, not a fabricated submit response.
  captured.readPassword = () => { calls.password++; return ''; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.notEqual(provider.initialContextEvidence?.(), undefined);

  const first = await opened.driver.submit({
    inputId: 'TEST-not-sent', operationRef: 'TEST-preflight-op', content: 'TEST only; do not run a model',
  });
  assert.deepEqual(first, { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
  assert.equal(provider.isReady(), false, 'a sealed private V2 driver cannot leave Host ready');
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.password, 1, 'no credential or native mutation retry');
  assert.equal(calls.stop, 1, 'retire only the original captured native owner');
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-no-retry', operationRef: 'TEST-next-op', content: 'must not be submitted',
  }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
  assert.equal(calls.password, 1);
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(calls.stop, 1, 'no duplicate stop after uncertain native ACK');
});

test('pinned PR2 V2 driver refuses sync-only native log before prompt (HOLD)',
  { timeout: 10000 }, async () => {
    // PR2 decodes the real pinned V2.0.21 {data: session} envelope, but
    // log.synced without session.created and durable events is insufficient
    // for a qualified input. Prove rejection BEFORE any native POST. This is
    // a synthetic TEST peer, not evidence of a native model/tool turn.
    const profile = v2Profile();
    const sessionPath = '/api/session/' + profile.nativeSessionId;
    const logPath = '/api/experimental/session/' + profile.nativeSessionId + '/log?follow=false';
    let getCount = 0;
    let logCount = 0;
    let promptCount = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === sessionPath) {
        getCount++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: {
          id: profile.nativeSessionId,
          location: { directory: profile.cwd },
          agent: 'TEST-agent',
          model: { providerID: 'TEST-provider', id: 'TEST-model' },
          time: { created: 1 },
        } }));
        return;
      }
      if (req.method === 'GET' && req.url === logPath) {
        logCount++;
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({
          type: 'log.synced', aggregateID: profile.nativeSessionId, seq: 0,
        }) + '\n\n');
        return;
      }
      if (req.method === 'POST') promptCount++;
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    profile.endpoint = 'http://127.0.0.1:' + address.port;
    const { captured, calls } = owner(true);
    let opened: Awaited<ReturnType<ReturnType<typeof createOpenCodeV2MemberProvider>['factory']['open']>> | undefined;
    try {
      const provider = createOpenCodeV2MemberProvider(context(profile), captured);
      opened = await provider.factory.open(request());
      assert.equal(provider.isReady(), true, 'synthetic owner preflight is not wire qualification');
      assert.deepEqual(await opened.driver.submit({
        inputId: 'TEST-envelope-native',
        operationRef: 'TEST-envelope-native-op',
        content: 'TEST only; no model execution',
      }), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
      assert.equal(getCount, 1, 'exactly one real-shaped session GET');
      assert.equal(logCount, 1, 'PR2 must decode the official session and inspect the empty durable log');
      assert.equal(promptCount, 0, 'sync-only log cannot qualify any native prompt');
      assert.equal(provider.isReady(), false);
      assert.equal(calls.stop, 1, 'only the captured TEST owner is retired');
      assert.deepEqual(await opened.driver.submit({
        inputId: 'TEST-envelope-no-retry',
        operationRef: 'TEST-envelope-no-retry-op',
        content: 'never send',
      }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
      assert.equal(getCount, 1);
      assert.equal(logCount, 1, 'sealed capture must not reread native log');
      assert.equal(promptCount, 0);
      assert.equal(await provider.cleanup(), true);
      assert.equal(calls.stop, 1);
    } finally {
      await opened?.driver.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });

test('unknown physical stop after a failed V2 submit cannot claim safe reuse', async () => {
  const { captured, calls } = owner(true);
  captured.readPassword = () => { calls.password++; return ''; };
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-uncertain', operationRef: 'TEST-uncertain-op', content: 'TEST no model',
  }), /opencode.v2.owner-cleanup-unknown/,
  'unknown physical custody must be a distinct failure from known-not-sent input');
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-retry', operationRef: 'TEST-retry-op', content: 'must not send',
  }), /opencode.v2.owner-cleanup-unknown/);
  assert.equal(calls.password, 1, 'refused preflight never replays credentials or native POST');
  assert.equal(calls.stop, 1, 'never resignal the same owned PID after uncertain ACK');
  assert.equal(await provider.cleanup(), false);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  assert.equal(calls.stop, 1);
});

test('unknown physical cleanup on failed V2 open does not become a retryable success', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(
    () => provider.factory.open({ ...request(), configRevision: 'forged' }),
    /opencode.v2.owner-cleanup-unknown/
  );
  assert.equal(await provider.cleanup(), false);
  assert.equal(calls.stop, 1);
  assert.equal(calls.probe, 0);
  await assert.rejects(() => provider.factory.open(request()), /opencode.v2.owner-cleanup-unknown/);
  assert.equal(calls.stop, 1, 'unknown owner must not be signalled twice');
});

test('mutable owner cannot downgrade an already captured deny to ask', async () => {
  const { captured, calls } = owner(true, 'ask');
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  // A subsequent owner revision is not allowed to change the captured product
  // security boundary for an already selected native generation.
  (captured as { requiredExternalDirectory: 'ask' | 'deny' }).requiredExternalDirectory = 'ask';
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 0, password: 0, stop: 1, stopped: 1 });
});

test('native instructions are not treated as installed when identity attestation is wrong', async () => {
  const { captured, calls } = owner(true);
  captured.installAndAttestInitialContext = async (capture) => {
    calls.context++;
    return { nativeSessionId: capture.nativeSessionId,
      contextDigest: '0'.repeat(64),
      generation: capture.generation, configRevision: capture.configRevision };
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open(request()), /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.deepEqual(calls, { probe: 1, permissions: 1, context: 1, password: 0, stop: 1, stopped: 1 });
});

test('lost native V2 initial-context ACK cannot replay a write or conceal UNKNOWN cleanup', async () => {
  // A remote mutation may have taken effect even when its acknowledgement was lost.
  // This is deterministic TEST fault injection, NOT evidence of a real model turn.
  for (const physicallyConfirmed of [true, false]) {
    const { captured, calls } = owner(true);
    const attemptedDigests: string[] = [];
    captured.installAndAttestInitialContext = async (capture) => {
      calls.context++;
      attemptedDigests.push(capture.contextDigest);
      throw new Error('TEST-native-instructions-applied-ACK-lost');
    };
    if (!physicallyConfirmed) {
      captured.stopOwned = async () => { calls.stop++; return false; };
      captured.confirmStopped = async () => { calls.stopped++; return false; };
    }
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opening = () => provider.factory.open(request());
    if (physicallyConfirmed) {
      await assert.rejects(opening, 'lost context ACK must fail Host admission');
    } else {
      await assert.rejects(opening, /opencode.v2.owner-cleanup-unknown/,
        'uncertain process custody must not be reported as a retryable admission failure');
    }
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(attemptedDigests.length, 1, 'one and only one possibly applied native PUT');
    assert.match(attemptedDigests[0]!, /^[0-9a-f]{64}$/);
    assert.equal(calls.stop, 1, 'stopOwned must be single-flight even on an unknown ACK');

    await assert.rejects(opening, 'failed admission cannot reopen the retired native capture');
    assert.equal(calls.context, 1, 'never replay the possibly applied native context write');
    assert.equal(calls.stop, 1, 'a lost stop ACK cannot authorize a second signal');
    assert.equal(await provider.cleanup(), physicallyConfirmed,
      'only confirmed physical termination can release native custody');
    assert.equal(calls.stop, 1);
  }
});

test('cleanup retries only read-only physical confirmation after uncertain stop ACK', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return calls.stopped > 1; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  await assert.rejects(() => provider.factory.open({ ...request(), configRevision: 'forged' }),
    /opencode.v2.owner-cleanup-unknown/);
  assert.equal(await provider.cleanup(), true, 'later physical readback may confirm exit');
  assert.equal(await provider.cleanup(), true);
  assert.equal(calls.stop, 1, 'never replay an uncertain stop');
  assert.equal(calls.stopped, 2);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
});

test('V2 refuses truthy non-boolean physical stop evidence after failed admission',
  async () => {
    for (const malformed of [{ stopped: false }, 1]) {
      const { captured, calls } = owner(true);
      captured.confirmStopped = async () => {
        calls.stopped++;
        return malformed as unknown as boolean;
      };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      await assert.rejects(() => provider.factory.open({ ...request(), configRevision: 'forged' }),
        /opencode.v2.owner-cleanup-unknown/,
        'malformed native status cannot confirm that the original PID has stopped');
      assert.equal(provider.isReady(), false);
      assert.equal(await provider.cleanup(), false, 'read-only recheck cannot launder false custody');
      assert.equal(calls.stop, 1, 'do not resend native stop after uncertain ACK');
      assert.equal(calls.stopped, 2, 'physical status may be checked again without a new stop');
      assert.equal(calls.context, 0);
      assert.equal(calls.password, 0);
    }
  });

test('sealing a ready V2 capture initiates its own physical stop before explicit cleanup', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  provider.seal();
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.stop, 1, 'seal itself must initiate the TEST-owned stop');

  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  assert.equal(calls.stop, 1, 'cleanup and close cannot replay a stop with an unknown ACK');
  assert.equal(calls.stopped, 1);
});

test('sealing aborts an in-flight V2 native probe before permission or context installation', async () => {
  const { captured, calls } = owner(true);
  const entered = Promise.withResolvers<void>();
  captured.probe = async (signal) => {
    calls.probe++;
    entered.resolve();
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      signal.addEventListener('abort', () => resolve(false), { once: true });
    });
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opening = provider.factory.open(request());
  await entered.promise;
  provider.seal();
  await assert.rejects(opening, /opencode.driver.dependency-unavailable/);
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.deepEqual(calls, { probe: 1, permissions: 0, context: 0, password: 0, stop: 1, stopped: 1 });
  assert.equal(await provider.cleanup(), true);
});

test('initial native V2 readiness cannot ACK after progress revokes Host authority',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    let hostCurrent = true;
    let progress = 0;
    const host = {
      ...context(),
      isCurrent: () => hostCurrent,
      // Progress is a Host callback, not a grant. A synchronous lease
      // revocation during the FIRST probe must not return a ready V2 driver.
      onProgress: () => { progress++; hostCurrent = false; },
    };
    const provider = createOpenCodeV2MemberProvider(host, captured);
    await assert.rejects(() => provider.factory.open(request()),
      /opencode.driver.dependency-unavailable/);
    assert.equal(progress, 1, 'native probe reached the progress callback');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.probe, 1);
    assert.equal(calls.context, 1, 'native instructions are never replayed');
    assert.equal(calls.password, 0, 'no native credentials after lease loss');
    assert.equal(calls.stop, 1, 'only the captured TEST-owned child is stopped');
    assert.equal(calls.stopped, 1);
    hostCurrent = true;
    assert.equal(provider.isReady(), false, 'renewed lease cannot revive retired capture');
    assert.equal(await provider.cleanup(), true);
    assert.equal(calls.stop, 1, 'cleanup must not signal the process twice');
  });

test('late native readiness ACK cannot restore revoked Host authority or hide UNKNOWN cleanup',
  { timeout: 3000 }, async () => {
    for (const stopConfirmed of [true, false]) {
      const { captured, calls } = owner(true);
      let hostCurrent = true;
      let progress = 0;
      const host = {
        ...context(),
        isCurrent: () => hostCurrent,
        // The final native probe has already completed, but the Host lease
        // can expire before the private Session SPI returns its ACK.
        onProgress: () => { if (++progress === 2) hostCurrent = false; },
      };
      captured.confirmStopped = async () => { calls.stopped++; return stopConfirmed; };
      const provider = createOpenCodeV2MemberProvider(host, captured);
      const opened = await provider.factory.open(request());
      assert.equal(progress, 1);
      assert.equal(provider.isReady(), true);
      const pending = opened.driver.checkReadiness();
      if (stopConfirmed) {
        assert.deepEqual(await pending, { ok: false, code: 'unavailable' },
          'the completed native probe cannot renew a revoked Host lease');
        assert.equal(await provider.cleanup(), true);
      } else {
        await assert.rejects(pending, /opencode.v2.owner-cleanup-unknown/,
          'uncertain physical teardown cannot appear as healthy readiness');
        assert.equal(await provider.cleanup(), false);
      }
      assert.equal(progress, 2, 'the second native probe really completed');
      assert.equal(provider.isReady(), false);
      assert.equal(provider.initialContextEvidence?.(), undefined);
      assert.equal(calls.stop, 1, 'never repeat an uncertain stop ACK');
      assert.equal(calls.password, 0, 'no native credentials accessed');
      assert.equal(calls.context, 1, 'never replay native instructions');
    }
  });

test('retained V2 driver handle cannot mutate or checkpoint after Host seal', async () => {
  const { captured, calls } = owner(true);
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);

  provider.seal();
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-after-seal', operationRef: 'TEST-no-post', content: 'must not send',
  }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
  assert.deepEqual(await opened.driver.respondToInteraction('perTEST-foreign',
    { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unavailable' });
  assert.deepEqual(await opened.driver.interrupt('TEST-foreign-operation'),
    { ok: false, code: 'unavailable' });
  assert.deepEqual(await opened.driver.checkReadiness(), { ok: false, code: 'unavailable' });
  assert.deepEqual(opened.driver.checkpoint(), { ok: false, code: 'unavailable' });
  assert.equal(provider.isReady(), false);
  assert.equal(provider.initialContextEvidence?.(), undefined);
  assert.equal(calls.password, 0, 'revoked driver never reads native credentials');
  assert.equal(calls.context, 1, 'no native instructions replay');
  assert.equal(calls.stop, 1, 'only the captured TEST-owned process is stopped');
  assert.equal(await provider.cleanup(), true);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});


test('V2 owner cleanup never follows replaced process-stop or confirmation callbacks',
  async () => {
    const { captured, calls } = owner(true);
    // The original process has uncertain physical termination. A callback
    // replacement must not turn that UNKNOWN custody into a false success,
    // or dispatch a stop signal through a different process owner.
    captured.confirmStopped = async () => { calls.stopped++; return false; };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);

    let foreignStopCalls = 0;
    let forgedConfirmCalls = 0;
    captured.stopOwned = async () => { foreignStopCalls++; return true; };
    captured.confirmStopped = async () => { forgedConfirmCalls++; return true; };
    provider.seal();
    assert.equal(await provider.cleanup(), false, 'original physical custody remains UNKNOWN');
    assert.equal(calls.stop, 1, 'stop must use the original captured TEST owner');
    assert.equal(calls.stopped, 1, 'readback must come from the original owner');
    assert.equal(foreignStopCalls, 0, 'never invoke an externally swapped stop method');
    assert.equal(forgedConfirmCalls, 0, 'never trust a swapped cleanup certificate');
    assert.equal(provider.isReady(), false);
    assert.deepEqual(await opened.driver.close(), {
      logicallyClosed: true, cleanup: 'unknown',
    });
    assert.equal(calls.stop, 1, 'shutdown never repeats physical stop');
  });


test('V2 owner cleanup callbacks remain pinned when swapped during native admission', async () => {
  const { captured, calls } = owner(true);
  // Capture an uncertain original termination BEFORE the owner callback can
  // replace both methods. A forged confirmation must never turn it into PASS.
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  let foreignStopCalls = 0;
  let forgedConfirmCalls = 0;
  captured.probe = async () => {
    calls.probe++;
    captured.stopOwned = async () => { foreignStopCalls++; return true; };
    captured.confirmStopped = async () => { forgedConfirmCalls++; return true; };
    return true;
  };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.equal(calls.probe, 1, 'method replacement occurred inside native admission');

  provider.seal();
  assert.equal(await provider.cleanup(), false, 'original physical custody is UNKNOWN');
  assert.equal(calls.stop, 1, 'only the original TEST process stop is invoked');
  assert.equal(calls.stopped, 1, 'readback remains bound to original TEST owner');
  assert.equal(foreignStopCalls, 0, 'foreign owner cannot stop another process');
  assert.equal(forgedConfirmCalls, 0, 'forged physical confirmation is never trusted');
  assert.equal(provider.isReady(), false);
  assert.deepEqual(await opened.driver.close(), {
    logicallyClosed: true, cleanup: 'unknown',
  });
  assert.equal(calls.stop, 1, 'an unknown stop ACK is never replayed');
});

test('retained V2 controls surface UNKNOWN process custody, never re-signal', async () => {
  const { captured, calls } = owner(true);
  captured.stopOwned = async () => { calls.stop++; return false; };
  captured.confirmStopped = async () => { calls.stopped++; return false; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  provider.seal();

  await assert.rejects(() => opened.driver.submit({
    inputId: 'TEST-unknown-stop', operationRef: 'TEST-no-retry', content: 'must not send',
  }), /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.respondToInteraction('perTEST-foreign',
    { kind: 'permission', decision: 'allow' }), /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.interrupt('TEST-foreign-operation'),
    /opencode.v2.owner-cleanup-unknown/);
  await assert.rejects(() => opened.driver.checkReadiness(),
    /opencode.v2.owner-cleanup-unknown/);
  assert.deepEqual(opened.driver.checkpoint(), { ok: false, code: 'unavailable' });
  assert.equal(calls.stop, 1, 'unknown ACK never causes a second physical stop');
  assert.equal(calls.password, 0);
  assert.equal(await provider.cleanup(), false);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  await assert.rejects(async () => {
    for await (const _event of opened.driver.observe()) { /* Drain sealed feed. */ }
  }, /opencode.v2.owner-cleanup-unknown/,
  'natural observation exhaustion must not mask UNKNOWN process custody');
});

test('buffered private V2 terminal never escapes a revoked Host observer', async () => {
  const { captured, calls } = owner(true);
  captured.readPassword = () => { calls.password++; return ''; };
  const provider = createOpenCodeV2MemberProvider(context(), captured);
  const opened = await provider.factory.open(request());
  assert.equal(provider.isReady(), true);
  assert.deepEqual(await opened.driver.submit({
    inputId: 'TEST-buffered-failure', operationRef: 'TEST-buffered-op',
    content: 'TEST preflight only; no model',
  }), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
  assert.equal(provider.isReady(), false);
  // Private EventFeed.finishWith deliberately retains a diagnostic frame.
  // Host must suppress it once the captured generation has been retired.
  const received = await opened.driver.observe()[Symbol.asyncIterator]().next();
  assert.equal(received.done, true, 'revoked Host cannot expose buffered native diagnostic');
  assert.equal(calls.stop, 1);
  assert.equal(calls.password, 1);
  assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
});

test('direct V2 SPI close retires its TEST owner without a separate Host cleanup call',
  { timeout: 4000 }, async () => {
    for (const physicallyConfirmed of [true, false]) {
      const { captured, calls } = owner(true);
      captured.confirmStopped = async () => { calls.stopped++; return physicallyConfirmed; };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      const opened = await provider.factory.open(request());
      const observer = opened.driver.observe()[Symbol.asyncIterator]();
      // Attach both handlers before close(): the pending next() can reject
      // while physical custody remains UNKNOWN, and that rejection must not
      // become an unhandled promise or be mistaken for clean exhaustion.
      const observed = observer.next().then(
        (event: IteratorResult<unknown>) => event.done ? 'done' : 'unexpected-event',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      const receipt = await opened.driver.close();
      assert.equal(await observed, physicallyConfirmed ? 'done' : 'opencode.v2.owner-cleanup-unknown',
        'close wakes the feed; uncertain physical custody must fail closed');
      assert.deepEqual(receipt, {
        logicallyClosed: true,
        cleanup: physicallyConfirmed ? 'confirmed' : 'unknown',
      }, 'an uncertain physical stop cannot be reported as a confirmed close');
      assert.equal(provider.isReady(), false);
      assert.equal(provider.initialContextEvidence?.(), undefined);
      assert.equal(calls.stop, 1, 'close alone stops the original owned PID exactly once');
      assert.equal(await provider.cleanup(), physicallyConfirmed);
      assert.equal(calls.stop, 1, 'later cleanup never resends an uncertain stop');
      assert.equal(calls.password, 0, 'no native request or credential read during close');
    }
  });

test('consumer cancel before first V2 observation retires the unclaimable native session',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const cancelled = await observer.return?.();
    assert.equal(cancelled?.done, true);
    assert.equal((await observer.next()).done, true);
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'cancel must stop only the captured TEST owner');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0, 'no native request is allowed after cancel');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(calls.stop, 1, 'no duplicate stop signal');
  });

test('consumer cancel wakes a suspended native V2 next without Host seal',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pendingNext = observer.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pendingCancel = observer.return?.();
    assert.equal((await pendingNext).done, true, 'pending next must be released');
    assert.equal((await pendingCancel)?.done, true);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.stop, 1, 'the same owned process is stopped once');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('consumer observer cancel reports uncertain physical native cleanup',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    captured.stopOwned = async () => { calls.stop++; return false; };
    captured.confirmStopped = async () => { calls.stopped++; return false; };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    await assert.rejects(async () => { await observer.return?.(); },
      /opencode.v2.owner-cleanup-unknown/);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.stop, 1, 'uncertain ACK must never be replayed');
    assert.equal(await provider.cleanup(), false);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  });

test('consumer throw before first V2 observation retires its single-claim native owner',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    assert.equal(typeof observer.throw, 'function');
    const failure = new Error('TEST observer failed before next');
    await assert.rejects(async () => { await observer.throw?.(failure); },
      (error: unknown) => error === failure);
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'no observer can reclaim the native EventFeed');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(calls.stop, 1, 'cleanup must not signal twice');
  });

test('consumer throw wakes pending V2 observation without leaking native ownership',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pendingNext = observer.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failure = new Error('TEST consumer abandons native feed');
    const pendingThrow = observer.throw?.(failure);
    assert.equal((await pendingNext).done, true, 'pending native next must be released');
    await assert.rejects(async () => { await pendingThrow; },
      (error: unknown) => error === failure);
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1);
    assert.equal(calls.stopped, 1);
    assert.equal(calls.password, 0);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('consumer throw cannot mask UNKNOWN physical native owner custody',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    captured.stopOwned = async () => { calls.stop++; return false; };
    captured.confirmStopped = async () => { calls.stopped++; return false; };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    await assert.rejects(async () => { await observer.throw?.(new Error('TEST consumer failure')); },
      /opencode.v2.owner-cleanup-unknown/);
    assert.equal(provider.isReady(), false);
    assert.equal(calls.stop, 1, 'no retry after unknown stop ACK');
    assert.equal(await provider.cleanup(), false);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'unknown' });
  });

test('Host seal wakes a suspended native V2 observer without delivering a late event',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    const iterator = opened.driver.observe()[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    provider.seal();
    const result = await next;
    assert.equal(result.done, true, 'revocation resolves even when private feed has no events');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1);
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('idle observer revokes an expired native V2 lease without seal or native events',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    let leaseValid = true;
    const ctx = { ...context(), canAllocate: () => leaseValid };
    const provider = createOpenCodeV2MemberProvider(ctx, captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pending = observer.next();
    // Start one genuine idle next() and then remove Host authority WITHOUT
    // calling isReady(), seal(), or a mutating SPI method. The observer must
    // notice lease expiration itself rather than wait indefinitely for events.
    await new Promise<void>((resolve) => setImmediate(resolve));
    leaseValid = false;
    const expired = Promise.withResolvers<never>();
    const deadline = setTimeout(() => expired.reject(new Error('idle V2 lease watcher did not wake')),
      1750);
    try {
      const result = await Promise.race([pending, expired.promise]);
      assert.equal(result.done, true, 'expired Host cannot leak an idle native event');
    } finally {
      clearTimeout(deadline);
      provider.seal();
    }
    leaseValid = true;
    assert.equal(provider.isReady(), false, 'lease restoration cannot revive a retired capture');
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'only the captured TEST-owned process was stopped once');
    assert.equal(calls.context, 1, 'no initial-context mutation replay');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
  });

test('late executable alias during a suspended V2 native probe cannot renew authority',
  { timeout: 3000 }, async () => {
    const previous = process.env.opencode_bin_path;
    delete process.env.opencode_bin_path;
    try {
      for (const stopConfirmed of [true, false]) {
        const { captured, calls } = owner(true);
        captured.confirmStopped = async () => { calls.stopped++; return stopConfirmed; };
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let suspendProbe = false;
        captured.probe = async () => {
          calls.probe++;
          if (suspendProbe) { entered.resolve(); await resume.promise; }
          return true;
        };
        const provider = createOpenCodeV2MemberProvider(context(), captured);
        const opened = await provider.factory.open(request());
        assert.equal(provider.isReady(), true);
        suspendProbe = true;
        const recheck = opened.driver.checkReadiness();
        try {
          await entered.promise;
          assert.equal(provider.isReady(), false, 'suspended native re-attestation fences old readiness');
          process.env.opencode_bin_path = '/TEST-parent/mixed-case-engine-during-probe';
        } finally {
          // Always release the deferred TEST probe, including on assertion failure.
          resume.resolve();
        }
        try {
          if (stopConfirmed) {
            assert.deepEqual(await recheck, { ok: false, code: 'unavailable' });
          } else {
            await assert.rejects(recheck, /opencode.v2.owner-cleanup-unknown/,
              'unconfirmed physical custody must not look like an ordinary readiness failure');
          }
          delete process.env.opencode_bin_path;
          assert.equal(provider.isReady(), false, 'clearing the override never revives custody');
          assert.equal(provider.initialContextEvidence?.(), undefined);
          assert.equal(calls.context, 1, 'native instructions must not be replayed');
          assert.equal(calls.stop, 1, 'stop is sent only to the captured TEST owner, once');
          assert.ok(calls.stopped >= 1, 'physical process status must be read back');
          assert.equal(await provider.cleanup(), stopConfirmed);
          assert.deepEqual(await opened.driver.close(), {
            logicallyClosed: true, cleanup: stopConfirmed ? 'confirmed' : 'unknown',
          });
          assert.equal(calls.stop, 1, 'cleanup must never resend an uncertain stop ACK');
        } finally {
          delete process.env.opencode_bin_path;
          resume.resolve();
          await opened.driver.close();
          await provider.cleanup();
        }
      }
    } finally {
      if (previous === undefined) delete process.env.opencode_bin_path;
      else process.env.opencode_bin_path = previous;
    }
  });

test('native progress callback cannot expose a V2 lease before its own admission fence settles',
  async () => {
    const { captured, calls } = owner(true);
    let provider!: ReturnType<typeof createOpenCodeV2MemberProvider>;
    let driver: { checkpoint: () => unknown } | undefined;
    const snapshots: Array<{ ready: boolean; evidence: boolean; checkpoint?: unknown }> = [];
    const capturedContext = {
      ...context(),
      onProgress: () => {
        // The callback is invoked after native attestations, but BEFORE the
        // current probe removes its pending fence. It may synchronously re-enter
        // public Host controls and must not observe an authorized native lease.
        snapshots.push({
          ready: provider.isReady(),
          evidence: provider.initialContextEvidence?.() !== undefined,
          ...(driver === undefined ? {} : { checkpoint: driver.checkpoint() }),
        });
      },
    };
    provider = createOpenCodeV2MemberProvider(capturedContext, captured);
    const opened = await provider.factory.open(request());
    driver = opened.driver;
    try {
      assert.deepEqual(snapshots, [{ ready: false, evidence: false }],
        'a progress callback is not evidence of a completed initial admission');
      assert.equal(provider.isReady(), true, 'readiness is visible after initial probe settles');
      assert.notEqual(provider.initialContextEvidence?.(), undefined);

      const check = await opened.driver.checkReadiness();
      assert.equal(check.ok, true);
      assert.deepEqual(snapshots[1], {
        ready: false, evidence: false,
        checkpoint: { ok: false, code: 'unavailable' },
      }, 'a reentrant callback cannot checkpoint during a still-pending native re-attestation');
      assert.equal(provider.isReady(), true, 'settled re-attestation restores the same owner');
      assert.equal(snapshots.length, 2, 'only the original native probes can report progress');
      assert.equal(calls.context, 1, 'no duplicate initial native context mutation');
      assert.equal(calls.stop, 0, 'in-flight fencing alone must not kill the owned native process');
    } finally {
      assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
      assert.equal(await provider.cleanup(), true);
      assert.equal(calls.stop, 1);
    }
  });

test('pending native V2 re-attestation fences concurrent controls without retiring owner',
  { timeout: 3000 }, async () => {
    const { captured, calls } = owner(true);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let suspendProbe = false;
    captured.probe = async () => {
      calls.probe++;
      if (suspendProbe) { entered.resolve(); await resume.promise; }
      return true;
    };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    const opened = await provider.factory.open(request());
    assert.equal(provider.isReady(), true);
    suspendProbe = true;
    const observer = opened.driver.observe()[Symbol.asyncIterator]();
    const pendingEvent = observer.next();
    let observerSettled = false;
    void pendingEvent.then(() => { observerSettled = true; }, () => { observerSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recheck = opened.driver.checkReadiness();
    await entered.promise;
    assert.equal(provider.isReady(), false, 'pending native recheck cannot reuse stale readiness');

    assert.deepEqual(await opened.driver.submit({
      inputId: 'TEST-overlap', operationRef: 'TEST-overlap-op', content: 'TEST only; no model',
    }), { ok: false, code: 'unavailable', delivery: 'known-not-sent' });
    assert.deepEqual(await opened.driver.respondToInteraction('perTEST-foreign',
      { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unavailable' });
    assert.deepEqual(await opened.driver.interrupt('TEST-foreign-operation'),
      { ok: false, code: 'unavailable' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observerSettled, false,
      'an already-running native observer stays pending through re-attestation');
    assert.equal(calls.stop, 0, 'a pending probe must not stop its still-owned native PID');
    assert.equal(calls.password, 0, 'fenced controls never read native credentials');

    resume.resolve();
    assert.equal((await recheck).ok, true);
    assert.equal(provider.isReady(), true, 'successful re-attestation restores the same captured owner');
    assert.equal(calls.context, 1, 'no initial-instruction replay');
    assert.equal(calls.stop, 0);
    assert.equal(observerSettled, false, 'the same observer remains live after re-attestation');
    provider.seal();
    assert.equal((await pendingEvent).done, true, 'revocation wakes the retained observer');
    assert.equal(await provider.cleanup(), true);
    assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(calls.stop, 1, 'only Host seal stops the original native owner');
  });

// Even though the corrected V2 driver admits canonical Windows directories,
// drive-relative paths must fail before a native probe or credential access.
test('private V2 driver refuses drive-relative Windows cwd before network access',
  { skip: process.platform !== 'win32' }, async () => {
    const fixture = nativeV2Profile();
    fixture.cwd = 'C:TEST-only-opencode-v2';
    const { captured, calls } = owner(true);
    const provider = createOpenCodeV2MemberProvider(context(fixture), captured);
    await assert.rejects(() => provider.factory.open(request()), /opencode.driver.invalid-config/);
    assert.equal(calls.probe, 0, 'drive-relative path cannot reach a native probe');
    assert.equal(calls.password, 0, 'no native credentials');
    assert.equal(calls.stop, 1, 'only this TEST-owned capture is retired');
    assert.equal(await provider.cleanup(), true);
  });

test('late native prompt ACK stays UNKNOWN across re-attestation recovery and Host seal',
  { timeout: 15000 }, async () => {
    // An outer node:test timeout alone cannot release unresolved promises or
    // close live peers. Bound each synthetic HTTP/re-attestation handshake.
    const within = async <T>(work: Promise<T>, stage: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TEST handshake timeout: ' + stage)), 5000);
        })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // Independent disposable peers: active turns must never cross TEST sessions.
    for (const mode of ['recheck', 'recheck-restored', 'seal'] as const) {
      const profile = v2Profile();
      const postSeen = Promise.withResolvers<void>();
      const releaseAck = Promise.withResolvers<void>();
      const recheckEntered = Promise.withResolvers<void>();
      const completeRecheck = Promise.withResolvers<void>();
      let postCount = 0;
      const sessionPath = '/api/session/' + profile.nativeSessionId;
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const json = (value: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(value));
        };
        if (req.method === 'GET' && url.pathname === sessionPath) {
          // Synthetic disposable TEST peer with pinned V2 {data} envelope:
          // no actual native engine/tool execution or qualification implied.
          json({ data: {
            id: profile.nativeSessionId, location: { directory: profile.cwd },
            agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' },
            time: { created: 1 },
          } });
          return;
        }
        if (req.method === 'GET' &&
            url.pathname === '/api/experimental/session/' + profile.nativeSessionId + '/log') {
          res.setHeader('content-type', 'text/event-stream');
          res.end([
            {
              id: 'evt_created', type: 'session.created',
              durable: { aggregateID: profile.nativeSessionId, seq: 0 },
              data: { sessionID: profile.nativeSessionId },
              location: { directory: profile.cwd },
            },
            { type: 'log.synced', aggregateID: profile.nativeSessionId, seq: 0 },
          ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
          return;
        }
        if (req.method === 'POST' && url.pathname === sessionPath + '/prompt') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            const input = JSON.parse(body) as { id: string; text: string };
            postCount++;
            postSeen.resolve();
            void releaseAck.promise.then(() => json({ data: {
              id: input.id, sessionID: profile.nativeSessionId, type: 'user',
              delivery: 'queue', time: { created: 1 }, payload: { text: input.text },
            } }));
          });
          return;
        }
        res.writeHead(404); res.end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      profile.endpoint = 'http://127.0.0.1:' + address.port;
      let opened: Awaited<ReturnType<ReturnType<typeof createOpenCodeV2MemberProvider>['factory']['open']>> | undefined;
      const { captured, calls } = owner(true);
      let suspendRecheck = false;
      captured.probe = async () => {
        calls.probe++;
        if (suspendRecheck) {
          recheckEntered.resolve();
          await completeRecheck.promise;
        }
        return true;
      };
      try {
        const provider = createOpenCodeV2MemberProvider(context(profile), captured);
        opened = await provider.factory.open(request());
        assert.equal(provider.isReady(), true);
        const pending = opened.driver.submit({
          inputId: 'TEST-late-' + mode, operationRef: 'TEST-late-' + mode + '-op',
          content: 'TEST only; no model',
        });
        // The pinned driver probes before its POST. Only block the separate
        // re-attestation AFTER the TEST HTTP peer has received the mutation.
        await within(postSeen.promise, mode + ' POST received');
        if (mode !== 'seal') {
          suspendRecheck = true;
          const recheck = opened.driver.checkReadiness();
          await within(recheckEntered.promise, 're-attestation started');
          assert.equal(provider.isReady(), false);
          if (mode === 'recheck-restored') {
            completeRecheck.resolve();
            const recoveredReadback = await within(recheck, 'successful re-attestation');
            assert.ok(recoveredReadback && typeof recoveredReadback === 'object' &&
              'ok' in recoveredReadback, 're-attestation returns a structured SPI reply');
            assert.equal(recoveredReadback.ok, true);
            assert.equal(provider.isReady(), true, 'owner restored before late native POST ACK');
            assert.equal(calls.stop, 0, 'a successful probe alone must not retire the owner');
          }
          releaseAck.resolve();
          assert.deepEqual(await within(pending, mode + ' native ACK'), { ok: false, code: 'unknown' },
            'late POST ACK cannot inherit newly restored readiness after an intervening probe');
          assert.equal(postCount, 1, 'no second native POST after uncertain ACK');
          // The original native POST is uncertain after its ACK raced the
          // policy probe. Quarantine this capture before any further dispatch.
          // A probe by itself must not stop the PID; an uncertain mutation does.
          assert.equal(calls.stop, 1, 'uncertain native handoff retires only its TEST-owned PID');
          assert.equal(provider.isReady(), false, 'no renewed readiness after UNKNOWN delivery');
          if (mode === 'recheck') {
            provider.seal();
            completeRecheck.resolve();
            const sealedReadback = await within(recheck, 'sealed re-attestation');
            assert.ok(sealedReadback && typeof sealedReadback === 'object' && 'ok' in sealedReadback,
              'the private Session SPI must return a structured readiness result');
            assert.equal(sealedReadback.ok, false, 'seal revokes the suspended native probe');
          }
        } else {
          provider.seal();
          releaseAck.resolve();
          assert.deepEqual(await within(pending, 'sealed native ACK'), { ok: false, code: 'unknown' },
            'post-seal native ACK is neither authorized nor known-not-sent');
        }
        assert.equal(postCount, 1, 'each TEST case sends exactly one native POST');
        assert.equal(provider.isReady(), false);
        assert.equal(calls.stop, 1, 'only the captured TEST-owned process is stopped');
        assert.deepEqual(await opened.driver.close(), { logicallyClosed: true, cleanup: 'confirmed' });
        assert.equal(await provider.cleanup(), true);
        assert.equal(calls.stop, 1, 'stop is single-flight after uncertain ACK');
      } finally {
        completeRecheck.resolve();
        releaseAck.resolve();
        await opened?.driver.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      }
    }
  });

test('V2 observer abandonment finalizes after rejected private close for return and throw',
  { timeout: 3000 }, async () => {
    for (const operation of ['return', 'throw'] as const) {
      const closeFailure = new Error('TEST private V2 observer close rejected');
      let finalized = 0;
      let closes = 0;
      let physicalStops = 0;
      const stream = guardOpenCodeV2ObserverCleanup((async function* () {
        try {
          yield 'native-test-event';
        } finally {
          finalized++;
        }
      })(), async () => {
        closes++;
        throw closeFailure;
      }, async () => {
        physicalStops++;
        return true;
      });
      assert.equal((await stream.next()).value, 'native-test-event');
      const result = operation === 'return' ? stream.return(undefined) :
        stream.throw(new Error('TEST consumer throw'));
      await assert.rejects(result, (error: unknown) => error === closeFailure,
        'a private close rejection must remain visible after finalization');
      assert.equal(finalized, 1, 'underlying generator finally must run');
      assert.equal(closes, 1, 'private close is never retried');
      assert.equal(physicalStops, 1, 'only the owned physical stop is signaled');
    }
  });

test('revoked V2 inner native observer finalizes despite rejected feed close',
  { timeout: 3000 }, async () => {
    const closeFailure = new Error('TEST revoked private feed close rejected');
    let finalized = 0;
    let closeCalls = 0;
    const iterator = (async function* () {
      try {
        yield 'claimed';
      } finally {
        finalized++;
      }
    })();
    await iterator.next();
    await assert.rejects(
      finalizeOpenCodeV2ObserverAfterClose(
        async () => { closeCalls++; throw closeFailure; },
        () => iterator.return(undefined),
      ),
      (error: unknown) => error === closeFailure,
    );
    assert.equal(finalized, 1, 'native iterator finalization cannot be skipped');
    assert.equal(closeCalls, 1, 'a rejected close is never replayed');
  });

test('V2 rejects forged native permission envelopes before and after initial context PUT', async () => {
  for (const phase of ['initial', 'final'] as const) {
    for (const shape of ['identity-getter', 'proxy'] as const) {
      const { captured, calls } = owner(true);
      let getterCalls = 0;
      const deny = { action: 'external_directory', resource: '*', effect: 'deny' };
      const allow = { action: 'external_directory', resource: '*', effect: 'allow' };
      captured.readNativeEffectivePermissions = async () => {
        calls.permissions++;
        const normal = testNativePermissionReadback([deny]);
        if ((phase === 'initial' && calls.permissions !== 1) ||
            (phase === 'final' && calls.permissions !== 2)) return normal;
        if (shape === 'proxy') return new Proxy(normal, {});
        const forged = testNativePermissionReadback([allow]);
        Object.defineProperty(forged, 'nativeSessionId', {
          enumerable: true,
          get() {
            getterCalls++;
            // Old Host access to nativeSessionId ran this mutation BEFORE
            // it checked the apparently final DENY rules.
            forged.rules = [deny];
            return v2Profile().nativeSessionId;
          },
        });
        return forged;
      };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      await assert.rejects(() => provider.factory.open(request()),
        /opencode.driver.dependency-unavailable/,
        'an accessor or Proxy is not a native JSON permission witness');
      assert.equal(getterCalls, 0, 'Host must not execute native readback getters');
      assert.equal(calls.context, phase === 'final' ? 1 : 0,
        'a rejected initial readback never installs context; a final one never replays it');
      assert.equal(calls.password, 0, 'no credentials after forged native permissions');
      assert.equal(provider.isReady(), false);
      assert.equal(calls.stop, 1, 'only the captured TEST-owned process stops');
      assert.equal(await provider.cleanup(), true);
    }
  }
});

test('V2 refuses forged native custody envelopes before and after context installation', async () => {
  for (const phase of ['initial', 'final'] as const) {
    for (const shape of ['identity-getter', 'proxy'] as const) {
      const { captured, calls } = owner(true);
      let reads = 0;
      let getterCalls = 0;
      captured.readNativeCustody = async () => {
        reads++;
        const canonical = testNativeCustody();
        if ((phase === 'initial' && reads !== 1) ||
            (phase === 'final' && reads !== 2)) return canonical;
        if (shape === 'proxy') return new Proxy(canonical, {});
        const forged = { ...canonical, executableSha256: 'b'.repeat(64) };
        Object.defineProperty(forged, 'executablePath', {
          enumerable: true,
          get() {
            getterCalls++;
            // Old Host projected path first, allowing this getter to replace
            // the unqualified digest before it read executableSha256.
            forged.executableSha256 = canonical.executableSha256;
            return canonical.executablePath;
          },
        });
        return forged;
      };
      const provider = createOpenCodeV2MemberProvider(context(), captured);
      await assert.rejects(() => provider.factory.open(request()),
        /opencode.driver.dependency-unavailable/,
        'native custody evidence must be genuine JSON data, not a mutable projection');
      assert.equal(reads, phase === 'final' ? 2 : 1);
      assert.equal(getterCalls, 0, 'Host must not invoke a custody identity getter');
      assert.equal(calls.context, phase === 'final' ? 1 : 0,
        'native instructions never run with invalid initial custody or replay on final failure');
      assert.equal(calls.password, 0, 'invalid process identity cannot access credentials');
      assert.equal(calls.stop, 1, 'only the original TEST-owned process is retired');
      assert.equal(provider.isReady(), false);
      assert.equal(await provider.cleanup(), true);
    }
  }
});

test('V2 rejects forged native initial-context ACK before final policy readback', async () => {
  // An owner-provided getter could previously rewrite a wrong context digest
  // while Host read nativeSessionId. Do not accept a forged native PUT ACK.
  for (const shape of ['digest-getter', 'proxy', 'hidden-field', 'foreign-prototype'] as const) {
    const { captured, calls } = owner(true);
    let getterCalls = 0;
    captured.installAndAttestInitialContext = async (capture) => {
      calls.context++;
      const receipt = {
        nativeSessionId: capture.nativeSessionId,
        contextDigest: capture.contextDigest,
        generation: capture.generation,
        configRevision: capture.configRevision,
      };
      if (shape === 'proxy') return new Proxy(receipt, {});
      if (shape === 'hidden-field') {
        Object.defineProperty(receipt, 'unsupported', { value: true, enumerable: false });
      } else if (shape === 'foreign-prototype') {
        Object.setPrototypeOf(receipt, { toJSON: () => ({ contextDigest: 'forged' }) });
      } else if (shape === 'digest-getter') {
        receipt.contextDigest = 'b'.repeat(64);
        Object.defineProperty(receipt, 'nativeSessionId', {
          enumerable: true,
          get() {
            getterCalls++;
            // Pre-fix direct property access accepted the fake digest after
            // this getter changed it to the expected captured digest.
            receipt.contextDigest = capture.contextDigest;
            return capture.nativeSessionId;
          },
        });
      }
      return receipt;
    };
    const provider = createOpenCodeV2MemberProvider(context(), captured);
    await assert.rejects(() => provider.factory.open(request()),
      /opencode.driver.dependency-unavailable/,
      'a non-JSON instruction ACK must not attest the initial native context');
    assert.equal(getterCalls, 0, 'Host must not execute an instruction ACK getter');
    assert.equal(calls.context, 1, 'possibly applied native instructions are never replayed');
    assert.equal(calls.permissions, 1, 'forged ACK must fail before final permission readback');
    assert.equal(calls.password, 0, 'invalid context receipt cannot access credentials');
    assert.equal(provider.isReady(), false);
    assert.equal(provider.initialContextEvidence?.(), undefined);
    assert.equal(calls.stop, 1, 'only this TEST-owned native engine is retired');
    assert.equal(await provider.cleanup(), true);
  }
});
