import { assertProductActivationSigningBinding, productActivationSigningEnvironment, PRODUCT_ACTIVATION_ENV } from './selected-product-signing-reference';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupervisorPlan } from '../processes';
import { sha256 } from './canonical';
import { decodeSelectedPrivateInputs, SELECTED_PRIVATE_INPUTS, type SelectedPrivateInputs } from './selected-private-inputs';

// Decoder fixtures only: no signed admission, process receipt, credentials or
// prepared profile are obtained from these values.
function fixture() {
  const hex = '1'.repeat(64), artifact = '2'.repeat(64), bootstrap = '{"fixture":true}';
  const key = Buffer.alloc(32, 3);
  const plan = { controllerNonce: hex, runId: artifact,
    supervisorSourceInvocation: { executable: { relativePath: 'node' } } } as SupervisorPlan;
  const input: SelectedPrivateInputs = {
    format: SELECTED_PRIVATE_INPUTS, controllerNonce: hex, runId: artifact,
    serializedProductBootstrap: bootstrap, bootstrapProofKeyBase64: key.toString('base64'),
    launcherArtifactDigest: artifact,
    generations: [1, 2, 3, 4].map(generation => ({ launcherLeaseId: `lease-${generation}`, common: {
      restoreGeneration: 0, teamId: `team_${'a'.repeat(32)}`, declaredRootHash: hex,
      ownerAuthority: 'owner-authority_test0001', ownerGeneration: generation,
      ownerSessionId: `owner-session_test000${generation}`, claudeRoot: '/sandbox/claude',
      socketPath: '/sandbox/owner.sock', legacyKey: 'fixture',
      bootstrapBinding: { deploymentId: 'fixture', bootId: 'fixture', workspaceId: 'fixture',
        mountGeneration: 1, bootstrapDigest: sha256(bootstrap), ownerArtifactDigest: `sha256:${artifact}`,
        proofKeyId: sha256(key) },
      approvalActivationV2: { approvalGeneration: generation, admissionOwnerGeneration: generation,
        approvalDigest: `sha256:${hex}`, admissionDocumentDigest: `sha256:${hex}`,
        ownerArtifactDigest: `sha256:${artifact}`, wireCapabilityDigest: `sha256:${hex}`,
        signedManifest: { format: 'agent-teams.hosted-lifecycle-owner-admission/v4',
          releasePinDigest: `sha256:${hex}`, launcherKeyId: hex } },
    } })),
    openCode: { stackManifestSha256: hex, paths: { data: '/sandbox/data', cache: '/sandbox/cache' },
      sourceHomePath: '/sandbox/home', sourceAuthPaths: ['/sandbox/home/auth.json'],
      globalAuthPath: '/sandbox/global/auth.json', environment: {},
      appMcp: { command: '/toolchain/node', entry: '/p3b2/app-mcp.cjs',
        moduleDirectory: '/p3b2', repositoryRoot: '/p3b2' },
      credentials: { username: 'fixture', password: 'benign-fixture-only' }, serverAuthId: 'fixture',
      modelOutputLimitOverrides: [{ modelId: 'provider/model', outputTokens: 1024, contextTokens: 4096 }] },
    productActivationSigning: { kind: 'product-activation-signing-key-file/v1',
      keyFile: '/sandbox/product-activation/selected.pem', contractDigest: 'c'.repeat(64),
      publicKeySpkiDerBase64url: Buffer.from('302a300506032b6570032100' +
        'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url') },
    productEnvironment: {}, browserEnvironment: {},
  };
  return { input, plan };
}

test('private deployment decoder copies bounded inputs for all four generations', () => {
  const { input, plan } = fixture();
  const decoded = decodeSelectedPrivateInputs(input, plan);
  assert.deepEqual(decoded, input);
  assert.notEqual(decoded.openCode, input.openCode);
});

