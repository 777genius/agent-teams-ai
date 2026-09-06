import { createHmac } from 'node:crypto';

import { canonicalJson, exactRecord, sha256 } from './canonical';
import { descriptorMap, u32, type HeldOwner } from './native-protocol';

const BOOTSTRAP = 'agent-teams.hosted-control.bootstrap/v2';
const AUTH = 'agent-teams.hosted-control.opencode-server-auth/v1';
const LEASE = 'agent-teams.hosted-control.launcher-lease/v2';
const STATEMENT = 'agent-teams.hosted-control.bootstrap-statement/v2';
const HEX = /^[0-9a-f]{64}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

// Wire mirrors of H dd50 HostedControlBootstrap and W1 r840
// ExpectedSupervisedOpenCode. No cross-repository runtime imports or new Owner protocol.
export interface BootstrapCommon {
  restoreGeneration: number; teamId: string; declaredRootHash: string; ownerAuthority: string;
  ownerGeneration: number; ownerSessionId: string; claudeRoot: string; socketPath: string; legacyKey: string;
  approvalActivationV2: {
    approvalGeneration: number; admissionOwnerGeneration: number; approvalDigest: string;
    admissionDocumentDigest: string; ownerArtifactDigest: string; wireCapabilityDigest: string;
    // r866: ONLY manifestDigest is absent, until the actual socket exists and publication verifies.
    signedManifest: { format: 'agent-teams.hosted-lifecycle-owner-admission/v4'; releasePinDigest: string; launcherKeyId: string };
  };
  bootstrapBinding: { deploymentId: string; bootId: string; workspaceId: string; mountGeneration: number;
    bootstrapDigest: string; ownerArtifactDigest: string; proofKeyId: string };
}
export interface ExpectedSupervisedOpenCode {
  endpoint: { protocol: 'http:'; address: '127.0.0.1'; port: number; baseUrl: string };
  process: { pid: number; startTicks: string; startIdentity: `start_${string}`; supervisorProcessStartToken: string;
    pidNamespaceInode: string; networkNamespaceInode: string };
  executable: { device: string; inode: string; size: string; sha256: string; artifactManifestSha256: string; moduleSha256: string };
  profile: { projectPath: string; profileRootKey: string; profileRootPath: string; projectBehaviorFingerprint: string;
    managedConfigFingerprint: string; resolvedConfigFingerprint: string; sourceAuthFingerprint: string | null;
    managedAuthFingerprint: string | null; sourceAuthSources: readonly { path: string; fingerprint: string | null }[];
    toolApprovalMode: 'manual' };
  hosted: { schemaVersion: 2; protocol: 'agent-teams-hosted-approval-v2'; authentication: 'opencode-basic';
    runtimeInstanceId: string; configGeneration: string };
  activation: { controllerNonce: string; runId: string; stackManifestSha256: string; bootstrapDigest: string;
    admissionDocumentDigest: `sha256:${string}`; ownerArtifactDigest: `sha256:${string}`;
    ownerGeneration: number; ownerSessionId: string };
  serverAuthId: string;
}
export interface RawRetentionBinding {
  format: 'agent-teams.hosted-control.opencode-raw-retention/v1'; captureId: string;
  initialByteLength: number; initialSha256: string; nextSequence: number;
}
export interface SupervisorBinding {
  supervisorPid: number; supervisorStartTicks: string; supervisorStartToken: string;
  supervisorExecutableSha256: string; recipeSha256: string; ownerEntrySha256: string;
  ownerPid: number; ownerStartTicks: string; ownerProcessStartToken: string;
  harnessContractSha256: string; ownerProducerCapsuleSha256: string;
}
export interface BootstrapFrames {
  readonly leaseBytes: Buffer;
  readonly bootstrapFrame: Buffer;
  readonly authFrame: Buffer;
}
export interface AssembledBootstrap extends BootstrapFrames {
  readonly digests: Readonly<{ bootstrapDigest: string; bootstrapV2HeaderSha256: string;
    leaseArtifactSha256: string; launcherArtifactDigest: string; expectedHostSha256: string;
    descriptorMapSha256: string; bootstrapStatementSha256: string }>;
}
export interface AssembleBootstrapInput {
  readonly held: HeldOwner;
  readonly common: BootstrapCommon;
  readonly expectedHost: ExpectedSupervisedOpenCode;
  readonly supervisorBinding: SupervisorBinding;
  readonly rawRetention: RawRetentionBinding;
  readonly launcherLeaseId: string;
  readonly launcherArtifactDigest: string;
  /** Exact serialized Product document, NOT the v2 header or a reserialization. */
  readonly serializedProductBootstrap: Uint8Array;
  readonly key: Uint8Array;
  readonly credentials: Readonly<{ username: string; password: string }>;
}
function check(value: unknown, label: string): asserts value {
  if (!value) throw new TypeError(`owner_bootstrap_${label}`);
}
function keys(value: unknown, names: string): Record<string, unknown> {
  return exactRecord(value, names.split(','), 'owner_bootstrap');
}
function text(value: unknown, pattern: RegExp): asserts value is string {
  check(typeof value === 'string' && pattern.test(value), 'string');
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): void {
  check(Number.isSafeInteger(value) && !Object.is(value, -0) && Number(value) >= min && Number(value) <= max, 'integer');
}
function decimal(value: unknown): void {
  text(value, /^(?:0|[1-9][0-9]{0,19})$/u); check(BigInt(value) <= 0xffffffffffffffffn, 'decimal');
}
function path(value: unknown, max = 4096): void {
  text(value, /^\//u);
  check(Buffer.byteLength(value) <= max && !value.includes('\0') && !value.includes('//') &&
    !value.split('/').some(s => s === '.' || s === '..'), 'path');
}
function wellFormed(value: unknown, depth = 0): void {
  check(depth < 32, 'depth');
  if (typeof value === 'string') check(Buffer.from(value).toString('utf8') === value, 'unicode');
  if (typeof value === 'number') integer(value, 0);
  if (Array.isArray(value)) for (const v of value) wellFormed(v, depth + 1);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    wellFormed(k, depth + 1); wellFormed(v, depth + 1);
  }
}
export function canonicalBytes(value: unknown, max: number): Buffer {
  wellFormed(value);
  const b = Buffer.from(canonicalJson(value));
  check(b.length >= 2 && b.length <= max, 'byte_limit'); return b;
}
function validateCommon(c: BootstrapCommon): void {
  keys(c, 'restoreGeneration,teamId,declaredRootHash,ownerAuthority,ownerGeneration,ownerSessionId,claudeRoot,socketPath,legacyKey,approvalActivationV2,bootstrapBinding');
  integer(c.restoreGeneration, 0); integer(c.ownerGeneration);
  text(c.teamId, /^team_[0-9a-f]{32}$/u); text(c.declaredRootHash, HEX);
  text(c.ownerAuthority, /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u);
  text(c.ownerSessionId, /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u);
  text(c.legacyKey, /^[A-Za-z0-9_-]{1,128}$/u);
  path(c.claudeRoot); path(c.socketPath, 103); check(c.claudeRoot !== c.socketPath, 'paths_distinct');
  const b = c.bootstrapBinding;
  keys(b, 'deploymentId,bootId,workspaceId,mountGeneration,bootstrapDigest,ownerArtifactDigest,proofKeyId');
  for (const v of [b.deploymentId, b.bootId, b.workspaceId]) text(v, ID);
  integer(b.mountGeneration); text(b.bootstrapDigest, HEX); text(b.ownerArtifactDigest, SHA); text(b.proofKeyId, HEX);
  const a = c.approvalActivationV2;
  keys(a, 'approvalGeneration,admissionOwnerGeneration,approvalDigest,admissionDocumentDigest,ownerArtifactDigest,wireCapabilityDigest,signedManifest');
  integer(a.approvalGeneration); integer(a.admissionOwnerGeneration);
  for (const v of [a.approvalDigest, a.admissionDocumentDigest, a.ownerArtifactDigest, a.wireCapabilityDigest]) text(v, SHA);
  keys(a.signedManifest, 'format,releasePinDigest,launcherKeyId');
  check(a.signedManifest.format === 'agent-teams.hosted-lifecycle-owner-admission/v4', 'manifest_format');
  text(a.signedManifest.releasePinDigest, SHA); text(a.signedManifest.launcherKeyId, HEX);
  check(a.ownerArtifactDigest === b.ownerArtifactDigest, 'artifact_binding');
}
function validateExpected(e: ExpectedSupervisedOpenCode, held: HeldOwner, c: BootstrapCommon): void {
  keys(e, 'endpoint,process,executable,profile,hosted,activation,serverAuthId');
  keys(e.endpoint, 'protocol,address,port,baseUrl'); integer(e.endpoint.port, 1, 65535);
  check(e.endpoint.protocol === 'http:' && e.endpoint.address === '127.0.0.1' && e.endpoint.port === 4096 &&
    e.endpoint.baseUrl === `http://127.0.0.1:${e.endpoint.port}`, 'endpoint');
  const p = e.process;
  keys(p, 'pid,startTicks,startIdentity,supervisorProcessStartToken,pidNamespaceInode,networkNamespaceInode');
  integer(p.pid, 2, 0x7fffffff); decimal(p.startTicks); integer(Number(p.startTicks));
  text(p.supervisorProcessStartToken, HEX); decimal(p.pidNamespaceInode); decimal(p.networkNamespaceInode);
  check(p.startIdentity === `start_${sha256(`${p.pid}\0proc:${p.startTicks}`)}` && p.pid !== held.ownerPid &&
    p.pidNamespaceInode === held.ownerPidNamespaceInode && p.networkNamespaceInode === held.ownerNetworkNamespaceInode, 'host_process');
  keys(e.executable, 'device,inode,size,sha256,artifactManifestSha256,moduleSha256');
  for (const v of [e.executable.device, e.executable.inode, e.executable.size]) decimal(v);
  for (const v of [e.executable.sha256, e.executable.artifactManifestSha256, e.executable.moduleSha256]) text(v, HEX);
  const f = e.profile;
  keys(f, 'projectPath,profileRootKey,profileRootPath,projectBehaviorFingerprint,managedConfigFingerprint,resolvedConfigFingerprint,sourceAuthFingerprint,managedAuthFingerprint,sourceAuthSources,toolApprovalMode');
  path(f.projectPath); path(f.profileRootPath); text(f.profileRootKey, ID);
  for (const v of [f.projectBehaviorFingerprint, f.managedConfigFingerprint, f.resolvedConfigFingerprint]) text(v, HEX);
  for (const v of [f.sourceAuthFingerprint, f.managedAuthFingerprint]) if (v !== null) text(v, HEX);
  check(f.toolApprovalMode === 'manual' && Array.isArray(f.sourceAuthSources) && f.sourceAuthSources.length <= 32, 'profile');
  for (const v of f.sourceAuthSources) { keys(v, 'path,fingerprint'); path(v.path); if (v.fingerprint !== null) text(v.fingerprint, HEX); }
  check(new Set(f.sourceAuthSources.map(v => v.path)).size === f.sourceAuthSources.length, 'auth_sources');
  keys(e.hosted, 'schemaVersion,protocol,authentication,runtimeInstanceId,configGeneration');
  check(e.hosted.schemaVersion === 2 && e.hosted.protocol === 'agent-teams-hosted-approval-v2' &&
    e.hosted.authentication === 'opencode-basic', 'hosted');
  text(e.hosted.runtimeInstanceId, /^runtime_instance_[0-9a-f]{32}$/u);
  text(e.hosted.configGeneration, /^config_generation_[0-9a-f]{32}$/u);
  const a = e.activation;
  keys(a, 'controllerNonce,runId,stackManifestSha256,bootstrapDigest,admissionDocumentDigest,ownerArtifactDigest,ownerGeneration,ownerSessionId');
  for (const v of [a.controllerNonce, a.runId, a.stackManifestSha256, a.bootstrapDigest]) text(v, HEX);
  text(a.admissionDocumentDigest, SHA); text(a.ownerArtifactDigest, SHA); text(e.serverAuthId, ID);
  check(a.bootstrapDigest === c.bootstrapBinding.bootstrapDigest && a.ownerArtifactDigest === c.bootstrapBinding.ownerArtifactDigest &&
    a.admissionDocumentDigest === c.approvalActivationV2.admissionDocumentDigest &&
    a.ownerGeneration === c.ownerGeneration && a.ownerSessionId === c.ownerSessionId, 'activation_binding');
}
function mac(key: Buffer, domain: string, body: Buffer): Buffer {
  return createHmac('sha256', key).update(domain).update('\0').update(body).digest();
}

