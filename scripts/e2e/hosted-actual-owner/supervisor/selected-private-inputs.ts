import { decodeProductActivationSigningReference, PRODUCT_ACTIVATION_ENV, type SelectedProductActivationSigningReference } from './selected-product-signing-reference';
import type { BootstrapCommon } from './bootstrap-v2';
import type { SelectedOpenCodeInputs } from './selected-opencode-runtime';
import type { SupervisorPlan } from '../processes';
import { canonicalJson, exactRecord, sha256 } from './canonical';

export const SELECTED_PRIVATE_INPUTS = 'agent-teams.hosted-selected-private-inputs/v1' as const;
/** Deployment data, never observations, callbacks, roots, signing keys or
 * prepared results. Product receives a typed activation file reference, never
 * signing bytes. The only key bytes transferred are the existing bootstrap HMAC
 * proof key required by the accepted private FD4/FD7 contracts. */
export interface SelectedPrivateInputs {
  readonly format: typeof SELECTED_PRIVATE_INPUTS;
  readonly controllerNonce: string;
  readonly runId: string;
  readonly openCode: Omit<SelectedOpenCodeInputs, 'preparationModule'>;
  readonly serializedProductBootstrap: string;
  readonly bootstrapProofKeyBase64: string;
  readonly launcherArtifactDigest: string;
  readonly generations: readonly { readonly common: BootstrapCommon; readonly launcherLeaseId: string }[];
  readonly productActivationSigning: SelectedProductActivationSigningReference;
  readonly productEnvironment: Readonly<Record<string, string>>;
  readonly browserEnvironment: Readonly<Record<string, string>>;
}
function check(value: unknown): asserts value { if (!value) throw new Error('selected_private_inputs_rejected'); }
function namespacePath(value: unknown, root: '/sandbox' | '/p3b2' | '/toolchain'): asserts value is string {
  check(typeof value === 'string' && value.startsWith(`${root}/`) && value.length <= 4096 &&
    !value.includes('\\') && !value.includes('\0') &&
    value.split('/').slice(1).every(part => part && part !== '.' && part !== '..'));
}
function environment(value: unknown): void {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const entries = Object.entries(value);
  check(entries.length <= 256);
  for (const [name, text] of entries) {
    check(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) && typeof text === 'string' &&
      Buffer.byteLength(text) <= 256 * 1024 && !text.includes('\0') &&
      !/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text));
    // A child may not select a new JS loader, preload, library, or launcher
    // signer through otherwise private deployment environment data.
    check(!['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BUN_OPTIONS'].includes(name) &&
      !/(?:LAUNCHER|ROOT|SIGNING|PRIVATE).*KEY/u.test(name) &&
      !Object.values(PRODUCT_ACTIVATION_ENV).some(reserved => reserved === name));
  }
}
export function decodeSelectedPrivateInputs(value: unknown, plan: SupervisorPlan): SelectedPrivateInputs {
  try {
    const row = exactRecord(value, ['format', 'controllerNonce', 'runId', 'openCode',
      'serializedProductBootstrap', 'bootstrapProofKeyBase64', 'launcherArtifactDigest',
      'generations', 'productActivationSigning', 'productEnvironment', 'browserEnvironment'], 'selected_private_inputs');
    check(row.format === SELECTED_PRIVATE_INPUTS && row.controllerNonce === plan.controllerNonce && row.runId === plan.runId);
    check(typeof row.serializedProductBootstrap === 'string' &&
      Buffer.byteLength(row.serializedProductBootstrap) <= 1024 * 1024 &&
      JSON.stringify(JSON.parse(row.serializedProductBootstrap)) === row.serializedProductBootstrap);
    check(typeof row.bootstrapProofKeyBase64 === 'string');
    const key = Buffer.from(row.bootstrapProofKeyBase64, 'base64');
    try {
      check(key.length === 32 && key.toString('base64') === row.bootstrapProofKeyBase64);
      check(Array.isArray(row.generations) && row.generations.length === 4);
      const sessions = new Set<string>(), leases = new Set<string>();
      let first: BootstrapCommon | undefined;
      for (const [index, candidate] of row.generations.entries()) {
        const generation = exactRecord(candidate, ['common', 'launcherLeaseId'], 'selected_private_generation');
        check(typeof generation.launcherLeaseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(generation.launcherLeaseId));
        exactRecord(generation.common, ['restoreGeneration', 'teamId', 'declaredRootHash', 'ownerAuthority',
          'ownerGeneration', 'ownerSessionId', 'claudeRoot', 'socketPath', 'legacyKey',
          'approvalActivationV2', 'bootstrapBinding'], 'selected_private_common');
        const common = generation.common as BootstrapCommon;
        exactRecord(common.bootstrapBinding, ['deploymentId', 'bootId', 'workspaceId', 'mountGeneration',
          'bootstrapDigest', 'ownerArtifactDigest', 'proofKeyId'], 'selected_private_bootstrap_binding');
        exactRecord(common.approvalActivationV2, ['approvalGeneration', 'admissionOwnerGeneration', 'approvalDigest',
          'admissionDocumentDigest', 'ownerArtifactDigest', 'wireCapabilityDigest', 'signedManifest'], 'selected_private_activation');
        exactRecord(common.approvalActivationV2.signedManifest, ['format', 'releasePinDigest', 'launcherKeyId'], 'selected_private_manifest');
        check(common && common.ownerGeneration === index + 1 && typeof common.ownerSessionId === 'string' &&
          /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(common.ownerSessionId));
        check(common.bootstrapBinding?.bootstrapDigest === sha256(row.serializedProductBootstrap) &&
          common.bootstrapBinding.proofKeyId === sha256(key) &&
          common.bootstrapBinding.ownerArtifactDigest === `sha256:${row.launcherArtifactDigest}`);
        if (first) check(canonicalJson(common.bootstrapBinding) === canonicalJson(first.bootstrapBinding) &&
          common.ownerAuthority === first.ownerAuthority && common.teamId === first.teamId &&
          common.declaredRootHash === first.declaredRootHash && common.claudeRoot === first.claudeRoot &&
          common.socketPath === first.socketPath && common.restoreGeneration === first.restoreGeneration);
        first ??= common; sessions.add(common.ownerSessionId); leases.add(generation.launcherLeaseId);
      }
      check(sessions.size === 4 && leases.size === 4);
    } finally { key.fill(0); }
    check(typeof row.launcherArtifactDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.launcherArtifactDigest));
    const openCode = exactRecord(row.openCode, ['stackManifestSha256', 'paths', 'sourceHomePath', 'sourceAuthPaths',
      'globalAuthPath', 'environment', 'appMcp', 'credentials', 'serverAuthId',
      ...(Object.hasOwn(row.openCode as object, 'modelOutputLimitOverrides') ? ['modelOutputLimitOverrides'] : [])], 'selected_private_opencode');
    const paths = exactRecord(openCode.paths, ['data', 'cache'], 'selected_private_paths');
    namespacePath(paths.data, '/sandbox'); namespacePath(paths.cache, '/sandbox');
    namespacePath(openCode.sourceHomePath, '/sandbox'); namespacePath(openCode.globalAuthPath, '/sandbox');
    check(Array.isArray(openCode.sourceAuthPaths) && openCode.sourceAuthPaths.length <= 32);
    for (const path of openCode.sourceAuthPaths) namespacePath(path, '/sandbox');
    check(new Set(openCode.sourceAuthPaths).size === openCode.sourceAuthPaths.length);
    const appMcp = exactRecord(openCode.appMcp, ['command', 'entry', 'moduleDirectory', 'repositoryRoot'], 'selected_private_app_mcp');
    namespacePath(appMcp.command, '/toolchain'); namespacePath(appMcp.entry, '/p3b2');
    if (appMcp.moduleDirectory !== '/p3b2') namespacePath(appMcp.moduleDirectory, '/p3b2');
    if (appMcp.repositoryRoot !== '/p3b2') namespacePath(appMcp.repositoryRoot, '/p3b2');
    check(plan.supervisorSourceInvocation &&
      appMcp.command === `/toolchain/${plan.supervisorSourceInvocation.executable.relativePath}`);
    const credentials = exactRecord(openCode.credentials, ['username', 'password'], 'selected_private_credentials');
    check(typeof credentials.username === 'string' && /^[^:\r\n\0]+$/u.test(credentials.username) &&
      Buffer.byteLength(credentials.username) <= 128 && typeof credentials.password === 'string' &&
      /^[^\r\n\0]+$/u.test(credentials.password) && Buffer.byteLength(credentials.password) <= 4096);
    check(typeof openCode.stackManifestSha256 === 'string' && /^[0-9a-f]{64}$/u.test(openCode.stackManifestSha256) &&
      typeof openCode.serverAuthId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(openCode.serverAuthId));
    if (openCode.modelOutputLimitOverrides !== undefined) {
      check(Array.isArray(openCode.modelOutputLimitOverrides) && openCode.modelOutputLimitOverrides.length <= 256);
      const models = new Set<string>();
      for (const option of openCode.modelOutputLimitOverrides) {
        const limit = exactRecord(option,
          ['modelId', 'outputTokens', ...(Object.hasOwn(option, 'contextTokens') ? ['contextTokens'] : [])], 'selected_private_model_limit');
        check(typeof limit.modelId === 'string' && limit.modelId.length > 0 && limit.modelId.length <= 512 &&
          !/[\u0000-\u001f\u007f]/u.test(limit.modelId) && !models.has(limit.modelId));
        check(typeof limit.outputTokens === 'number' && Number.isSafeInteger(limit.outputTokens) && limit.outputTokens > 0);
        if (limit.contextTokens !== undefined) check(typeof limit.contextTokens === 'number' &&
          Number.isSafeInteger(limit.contextTokens) && limit.contextTokens >= limit.outputTokens);
        models.add(limit.modelId);
      }
    }
    decodeProductActivationSigningReference(row.productActivationSigning);
    environment(openCode.environment); environment(row.productEnvironment); environment(row.browserEnvironment);
    check(Buffer.byteLength(canonicalJson(row)) <= 3 * 1024 * 1024);
    return structuredClone(row) as unknown as SelectedPrivateInputs;
  } catch { throw new Error('selected_private_inputs_rejected'); }
}
