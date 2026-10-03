import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  decodeOwnerPermissionReply,
  decodeProtocol2CommandContext,
  decodeProtocol2Handshake,
  decodeProtocol2Offer,
  negotiateOpenCodeProtocol,
} from '@features/opencode-compatibility';
import {
  parseSingleBridgeJsonResult,
  validateBridgeResultEnvelope,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { createOpenCodeBridgeClientIdentity } from '@main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { describe, expect, it } from 'vitest';

import type {
  EndpointAuthority,
  NativeIdentity,
  OwnerPermissionReply,
  Protocol2CommandContext,
  Protocol2Handshake,
  Protocol2Offer,
} from '@features/opencode-compatibility/contracts';

const sha = 'a'.repeat(64);
function native(version = '2.0.0'): NativeIdentity {
  return version === '1.18.0'
    ? {
        generation: 'v1',
        apiDialect: 'v1',
        version,
        executablePath: '/TEST/bin/opencode',
        executableSha256: sha,
        launcherPath: '/TEST/bin/opencode1',
        packageName: 'opencode-ai',
        source: 'explicit',
      }
    : {
        generation: 'v2',
        apiDialect: version === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.21',
        version,
        executablePath: '/TEST/bin/opencode-native',
        executableSha256: sha,
        launcherPath: '/TEST/bin/opencode2',
        packageName: '@opencode/cli',
        source: 'explicit',
      };
}
function endpoint(version = '2.0.0'): EndpointAuthority {
  return {
    native: native(version),
    selectionEpoch: 'sel-3',
    profileEpoch: 'prof-9',
    profileRootKey: 'TEST-profile',
    profileGeneration: version === '1.18.0' ? 'v1' : 'v2',
    canonicalDirectory: '/TEST/project',
    projectId: 'p_1',
    baseUrl: 'http://127.0.0.1:48123',
    pid: 1234,
    processBirth: { format: 'linux-start-ticks', value: '987654', bootId: 'TEST-boot' },
    observedSpawnAtUtcMs: 1790899200000,
    hostInstanceId: 'host-5',
    ownership: 'spawned',
    capabilitySnapshotId: 'cap-6',
  };
}
function permission(): OwnerPermissionReply {
  return {
    schemaVersion: 1,
    scope: {
      kind: 'session',
      requestId: 'r_7',
      relation: 'child',
      authority: {
        endpoint: endpoint(),
        teamId: 'TEST-team',
        runId: 'run-4',
        laneId: 'primary',
        memberName: 'worker',
        sessionId: 's_child',
        rootSessionId: 's_root',
        parentSessionId: 's_parent',
        bindingId: 'bind-7',
        leaseId: 'lease-8',
        leaseEpoch: 'lease-rev-2',
        sessionRevision: 'session-rev-3',
      },
    },
    approvalId: 'approval-8',
    bindingId: 'bind-7',
    expectedRevision: 'rev-11',
    operationId: 'answer-12',
    decision: 'always',
  };
}
function offer(version = '2.0.0'): Protocol2Offer {
  return {
    schemaVersion: 1,
    minVersion: 1,
    currentVersion: 2,
    selected: native(version),
    requiredOperations: { generationIdentity: 1, permissionAnswer: 1 },
  };
}
function handshake(version = '2.0.0'): Protocol2Handshake {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    supportedGenerations: ['v1', 'v2'],
    dialects: {
      [native(version).apiDialect]: {
        generationIdentity: {
          version: 1,
          fingerprint: sha,
          availability: 'qualified',
          qualificationDigest: sha,
        },
        permissionAnswer: {
          version: 1,
          fingerprint: sha,
          availability: 'qualified',
          qualificationDigest: sha,
        },
      },
    },
    selectedNative: native(version),
    selectionEpoch: 'sel-3',
    selectedAuthority: endpoint(version),
    support: 'ready',
    qualificationDigest: sha,
  };
}
function context(): Protocol2CommandContext {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    operation: 'permissionAnswer',
    operationVersion: 1,
    operationFingerprint: sha,
    native: native(),
    selectionEpoch: 'sel-3',
    authority: permission().scope.authority,
    operationId: 'answer-12',
    expectedObservationEpoch: 'obs-4',
    expectedCapabilitySnapshotId: 'cap-6',
    expectedManifestHighWatermark: 7,
    expectedRunId: 'run-4',
    handshakeIdentityHash: sha,
  };
}