/** Producer only: this constructs bytes inside admitted supervisor composition. It grants no custody. */
export function assembleOwnerBootstrap(input: AssembleBootstrapInput): AssembledBootstrap {
  const { held, common, expectedHost, supervisorBinding: s, rawRetention: raw } = input;
  validateCommon(common); validateExpected(expectedHost, held, common);
  keys(s, 'supervisorPid,supervisorStartTicks,supervisorStartToken,supervisorExecutableSha256,recipeSha256,ownerEntrySha256,ownerPid,ownerStartTicks,ownerProcessStartToken,harnessContractSha256,ownerProducerCapsuleSha256');
  for (const v of [s.supervisorStartToken, s.supervisorExecutableSha256, s.recipeSha256, s.ownerEntrySha256,
    s.ownerProcessStartToken, s.harnessContractSha256, s.ownerProducerCapsuleSha256]) text(v, HEX);
  check(s.supervisorPid === held.callerPid && s.supervisorStartTicks === held.callerStartTicks &&
    s.ownerPid === held.ownerPid && s.ownerStartTicks === held.ownerStartTicks, 'observed_start');
  keys(raw, 'format,captureId,initialByteLength,initialSha256,nextSequence');
  check(raw.format === 'agent-teams.hosted-control.opencode-raw-retention/v1', 'raw_format');
  text(raw.captureId, HEX); text(raw.initialSha256, HEX); integer(raw.initialByteLength, 0, 64 * 1024 * 1024); integer(raw.nextSequence);
  check(String(raw.initialByteLength) === held.descriptors[5].size && (raw.initialByteLength !== 0 ||
    (raw.initialSha256 === sha256(Buffer.alloc(0)) && raw.nextSequence === 1)), 'raw_prefix');
  text(input.launcherLeaseId, ID); text(input.launcherArtifactDigest, HEX);
  check(common.bootstrapBinding.ownerArtifactDigest === `sha256:${input.launcherArtifactDigest}`, 'launcher_artifact');
  const product = Buffer.from(input.serializedProductBootstrap);
  check(product.length > 0 && product.length <= 1024 * 1024 &&
    sha256(product) === common.bootstrapBinding.bootstrapDigest, 'product_bootstrap_digest');
  const productText = new TextDecoder('utf-8', { fatal: true }).decode(product);
  check(Buffer.from(productText).equals(product) && JSON.stringify(JSON.parse(productText)) === productText, 'product_bootstrap_serialization');
  const leaseFd = held.descriptors[0];
  check(leaseFd.accessMode === 'read-only' && leaseFd.seals === 0 && leaseFd.size === '0' && leaseFd.mode === 0o600, 'lease_construction');
  const map = descriptorMap(held);
  const expectedHostSha256 = sha256(canonicalBytes(expectedHost, 32768));
  const descriptorMapSha256 = sha256(canonicalBytes(map, 8192));
  keys(input.credentials, 'username,password');
  const { username, password } = input.credentials;
  text(username, /^[^:\r\n\0]+$/u); text(password, /^[^\r\n\0]+$/u);
  check(Buffer.byteLength(username) <= 128 && Buffer.byteLength(password) <= 4096, 'credentials_length');
  const key = Buffer.from(input.key);
  let authDocument: Buffer | undefined, authFrame: Buffer | undefined, bootstrapFrame: Buffer | undefined;
  let header: Buffer | undefined, authenticated: Buffer | undefined;
  try {
    check(key.length === 32 && sha256(key) === common.bootstrapBinding.proofKeyId, 'proof_key');
    authDocument = canonicalBytes({ format: AUTH, bootstrapDigest: common.bootstrapBinding.bootstrapDigest,
      spawnNonce: held.spawnNonce, expectedHostSha256, descriptorMapSha256, serverAuthId: expectedHost.serverAuthId,
      username, password }, 8192);
    authFrame = Buffer.concat([u32(authDocument.length), authDocument]);
    const h0 = { ...common, format: BOOTSTRAP, expectedHost, supervisorBinding: s, descriptorMap: map, rawRetention: raw,
      leaseEvidence: { device: leaseFd.device, inode: leaseFd.inode, uid: leaseFd.uid, gid: leaseFd.gid, mode: leaseFd.mode,
        launcherLeaseId: input.launcherLeaseId, launcherArtifactDigest: input.launcherArtifactDigest },
      serverAuthBinding: { format: AUTH, serverAuthId: expectedHost.serverAuthId, expectedHostSha256, descriptorMapSha256,
        authHmacSha256: mac(key, AUTH, authFrame).toString('hex') } };
    const bootstrapStatementSha256 = sha256(Buffer.concat([Buffer.from(`${STATEMENT}\0`), canonicalBytes(h0, 65536)]));
    const leaseBytes = canonicalBytes({ format: LEASE, launcherLeaseId: input.launcherLeaseId, bootstrapStatementSha256 }, 65536);
    const leaseArtifactSha256 = sha256(leaseBytes);
    header = canonicalBytes({ ...h0, leaseEvidence: { ...h0.leaseEvidence, leaseArtifactSha256 } }, 65536);
    authenticated = Buffer.concat([u32(header.length), header]);
    bootstrapFrame = Buffer.concat([authenticated, key, mac(key, BOOTSTRAP, authenticated)]);
    return Object.freeze({ leaseBytes, authFrame, bootstrapFrame, digests: Object.freeze({
      bootstrapDigest: common.bootstrapBinding.bootstrapDigest, bootstrapV2HeaderSha256: sha256(header), leaseArtifactSha256,
      launcherArtifactDigest: input.launcherArtifactDigest, expectedHostSha256, descriptorMapSha256, bootstrapStatementSha256 }) });
  } catch (error) {
    authFrame?.fill(0); bootstrapFrame?.fill(0); throw error;
  } finally { key.fill(0); authDocument?.fill(0); header?.fill(0); authenticated?.fill(0); }
}