test('private deployment decoder rejects path, command and credential substitutions without disclosure', () => {
  const changes: ((input: ReturnType<typeof fixture>['input']) => unknown)[] = [
    input => ({ ...input, openCode: { ...input.openCode, sourceHomePath: '/sandbox/../secret-sentinel' } }),
    input => ({ ...input, openCode: { ...input.openCode, sourceAuthPaths: ['/sandbox/a', '/sandbox/a'] } }),
    input => ({ ...input, openCode: { ...input.openCode, appMcp: { ...input.openCode.appMcp, command: '/toolchain/other' } } }),
    input => ({ ...input, openCode: { ...input.openCode, appMcp: { ...input.openCode.appMcp, entry: '/p3b2//other' } } }),
    input => ({ ...input, openCode: { ...input.openCode, credentials: { username: 'bad:name', password: 'secret-sentinel' } } }),
    input => ({ ...input, productEnvironment: { NODE_OPTIONS: '--require=secret-sentinel' } }),
  ];
  for (const change of changes) {
    const { input, plan } = fixture();
    assert.throws(() => decodeSelectedPrivateInputs(change(input), plan),
      { message: 'selected_private_inputs_rejected' });
  }
});

test('private deployment decoder rejects malformed and duplicate model budgets', () => {
  for (const limits of [
    [{ modelId: 'provider/model', outputTokens: 0 }],
    [{ modelId: 'provider/model', outputTokens: 1.5 }],
    [{ modelId: 'provider/model', outputTokens: 10, contextTokens: 9 }],
    [{ modelId: 'provider/model', outputTokens: 10 }, { modelId: 'provider/model', outputTokens: 20 }],
    [{ modelId: 'secret\0sentinel', outputTokens: 10 }],
  ]) {
    const { input, plan } = fixture();
    assert.throws(() => decodeSelectedPrivateInputs({ ...input,
      openCode: { ...input.openCode, modelOutputLimitOverrides: limits } }, plan),
    { message: 'selected_private_inputs_rejected' });
  }
});

test('typed Product activation reference reaches production configuration and binds root selection', () => {
  const { input, plan } = fixture();
  const reference = decodeSelectedPrivateInputs(input, plan).productActivationSigning;
  const activation = { publicKeySpkiDerBase64url: reference.publicKeySpkiDerBase64url, contractDigest: reference.contractDigest };
  assert.doesNotThrow(() => assertProductActivationSigningBinding(reference, activation));
  const environment = productActivationSigningEnvironment(reference);
  assert.equal(environment[PRODUCT_ACTIVATION_ENV.key], reference.keyFile);
  assert.equal(environment[PRODUCT_ACTIVATION_ENV.publicDigest], `sha256:${sha256(Buffer.from(reference.publicKeySpkiDerBase64url, 'base64url'))}`);
  assert.equal(environment[PRODUCT_ACTIVATION_ENV.contract], `sha256:${reference.contractDigest}`);
  assert.throws(() => assertProductActivationSigningBinding(reference, { ...activation, contractDigest: 'd'.repeat(64) }));
  assert.throws(() => assertProductActivationSigningBinding(reference, { ...activation, publicKeySpkiDerBase64url: 'different' }));
  for (const name of [...Object.values(PRODUCT_ACTIVATION_ENV), 'ROOT_SIGNING_KEY', 'LAUNCHER_PRIVATE_KEY']) {
    for (const field of ['productEnvironment', 'browserEnvironment'] as const) {
      assert.throws(() => decodeSelectedPrivateInputs({ ...input, [field]: { [name]: reference.keyFile } }, plan));
    }
  }
  for (const keyFile of ['/root/launcher.pem', '/sandbox/product-activation/../launcher.pem', '/sandbox/product-activation//key.pem']) {
    assert.throws(() => decodeSelectedPrivateInputs({ ...input, productActivationSigning: { ...reference, keyFile } }, plan));
  }
  assert.throws(() => decodeSelectedPrivateInputs({ ...input, productActivationSigning: undefined }, plan));
});
