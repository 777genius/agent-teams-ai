import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  assertSelectedControllerInputPresence,
  authenticateSelectedControllerInputs,
  snapshotSelectedControllerInputs,
} from '../../../../scripts/e2e/hosted-actual-owner/selected-controller-inputs';
import { sha256 } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/canonical';
import { SELECTED_PRIVATE_INPUTS } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/selected-private-inputs';

import type { SupervisorPlan } from '../../../../scripts/e2e/hosted-actual-owner/processes';
import type { SelectedControllerExecutionInputs } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/selected-controller-execution';

const nonce = '1'.repeat(64);
const runId = '2'.repeat(64);
const executable = '3'.repeat(64);
const artifact = '4'.repeat(64);
const bootstrap = '{"fixture":"selected-controller"}';
const proofKey = Buffer.alloc(32, 5).toString('base64');
const controllerDescriptor = '{"fixture":"controller"}';
const rejection = 'p3c_selected_controller_inputs_rejected';

function fixture(): {
  plan: SupervisorPlan;
  input: SelectedControllerExecutionInputs;
  mutableNamespace: Record<string, unknown>;
  mutableIssuance: Record<string, unknown>;
} {
  const launcher = generateKeyPairSync('ed25519');
  const activation = generateKeyPairSync('ed25519');
  const activationPublic = activation.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const activationContract = '6'.repeat(64);
  const mutableNamespace: Record<string, unknown> = {
    format: SELECTED_PRIVATE_INPUTS,
    controllerNonce: nonce,
    runId,
    openCode: {},
    serializedProductBootstrap: bootstrap,
    bootstrapProofKeyBase64: proofKey,
    launcherArtifactDigest: artifact,
    generations: [],
    productActivationSigning: {
      kind: 'product-activation-signing-key-file/v1',
      keyFile: '/sandbox/product-activation/key.pem',
      publicKeySpkiDerBase64url: activationPublic,
      contractDigest: activationContract,
    },
    productEnvironment: { FIXTURE: 'product' },
    browserEnvironment: { FIXTURE: 'browser' },
  };
  const mutableIssuance: Record<string, unknown> = {
    native: {
      allocation: { fixture: 'allocation' },
      controllerDescriptor,
      controllerTrustAnchor: { fixture: 'trust' },
      activation: {
        publicKeySpkiDerBase64url: activationPublic,
        contractDigest: activationContract,
      },
      observations: {
        async observe() {
          return {
            launchSha256: '7'.repeat(64),
            sealedSha256: '8'.repeat(64),
            ownerProcessStartToken: '9'.repeat(64),
            bootstrapV2HeaderSha256: 'a'.repeat(64),
            predecessorResults: [],
          };
        },
      },
      endpointObservations: {
        async observe() {
          return { device: '1', inode: '2' };
        },
      },
    },
    expectedOpenCodeExecutableSha256: executable,
    launcherKey: launcher.privateKey,
    predecessor: {
      launcherPublicKey: launcher.publicKey.export({ format: 'jwk' }).x,
      artifactDigest: `sha256:${artifact}`,
      bootstrapBinding: { proofKeyId: sha256(Buffer.from(proofKey, 'base64')) },
    },
    serializedProductBootstrap: bootstrap,
    initialAdmissionDocument: '{}',
    successors: [],
  };
  const plan = {
    controllerNonce: nonce,
    runId,
    expectedExecutableSha256: { opencode: executable },
    supervisorAdmissionDescriptor: { fixture: 'controller' },
  } as unknown as SupervisorPlan;
  return {
    plan,
    input: {
      namespace: mutableNamespace as never,
      issuance: mutableIssuance as never,
    },
    mutableNamespace,
    mutableIssuance,
  };
}

function changed(
  apply: (fixtureValue: ReturnType<typeof fixture>) => void
): [SupervisorPlan, SelectedControllerExecutionInputs] {
  const value = fixture();
  apply(value);
  return [value.plan, value.input];
}