// These protect absent/new strict decoding, not an implemented permission transport.
describe('bounded protocol2 public contracts', () => {
  it.each(['once', 'always', 'reject'] as const)(
    'retains full child authority and %s intent',
    (decision) => {
      const source = permission();
      source.decision = decision;
      const decoded = decodeOwnerPermissionReply(JSON.stringify(source));
      expect(decoded).toEqual({ ok: true, value: source });
      if (!decoded.ok) throw new Error(decoded.reason);
      expect(Object.isFrozen(decoded.value.scope.authority.endpoint.native)).toBe(true);
      (source.scope.authority.endpoint.native as { executablePath: string }).executablePath =
        '/TEST/foreign';
      expect(decoded.value.scope.authority.endpoint.native.executablePath).toBe(
        '/TEST/bin/opencode-native'
      );
    }
  );

  it.each(['bindingId', 'expectedRevision', 'operationId', 'approvalId'])(
    'refuses missing %s',
    (key) => {
      const source = permission() as unknown as Record<string, unknown>;
      delete source[key];
      expect(decodeOwnerPermissionReply(source).ok).toBe(false);
    }
  );

  it.each([
    'endpoint',
    'rootSessionId',
    'parentSessionId',
    'leaseId',
    'leaseEpoch',
    'sessionRevision',
  ])('refuses incomplete authority %s', (key) => {
    const source = permission();
    delete (source.scope.authority as unknown as Record<string, unknown>)[key];
    expect(decodeOwnerPermissionReply(source).ok).toBe(false);
  });

  it('refuses wrong binding, relation and legacy boolean permission', () => {
    const wrong = permission();
    wrong.bindingId = 'other-binding';
    expect(decodeOwnerPermissionReply(wrong).ok).toBe(false);
    wrong.bindingId = 'bind-7';
    wrong.scope = { ...wrong.scope, relation: 'root' };
    expect(decodeOwnerPermissionReply(wrong).ok).toBe(false);
    expect(
      decodeOwnerPermissionReply({ memberName: 'worker', requestId: 'r_7', allow: true }).ok
    ).toBe(false);
  });

  it('bounds input and refuses accessors without invoking them', () => {
    let accesses = 0;
    expect(
      decodeProtocol2Offer({
        get selected() {
          accesses++;
          throw new Error('effect');
        },
      }).ok
    ).toBe(false);
    expect(accesses).toBe(0);
    expect(decodeProtocol2Handshake(' '.repeat(65537)).ok).toBe(false);
    expect(decodeOwnerPermissionReply({ ...permission(), message: 'x'.repeat(8193) }).ok).toBe(
      false
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(decodeProtocol2Offer(cycle).ok).toBe(false);
  });

  it('refuses unknown dialect/operation/version/fingerprint and mismatched command authority', () => {
    expect(
      decodeProtocol2Offer({ ...offer(), selected: { ...native(), apiDialect: 'v2-next' } }).ok
    ).toBe(false);
    expect(decodeProtocol2Offer({ ...offer(), requiredOperations: { foreignWrite: 1 } }).ok).toBe(
      false
    );
    expect(
      decodeProtocol2Offer({ ...offer(), requiredOperations: { permissionAnswer: 2 } }).ok
    ).toBe(false);
    expect(decodeProtocol2CommandContext(context()).ok).toBe(true);
    expect(decodeProtocol2CommandContext({ ...context(), operationFingerprint: 'forged' }).ok).toBe(
      false
    );
    expect(decodeProtocol2CommandContext({ ...context(), expectedRunId: 'foreign' }).ok).toBe(
      false
    );
    expect(
      decodeProtocol2CommandContext({ ...context(), expectedCapabilitySnapshotId: 'foreign' }).ok
    ).toBe(false);
  });

  it.each(['2.0.0', '2.0.21'])('vetoes even a claimed ready %s', (version) => {
    const result = negotiateOpenCodeProtocol({
      version,
      offer: offer(version),
      handshake: handshake(version),
      expectedAuthority: endpoint(version),
      expectedOperations: handshake(version).dialects[native(version).apiDialect],
    });
    expect(result).toEqual({ kind: 'blocked', reason: 'V2 remains unqualified in A0' });
  });

  it('supports old/new V1 negotiation and refuses V2 fallback', () => {
    expect(negotiateOpenCodeProtocol({ version: '1.18.0' })).toEqual({
      kind: 'legacy',
      protocolVersion: 1,
      generation: 'v1',
    });
    expect(negotiateOpenCodeProtocol({ version: '1.18.0', offer: offer('1.18.0') })).toEqual({
      kind: 'legacy',
      protocolVersion: 1,
      generation: 'v1',
    });
    expect(negotiateOpenCodeProtocol({ version: '2.0.0', offer: offer() }).kind).toBe('blocked');
    expect(
      negotiateOpenCodeProtocol({ version: '1.18.0', handshake: handshake('1.18.0') }).kind
    ).toBe('blocked');
  });

  it('negotiates exact qualified V1 metadata but vetoes pending/forged authority or operations', () => {
    const response = handshake('1.18.0');
    const input = {
      version: '1.18.0',
      offer: offer('1.18.0'),
      handshake: response,
      expectedAuthority: endpoint('1.18.0'),
      expectedOperations: structuredClone(response.dialects.v1),
    };
    expect(negotiateOpenCodeProtocol(input)).toEqual({
      kind: 'compatible',
      protocolVersion: 2,
      generation: 'v1',
    });
    response.dialects.v1!.permissionAnswer!.availability = 'pending';
    expect(negotiateOpenCodeProtocol(input).kind).toBe('blocked');
    response.dialects.v1!.permissionAnswer!.availability = 'qualified';
    response.dialects.v1!.permissionAnswer!.fingerprint = 'b'.repeat(64);
    expect(negotiateOpenCodeProtocol(input).kind).toBe('blocked');
    response.dialects.v1!.permissionAnswer!.fingerprint = sha;
    response.selectedAuthority = { ...response.selectedAuthority!, hostInstanceId: 'foreign-host' };
    expect(negotiateOpenCodeProtocol(input).kind).toBe('blocked');
  });

  it('accepts captured pre-change schema1 response through current public validators', () => {
    // Captured from the existing OpenCodeBridgeCommandContract.test.ts bridgeSuccess fixture.
    const captured = readFileSync(
      resolve('test/features/opencode-compatibility/legacy-response.json'),
      'utf8'
    );
    const parsed = parseSingleBridgeJsonResult(captured);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(
      validateBridgeResultEnvelope(parsed.value, {
        schemaVersion: 1,
        requestId: 'req-1',
        command: 'opencode.launchTeam',
      })
    ).toEqual({ ok: true });
    expect(parsed.value).not.toHaveProperty('protocol2');
  });

  it('retains current legacy public builder bytes captured before A0 integration', () => {
    const captured = readFileSync(
      resolve('test/features/opencode-compatibility/legacy-identity.json'),
      'utf8'
    );
    const identity = createOpenCodeBridgeClientIdentity({ appVersion: 'test-app' });
    expect(JSON.stringify(identity, null, 2) + '\n').toBe(captured);
    expect(identity.bridgeProtocol).toMatchObject({
      minVersion: 1,
      currentVersion: 1,
      opencodeAppManagedBootstrapContractVersion: 1,
      opencodeDeliveryAcceptanceContractVersion: 2,
      opencodeFilePartsContractVersion: 2,
      opencodeTaskLedgerEvidenceContractVersion: 1,
      expectedBehaviorFingerprintSchemaVersion: 2,
    });
    expect(identity).not.toHaveProperty('protocol2');
  });
});