describe('selected controller input source integration', () => {
  it('requires inputs exactly when the admitted Owner-v2 launch is selected', () => {
    expect(() => assertSelectedControllerInputPresence(false, undefined)).not.toThrow();
    const { input } = fixture();
    expect(() => assertSelectedControllerInputPresence(true, input)).not.toThrow();
    expect(() => assertSelectedControllerInputPresence(true, undefined)).toThrow(rejection);
    expect(() => assertSelectedControllerInputPresence(false, input)).toThrow(rejection);
  });

  it('snapshots controller data and retained authorities without exporting key bytes', async () => {
    const value = fixture();
    const snapshot = snapshotSelectedControllerInputs(value.plan, value.input);

    value.mutableNamespace.controllerNonce = 'f'.repeat(64);
    (value.mutableNamespace.productEnvironment as Record<string, string>).FIXTURE = 'substituted';
    value.mutableIssuance.serializedProductBootstrap = '{}';
    (
      (value.mutableIssuance.native as Record<string, unknown>).activation as Record<string, string>
    )['contractDigest'] = '0'.repeat(64);

    expect(snapshot.namespace.controllerNonce).toBe(nonce);
    expect(snapshot.namespace.productEnvironment).toEqual({ FIXTURE: 'product' });
    expect(snapshot.issuance.serializedProductBootstrap).toBe(bootstrap);
    expect(snapshot.issuance.native.activation.contractDigest).toBe('6'.repeat(64));
    expect(snapshot.issuance.launcherKey).toBe(value.input.issuance.launcherKey);
    expect(Object.hasOwn(snapshot.namespace, 'launcherKey')).toBe(false);
    expect(JSON.stringify(snapshot.namespace)).not.toContain('PRIVATE KEY');

    const observed = await snapshot.issuance.native.observations.observe(
      {} as never,
      new AbortController().signal
    );
    expect(observed.launchSha256).toBe('7'.repeat(64));
    const endpoint = await snapshot.issuance.native.endpointObservations.observe(
      {} as never,
      {} as never,
      new AbortController().signal
    );
    expect(endpoint).toEqual({ device: '1', inode: '2' });
  });

  it.each([
    [
      'stale controller nonce',
      (v: ReturnType<typeof fixture>) => (v.mutableNamespace.controllerNonce = '0'.repeat(64)),
    ],
    [
      'stale run id',
      (v: ReturnType<typeof fixture>) => (v.mutableNamespace.runId = '0'.repeat(64)),
    ],
    [
      'substituted executable',
      (v: ReturnType<typeof fixture>) =>
        (v.mutableIssuance.expectedOpenCodeExecutableSha256 = '0'.repeat(64)),
    ],
    [
      'mismatched bootstrap',
      (v: ReturnType<typeof fixture>) => (v.mutableIssuance.serializedProductBootstrap = '{}'),
    ],
    [
      'mismatched artifact',
      (v: ReturnType<typeof fixture>) =>
        ((v.mutableIssuance.predecessor as Record<string, unknown>).artifactDigest =
          `sha256:${'0'.repeat(64)}`),
    ],
    [
      'mismatched proof key',
      (v: ReturnType<typeof fixture>) =>
        ((
          (v.mutableIssuance.predecessor as Record<string, unknown>).bootstrapBinding as Record<
            string,
            unknown
          >
        ).proofKeyId = '0'.repeat(64)),
    ],
    [
      'substituted descriptor',
      (v: ReturnType<typeof fixture>) =>
        (((v.mutableIssuance.native as Record<string, unknown>).controllerDescriptor as string) =
          '{"fixture":"substituted"}'),
    ],
    [
      'substituted activation signer',
      (v: ReturnType<typeof fixture>) =>
        ((
          (v.mutableIssuance.native as Record<string, unknown>).activation as Record<
            string,
            unknown
          >
        ).contractDigest = '0'.repeat(64)),
    ],
  ] as const)('rejects %s before the selected composition can spawn', (_label, mutate) => {
    const [plan, input] = changed(mutate);
    expect(() => snapshotSelectedControllerInputs(plan, input)).toThrow(rejection);
  });

  it('rejects a substituted launcher signer', () => {
    const [plan, input] = changed((value) => {
      value.mutableIssuance.launcherKey = generateKeyPairSync('ed25519').privateKey;
    });
    expect(() => snapshotSelectedControllerInputs(plan, input)).toThrow(rejection);
  });

  it.each([
    [
      'missing observation authority',
      (v: ReturnType<typeof fixture>) =>
        ((v.mutableIssuance.native as Record<string, unknown>).observations = undefined),
    ],
    [
      'missing endpoint authority',
      (v: ReturnType<typeof fixture>) =>
        ((v.mutableIssuance.native as Record<string, unknown>).endpointObservations = {}),
    ],
    [
      'non-private launcher key',
      (v: ReturnType<typeof fixture>) =>
        (v.mutableIssuance.launcherKey = generateKeyPairSync('ed25519').publicKey),
    ],
    [
      'uncloneable namespace',
      (v: ReturnType<typeof fixture>) =>
        (v.mutableNamespace.productEnvironment = { VALUE: () => undefined }),
    ],
  ] as const)('fails closed for %s', (_label, mutate) => {
    const [plan, input] = changed(mutate);
    expect(() => snapshotSelectedControllerInputs(plan, input)).toThrow(rejection);
  });

  it('normalizes deep contract failures so private values cannot enter errors', () => {
    const { plan, input } = fixture();
    const secret = 'controller-private-signing-material';
    (input.namespace.productEnvironment as Record<string, string>).SECRET_FIXTURE = secret;
    let failure: unknown;
    try {
      authenticateSelectedControllerInputs(plan, input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(rejection);
    expect(String(failure)).not.toContain(secret);
  });

  it('preserves legacy authorization-before-sandbox-and-planning ordering', async () => {
    const events: string[] = [];
    const sandbox = {
      runId,
      handle: { close: vi.fn(async () => undefined) },
    };
    const admission = {
      roots: { sandboxParent: {} },
    };

    vi.resetModules();
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/contracts', () => ({
      parseRunArguments: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/driver', () => ({
      runDriver: vi.fn(async () => {
        events.push('prepare-and-drive');
        throw new Error('fixture_driver_failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/evidence', () => ({
      prepareEvidence: vi.fn(),
      retainFailureEvidence: vi.fn(async () => {
        events.push('retain-failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({
      readIntegrationDescriptor: vi.fn(async () => ({ controllerNonce: nonce })),
      admitIntegration: vi.fn(async () => admission),
      consumeOneRunAuthorization: vi.fn(async () => {
        events.push('consume');
        return {};
      }),
      closeAdmission: vi.fn(async () => {
        events.push('close-admission');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({
      createSandbox: vi.fn(async () => {
        events.push('create-sandbox');
        return sandbox;
      }),
      cleanupSandbox: vi.fn(async (_sandbox, remove) => {
        events.push(`cleanup-sandbox:${String(remove)}`);
        return { disposition: 'preserved' };
      }),
    }));

    const { run } = await import('../../../../scripts/e2e/hosted-actual-owner/run');
    await expect(run([])).rejects.toThrow('fixture_driver_failure');
    expect(events).toEqual([
      'consume',
      'create-sandbox',
      'prepare-and-drive',
      'cleanup-sandbox:false',
      'retain-failure',
      'close-admission',
    ]);
    expect(sandbox.handle.close).toHaveBeenCalledOnce();
  });

  it('does not consume one-run authorization when truthy input authentication fails', async () => {
    const { input } = fixture();
    const events: string[] = [];
    const sandbox = {
      runId,
      handle: { close: vi.fn(async () => undefined) },
    };
    const admission = {
      ownerLaunch: {},
      roots: { sandboxParent: {} },
    };
    const cleanupSandbox = vi.fn(async () => {
      events.push('cleanup-sandbox');
      return { disposition: 'removed' };
    });

    vi.resetModules();
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/contracts', () => ({
      parseRunArguments: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/driver', () => ({
      prepareDriverExecution: vi.fn((_admission, _sandbox, candidate) => {
        events.push('authenticate');
        expect(candidate).toBe(input);
        throw new Error(rejection);
      }),
      runDriver: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/evidence', () => ({
      prepareEvidence: vi.fn(),
      retainFailureEvidence: vi.fn(async () => {
        events.push('retain-failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({
      readIntegrationDescriptor: vi.fn(async () => ({ controllerNonce: nonce })),
      admitIntegration: vi.fn(async () => admission),
      consumeOneRunAuthorization: vi.fn(async () => {
        events.push('consume');
        return {};
      }),
      closeAdmission: vi.fn(async () => {
        events.push('close-admission');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({
      createSandbox: vi.fn(async () => {
        events.push('create-sandbox');
        return sandbox;
      }),
      cleanupSandbox,
    }));

    const { run } = await import('../../../../scripts/e2e/hosted-actual-owner/run');
    await expect(run([], input)).rejects.toThrow(rejection);
    expect(events).toEqual([
      'create-sandbox',
      'authenticate',
      'cleanup-sandbox',
      'retain-failure',
      'close-admission',
    ]);
    expect(cleanupSandbox).toHaveBeenCalledWith(sandbox, true);
    expect(sandbox.handle.close).not.toHaveBeenCalled();
  });

  it('consumes only after successful authentication and cleans up a later failure', async () => {
    const { input } = fixture();
    const events: string[] = [];
    const sandbox = {
      runId,
      handle: { close: vi.fn(async () => undefined) },
    };
    const admission = {
      ownerLaunch: {},
      roots: { sandboxParent: {} },
    };
    const prepared = Object.freeze({ selectedLaunch: {}, selectedInputs: input });
    const cleanupSandbox = vi.fn(async () => {
      events.push('cleanup-sandbox');
      return { disposition: 'preserved' };
    });

    vi.resetModules();
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/contracts', () => ({
      parseRunArguments: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/driver', () => ({
      prepareDriverExecution: vi.fn(() => {
        events.push('authenticate');
        return prepared;
      }),
      runDriver: vi.fn(async (_admission, _sandbox, _attempt, candidate) => {
        events.push('driver');
        expect(candidate).toBe(prepared);
        throw new Error('fixture_driver_failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/evidence', () => ({
      prepareEvidence: vi.fn(),
      retainFailureEvidence: vi.fn(async () => {
        events.push('retain-failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({
      readIntegrationDescriptor: vi.fn(async () => ({ controllerNonce: nonce })),
      admitIntegration: vi.fn(async () => admission),
      consumeOneRunAuthorization: vi.fn(async () => {
        events.push('consume');
        return {};
      }),
      closeAdmission: vi.fn(async () => {
        events.push('close-admission');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({
      createSandbox: vi.fn(async () => {
        events.push('create-sandbox');
        return sandbox;
      }),
      cleanupSandbox,
    }));

    const { run } = await import('../../../../scripts/e2e/hosted-actual-owner/run');
    await expect(run([], input)).rejects.toThrow('fixture_driver_failure');
    expect(events).toEqual([
      'create-sandbox',
      'authenticate',
      'consume',
      'driver',
      'cleanup-sandbox',
      'retain-failure',
      'close-admission',
    ]);
    expect(cleanupSandbox).toHaveBeenCalledWith(sandbox, false);
    expect(sandbox.handle.close).toHaveBeenCalledOnce();
  });

  it('preserves the sandbox when authorization consumption rejects after authentication', async () => {
    const { input } = fixture();
    const events: string[] = [];
    const sandbox = {
      runId,
      handle: { close: vi.fn(async () => undefined) },
    };
    const admission = {
      ownerLaunch: {},
      roots: { sandboxParent: {} },
    };
    const cleanupSandbox = vi.fn(async () => {
      events.push('cleanup-sandbox');
      return { disposition: 'preserved' };
    });

    vi.resetModules();
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/contracts', () => ({
      parseRunArguments: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/driver', () => ({
      prepareDriverExecution: vi.fn(() => {
        events.push('authenticate');
        return Object.freeze({ selectedLaunch: {}, selectedInputs: input });
      }),
      runDriver: vi.fn(),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/evidence', () => ({
      prepareEvidence: vi.fn(),
      retainFailureEvidence: vi.fn(async () => {
        events.push('retain-failure');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({
      readIntegrationDescriptor: vi.fn(async () => ({ controllerNonce: nonce })),
      admitIntegration: vi.fn(async () => admission),
      consumeOneRunAuthorization: vi.fn(async () => {
        events.push('consume');
        throw new Error('fixture_consume_failure');
      }),
      closeAdmission: vi.fn(async () => {
        events.push('close-admission');
      }),
    }));
    vi.doMock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({
      createSandbox: vi.fn(async () => {
        events.push('create-sandbox');
        return sandbox;
      }),
      cleanupSandbox,
    }));

    const { run } = await import('../../../../scripts/e2e/hosted-actual-owner/run');
    await expect(run([], input)).rejects.toThrow('fixture_consume_failure');
    expect(events).toEqual([
      'create-sandbox',
      'authenticate',
      'consume',
      'cleanup-sandbox',
      'retain-failure',
      'close-admission',
    ]);
    expect(cleanupSandbox).toHaveBeenCalledWith(sandbox, false);
    expect(sandbox.handle.close).toHaveBeenCalledOnce();
  });
});
