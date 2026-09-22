// @vitest-environment node
import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  promises as fs,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceTrustCoordinator } from '../../../../src/features/workspace-trust/main';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { bindProjectDirectoryLease } from '../../../../src/main/services/team/provisioning/TeamProvisioningProjectDirectoryLease';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { withFileLock } from '../../../../src/main/services/team/fileLock';
import { OpenCodeBridgeCommandClient } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { VersionedJsonStore } from '../../../../src/main/services/team/opencode/store/VersionedJsonStore';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import {
  createOpenCodeLiveHarness,
  readInboxMessages,
  waitForOpenCodeLanesStopped,
  waitUntil,
} from './openCodeLiveTestHarness';

import type {
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamMember,
  TeamProviderId,
  TeamProvisioningProgress,
} from '../../../../src/shared/types';

vi.mock('../../../../src/main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: vi.fn(async () => undefined),
    }),
  },
}));

interface LinuxProcessIdentity {
  pid: number;
  parentPid: number;
  processGroup: number;
  startTicks: string;
}

interface LiveStressAuthorization {
  ok: boolean;
  reason: string;
  auth?: CapturedAuthContext;
  project?: DisposableProjectIdentity;
  cgroup?: CgroupLaunchReceipt;
  accounting?: PinnedAccountingLedger;
  issuer?: CapabilityIssuer;
  wrapperTrustAnchor?: string;
}

interface CapturedAuthContext {
  home: string;
  userProfile: string;
  claudeConfigDir: string;
  codexHome: string;
  anthropicAuth: string;
  xdgDataHome: string;
  xdgConfigHome: string;
  googleApplicationCredentials: string;
}

interface DisposableProjectIdentity {
  root: string;
  projectPath: string;
  token: string;
  invocationId: string;
  rootDev: string;
  rootIno: string;
  projectDev: string;
  projectIno: string;
  markerDev: string;
  markerIno: string;
}

interface CapabilityPayload {
  version: 1;
  token: string;
  /** Wrapper-held issuer signs this opaque immutable process anchor. */
  wrapperIdentity: string;
  /** Per-wrapper capability signed by the wrapper issuer, never an env knob. */
  wrapperTrustAnchor: string;
  /** Hash of the exact parent wrapper release script, checked out-of-band. */
  wrapperScriptSha256: string;
  /** Wrapper-owned proc descriptor identity, verified by the isolated attestor. */
  launcher: {
    pid: number;
    startTicks: string;
    procDev: string;
    procIno: string;
  };
  /** Fresh proof from the separately trusted launcher private capability. */
  trustedLauncherAdmission: TrustedLauncherAdmission;
  /** The wrapper-local issuer carried with the signed runtime capability. */
  issuer: CapabilityIssuer;
  /** The isolated attestor selected by the independently trusted launcher. */
  attestor: CapabilityAttestor;
  auth: CapturedAuthContext;
  cgroup: CgroupLaunchReceipt;
  project: DisposableProjectIdentity;
  accounting: AccountingCollectorCapability;
}

interface SignedCapabilityEnvelope {
  version: 2;
  issuerId: string;
  payload: string;
  signature: string;
}

interface TrustedLauncherAdmission {
  payload: string;
  signature: string;
}

interface CapabilityIssuer {
  version: 1;
  id: string;
  publicKey: string;
}

interface CapabilityAttestor {
  id: string;
  publicKey: string;
  endpoint: string;
}

interface AccountingCollectorCapability {
  collectorId: string;
  endpoint: string;
  publicKey: string;
  ledger: { dev: string; ino: string };
  provenance: { dev: string; ino: string; sha256: string };
  issuer: { id: string; publicKey: string };
  producer: { id: string; publicKey: string };
}

interface PinnedAccountingLedger {
  endpoint: string;
  publicKey: string;
  collectorId: string;
  dev: string;
  ino: string;
  provenanceDev: string;
  provenanceIno: string;
  provenanceSha256: string;
  issuerId: string;
  issuerPublicKey: string;
}

/** Kernel ownership boundary created by the release wrapper before Vitest. */
interface CgroupLaunchReceipt {
  mountPath: string;
  relativePath: string;
  dev: string;
  ino: string;
}

const isLiveStressAuthorized = () => getLiveStressAuthorization().ok;
// Fixed wrapper ABI.  Environment values must never nominate the endpoint,
// key, or descriptor used to establish the canary trust root.
const CAPABILITY_ATTESTATION_BOOTSTRAP_FD = 3;
const PROJECT_DIRECTORY_CAPABILITY_FD = 4;
// The worker verifies a new statement from the private launcher capability,
// never a static release signature or caller-controlled public key.
const TRUSTED_LAUNCHER_CAPABILITY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+THE0SAcPPSjg7aEY0mYMY/bEbzULrxKpP00J76iu78=
-----END PUBLIC KEY-----
`;
const TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN =
  'agent-teams.provider-launch-stress.runtime-capability-admission/v1';
function getLiveStressAuthorization(
  platform: NodeJS.Platform = process.platform,
  requestAttestation: () => ReturnType<typeof requestCapabilityAttestation> =
    requestCapabilityAttestation
): LiveStressAuthorization {
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE !== '1') {
    return { ok: false, reason: 'live canary was not requested' };
  }
  if (platform !== 'linux') {
    return { ok: false, reason: `live canary is unsupported on ${platform}` };
  }
  try {
    const attestation = requestAttestation();
    if (!attestation) {
      return { ok: false, reason: 'wrapper capability attestation is unavailable' };
    }
    const issuer = JSON.parse(Buffer.from(attestation.issuer, 'base64').toString('utf8')) as CapabilityIssuer;
    if (
      issuer.version !== 1 ||
      typeof issuer.publicKey !== 'string' ||
      !issuer.publicKey.includes('BEGIN PUBLIC KEY') ||
      issuer.id !== createHash('sha256').update(issuer.publicKey).digest('hex')
    ) {
      return { ok: false, reason: 'wrapper capability issuer is malformed' };
    }
    const signed = JSON.parse(Buffer.from(attestation.capability, 'base64').toString('utf8')) as SignedCapabilityEnvelope;
    if (
      signed.version !== 2 ||
      signed.issuerId !== issuer.id ||
      typeof signed.payload !== 'string' ||
      typeof signed.signature !== 'string' ||
      !verify(null, Buffer.from(signed.payload), issuer.publicKey, Buffer.from(signed.signature, 'base64'))
    ) {
      return { ok: false, reason: 'wrapper capability was not issued by its pinned signer' };
    }
    const envelope = JSON.parse(signed.payload) as CapabilityPayload;
    if (
      envelope.version !== 1 ||
      typeof envelope.token !== 'string' ||
      envelope.token.length < 32 ||
      typeof envelope.wrapperIdentity !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(envelope.wrapperIdentity) ||
      typeof envelope.wrapperTrustAnchor !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(envelope.wrapperTrustAnchor) ||
      typeof envelope.wrapperScriptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(envelope.wrapperScriptSha256) ||
      !isLauncherCapability(envelope.launcher) ||
      !isCapabilityIssuer(envelope.issuer) ||
      envelope.issuer.id !== issuer.id ||
      envelope.issuer.publicKey !== issuer.publicKey ||
      !isCapabilityAttestor(envelope.attestor) ||
      !isTrustedLauncherAdmission(envelope.trustedLauncherAdmission, envelope) ||
      !isCapturedAuthContext(envelope.auth) ||
      !isCgroupLaunchReceipt(envelope.cgroup) ||
      !isDisposableProjectIdentity(envelope.project) ||
      !isAccountingCollectorCapability(envelope.accounting)
    ) {
      return { ok: false, reason: 'wrapper capability payload is malformed' };
    }
    if (!isCurrentProcessInLaunchCgroup(envelope.cgroup)) {
      return { ok: false, reason: 'worker is outside the wrapper launch cgroup' };
    }
    if (!isBoundProjectDirectoryLease(envelope.project)) {
      return { ok: false, reason: 'wrapper project directory lease is unavailable or changed' };
    }
    // The sealed bootstrap only locates the attestor. Authorization comes
    // from the per-run private launcher capability inside the attested
    // envelope; a forged bootstrap/attestor can choose its own key but cannot
    // forge that separate signature.
    if (
      attestation.wrapperIdentity !== envelope.wrapperIdentity ||
      attestation.wrapperTrustAnchor !== envelope.wrapperTrustAnchor ||
      attestation.wrapperScriptSha256 !== envelope.wrapperScriptSha256 ||
      attestation.wrapperPid !== envelope.launcher.pid ||
      attestation.wrapperStartTicks !== envelope.launcher.startTicks ||
      attestation.attestor.id !== envelope.attestor.id ||
      attestation.attestor.publicKey !== envelope.attestor.publicKey ||
      attestation.attestor.endpoint !== envelope.attestor.endpoint ||
      attestation.cgroup.mountPath !== envelope.cgroup.mountPath ||
      attestation.cgroup.relativePath !== envelope.cgroup.relativePath ||
      attestation.cgroup.dev !== envelope.cgroup.dev ||
      attestation.cgroup.ino !== envelope.cgroup.ino
    ) {
      return { ok: false, reason: 'attestation does not bind the authorized wrapper and cgroup' };
    }
    const accounting = bindPinnedAccountingLedger(envelope.accounting);
    return {
      ok: true,
      reason: 'authorized by wrapper-controlled attestation channel',
      auth: envelope.auth,
      project: envelope.project,
      cgroup: envelope.cgroup,
      accounting,
      issuer,
      wrapperTrustAnchor: envelope.wrapperTrustAnchor,
    };
  } catch {
    return { ok: false, reason: 'wrapper attestation evidence is unavailable' };
  }
}

function requestCapabilityAttestation(): {
  wrapperIdentity: string;
  wrapperTrustAnchor: string;
  wrapperScriptSha256: string;
  wrapperPid: number;
  wrapperStartTicks: string;
  cgroup: CgroupLaunchReceipt;
  attestor: CapabilityAttestor;
  capability: string;
  issuer: string;
} | null {
  const bootstrap = readCapabilityAttestationBootstrap();
  if (!bootstrap) return null;
  const { endpoint, publicKey, id } = bootstrap;
  const nonce = randomBytes(32).toString('hex');
  const client = [
    "const net=require('node:net');",
    "const socket=net.createConnection(process.env.ATTESTOR_ENDPOINT);",
    "let data=''; socket.setEncoding('utf8'); socket.setTimeout(5000);",
    "socket.once('connect',()=>socket.write('attest '+process.env.ATTESTOR_NONCE+'\\n'));",
    "socket.on('data',(chunk)=>{data+=chunk;const i=data.indexOf('\\n');if(i>=0){process.stdout.write(data.slice(0,i));socket.end();}});",
    "socket.once('timeout',()=>process.exit(2)); socket.once('error',()=>process.exit(3));",
  ].join('');
  const result = spawnSync(process.execPath, ['-e', client], {
    encoding: 'utf8',
    timeout: 6_000,
    env: { ATTESTOR_ENDPOINT: endpoint, ATTESTOR_NONCE: nonce },
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    const response = JSON.parse(result.stdout) as { payload?: unknown; signature?: unknown };
    if (typeof response.payload !== 'string' || typeof response.signature !== 'string') return null;
    if (!verify(null, Buffer.from(response.payload), publicKey, Buffer.from(response.signature, 'base64'))) {
      return null;
    }
    const payload = JSON.parse(response.payload) as Record<string, unknown>;
    if (
      payload.version !== 1 ||
      payload.id !== id ||
      payload.nonce !== nonce ||
      typeof payload.wrapperIdentity !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(payload.wrapperIdentity) ||
      typeof payload.wrapperTrustAnchor !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(payload.wrapperTrustAnchor) ||
      typeof payload.wrapperScriptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(payload.wrapperScriptSha256) ||
      !isSafeProcessId(payload.wrapperPid) ||
      typeof payload.wrapperStartTicks !== 'string' ||
      !isDescendedFromBoundLauncher(payload.wrapperPid, payload.wrapperStartTicks) ||
      !isCgroupLaunchReceipt(payload.cgroup) ||
      typeof payload.capability !== 'string' ||
      typeof payload.issuer !== 'string'
    ) {
      return null;
    }
    return {
      wrapperIdentity: payload.wrapperIdentity,
      wrapperTrustAnchor: payload.wrapperTrustAnchor,
      wrapperPid: payload.wrapperPid,
      wrapperStartTicks: payload.wrapperStartTicks,
      wrapperScriptSha256: payload.wrapperScriptSha256,
      cgroup: payload.cgroup,
      attestor: { id: bootstrap.id, publicKey: bootstrap.publicKey, endpoint: bootstrap.endpoint },
      capability: payload.capability,
      issuer: payload.issuer,
    };
  } catch {
    return null;
  }
}

function isSafeProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && value > 1;
}

function readCapabilityAttestationBootstrap(
  bootstrapFd = CAPABILITY_ATTESTATION_BOOTSTRAP_FD
): {
  endpoint: string;
  publicKey: string;
  id: string;
  issuer: CapabilityIssuer;
  wrapperPid: number;
  wrapperStartTicks: string;
  wrapperTrustAnchor: string;
  wrapperScriptSha256: string;
} | null {
  try {
    const stat = fstatSync(bootstrapFd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 0n || stat.size <= 0n || stat.size > 64n * 1024n) {
      return null;
    }
    // A read-only fd is not sufficient: a direct launcher can manufacture an
    // unlinked regular file. FD 3 must be the wrapper pre-exec memfd and the
    // kernel must still report all mutation-preventing seals.
    // Linux reports an anonymous memfd as either `memfd:name (deleted)` or
    // `/memfd:name (deleted)`. Seals establish immutability, not provenance.
    if (!/^\/?memfd:provider-launch-stress-attestation(?: \(deleted\))?$/.test(
      readlinkSync(`/proc/self/fd/${bootstrapFd}`)
    )) {
      return null;
    }
    const seals = spawnSync(
      'python3',
      [
        '-c',
        "import fcntl, os, sys; required=fcntl.F_SEAL_SEAL|fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK; seals=fcntl.fcntl(3, fcntl.F_GET_SEALS); sys.exit(0 if (seals & required) == required else 1)",
      ],
      { stdio: ['ignore', 'ignore', 'ignore', bootstrapFd] }
    );
    if (seals.status !== 0) return null;
    const flags = readFileSync(
      `/proc/self/fdinfo/${bootstrapFd}`,
      'utf8'
    )
      .split('\n')
      .find((line) => line.startsWith('flags:'));
    const accessModeMask =
      fsConstants.O_RDONLY | fsConstants.O_WRONLY | fsConstants.O_RDWR;
    if (
      !flags ||
      (Number.parseInt(flags.slice('flags:'.length).trim(), 8) & accessModeMask) !==
        fsConstants.O_RDONLY
    ) {
      return null;
    }
    const bytes = Buffer.alloc(Number(stat.size));
    if (readSync(bootstrapFd, bytes, 0, bytes.length, 0) !== bytes.length)
      return null;
    const bootstrap = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const issuer = bootstrap.issuer as CapabilityIssuer | undefined;
    const wrapperPid = bootstrap.wrapperPid;
    const wrapperStartTicks = bootstrap.wrapperStartTicks;
    const wrapperTrustAnchor = bootstrap.wrapperTrustAnchor;
    const wrapperScriptSha256 = bootstrap.wrapperScriptSha256;
    const signedBootstrap = JSON.stringify({
      version: 2,
      endpoint: bootstrap.endpoint,
      publicKey: bootstrap.publicKey,
      id: bootstrap.id,
      issuerVersion: issuer?.version,
      issuerId: issuer?.id,
      wrapperPid,
      wrapperStartTicks,
      wrapperTrustAnchor,
      wrapperScriptSha256,
    });
    return bootstrap.version === 2 &&
      typeof bootstrap.endpoint === 'string' &&
      bootstrap.endpoint.length > 0 &&
      typeof bootstrap.publicKey === 'string' &&
      bootstrap.publicKey.includes('BEGIN PUBLIC KEY') &&
      typeof bootstrap.id === 'string' &&
      /^[a-f0-9]{64}$/i.test(bootstrap.id) &&
      issuer?.version === 1 &&
      typeof issuer.publicKey === 'string' &&
      issuer.publicKey.includes('BEGIN PUBLIC KEY') &&
      issuer.id === createHash('sha256').update(issuer.publicKey).digest('hex') &&
      typeof wrapperPid === 'number' &&
      Number.isSafeInteger(wrapperPid) &&
      wrapperPid > 1 &&
      typeof wrapperStartTicks === 'string' &&
      typeof wrapperTrustAnchor === 'string' &&
      /^[a-f0-9]{64}$/i.test(wrapperTrustAnchor) &&
      typeof wrapperScriptSha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(wrapperScriptSha256) &&
      // The fixed sealed descriptor only locates the attestor. Authorization
      // comes from that isolated attestor's private wrapper-proc capability;
      // do not authenticate a caller-selected argv string here.
      typeof bootstrap.signature === 'string' &&
      verify(null, Buffer.from(signedBootstrap), issuer.publicKey, Buffer.from(bootstrap.signature, 'base64'))
      ? {
          endpoint: bootstrap.endpoint,
          publicKey: bootstrap.publicKey,
          id: bootstrap.id,
          issuer,
          wrapperPid,
          wrapperStartTicks,
          wrapperTrustAnchor,
          wrapperScriptSha256,
        }
      : null;
  } catch {
    return null;
  }
}

function isDescendedFromBoundLauncher(wrapperPid: number, wrapperStartTicks: string): boolean {
  const wrapper = readLinuxProcessIdentity(`/proc/${wrapperPid}`);
  if (wrapper?.startTicks !== wrapperStartTicks) return false;
  let candidate = readLinuxProcessIdentity('/proc/self');
  const seen = new Set<number>();
  while (candidate && !seen.has(candidate.pid)) {
    if (candidate.pid === wrapperPid) return candidate.startTicks === wrapperStartTicks;
    seen.add(candidate.pid);
    if (candidate.parentPid <= 1) return false;
    candidate = readLinuxProcessIdentity(`/proc/${candidate.parentPid}`);
  }
  return false;
}

function isTrustedLauncherAdmission(
  admission: unknown,
  envelope: CapabilityPayload,
  trustedPublicKey = TRUSTED_LAUNCHER_CAPABILITY_PUBLIC_KEY
): admission is TrustedLauncherAdmission {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return false;
  const candidate = admission as Partial<TrustedLauncherAdmission>;
  if (typeof candidate.payload !== 'string' || typeof candidate.signature !== 'string') return false;
  if (
    !verify(
      null,
      Buffer.from(candidate.payload),
      trustedPublicKey,
      Buffer.from(candidate.signature, 'base64')
    )
  ) {
    return false;
  }
  try {
    const bound = JSON.parse(candidate.payload) as Record<string, unknown>;
    return (
      canonicalizeCapabilityJson(bound) === candidate.payload &&
      bound.domain === TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN &&
      bound.version === 1 &&
      canonicalizeCapabilityJson(bound.capability) ===
        canonicalizeCapabilityJson(runtimeCapabilityAdmissionScope(envelope))
    );
  } catch {
    return false;
  }
}

function runtimeCapabilityAdmissionScope(envelope: CapabilityPayload): Omit<CapabilityPayload, 'trustedLauncherAdmission'> {
  const { trustedLauncherAdmission: _admission, ...scope } = envelope;
  return scope;
}

function canonicalizeCapabilityJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('capability canonical JSON rejects non-safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeCapabilityJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('capability canonical JSON rejects non-plain values');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeCapabilityJson(record[key])}`)
    .join(',')}}`;
}

function isCapabilityIssuer(value: unknown): value is CapabilityIssuer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const issuer = value as Record<string, unknown>;
  return (
    issuer.version === 1 &&
    typeof issuer.id === 'string' &&
    /^[a-f0-9]{64}$/i.test(issuer.id) &&
    typeof issuer.publicKey === 'string' &&
    issuer.publicKey.includes('BEGIN PUBLIC KEY') &&
    issuer.id === createHash('sha256').update(issuer.publicKey).digest('hex')
  );
}

function isCapabilityAttestor(value: unknown): value is CapabilityAttestor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attestor = value as Record<string, unknown>;
  return (
    typeof attestor.id === 'string' &&
    /^[a-f0-9]{64}$/i.test(attestor.id) &&
    typeof attestor.publicKey === 'string' &&
    attestor.publicKey.includes('BEGIN PUBLIC KEY') &&
    createHash('sha256').update(attestor.publicKey).digest('hex') === attestor.id &&
    typeof attestor.endpoint === 'string' &&
    attestor.endpoint.length > 0
  );
}

function isLauncherCapability(value: unknown): value is CapabilityPayload['launcher'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const launcher = value as Record<string, unknown>;
  return (
    typeof launcher.pid === 'number' &&
    Number.isSafeInteger(launcher.pid) &&
    launcher.pid > 1 &&
    typeof launcher.startTicks === 'string' &&
    /^\d+$/.test(launcher.startTicks) &&
    typeof launcher.procDev === 'string' &&
    /^\d+$/.test(launcher.procDev) &&
    typeof launcher.procIno === 'string' &&
    /^\d+$/.test(launcher.procIno)
  );
}

function bindPinnedAccountingLedger(
  capability: AccountingCollectorCapability
): PinnedAccountingLedger {
  if (!isAccountingCollectorCapability(capability)) {
    throw new Error('accounting collector capability is malformed');
  }
  return {
    endpoint: capability.endpoint,
    publicKey: capability.publicKey,
    collectorId: capability.collectorId,
    dev: capability.ledger.dev,
    ino: capability.ledger.ino,
    provenanceDev: capability.provenance.dev,
    provenanceIno: capability.provenance.ino,
    provenanceSha256: capability.provenance.sha256,
    issuerId: capability.issuer.id,
    issuerPublicKey: capability.issuer.publicKey,
  };
}

function isAccountingCollectorCapability(value: unknown): value is AccountingCollectorCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const ledger = record.ledger as Record<string, unknown> | undefined;
  const provenance = record.provenance as Record<string, unknown> | undefined;
  const issuer = record.issuer as Record<string, unknown> | undefined;
  const producer = record.producer as Record<string, unknown> | undefined;
  return (
    typeof record.collectorId === 'string' &&
    /^[a-f0-9]{64}$/i.test(record.collectorId) &&
    typeof record.endpoint === 'string' &&
    record.endpoint.length > 0 &&
    typeof record.publicKey === 'string' &&
    record.publicKey.includes('BEGIN PUBLIC KEY') &&
    typeof ledger?.dev === 'string' &&
    typeof ledger.ino === 'string' &&
    typeof provenance?.dev === 'string' &&
    typeof provenance.ino === 'string' &&
    typeof provenance.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(provenance.sha256) &&
    typeof issuer?.id === 'string' &&
    /^[a-f0-9]{64}$/i.test(issuer.id) &&
    typeof issuer.publicKey === 'string' &&
    issuer.publicKey.includes('BEGIN PUBLIC KEY') &&
    createHash('sha256').update(issuer.publicKey).digest('hex') === issuer.id &&
    typeof producer?.id === 'string' &&
    /^[a-f0-9]{64}$/i.test(producer.id) &&
    typeof producer.publicKey === 'string' &&
    producer.publicKey.includes('BEGIN PUBLIC KEY') &&
    createHash('sha256').update(producer.publicKey).digest('hex') === producer.id
  );
}

function isCapturedAuthContext(value: unknown): value is CapturedAuthContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    'home',
    'userProfile',
    'claudeConfigDir',
    'codexHome',
    'anthropicAuth',
    'xdgDataHome',
    'xdgConfigHome',
    'googleApplicationCredentials',
  ].every((key) => typeof record[key] === 'string' && Boolean((record[key] as string).trim()));
}

function isDisposableProjectIdentity(value: unknown): value is DisposableProjectIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    'root',
    'projectPath',
    'token',
    'invocationId',
    'rootDev',
    'rootIno',
    'projectDev',
    'projectIno',
    'markerDev',
    'markerIno',
  ].every((key) => typeof record[key] === 'string' && Boolean((record[key] as string).trim()));
}

function isBoundProjectDirectoryLease(project: DisposableProjectIdentity): boolean {
  try {
    const stat = fstatSync(PROJECT_DIRECTORY_CAPABILITY_FD, { bigint: true });
    return (
      stat.isDirectory() &&
      String(stat.dev) === project.projectDev &&
      String(stat.ino) === project.projectIno
    );
  } catch {
    return false;
  }
}

function isCgroupLaunchReceipt(value: unknown): value is CgroupLaunchReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.mountPath === 'string' &&
    record.mountPath.startsWith('/') &&
    typeof record.relativePath === 'string' &&
    record.relativePath.startsWith('/') &&
    typeof record.dev === 'string' &&
    /^\d+$/.test(record.dev) &&
    typeof record.ino === 'string' &&
    /^\d+$/.test(record.ino)
  );
}

function isCurrentProcessInLaunchCgroup(receipt: CgroupLaunchReceipt): boolean {
  try {
    const current = readUnifiedCgroupRelativePath();
    if (current !== receipt.relativePath) return false;
    const cgroupPath = path.join(receipt.mountPath, receipt.relativePath.replace(/^\//, ''));
    const stat = statSync(cgroupPath, { bigint: true });
    return (
      String(stat.dev) === receipt.dev &&
      String(stat.ino) === receipt.ino &&
      readFileSync(path.join(cgroupPath, 'cgroup.procs'), 'utf8')
        .split(/\s+/)
        .includes(String(process.pid))
    );
  } catch {
    return false;
  }
}

function readUnifiedCgroupRelativePath(): string | null {
  try {
    const entry = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'));
    return entry?.slice(3).trim() || null;
  } catch {
    return null;
  }
}

function currentCgroupReceiptForTest(): CgroupLaunchReceipt {
  const relativePath = readUnifiedCgroupRelativePath();
  if (!relativePath)
    throw new Error('cgroup v2 is unavailable for this Linux-only authorization fixture');
  const mountPath = '/sys/fs/cgroup';
  const stat = statSync(path.join(mountPath, relativePath.replace(/^\//, '')), { bigint: true });
  return { mountPath, relativePath, dev: String(stat.dev), ino: String(stat.ino) };
}

function readLinuxProcessIdentity(procPath: string): LinuxProcessIdentity | null {
  const stat = readFileSync(`${procPath}/stat`, 'utf8');
  const closingParen = stat.lastIndexOf(')');
  if (closingParen < 0) return null;
  const pid = Number.parseInt(stat.slice(0, stat.indexOf(' ')), 10);
  const fields = stat.slice(closingParen + 2).split(' ');
  const parentPid = Number.parseInt(fields[1] ?? '', 10);
  const processGroup = Number.parseInt(fields[2] ?? '', 10);
  const startTicks = fields[19] ?? '';
  return Number.isSafeInteger(pid) &&
    Number.isSafeInteger(parentPid) &&
    Number.isSafeInteger(processGroup) &&
    startTicks
    ? { pid, parentPid, processGroup, startTicks }
    : null;
}
const initialLiveAuthorization = getLiveStressAuthorization();
// Positive wrapper-capability assertions, including FD 6-derived authority,
// are meaningful only in the authenticated disposable invocation. Ordinary
// test runs exercise the safe negative/static lanes below and cannot turn an
// ambient descriptor into a live authorization claim.
const liveAuthorizedDisposableDescribe =
  initialLiveAuthorization.ok &&
  Boolean(initialLiveAuthorization.project?.root) &&
  Boolean(initialLiveAuthorization.project?.projectPath)
    ? describe
    : describe.skip;
// This lane deliberately has no environment prerequisite.  It validates the
// release wrapper's FD 6 admission boundary itself, so it must execute in
// every lightweight run instead of inheriting the optional live-canary skip.
let mandatoryFd6VerificationLaneExecuted = false;

function createTrustedCapabilityAdmissionFixture() {
  const trusted = generateKeyPairSync('ed25519');
  const issuer = generateKeyPairSync('ed25519');
  const attestor = generateKeyPairSync('ed25519');
  const accounting = generateKeyPairSync('ed25519');
  const producer = generateKeyPairSync('ed25519');
  const publicPem = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
    key.export({ type: 'spki', format: 'pem' }).toString();
  const issuerPublicKey = publicPem(issuer.publicKey);
  const attestorPublicKey = publicPem(attestor.publicKey);
  const accountingPublicKey = publicPem(accounting.publicKey);
  const producerPublicKey = publicPem(producer.publicKey);
  const payload = {
    version: 1,
    token: 'a'.repeat(64),
    wrapperIdentity: 'b'.repeat(64),
    wrapperTrustAnchor: 'c'.repeat(64),
    wrapperScriptSha256: 'd'.repeat(64),
    launcher: { pid: 99, startTicks: '100', procDev: '101', procIno: '102' },
    issuer: {
      version: 1,
      id: createHash('sha256').update(issuerPublicKey).digest('hex'),
      publicKey: issuerPublicKey,
    },
    attestor: {
      id: createHash('sha256').update(attestorPublicKey).digest('hex'),
      publicKey: attestorPublicKey,
      endpoint: '/tmp/attestor.sock',
    },
    auth: {
      home: '/tmp/home', userProfile: '/tmp/home', claudeConfigDir: '/tmp/home/.claude',
      codexHome: '/tmp/home/.codex', anthropicAuth: 'subscription', xdgDataHome: '/tmp/home/.local/share',
      xdgConfigHome: '/tmp/home/.config', googleApplicationCredentials: '/tmp/home/adc.json',
    },
    cgroup: { mountPath: '/sys/fs/cgroup', relativePath: '/fixture', dev: '103', ino: '104' },
    project: {
      root: '/tmp/project', projectPath: '/tmp/project/app', token: 'e'.repeat(64),
      invocationId: 'fixture-invocation', rootDev: '105', rootIno: '106', projectDev: '107', projectIno: '108', markerDev: '109', markerIno: '110',
    },
    accounting: {
      collectorId: createHash('sha256').update('collector').digest('hex'), endpoint: '/tmp/collector.sock',
      publicKey: accountingPublicKey, ledger: { dev: '109', ino: '110' },
      provenance: { dev: '111', ino: '112', sha256: 'f'.repeat(64) },
      issuer: { id: createHash('sha256').update(accountingPublicKey).digest('hex'), publicKey: accountingPublicKey },
      producer: { id: createHash('sha256').update(producerPublicKey).digest('hex'), publicKey: producerPublicKey },
    },
  } satisfies Omit<CapabilityPayload, 'trustedLauncherAdmission'>;
  const statement = canonicalizeCapabilityJson({
    domain: TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN,
    version: 1,
    capability: payload,
  });
  const envelope: CapabilityPayload = {
    ...payload,
    trustedLauncherAdmission: {
      payload: statement,
      signature: sign(null, Buffer.from(statement), trusted.privateKey).toString('base64'),
    },
  };
  return {
    envelope,
    trustedPublicKey: publicPem(trusted.publicKey),
    trustedPrivateKey: trusted.privateKey,
    issuerPrivateKey: issuer.privateKey,
  };
}

function openProvisionedTrustedLauncherCapabilityForWrapperFixture(): number | null {
  const sourceFd = Number.parseInt(
    process.env.PROVIDER_LAUNCH_STRESS_TEST_TRUSTED_LAUNCHER_CAPABILITY_FD ?? '',
    10
  );
  if (!Number.isSafeInteger(sourceFd) || sourceFd < 0) return null;
  try {
    const duplicate = openSync(`/proc/self/fd/${sourceFd}`, 'r');
    const privateKey = readFileSync(`/proc/self/fd/${duplicate}`);
    const publicKey = createPublicKey(createPrivateKey(privateKey))
      .export({ type: 'spki', format: 'pem' })
      .toString();
    if (publicKey !== TRUSTED_LAUNCHER_CAPABILITY_PUBLIC_KEY) {
      closeSync(duplicate);
      return null;
    }
    return duplicate;
  } catch {
    return null;
  }
}

describe('provider launch stress mandatory FD6 verification lane', () => {
  afterAll(() => {
    // A positive marker makes an accidental describe.skip/early return in this
    // mandatory lane visible even when the optional environment lane is absent.
    expect(mandatoryFd6VerificationLaneExecuted).toBe(true);
  });

  it('must execute the safe negative descriptor fixture when FD 6 is missing or invalid', async () => {
    mandatoryFd6VerificationLaneExecuted = true;
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    const run = (stdio: StdioOptions) =>
      spawnSync(process.execPath, [wrapper, '--provider-launch-stress-fd6-negative-fixture'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio,
        env: { ...process.env },
      });

    // The regular release path still verifies signed identity before FD 6.
    // Ordinary tests deliberately use only this local negative fixture: it
    // cannot claim live authorization or allocate a disposable project.
    const missing = run(['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore']);
    expect(missing.status, missing.stderr).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ ok: true, authorized: false });

    const invalidPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-invalid-fd6-')),
      'not-a-launcher-capability'
    );
    let invalidFd: number | undefined;
    try {
      await fs.writeFile(invalidPath, 'not an Ed25519 launcher capability', { mode: 0o600 });
      invalidFd = openSync(invalidPath, 'r');
      const invalid = run([
        'ignore',
        'pipe',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        invalidFd,
      ]);
      expect(invalid.status, invalid.stderr).toBe(0);
      expect(JSON.parse(invalid.stdout)).toEqual({ ok: true, authorized: false });
    } finally {
      if (invalidFd !== undefined) closeSync(invalidFd);
      await tombstoneTestDirectory(path.dirname(invalidPath));
    }
  });
});

describe('provider launch stress wrapper hardening regressions', () => {
  const wrapperSource = () =>
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../scripts/prove-provider-launch-stress.mjs'
      ),
      'utf8'
    );

  it('counts a closed credential-lock lifecycle as a settlement while preserving four provider settlements', () => {
    const source = wrapperSource();
    expect(source).toContain('settlementCount: settlements.size + revokedCredentialLocks.size');
    expect(source).toContain('providerSettlementCount: settlements.size');
    expect(source).toContain('credentialLockSettlementCount: revokedCredentialLocks.size');
    expect(source).toContain('settlement.providerSettlementCount !== REQUIRED_PROVIDER_ORDER.length');
    expect(source).toContain('settlement.credentialLockSettlementCount !== REQUIRED_PROVIDER_ORDER.length');
  });

  it('runs the isolated Electron output worker as Node and bounds a cgroup-tree kill plus root reap', () => {
    const source = wrapperSource();
    expect(source).toContain("env: { ...input.env, ELECTRON_RUN_AS_NODE: '1' }");
    expect(source).toContain('ISOLATED_OUTPUT_WORKER_TIMEOUT_MS');
    expect(source).toContain('drainDedicatedLaunchCgroupSubtree(cgroup);');
    expect(source).toContain('isolated output worker root was not reaped after cgroup kill');
  });

  it('returns to the verified parent before removing a post-join cgroup and retains failed init ownership', () => {
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    const result = spawnSync(
      process.execPath,
      [wrapper, '--provider-launch-stress-cgroup-init-fault-fixture'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    expect(result.status, result.stderr).toBe(0);
    const fixture = JSON.parse(result.stdout) as {
      ok: boolean;
      removed: { operations: string[]; returnedToParentBeforeRmdir: boolean };
      retained: { operations: string[]; returnedToParentBeforeRmdir: boolean; ownershipExposed: boolean };
    };
    expect(fixture.ok).toBe(true);
    expect(fixture.removed.operations).toEqual(['joined', 'restored', 'rmdir']);
    expect(fixture.removed.returnedToParentBeforeRmdir).toBe(true);
    expect(fixture.retained.operations).toEqual(['joined', 'restored', 'rmdir']);
    expect(fixture.retained.returnedToParentBeforeRmdir).toBe(true);
    expect(fixture.retained.ownershipExposed).toBe(true);
  });

  it('accepts only unlinked read-only descriptors at collector and terminal guards', () => {
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    const result = spawnSync(
      process.execPath,
      [wrapper, '--provider-launch-stress-descriptor-access-fixture'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    expect(result.status, result.stderr).toBe(0);
    const fixture = JSON.parse(result.stdout) as {
      ok: boolean;
      results: Array<{
        name: string;
        unlinked: boolean;
        readOnly: boolean;
        producerWritable: boolean;
        terminal: boolean;
      }>;
    };
    expect(fixture.ok).toBe(true);
    expect(fixture.results).toEqual([
      { name: 'read-only', unlinked: true, readOnly: true, producerWritable: false, terminal: true, expected: { readOnly: true, producerWritable: false, terminal: true } },
      { name: 'read-write', unlinked: true, readOnly: false, producerWritable: true, terminal: false, expected: { readOnly: false, producerWritable: true, terminal: false } },
      { name: 'write-only', unlinked: true, readOnly: false, producerWritable: true, terminal: false, expected: { readOnly: false, producerWritable: true, terminal: false } },
    ]);
  });

  it('awaits idempotent signal cleanup before restoring SIGINT or SIGTERM semantics', () => {
    const source = wrapperSource();
    const signalBoundary = source.indexOf("for (const signal of ['SIGINT', 'SIGTERM'])");
    const cleanup = source.indexOf('await cleanupProviderLaunchStress(`received ${signal}`)', signalBoundary);
    const reraised = source.indexOf('process.kill(process.pid, signal);', cleanup);
    expect(signalBoundary).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(signalBoundary);
    expect(reraised).toBeGreaterThan(cleanup);
    expect(source).toContain('if (providerLaunchStressCleanupPromise) return providerLaunchStressCleanupPromise;');
    expect(source).toContain("terminateAndReapAccountingChild(accountingCollector.process, 'accounting collector', false)");
    expect(source).toContain('releaseDedicatedLaunchCgroup(launchCgroup);');
    expect(source).toContain('eraseCredentialBearingDisposableRunRoot(disposableRunProject)');
    expect(source).toContain('capabilityAttestor = attestor;');
    expect(source).toContain('accountingCollector = {\n    process: child,\n    producer,');
  });

  it('deterministically refuses worker admission when SIGTERM lands during preflight', () => {
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    const result = spawnSync(
      process.execPath,
      [wrapper, '--provider-launch-stress-signal-during-preflight-fixture'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      cleanupStarted: true,
      workerStarts: 0,
    });
    const source = wrapperSource();
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('continuation after Anthropic preflight')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('continuation after Gemini preflight')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('continuation after OpenCode preflight')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('accounting collector sibling allocation')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('dedicated launch cgroup allocation')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('capability attestor sibling allocation')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('accounting producer sibling allocation')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('isolated output worker cgroup allocation')");
    expect(source).toContain("assertProviderLaunchStressAdmissionOpen('isolated output worker allocation')");
  });

  it('does not synchronously exit after allocating collector siblings', () => {
    const source = wrapperSource();
    const collectorAllocation = source.indexOf('accountingCollector = await startAuthenticatedAccountingCollector();');
    const normalCompletion = source.indexOf('process.exitCode = result.status ?? 1;', collectorAllocation);
    const allocationToCompletion = source.slice(collectorAllocation, normalCompletion);
    expect(collectorAllocation).toBeGreaterThanOrEqual(0);
    expect(normalCompletion).toBeGreaterThan(collectorAllocation);
    expect(allocationToCompletion).not.toMatch(/^\s*process\.exit\(/m);
    expect(allocationToCompletion).toContain('await failClosedProviderLaunchStress(');
  });

  it('binds a collector revocation to the released provider owner and runtime session', () => {
    const source = wrapperSource();
    const revocation = source.indexOf('const releasedCredentialLock = releasedCredentialLocks.get(lock.lockId);');
    expect(revocation).toBeGreaterThanOrEqual(0);
    const guard = source.slice(revocation, revocation + 900);
    expect(guard).toContain('releasedCredentialLock.providerId !== receipt.providerId');
    expect(guard).toContain('releasedCredentialLock.ownerId !== lock.ownerId');
    expect(guard).toContain('releasedCredentialLock.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId');
    expect(source).toContain("} else if (lock.event === 'revocation') {");
    expect(source).toContain('requires an explicit revocation event');
  });

  it('requires one provider settlement and one lock lifecycle for every named provider', () => {
    const source = wrapperSource();
    expect(source).toContain('const providerSettlementCounts = new Map();');
    expect(source).toContain('const credentialLockSettlementCounts = new Map();');
    expect(source).toContain('!hasOneSettlementPerProvider(settlement.providerSettlementCounts)');
    expect(source).toContain('!hasOneSettlementPerProvider(settlement.credentialLockSettlementCounts)');
  });

  it('never enables retained evidence until descriptor credential scrubbing succeeds', () => {
    const source = wrapperSource();
    const retention = source.indexOf('function enableEvidenceRetention(reason)');
    const scrub = source.indexOf('!scrubCopiedProviderCredentialsBeforeEvidence()', retention);
    const enable = source.indexOf('preserveRunEvidence = true;', scrub);
    expect(retention).toBeGreaterThanOrEqual(0);
    expect(scrub).toBeGreaterThan(retention);
    expect(enable).toBeGreaterThan(scrub);
    expect(source).toContain("enableEvidenceRetention('disposable canary root deletion failure')");
  });
});

liveAuthorizedDisposableDescribe('provider launch stress requested-live authorization', () => {
  it('proves the executing worker received the authenticated wrapper capability', () => {
    expect(initialLiveAuthorization.ok, initialLiveAuthorization.reason).toBe(true);
    expect(initialLiveAuthorization.auth).toMatchObject({
      home: expect.any(String),
      claudeConfigDir: expect.any(String),
      codexHome: expect.any(String),
    });
    expect(initialLiveAuthorization.cgroup).toMatchObject({
      mountPath: expect.stringMatching(/^\//),
      relativePath: expect.stringMatching(/^\//),
      dev: expect.any(String),
      ino: expect.any(String),
    });
  });
});

const DEFAULT_ANTHROPIC_MODEL = 'haiku';
const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_CODEX_EFFORT = 'low' as const;
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';
const DEFAULT_ORDER: readonly RequiredProviderScenario[] = [
  'anthropic',
  'codex',
  'gemini',
  'opencode',
];
const STRESS_ORDER: readonly ProviderLaunchStressScenario[] = [...DEFAULT_ORDER, 'mixed'];
const MEMBER_NAMES = [
  'alice',
  'bob',
  'jack',
  'tom',
  'atlas',
  'nova',
  'cody',
  'oscar',
  'maya',
  'liam',
  'ivy',
  'noah',
  'zoe',
  'ryan',
  'emma',
  'owen',
  'luna',
  'finn',
  'aria',
  'milo',
];
const POST_LAUNCH_WORK_TIMEOUT_MS = 300_000;
const POST_STOP_QUIET_PERIOD_MS = 5_000;
const STOP_OWNERSHIP_POLL_MS = 50;
const STOP_OWNERSHIP_STABLE_PASSES = 3;
const DISPATCH_DRAIN_TIMEOUT_MS = 15_000;
const STOP_TEAM_TIMEOUT_MS = 90_000;
const OWNERSHIP_DISCOVERY_TIMEOUT_MS = 15_000;
const PROCESS_ESCALATION_TIMEOUT_MS = 30_000;
const SCENARIO_CLEANUP_TIMEOUT_MS = 180_000;
let currentStressTempDir = '';
let currentStressEffectiveHome = '';
let currentStressDisposableProject: DisposableProject | null = null;

type ProviderLaunchStressScenario = 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'mixed';

interface ActiveScenario {
  scenario: ProviderLaunchStressScenario;
  teamName: string;
  svc: ProviderLaunchStressService;
  /**
   * The teardown gate validates this authority immediately before and after
   * each real service boundary. Provider-owned disposers retain the same
   * cooperative boundary outside the provisioning service.
   */
  teardown?: CancellationAwareTeardown;
  ownership: TeamOwnership;
  phase: 'reserved' | 'creating' | 'created' | 'marked' | 'stopped' | 'cleaned';
  markerWritten: boolean;
  capturedProcesses: Map<number, LinuxProcessIdentity>;
  /** Immutable provider receipt that justified the initial PID observation. */
  launchProcessReceipts: Map<number, LaunchProcessReceipt>;
  /** Wrapper-created cgroup inherited by every launch descendant. */
  cgroupReceipt?: CgroupLaunchReceipt;
  teardownDiagnostics: string[];
  /** Closed before teardown.  Dispatches must observe this fence before each paid effect. */
  dispatchClosed: boolean;
  dispatchAbortController: AbortController;
  inFlightDispatches: Set<Promise<unknown>>;
  launchIdentityObservations: Set<Promise<void>>;
  /** Once true, a snapshot can reject identities but can never grant new PID authority. */
  teardownStarted: boolean;
  /** Timed-out teardown work remains fenced and observable until it settles. */
  pendingTeardownReceipts: Map<string, TeardownSettlementReceipt>;
  /** Durable exactly-once state for every teardown effect and afterEach resume. */
  cleanupEffects: Map<string, CleanupEffectReceipt>;
  cleanupAbortController: AbortController;
  proofAudit?: ProofAudit;
  created: boolean;
  failed: boolean;
}

interface TeardownMutationOptions {
  signal: AbortSignal;
  deadline: number;
}

interface CancellationAwareTeardown {
  stopTeam: (options: TeardownMutationOptions) => Promise<void>;
  disposeHarness?: (options: TeardownMutationOptions) => Promise<void>;
  cleanupCodex?: (options: TeardownMutationOptions) => Promise<void>;
}

interface LaunchProcessReceipt {
  teamName: string;
  runId: string;
  memberName: string;
  providerId: string;
  runtimeSessionId: string;
  pid: number;
  startTicks: string;
  parentPid: number;
  parentStartTicks: string | null;
}

interface TeardownSettlementReceipt {
  label: string;
  deadline: number;
  state: 'pending' | 'fulfilled' | 'rejected';
  error?: string;
}

interface CleanupEffectReceipt {
  label: string;
  state: 'pending' | 'fulfilled' | 'rejected';
  settlement: Promise<void>;
  error?: string;
}

interface ProofAudit {
  entries: Array<{
    taskId: string;
    memberName: string;
    replyText: string;
    peerRecipient: string | null;
    peerText: string | null;
    peerAckText: string | null;
    runId: string;
    providerId: TeamProviderId;
    runtimeSessionId: string;
    marker: string;
  }>;
  beforeStop: string;
  accounting: PinnedAccountingLedger;
  /** Exact authenticated settlement identity multiset accepted at baseline. */
  acceptedSettlementIdentityMultiset?: ReadonlyMap<string, number>;
}

type RequiredProviderScenario = Exclude<ProviderLaunchStressScenario, 'mixed'>;

type ProviderLaunchStressService = Pick<
  TeamProvisioningService,
  | 'createTeam'
  | 'getMemberSpawnStatuses'
  | 'getTeamAgentRuntimeSnapshot'
  | 'relayInboxFileToLiveRecipient'
  | 'setWorkspaceTrustCoordinator'
  | 'stopTeam'
>;

type ProviderLaunchStressDiagnosticsService = Pick<
  ProviderLaunchStressService,
  'getMemberSpawnStatuses' | 'getTeamAgentRuntimeSnapshot'
>;

type ProviderLaunchStressHarness = Pick<
  Awaited<ReturnType<typeof createOpenCodeLiveHarness>>,
  'dispose' | 'svc'
>;

function createProviderLaunchStressService(
  overrides: Partial<ProviderLaunchStressService> = {}
): ProviderLaunchStressService {
  const service = new TeamProvisioningService();
  return {
    createTeam: (...args) => service.createTeam(...args),
    getMemberSpawnStatuses: (...args) => service.getMemberSpawnStatuses(...args),
    getTeamAgentRuntimeSnapshot: (...args) => service.getTeamAgentRuntimeSnapshot(...args),
    relayInboxFileToLiveRecipient: (...args) => service.relayInboxFileToLiveRecipient(...args),
    setWorkspaceTrustCoordinator: (...args) => service.setWorkspaceTrustCoordinator(...args),
    stopTeam: (...args) => service.stopTeam(...args),
    ...overrides,
  };
}

function createEmptyRuntimeSnapshot(teamName: string): TeamAgentRuntimeSnapshot {
  return {
    teamName,
    runId: null,
    updatedAt: new Date().toISOString(),
    members: {},
  };
}

function createActiveScenarioFixture(
  input: Pick<ActiveScenario, 'teamName'> &
    Partial<Omit<ActiveScenario, 'teamName' | 'svc' | 'ownership'>> & {
      ownership?: TeamOwnership;
      svc?: Partial<ProviderLaunchStressService>;
    }
): ActiveScenario {
  const { svc: svcOverrides, ownership, ...overrides } = input;
  return {
    scenario: 'anthropic',
    teamName: input.teamName,
    svc: createProviderLaunchStressService(svcOverrides),
    ownership: ownership ?? { lockPath: '', token: '' },
    phase: 'reserved',
    markerWritten: false,
    capturedProcesses: new Map(),
    launchProcessReceipts: new Map(),
    teardownDiagnostics: [],
    dispatchClosed: false,
    dispatchAbortController: new AbortController(),
    inFlightDispatches: new Set(),
    launchIdentityObservations: new Set(),
    teardownStarted: false,
    pendingTeardownReceipts: new Map(),
    cleanupEffects: new Map(),
    cleanupAbortController: new AbortController(),
    created: false,
    failed: false,
    ...overrides,
  };
}

/**
 * A locally verified scenario proof. The collector is intentionally not
 * sealed here: the four proofs are combined into one final baseline only
 * after every required provider has completed and drained.
 */
interface ScenarioSequenceProof {
  scenario: RequiredProviderScenario;
  teamName: string;
  audit: ProofAudit;
}

interface ProviderEffectReceipt {
  version: 1;
  /** Every billable effect remains bound to the authenticated producer. */
  issuerId: string;
  issuerPayload: string;
  issuerSignature: string;
  billingEventId: string;
  kind:
    | 'provider-request'
    | 'provider-debit'
    | 'provider-refund'
    | 'provider-effect'
    | 'runtime-credential-lock';
  terminalOutcome: 'accepted' | 'debited' | 'refunded' | 'effect-observed' | 'acquired' | 'released' | 'revoked';
  teamName: string;
  runId: string;
  taskId: string;
  memberName: string;
  providerId: TeamProviderId;
  runtimeSessionId: string;
  marker: string;
  /** Present only for a signed event emitted by the runtime credential-lock owner. */
  credentialLock?: {
    lockId: string;
    ownerId: string;
    ownerRuntimeSessionId: string;
    /** `effect` is an owner reference on every provider effect receipt. */
    event: 'acquire' | 'release' | 'revocation' | 'effect';
  };
}

/**
 * The runtime that owns the credential lock signs these transitions into the
 * collector ledger. Billing receipts are deliberately not lock evidence:
 * request/debit order can be interleaved after a runtime has already released
 * a credential, and therefore cannot prove non-overlap.
 */
interface ProviderCredentialCriticalSectionEvidence {
  providerId: TeamProviderId;
  enteredAtSequence: number;
  exitedAtSequence: number;
  revokedAtSequence: number;
  lockId: string;
  ownerId: string;
  ownerRuntimeSessionId: string;
  receiptIds: readonly string[];
}

interface TeamOwnership {
  lockPath: string;
  token: string;
}

interface DisposableProject {
  root: string;
  projectPath: string;
  token: string;
  wrapperOwned: boolean;
  invocationId?: string;
  failureReservationManifest?: string;
  rootDev: string;
  rootIno: string;
  projectDev: string;
  projectIno: string;
  markerDev: string;
  markerIno: string;
}

interface ReleasePayloadEntry {
  realPath: string;
  sha256: string;
  dev: string;
  ino: string;
  size: string;
  role: 'wrapper' | 'entry' | 'build-metadata' | 'lockfile' | 'module-or-asset';
}

interface ReleaseDescriptor {
  fd: number;
  path: string;
  dev: string;
  ino: string;
  size: string;
  sha256: string;
}

interface SealedReleaseAssertion {
  version: 1;
  wrapperTrustAnchor: string;
  wrapperSha256: string;
  manifestSha256: string;
  payloadSha256: string;
}

const MAX_RELEASE_DESCRIPTOR_BYTES = 64 * 1024 * 1024;

describe('provider launch stress fake-downstream guards', () => {
  it('binds the complete runtime capability with canonical, domain-separated launcher admission', () => {
    const { envelope, trustedPublicKey } = createTrustedCapabilityAdmissionFixture();
    expect(isTrustedLauncherAdmission(envelope.trustedLauncherAdmission, envelope, trustedPublicKey)).toBe(true);

    // Every authority-bearing field is copied from a genuine admission and
    // then substituted independently. None can ride alongside a valid token,
    // launcher, issuer, or signature from another runtime capability.
    const substitutions: Array<[string, (copy: CapabilityPayload) => void]> = [
      ['token', (copy) => { copy.token = '0'.repeat(64); }],
      ['wrapper identity', (copy) => { copy.wrapperIdentity = '1'.repeat(64); }],
      ['trust anchor', (copy) => { copy.wrapperTrustAnchor = '2'.repeat(64); }],
      ['wrapper artifact', (copy) => { copy.wrapperScriptSha256 = '3'.repeat(64); }],
      ['launcher pid', (copy) => { copy.launcher.pid += 1; }],
      ['launcher start ticks', (copy) => { copy.launcher.startTicks = '200'; }],
      ['launcher device', (copy) => { copy.launcher.procDev = '201'; }],
      ['launcher inode', (copy) => { copy.launcher.procIno = '202'; }],
      ['issuer identity', (copy) => { copy.issuer.id = '4'.repeat(64); }],
      ['issuer key', (copy) => { copy.issuer.publicKey += 'forged'; }],
      ['attestor identity', (copy) => { copy.attestor.id = '5'.repeat(64); }],
      ['attestor key', (copy) => { copy.attestor.publicKey += 'forged'; }],
      ['attestor endpoint', (copy) => { copy.attestor.endpoint = '/tmp/copied-attestor.sock'; }],
      ['auth home', (copy) => { copy.auth.home = '/tmp/copied-home'; }],
      ['auth user profile', (copy) => { copy.auth.userProfile = '/tmp/copied-user'; }],
      ['auth Claude config', (copy) => { copy.auth.claudeConfigDir = '/tmp/copied-claude'; }],
      ['auth Codex home', (copy) => { copy.auth.codexHome = '/tmp/copied-codex'; }],
      ['auth mode', (copy) => { copy.auth.anthropicAuth = 'api-key'; }],
      ['auth XDG data', (copy) => { copy.auth.xdgDataHome = '/tmp/copied-data'; }],
      ['auth XDG config', (copy) => { copy.auth.xdgConfigHome = '/tmp/copied-config'; }],
      ['auth ADC', (copy) => { copy.auth.googleApplicationCredentials = '/tmp/copied-adc'; }],
      ['cgroup mount', (copy) => { copy.cgroup.mountPath = '/tmp/cgroup'; }],
      ['cgroup path', (copy) => { copy.cgroup.relativePath = '/copied'; }],
      ['cgroup device', (copy) => { copy.cgroup.dev = '203'; }],
      ['cgroup inode', (copy) => { copy.cgroup.ino = '204'; }],
      ['project root', (copy) => { copy.project.root = '/tmp/copied-project'; }],
      ['project path', (copy) => { copy.project.projectPath = '/tmp/copied-project/app'; }],
      ['project token', (copy) => { copy.project.token = '6'.repeat(64); }],
      ['project invocation', (copy) => { copy.project.invocationId = 'copied-invocation'; }],
      ['project root device', (copy) => { copy.project.rootDev = '205'; }],
      ['project root inode', (copy) => { copy.project.rootIno = '206'; }],
      ['project directory device', (copy) => { copy.project.projectDev = '207'; }],
      ['project directory inode', (copy) => { copy.project.projectIno = '208'; }],
      ['project marker device', (copy) => { copy.project.markerDev = '209'; }],
      ['project marker inode', (copy) => { copy.project.markerIno = '210'; }],
      ['accounting collector', (copy) => { copy.accounting.collectorId = '7'.repeat(64); }],
      ['accounting endpoint', (copy) => { copy.accounting.endpoint = '/tmp/copied-collector.sock'; }],
      ['accounting key', (copy) => { copy.accounting.publicKey += 'forged'; }],
      ['accounting ledger device', (copy) => { copy.accounting.ledger.dev = '209'; }],
      ['accounting ledger inode', (copy) => { copy.accounting.ledger.ino = '210'; }],
      ['accounting provenance device', (copy) => { copy.accounting.provenance.dev = '211'; }],
      ['accounting provenance inode', (copy) => { copy.accounting.provenance.ino = '212'; }],
      ['accounting provenance digest', (copy) => { copy.accounting.provenance.sha256 = '8'.repeat(64); }],
      ['accounting issuer id', (copy) => { copy.accounting.issuer.id = '9'.repeat(64); }],
      ['accounting issuer key', (copy) => { copy.accounting.issuer.publicKey += 'forged'; }],
      ['accounting producer id', (copy) => { copy.accounting.producer.id = 'a'.repeat(64); }],
      ['accounting producer key', (copy) => { copy.accounting.producer.publicKey += 'forged'; }],
    ];
    for (const [field, substitute] of substitutions) {
      const copy = structuredClone(envelope);
      substitute(copy);
      expect(isTrustedLauncherAdmission(copy.trustedLauncherAdmission, copy, trustedPublicKey), field).toBe(false);
    }
  });

  it('rejects canonical-equivalent reformatting and a copied admission with substituted authority', () => {
    const { envelope, trustedPublicKey, trustedPrivateKey } = createTrustedCapabilityAdmissionFixture();
    const prettyCopy = structuredClone(envelope);
    prettyCopy.trustedLauncherAdmission.payload = JSON.stringify(
      JSON.parse(prettyCopy.trustedLauncherAdmission.payload),
      null,
      2
    );
    prettyCopy.trustedLauncherAdmission.signature = sign(
      null,
      Buffer.from(prettyCopy.trustedLauncherAdmission.payload),
      trustedPrivateKey
    ).toString('base64');
    expect(isTrustedLauncherAdmission(prettyCopy.trustedLauncherAdmission, prettyCopy, trustedPublicKey)).toBe(false);

    const authCopy = structuredClone(envelope);
    authCopy.auth.codexHome = '/tmp/copied-authority';
    expect(isTrustedLauncherAdmission(authCopy.trustedLauncherAdmission, authCopy, trustedPublicKey)).toBe(false);
  });

  it('rejects a signed receipt whose terminal attribution was changed after signing', () => {
    const receipt = {
      version: 1,
      issuerId: 'issuer',
      issuerPayload: '{}',
      issuerSignature: 'signature',
      billingEventId: 'billing-event-0001',
      kind: 'provider-effect',
      terminalOutcome: 'effect-observed',
      teamName: 'team',
      runId: 'run',
      taskId: 'task',
      memberName: 'member',
      providerId: 'gemini',
      runtimeSessionId: 'session',
      marker: 'marker',
    } satisfies ProviderEffectReceipt;
    const signedPayload: Record<string, unknown> = {
      billingEventId: receipt.billingEventId,
      teamName: receipt.teamName,
      runId: receipt.runId,
      taskId: receipt.taskId,
      memberName: receipt.memberName,
      providerId: receipt.providerId,
      kind: receipt.kind,
      terminalOutcome: 'accepted',
      runtimeSessionId: receipt.runtimeSessionId,
      marker: receipt.marker,
    };
    expect(() => assertSignedProviderAttribution(receipt, signedPayload)).toThrow(
      /does not bind/i
    );
  });

  it('rejects a late extra billing receipt in the post-drain snapshot', () => {
    const expected = {
      taskId: 'task',
      memberName: 'member',
      replyText: 'reply',
      peerRecipient: null,
      peerText: null,
      peerAckText: null,
      runId: 'run',
      providerId: 'gemini',
      runtimeSessionId: 'session',
      marker: 'marker',
    };
    const receipt = (kind: ProviderEffectReceipt['kind'], terminalOutcome: ProviderEffectReceipt['terminalOutcome']) => ({
      version: 1,
      issuerId: 'issuer',
      issuerPayload: '{}',
      issuerSignature: 'signature',
      billingEventId: `billing-event-${kind}`,
      kind,
      terminalOutcome,
      teamName: 'team',
      runId: expected.runId,
      taskId: expected.taskId,
      memberName: expected.memberName,
      providerId: expected.providerId,
      runtimeSessionId: expected.runtimeSessionId,
      marker: expected.marker,
    });
    const extraReceipt = receipt('provider-debit', 'debited');
    const snapshot = JSON.stringify({
      version: 1,
      entries: [
        {
        taskId: expected.taskId,
        comments: [{ text: expected.replyText }],
        peers: [],
        peerAcks: [],
        providerReceipts: [
          receipt('provider-request', 'accepted'),
          receipt('provider-debit', 'debited'),
          receipt('provider-effect', 'effect-observed'),
          extraReceipt,
        ],
        },
      ],
      receipts: [
        receipt('provider-request', 'accepted'),
        receipt('provider-debit', 'debited'),
        receipt('provider-effect', 'effect-observed'),
        extraReceipt,
      ],
    });
    expect(() =>
      assertExactProofSnapshot(
        { entries: [expected], beforeStop: '', accounting: { issuerId: 'issuer' } } as ProofAudit,
        snapshot,
        'team'
      )
    ).toThrow(/duplicated|malformed/i);
  });

  it('accepts a deterministic four-provider baseline and rejects signed late, duplicate, and missing effects', () => {
    const issuer = generateKeyPairSync('ed25519');
    const issuerPublicKey = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const issuerId = createHash('sha256').update(issuerPublicKey).digest('hex');
    const receipt = (
      billingEventId: string,
      providerId: TeamProviderId,
      kind: ProviderEffectReceipt['kind'],
      terminalOutcome: ProviderEffectReceipt['terminalOutcome'],
      credentialLock?: ProviderEffectReceipt['credentialLock'],
      runtimeSessionId = `session-${providerId}`
    ): ProviderEffectReceipt => {
      const signedPayload = JSON.stringify({
        billingEventId,
        teamName: 'team',
        runId: 'run',
        taskId: `task-${providerId}`,
        memberName: `member-${providerId}`,
        providerId,
        kind,
        terminalOutcome,
        runtimeSessionId,
        marker: `marker-${providerId}`,
        ...(credentialLock ? { credentialLock } : {}),
      });
      return {
        version: 1,
        issuerId,
        issuerPayload: signedPayload,
        issuerSignature: sign(null, Buffer.from(signedPayload), issuer.privateKey).toString('base64'),
        billingEventId,
        kind,
        terminalOutcome,
        teamName: 'team',
        runId: 'run',
        taskId: `task-${providerId}`,
        memberName: `member-${providerId}`,
        providerId,
        runtimeSessionId,
        marker: `marker-${providerId}`,
        ...(credentialLock ? { credentialLock } : {}),
      };
    };
    const lock = (
      provider: TeamProviderId,
      event: 'acquire' | 'release' | 'revocation' | 'effect'
    ) => ({
      lockId: `lock-${provider}`,
      ownerId: `runtime-lock-owner-${provider}`,
      ownerRuntimeSessionId: `session-${provider}`,
      event,
    });
    const baseline = DEFAULT_ORDER.flatMap((provider) => [
      receipt(
        `credential-lock-${provider}-acquire`,
        provider,
        'runtime-credential-lock',
        'acquired',
        lock(provider, 'acquire')
      ),
      receipt(
        `billing-event-${provider}-request`,
        provider,
        'provider-request',
        'accepted',
        lock(provider, 'effect')
      ),
      receipt(
        `billing-event-${provider}-debit`,
        provider,
        'provider-debit',
        'debited',
        lock(provider, 'effect')
      ),
      receipt(
        `billing-event-${provider}-effect`,
        provider,
        'provider-effect',
        'effect-observed',
        lock(provider, 'effect')
      ),
      receipt(
        `credential-lock-${provider}-release`,
        provider,
        'runtime-credential-lock',
        'released',
        lock(provider, 'release')
      ),
      receipt(
        `credential-lock-${provider}-revocation`,
        provider,
        'runtime-credential-lock',
        'revoked',
        lock(provider, 'revocation')
      ),
    ]);
    const serialize = (receipts: ProviderEffectReceipt[]) => JSON.stringify({ version: 1, receipts });
    const baselineProof = serialize(baseline);
    // The signed payload and the received receipt are separately parsed JSON,
    // so their credential-lock objects are structurally equal but never the
    // same JavaScript object. Keep this regression independent of object
    // construction history and reject a structurally different lock.
    const independentlyParsedLockReceipt = {
      ...baseline[0]!,
      credentialLock: { ...baseline[0]!.credentialLock! },
    };
    expect(() =>
      assertSignedProviderAttribution(
        independentlyParsedLockReceipt,
        JSON.parse(independentlyParsedLockReceipt.issuerPayload) as Record<string, unknown>
      )
    ).not.toThrow();
    const changedLockReceipt = {
      ...independentlyParsedLockReceipt,
      credentialLock: {
        ...independentlyParsedLockReceipt.credentialLock!,
        ownerId: 'different-runtime-lock-owner',
      },
    };
    expect(() =>
      assertSignedProviderAttribution(
        changedLockReceipt,
        JSON.parse(changedLockReceipt.issuerPayload) as Record<string, unknown>
      )
    ).toThrow(/signature does not bind/i);
    expect(() => assertDeterministicFourProviderSequenceMultiset(baseline, baseline)).not.toThrow();
    expect(() =>
      assertDeterministicFourProviderSequenceMultiset(
        baseline.filter((entry) => entry.kind !== 'runtime-credential-lock'),
        baseline.filter((entry) => entry.kind !== 'runtime-credential-lock')
      )
    ).toThrow(/runtime credential-lock/i);
    expect(() =>
      assertFinalSealedAccountingProofReconciliation(baselineProof, baselineProof, 'team', issuerId)
    ).not.toThrow();
    const providerLedger = baseline.slice(0, 6);
    const providerEffect = providerLedger.find((entry) => entry.kind === 'provider-effect')!;
    const providerAudit = {
      entries: [
        {
          taskId: providerEffect.taskId,
          memberName: providerEffect.memberName,
          replyText: 'reply',
          peerRecipient: null,
          peerText: null,
          peerAckText: null,
          runId: providerEffect.runId,
          providerId: providerEffect.providerId,
          runtimeSessionId: providerEffect.runtimeSessionId,
          marker: providerEffect.marker,
        },
      ],
      beforeStop: '',
      accounting: { issuerId },
    } as ProofAudit;
    const providerSnapshot = JSON.stringify({
      version: 1,
      entries: [
        {
          taskId: providerEffect.taskId,
          comments: [{ text: 'reply' }],
          peers: [],
          peerAcks: [],
          providerReceipts: providerLedger.filter(
            (entry) => entry.kind !== 'runtime-credential-lock'
          ),
        },
      ],
      receipts: providerLedger,
    });
    expect(() =>
      assertExactProofSnapshot(
        providerAudit,
        providerSnapshot,
        'team',
        collectAcceptedSettlementIdentityMultiset(providerSnapshot, 'team', issuerId)
      )
    ).not.toThrow();

    // Exercise the narrow invariant first. A broad final-reconciliation
    // assertion can reject a malformed fixture before its intended lock
    // ownership check runs, which turns a useful adversarial regression into
    // an accidental assertion about whichever outer guard happens to fire.
    const variants: Array<[string, ProviderEffectReceipt[], () => void, RegExp]> = [
      [
        'late signed append',
        [...baseline, receipt('billing-event-opencode-late', 'opencode', 'provider-refund', 'refunded')],
        () => assertExactFourProviderProofReceiptMultiset([...baseline, receipt('billing-event-opencode-late', 'opencode', 'provider-refund', 'refunded')]),
        /four-provider/i,
      ],
      ['duplicate signed effect', [...baseline, baseline[2]!], () => assertExactFourProviderProofReceiptMultiset([...baseline, baseline[2]!]), /four-provider/i],
      ['missing signed effect', baseline.filter((receipt) => receipt.providerId !== 'gemini'), () => assertExactFourProviderProofReceiptMultiset(baseline.filter((receipt) => receipt.providerId !== 'gemini')), /four-provider/i],
      [
        'replacement',
        [
          ...baseline.slice(0, -1),
          receipt('billing-event-opencode-replaced', 'opencode', 'provider-effect', 'effect-observed'),
        ],
        () => assertNoOverlappingProviderCredentialCriticalSections([
          ...baseline.slice(0, -1),
          receipt('billing-event-opencode-replaced', 'opencode', 'provider-effect', 'effect-observed'),
        ]),
        /active credential-lock owner/i,
      ],
      [
        'reordered authority effects',
        [baseline[1]!, baseline[0]!, ...baseline.slice(2)],
        () => assertNoOverlappingProviderCredentialCriticalSections([baseline[1]!, baseline[0]!, ...baseline.slice(2)]),
        /active credential-lock owner at sequence 0/i,
      ],
      [
        'interleaved credential events',
        [baseline[0]!, baseline[6]!, ...baseline.slice(1, 6), ...baseline.slice(7)],
        () => assertNoOverlappingProviderCredentialCriticalSections([baseline[0]!, baseline[6]!, ...baseline.slice(1, 6), ...baseline.slice(7)]),
        /overlap or duplicate acquisition/i,
      ],
      [
        'post-revocation provider effect',
        [...baseline.filter((_, index) => index !== 3), baseline[3]!],
        () => assertNoOverlappingProviderCredentialCriticalSections([...baseline.filter((_, index) => index !== 3), baseline[3]!]),
        /active credential-lock owner at sequence/i,
      ],
      [
        'different-session lock owner effect',
        [
          ...baseline.slice(0, 3),
          receipt(
            'billing-event-anthropic-different-owner',
            'anthropic',
            'provider-effect',
            'effect-observed',
            {
              ...lock('anthropic', 'effect'),
              ownerRuntimeSessionId: 'session-different-runtime-owner',
            },
            'session-different-runtime-owner'
          ),
          ...baseline.slice(4),
        ],
        () => assertNoOverlappingProviderCredentialCriticalSections([
          ...baseline.slice(0, 3),
          receipt('billing-event-anthropic-different-owner', 'anthropic', 'provider-effect', 'effect-observed', {
            ...lock('anthropic', 'effect'), ownerRuntimeSessionId: 'session-different-runtime-owner',
          }, 'session-different-runtime-owner'),
          ...baseline.slice(4),
        ]),
        /active credential-lock owner at sequence/i,
      ],
      [
        'missing lock revocation',
        baseline.filter((entry) => entry.credentialLock?.event !== 'revocation'),
        () => assertNoOverlappingProviderCredentialCriticalSections(baseline.filter((entry) => entry.credentialLock?.event !== 'revocation')),
        /credential-lock.*revocation/i,
      ],
      [
        'signed revocation event substitution',
        [
          ...baseline.slice(0, 5),
          receipt(
            'credential-lock-anthropic-effect-substituted-for-revocation',
            'anthropic',
            'runtime-credential-lock',
            'revoked',
            lock('anthropic', 'effect')
          ),
          ...baseline.slice(6),
        ],
        () => assertNoOverlappingProviderCredentialCriticalSections([
          ...baseline.slice(0, 5),
          receipt(
            'credential-lock-anthropic-effect-substituted-for-revocation',
            'anthropic',
            'runtime-credential-lock',
            'revoked',
            lock('anthropic', 'effect')
          ),
          ...baseline.slice(6),
        ]),
        /invalid event/i,
      ],
      [
        'signed skewed provider settlements',
        baseline.map((entry) =>
          entry.providerId === 'gemini' && entry.kind !== 'runtime-credential-lock'
            ? receipt(
                `skewed-${entry.billingEventId}`,
                'anthropic',
                entry.kind,
                entry.terminalOutcome,
                lock('anthropic', 'effect')
              )
            : entry
        ),
        () =>
          assertExactFourProviderProofReceiptMultiset(
            baseline.map((entry) =>
              entry.providerId === 'gemini' && entry.kind !== 'runtime-credential-lock'
                ? receipt(
                    `skewed-${entry.billingEventId}`,
                    'anthropic',
                    entry.kind,
                    entry.terminalOutcome,
                    lock('anthropic', 'effect')
                  )
                : entry
            )
          ),
        /four-provider.*anthropic|overlapping or missing anthropic/i,
      ],
      [
        'fresh signed revocation with another owner',
        [
          ...baseline.slice(0, 5),
          receipt('credential-lock-anthropic-revocation-other-owner', 'anthropic', 'runtime-credential-lock', 'revoked', {
            ...lock('anthropic', 'revocation'), ownerId: 'fresh-signed-other-owner',
          }),
          ...baseline.slice(6),
        ],
        () => assertNoOverlappingProviderCredentialCriticalSections([
          ...baseline.slice(0, 5),
          receipt('credential-lock-anthropic-revocation-other-owner', 'anthropic', 'runtime-credential-lock', 'revoked', {
            ...lock('anthropic', 'revocation'), ownerId: 'fresh-signed-other-owner',
          }),
          ...baseline.slice(6),
        ]),
        /revocation is not owned/i,
      ],
      [
        'fresh signed revocation with another session',
        [
          ...baseline.slice(0, 5),
          receipt('credential-lock-anthropic-revocation-other-session', 'anthropic', 'runtime-credential-lock', 'revoked', {
            ...lock('anthropic', 'revocation'), ownerRuntimeSessionId: 'session-fresh-signed-other-owner',
          }, 'session-fresh-signed-other-owner'),
          ...baseline.slice(6),
        ],
        () => assertNoOverlappingProviderCredentialCriticalSections([
          ...baseline.slice(0, 5),
          receipt('credential-lock-anthropic-revocation-other-session', 'anthropic', 'runtime-credential-lock', 'revoked', {
            ...lock('anthropic', 'revocation'), ownerRuntimeSessionId: 'session-fresh-signed-other-owner',
          }, 'session-fresh-signed-other-owner'),
          ...baseline.slice(6),
        ]),
        /revocation is not owned/i,
      ],
    ];
    for (const [label, finalReceipts, assertIntendedInvariant, expectedSequenceError] of variants) {
      for (const signedReceipt of finalReceipts) {
        expect(
          verify(
            null,
            Buffer.from(signedReceipt.issuerPayload),
            issuerPublicKey,
            Buffer.from(signedReceipt.issuerSignature, 'base64')
          ),
          `${label} must remain a signed receipt`
        ).toBe(true);
      }
      expect(assertIntendedInvariant, label).toThrow(expectedSequenceError);
      expect(() => assertDeterministicFourProviderSequenceMultiset(baseline, finalReceipts), label).toThrow();
      expect(
        () =>
          assertFinalSealedAccountingProofReconciliation(
            baselineProof,
            serialize(finalReceipts),
            'team',
            issuerId
          ),
        label
      ).toThrow(/sealed accounting|authority effects/i);
    }
  });

  it('reports unsupported platforms explicitly', () => {
    const live = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    try {
      process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
      expect(getLiveStressAuthorization('darwin')).toEqual({
        ok: false,
        reason: 'live canary is unsupported on darwin',
      });
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', live);
    }
  });

  it('preserves legitimate wrapper authorization while rejecting forged or missing trust anchors', async () => {
    if (process.platform !== 'linux') return;
    // Environment knobs are deliberately ignored. A legitimate live worker
    // must remain authorized after they are forged: the negative case is an
    // absent/untrusted FD-3 trust anchor, not an expectation that harmless
    // environment mutation breaks the actual wrapper capability.
    const originalLive = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
    if (initialLiveAuthorization.ok) {
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ENDPOINT = '/tmp/forged-attestor.sock';
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_PUBLIC_KEY = 'forged';
      expect(getLiveStressAuthorization()).toMatchObject({ ok: true });
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', originalLive);
      delete process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_ENDPOINT;
      delete process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ATTESTOR_PUBLIC_KEY;
      return;
    }
    const names = [
      'PROVIDER_LAUNCH_STRESS_LIVE',
      'PROVIDER_LAUNCH_STRESS_WRAPPER_PID',
      'PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS',
      'PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_FD',
      'PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_DEV',
      'PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_INO',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_FD',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_DEV',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_INO',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_SHA256',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_FD',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_DEV',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_INO',
      'PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_SHA256',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const previousArgv = [...process.argv];
    const previousTitle = process.title;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-forged-identity-'));
    const capabilityPath = path.join(root, 'capability');
    const issuerPath = path.join(root, 'issuer');
    // This is a completely valid forged envelope.  It is still rejected
    // because the worker only reads the wrapper's fixed inherited bootstrap
    // descriptor, never an environment-selected capability/key/endpoint.
    const forgedIssuer = generateKeyPairSync('ed25519');
    const forgedPublicKey = forgedIssuer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const forgedIssuerId = createHash('sha256').update(forgedPublicKey).digest('hex');
    const forgedPayload = JSON.stringify({
      version: 1,
      token: randomBytes(32).toString('hex'),
      wrapperIdentity: createHash('sha256').update('forged-wrapper').digest('hex'),
      wrapperTrustAnchor: createHash('sha256').update('forged-trust-anchor').digest('hex'),
      auth: {
        home: '/tmp/forged-home',
        userProfile: '/tmp/forged-home',
        claudeConfigDir: '/tmp/forged-home/.claude',
        codexHome: '/tmp/forged-home/.codex',
        anthropicAuth: 'subscription',
        xdgDataHome: '/tmp/forged-home/.local/share',
        xdgConfigHome: '/tmp/forged-home/.config',
        googleApplicationCredentials:
          '/tmp/forged-home/.config/gcloud/application_default_credentials.json',
      },
      cgroup: currentCgroupReceiptForTest(),
      project: {
        root: '/tmp/forged-project',
        projectPath: '/tmp/forged-project/project',
        token: 'forged-token',
        invocationId: 'forged-invocation',
        rootDev: '1',
        rootIno: '2',
        markerDev: '1',
        markerIno: '3',
      },
      accounting: {
        collectorId: createHash('sha256').update('forged-collector').digest('hex'),
        endpoint: '/tmp/forged-collector.sock',
        publicKey: forgedPublicKey,
        ledger: { dev: '1', ino: '2' },
        provenance: {
          dev: '1',
          ino: '3',
          sha256: createHash('sha256').update('forged-provenance').digest('hex'),
        },
        issuer: { id: forgedIssuerId, publicKey: forgedPublicKey },
      },
    });
    const forgedEnvelope = JSON.stringify({
      version: 2,
      issuerId: forgedIssuerId,
      payload: forgedPayload,
      signature: sign(null, Buffer.from(forgedPayload), forgedIssuer.privateKey).toString('base64'),
    });
    await fs.writeFile(capabilityPath, forgedEnvelope, { mode: 0o600 });
    await fs.writeFile(
      issuerPath,
      JSON.stringify({ version: 1, id: forgedIssuerId, publicKey: forgedPublicKey }),
      { mode: 0o600 }
    );
    const capabilityFd = openSync(capabilityPath, 'r');
    const issuerFd = openSync(issuerPath, 'r');
    await fs.unlink(capabilityPath);
    await fs.unlink(issuerPath);
    const procFd = openSync('/proc/self', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      const identity = readLinuxProcessIdentity('/proc/self');
      const procStat = fstatSync(procFd, { bigint: true });
      const capabilityStat = fstatSync(capabilityFd, { bigint: true });
      const issuerStat = fstatSync(issuerFd, { bigint: true });
      expect(identity).not.toBeNull();
      process.argv[0] = 'node';
      process.argv[1] = path.join(process.cwd(), 'scripts/prove-provider-launch-stress.mjs');
      process.title = 'prove-provider-launch-stress';
      // This invokes the same fixed-descriptor trust-root validator against
      // the forged descriptor itself. It is not an ignored environment-value
      // check: the complete signed capability is rejected because the anchor
      // is an unsealed regular file rather than the wrapper-created memfd.
      expect(readCapabilityAttestationBootstrap(capabilityFd)).toBeNull();
      // The test process has no wrapper-created sealed memfd. Even a complete
      // self-signed envelope and unlinked read-only descriptors therefore
      // cannot replace the missing wrapper trust anchor.
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID = String(process.pid);
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS = identity!.startTicks;
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_FD = String(procFd);
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_DEV = String(procStat.dev);
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PROC_INO = String(procStat.ino);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_FD = String(capabilityFd);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_DEV = String(capabilityStat.dev);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_INO = String(capabilityStat.ino);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_SHA256 = createHash('sha256')
        .update(forgedEnvelope)
        .digest('hex');
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_FD = String(issuerFd);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_DEV = String(issuerStat.dev);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_INO = String(issuerStat.ino);
      process.env.PROVIDER_LAUNCH_STRESS_CAPABILITY_ISSUER_SHA256 = createHash('sha256')
        .update(readFileSync(`/proc/self/fd/${issuerFd}`))
        .digest('hex');

      expect(getLiveStressAuthorization().ok).toBe(false);
    } finally {
      process.argv.splice(0, process.argv.length, ...previousArgv);
      process.title = previousTitle;
      closeSync(procFd);
      closeSync(capabilityFd);
      closeSync(issuerFd);
      for (const name of names) restoreEnv(name, previous[name]);
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', originalLive);
      await tombstoneTestDirectory(root);
    }
  });

  it('rejects all self-test flags before the release command can report green', () => {
    const script = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, PROVIDER_LAUNCH_STRESS_SELF_TEST: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rejects all self-test inputs');
  });

  it('does not treat mutable wrapper identity environment values as a replacement for wrapper authority', () => {
    if (process.platform !== 'linux') return;
    const previousLive = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    const previousPid = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID;
    const previousTicks = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS;
    try {
      process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID = String(process.pid);
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS = '0';
      expect(getLiveStressAuthorization().ok).toBe(initialLiveAuthorization.ok);
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', previousLive);
      restoreEnv('PROVIDER_LAUNCH_STRESS_WRAPPER_PID', previousPid);
      restoreEnv('PROVIDER_LAUNCH_STRESS_WRAPPER_START_TICKS', previousTicks);
    }
  });

  it('rejects a malicious forged parent that supplies its own sealed bootstrap, signing keys, attestor, and public release hash', async () => {
    if (process.platform !== 'linux') return;
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/prove-provider-launch-stress.mjs'
    );
    // `exec -a` makes the parent look like the public release wrapper. It also
    // controls every child-visible bootstrap/attestor key below. That is the
    // review regression: a child-only spoof check would accept this complete
    // self-issued trust graph unless the per-run admission verifies against
    // the separate private launcher capability.
    const customParent = spawn(
      'bash',
      ['-c', 'exec -a "$0" "$1" -e "setTimeout(() => {}, 5_000)"', wrapper, process.execPath],
      { stdio: 'ignore' }
    );
    try {
      expect(customParent.pid).toBeTypeOf('number');
      const forgedCmdline = readFileSync(`/proc/${customParent.pid}/cmdline`, 'utf8');
      expect(forgedCmdline).toContain(wrapper);
      const forgedIdentity = readLinuxProcessIdentity(`/proc/${customParent.pid}`);
      expect(forgedIdentity).not.toBeNull();
      // The forged graph keeps otherwise valid disposable auth, project and
      // accounting authorities. Its only trust failure is that its complete
      // canonical admission was signed by a key other than the independent
      // launcher capability compiled into the release worker.
      const { envelope: forgedCapability, trustedPrivateKey, issuerPrivateKey } =
        createTrustedCapabilityAdmissionFixture();
      forgedCapability.wrapperIdentity = createHash('sha256').update('forged-wrapper').digest('hex');
      forgedCapability.wrapperTrustAnchor = randomBytes(32).toString('hex');
      forgedCapability.wrapperScriptSha256 = createHash('sha256').update(readFileSync(wrapper)).digest('hex');
      forgedCapability.launcher = {
        pid: customParent.pid!, startTicks: forgedIdentity!.startTicks, procDev: '1', procIno: '1',
      };
      forgedCapability.cgroup = currentCgroupReceiptForTest();
      forgedCapability.attestor.endpoint = '/tmp/forged-attestor.sock';
      const forgedAdmissionPayload = canonicalizeCapabilityJson({
        domain: TRUSTED_LAUNCHER_CAPABILITY_ADMISSION_DOMAIN,
        version: 1,
        capability: runtimeCapabilityAdmissionScope(forgedCapability),
      });
      forgedCapability.trustedLauncherAdmission = {
        payload: forgedAdmissionPayload,
        signature: sign(null, Buffer.from(forgedAdmissionPayload), trustedPrivateKey).toString('base64'),
      };
      // Keep these independently valid so the expected rejection below cannot
      // be attributed to malformed disposable credentials, project identity,
      // or accounting provenance rather than launcher authentication.
      expect(isCapturedAuthContext(forgedCapability.auth)).toBe(true);
      expect(isDisposableProjectIdentity(forgedCapability.project)).toBe(true);
      expect(isAccountingCollectorCapability(forgedCapability.accounting)).toBe(true);
      expect(isCapabilityIssuer(forgedCapability.issuer)).toBe(true);
      expect(isCapabilityAttestor(forgedCapability.attestor)).toBe(true);
      const forgedCapabilityPayload = canonicalizeCapabilityJson(forgedCapability);
      const forgedEnvelope = JSON.stringify({
        version: 2, issuerId: forgedCapability.issuer.id, payload: forgedCapabilityPayload,
        signature: sign(null, Buffer.from(forgedCapabilityPayload), issuerPrivateKey).toString('base64'),
      });
      const previousLive = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
      try {
        process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
        expect(getLiveStressAuthorization(process.platform, () => ({
          wrapperIdentity: createHash('sha256').update('forged-wrapper').digest('hex'),
          wrapperTrustAnchor: forgedCapability.wrapperTrustAnchor,
          wrapperScriptSha256: forgedCapability.wrapperScriptSha256,
          wrapperPid: customParent.pid!, wrapperStartTicks: forgedIdentity!.startTicks,
          cgroup: forgedCapability.cgroup,
          attestor: forgedCapability.attestor,
          capability: Buffer.from(forgedEnvelope).toString('base64'),
          issuer: Buffer.from(JSON.stringify(forgedCapability.issuer)).toString('base64'),
        }))).toMatchObject({ ok: false });
      } finally {
        restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', previousLive);
      }
    } finally {
      customParent.kill('SIGTERM');
    }
  });

  it('does not authorize a canary when wrapper preflight is absent', () => {
    const live = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    const wrapperPid = process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID;
    delete process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    delete process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID;
    try {
      expect(isLiveStressAuthorized()).toBe(false);
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', live);
      restoreEnv('PROVIDER_LAUNCH_STRESS_WRAPPER_PID', wrapperPid);
    }
  });

  it('rejects a forged file/env preflight pair', async () => {
    const previous = {
      live: process.env.PROVIDER_LAUNCH_STRESS_LIVE,
      wrapperPid: process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID,
      token: process.env.PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY,
      file: process.env.PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY_FILE,
    };
    const file = path.join(os.tmpdir(), `provider-stress-forged-${process.pid}`);
    try {
      await fs.writeFile(file, 'forged', { mode: 0o600 });
      process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
      process.env.PROVIDER_LAUNCH_STRESS_WRAPPER_PID = String(process.pid);
      process.env.PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY = 'forged';
      process.env.PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY_FILE = file;
      expect(isLiveStressAuthorized()).toBe(false);
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', previous.live);
      restoreEnv('PROVIDER_LAUNCH_STRESS_WRAPPER_PID', previous.wrapperPid);
      restoreEnv('PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY', previous.token);
      restoreEnv('PROVIDER_LAUNCH_STRESS_PREFLIGHT_CAPABILITY_FILE', previous.file);
      await fs.writeFile(file, 'provider-stress test tombstone\n').catch(() => undefined);
    }
  });

  it('binds subscription config resolution to the selected custom config directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-custom-config-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = root;
      setClaudeBasePathOverride(root);
      expect(getClaudeBasePath()).toBe(root);
      expect(getTeamsBasePath()).toBe(path.join(root, 'teams'));
      expect(getTasksBasePath()).toBe(path.join(root, 'tasks'));
    } finally {
      setClaudeBasePathOverride(null);
      restoreEnv('CLAUDE_CONFIG_DIR', previous);
      await tombstoneTestDirectory(root);
    }
  });

  async function executeProvisionedWrapperOnDisposableProject(): Promise<void> {
    // This is deliberately a wrapper process, not a hand-built auth map.  It
    // reaches release verification and then fails its unavailable OpenCode
    // preflight before any provider launch; its retained disposable evidence
    // lets the assertions inspect exactly what the wrapper constructed.
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-wrapper-auth-source-'));
    const release = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-wrapper-release-'));
    let accountingLedgerFd: number | undefined;
    let accountingProvenanceFd: number | undefined;
    let accountingAuthorityFd: number | undefined;
    const trustedLauncherCapabilityFd =
      openProvisionedTrustedLauncherCapabilityForWrapperFixture();
    expect(
      trustedLauncherCapabilityFd,
      'optional environment lane was selected without a valid provisioned launcher descriptor'
    ).not.toBeNull();
    if (trustedLauncherCapabilityFd === null) {
      throw new Error('Optional environment lane requires a provisioned launcher descriptor.');
    }
    try {
      const claude = path.join(source, '.claude');
      const codex = path.join(source, '.codex');
      const xdgConfig = path.join(source, '.config');
      const adc = path.join(xdgConfig, 'gcloud', 'application_default_credentials.json');
      const openCodeAuth = path.join(xdgConfig, 'opencode', 'auth.json');
      await fs.mkdir(claude, { recursive: true });
      await fs.mkdir(path.join(codex, 'accounts'), { recursive: true });
      await fs.mkdir(path.dirname(adc), { recursive: true });
      await fs.mkdir(path.dirname(openCodeAuth), { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(claude, '.config.json'),
          JSON.stringify({ geminiLastAuthMethod: 'cli_oauth_personal', token: 'test-only-claude-token' })
        ),
        fs.writeFile(
          path.join(codex, 'auth.json'),
          JSON.stringify({ refresh_token: 'test-only-refresh-token' })
        ),
        fs.writeFile(
          adc,
          JSON.stringify({ type: 'authorized_user', refresh_token: 'test-only-adc-token' })
        ),
        fs.writeFile(openCodeAuth, JSON.stringify({ token: 'test-only-opencode-token' })),
      ]);
      const wrapper = path.join(release, 'release-cli');
      const entry = path.join(release, 'entry.js');
      const metadata = path.join(release, 'build-metadata.json');
      const lockfile = path.join(release, 'pnpm-lock.yaml');
      await Promise.all([
        fs.writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
        fs.writeFile(entry, 'export {};\n'),
        fs.writeFile(metadata, '{}\n'),
        fs.writeFile(lockfile, 'lockfileVersion: 9\n'),
      ]);
      const digest = async (file: string) =>
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      const files = await Promise.all(
        [wrapper, entry, metadata, lockfile].map(async (file) => ({
          path: file,
          sha256: await digest(file),
        }))
      );
      const manifest = path.join(release, 'release-payload.json');
      await fs.writeFile(
        manifest,
        JSON.stringify({
          version: 2,
          repository: { root: release },
          wrapperPath: wrapper,
          buildMetadata: {
            path: metadata,
            entryPath: entry,
            lockfilePath: lockfile,
            references: {
              [wrapper]: [entry],
              [entry]: [metadata],
              [metadata]: [lockfile],
              [lockfile]: [],
            },
          },
          files,
        })
      );
      const ledgerPath = path.join(release, 'collector-ledger');
      await fs.writeFile(ledgerPath, '');
      accountingLedgerFd = openSync(ledgerPath, 'r');
      const ledgerStat = fstatSync(accountingLedgerFd, { bigint: true });
      const issuer = generateKeyPairSync('ed25519');
      const issuerPublicKey = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const issuerId = createHash('sha256').update(issuerPublicKey).digest('hex');
      const authorityPath = path.join(release, 'collector-authority');
      await fs.writeFile(
        authorityPath,
        JSON.stringify({ version: 1, id: issuerId, publicKey: issuerPublicKey })
      );
      accountingAuthorityFd = openSync(authorityPath, 'r');
      const handoffPayload = JSON.stringify({
        version: 1,
        issuerId,
        ledger: { dev: String(ledgerStat.dev), ino: String(ledgerStat.ino) },
      });
      const provenancePath = path.join(release, 'collector-provenance');
      await fs.writeFile(
        provenancePath,
        JSON.stringify({
          version: 2,
          collectorId: createHash('sha256').update('wrapper-auth-fixture').digest('hex'),
          ledger: {
            dev: String(ledgerStat.dev),
            ino: String(ledgerStat.ino),
          },
          issuer: { id: issuerId, publicKey: issuerPublicKey },
          handoffPayload,
          handoffSignature: sign(null, Buffer.from(handoffPayload), issuer.privateKey).toString(
            'base64'
          ),
        })
      );
      accountingProvenanceFd = openSync(provenancePath, 'r');
      await Promise.all([fs.unlink(ledgerPath), fs.unlink(provenancePath), fs.unlink(authorityPath)]);
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../../scripts/prove-provider-launch-stress.mjs'
          ),
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
            accountingLedgerFd,
            accountingProvenanceFd,
            accountingAuthorityFd,
            // The release wrapper consumes the independently provisioned
            // private capability itself. It is deliberately FD 6 (not an env
            // selector) and is closed before the untrusted test worker starts.
            trustedLauncherCapabilityFd,
          ],
          env: {
            ...process.env,
            HOME: source,
            USERPROFILE: source,
            CLAUDE_CONFIG_DIR: claude,
            CODEX_HOME: codex,
            XDG_CONFIG_HOME: xdgConfig,
            GOOGLE_APPLICATION_CREDENTIALS: adc,
            ANTHROPIC_API_KEY: 'test-only',
            GEMINI_API_KEY: 'test-only',
            CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: wrapper,
            PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_PATH: wrapper,
            PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_SHA256: await digest(wrapper),
            PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST: manifest,
            PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST_SHA256: await digest(manifest),
            PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL: 'intentionally-unavailable',
            PROVIDER_LAUNCH_STRESS_ACCOUNTING_COLLECTOR_FD: '3',
            PROVIDER_LAUNCH_STRESS_ACCOUNTING_PROVENANCE_SOURCE_FD: '4',
            PROVIDER_LAUNCH_STRESS_ACCOUNTING_AUTHORITY_FD: '5',
          },
        }
      );
      expect(result.status).not.toBe(0);
      const project = /Disposable project root: (.+)/.exec(result.stdout)?.[1]?.trim();
      expect(project, result.stderr || result.stdout).toBeTruthy();
      const root = path.dirname(project!);
      // Failure evidence remains available, but every copied provider root is
      // removed before it can be retained. Checking exact fixture secrets
      // catches a regression that merely redacts filenames or one provider.
      const retainedFiles = await listRegularFilesRecursively(root);
      const retainedContents = await Promise.all(
        retainedFiles.map(async (file) => fs.readFile(file, 'utf8').catch(() => ''))
      );
      const retainedEvidence = retainedContents.join('\n');
      expect(retainedEvidence).not.toContain('test-only-refresh-token');
      expect(retainedEvidence).not.toContain('test-only-adc-token');
      expect(retainedEvidence).not.toContain('test-only-claude-token');
      expect(retainedEvidence).not.toContain('test-only-opencode-token');
      await expect(fs.access(path.join(root, 'provider-claude-config', '.config.json'))).rejects.toThrow();
      await expect(fs.access(path.join(root, 'provider-codex-home'))).rejects.toThrow();
      await expect(fs.access(path.join(root, 'provider-xdg-config', 'opencode'))).rejects.toThrow();
      await expect(
        fs.access(path.join(root, 'provider-xdg-config', 'gcloud', 'application_default_credentials.json'))
      ).rejects.toThrow();
      const isolatedAdc = path.join(
        root,
        'provider-xdg-config',
        'gcloud',
        'application_default_credentials.json'
      );
      const receipt = JSON.parse(
        await fs.readFile(
          path.join(root, '.provider-launch-stress-capability-receipt.json'),
          'utf8'
        )
      ) as {
        serializedCapabilitySha256: string;
        serializedAuth: { googleApplicationCredentials: string; codexHome: string };
        downstreamEnvironment: {
          GOOGLE_APPLICATION_CREDENTIALS: string;
          NODE_OPTIONS: string | null;
          NODE_PATH: string | null;
          NODE_REPL_EXTERNAL_MODULE: string | null;
          NODE_PRESERVE_SYMLINKS: string | null;
          NODE_PRESERVE_SYMLINKS_MAIN: string | null;
        };
      };
      // The retained receipt is read back from the wrapper's unlinked
      // descriptor. Checking both fields makes this fail if the wrapper stops
      // rewriting ADC for the actual downstream Vitest environment.
      expect(receipt.serializedCapabilitySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.serializedAuth.googleApplicationCredentials).toBe(isolatedAdc);
      expect(receipt.serializedAuth.codexHome).toBe(path.join(root, 'provider-codex-home'));
      expect(receipt.downstreamEnvironment.GOOGLE_APPLICATION_CREDENTIALS).toBe(isolatedAdc);
      expect(receipt.downstreamEnvironment.GOOGLE_APPLICATION_CREDENTIALS).not.toBe(adc);
      expect(receipt.downstreamEnvironment).toMatchObject({
        NODE_OPTIONS: null,
        NODE_PATH: null,
        NODE_REPL_EXTERNAL_MODULE: null,
        NODE_PRESERVE_SYMLINKS: null,
        NODE_PRESERVE_SYMLINKS_MAIN: null,
      });
    } finally {
      if (accountingLedgerFd !== undefined) closeSync(accountingLedgerFd);
      if (accountingProvenanceFd !== undefined) closeSync(accountingProvenanceFd);
      if (accountingAuthorityFd !== undefined) closeSync(accountingAuthorityFd);
      closeSync(trustedLauncherCapabilityFd);
      // No fixture pathname is recursively deleted: retained evidence is safer
      // than a cleanup which could re-resolve an attacker replacement.
      await tombstoneTestDirectory(source);
      await tombstoneTestDirectory(release);
    }
  }

  it('consumes the trusted-launcher-signed disposable project capability without receiving FD6', () => {
    // The mandatory positive lane is the release launcher itself: it creates
    // the disposable project and signs its exact runtime capability while FD6
    // is still private to that launcher. The worker may prove that signed
    // binding, but must never require (or receive) the launcher private key.
    const authorization = getLiveStressAuthorization();
    expect(authorization.ok, authorization.reason).toBe(true);
    expect(authorization.project).toMatchObject({
      root: expect.stringMatching(/^\//),
      projectPath: expect.stringMatching(/^\//),
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      invocationId: expect.any(String),
    });
    expect(authorization.project?.projectPath.startsWith(`${authorization.project?.root}/`)).toBe(true);
  });

  // Keep the environment-gated lane separate from the mandatory FD6 proof:
  // it is useful to exercise runner injection independently when present.
  const optionalProvisionedLauncherCapability = Number.parseInt(
    process.env.PROVIDER_LAUNCH_STRESS_TEST_TRUSTED_LAUNCHER_CAPABILITY_FD ?? '',
    10
  );
  const optionalEnvironmentIt = Number.isSafeInteger(optionalProvisionedLauncherCapability)
    ? it
    : it.skip;
  optionalEnvironmentIt('optional environment lane: executes wrapper and verifies isolated project/auth/capability serialization', async () => {
    await executeProvisionedWrapperOnDisposableProject();
  }, 45_000);

  it('retains an explicit null artifact in manifest-load diagnostics', async () => {
    const diagnostics = await formatStressDiagnostics(
      createProviderLaunchStressService(),
      `missing-artifact-${process.pid}`,
      []
    );
    expect(JSON.parse(diagnostics).artifact).toBeNull();
  });

  it('serializes delayed production store and bridge mutations at their real boundaries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-cancellation-'));
    const storePath = path.join(root, 'diagnostics.json');
    const diagnostics: string[] = [];
    const store = new VersionedJsonStore<string[]>({
      filePath: storePath,
      schemaVersion: 1,
      defaultData: () => [],
      validate: (value) => Array.isArray(value) ? value.map(String) : [],
    });
    await store.updateLocked(() => ['baseline']);
    const before = await fs.readFile(storePath, 'utf8');
    let releaseLock!: () => void;
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });
    const holder = withFileLock(storePath, async () => {
      markLockHeld();
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await lockHeld;
    const pendingStoreWrite = store.updateLocked(
      (rows) => {
        diagnostics.push('store lock acquired');
        return [...rows, 'delayed-commit'];
      }
    );
    releaseLock();
    await holder;
    await expect(pendingStoreWrite).resolves.toMatchObject({ changed: true });
    expect(await fs.readFile(storePath, 'utf8')).not.toBe(before);
    expect(diagnostics).toEqual(['store lock acquired']);

    let releaseEnvironment!: () => void;
    let markEnvironmentWait!: () => void;
    const environmentWait = new Promise<void>((resolve) => { markEnvironmentWait = resolve; });
    let dispatched = 0;
    const bridge = new OpenCodeBridgeCommandClient({
      binaryPath: process.execPath,
      tempDirectory: root,
      envProvider: async () => {
        markEnvironmentWait();
        await new Promise<void>((resolve) => { releaseEnvironment = resolve; });
        return process.env;
      },
      processRunner: { run: async () => {
        dispatched += 1;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      } },
    });
    const readinessBridge = new OpenCodeReadinessBridge(bridge, { cleanupTimeoutMs: 1_000 });
    const pendingBridge = readinessBridge.cleanupOpenCodeHosts(
      {
        reason: 'test-harness-dispose',
        mode: 'force',
        projectPath: root,
      }
    );
    await environmentWait;
    releaseEnvironment();
    await expect(pendingBridge).resolves.toMatchObject({ cleaned: 0, remaining: 0 });
    expect(dispatched).toBe(1);
    expect(readdirSync(root).filter((name) => name.includes('opencode-command-'))).toHaveLength(1);
    await tombstoneTestDirectory(root);
  });

  it('refuses cancelled teardown mutations before invoking real stop or disposal boundaries', async () => {
    const controller = new AbortController();
    controller.abort(new Error('deterministic cancellation'));
    const events: string[] = [];
    const active = createActiveScenarioFixture({
      teamName: 'teardown-cancelled-before-mutation',
      svc: { stopTeam: async () => { events.push('stop mutation'); } },
    });
    const harness = {
      dispose: async () => { events.push('harness mutation'); },
      svc: active.svc,
    } satisfies ProviderLaunchStressHarness;
    active.teardown = createCancellationAwareTeardown({ active, harness });
    await expect(
      invokeAbortableStopTeam(active, { signal: controller.signal, deadline: Date.now() + 10_000 })
    ).rejects.toThrow(/cancellation boundary/i);
    await expect(
      invokeAbortableHarnessDispose(active, {
        signal: controller.signal,
        deadline: Date.now() + 10_000,
      })
    ).rejects.toThrow(/cancellation boundary/i);
    expect(events).toEqual([]);
  });

  it('checks cancellation authority around the real stopTeam boundary', async () => {
    const controller = new AbortController();
    const authority = { signal: controller.signal, deadline: Date.now() + 10_000 };
    const observed: string[] = [];
    const active = createActiveScenarioFixture({
      teamName: 'real-deadline-aware-boundaries',
      svc: {
        stopTeam: async (teamName: string) => {
          expect(teamName).toBe('real-deadline-aware-boundaries');
          await Promise.resolve();
          observed.push('stop');
        },
      },
    });
    active.teardown = createCancellationAwareTeardown({ active });

    await invokeAbortableStopTeam(active, authority);
    expect(observed).toEqual(['stop']);
  });

  it('rejects self-declared collector identity without independent signing authority', () => {
    const forgedCollectorId = createHash('sha256').update('forged-issuer').digest('hex');
    expect(
      isAccountingCollectorCapability({
        collectorId: forgedCollectorId,
        endpoint: '/tmp/forged-collector.sock',
        ledger: { dev: '1', ino: '2' },
        provenance: { dev: '1', ino: '3', sha256: forgedCollectorId },
      })
    ).toBe(false);
  });

  it('prevents an outside host-alias mutation from changing the production sealed backing', async () => {
    if (process.platform !== 'linux') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-sealed-payload-'));
    const hostAlias = path.join(root, 'host-alias-payload');
    const releasePayload = path.join(root, 'payload');
    const releaseManifest = path.join(root, 'manifest.json');
    try {
      await fs.writeFile(releasePayload, 'verified production bytes', { mode: 0o600 });
      // This must be a second name for the *same* host backing inode.  Two
      // independent files only prove that changing an unrelated file does not
      // change the sealed copy; they do not exercise the host-alias attack.
      await fs.link(releasePayload, hostAlias);
      const [aliasIdentity, payloadIdentity] = await Promise.all([
        fs.stat(hostAlias, { bigint: true }),
        fs.stat(releasePayload, { bigint: true }),
      ]);
      if (aliasIdentity.dev !== payloadIdentity.dev || aliasIdentity.ino !== payloadIdentity.ino) {
        throw new Error('Host-alias fixture requires the expected same-inode descriptor identity.');
      }
      await fs.writeFile(releaseManifest, '{"version":1}\n', { mode: 0o600 });
      const attack = spawnSync(
        'unshare',
        [
          '--user',
          '--map-root-user',
          '--mount',
          '--fork',
          '--',
          'python3',
          '-c',
          readSealedPayloadLauncherForTest(),
          root,
          process.execPath,
          '-e',
          "const fs=require('node:fs'); fs.writeFileSync(process.argv[1],'forged through host alias'); if(fs.readFileSync(process.env.TEST_SEALED_PAYLOAD_PATH,'utf8') !== 'verified production bytes') process.exit(97)",
          hostAlias,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_PAYLOAD: JSON.stringify([
              { realPath: releasePayload, role: 'wrapper' },
            ]),
            PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_PATH: releaseManifest,
            TEST_SEALED_PAYLOAD_PATH: releasePayload,
          },
        }
      );
      // This executes the exact release namespace launcher. A generic
      // non-zero result must never turn unavailable namespace support into a
      // passing alias regression.
      expect(attack.error, attack.stderr).toBeUndefined();
      expect(attack.status, attack.stderr).toBe(0);
      await expect(fs.readFile(hostAlias, 'utf8')).resolves.toBe('forged through host alias');
      await expect(fs.readFile(releasePayload, 'utf8')).resolves.toBe('forged through host alias');
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('keeps collector descriptors outside a sibling worker and rejects tampered snapshots', async () => {
    if (process.platform !== 'linux') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-collector-boundary-'));
    let ledgerFd: number | undefined;
    let ledgerWriterFd: number | undefined;
    let provenanceFd: number | undefined;
    let authorityFd: number | undefined;
    let collector: ReturnType<typeof spawn> | undefined;
    try {
      const ledgerPath = path.join(root, 'ledger');
      await fs.writeFile(ledgerPath, '');
      ledgerWriterFd = openSync(ledgerPath, 'w');
      ledgerFd = openSync(ledgerPath, 'r');
      const ledger = fstatSync(ledgerFd, { bigint: true });
      const issuer = generateKeyPairSync('ed25519');
      const issuerPublicKey = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const issuerId = createHash('sha256').update(issuerPublicKey).digest('hex');
      const authorityPath = path.join(root, 'authority');
      await fs.writeFile(
        authorityPath,
        JSON.stringify({ version: 1, id: issuerId, publicKey: issuerPublicKey })
      );
      authorityFd = openSync(authorityPath, 'r');
      const provenancePath = path.join(root, 'provenance');
      await fs.writeFile(
        provenancePath,
        JSON.stringify({
          version: 2,
          ledger: { dev: String(ledger.dev), ino: String(ledger.ino) },
          issuer: { id: issuerId, publicKey: issuerPublicKey },
        })
      );
      provenanceFd = openSync(provenancePath, 'r');
      const provenance = fstatSync(provenanceFd, { bigint: true });
      const provenanceSha256 = createHash('sha256')
        .update(readPinnedDescriptorBytes(provenanceFd, Number(provenance.size)))
        .digest('hex');
      await Promise.all([
        fs.chmod(ledgerPath, 0o000),
        fs.chmod(provenancePath, 0o000),
        fs.chmod(authorityPath, 0o000),
      ]);
      await Promise.all([fs.unlink(ledgerPath), fs.unlink(provenancePath), fs.unlink(authorityPath)]);
      const endpoint = path.join(root, 'collector.sock');
      collector = spawn(
        'unshare',
        [
          '--user',
          '--map-root-user',
          '--',
          process.execPath,
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../../scripts/prove-provider-launch-stress.mjs'
          ),
          '--provider-launch-stress-accounting-collector',
        ],
        {
          env: { ...process.env, PROVIDER_LAUNCH_STRESS_COLLECTOR_SOCKET: endpoint },
          stdio: ['ignore', 'pipe', 'pipe', ledgerFd, provenanceFd, authorityFd],
        }
      );
      const ready = await readCollectorReadyForTest(collector, endpoint);
      const attack = spawnSync(
        process.execPath,
        [
          '-e',
          "const fs=require('node:fs'); const target=process.argv[1]; const fd=fs.openSync(target,'r+'); fs.writeFileSync(fd,'forged receipt'); fs.fchmodSync(fd,0o600)",
          `/proc/${collector.pid}/fd/3`,
        ],
        { encoding: 'utf8' }
      );
      expect(attack.status).not.toBe(0);
      // Linux permits chmod through a proc-fd pathname even when the target's
      // descriptor table is ptrace-isolated.  That metadata operation must
      // still not recover a writable description or permit byte tampering.
      const chmodAttack = spawnSync(
        process.execPath,
        ['-e', "require('node:fs').chmodSync(process.argv[1],0o600)", `/proc/${collector.pid}/fd/3`],
        { encoding: 'utf8' }
      );
      expect(chmodAttack.status).toBe(0);
      const writableAfterChmod = spawnSync(
        process.execPath,
        [
          '-e',
          "const fs=require('node:fs'); const fd=fs.openSync(process.argv[1],'r+'); fs.writeFileSync(fd,'forged receipt')",
          `/proc/${collector.pid}/fd/3`,
        ],
        { encoding: 'utf8' }
      );
      expect(writableAfterChmod.status).not.toBe(0);
      const accounting: PinnedAccountingLedger = {
        endpoint,
        publicKey: ready.publicKey,
        collectorId: ready.collectorId,
        dev: String(ledger.dev),
        ino: String(ledger.ino),
        provenanceDev: String(provenance.dev),
        provenanceIno: String(provenance.ino),
        provenanceSha256,
        issuerId,
        issuerPublicKey,
      };
      const signed = await requestAuthenticatedCollectorSnapshot(accounting);
      const payload = JSON.stringify(signed.payload);
      expect(cryptoVerifyCollectorSnapshot(`${payload}tampered`, 'invalid', ready.publicKey)).toBe(
        false
      );
      // The only remaining writer is deliberately hostile. A collector must
      // reject, rather than sign, arbitrary caller bytes even though their
      // inode and snapshot hash are unchanged.
      writeSync(ledgerWriterFd, `${JSON.stringify({ teamName: 'forged' })}\n`);
      await expect(requestAuthenticatedCollectorSnapshot(accounting)).rejects.toThrow(
        /unauthenticated producer record/i
      );
    } finally {
      collector?.kill('SIGTERM');
      if (ledgerFd !== undefined) closeSync(ledgerFd);
      if (ledgerWriterFd !== undefined) closeSync(ledgerWriterFd);
      if (provenanceFd !== undefined) closeSync(provenanceFd);
      if (authorityFd !== undefined) closeSync(authorityFd);
      await tombstoneTestDirectory(root);
    }
  });

  it('refuses the real terminal producer acknowledgement while an external ledger writer survives', async () => {
    if (process.platform !== 'linux') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-producer-seal-'));
    let ledgerFd: number | undefined;
    let externalWriterFd: number | undefined;
    let keyFd: number | undefined;
    let producer: ReturnType<typeof spawn> | undefined;
    try {
      const ledgerPath = path.join(root, 'ledger');
      const keyPath = path.join(root, 'producer-key');
      const key = generateKeyPairSync('ed25519');
      await fs.writeFile(ledgerPath, '');
      await fs.writeFile(keyPath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      ledgerFd = openSync(ledgerPath, 'r+');
      // This fd is deliberately not in the producer. A terminal signature
      // cannot be accepted while this external writable description exists.
      externalWriterFd = openSync(ledgerPath, 'r+');
      keyFd = openSync(keyPath, 'r');
      await Promise.all([fs.unlink(ledgerPath), fs.unlink(keyPath)]);
      const endpoint = path.join(root, 'producer.sock');
      producer = spawn(
        process.execPath,
        [
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../../scripts/prove-provider-launch-stress.mjs'
          ),
          '--provider-launch-stress-accounting-producer',
        ],
        {
          env: {
            ...process.env,
            PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET: endpoint,
            PROVIDER_LAUNCH_STRESS_PRODUCER_ID: 'producer-terminal-regression',
          },
          stdio: ['ignore', 'ignore', 'pipe', ledgerFd, keyFd],
        }
      );
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await fs.stat(endpoint).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await fs.stat(endpoint).then(() => true, () => false)).toBe(true);
      const responseLine = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let received = '';
        socket.setEncoding('utf8');
        socket.setTimeout(2_000);
        socket.once('connect', () => socket.write(`seal ${'a'.repeat(64)}\n`));
        socket.on('data', (chunk) => {
          received += chunk;
          const newline = received.indexOf('\n');
          if (newline < 0) return;
          socket.destroy();
          resolve(received.slice(0, newline));
        });
        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('producer terminal seal timed out')));
      });
      expect(JSON.parse(responseLine).error).toMatch(/exclusive ledger ownership/i);
    } finally {
      producer?.kill('SIGTERM');
      if (ledgerFd !== undefined) closeSync(ledgerFd);
      if (externalWriterFd !== undefined) closeSync(externalWriterFd);
      if (keyFd !== undefined) closeSync(keyFd);
      await tombstoneTestDirectory(root);
    }
  });

  it('captures an append-and-close race only after exclusive ledger admission', async () => {
    if (process.platform !== 'linux') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-producer-final-size-'));
    let ledgerFd: number | undefined;
    let racingWriterFd: number | undefined;
    let keyFd: number | undefined;
    let producer: ReturnType<typeof spawn> | undefined;
    try {
      const ledgerPath = path.join(root, 'ledger');
      const keyPath = path.join(root, 'producer-key');
      const key = generateKeyPairSync('ed25519');
      await fs.writeFile(ledgerPath, '');
      await fs.writeFile(keyPath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      ledgerFd = openSync(ledgerPath, 'r+');
      // Keep this writer open while the producer first attempts its exclusive
      // lease, then append and close. The final signed snapshot must include
      // this last record rather than the size observed before admission.
      racingWriterFd = openSync(ledgerPath, 'r+');
      keyFd = openSync(keyPath, 'r');
      await Promise.all([fs.unlink(ledgerPath), fs.unlink(keyPath)]);
      const endpoint = path.join(root, 'producer.sock');
      producer = spawn(
        process.execPath,
        [
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../../scripts/prove-provider-launch-stress.mjs'
          ),
          '--provider-launch-stress-accounting-producer',
        ],
        {
          env: {
            ...process.env,
            PROVIDER_LAUNCH_STRESS_PRODUCER_SOCKET: endpoint,
            PROVIDER_LAUNCH_STRESS_PRODUCER_ID: 'producer-final-size-regression',
          },
          stdio: ['ignore', 'ignore', 'pipe', ledgerFd, keyFd],
        }
      );
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await fs.stat(endpoint).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await fs.stat(endpoint).then(() => true, () => false)).toBe(true);
      const responseLine = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let received = '';
        socket.setEncoding('utf8');
        socket.setTimeout(3_000);
        socket.once('connect', () => {
          socket.write(`seal ${'b'.repeat(64)}\n`);
          setTimeout(() => {
            if (racingWriterFd === undefined) return;
            writeSync(racingWriterFd, '{"race":"append-and-close"}\n');
            closeSync(racingWriterFd);
            racingWriterFd = undefined;
          }, 25);
        });
        socket.on('data', (chunk) => {
          received += chunk;
          const newline = received.indexOf('\n');
          if (newline < 0) return;
          socket.destroy();
          resolve(received.slice(0, newline));
        });
        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('producer final-size seal timed out')));
      });
      const response = JSON.parse(responseLine) as { payload?: string; error?: string };
      expect(response.error).toBeUndefined();
      expect(response.payload).toBeTypeOf('string');
      const acknowledgement = JSON.parse(response.payload!) as {
        receipts: string;
        finalSequence: number;
      };
      expect(Buffer.from(acknowledgement.receipts, 'base64').toString('utf8')).toBe(
        '{"race":"append-and-close"}\n'
      );
      expect(acknowledgement.finalSequence).toBe(1);
    } finally {
      producer?.kill('SIGTERM');
      if (ledgerFd !== undefined) closeSync(ledgerFd);
      if (racingWriterFd !== undefined) closeSync(racingWriterFd);
      if (keyFd !== undefined) closeSync(keyFd);
      await tombstoneTestDirectory(root);
    }
  });

  it('rejects an unowned project-path override instead of accepting an arbitrary directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-unowned-project-'));
    const project = path.join(root, 'project');
    const previous = {
      root: process.env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT,
      project: process.env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH,
      token: process.env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN,
      invocationId: process.env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID,
      reservationManifest: process.env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST,
    };
    try {
      await fs.mkdir(project);
      const realRoot = await fs.realpath(root);
      const realProject = await fs.realpath(project);
      const invocationId = randomUUID();
      const reservationManifest = path.join(
        realRoot,
        '.provider-launch-stress-failure-reservations.json'
      );
      // Supply every wrapper field and both on-root files.  The owner marker's
      // deliberately different token is the only rejected evidence, so this
      // fixture cannot accidentally prove only an incomplete/ENOENT branch.
      await fs.writeFile(
        path.join(realRoot, '.provider-launch-stress-owner.json'),
        `${JSON.stringify({ version: 1, root: realRoot, projectPath: realProject, token: 'marker-not-env-token', invocationId })}\n`,
        { mode: 0o600 }
      );
      await fs.writeFile(
        reservationManifest,
        `${JSON.stringify({ version: 1, root: realRoot, token: 'forged', invocationId, reservations: [] })}\n`,
        { mode: 0o600 }
      );
      process.env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT = root;
      process.env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH = project;
      process.env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN = 'forged';
      process.env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID = invocationId;
      process.env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST = reservationManifest;
      await expect(acquireDisposableProject()).rejects.toThrow(
        /not proven to be an owned disposable root/i
      );
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_PROJECT_ROOT', previous.root);
      restoreEnv('PROVIDER_LAUNCH_STRESS_PROJECT_PATH', previous.project);
      restoreEnv('PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN', previous.token);
      restoreEnv('PROVIDER_LAUNCH_STRESS_INVOCATION_ID', previous.invocationId);
      restoreEnv(
        'PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST',
        previous.reservationManifest
      );
      await tombstoneTestDirectory(root);
    }
  });

  it('refuses a replaced disposable owner marker before a recursive cleanup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-marker-replacement-'));
    const projectPath = path.join(root, 'project');
    const markerPath = path.join(root, '.provider-launch-stress-owner.json');
    const token = randomBytes(32).toString('hex');
    try {
      await fs.mkdir(projectPath);
      const realRoot = await fs.realpath(root);
      const realProjectPath = await fs.realpath(projectPath);
      await fs.writeFile(
        markerPath,
        `${JSON.stringify({ version: 1, root: realRoot, projectPath: realProjectPath, token })}\n`,
        { mode: 0o600 }
      );
      const [rootIdentity, projectIdentity, markerIdentity] = await Promise.all([
        openNoFollowIdentity(realRoot, true),
        openNoFollowIdentity(realProjectPath, true),
        openNoFollowIdentity(markerPath, false),
      ]);
      const disposable: DisposableProject = {
        root: realRoot,
        projectPath: realProjectPath,
        token,
        wrapperOwned: false,
        rootDev: String(rootIdentity.dev),
        rootIno: String(rootIdentity.ino),
        projectDev: String(projectIdentity.dev),
        projectIno: String(projectIdentity.ino),
        markerDev: String(markerIdentity.dev),
        markerIno: String(markerIdentity.ino),
      };
      await assertOwnedDisposableProject(disposable);
      await fs.rename(markerPath, `${markerPath}.replaced`);
      await fs.writeFile(
        markerPath,
        `${JSON.stringify({ version: 1, root: realRoot, projectPath: realProjectPath, token })}\n`,
        { mode: 0o600 }
      );
      await expect(assertOwnedDisposableProject(disposable)).rejects.toThrow(
        /root or owner marker identity changed/i
      );
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('rejects a replaced or symlinked disposable project directory before a provider effect', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-project-replacement-'));
    const projectPath = path.join(root, 'project');
    const markerPath = path.join(root, '.provider-launch-stress-owner.json');
    const token = randomBytes(32).toString('hex');
    try {
      await fs.mkdir(projectPath);
      const realRoot = await fs.realpath(root);
      const realProjectPath = await fs.realpath(projectPath);
      await fs.writeFile(
        markerPath,
        `${JSON.stringify({ version: 1, root: realRoot, projectPath: realProjectPath, token })}\n`,
        { mode: 0o600 }
      );
      const [rootIdentity, projectIdentity, markerIdentity] = await Promise.all([
        openNoFollowIdentity(realRoot, true),
        openNoFollowIdentity(realProjectPath, true),
        openNoFollowIdentity(markerPath, false),
      ]);
      const disposable: DisposableProject = {
        root: realRoot,
        projectPath: realProjectPath,
        token,
        wrapperOwned: false,
        rootDev: String(rootIdentity.dev),
        rootIno: String(rootIdentity.ino),
        projectDev: String(projectIdentity.dev),
        projectIno: String(projectIdentity.ino),
        markerDev: String(markerIdentity.dev),
        markerIno: String(markerIdentity.ino),
      };
      await assertOwnedDisposableProject(disposable);

      const replacedProjectPath = `${projectPath}.replaced`;
      await fs.rename(projectPath, replacedProjectPath);
      await fs.mkdir(projectPath);
      await expect(assertOwnedDisposableProject(disposable)).rejects.toThrow(
        /root or owner marker identity changed/i
      );

      await fs.rmdir(projectPath);
      await fs.symlink(path.basename(replacedProjectPath), projectPath);
      await expect(assertOwnedDisposableProject(disposable)).rejects.toThrow(
        /replaced or symlinked disposable path/i
      );
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('rejects source artifacts even when their bytes match the claimed digest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-source-artifact-'));
    const sourceArtifact = path.join(root, 'cli-source');
    const previous = {
      path: process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH,
      sha: process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_SHA256,
    };
    try {
      await fs.writeFile(sourceArtifact, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH = sourceArtifact;
      process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_SHA256 = createHash('sha256')
        .update(await fs.readFile(sourceArtifact))
        .digest('hex');
      await expect(assertVerifiedReleaseArtifact(sourceArtifact)).rejects.toThrow(
        /source, dev, or foreign/i
      );
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH', previous.path);
      restoreEnv('PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_SHA256', previous.sha);
      await tombstoneTestDirectory(root);
    }
  });

  it('rejects a release payload mutation between canary scenarios', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-payload-mutation-'));
    const artifact = path.join(root, 'release-cli');
    try {
      await fs.writeFile(artifact, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const entryFile = path.join(root, 'entry.js');
      const buildMetadataFile = path.join(root, 'build-metadata.json');
      const lockfile = path.join(root, 'pnpm-lock.yaml');
      await Promise.all([
        fs.writeFile(entryFile, 'export {};\n'),
        fs.writeFile(buildMetadataFile, '{"references":true}\n'),
        fs.writeFile(lockfile, 'lockfileVersion: 9\n'),
      ]);
      const makeEntry = async (
        filePath: string,
        role: ReleasePayloadEntry['role']
      ): Promise<ReleasePayloadEntry> => {
        const stats = await fs.stat(filePath, { bigint: true });
        return {
          realPath: await fs.realpath(filePath),
          sha256: createHash('sha256')
            .update(await fs.readFile(filePath))
            .digest('hex'),
          dev: String(stats.dev),
          ino: String(stats.ino),
          size: String(stats.size),
          role,
        };
      };
      const [entry, builtEntry, metadataEntry, lockEntry] = await Promise.all([
        makeEntry(artifact, 'wrapper'),
        makeEntry(entryFile, 'entry'),
        makeEntry(buildMetadataFile, 'build-metadata'),
        makeEntry(lockfile, 'lockfile'),
      ]);
      const manifest = path.join(root, 'release-payload.json');
      await fs.writeFile(
        manifest,
        JSON.stringify({
          version: 2,
          repository: { root },
          wrapperPath: entry.realPath,
          buildMetadata: {
            path: metadataEntry.realPath,
            entryPath: builtEntry.realPath,
            lockfilePath: lockEntry.realPath,
            references: {
              [entry.realPath]: [builtEntry.realPath],
              [builtEntry.realPath]: [metadataEntry.realPath],
              [metadataEntry.realPath]: [lockEntry.realPath],
              [lockEntry.realPath]: [],
            },
          },
          files: [entry, builtEntry, metadataEntry, lockEntry].map(({ realPath, sha256 }) => ({
            path: realPath,
            sha256,
          })),
        })
      );
      const wrapper = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../scripts/prove-provider-launch-stress.mjs'
      );
      const fixtureEnv = {
        ...process.env,
        CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: entry.realPath,
        PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_PATH: entry.realPath,
        PROVIDER_LAUNCH_STRESS_EXPECTED_ORCHESTRATOR_SHA256: entry.sha256,
        PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST: manifest,
        PROVIDER_LAUNCH_STRESS_RELEASE_PAYLOAD_MANIFEST_SHA256: createHash('sha256')
          .update(await fs.readFile(manifest))
          .digest('hex'),
      };
      // The private fixture enters through the signed wrapper identity and
      // calls the release script's real descriptor/closure verifier. Its
      // positive result is the authorized baseline; no test-side copy of the
      // guard or unsigned environment-only closure can make this pass.
      const runGuard = () =>
        spawnSync(process.execPath, [wrapper, '--provider-launch-stress-release-closure-fixture'], {
          encoding: 'utf8',
          timeout: 10_000,
          env: fixtureEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      const baseline = runGuard();
      expect(baseline.status, baseline.stderr).toBe(0);
      expect(JSON.parse(baseline.stdout)).toMatchObject({ ok: true, sha256: entry.sha256 });
      await fs.chmod(artifact, 0o700);
      await fs.appendFile(artifact, '# mutation\n');
      const changed = runGuard();
      expect(changed.status).not.toBe(0);
      expect(JSON.parse(changed.stdout)).toMatchObject({ ok: false });
      expect(changed.stdout).toMatch(/descriptor changed|release artifact/i);
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('refuses a release descriptor after a pathname symlink swap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-release-symlink-'));
    const release = path.join(root, 'release-cli');
    const replacement = path.join(root, 'replacement-cli');
    try {
      await fs.writeFile(release, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await fs.writeFile(replacement, '#!/bin/sh\necho replacement\n', { mode: 0o700 });
      const descriptor = openVerifiedReleaseDescriptor(release);
      closeSync(descriptor.fd);
      await fs.rename(release, `${release}.original`);
      await fs.symlink(replacement, release);
      expect(() => openVerifiedReleaseDescriptor(release, descriptor)).toThrow(/ELOOP|descriptor/i);
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('treats an atomic ownership-lock collision as a failure without touching a team', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-team-collision-'));
    const teamName = `provider-stress-collision-${randomUUID()}`;
    try {
      setClaudeBasePathOverride(root);
      const first = await acquireTeamOwnership(teamName);
      await expect(acquireTeamOwnership(teamName)).rejects.toThrow(/collision/i);
      await fs.writeFile(first.lockPath, 'provider-stress test tombstone\n');
      await expect(fs.lstat(path.join(getTeamsBasePath(), teamName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      setClaudeBasePathOverride(null);
      await tombstoneTestDirectory(root);
    }
  });

  it('cleans a partial create whose ownership marker could not be written', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-partial-create-'));
    const teamName = `provider-stress-partial-${randomUUID()}`;
    try {
      setClaudeBasePathOverride(root);
      const ownership = await acquireTeamOwnership(teamName);
      const teamPath = path.join(getTeamsBasePath(), teamName);
      await fs.mkdir(teamPath, { recursive: true });
      await fs.mkdir(path.join(getTasksBasePath(), teamName), { recursive: true });
      const stopTeam = vi.fn(async (_teamName: string) => undefined);
      const active = createActiveScenarioFixture({
        teamName,
        ownership,
        phase: 'created',
        markerWritten: false,
        capturedProcesses: new Map(),
        launchProcessReceipts: new Map(),
        teardownDiagnostics: [],
        dispatchClosed: false,
        dispatchAbortController: new AbortController(),
        inFlightDispatches: new Set(),
        launchIdentityObservations: new Set(),
        teardownStarted: false,
        pendingTeardownReceipts: new Map(),
        cleanupEffects: new Map(),
        cleanupAbortController: new AbortController(),
        created: true,
        failed: true,
        svc: {
          getTeamAgentRuntimeSnapshot: vi.fn(async () => createEmptyRuntimeSnapshot(teamName)),
          stopTeam,
        },
        teardown: {
          stopTeam: async ({ signal, deadline }) => {
            assertTeardownMutationDeadline(signal, deadline, 'partial create fixture stop');
            await stopTeam(teamName);
            assertTeardownMutationDeadline(signal, deadline, 'partial create fixture stop');
          },
        },
      });
      await updateTeamReservation(active);
      await expect(
        cleanupActiveScenario(active, { preserveFiles: false })
      ).resolves.toBeUndefined();
      expect(stopTeam).toHaveBeenCalledWith(teamName);
      await expect(fs.lstat(teamPath)).resolves.toBeTruthy();
      await expect(fs.lstat(ownership.lockPath)).resolves.toBeTruthy();
      await expect(fs.readFile(ownership.lockPath, 'utf8')).resolves.toContain('"phase":"stopped"');
    } finally {
      setClaudeBasePathOverride(null);
      await tombstoneTestDirectory(root);
    }
  });

  it('fails exact reply validation for wrong session, author, and duplicate provider completions', () => {
    const probe = {
      replyText: 'nonce:done:run:expected:member:alice:provider:gemini',
      memberName: 'alice',
    };
    const startedAt = Date.now() - 1_000;
    expect(() =>
      assertExactAttributableTaskReply(
        [{ author: 'mallory', text: probe.replyText, createdAt: new Date().toISOString() }],
        probe,
        startedAt
      )
    ).toThrow(/missing, misattributed, or duplicated/i);
    expect(() =>
      assertExactAttributableTaskReply(
        [
          { author: 'alice', text: probe.replyText, createdAt: new Date().toISOString() },
          { author: 'alice', text: probe.replyText, createdAt: new Date().toISOString() },
        ],
        probe,
        startedAt
      )
    ).toThrow(/missing, misattributed, or duplicated/i);
    expect(() =>
      assertExactAttributableTaskReply(
        [
          {
            author: 'alice',
            text: 'nonce:done:run:other:member:alice:provider:gemini',
            createdAt: new Date().toISOString(),
          },
        ],
        probe,
        startedAt
      )
    ).toThrow(/missing, misattributed, or duplicated/i);
  });

  it('never signals an orphaned or PID-reused descendant without its captured start identity', async () => {
    if (process.platform !== 'linux') return;
    const identity = readLinuxProcessIdentity('/proc/self');
    expect(identity).not.toBeNull();
    const killSpy = vi.spyOn(process, 'kill');
    const active = createActiveScenarioFixture({
      teamName: 'pid-reuse-guard',
      capturedProcesses: new Map<number, LinuxProcessIdentity>(),
      launchProcessReceipts: new Map(),
      teardownDiagnostics: [],
    });
    try {
      captureProcessIdentity(
        active,
        identity!,
        'launch',
        makeTestLaunchReceipt(active.teamName, identity!)
      );
      const replacement = { ...identity!, startTicks: `${identity!.startTicks}-reused` };
      captureProcessIdentity(active, replacement);
      expect(active.capturedProcesses.get(process.pid)).toEqual(identity);
      await signalExactProcess(active, replacement, 'SIGKILL');
      expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('pins first-seen launch identity and refuses a late teardown recapture', () => {
    const active = createActiveScenarioFixture({
      teamName: 'first-launch-identity',
      capturedProcesses: new Map<number, LinuxProcessIdentity>(),
      launchProcessReceipts: new Map(),
      teardownDiagnostics: [],
      teardownStarted: false,
    });
    const first = { pid: 41_001, parentPid: 1, processGroup: 41_001, startTicks: '100' };
    const replacement = { ...first, startTicks: '200' };
    captureProcessIdentity(active, first, 'launch', makeTestLaunchReceipt(active.teamName, first));
    active.teardownStarted = true;
    captureProcessIdentity(active, replacement);
    captureProcessIdentity(active, { ...first, pid: 41_002 });
    expect(active.capturedProcesses.get(first.pid)).toEqual(first);
    expect(active.capturedProcesses.has(41_002)).toBe(false);
    expect(active.teardownDiagnostics.join('\n')).toMatch(
      /refused replacement|refused late PID authority/i
    );
  });

  it('does not turn a bare runtime PID snapshot into first-seen signal authority', () => {
    const active = createActiveScenarioFixture({
      teamName: 'bare-pid-snapshot',
      capturedProcesses: new Map<number, LinuxProcessIdentity>(),
      launchProcessReceipts: new Map<number, LaunchProcessReceipt>(),
      teardownDiagnostics: [],
      teardownStarted: false,
    });
    const observed = { pid: 41_003, parentPid: 1, processGroup: 41_003, startTicks: '300' };
    captureProcessIdentity(active, observed, 'launch');
    captureProcessIdentity(active, observed, 'provider-receipt');
    expect(active.capturedProcesses.has(observed.pid)).toBe(false);
    expect(active.teardownDiagnostics.join('\n')).toMatch(
      /unbound initial PID authority|without launch-bound PID authority|without wrapper launch receipt/i
    );
  });

  it('never falls back to a numeric signal for a reparented identity', async () => {
    if (process.platform !== 'linux') return;
    const identity = readLinuxProcessIdentity('/proc/self');
    expect(identity).not.toBeNull();
    const killSpy = vi.spyOn(process, 'kill');
    const active = createActiveScenarioFixture({
      teamName: 'reparented-identity',
      capturedProcesses: new Map<number, LinuxProcessIdentity>(),
      launchProcessReceipts: new Map(),
      teardownDiagnostics: [],
    });
    try {
      // The parent relation was proven when captured; a later PPID change is
      // normal after stopTeam and must not abandon this exact process.
      const reparented = { ...identity!, parentPid: 1 };
      captureProcessIdentity(
        active,
        reparented,
        'launch',
        makeTestLaunchReceipt(active.teamName, reparented)
      );
      // A PID which is no longer present cannot cause a numeric fallback. The
      // production helper uses pidfd for a live captured identity.
      await signalExactProcess(active, { ...reparented, pid: 999_999_999 }, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('refuses a provider-receipted orphan while stopTeam is pending', async () => {
    if (process.platform !== 'linux') return;
    const self = readLinuxProcessIdentity('/proc/self');
    expect(self).not.toBeNull();
    let releaseStop!: () => void;
    const stopTeam = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    });
    const active = createActiveScenarioFixture({
      teamName: 'during-stop-orphan',
      teardownStarted: true,
      capturedProcesses: new Map<number, LinuxProcessIdentity>(),
      teardownDiagnostics: [],
      dispatchAbortController: new AbortController(),
      cleanupAbortController: new AbortController(),
      svc: {
        stopTeam,
        getTeamAgentRuntimeSnapshot: vi.fn(async () => ({
          teamName: 'during-stop-orphan',
          runId: 'orphan-run',
          updatedAt: new Date().toISOString(),
          members: {
            orphan: {
              memberName: 'orphan',
              alive: true,
              restartable: true,
              backendType: 'process',
              providerId: 'codex',
              runtimePid: process.pid,
              updatedAt: new Date().toISOString(),
            },
          },
        }) satisfies TeamAgentRuntimeSnapshot),
      },
    });
    active.teardown = createCancellationAwareTeardown({ active });
    const stopping = stopTeamWithContinuousOwnedDiscovery(
      active,
      active.cleanupAbortController.signal
    );
    await new Promise((resolve) => setTimeout(resolve, STOP_OWNERSHIP_POLL_MS * 2));
    releaseStop();
    await stopping;
    expect(active.svc.getTeamAgentRuntimeSnapshot).toHaveBeenCalled();
    expect(stopTeam).toHaveBeenCalledWith(active.teamName);
    expect(active.capturedProcesses.get(process.pid)).toBeUndefined();
    expect(active.teardownDiagnostics.join('\n')).toMatch(/refused late PID authority/i);
  });

  it('fences new dispatches and drains an in-flight dispatch before teardown', async () => {
    let release!: () => void;
    const active = createActiveScenarioFixture({
      teamName: 'dispatch-fence',
      dispatchClosed: false,
      dispatchAbortController: new AbortController(),
      inFlightDispatches: new Set<Promise<unknown>>(),
    });
    const inFlight = dispatchWithTeardownFence(active, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'created';
    });
    const draining = fenceAndDrainDispatches(active);
    await expect(dispatchWithTeardownFence(active, async () => 'late')).rejects.toThrow(/fenced/i);
    release();
    await expect(inFlight).rejects.toThrow(/fenced/i);
    await expect(draining).rejects.toThrow(/dispatch drain failed/i);
  });

  it('does not start expired cleanup work and retains a fence until timed work settles', async () => {
    const active = createActiveScenarioFixture({
      teamName: 'deadline-receipt',
      teardownDiagnostics: [],
      pendingTeardownReceipts: new Map(),
    });
    const cancellation = new AbortController();
    const neverStart = vi.fn(async () => undefined);
    await expect(
      settleBeforeDeadline(neverStart, Date.now() - 1, 'expired cleanup', cancellation, active)
    ).rejects.toThrow(/absolute deadline/i);
    expect(neverStart).not.toHaveBeenCalled();

    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(
      settleBeforeDeadline(() => pending, Date.now() + 1, 'timed cleanup', cancellation, active)
    ).rejects.toThrow(/absolute deadline/i);
    expect(active.pendingTeardownReceipts.get('timed cleanup')?.state).toBe('pending');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active.pendingTeardownReceipts.get('timed cleanup')?.state).toBe('fulfilled');
  });

  it('resumes a timed-out teardown receipt without reissuing its stop effect', async () => {
    let release!: () => void;
    const active = createActiveScenarioFixture({
      teamName: 'timeout-reentry',
      cleanupEffects: new Map(),
      cleanupAbortController: new AbortController(),
      teardownDiagnostics: [],
      pendingTeardownReceipts: new Map(),
    });
    const stop = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await expect(
      runCleanupEffectExactlyOnce(active, 'stop effect', Date.now() + 10, async () => stop())
    ).rejects.toThrow(/absolute deadline/i);
    expect(stop).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      runCleanupEffectExactlyOnce(active, 'stop effect', Date.now() + 1_000, async () => stop())
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('bounds re-observation of a never-settling exactly-once cleanup receipt', async () => {
    const active = createActiveScenarioFixture({
      teamName: 'pending-receipt-deadline',
      cleanupEffects: new Map(),
      cleanupAbortController: new AbortController(),
      teardownDiagnostics: [],
      pendingTeardownReceipts: new Map(),
    });
    const never = new Promise<void>(() => undefined);
    const stop = vi.fn(async () => never);
    await expect(
      runCleanupEffectExactlyOnce(active, 'never settle', Date.now() + 5, async () => stop())
    ).rejects.toThrow(/absolute deadline/i);
    await expect(
      runCleanupEffectExactlyOnce(active, 'never settle', Date.now() + 5, async () => stop())
    ).rejects.toThrow(/absolute deadline/i);
    expect(stop).toHaveBeenCalledOnce();
    expect(active.pendingTeardownReceipts.get('never settle')?.state).toBe('pending');
  });

  it('aggregates independent teardown failures in deterministic order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-cleanup-aggregate-'));
    const teamName = `provider-stress-cleanup-${randomUUID()}`;
    try {
      setClaudeBasePathOverride(root);
      const ownership = await acquireTeamOwnership(teamName);
      await fs.mkdir(path.join(getTeamsBasePath(), teamName), { recursive: true });
      await fs.writeFile(
        path.join(getTeamsBasePath(), teamName, '.provider-launch-stress-owner.json'),
        `${JSON.stringify({ teamName, token: ownership.token })}\n`
      );
      const stopTeam = vi.fn(async (_teamName: string) => {
        throw new Error('stop failed');
      });
      const drainedDispatch = Promise.reject(new Error('overlapping dispatch rejected'));
      // Prevent the fixture's deliberate rejection from becoming an unrelated
      // unhandled-rejection failure before fenceAndDrainDispatches observes it.
      void drainedDispatch.catch(() => undefined);
      const active = createActiveScenarioFixture({
        scenario: 'anthropic',
        teamName,
        ownership,
        phase: 'marked',
        markerWritten: true,
        created: true,
        failed: false,
        capturedProcesses: new Map(),
        teardownDiagnostics: [],
        dispatchClosed: false,
        dispatchAbortController: new AbortController(),
        inFlightDispatches: new Set([drainedDispatch]),
        teardownStarted: false,
        svc: {
          getTeamAgentRuntimeSnapshot: vi.fn(async () => createEmptyRuntimeSnapshot(teamName)),
          stopTeam,
        },
        teardown: {
          stopTeam: async (_options: TeardownMutationOptions) => {
            await stopTeam(teamName);
          },
          cleanupCodex: async (_options) => {
            throw new Error('Codex cleanup failed');
          },
        },
      });
      await updateTeamReservation(active);
      const teardownError = await cleanupActiveScenario(active, { preserveFiles: false }).then(
        () => null,
        (error: unknown) => error
      );
      // AggregateError.errors is the runtime contract. Its message is only a
      // summary and must not be used to claim independent cleanup continued.
      expect(teardownError).toBeInstanceOf(AggregateError);
      const errors = (teardownError as AggregateError).errors as Error[];
      expect(errors.map((error) => error.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'stop team while continuously discovering owned descendants: stop failed'
          ),
          expect.stringContaining('clean up Codex feature: Codex cleanup failed'),
        ])
      );
      expect(stopTeam).toHaveBeenCalledOnce();
      const reservation = JSON.parse(await fs.readFile(ownership.lockPath, 'utf8')) as {
        phase: string;
      };
      expect(reservation.phase).toBe('stopped');
    } finally {
      setClaudeBasePathOverride(null);
      await tombstoneTestDirectory(root);
    }
  });

  it('refuses every requested-live teardown mutation without fresh wrapper closure authority', async () => {
    const previousLive = process.env.PROVIDER_LAUNCH_STRESS_LIVE;
    const previousArtifact = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    try {
      process.env.PROVIDER_LAUNCH_STRESS_LIVE = '1';
      delete process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
      await expect(
        assertReleaseClosureBeforeTeardownEffect(
          createActiveScenarioFixture({ teamName: 'closure-fence' }),
          'delete evidence'
        )
      ).rejects.toThrow(/wrapper authorization is unavailable|release closure is unavailable/i);
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_LIVE', previousLive);
      restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousArtifact);
    }
  });

  it('fails the quiet-period audit when a duplicate or late provider effect appears', () => {
    expect(() => assertQuietProofSnapshot('[{"effects":1}]', '[{"effects":2}]')).toThrow(
      /late or duplicate/i
    );
  });

  it('changes only an invocation-owned Claude config copy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-isolated-config-'));
    const sourceConfig = path.join(root, 'source', '.claude.json');
    const isolatedConfigRoot = path.join(root, 'owned-config');
    const projectPath = path.join(root, 'project');
    const original = Buffer.from('{"keep":true}\n', 'utf8');
    try {
      await fs.mkdir(path.dirname(sourceConfig), { recursive: true });
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(sourceConfig, original, { mode: 0o640 });
      await fs.mkdir(isolatedConfigRoot, { recursive: true });
      await fs.copyFile(sourceConfig, path.join(isolatedConfigRoot, '.claude.json'));
      await upsertTrustedClaudeProjectConfig(isolatedConfigRoot, projectPath);
      expect(await fs.readFile(sourceConfig)).toEqual(original);
      expect(await fs.readFile(path.join(isolatedConfigRoot, '.claude.json'))).not.toEqual(
        original
      );
    } finally {
      await tombstoneTestDirectory(root);
    }
  });

  it('keeps a deterministic Codex auth manifest unique when active auth also appears in directory discovery', () => {
    const active = '/source/accounts/active.auth.json';
    const discovered = [
      '/source/accounts/z.auth.json',
      active,
      '/source/accounts/a.auth.json',
      active,
    ];
    const manifest = new Map<string, string>();
    for (const source of [active, ...[...discovered].sort()]) {
      manifest.set(path.basename(source), source);
    }
    expect([...manifest.entries()]).toEqual([
      ['active.auth.json', active],
      ['a.auth.json', '/source/accounts/a.auth.json'],
      ['z.auth.json', '/source/accounts/z.auth.json'],
    ]);
    expect([...manifest.values()].filter((source) => source === active)).toHaveLength(1);
  });

  it('keeps Gemini OAuth config and ADC rooted in the invocation-owned config tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-gemini-isolation-'));
    const source = path.join(root, 'source-adc.json');
    const configRoot = path.join(root, 'provider-xdg-config');
    const isolatedAdc = path.join(configRoot, 'gcloud', 'application_default_credentials.json');
    const oauth = path.join(root, 'provider-claude-config', '.config.json');
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      await fs.writeFile(source, '{"type":"authorized_user"}\n', { mode: 0o600 });
      await fs.mkdir(path.dirname(isolatedAdc), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, isolatedAdc);
      await fs.mkdir(path.dirname(oauth), { recursive: true, mode: 0o700 });
      await fs.writeFile(oauth, JSON.stringify({ geminiLastAuthMethod: 'cli_oauth_personal' }), {
        mode: 0o600,
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = isolatedAdc;
      expect(path.relative(root, process.env.GOOGLE_APPLICATION_CREDENTIALS).startsWith('..')).toBe(
        false
      );
      expect(await fs.readFile(isolatedAdc, 'utf8')).toBe(await fs.readFile(source, 'utf8'));
      expect(JSON.parse(await fs.readFile(oauth, 'utf8'))).toMatchObject({
        geminiLastAuthMethod: 'cli_oauth_personal',
      });
    } finally {
      restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', previous);
      await tombstoneTestDirectory(root);
    }
  });

  it('resolves Gemini auto auth exactly for CLI OAuth and ADC project credentials', () => {
    const previous = {
      configDir: process.env.CLAUDE_CONFIG_DIR,
      backend: process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND,
      claudeBackend: process.env.CLAUDE_CODE_GEMINI_BACKEND,
      apiKey: process.env.GEMINI_API_KEY,
      project: process.env.GOOGLE_CLOUD_PROJECT,
    };
    const configDir = fs.mkdtemp(path.join(os.tmpdir(), 'provider-stress-gemini-'));
    return configDir.then(async (root) => {
      try {
        process.env.CLAUDE_CONFIG_DIR = root;
        delete process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND;
        delete process.env.CLAUDE_CODE_GEMINI_BACKEND;
        delete process.env.GEMINI_API_KEY;
        delete process.env.GOOGLE_CLOUD_PROJECT;
        await fs.writeFile(
          path.join(root, '.config.json'),
          JSON.stringify({ geminiLastAuthMethod: 'cli_oauth_personal' }),
          'utf8'
        );
        expect(resolveGeminiBackend()).toBe('cli-sdk');
        await fs.writeFile(
          path.join(root, '.config.json'),
          JSON.stringify({
            geminiLastAuthMethod: 'adc_authorized_user',
            geminiProjectId: 'test-project',
          }),
          'utf8'
        );
        expect(resolveGeminiBackend()).toBe('api');
        process.env.GEMINI_API_KEY = 'test-key';
        expect(resolveGeminiBackend()).toBe('api');
        await fs.writeFile(
          path.join(root, '.config.json'),
          JSON.stringify({ geminiLastAuthMethod: 'adc_authorized_user', geminiProjectId: {} }),
          'utf8'
        );
        expect(() => resolveGeminiBackend()).toThrow(/geminiProjectId must be a string/);
        await fs.writeFile(path.join(root, '.config.json'), '{invalid', 'utf8');
        expect(() => resolveGeminiBackend()).toThrow(/Gemini config is invalid JSON/);
      } finally {
        restoreEnv('CLAUDE_CONFIG_DIR', previous.configDir);
        restoreEnv('PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND', previous.backend);
        restoreEnv('CLAUDE_CODE_GEMINI_BACKEND', previous.claudeBackend);
        restoreEnv('GEMINI_API_KEY', previous.apiKey);
        restoreEnv('GOOGLE_CLOUD_PROJECT', previous.project);
        await tombstoneTestDirectory(root);
      }
    });
  });

  it('keeps wrapper-selected Gemini backend and runtime auth resolution in parity', () => {
    const previousBackend = process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND;
    const previousClaudeBackend = process.env.CLAUDE_CODE_GEMINI_BACKEND;
    const previousApiKey = process.env.GEMINI_API_KEY;
    try {
      process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND = 'CLI';
      process.env.CLAUDE_CODE_GEMINI_BACKEND = 'cli-sdk';
      process.env.GEMINI_API_KEY = '';
      expect(resolveGeminiBackend()).toBe('cli-sdk');
      process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND = 'api';
      process.env.CLAUDE_CODE_GEMINI_BACKEND = 'api';
      process.env.GEMINI_API_KEY = 'test-key';
      expect(resolveGeminiBackend()).toBe('api');
    } finally {
      restoreEnv('PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND', previousBackend);
      restoreEnv('CLAUDE_CODE_GEMINI_BACKEND', previousClaudeBackend);
      restoreEnv('GEMINI_API_KEY', previousApiKey);
    }
  });
});

liveAuthorizedDisposableDescribe('provider launch stress live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let tempHome: string;
  let projectPath: string;
  let previousCliPath: string | undefined;
  let previousCliFlavor: string | undefined;
  let previousCodexHome: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  let previousGeminiBackend: string | undefined;
  let previousClaudeGeminiBackend: string | undefined;
  let previousNodeEnv: string | undefined;
  let previousAnthropicApiKey: string | undefined;
  let previousAnthropicAuthToken: string | undefined;
  let previousRuntimeReadyTimeout: string | undefined;
  let previousInboxPollerReadyTimeout: string | undefined;
  let previousXdgDataHome: string | undefined;
  let previousXdgConfigHome: string | undefined;
  let previousGoogleApplicationCredentials: string | undefined;
  let disposableProject: DisposableProject;
  const activeScenarios: ActiveScenario[] = [];

  beforeEach(async () => {
    disposableProject = await acquireDisposableProject();
    tempDir = disposableProject.root;
    // Simulate a global setup changing HOME before the suite setup runs.  The
    // descriptor must still select the wrapper's original provider roots.
    const homeBeforeSetupMutation = process.env.HOME;
    const setupMutatedHome = path.join(tempDir, 'global-setup-mutated-home');
    process.env.HOME = setupMutatedHome;
    const authorization = getLiveStressAuthorization();
    restoreEnv('HOME', homeBeforeSetupMutation);
    if (!authorization.ok || !authorization.auth || !authorization.project) {
      throw new Error(`Live provider canary lost wrapper capability: ${authorization.reason}`);
    }
    if (authorization.auth.home === setupMutatedHome) {
      throw new Error('Live provider canary accepted HOME mutated by global setup.');
    }
    // Do not consult HOME/USERPROFILE here: test/global setup can mutate them.
    // The wrapper's original provider roots are authenticated descriptor data.
    tempHome = authorization.auth.home;
    tempClaudeRoot = authorization.auth.claudeConfigDir;
    projectPath = disposableProject.projectPath;
    currentStressTempDir = tempDir;
    currentStressEffectiveHome = tempHome;
    currentStressDisposableProject = disposableProject;
    await fs.mkdir(tempHome, { recursive: true });
    await assertOwnedDisposableProject(disposableProject);

    if (usingAnthropicSubscriptionAuth()) {
      await upsertTrustedClaudeProjectConfig(tempClaudeRoot, projectPath);
      setClaudeBasePathOverride(tempClaudeRoot);
    } else {
      await fs.mkdir(tempClaudeRoot, { recursive: true });
      await writeTrustedClaudeConfig(tempClaudeRoot, projectPath);
      setClaudeBasePathOverride(tempClaudeRoot);
    }

    previousCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    previousCliFlavor = process.env.CLAUDE_TEAM_CLI_FLAVOR;
    previousCodexHome = process.env.CODEX_HOME;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousGeminiBackend = process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND;
    previousClaudeGeminiBackend = process.env.CLAUDE_CODE_GEMINI_BACKEND;
    previousNodeEnv = process.env.NODE_ENV;
    previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    previousRuntimeReadyTimeout = process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS;
    previousInboxPollerReadyTimeout = process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS;
    previousXdgDataHome = process.env.XDG_DATA_HOME;
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    previousGoogleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const verifiedCli = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH?.trim();
    if (!verifiedCli)
      throw new Error('Live canary wrapper did not provide a verified release artifact.');
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = verifiedCli;
    process.env.CLAUDE_TEAM_CLI_FLAVOR = 'agent_teams_orchestrator';
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS?.trim() || '90000';
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS =
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS?.trim() || '30000';
    process.env.CODEX_HOME = authorization.auth.codexHome;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = authorization.auth.userProfile;
    // Keep the canary's effective config root identical to wrapper preflight in
    // both subscription and API-key modes.
    process.env.CLAUDE_CONFIG_DIR = tempClaudeRoot;
    process.env.XDG_DATA_HOME = authorization.auth.xdgDataHome;
    process.env.XDG_CONFIG_HOME = authorization.auth.xdgConfigHome;
    // The wrapper supplies only an invocation-owned ADC location.  Do not let
    // a global setup restore a path into the invoking user's home.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = authorization.auth.googleApplicationCredentials;
    const normalizedBackend = normalizeGeminiBackend(
      process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND || process.env.CLAUDE_CODE_GEMINI_BACKEND
    );
    process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND = normalizedBackend;
    process.env.CLAUDE_CODE_GEMINI_BACKEND = normalizedBackend;
    process.env.NODE_ENV = 'production';
    if (usingAnthropicSubscriptionAuth()) {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  afterEach(async () => {
    const cleanupFailures: Error[] = [];
    const hadScenarioFailure = activeScenarios.some((active) => active.failed);
    for (const active of [...activeScenarios].reverse()) {
      try {
        await cleanupActiveScenario(active, { preserveFiles: active.failed });
      } catch (error) {
        active.failed = true;
        cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    activeScenarios.length = 0;
    discardKnownProviderLaunchStressWarnings();

    setClaudeBasePathOverride(null);

    restoreEnv('CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH', previousCliPath);
    restoreEnv('CLAUDE_TEAM_CLI_FLAVOR', previousCliFlavor);
    restoreEnv('CODEX_HOME', previousCodexHome);
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
    restoreEnv('CLAUDE_CONFIG_DIR', previousClaudeConfigDir);
    restoreEnv('PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND', previousGeminiBackend);
    restoreEnv('CLAUDE_CODE_GEMINI_BACKEND', previousClaudeGeminiBackend);
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    restoreEnv('ANTHROPIC_AUTH_TOKEN', previousAnthropicAuthToken);
    restoreEnv('CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS', previousRuntimeReadyTimeout);
    restoreEnv(
      'CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS',
      previousInboxPollerReadyTimeout
    );
    restoreEnv('XDG_DATA_HOME', previousXdgDataHome);
    restoreEnv('XDG_CONFIG_HOME', previousXdgConfigHome);
    restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', previousGoogleApplicationCredentials);

    let retainEvidence =
      process.env.PROVIDER_LAUNCH_STRESS_KEEP_TEMP === '1' ||
      hadScenarioFailure ||
      cleanupFailures.length > 0;
    if (!retainEvidence && disposableProject.wrapperOwned) {
      // The wrapper owns the root marker and performs the final authenticated
      // removal after the worker exits.  Removing it here would make wrapper
      // exit cleanup unable to validate the ownership it is about to delete.
      try {
        await assertOwnedDisposableProject(disposableProject);
      } catch (error) {
        retainEvidence = true;
        cleanupFailures.push(
          new Error(
            `preserve wrapper ownership marker: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
      }
    } else if (!retainEvidence) {
      try {
        await assertReleaseClosureBeforeTeardownEffect(
          createActiveScenarioFixture({ teamName: 'suite temp root' }),
          'delete suite disposable root'
        );
        await assertOwnedDisposableProject(disposableProject);
        const artifact = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
        if (!artifact)
          throw new Error('Release closure is unavailable before suite disposable-root deletion.');
        await assertVerifiedReleaseArtifact(artifact, async () => {
          await tombstoneTestDirectory(tempDir);
        });
      } catch (error) {
        retainEvidence = true;
        cleanupFailures.push(
          new Error(
            `delete suite disposable root: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
      }
    }
    if (retainEvidence) {
      process.stderr.write(`[ProviderLaunchStress.live] preserved temp dir: ${tempDir}\n`);
    }
    currentStressTempDir = '';
    currentStressEffectiveHome = '';
    currentStressDisposableProject = null;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        'Provider launch stress teardown failed; evidence retained.'
      );
    }
  }, 240_000);

  it(
    'launches exactly once and exercises attributable post-launch work for all four provider canaries plus the mixed team',
    async () => {
      const orchestratorCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
      expect(orchestratorCli).toBeTruthy();
      await assertVerifiedReleaseArtifact(orchestratorCli!);
      const order = getStressOrder();
      if (order.some((scenario) => scenario === 'codex' || scenario === 'mixed')) {
        await assertCodexSubscriptionAuthAvailable(process.env.CODEX_HOME!);
      }

      const scenarioProofs: ScenarioSequenceProof[] = [];
      for (const scenario of order) {
        const scenarioProof = await runProviderStressScenario(
          scenario,
          activeScenarios,
          disposableProject
        );
        if (scenarioProof) scenarioProofs.push(scenarioProof);
      }
      await acceptAuthenticatedFourProviderSequenceBaseline(scenarioProofs);
    },
    30 * 60_000
  );
});

async function runProviderStressScenario(
  scenario: ProviderLaunchStressScenario,
  activeScenarios: ActiveScenario[],
  disposableProject: DisposableProject
): Promise<ScenarioSequenceProof | null> {
  const selected = resolveScenarioSelection(scenario);
  const memberCount = getStressMemberCount();
  const runId = sanitizeEvidencePart(randomUUID());
  const teamName = `provider-stress-${runId}-${scenario}`;
  const progressEvents: TeamProvisioningProgress[] = [];
  process.stderr.write(
    `[ProviderLaunchStress.live] starting ${scenario} with ${memberCount} teammates\n`
  );
  let codexCleanup: ((options: TeardownMutationOptions) => Promise<void>) | undefined;
  let harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>> | undefined;
  const ownership = await acquireTeamOwnership(teamName);
  // Register cleanup before the OpenCode harness or createTeam can cause a
  // launch.  The reservation is durable, unique, and becomes the evidence for
  // a partial create/marker failure.
  const active: ActiveScenario = {
    scenario,
    teamName,
    svc: new TeamProvisioningService(),
    ownership,
    phase: 'reserved',
    markerWritten: false,
    capturedProcesses: new Map(),
    launchProcessReceipts: new Map(),
    cgroupReceipt: initialLiveAuthorization.cgroup,
    teardownDiagnostics: [],
    dispatchClosed: false,
    dispatchAbortController: new AbortController(),
    inFlightDispatches: new Set(),
    launchIdentityObservations: new Set(),
    teardownStarted: false,
    pendingTeardownReceipts: new Map(),
    cleanupEffects: new Map(),
    cleanupAbortController: new AbortController(),
    created: false,
    failed: false,
  };
  let sequenceProof: ScenarioSequenceProof | undefined;
  activeScenarios.push(active);
  try {
    await recordFailureArtifactReservation(active);
    codexCleanup =
      scenario === 'codex' || scenario === 'mixed' ? await installCodexAccountFeature() : undefined;
    // OpenCode's harness can spawn a release-backed bridge while it is being
    // created, so it receives the same immediately-before-launch payload gate.
    await assertVerifiedReleaseArtifact(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!);
    await assertOwnedDisposableProject(disposableProject);
    harness =
      scenario === 'opencode' || scenario === 'mixed'
        ? await createHomeParityOpenCodeHarness({
            tempDir: disposableProject.root,
            selectedModel: selected.openCodeModel,
            projectPath: disposableProject.projectPath,
            effectiveHome: currentStressEffectiveHome,
          })
        : undefined;
    active.svc = harness?.svc ?? active.svc;
    active.teardown = createCancellationAwareTeardown({
      active,
      harness,
      codexCleanup,
    });
    configureWorkspaceTrustCoordinator(active.svc);
    active.phase = 'creating';
    await updateTeamReservation(active);
    // The wrapper's inventory is re-read immediately before every paid
    // createTeam effect.  A prior scenario cannot bless changed bytes.
    await assertVerifiedReleaseArtifact(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!);
    await assertOwnedDisposableProject(disposableProject);
    const createRequest = buildStressCreateRequest({
      scenario,
      teamName,
      memberCount,
      selection: selected,
      disposableProject,
    });
    bindAuthenticatedProjectDirectoryLease(createRequest);
    await active.svc.createTeam(
      createRequest,
      (progress) => {
        progressEvents.push(progress);
        observeLaunchProcessIdentities(active);
      }
    );
    await Promise.all([...active.launchIdentityObservations]);
    // Take the first trusted runtime observation while the launch is still
    // owned.  Teardown is deliberately forbidden from granting fresh PID
    // authority: a later observation could be a reused PID.
    captureSnapshotProcessIdentities(
      active,
      await active.svc.getTeamAgentRuntimeSnapshot(active.teamName)
    );
    active.created = true;
    active.phase = 'created';
    await updateTeamReservation(active);
    await writeTeamOwnershipMarker(active);
    active.markerWritten = true;
    active.phase = 'marked';
    await updateTeamReservation(active);

    await waitUntil(async () => {
      const last = progressEvents.at(-1);
      if (last?.state === 'failed') {
        active.failed = true;
        throw new Error(await formatStressDiagnostics(active.svc, teamName, progressEvents));
      }
      return last?.state === 'ready';
    }, 420_000);

    const expectedMembers = buildExpectedMemberNames(memberCount);
    await waitUntil(async () => {
      const statuses = await active.svc.getMemberSpawnStatuses(teamName);
      if (statuses.teamLaunchState === 'partial_failure') {
        active.failed = true;
        throw new Error(await formatStressDiagnostics(active.svc, teamName, progressEvents));
      }
      return expectedMembers.every((memberName) => {
        const entry = statuses.statuses[memberName];
        return (
          entry?.status === 'online' &&
          entry.launchState === 'confirmed_alive' &&
          entry.bootstrapConfirmed === true
        );
      });
    }, 240_000);

    await waitForStressCondition(
      `all teammate runtimes alive ${teamName}`,
      async () => {
        const snapshot = await active.svc.getTeamAgentRuntimeSnapshot(teamName);
        captureSnapshotProcessIdentities(active, snapshot);
        return expectedMembers.every((memberName) => {
          const runtime = snapshot.members[memberName];
          return (
            runtime?.alive === true &&
            runtime.providerId ===
              resolveExpectedProviderForMember(scenario, memberName, expectedMembers)
          );
        });
      },
      180_000,
      2_000,
      () => formatStressDiagnostics(active.svc, teamName, progressEvents)
    );
    process.stderr.write(`[ProviderLaunchStress.live] ${scenario} confirmed all teammates\n`);

    await runPostLaunchWorkProofCheck(active, expectedMembers, progressEvents);
    if (!active.proofAudit) {
      throw new Error(`Provider launch stress did not retain a proof for ${scenario}.`);
    }
    if (scenario !== 'mixed') {
      sequenceProof = { scenario, teamName: active.teamName, audit: active.proofAudit };
    }
  } catch (error) {
    active.failed = true;
    throw error;
  } finally {
    if (!active.failed) {
      await cleanupActiveScenario(active, { preserveFiles: false });
      const index = activeScenarios.indexOf(active);
      if (index >= 0) activeScenarios.splice(index, 1);
    }
  }
  if (!sequenceProof && scenario !== 'mixed') {
    throw new Error(`Provider launch stress did not collect a final proof for ${scenario}.`);
  }
  return sequenceProof ?? null;
}

async function createHomeParityOpenCodeHarness(
  input: Parameters<typeof createOpenCodeLiveHarness>[0] & { effectiveHome: string }
): ReturnType<typeof createOpenCodeLiveHarness> {
  const { effectiveHome, ...harnessInput } = input;
  const selectedHome = process.env.HOME?.trim();
  if (!selectedHome || selectedHome !== process.env.USERPROFILE || selectedHome !== effectiveHome) {
    throw new Error('OpenCode launch refused because the wrapper-selected HOME is not preserved.');
  }
  const userInfoSpy = vi.spyOn(os, 'userInfo').mockImplementation((() => ({
    username: 'provider-launch-stress',
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    shell: '',
    homedir: selectedHome,
  })) as typeof os.userInfo);
  try {
    return await createOpenCodeLiveHarness(harnessInput);
  } finally {
    userInfoSpy.mockRestore();
  }
}

function configureWorkspaceTrustCoordinator(svc: ProviderLaunchStressService): void {
  svc.setWorkspaceTrustCoordinator(
    createWorkspaceTrustCoordinator({
      claudeConfigDir: () => getClaudeBasePath(),
      globalConfigFilePath: () => {
        const claudeBasePath = getClaudeBasePath();
        return claudeBasePath !== getAutoDetectedClaudeBasePath()
          ? path.join(claudeBasePath, '.claude.json')
          : path.join(getHomeDir(), '.claude.json');
      },
    })
  );
}

async function runPostLaunchWorkProofCheck(
  active: ActiveScenario,
  expectedMembers: string[],
  progressEvents: TeamProvisioningProgress[]
): Promise<void> {
  const memberNames = resolvePostLaunchWorkTargets(active.scenario, expectedMembers);
  const launchSnapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
  if (!launchSnapshot.runId) {
    throw new Error(
      `Provider launch stress has no attributable runtime session for ${active.teamName}.`
    );
  }
  const expectedRunId = launchSnapshot.runId;
  const markerPrefix = `provider-stress-${active.teamName}-${sanitizeEvidencePart(expectedRunId)}-${memberNames.length}`;
  const teamDataService = new TeamDataService();
  const taskReader = new TeamTaskReader();

  process.stderr.write(
    `[ProviderLaunchStress.live] sending post-launch work probes to ${active.scenario}/${memberNames.join(',')}\n`
  );
  const launchEvidenceStartedAt = Date.now();
  const planned = memberNames.map((memberName, index) => {
    const runtime = launchSnapshot.members[memberName];
    const expectedProvider = resolveExpectedProviderForMember(
      active.scenario,
      memberName,
      expectedMembers
    );
    const expectedSessionId = runtime?.runtimeSessionId?.trim();
    if (runtime?.providerId !== expectedProvider || !expectedSessionId) {
      throw new Error(`Provider launch stress lacks fresh runtime attribution for ${memberName}.`);
    }
    return {
      marker: `${markerPrefix}-${index + 1}-${randomBytes(16).toString('hex')}`,
      memberName,
      expectedRunId,
      expectedProvider,
      expectedSessionId,
      replyText: '',
      peerRecipient: memberNames.length > 1 ? memberNames[(index + 1) % memberNames.length]! : null,
      peerToken: null as string | null,
      peerAckToken: null as string | null,
      incomingPeerToken: null as string | null,
      incomingPeerAckToken: null as string | null,
    };
  });
  for (const probe of planned) {
    probe.replyText = `${probe.marker}:done:run:${expectedRunId}:session:${probe.expectedSessionId}:member:${probe.memberName}:provider:${probe.expectedProvider}`;
    if (!probe.peerRecipient) continue;
    const recipient = planned.find((candidate) => candidate.memberName === probe.peerRecipient);
    if (!recipient) throw new Error(`Peer recipient ${probe.peerRecipient} was not planned.`);
    probe.peerToken = JSON.stringify({
      kind: 'provider-stress-peer-v2',
      nonce: probe.marker,
      runId: expectedRunId,
      from: {
        member: probe.memberName,
        provider: probe.expectedProvider,
        session: probe.expectedSessionId,
      },
      to: {
        member: recipient.memberName,
        provider: recipient.expectedProvider,
        session: recipient.expectedSessionId,
      },
    });
    probe.peerAckToken = JSON.stringify({
      kind: 'provider-stress-peer-ack-v2',
      nonce: probe.marker,
      runId: expectedRunId,
      member: recipient.memberName,
      provider: recipient.expectedProvider,
      session: recipient.expectedSessionId,
      receivedFrom: probe.memberName,
    });
    recipient.incomingPeerToken = probe.peerToken;
    recipient.incomingPeerAckToken = probe.peerAckToken;
  }
  const probes = await Promise.all(
    planned.map((probe) =>
      dispatchWithTeardownFence(active, async () => {
        // This is a provider effect: reject a mutated release closure before task
        // dispatch instead of allowing a paid worker to consume it.
        await assertVerifiedReleaseArtifact(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!);
        await assertOwnedDisposableProject(currentStressDisposableProject!);
        assertDispatchOpen(active);
        const task = await teamDataService.createTask(active.teamName, {
          subject: `Provider launch stress proof ${probe.marker}`,
          owner: probe.memberName,
          startImmediately: true,
          prompt: [
            `This is a live provider launch stress validation. Marker: ${probe.marker}.`,
            'Do not edit files.',
            'Add one task comment containing exactly:',
            probe.replyText,
            ...(probe.peerRecipient && probe.peerToken
              ? [
                  `Send ${probe.peerRecipient} one team message whose full text is exactly: ${probe.peerToken}`,
                  'Use agent-teams_message_send for the team message.',
                ]
              : []),
            ...(probe.incomingPeerToken && probe.incomingPeerAckToken
              ? [
                  'Before completing, wait until your team inbox contains exactly one message whose full text is:',
                  probe.incomingPeerToken,
                  'After processing that exact message, add one additional task comment containing exactly:',
                  probe.incomingPeerAckToken,
                ]
              : []),
            'Mark this task complete only after all required message send/processing steps are complete.',
            'After that stop. Do not send a separate user-visible chat reply.',
          ].join('\n'),
        });
        await assertVerifiedReleaseArtifact(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!);
        await assertOwnedDisposableProject(currentStressDisposableProject!);
        assertDispatchOpen(active);
        const relay = await active.svc.relayInboxFileToLiveRecipient(
          active.teamName,
          probe.memberName
        );
        if (!isAcceptedStressRelayResult(relay)) {
          throw new Error(
            `Post-launch work probe was not relayed to ${probe.memberName}; relay result: ${JSON.stringify(relay)}`
          );
        }
        return { ...probe, taskId: task.id };
      })
    )
  );
  // This suite must not manufacture request/debit/effect evidence after it
  // asked a provider to work.  The release runtime/accounting collector owns
  // this append-only record and supplies its descriptor through the wrapper.
  const accounting = await requireIndependentProviderEffectReceiptLedger(active, expectedRunId);

  await waitForStressCondition(
    `post-launch work proofs ${active.teamName}/${memberNames.join(',')}`,
    async () => {
      const tasks = await taskReader.getTasks(active.teamName);
      return probes.every((probe) => {
        const current = tasks.find((candidate) => candidate.id === probe.taskId);
        try {
          assertExactAttributableTaskReply(current?.comments ?? [], probe, launchEvidenceStartedAt);
          return current?.status === 'completed';
        } catch {
          return false;
        }
      });
    },
    POST_LAUNCH_WORK_TIMEOUT_MS,
    2_000,
    () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
  );

  const peerProbes = probes.filter(
    (
      probe
    ): probe is (typeof probes)[number] & {
      peerRecipient: string;
      peerToken: string;
    } => Boolean(probe.peerRecipient && probe.peerToken)
  );
  await Promise.all(
    peerProbes.map((probe) =>
      waitForExactPeerMessage(
        active.teamName,
        probe.peerRecipient,
        probe.memberName,
        probe.peerToken,
        POST_LAUNCH_WORK_TIMEOUT_MS
      )
    )
  );
  await Promise.all(
    Array.from(new Set(peerProbes.map((probe) => probe.peerRecipient))).map((recipientName) =>
      dispatchWithTeardownFence(active, async () => {
        await assertVerifiedReleaseArtifact(process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!);
        await assertOwnedDisposableProject(currentStressDisposableProject!);
        assertDispatchOpen(active);
        const relay = await active.svc.relayInboxFileToLiveRecipient(
          active.teamName,
          recipientName
        );
        if (!isAcceptedStressRelayResult(relay)) {
          throw new Error(
            `Peer message was not relayed to ${recipientName}; relay result: ${JSON.stringify(relay)}`
          );
        }
      })
    )
  );
  await waitForStressCondition(
    `peer processing acknowledgements ${active.teamName}`,
    async () => {
      const tasks = await taskReader.getTasks(active.teamName);
      try {
        for (const probe of peerProbes) {
          const recipient = probes.find(
            (candidate) => candidate.memberName === probe.peerRecipient
          );
          const recipientTask = tasks.find((candidate) => candidate.id === recipient?.taskId);
          if (!probe.peerAckToken || !recipient) return false;
          assertExactPeerAcknowledgement(
            recipientTask?.comments ?? [],
            probe.peerAckToken,
            probe.peerRecipient,
            launchEvidenceStartedAt
          );
        }
        return true;
      } catch {
        return false;
      }
    },
    POST_LAUNCH_WORK_TIMEOUT_MS,
    1_500,
    () => formatStressDiagnostics(active.svc, active.teamName, progressEvents)
  );
  await Promise.all(
    probes.map(async (probe) => {
      const snapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
      const entry = snapshot.members[probe.memberName];
      if (snapshot.runId !== probe.expectedRunId) {
        throw new Error(
          `Reply evidence for ${probe.memberName} moved to a different runtime session.`
        );
      }
      if (
        entry?.providerId !== probe.expectedProvider ||
        entry?.runtimeSessionId?.trim() !== probe.expectedSessionId
      ) {
        throw new Error(
          `Reply evidence for ${probe.memberName} lost independent provider/session attribution.`
        );
      }
      const tasks = await taskReader.getTasks(active.teamName);
      const task = tasks.find((candidate) => candidate.id === probe.taskId);
      assertExactAttributableTaskReply(task?.comments ?? [], probe, launchEvidenceStartedAt);
      if (probe.peerRecipient && probe.peerAckToken) {
        const recipient = probes.find((candidate) => candidate.memberName === probe.peerRecipient);
        const recipientEntry = snapshot.members[probe.peerRecipient];
        const recipientTask = tasks.find((candidate) => candidate.id === recipient?.taskId);
        if (
          !recipient ||
          recipientEntry?.providerId !== recipient.expectedProvider ||
          recipientEntry?.runtimeSessionId?.trim() !== recipient.expectedSessionId
        ) {
          throw new Error(
            `Peer acknowledgement for ${probe.memberName} is not independently attributable to ${probe.peerRecipient}.`
          );
        }
        assertExactPeerAcknowledgement(
          recipientTask?.comments ?? [],
          probe.peerAckToken,
          probe.peerRecipient,
          launchEvidenceStartedAt
        );
      }
    })
  );
  active.proofAudit = {
    entries: probes.map((probe) => ({
      taskId: probe.taskId,
      memberName: probe.memberName,
      replyText: probe.replyText,
      peerRecipient: probe.peerRecipient,
      peerText: probe.peerToken,
      peerAckText: probe.peerAckToken,
      runId: probe.expectedRunId,
      providerId: probe.expectedProvider,
      runtimeSessionId: probe.expectedSessionId,
      marker: probe.marker,
    })),
    beforeStop: '',
    accounting,
  };
  const baselineProof = await snapshotProofEffects(active);
  // Recheck the exact cardinality at the baseline boundary.  A second peer
  // message can arrive after the acknowledgement poll but before this read.
  assertExactProofSnapshot(active.proofAudit, baselineProof, active.teamName);
  // This is a scenario-local proof only. The authenticated collector accepts
  // exactly one baseline after the anthropic/codex/gemini/opencode sequence is
  // complete, so no earlier provider can seal out a later required provider.
  active.proofAudit.acceptedSettlementIdentityMultiset =
    collectAcceptedSettlementIdentityMultiset(
    baselineProof,
    active.teamName,
    active.proofAudit.accounting.issuerId
    );
  active.proofAudit.beforeStop = baselineProof;
  process.stderr.write(`[ProviderLaunchStress.live] ${active.scenario} post-launch work passed\n`);
}

function assertExactPeerAcknowledgement(
  comments: Array<{ author: string; text: string; createdAt: string }>,
  expectedText: string,
  recipient: string,
  startedAt: number
): void {
  const acknowledgements = comments.filter((comment) => comment.text === expectedText);
  if (
    acknowledgements.length !== 1 ||
    acknowledgements[0]?.author !== recipient ||
    !Number.isFinite(Date.parse(acknowledgements[0]?.createdAt ?? '')) ||
    Date.parse(acknowledgements[0]?.createdAt ?? '') < startedAt
  ) {
    throw new Error(
      `Peer acknowledgement for ${recipient} is missing, misattributed, stale, or duplicated.`
    );
  }
}

function resolveExpectedProviderForMember(
  scenario: ProviderLaunchStressScenario,
  memberName: string,
  expectedMembers: string[]
): TeamProviderId {
  const index = expectedMembers.indexOf(memberName);
  if (index < 0) throw new Error(`Unknown expected provider launch member ${memberName}.`);
  return resolveStressMemberProvider(scenario, index);
}

function assertExactAttributableTaskReply(
  comments: Array<{ author: string; text: string; createdAt: string }>,
  probe: { replyText?: string; marker?: string; memberName: string },
  launchEvidenceStartedAt: number
): void {
  const expectedText = probe.replyText ?? `${probe.marker}:done`;
  const exactReplies = comments.filter((comment) => comment.text === expectedText);
  const valid =
    exactReplies.length === 1 &&
    exactReplies[0]?.author === probe.memberName &&
    Number.isFinite(Date.parse(exactReplies[0]?.createdAt ?? '')) &&
    Date.parse(exactReplies[0]?.createdAt ?? '') >= launchEvidenceStartedAt;
  if (!valid) {
    throw new Error(
      `Reply evidence for ${probe.memberName} is missing, misattributed, or duplicated.`
    );
  }
}

async function waitForExactPeerMessage(
  teamName: string,
  recipient: string,
  sender: string,
  text: string,
  timeoutMs: number
): Promise<void> {
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${recipient}.json`);
  await waitForStressCondition(
    `exact peer proof ${sender}->${recipient}`,
    async () => {
      const messages = await readInboxMessages(inboxPath);
      return (
        messages.filter(
          (message) => message.from === sender && message.to === recipient && message.text === text
        ).length === 1
      );
    },
    timeoutMs,
    1_500,
    async () => `Exact peer proof was absent, duplicated, or late in ${inboxPath}`
  );
}

async function snapshotProofEffects(active: ActiveScenario): Promise<string> {
  if (!active.proofAudit) return JSON.stringify({ version: 1, entries: [], receipts: [] });
  const taskReader = new TeamTaskReader();
  const tasks = await taskReader.getTasks(active.teamName);
  const receipts = await readProviderEffectReceipts(active.proofAudit.accounting);
  const entries = await Promise.all(
    active.proofAudit.entries.map(async (entry) => {
      const task = tasks.find((candidate) => candidate.id === entry.taskId);
      const peerMessages =
        entry.peerRecipient && entry.peerText
          ? await readInboxMessages(
              path.join(
                getTeamsBasePath(),
                active.teamName,
                'inboxes',
                `${entry.peerRecipient}.json`
              )
            )
          : [];
      return {
        taskId: entry.taskId,
        status: task?.status,
        comments: (task?.comments ?? []).filter((comment) => comment.text === entry.replyText),
        peers: peerMessages.filter(
          (message) =>
            message.from === entry.memberName &&
            message.to === entry.peerRecipient &&
            message.text === entry.peerText
        ),
        peerAcks: entry.peerAckText
          ? tasks.flatMap((candidate) =>
              (candidate.comments ?? []).filter((comment) => comment.text === entry.peerAckText)
            )
          : [],
        providerReceipts: receipts.filter(
          (receipt) => receipt.taskId === entry.taskId && receipt.kind !== 'runtime-credential-lock'
        ),
      };
    })
  );
  return JSON.stringify({
    version: 1,
    entries,
    // Keep the complete immutable collector ledger.  A later scenario may
    // legitimately inherit receipts from an earlier one, but its before-stop
    // snapshot becomes the authoritative full-ledger baseline; a deletion,
    // foreign addition, or late settlement then changes this exact receipt
    // sequence and fails final reconciliation.
    receipts,
  });
}

async function requireIndependentProviderEffectReceiptLedger(
  active: ActiveScenario,
  runId: string
): Promise<PinnedAccountingLedger> {
  const authorization = getLiveStressAuthorization();
  if (!authorization.ok || !authorization.accounting) {
    throw new Error(
      'Provider launch stress requires a pinned independently emitted accounting collector.'
    );
  }
  const receipts = await readProviderEffectReceipts(authorization.accounting);
  if (
    !receipts.some((receipt) => receipt.teamName === active.teamName && receipt.runId === runId)
  ) {
    throw new Error('Provider/runtime/accounting receipt ledger has no record for this exact run.');
  }
  return authorization.accounting;
}

async function readProviderEffectReceipts(
  accounting: PinnedAccountingLedger
): Promise<ProviderEffectReceipt[]> {
  const response = await requestAuthenticatedCollectorSnapshot(accounting);
  const payload = response.payload as Record<string, unknown>;
  const ledger = payload.ledger as Record<string, unknown> | undefined;
  const provenance = payload.provenance as Record<string, unknown> | undefined;
  const issuer = payload.issuer as Record<string, unknown> | undefined;
  if (
    payload.version !== 1 ||
    payload.collectorId !== accounting.collectorId ||
    !ledger ||
    !provenance ||
    ledger.dev !== accounting.dev ||
    ledger.ino !== accounting.ino ||
    provenance?.dev !== accounting.provenanceDev ||
    provenance.ino !== accounting.provenanceIno ||
    provenance.sha256 !== accounting.provenanceSha256 ||
    issuer?.id !== accounting.issuerId ||
    typeof payload.receipts !== 'string' ||
    createHash('sha256').update(Buffer.from(payload.receipts, 'base64')).digest('hex') !==
      ledger.sha256
  ) {
    throw new Error('Pinned provider/runtime/accounting collector changed.');
  }
  const raw = Buffer.from(payload.receipts, 'base64').toString('utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const receipt = JSON.parse(line) as ProviderEffectReceipt;
      if (
        receipt.version !== 1 ||
        receipt.issuerId !== accounting.issuerId ||
        !cryptoVerifyCollectorSnapshot(
          receipt.issuerPayload,
          receipt.issuerSignature,
          accounting.issuerPublicKey
        )
      ) {
        throw new Error(
          'Provider/runtime/accounting receipt is not from pinned collector and issuer provenance.'
        );
      }
      const producer = JSON.parse(receipt.issuerPayload) as Record<string, unknown>;
      assertSignedProviderAttribution(receipt, producer);
      return receipt;
    });
}

function assertSignedProviderAttribution(
  receipt: ProviderEffectReceipt,
  producer: Record<string, unknown>
): void {
  const receiptFields: Record<string, unknown> = {
    billingEventId: receipt.billingEventId,
    teamName: receipt.teamName,
    runId: receipt.runId,
    taskId: receipt.taskId,
    memberName: receipt.memberName,
    providerId: receipt.providerId,
    kind: receipt.kind,
    terminalOutcome: receipt.terminalOutcome,
    runtimeSessionId: receipt.runtimeSessionId,
    marker: receipt.marker,
    credentialLock: receipt.credentialLock,
  };
  for (const key of [
    'billingEventId',
    'teamName',
    'runId',
    'taskId',
    'memberName',
    'providerId',
    'kind',
    'terminalOutcome',
    'runtimeSessionId',
    'marker',
    'credentialLock',
  ]) {
    if (
      canonicalizeSignedReceiptField(producer[key]) !==
      canonicalizeSignedReceiptField(receiptFields[key])
    ) {
      throw new Error('Producer signature does not bind the billing receipt fields.');
    }
  }
}

function canonicalizeSignedReceiptField(value: unknown): string {
  if (value === undefined) return '__absent__';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Signed receipt contains an unsafe number.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeSignedReceiptField).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new Error('Signed receipt contains a non-JSON field.');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeSignedReceiptField(record[key])}`)
    .join(',')}}`;
}

async function requestAuthenticatedCollectorSnapshot(
  accounting: PinnedAccountingLedger,
  mode: 'snapshot' | 'accept-baseline' = 'snapshot'
): Promise<{ payload: Record<string, unknown> }> {
  const nonce = randomBytes(32).toString('hex');
  const line = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(accounting.endpoint);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000);
    socket.once('connect', () => socket.write(`${mode} ${nonce}\n`));
    socket.on('data', (chunk) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline >= 0) {
        socket.end();
        resolve(received.slice(0, newline));
      }
    });
    socket.once('timeout', () => reject(new Error('accounting collector snapshot timed out')));
    socket.once('error', reject);
  });
  let response: { payload?: unknown; signature?: unknown; error?: unknown };
  try {
    response = JSON.parse(line) as { payload?: unknown; signature?: unknown; error?: unknown };
  } catch {
    throw new Error('accounting collector returned malformed snapshot evidence');
  }
  if (typeof response.error === 'string')
    throw new Error(`accounting collector: ${response.error}`);
  if (typeof response.payload !== 'string' || typeof response.signature !== 'string') {
    throw new Error('accounting collector omitted signed snapshot evidence');
  }
  if (!cryptoVerifyCollectorSnapshot(response.payload, response.signature, accounting.publicKey)) {
    throw new Error('accounting collector snapshot signature is invalid');
  }
  const payload = JSON.parse(response.payload) as Record<string, unknown>;
  if (payload.nonce !== nonce) {
    throw new Error('accounting collector snapshot replayed a different challenge.');
  }
  return { payload };
}

async function acceptAuthenticatedFourProviderSequenceBaseline(
  scenarioProofs: readonly ScenarioSequenceProof[]
): Promise<void> {
  const expected = collectDeterministicFourProviderSequenceBaseline(scenarioProofs);
  const accounting = expected.accounting;
  const { payload } = await requestAuthenticatedCollectorSnapshot(accounting, 'accept-baseline');
  const baseline = payload.baseline as Record<string, unknown> | undefined;
  if (
    payload.sealed !== false ||
    baseline?.accepted !== true ||
    typeof baseline.ledgerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(baseline.ledgerSha256) ||
    !Number.isSafeInteger(baseline.receiptCount) ||
    !Number.isSafeInteger(baseline.settlementCount) ||
    !Number.isSafeInteger(baseline.providerSettlementCount) ||
    !Number.isSafeInteger(baseline.credentialLockSettlementCount) ||
    typeof baseline.identityDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(baseline.identityDigest) ||
    baseline.receiptCount !== expected.receiptCount ||
    baseline.settlementCount !== expected.settlementCount ||
    baseline.providerSettlementCount !== expected.providerSettlementCount ||
    baseline.credentialLockSettlementCount !== expected.credentialLockSettlementCount ||
    baseline.providerSettlementCount !== DEFAULT_ORDER.length ||
    baseline.credentialLockSettlementCount !== DEFAULT_ORDER.length ||
    baseline.settlementCount !==
      baseline.providerSettlementCount + baseline.credentialLockSettlementCount ||
    (payload.ledger as Record<string, unknown> | undefined)?.sha256 !== baseline.ledgerSha256 ||
    typeof payload.receipts !== 'string'
  ) {
    throw new Error('accounting collector did not accept the exact four-provider proof baseline');
  }
  const acceptedReceipts = Buffer.from(payload.receipts, 'base64').toString('utf8');
  const acceptedLedgerReceipts = acceptedReceipts
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderEffectReceipt);
  assertDeterministicFourProviderSequenceMultiset(expected.receipts, acceptedLedgerReceipts);
}

function collectDeterministicFourProviderSequenceBaseline(
  scenarioProofs: readonly ScenarioSequenceProof[]
): {
  accounting: PinnedAccountingLedger;
  receipts: ProviderEffectReceipt[];
  receiptCount: number;
  settlementCount: number;
  providerSettlementCount: number;
  credentialLockSettlementCount: number;
} {
  if (scenarioProofs.length !== DEFAULT_ORDER.length) {
    throw new Error('Four-provider sequence did not collect every required scenario proof.');
  }
  const accounting = scenarioProofs[0]?.audit.accounting;
  if (!accounting) throw new Error('Four-provider sequence has no pinned accounting collector.');

  const receipts: ProviderEffectReceipt[] = [];
  const billingEventIds = new Set<string>();
  for (const [index, proof] of scenarioProofs.entries()) {
    const expectedProvider = DEFAULT_ORDER[index];
    if (proof.scenario !== expectedProvider) {
      throw new Error(`Four-provider sequence is non-deterministic at position ${index + 1}.`);
    }
    if (
      proof.audit.accounting.collectorId !== accounting.collectorId ||
      proof.audit.accounting.issuerId !== accounting.issuerId ||
      proof.audit.accounting.publicKey !== accounting.publicKey
    ) {
      throw new Error('Four-provider sequence spans more than one accounting authority.');
    }
    if (
      proof.audit.entries.length === 0 ||
      proof.audit.entries.some((entry) => entry.providerId !== expectedProvider)
    ) {
      throw new Error(`Four-provider sequence lacks attributable ${expectedProvider} effects.`);
    }
    assertExactProofSnapshot(proof.audit, proof.audit.beforeStop, proof.teamName);
    const snapshot = JSON.parse(proof.audit.beforeStop) as { receipts?: unknown };
    if (!Array.isArray(snapshot.receipts)) {
      throw new Error(`Four-provider ${expectedProvider} proof has no receipt ledger.`);
    }
    const scenarioReceipts = (snapshot.receipts as ProviderEffectReceipt[]).filter(
      (receipt) => receipt?.teamName === proof.teamName && receipt?.issuerId === accounting.issuerId
    );
    for (const receipt of scenarioReceipts) {
      if (billingEventIds.has(receipt.billingEventId)) {
        throw new Error('Four-provider sequence contains a duplicate signed billing event.');
      }
      billingEventIds.add(receipt.billingEventId);
      receipts.push(receipt);
    }
  }
  assertDeterministicFourProviderSequenceMultiset(receipts, receipts);
  return {
    accounting,
    receipts,
    receiptCount: receipts.length,
    // The baseline has four provider settlements and four independent
    // credential-lock lifecycles. Both are terminal accounting settlements,
    // so the total is eight rather than silently dividing every receipt by
    // the provider's three-receipt shape.
    providerSettlementCount: DEFAULT_ORDER.length,
    credentialLockSettlementCount: DEFAULT_ORDER.length,
    settlementCount: DEFAULT_ORDER.length * 2,
  };
}

function assertNoOverlappingProviderCredentialCriticalSections(
  receipts: readonly ProviderEffectReceipt[],
  requiredProviders: readonly TeamProviderId[] = DEFAULT_ORDER
): readonly ProviderCredentialCriticalSectionEvidence[] {
  const evidence: ProviderCredentialCriticalSectionEvidence[] = [];
  const released = new Map<string, {
    providerId: TeamProviderId;
    enteredAtSequence: number;
    exitedAtSequence: number;
    ownerId: string;
    ownerRuntimeSessionId: string;
    receiptIds: string[];
  }>();
  const completed = new Set<string>();
  let active:
    | {
        providerId: TeamProviderId;
        lockId: string;
        ownerId: string;
        ownerRuntimeSessionId: string;
        enteredAtSequence: number;
        receiptIds: string[];
      }
    | undefined;

  // Every provider effect carries the signed identity of the active runtime
  // credential lock. The lock lifecycle itself remains the exclusive-boundary
  // proof, but an effect outside its acquisition-to-revocation interval (or
  // from another owner/session) is rejected rather than merely ignored.
  for (const [sequence, receipt] of receipts.entries()) {
    const lock = receipt.credentialLock;
    if (receipt.kind !== 'runtime-credential-lock') {
      if (
        !lock ||
        lock.event !== 'effect' ||
        !active ||
        active.providerId !== receipt.providerId ||
        active.lockId !== lock.lockId ||
        active.ownerId !== lock.ownerId ||
        active.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId ||
        receipt.runtimeSessionId !== lock.ownerRuntimeSessionId
      ) {
        throw new Error(
          `Provider effect is not bound to the active credential-lock owner at sequence ${sequence}.`
        );
      }
      continue;
    }
    if (
      !lock ||
      !receipt.runtimeSessionId?.trim() ||
      !receipt.billingEventId?.trim() ||
      !lock.lockId?.trim() ||
      !lock.ownerId?.trim() ||
      lock.ownerRuntimeSessionId !== receipt.runtimeSessionId ||
      lock.event === 'effect'
    ) {
      throw new Error('Runtime credential-lock evidence lacks its actual owner identity.');
    }
    if (lock.event === 'acquire') {
      if (receipt.terminalOutcome !== 'acquired' || active || released.has(lock.lockId) || completed.has(lock.lockId)) {
        throw new Error(
          `Provider credential-lock overlap or duplicate acquisition for ${receipt.providerId}.`
        );
      }
      active = {
        providerId: receipt.providerId,
        lockId: lock.lockId,
        ownerId: lock.ownerId,
        ownerRuntimeSessionId: lock.ownerRuntimeSessionId,
        enteredAtSequence: sequence,
        receiptIds: [receipt.billingEventId],
      };
      continue;
    }
    if (lock.event === 'release') {
      if (
        receipt.terminalOutcome !== 'released' ||
        !active ||
        active.providerId !== receipt.providerId ||
        active.lockId !== lock.lockId ||
        active.ownerId !== lock.ownerId ||
        active.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId
      ) {
        throw new Error(
          `Runtime credential-lock release occurred without the owning lock for ${receipt.providerId}.`
        );
      }
      active.receiptIds.push(receipt.billingEventId);
      released.set(lock.lockId, {
        providerId: active.providerId,
        enteredAtSequence: active.enteredAtSequence,
        exitedAtSequence: sequence,
        ownerId: active.ownerId,
        ownerRuntimeSessionId: active.ownerRuntimeSessionId,
        receiptIds: active.receiptIds,
      });
      active = undefined;
      continue;
    }
    if (lock.event !== 'revocation' || receipt.terminalOutcome !== 'revoked') {
      throw new Error(
        `Runtime credential-lock evidence has an invalid event for ${receipt.providerId}.`
      );
    }
    const prior = released.get(lock.lockId);
    if (
      active ||
      !prior ||
      completed.has(lock.lockId) ||
      prior.providerId !== receipt.providerId ||
      prior.ownerId !== lock.ownerId ||
      prior.ownerRuntimeSessionId !== lock.ownerRuntimeSessionId
    ) {
      throw new Error(`Runtime credential-lock revocation is not owned by ${receipt.providerId}.`);
    }
    prior.receiptIds.push(receipt.billingEventId);
    evidence.push({ ...prior, revokedAtSequence: sequence, lockId: lock.lockId });
    completed.add(lock.lockId);
  }
  if (active) {
    throw new Error(`Runtime credential-lock did not release for ${active.providerId}.`);
  }
  if (released.size !== completed.size) {
    throw new Error('Runtime credential-lock did not emit revocation evidence for every released lock.');
  }
  if (
    evidence.length !== requiredProviders.length ||
    new Set(evidence.map((entry) => entry.providerId)).size !== requiredProviders.length ||
    evidence.some((entry) => !requiredProviders.includes(entry.providerId))
  ) {
    throw new Error('Four-provider proof has missing or duplicated runtime credential-lock evidence.');
  }
  return evidence;
}

function assertDeterministicFourProviderSequenceMultiset(
  expected: readonly ProviderEffectReceipt[],
  actual: readonly ProviderEffectReceipt[]
): void {
  assertExactFourProviderProofReceiptMultiset(expected);
  assertExactFourProviderProofReceiptMultiset(actual);
  assertNoOverlappingProviderCredentialCriticalSections(expected);
  assertNoOverlappingProviderCredentialCriticalSections(actual);
  const expectedMultiset = deterministicReceiptIdentityMultiset(expected);
  const actualMultiset = deterministicReceiptIdentityMultiset(actual);
  if (!areIdentityMultisetsBijective(expectedMultiset, actualMultiset)) {
    throw new Error('Final sealed accounting receipts differ from the accepted four-provider baseline.');
  }
}

function assertExactFourProviderProofReceiptMultiset(
  receipts: readonly ProviderEffectReceipt[]
): void {
  const requiredProviders = [...DEFAULT_ORDER];
  const effectReceipts = receipts.filter((receipt) => receipt.kind !== 'runtime-credential-lock');
  const kinds: ReadonlyArray<[
    ProviderEffectReceipt['kind'],
    ProviderEffectReceipt['terminalOutcome'],
  ]> = [
    ['provider-request', 'accepted'],
    ['provider-debit', 'debited'],
    ['provider-effect', 'effect-observed'],
  ];
  if (effectReceipts.length !== requiredProviders.length * kinds.length) {
    throw new Error('Four-provider proof must contain exactly four total provider effects.');
  }
  const providerCounts = new Map<TeamProviderId, number>();
  for (const provider of requiredProviders) {
    const providerReceipts = effectReceipts.filter((receipt) => receipt.providerId === provider);
    if (providerReceipts.length !== kinds.length) {
      throw new Error(`Four-provider proof has overlapping or missing ${provider} credentials.`);
    }
    for (const [kind, terminalOutcome] of kinds) {
      if (
        providerReceipts.filter(
          (receipt) => receipt.kind === kind && receipt.terminalOutcome === terminalOutcome
        ).length !== 1
      ) {
        throw new Error(`Four-provider proof does not have exactly one ${provider} ${kind}.`);
      }
    }
    providerCounts.set(provider, providerReceipts.length);
  }
  if (
    new Set(effectReceipts.map((receipt) => receipt.providerId)).size !== requiredProviders.length ||
    effectReceipts.some((receipt) => !requiredProviders.includes(receipt.providerId)) ||
    [...providerCounts.values()].some((count) => count !== kinds.length)
  ) {
    throw new Error('Four-provider proof contains an unaccepted provider effect.');
  }
}

function deterministicReceiptIdentityMultiset(
  receipts: readonly ProviderEffectReceipt[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const receipt of receipts) {
    const identity = providerEffectIdentity(receipt);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function cryptoVerifyCollectorSnapshot(
  payload: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

async function readCollectorReadyForTest(
  child: ReturnType<typeof spawn>,
  endpoint: string
): Promise<{ collectorId: string; publicKey: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('collector test fixture did not become ready')),
      5_000
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const ready = JSON.parse(output.slice(0, newline)) as {
          collectorId?: unknown;
          publicKey?: unknown;
        };
        if (
          typeof ready.collectorId !== 'string' ||
          typeof ready.publicKey !== 'string' ||
          !ready.publicKey.includes('BEGIN PUBLIC KEY') ||
          !statSync(endpoint).isSocket()
        ) {
          throw new Error('collector test fixture emitted malformed authority');
        }
        resolve({ collectorId: ready.collectorId, publicKey: ready.publicKey });
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes('\n')) {
        clearTimeout(timeout);
        reject(new Error(`collector test fixture exited before readiness (${code ?? 'signal'})`));
      }
    });
  });
}

function providerEffectIdentity(receipt: ProviderEffectReceipt): string {
  // The identity includes the exact authenticated envelope, not only its
  // display fields. A second validly signed effect with a new event ID, or a
  // replacement payload/signature, must not collapse into the accepted set.
  return createHash('sha256')
    .update(
      canonicalizeCapabilityJson({
        issuerId: receipt.issuerId,
        issuerPayload: receipt.issuerPayload,
        issuerSignature: receipt.issuerSignature,
        billingEventId: receipt.billingEventId,
        teamName: receipt.teamName,
        runId: receipt.runId,
        taskId: receipt.taskId,
        memberName: receipt.memberName,
        providerId: receipt.providerId,
        runtimeSessionId: receipt.runtimeSessionId,
        marker: receipt.marker,
        kind: receipt.kind,
        terminalOutcome: receipt.terminalOutcome,
        credentialLock: receipt.credentialLock,
      })
    )
    .digest('hex');
}

function collectAcceptedSettlementIdentityMultiset(
  serialized: string,
  teamName: string,
  issuerId: string
): Map<string, number> {
  const snapshot = JSON.parse(serialized) as { receipts?: unknown };
  if (!Array.isArray(snapshot.receipts)) {
    throw new Error(`Provider proof accounting snapshot is malformed for ${teamName}.`);
  }
  const identities = new Map<string, number>();
  for (const receipt of snapshot.receipts as ProviderEffectReceipt[]) {
    if (receipt?.teamName !== teamName || receipt?.issuerId !== issuerId) continue;
    const identity = providerEffectIdentity(receipt);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  return identities;
}

function collectSealedAccountingReceiptIdentities(
  serialized: string,
  teamName: string,
  issuerId: string
): string[] {
  const snapshot = JSON.parse(serialized) as { receipts?: unknown };
  if (!Array.isArray(snapshot.receipts)) {
    throw new Error(`Final sealed accounting proof is malformed for ${teamName}.`);
  }
  return (snapshot.receipts as ProviderEffectReceipt[])
    .filter((receipt) => receipt?.teamName === teamName && receipt?.issuerId === issuerId)
    .map(providerEffectIdentity);
}

function assertFinalSealedAccountingProofReconciliation(
  acceptedBaseline: string,
  finalSnapshot: string,
  teamName: string,
  issuerId: string
): void {
  const expected = collectSealedAccountingReceiptIdentities(
    acceptedBaseline,
    teamName,
    issuerId
  );
  const actual = collectSealedAccountingReceiptIdentities(finalSnapshot, teamName, issuerId);
  const expectedMultiset = new Map<string, number>();
  const actualMultiset = new Map<string, number>();
  for (const identity of expected) {
    expectedMultiset.set(identity, (expectedMultiset.get(identity) ?? 0) + 1);
  }
  for (const identity of actual) {
    actualMultiset.set(identity, (actualMultiset.get(identity) ?? 0) + 1);
  }
  if (!areIdentityMultisetsBijective(expectedMultiset, actualMultiset)) {
    throw new Error(`Final sealed accounting receipts differ from accepted proof for ${teamName}.`);
  }
  if (expected.length !== actual.length || expected.some((identity, index) => actual[index] !== identity)) {
    throw new Error(`Final sealed accounting authority effects were reordered for ${teamName}.`);
  }
}

function assertExactProofSnapshot(
  audit: ProofAudit,
  serialized: string,
  teamName: string,
  expectedSettlementIdentityMultiset?: ReadonlyMap<string, number>
): void {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    throw new Error(`Provider proof snapshot is malformed for ${teamName}.`);
  }
  const record = snapshot as { version?: unknown; entries?: unknown; receipts?: unknown };
  const entries = record?.entries;
  if (!Array.isArray(entries) || entries.length !== audit.entries.length) {
    throw new Error(`Provider proof snapshot is incomplete for ${teamName}.`);
  }
  if (record.version !== 1 || !Array.isArray(record.receipts)) {
    throw new Error(`Provider proof accounting snapshot is malformed for ${teamName}.`);
  }
  for (const expected of audit.entries) {
    const entry = entries.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) &&
        typeof candidate === 'object' &&
        (candidate as Record<string, unknown>).taskId === expected.taskId
    );
    const count = (field: 'comments' | 'peers' | 'peerAcks') =>
      Array.isArray(entry?.[field]) ? entry[field].length : -1;
    const receipts = Array.isArray(entry?.providerReceipts)
      ? (entry.providerReceipts as ProviderEffectReceipt[])
      : [];
    const exactReceipt = (
      kind: ProviderEffectReceipt['kind'],
      terminalOutcome: ProviderEffectReceipt['terminalOutcome']
    ) =>
      receipts.filter(
        (receipt) =>
          receipt?.kind === kind &&
          receipt.issuerId === audit.accounting.issuerId &&
          receipt.terminalOutcome === terminalOutcome &&
          receipt.teamName === teamName &&
          receipt.taskId === expected.taskId &&
          receipt.memberName === expected.memberName &&
          receipt.runId === expected.runId &&
          receipt.providerId === expected.providerId &&
          receipt.runtimeSessionId === expected.runtimeSessionId &&
          receipt.marker === expected.marker
      ).length;
    if (
      count('comments') !== 1 ||
      (expected.peerText !== null && count('peers') !== 1) ||
      (expected.peerAckText !== null && count('peerAcks') !== 1) ||
      exactReceipt('provider-request', 'accepted') !== 1 ||
      exactReceipt('provider-debit', 'debited') !== 1 ||
      exactReceipt('provider-refund', 'refunded') !== 0 ||
      exactReceipt('provider-effect', 'effect-observed') !== 1 ||
      receipts.length !== 3
    ) {
      throw new Error(
        `Provider proof is missing, duplicated, or malformed at ${teamName} baseline/final snapshot.`
      );
    }
  }
  const settlementReceipts = (record.receipts as ProviderEffectReceipt[]).filter(
    (receipt) =>
      receipt?.teamName === teamName &&
      receipt?.issuerId === audit.accounting.issuerId
  );
  const scenarioReceipts = settlementReceipts.filter(
    (receipt) => receipt.kind !== 'runtime-credential-lock'
  );
  const expectedReceiptCount = audit.entries.length * 3;
  if (scenarioReceipts.length !== expectedReceiptCount) {
    throw new Error(`Provider proof accounting contains a late or extra billing event for ${teamName}.`);
  }
  const billingEventIds = new Set<string>();
  for (const receipt of scenarioReceipts) {
    if (
      typeof receipt?.billingEventId !== 'string' ||
      receipt.billingEventId.length < 16 ||
      billingEventIds.has(receipt.billingEventId)
    ) {
      throw new Error(
        `Provider proof accounting cannot reconcile a unique closed billing event for ${teamName}.`
      );
    }
    billingEventIds.add(receipt.billingEventId);
    if (
      (receipt.kind === 'provider-request' && receipt.terminalOutcome !== 'accepted') ||
      (receipt.kind === 'provider-debit' && receipt.terminalOutcome !== 'debited') ||
      (receipt.kind === 'provider-refund' && receipt.terminalOutcome !== 'refunded') ||
      (receipt.kind === 'provider-effect' && receipt.terminalOutcome !== 'effect-observed')
    ) {
      throw new Error(`Provider proof accounting has an unresolved billing terminal state for ${teamName}.`);
    }
    const expected = audit.entries.find(
      (entry) =>
        entry.taskId === receipt.taskId &&
        entry.memberName === receipt.memberName &&
        entry.runId === receipt.runId &&
        entry.providerId === receipt.providerId &&
        entry.runtimeSessionId === receipt.runtimeSessionId &&
        entry.marker === receipt.marker
    );
    if (!expected || receipt.teamName !== teamName || receipt.issuerId !== audit.accounting.issuerId) {
      throw new Error(`Provider proof accounting contains an unrecognized billing event for ${teamName}.`);
    }
  }
  if (expectedSettlementIdentityMultiset) {
    const finalSettlementIdentityMultiset = new Map<string, number>();
    for (const receipt of settlementReceipts) {
      const identity = providerEffectIdentity(receipt);
      finalSettlementIdentityMultiset.set(
        identity,
        (finalSettlementIdentityMultiset.get(identity) ?? 0) + 1
      );
    }
    if (!areIdentityMultisetsBijective(
      expectedSettlementIdentityMultiset,
      finalSettlementIdentityMultiset
    )) {
      throw new Error(
        `Provider proof accounting has missing, extra, or replaced authenticated effect identities for ${teamName}.`
      );
    }
  }
  assertNoOverlappingProviderCredentialCriticalSections(
    settlementReceipts,
    [...new Set(audit.entries.map((entry) => entry.providerId))]
  );
}

function areIdentityMultisetsBijective(
  expected: ReadonlyMap<string, number>,
  actual: ReadonlyMap<string, number>
): boolean {
  if (expected.size !== actual.size) return false;
  for (const [identity, count] of expected) {
    if (actual.get(identity) !== count) return false;
  }
  return true;
}

function isAcceptedStressRelayResult(
  relay: Awaited<ReturnType<TeamProvisioningService['relayInboxFileToLiveRecipient']>>
): boolean {
  if (relay.kind === 'native_member_noop') return true;
  if (relay.relayed > 0) return true;
  const lastDelivery = relay.lastDelivery;
  return Boolean(
    lastDelivery &&
    (lastDelivery.accepted === true ||
      lastDelivery.delivered === true ||
      lastDelivery.responsePending === true)
  );
}

function resolvePostLaunchWorkTargets(
  _scenario: ProviderLaunchStressScenario,
  expectedMembers: string[]
): string[] {
  const target = expectedMembers[0];
  if (!target) throw new Error('Provider launch stress has no member for its one proof effect.');
  // WORK_TARGETS is intentionally non-authoritative. In particular `all`
  // cannot turn one provider proof into concurrent same-provider credential
  // use or expand the four-provider accepted accounting multiset.
  return [target];
}

async function listRegularFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(root);
  return files;
}

async function waitForStressCondition(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs: number,
  diagnostics: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const suffix = lastError
    ? `\nLast error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : '';
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${suffix}\n${await diagnostics()}`
  );
}

function discardKnownProviderLaunchStressWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (!warn.mock) return;
  const calls = warn.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const text = calls[index]?.map((value) => String(value)).join(' ') ?? '';
    if (text.includes('Failed to resolve login shell env: shell env resolve timeout')) {
      calls.splice(index, 1);
    }
  }
}

function buildStressCreateRequest(input: {
  scenario: ProviderLaunchStressScenario;
  teamName: string;
  memberCount: number;
  selection: ReturnType<typeof resolveScenarioSelection>;
  disposableProject: DisposableProject;
}): TeamCreateRequest {
  const members = buildStressMembers(input.scenario, input.memberCount, input.selection);
  const providerId: TeamProviderId = input.scenario === 'mixed' ? 'anthropic' : input.scenario;
  return {
    teamName: input.teamName,
    cwd: input.disposableProject.projectPath,
    providerId,
    providerBackendId:
      providerId === 'codex'
        ? 'codex-native'
        : providerId === 'gemini'
          ? resolveGeminiBackend()
          : undefined,
    model:
      providerId === 'codex'
        ? input.selection.codexModel
        : providerId === 'opencode'
          ? input.selection.openCodeModel
          : providerId === 'gemini'
            ? input.selection.geminiModel
            : input.selection.anthropicModel,
    effort: providerId === 'codex' ? input.selection.codexEffort : undefined,
    fastMode: providerId === 'codex' ? 'off' : undefined,
    skipPermissions: true,
    extraCliArgs: process.env.PROVIDER_LAUNCH_STRESS_EXTRA_CLI_ARGS?.trim() || undefined,
    prompt: 'Keep the team idle after bootstrap. Do not start extra work.',
    members,
  };
}

function buildStressMembers(
  scenario: ProviderLaunchStressScenario,
  memberCount: number,
  selection: ReturnType<typeof resolveScenarioSelection>
): TeamMember[] {
  const names = buildExpectedMemberNames(memberCount);
  return names.map((name, index) => {
    const providerId = resolveStressMemberProvider(scenario, index);
    return {
      name,
      role: index % 2 === 0 ? 'Developer' : 'Reviewer',
      providerId,
      providerBackendId:
        providerId === 'codex'
          ? 'codex-native'
          : providerId === 'gemini'
            ? resolveGeminiBackend()
            : undefined,
      model:
        providerId === 'codex'
          ? selection.codexModel
          : providerId === 'opencode'
            ? (selection.openCodeModels[index % selection.openCodeModels.length] ??
              selection.openCodeModel)
            : providerId === 'gemini'
              ? selection.geminiModel
              : selection.anthropicModel,
      effort: providerId === 'codex' ? selection.codexEffort : undefined,
      fastMode: providerId === 'codex' ? 'off' : undefined,
    };
  });
}

function resolveStressMemberProvider(
  scenario: ProviderLaunchStressScenario,
  index: number
): TeamProviderId {
  if (scenario !== 'mixed') return scenario;
  const providers: TeamProviderId[] = ['anthropic', 'codex', 'gemini', 'opencode', 'anthropic'];
  return providers[index % providers.length] ?? 'anthropic';
}

function resolveScenarioSelection(_scenario: ProviderLaunchStressScenario): {
  anthropicModel: string;
  codexModel: string;
  codexEffort: 'low' | 'medium' | 'high' | 'xhigh';
  openCodeModel: string;
  openCodeModels: string[];
  geminiModel: string;
} {
  const openCodeModel =
    process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;
  const openCodeModels = process.env.PROVIDER_LAUNCH_STRESS_OPENCODE_MODELS?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  return {
    anthropicModel:
      process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    codexModel: process.env.PROVIDER_LAUNCH_STRESS_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL,
    codexEffort: (process.env.PROVIDER_LAUNCH_STRESS_CODEX_EFFORT?.trim() ||
      DEFAULT_CODEX_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh',
    openCodeModel,
    openCodeModels: openCodeModels?.length ? openCodeModels : [openCodeModel],
    geminiModel: process.env.PROVIDER_LAUNCH_STRESS_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  };
}

function getStressMemberCount(): number {
  const parsed = Number.parseInt(process.env.PROVIDER_LAUNCH_STRESS_MEMBER_COUNT ?? '5', 10);
  if (!Number.isFinite(parsed) || parsed < 2 || parsed > MEMBER_NAMES.length) {
    throw new Error(
      'Provider launch stress requires at least two members for the peer-effect invariant.'
    );
  }
  return parsed;
}

function buildExpectedMemberNames(memberCount: number): string[] {
  return MEMBER_NAMES.slice(0, memberCount);
}

function getStressOrder(): ProviderLaunchStressScenario[] {
  const raw = process.env.PROVIDER_LAUNCH_STRESS_ORDER?.trim() || STRESS_ORDER.join(',');
  const parsed = raw.split(',').map((item) => item.trim());
  if (!sameProviderOrder(parsed, STRESS_ORDER)) {
    throw new Error(
      `Provider launch stress requires order ${STRESS_ORDER.join(',')}; received ${raw}`
    );
  }
  return [...STRESS_ORDER];
}

function sameProviderOrder(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveGeminiBackend(): 'auto' | 'api' | 'cli-sdk' {
  const requested = normalizeGeminiBackend(
    process.env.PROVIDER_LAUNCH_STRESS_GEMINI_BACKEND || process.env.CLAUDE_CODE_GEMINI_BACKEND
  );
  if (requested !== 'auto') return requested;
  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim();
  const config = configRoot ? readJsonObjectSync(path.join(configRoot, '.config.json')) : null;
  if (config === INVALID_GEMINI_CONFIG) {
    throw new Error('Gemini config is invalid JSON or not an object');
  }
  const authMethod = readGeminiString(config, 'geminiLastAuthMethod');
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    readGeminiString(config, 'geminiProjectId');
  const configuredBackend = normalizeGeminiBackend(
    readGeminiString(config, 'geminiResolvedBackend') ||
      readGeminiString(config, 'geminiBackendPreference')
  );
  if (configuredBackend !== 'auto') return configuredBackend;
  if (
    process.env.GEMINI_API_KEY?.trim() ||
    ((authMethod === 'adc_authorized_user' || authMethod === 'adc_service_account') && projectId)
  ) {
    return 'api';
  }
  if (authMethod === 'cli_oauth_personal') return 'cli-sdk';
  return 'auto';
}

const INVALID_GEMINI_CONFIG = Symbol('invalid-gemini-config');

function readJsonObjectSync(
  filePath: string
): Record<string, unknown> | null | typeof INVALID_GEMINI_CONFIG {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed === null || parsed === undefined) return null;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return INVALID_GEMINI_CONFIG;
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return INVALID_GEMINI_CONFIG;
  }
}

function readGeminiString(
  config: Record<string, unknown> | null | typeof INVALID_GEMINI_CONFIG,
  key: string
): string {
  if (config === INVALID_GEMINI_CONFIG) {
    throw new Error('Gemini config is invalid JSON or not an object');
  }
  if (!config || !(key in config)) return '';
  const value = config[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value.trim();
}

function normalizeGeminiBackend(value: string | undefined): 'auto' | 'api' | 'cli-sdk' {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value !== 'string') throw new Error('Gemini backend must be a string');
  const normalized = value.trim().toLowerCase();
  const canonical = normalized === 'cli' ? 'cli-sdk' : normalized || 'auto';
  if (canonical !== 'auto' && canonical !== 'api' && canonical !== 'cli-sdk') {
    throw new Error(`unsupported Gemini backend ${JSON.stringify(value)}`);
  }
  return canonical;
}

function sanitizeEvidencePart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'local'
  );
}

/**
 * The signed wrapper capability names the expected inode; this binding keeps
 * its already-open no-follow lease private to the production spawn boundary.
 * No request, member record, or provider argument receives a proc-fd string.
 */
function bindAuthenticatedProjectDirectoryLease(request: TeamCreateRequest): void {
  const authorization = getLiveStressAuthorization();
  if (!authorization.ok || !authorization.project) {
    throw new Error(`Project directory lease authorization is unavailable: ${authorization.reason}`);
  }
  const project = authorization.project;
  const descriptor = fstatSync(PROJECT_DIRECTORY_CAPABILITY_FD, { bigint: true });
  if (
    !descriptor.isDirectory() ||
    String(descriptor.dev) !== project.projectDev ||
    String(descriptor.ino) !== project.projectIno
  ) {
    throw new Error('Wrapper project directory lease does not match signed project identity.');
  }
  bindProjectDirectoryLease(request, {
    fd: PROJECT_DIRECTORY_CAPABILITY_FD,
    dev: project.projectDev,
    ino: project.projectIno,
  });
}

async function acquireDisposableProject(): Promise<DisposableProject> {
  const suppliedRoot = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT?.trim();
  const suppliedProject = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_PATH?.trim();
  const suppliedToken = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN?.trim();
  const invocationId = process.env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID?.trim();
  const failureReservationManifest =
    process.env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST?.trim();
  if (
    suppliedRoot ||
    suppliedProject ||
    suppliedToken ||
    invocationId ||
    failureReservationManifest
  ) {
    if (
      !suppliedRoot ||
      !suppliedProject ||
      !suppliedToken ||
      !invocationId ||
      !failureReservationManifest
    ) {
      throw new Error(
        'Disposable project evidence is incomplete; refusing a project-path override.'
      );
    }
    const root = await fs.realpath(suppliedRoot);
    const projectPath = await fs.realpath(suppliedProject);
    const authorization =
      process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1' ? getLiveStressAuthorization() : null;
    if (authorization && (!authorization.ok || !authorization.project)) {
      throw new Error(`Disposable project descriptor is unavailable: ${authorization.reason}`);
    }
    const expected = authorization?.project;
    const [rootIdentity, projectIdentity, markerIdentity] = await Promise.all([
      openNoFollowIdentity(root, true),
      openNoFollowIdentity(projectPath, true),
      openNoFollowIdentity(path.join(root, '.provider-launch-stress-owner.json'), false),
    ]);
    const marker = await readOwnedDisposableMarker(root, markerIdentity);
    if (
      marker.version !== 1 ||
      marker.root !== root ||
      marker.projectPath !== projectPath ||
      marker.token !== suppliedToken ||
      marker.invocationId !== invocationId ||
      path.dirname(projectPath) !== root ||
      (expected &&
        (expected.root !== root ||
          expected.projectPath !== projectPath ||
          expected.token !== suppliedToken ||
          expected.invocationId !== invocationId))
    ) {
      throw new Error('Project-path override is not proven to be an owned disposable root.');
    }
    const manifestPath = await fs.realpath(failureReservationManifest);
    if (path.dirname(manifestPath) !== root) {
      throw new Error(
        'Failure-artifact reservation manifest is outside the owned disposable root.'
      );
    }
    const reservationManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      reservationManifest.version !== 1 ||
      reservationManifest.root !== root ||
      reservationManifest.token !== suppliedToken ||
      reservationManifest.invocationId !== invocationId ||
      !Array.isArray(reservationManifest.reservations)
    ) {
      throw new Error('Failure-artifact reservation manifest is not owned by this invocation.');
    }
    if (
      expected &&
      (String(rootIdentity.dev) !== expected.rootDev ||
        String(rootIdentity.ino) !== expected.rootIno ||
        String(projectIdentity.dev) !== expected.projectDev ||
        String(projectIdentity.ino) !== expected.projectIno ||
        String(markerIdentity.dev) !== expected.markerDev ||
        String(markerIdentity.ino) !== expected.markerIno)
    )
      throw new Error('Disposable project identity changed before canary setup.');
    return {
      root,
      projectPath,
      token: suppliedToken,
      wrapperOwned: true,
      invocationId,
      failureReservationManifest: manifestPath,
      rootDev: String(rootIdentity.dev),
      rootIno: String(rootIdentity.ino),
      projectDev: String(projectIdentity.dev),
      projectIno: String(projectIdentity.ino),
      markerDev: String(markerIdentity.dev),
      markerIno: String(markerIdentity.ino),
    };
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-launch-stress-live-'));
  const projectPath = path.join(root, 'project');
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(projectPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    '# Disposable provider launch canary project\n',
    {
      mode: 0o600,
    }
  );
  const realRoot = await fs.realpath(root);
  const realProjectPath = await fs.realpath(projectPath);
  await fs.writeFile(
    path.join(realRoot, '.provider-launch-stress-owner.json'),
    `${JSON.stringify({ version: 1, root: realRoot, projectPath: realProjectPath, token })}\n`,
    { mode: 0o600, flag: 'wx' }
  );
  const [rootIdentity, projectIdentity, markerIdentity] = await Promise.all([
    openNoFollowIdentity(realRoot, true),
    openNoFollowIdentity(realProjectPath, true),
    openNoFollowIdentity(path.join(realRoot, '.provider-launch-stress-owner.json'), false),
  ]);
  return {
    root: realRoot,
    projectPath: realProjectPath,
    token,
    wrapperOwned: false,
    rootDev: String(rootIdentity.dev),
    rootIno: String(rootIdentity.ino),
    projectDev: String(projectIdentity.dev),
    projectIno: String(projectIdentity.ino),
    markerDev: String(markerIdentity.dev),
    markerIno: String(markerIdentity.ino),
  };
}

async function recordFailureArtifactReservation(active: ActiveScenario): Promise<void> {
  const manifestPath = process.env.PROVIDER_LAUNCH_STRESS_FAILURE_RESERVATION_MANIFEST?.trim();
  const invocationId = process.env.PROVIDER_LAUNCH_STRESS_INVOCATION_ID?.trim();
  const projectRoot = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_ROOT?.trim();
  const projectToken = process.env.PROVIDER_LAUNCH_STRESS_PROJECT_TOKEN?.trim();
  if (!manifestPath && !invocationId && !projectRoot && !projectToken) return;
  if (!manifestPath || !invocationId || !projectRoot || !projectToken) {
    throw new Error('Failure-artifact reservation evidence is incomplete.');
  }
  const root = await fs.realpath(projectRoot);
  const realManifestPath = await fs.realpath(manifestPath);
  if (path.dirname(realManifestPath) !== root)
    throw new Error('Failure-artifact reservation manifest escaped owned root.');
  const manifest = JSON.parse(await fs.readFile(realManifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    manifest.version !== 1 ||
    manifest.root !== root ||
    manifest.token !== projectToken ||
    manifest.invocationId !== invocationId ||
    !Array.isArray(manifest.reservations)
  )
    throw new Error('Failure-artifact reservation manifest ownership changed.');
  const reservations = manifest.reservations as Array<Record<string, unknown>>;
  if (
    reservations.some(
      (entry) => entry.teamName === active.teamName && entry.token !== active.ownership.token
    )
  ) {
    throw new Error(`Failure-artifact reservation collision for ${active.teamName}.`);
  }
  if (
    !reservations.some(
      (entry) => entry.teamName === active.teamName && entry.token === active.ownership.token
    )
  ) {
    reservations.push({ teamName: active.teamName, token: active.ownership.token });
    await fs.writeFile(realManifestPath, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

async function assertOwnedDisposableProject(project: DisposableProject): Promise<void> {
  if (
    project.wrapperOwned &&
    !isBoundProjectDirectoryLease({
      root: project.root,
      projectPath: project.projectPath,
      token: project.token,
      invocationId: project.invocationId ?? '',
      rootDev: project.rootDev,
      rootIno: project.rootIno,
      projectDev: project.projectDev,
      projectIno: project.projectIno,
      markerDev: project.markerDev,
      markerIno: project.markerIno,
    })
  ) {
    throw new Error('Wrapper project directory lease changed before provider effect.');
  }
  const [rootIdentity, projectIdentity, markerIdentity] = await Promise.all([
    openNoFollowIdentity(project.root, true),
    openNoFollowIdentity(project.projectPath, true),
    openNoFollowIdentity(path.join(project.root, '.provider-launch-stress-owner.json'), false),
  ]);
  if (
    String(rootIdentity.dev) !== project.rootDev ||
    String(rootIdentity.ino) !== project.rootIno ||
    String(projectIdentity.dev) !== project.projectDev ||
    String(projectIdentity.ino) !== project.projectIno ||
    String(markerIdentity.dev) !== project.markerDev ||
    String(markerIdentity.ino) !== project.markerIno
  )
    throw new Error(
      'Disposable project root or owner marker identity changed before provider launch.'
    );
  const marker = await readOwnedDisposableMarker(project.root, markerIdentity);
  if (
    marker.version !== 1 ||
    marker.root !== project.root ||
    marker.projectPath !== project.projectPath ||
    marker.token !== project.token ||
    (project.invocationId !== undefined && marker.invocationId !== project.invocationId) ||
    path.dirname(project.projectPath) !== project.root
  ) {
    throw new Error('Disposable project ownership changed before provider launch.');
  }
}

async function readOwnedDisposableMarker(
  root: string,
  expectedIdentity?: { dev: bigint; ino: bigint }
): Promise<Record<string, unknown>> {
  const markerPath = path.join(root, '.provider-launch-stress-owner.json');
  const fd = openSync(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      (expectedIdentity &&
        (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino))
    )
      throw new Error('Disposable project ownership marker changed while reading.');
    const marker = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      throw new Error('Disposable project ownership marker is malformed.');
    }
    return marker as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

async function openNoFollowIdentity(
  target: string,
  directory: boolean
): Promise<{ dev: bigint; ino: bigint }> {
  const before = await fs.lstat(target, { bigint: true });
  if ((directory ? !before.isDirectory() : !before.isFile()) || before.isSymbolicLink()) {
    throw new Error(`Refused replaced or symlinked disposable path: ${target}`);
  }
  const fd = openSync(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (directory ? fsConstants.O_DIRECTORY : 0)
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      (directory ? !opened.isDirectory() : !opened.isFile()) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error(`Disposable path changed while opening: ${target}`);
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(fd);
  }
}

async function acquireTeamOwnership(teamName: string): Promise<TeamOwnership> {
  const teamPath = path.join(getTeamsBasePath(), teamName);
  const locksRoot = path.join(getTeamsBasePath(), '.provider-launch-stress-locks');
  const lockPath = path.join(locksRoot, `${teamName}.json`);
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(locksRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(lockPath, `${JSON.stringify({ teamName, token, phase: 'reserved' })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    throw new Error(
      `Team name collision for ${teamName}; refusing to touch an existing invocation.`,
      {
        cause: error,
      }
    );
  }
  try {
    await fs.lstat(teamPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lockPath, token };
    throw error;
  }
  await fs.writeFile(lockPath, 'provider-stress collision tombstone\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  throw new Error(`Team name collision for ${teamName}; refusing to touch an existing team.`);
}

async function writeTeamOwnershipMarker(active: ActiveScenario): Promise<void> {
  const teamPath = path.join(getTeamsBasePath(), active.teamName);
  await fs.writeFile(
    path.join(teamPath, '.provider-launch-stress-owner.json'),
    `${JSON.stringify({ teamName: active.teamName, token: active.ownership.token })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
}

async function updateTeamReservation(active: ActiveScenario): Promise<void> {
  await fs.writeFile(
    active.ownership.lockPath,
    `${JSON.stringify({ teamName: active.teamName, token: active.ownership.token, phase: active.phase })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

async function assertActiveReservation(active: ActiveScenario): Promise<void> {
  const lock = JSON.parse(await fs.readFile(active.ownership.lockPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    lock.teamName !== active.teamName ||
    lock.token !== active.ownership.token ||
    lock.phase !== active.phase
  ) {
    throw new Error(`Team ${active.teamName} reservation ownership changed during teardown.`);
  }
}

async function assertReservationOwnership(active: ActiveScenario): Promise<void> {
  const lock = JSON.parse(await fs.readFile(active.ownership.lockPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (lock.teamName !== active.teamName || lock.token !== active.ownership.token) {
    throw new Error(`Team ${active.teamName} reservation token changed during teardown.`);
  }
}

async function assertOwnedTeam(active: ActiveScenario): Promise<void> {
  if (!active.created)
    throw new Error(`Team ${active.teamName} was never created by this invocation.`);
  const marker = JSON.parse(
    await fs.readFile(
      path.join(getTeamsBasePath(), active.teamName, '.provider-launch-stress-owner.json'),
      'utf8'
    )
  ) as Record<string, unknown>;
  if (marker.teamName !== active.teamName || marker.token !== active.ownership.token) {
    throw new Error(`Team ${active.teamName} is not owned by this invocation.`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type ProcIdentityObservation =
  | { kind: 'present'; identity: LinuxProcessIdentity }
  | { kind: 'gone' }
  | { kind: 'unresolved'; diagnostic: string };

function observeLinuxProcessIdentity(procPath: string): ProcIdentityObservation {
  try {
    const identity = readLinuxProcessIdentity(procPath);
    return identity
      ? { kind: 'present', identity }
      : { kind: 'unresolved', diagnostic: `malformed /proc identity at ${procPath}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' };
    return { kind: 'unresolved', diagnostic: `cannot read ${procPath}: ${code ?? String(error)}` };
  }
}

function noteTeardownDiagnostic(active: ActiveScenario, diagnostic: string): void {
  if (!active.teardownDiagnostics.includes(diagnostic)) active.teardownDiagnostics.push(diagnostic);
}

function compactOutput(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 1_200);
}

// Clear only the directory object opened with O_NOFOLLOW.  Every child effect
// is descriptor-relative, so a rename/symlink replacement after open cannot
// redirect cleanup.  The now-empty root is intentionally retained: Linux has
// no rmdir-by-fd primitive that can remove its mutable parent entry safely.
async function tombstoneTestDirectory(root: string): Promise<void> {
  let fd: number | undefined;
  try {
    fd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const identity = fstatSync(fd, { bigint: true });
    const helper = String.raw`
import os, stat, sys
fd, expected_dev, expected_ino = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def clear(directory_fd):
    current = os.fstat(directory_fd)
    if str(current.st_dev) != expected_dev or str(current.st_ino) != expected_ino:
        raise RuntimeError('owned root identity changed')
    for name in os.listdir(directory_fd):
        item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(item.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try: clear_child(child)
            finally: os.close(child)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)
def clear_child(directory_fd):
    for name in os.listdir(directory_fd):
        item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(item.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try: clear_child(child)
            finally: os.close(child)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)
clear(fd)
`;
    const result = spawnSync(
      'python3',
      ['-c', helper, '3', String(identity.dev), String(identity.ino)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe', fd],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }
    );
    if (result.status !== 0) {
      throw new Error(
        `safe test tombstone failed: ${compactOutput(result.stderr || result.error?.message || 'helper failed')}`
      );
    }
  } catch (error) {
    // Cleanup must never turn a fixture replacement into a destructive error;
    // retain the path as evidence and let the owning test report its failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertDispatchOpen(active: ActiveScenario): void {
  if (active.dispatchClosed || active.dispatchAbortController.signal.aborted) {
    throw new Error(
      `Provider launch stress dispatch is fenced during teardown for ${active.teamName}.`
    );
  }
}

/**
 * A timeout is a cancellation boundary, not merely a rejected observation.
 * Abort the shared dispatch controller before returning so pending provider
 * work sees cancellation and no follow-on paid dispatch can begin.  Callers
 * retain ownership evidence and continue the bounded cleanup sequence.
 */
async function settleBeforeDeadline<T>(
  start: () => Promise<T>,
  deadline: number,
  label: string,
  cancellation: AbortController,
  active?: ActiveScenario
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    if (!cancellation.signal.aborted) cancellation.abort(new Error(`${label} deadline elapsed`));
    throw new Error(`${label} exceeded its absolute deadline.`);
  }
  // Delay invocation until after the absolute-deadline check. This is not a
  // cosmetic Promise.race: an expired cleanup budget must never begin a new
  // stop/dispose/delete effect.
  const work = Promise.resolve().then(start);
  void work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          if (!cancellation.signal.aborted) cancellation.abort(new Error(`${label} timed out`));
          retainTeardownSettlementReceipt(active, label, deadline, work);
          reject(new Error(`${label} exceeded its absolute deadline.`));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retainTeardownSettlementReceipt(
  active: ActiveScenario | undefined,
  label: string,
  deadline: number,
  work: Promise<unknown>
): void {
  if (!active) return;
  const receipts = (active.pendingTeardownReceipts ??= new Map<
    string,
    TeardownSettlementReceipt
  >());
  if (receipts.has(label)) return;
  const receipt: TeardownSettlementReceipt = { label, deadline, state: 'pending' };
  receipts.set(label, receipt);
  noteTeardownDiagnostic(active, `teardown operation remains fenced pending settlement: ${label}`);
  void work
    .then(
      () => {
        receipt.state = 'fulfilled';
      },
      (error) => {
        receipt.state = 'rejected';
        receipt.error = error instanceof Error ? error.message : String(error);
      }
    )
    .finally(() => {
      // The receipt remains observable on the ActiveScenario until after its
      // terminal state is recorded. It is never silently forgotten while work
      // is pending, so callers cannot report a successful teardown early.
    });
}

async function runCleanupEffectExactlyOnce(
  active: ActiveScenario,
  label: string,
  deadline: number,
  work: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const effects = (active.cleanupEffects ??= new Map<string, CleanupEffectReceipt>());
  const previous = effects.get(label);
  if (previous) {
    if (previous.state === 'fulfilled') return;
    if (previous.state === 'rejected')
      throw new Error(previous.error ?? `${label} previously failed`);
    // Do not send a second stop/dispose after a timeout. afterEach resumes by
    // observing the original operation's durable settlement instead.  That
    // observation itself is bounded: a retry must never turn an already
    // timed-out cleanup into an unbounded await.
    return settleBeforeDeadline(
      () => previous.settlement,
      deadline,
      `pending exactly-once cleanup ${label}`,
      active.cleanupAbortController ?? (active.cleanupAbortController = new AbortController()),
      active
    );
  }
  const cancellation = (active.cleanupAbortController ??= new AbortController());
  if (Date.now() >= deadline || cancellation.signal.aborted) {
    if (!cancellation.signal.aborted) cancellation.abort(new Error(`${label} deadline elapsed`));
    throw new Error(`${label} exceeded its absolute deadline.`);
  }
  const receipt: CleanupEffectReceipt = {
    label,
    state: 'pending',
    settlement: Promise.resolve(),
  };
  const started = Promise.resolve().then(async () => {
    if (Date.now() >= deadline || cancellation.signal.aborted) {
      throw new Error(`${label} exceeded its absolute deadline before effect start.`);
    }
    await work(cancellation.signal);
  });
  const settlement = started.then(
    () => {
      receipt.state = 'fulfilled';
    },
    (error) => {
      receipt.state = 'rejected';
      receipt.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  );
  receipt.settlement = settlement;
  effects.set(label, receipt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement,
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => {
            if (!cancellation.signal.aborted)
              cancellation.abort(new Error(`${label} deadline elapsed`));
            retainTeardownSettlementReceipt(active, label, deadline, started);
            reject(new Error(`${label} exceeded its absolute deadline.`));
          },
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dispatchWithTeardownFence<T>(
  active: ActiveScenario,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  assertDispatchOpen(active);
  const operation = (async () => {
    assertDispatchOpen(active);
    const result = await work(active.dispatchAbortController.signal);
    // A task create which overlaps teardown may already have completed, but it
    // must not proceed to a follow-on relay or any other new dispatch effect.
    assertDispatchOpen(active);
    return result;
  })();
  active.inFlightDispatches.add(operation);
  try {
    return await operation;
  } finally {
    active.inFlightDispatches.delete(operation);
  }
}

async function fenceAndDrainDispatches(active: ActiveScenario): Promise<void> {
  active.dispatchClosed = true;
  if (!active.dispatchAbortController.signal.aborted) {
    active.dispatchAbortController.abort(new Error('Provider launch stress teardown started'));
  }
  const settled = await settleBeforeDeadline(
    () => Promise.allSettled([...active.inFlightDispatches]),
    Date.now() + DISPATCH_DRAIN_TIMEOUT_MS,
    `dispatch drain for ${active.teamName}`,
    active.dispatchAbortController,
    active
  );
  const failures = settled
    .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    .map((item) => (item.reason instanceof Error ? item.reason : new Error(String(item.reason))));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Provider launch stress dispatch drain failed for ${active.teamName}.`
    );
  }
}

// A PID is an address which can be reused.  The first start identity observed
// for a PID is therefore immutable teardown authority; later observations are
// useful only for rejecting a replacement, never for refreshing that authority.
function captureProcessIdentity(
  active: ActiveScenario,
  identity: LinuxProcessIdentity,
  source: 'launch' | 'kernel-boundary' | 'proven-descendant' | 'provider-receipt' = 'launch',
  receipt?: LaunchProcessReceipt
): void {
  const captured = active.capturedProcesses.get(identity.pid);
  if (captured) {
    if (captured.startTicks !== identity.startTicks) {
      noteTeardownDiagnostic(
        active,
        `refused replacement PID ${identity.pid}: captured ${captured.startTicks}, observed ${identity.startTicks}`
      );
    }
    return;
  }
  if (active.teardownStarted && source !== 'proven-descendant' && source !== 'kernel-boundary') {
    noteTeardownDiagnostic(
      active,
      `refused late PID authority ${identity.pid}@${identity.startTicks} after teardown began`
    );
    return;
  }
  if (source === 'launch') {
    if (
      !receipt ||
      receipt.teamName !== active.teamName ||
      receipt.pid !== identity.pid ||
      receipt.startTicks !== identity.startTicks ||
      receipt.parentPid !== identity.parentPid ||
      !receipt.parentStartTicks ||
      !receipt.runId ||
      !receipt.memberName ||
      !receipt.providerId ||
      !receipt.runtimeSessionId
    ) {
      noteTeardownDiagnostic(
        active,
        `refused unbound initial PID authority ${identity.pid}@${identity.startTicks}`
      );
      return;
    }
    (active.launchProcessReceipts ??= new Map()).set(identity.pid, receipt);
  } else if (source === 'kernel-boundary') {
    if (!active.cgroupReceipt || !isProcessInLaunchCgroup(identity.pid, active.cgroupReceipt)) {
      noteTeardownDiagnostic(
        active,
        `refused PID outside launch cgroup ${identity.pid}@${identity.startTicks}`
      );
      return;
    }
    // This receipt is rooted in the wrapper's cgroup admission, established
    // before Vitest/provider launch.  It is not a later ancestry guess: Linux
    // retains membership across setsid and reparenting.
    const parent = observeLinuxProcessIdentity(`/proc/${identity.parentPid}`);
    (active.launchProcessReceipts ??= new Map()).set(identity.pid, {
      teamName: active.teamName,
      runId: `cgroup:${active.cgroupReceipt.relativePath}`,
      memberName: 'kernel-cgroup-member',
      providerId: 'kernel-cgroup-boundary',
      runtimeSessionId: active.cgroupReceipt.ino,
      pid: identity.pid,
      startTicks: identity.startTicks,
      parentPid: identity.parentPid,
      parentStartTicks: parent.kind === 'present' ? parent.identity.startTicks : null,
    });
  } else if (source === 'proven-descendant') {
    const parent = active.capturedProcesses.get(identity.parentPid);
    const parentReceipt = active.launchProcessReceipts?.get(identity.parentPid);
    if (!parent || parent.startTicks !== (parentReceipt?.startTicks ?? '') || !parentReceipt) {
      noteTeardownDiagnostic(
        active,
        `refused descendant PID authority without launch-bound parent ${identity.pid}@${identity.startTicks}`
      );
      return;
    }
    // collectProcessTree observed this direct parent/child relation while the
    // parent start identity was stable. Record the inherited provider/session
    // capability alongside the child's own exact start identity before any
    // pidfd operation can use it.
    (active.launchProcessReceipts ??= new Map()).set(identity.pid, {
      ...parentReceipt,
      pid: identity.pid,
      startTicks: identity.startTicks,
      parentPid: identity.parentPid,
      parentStartTicks: parent.startTicks,
    });
  } else if (source === 'provider-receipt' && !active.launchProcessReceipts?.has(identity.pid)) {
    // A stop-time runtime snapshot is useful for rejecting a replacement but
    // is not launch authority. Never grant a PID merely because it currently
    // occupies a number named by an otherwise-valid provider response.
    noteTeardownDiagnostic(
      active,
      `refused provider receipt without launch-bound PID authority ${identity.pid}@${identity.startTicks}`
    );
    return;
  }
  active.capturedProcesses.set(identity.pid, identity);
}

function makeTestLaunchReceipt(
  teamName: string,
  identity: LinuxProcessIdentity
): LaunchProcessReceipt {
  return {
    teamName,
    runId: 'test-run',
    memberName: 'test-member',
    providerId: 'codex',
    runtimeSessionId: 'test-session',
    pid: identity.pid,
    startTicks: identity.startTicks,
    parentPid: identity.parentPid,
    parentStartTicks: 'test-parent-start',
  };
}

function isProcessInLaunchCgroup(pid: number, receipt: CgroupLaunchReceipt): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const memberPath = status
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3)
      .trim();
    if (
      memberPath !== receipt.relativePath &&
      !memberPath?.startsWith(`${receipt.relativePath.replace(/\/$/, '')}/`)
    )
      return false;
    const cgroupPath = path.join(receipt.mountPath, receipt.relativePath.replace(/^\//, ''));
    const stat = statSync(cgroupPath, { bigint: true });
    return String(stat.dev) === receipt.dev && String(stat.ino) === receipt.ino;
  } catch {
    return false;
  }
}

function captureKernelOwnedCgroupMembers(active: ActiveScenario): boolean {
  if (!active.cgroupReceipt) return false;
  const cgroupPath = path.join(
    active.cgroupReceipt.mountPath,
    active.cgroupReceipt.relativePath.replace(/^\//, '')
  );
  const protectedPids = new Set<number>();
  let identity: LinuxProcessIdentity | null = readLinuxProcessIdentity('/proc/self');
  while (identity && identity.pid > 1 && !protectedPids.has(identity.pid)) {
    protectedPids.add(identity.pid);
    identity = readLinuxProcessIdentity(`/proc/${identity.parentPid}`);
  }
  let members: string[];
  try {
    const stat = statSync(cgroupPath, { bigint: true });
    if (
      String(stat.dev) !== active.cgroupReceipt.dev ||
      String(stat.ino) !== active.cgroupReceipt.ino
    ) {
      noteTeardownDiagnostic(active, 'launch cgroup identity changed');
      return false;
    }
    members = listLaunchCgroupSubtreePaths(cgroupPath).flatMap((groupPath) =>
      readFileSync(path.join(groupPath, 'cgroup.procs'), 'utf8').split(/\s+/).filter(Boolean)
    );
  } catch (error) {
    noteTeardownDiagnostic(
      active,
      `cannot read launch cgroup: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
  const before = active.capturedProcesses.size;
  for (const rawPid of members) {
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isSafeInteger(pid) || protectedPids.has(pid)) continue;
    const observed = observeLinuxProcessIdentity(`/proc/${pid}`);
    if (observed.kind === 'present')
      captureProcessIdentity(active, observed.identity, 'kernel-boundary');
    if (observed.kind === 'unresolved') noteTeardownDiagnostic(active, observed.diagnostic);
  }
  return active.capturedProcesses.size !== before;
}

function listLaunchCgroupSubtreePaths(root: string): string[] {
  const result = [root];
  for (let index = 0; index < result.length; index += 1) {
    for (const entry of readdirSync(result[index]!, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(result[index]!, entry.name);
      const stat = statSync(child, { bigint: true });
      if (!stat.isDirectory()) throw new Error(`unsafe nested cgroup entry: ${child}`);
      result.push(child);
    }
  }
  return result;
}

function collectProcessTree(
  active: ActiveScenario,
  roots: Iterable<LinuxProcessIdentity>
): Map<number, LinuxProcessIdentity> {
  const result = new Map<number, LinuxProcessIdentity>();
  for (const root of roots) result.set(root.pid, root);
  if (process.platform !== 'linux') return result;
  const current = new Map<number, LinuxProcessIdentity>();
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync('/proc', { withFileTypes: true });
  } catch (error) {
    noteTeardownDiagnostic(
      active,
      `cannot enumerate /proc: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    );
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const observation = observeLinuxProcessIdentity(`/proc/${entry.name}`);
    if (observation.kind === 'present') current.set(observation.identity.pid, observation.identity);
    if (observation.kind === 'unresolved') noteTeardownDiagnostic(active, observation.diagnostic);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of current.values()) {
      if (result.has(identity.pid)) continue;
      const capturedParent = result.get(identity.parentPid);
      if (!capturedParent) continue;
      // A PID match alone is not ancestry authority.  Check the captured
      // parent start identity immediately before and after observing the
      // candidate child; PID reuse cannot pull a foreign tree into teardown.
      const parentBefore = observeLinuxProcessIdentity(`/proc/${capturedParent.pid}`);
      const childAfter = observeLinuxProcessIdentity(`/proc/${identity.pid}`);
      const parentAfter = observeLinuxProcessIdentity(`/proc/${capturedParent.pid}`);
      if (parentBefore.kind === 'unresolved')
        noteTeardownDiagnostic(active, parentBefore.diagnostic);
      if (childAfter.kind === 'unresolved') noteTeardownDiagnostic(active, childAfter.diagnostic);
      if (parentAfter.kind === 'unresolved') noteTeardownDiagnostic(active, parentAfter.diagnostic);
      if (
        parentBefore.kind !== 'present' ||
        childAfter.kind !== 'present' ||
        parentAfter.kind !== 'present' ||
        parentBefore.identity.startTicks !== capturedParent.startTicks ||
        parentAfter.identity.startTicks !== capturedParent.startTicks ||
        childAfter.identity.startTicks !== identity.startTicks ||
        childAfter.identity.parentPid !== capturedParent.pid
      ) {
        if (
          parentBefore.kind !== 'gone' &&
          childAfter.kind !== 'gone' &&
          parentAfter.kind !== 'gone'
        ) {
          noteTeardownDiagnostic(
            active,
            `refused descendant ${identity.pid}: parent identity changed or is unresolved`
          );
        }
        continue;
      }
      result.set(identity.pid, childAfter.identity);
      changed = true;
    }
  }
  return result;
}

function observeLaunchProcessIdentities(active: ActiveScenario): void {
  if (active.teardownStarted) return;
  // The cgroup receipt was established by the wrapper before createTeam. Read
  // it at the earliest launch progress edge, before accepting any mutable
  // runtime snapshot as corroboration.
  captureKernelOwnedCgroupMembers(active);
  const observation = active.svc
    .getTeamAgentRuntimeSnapshot(active.teamName)
    .then((snapshot) => {
      captureSnapshotProcessIdentities(active, snapshot);
    })
    .catch((error) => {
      // Progress callbacks are synchronous.  Keep their earliest trusted
      // observation non-blocking, but retain a deterministic diagnostic if
      // the runtime made that evidence unavailable.
      noteTeardownDiagnostic(
        active,
        `cannot capture launch process identity: ${error instanceof Error ? error.message : String(error)}`
      );
    })
    .finally(() => {
      active.launchIdentityObservations.delete(observation);
    });
  active.launchIdentityObservations.add(observation);
}

function captureSnapshotProcessIdentities(
  active: ActiveScenario,
  snapshot: TeamAgentRuntimeSnapshot | null,
  _source: 'launch' | 'provider-receipt' = 'launch'
): void {
  if (!snapshot || snapshot.teamName !== active.teamName) {
    if (snapshot)
      noteTeardownDiagnostic(
        active,
        `refused runtime receipt for a different team ${snapshot.teamName}`
      );
    return;
  }
  // A runtime snapshot is corroborating evidence only.  First harvest the
  // wrapper-established cgroup receipt; this is the sole path that can grant
  // a PID authority for a live canary.
  captureKernelOwnedCgroupMembers(active);
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.backendType !== 'process' || member.providerId === 'opencode') continue;
    const pid = member.runtimePid ?? member.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) continue;
    const observation = observeLinuxProcessIdentity(`/proc/${pid}`);
    if (observation.kind !== 'present' || observation.identity.pid !== pid) {
      if (observation.kind === 'unresolved') noteTeardownDiagnostic(active, observation.diagnostic);
      if (observation.kind !== 'gone' && isPidAlive(pid)) {
        noteTeardownDiagnostic(
          active,
          `Cannot prove identity for owned process ${pid}; it was not signalled.`
        );
      }
      continue;
    }
    // Never manufacture launch authority from a later numeric PID snapshot.
    // It can validate/reject an existing cgroup-bound identity only.
    if (!active.launchProcessReceipts?.has(pid)) {
      noteTeardownDiagnostic(active, `refused runtime PID without wrapper launch receipt ${pid}`);
      continue;
    }
    captureProcessIdentity(active, observation.identity, 'provider-receipt');
  }
  if (!active.teardownStarted) {
    for (const identity of collectProcessTree(active, active.capturedProcesses.values()).values()) {
      captureProcessIdentity(active, identity, 'proven-descendant');
    }
  }
}

async function captureOwnedProcessesFromProviderReceipt(active: ActiveScenario): Promise<boolean> {
  const before = active.capturedProcesses.size;
  const snapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
  captureSnapshotProcessIdentities(active, snapshot, 'provider-receipt');
  captureKernelOwnedCgroupMembers(active);
  captureExactOwnedDescendants(active);
  return active.capturedProcesses.size !== before;
}

async function stopTeamWithContinuousOwnedDiscovery(
  active: ActiveScenario,
  signal: AbortSignal,
  absoluteDeadline = Date.now() + STOP_TEAM_TIMEOUT_MS
): Promise<void> {
  const deadline = Math.min(absoluteDeadline, Date.now() + STOP_TEAM_TIMEOUT_MS);
  if (signal.aborted || Date.now() >= deadline) {
    throw new Error(`stopTeam for ${active.teamName} cannot begin after its deadline.`);
  }
  let stopping = true;
  let monitorFailure: Error | null = null;
  const monitor = (async () => {
    while (stopping && Date.now() < deadline) {
      try {
        await captureOwnedProcessesFromProviderReceipt(active);
      } catch (error) {
        monitorFailure = error instanceof Error ? error : new Error(String(error));
        noteTeardownDiagnostic(
          active,
          `cannot poll ownership during stop: ${monitorFailure.message}`
        );
      }
      if (stopping && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, STOP_OWNERSHIP_POLL_MS));
    }
  })();
  try {
    await settleBeforeDeadline(
      async () => {
        if (signal.aborted || Date.now() >= deadline) {
          throw new Error(`stopTeam for ${active.teamName} cannot signal after its deadline.`);
        }
        // The service stop API has no cancellation parameter. The owning gate
        // fences admission immediately before and after the real boundary.
        await invokeAbortableStopTeam(active, { signal, deadline });
        if (signal.aborted || Date.now() >= deadline) {
          throw new Error(`stopTeam for ${active.teamName} exceeded its cancellation boundary.`);
        }
      },
      deadline,
      `stopTeam for ${active.teamName}`,
      active.cleanupAbortController,
      active
    );
  } finally {
    stopping = false;
    await settleBeforeDeadline(
      () => monitor,
      deadline,
      `ownership monitor for ${active.teamName}`,
      active.cleanupAbortController,
      active
    );
  }
  if (monitorFailure) throw monitorFailure;
}

function createCancellationAwareTeardown(input: {
  active: ActiveScenario;
  harness?: ProviderLaunchStressHarness;
  codexCleanup?: (options: TeardownMutationOptions) => Promise<void>;
}): CancellationAwareTeardown {
  const { active, harness, codexCleanup } = input;
  return {
    stopTeam: (authority) =>
      runCancellationAwareMutation(authority, 'stopTeam', async (options) => {
        assertTeardownMutationDeadline(options.signal, options.deadline, 'stopTeam lock');
        await active.svc.stopTeam(active.teamName);
        assertTeardownMutationDeadline(options.signal, options.deadline, 'stopTeam mutation');
      }),
    ...(harness
      ? {
          disposeHarness: (authority: TeardownMutationOptions) =>
            runCancellationAwareMutation(authority, 'OpenCode harness disposal', async (options) => {
              assertTeardownMutationDeadline(
                options.signal,
                options.deadline,
                'OpenCode harness disposal lock'
              );
              await harness.dispose();
              assertTeardownMutationDeadline(
                options.signal,
                options.deadline,
                'OpenCode harness disposal mutation'
              );
            }),
        }
      : {}),
    ...(codexCleanup
      ? {
          cleanupCodex: (authority: TeardownMutationOptions) =>
            runCancellationAwareMutation(authority, 'Codex feature cleanup', () =>
              codexCleanup(authority)
            ),
        }
      : {}),
  };
}

async function runCancellationAwareMutation(
  authority: TeardownMutationOptions,
  label: string,
  mutate: (options: TeardownMutationOptions) => Promise<void>
): Promise<void> {
  assertTeardownMutationDeadline(authority.signal, authority.deadline, label);
  await mutate(authority);
  assertTeardownMutationDeadline(authority.signal, authority.deadline, label);
}

async function invokeAbortableStopTeam(
  active: ActiveScenario,
  options: TeardownMutationOptions
): Promise<void> {
  if (!active.teardown) throw new Error('Cancellation-aware stopTeam boundary is unavailable.');
  await active.teardown.stopTeam(options);
}

async function invokeAbortableHarnessDispose(
  active: ActiveScenario,
  options: TeardownMutationOptions
): Promise<void> {
  if (!active.teardown?.disposeHarness) {
    throw new Error('Cancellation-aware OpenCode harness boundary is unavailable.');
  }
  await active.teardown.disposeHarness(options);
}

async function rescanOwnedProcessesUntilStable(
  active: ActiveScenario,
  cancellation?: AbortSignal,
  absoluteDeadline = Date.now() + OWNERSHIP_DISCOVERY_TIMEOUT_MS
): Promise<void> {
  const deadline = Math.min(absoluteDeadline, Date.now() + OWNERSHIP_DISCOVERY_TIMEOUT_MS);
  let stablePasses = 0;
  for (
    let pass = 0;
    pass < STOP_OWNERSHIP_STABLE_PASSES * 3 && Date.now() < deadline && !cancellation?.aborted;
    pass += 1
  ) {
    const before = [...active.capturedProcesses.values()]
      .filter((identity) => identityStatus(active, identity) === 'same')
      .map((identity) => `${identity.pid}@${identity.startTicks}`)
      .sort()
      .join(',');
    const discovered = await settleBeforeDeadline(
      () => captureOwnedProcessesFromProviderReceipt(active),
      deadline,
      `ownership rescan for ${active.teamName}`,
      active.cleanupAbortController,
      active
    );
    const after = [...active.capturedProcesses.values()]
      .filter((identity) => identityStatus(active, identity) === 'same')
      .map((identity) => `${identity.pid}@${identity.startTicks}`)
      .sort()
      .join(',');
    stablePasses = !discovered && before === after ? stablePasses + 1 : 0;
    if (stablePasses >= STOP_OWNERSHIP_STABLE_PASSES) return;
    await new Promise((resolve) => setTimeout(resolve, STOP_OWNERSHIP_POLL_MS));
  }
  throw new Error(
    `Owned descendant discovery did not stabilize before its absolute deadline for ${active.teamName}.`
  );
}

function identityStatus(
  active: ActiveScenario,
  identity: LinuxProcessIdentity
): 'gone' | 'same' | 'reused-or-uncertain' {
  const observation = observeLinuxProcessIdentity(`/proc/${identity.pid}`);
  if (observation.kind === 'gone') return 'gone';
  if (observation.kind === 'unresolved') {
    noteTeardownDiagnostic(active, observation.diagnostic);
    return 'reused-or-uncertain';
  }
  return observation.identity.startTicks === identity.startTicks ? 'same' : 'reused-or-uncertain';
}

async function assertReleaseClosureBeforeTeardownEffect(
  active: ActiveScenario,
  effect: string
): Promise<void> {
  // Unit guards deliberately run without the release descriptor.  A requested
  // live canary, however, must re-read the full closure directly before every
  // teardown mutation; a scenario's earlier launch check is not authority.
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE !== '1') return;
  const authorization = getLiveStressAuthorization();
  if (!authorization.ok) {
    throw new Error(
      `Release wrapper authorization is unavailable before teardown ${effect} for ${active.teamName}: ${authorization.reason}`
    );
  }
  const artifact = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
  if (!artifact)
    throw new Error(
      `Release closure is unavailable before teardown ${effect} for ${active.teamName}.`
    );
  await assertVerifiedReleaseArtifact(artifact);
}

async function assertTeardownClosureBeforeEffect(
  active: ActiveScenario,
  effect: string,
  requireTeamMarker = active.markerWritten
): Promise<void> {
  await assertReleaseClosureBeforeTeardownEffect(active, effect);
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1') {
    if (!currentStressDisposableProject?.wrapperOwned) {
      throw new Error(`Disposable project authority is unavailable before teardown ${effect}.`);
    }
    await assertOwnedDisposableProject(currentStressDisposableProject);
  }
  // Focused non-live guard fixtures intentionally construct only the process
  // identity portion of ActiveScenario.  Real scenarios always have this
  // reservation from acquireTeamOwnership before any launch can occur.
  if (!active.ownership) return;
  await assertReservationOwnership(active);
  if (requireTeamMarker) await assertOwnedTeam(active);
}

async function signalExactProcess(
  active: ActiveScenario,
  identity: LinuxProcessIdentity,
  signal: NodeJS.Signals,
  deadline = Number.POSITIVE_INFINITY,
  cancellation?: AbortSignal
): Promise<void> {
  if (Date.now() >= deadline || cancellation?.aborted) {
    noteTeardownDiagnostic(
      active,
      `refused ${signal} to ${identity.pid}: absolute cleanup deadline elapsed`
    );
    return;
  }
  const captured = active.capturedProcesses.get(identity.pid);
  const receipt = active.launchProcessReceipts?.get(identity.pid);
  if (
    !captured ||
    captured.startTicks !== identity.startTicks ||
    !receipt ||
    receipt.startTicks !== identity.startTicks ||
    receipt.pid !== identity.pid
  ) {
    noteTeardownDiagnostic(
      active,
      `refused pidfd signal without launch-bound authority ${identity.pid}@${identity.startTicks}`
    );
    return;
  }
  if (identityStatus(active, identity) !== 'same') return;
  // The exact start identity was captured before teardown.  Never turn a
  // later runtime PID receipt into authority, and never use process.kill: a
  // /proc check followed by numeric kill is inherently vulnerable to PID
  // reuse.  The helper opens a pidfd and rechecks this exact start identity on
  // both sides of pidfd_open before signalling the kernel-bound handle.
  await assertTeardownClosureBeforeEffect(active, `signal ${signal} to ${identity.pid}`);
  const deliver = async (): Promise<void> => {
    if (Date.now() >= deadline || cancellation?.aborted) {
      noteTeardownDiagnostic(
        active,
        `refused late ${signal} to ${identity.pid}: absolute cleanup deadline elapsed`
      );
      return;
    }
    const result = spawnSync(
      'python3',
      [
        '-c',
        PIDFD_SIGNAL_HELPER,
        String(identity.pid),
        identity.startTicks,
        String(os.constants.signals[signal]),
      ],
      {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      }
    );
    if (result.status === 0) return;
    // Absence of pidfd support is a fail-closed condition: do not fall back to
    // a numeric signal even for a process we previously owned.
    noteTeardownDiagnostic(
      active,
      `refused pidfd signal ${signal} to ${identity.pid}@${identity.startTicks}: ${compactOutput(result.stderr || result.error?.message || 'pidfd helper failed')}`
    );
  };
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1') {
    const artifact = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
    if (!artifact) throw new Error(`Release closure is unavailable before signal ${signal}.`);
    await assertVerifiedReleaseArtifact(artifact, deliver);
  } else {
    await deliver();
  }
}

const PIDFD_SIGNAL_HELPER = String.raw`
import os, signal, sys
pid, expected_start, raw_signal = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
def start_ticks(target):
    data = open('/proc/%d/stat' % target, 'r', encoding='utf8').read()
    closing = data.rfind(')')
    if closing < 0: raise RuntimeError('malformed proc stat')
    return data[closing + 2:].split(' ')[19]
if start_ticks(pid) != expected_start: raise RuntimeError('pid identity changed before pidfd_open')
fd = os.pidfd_open(pid, 0)
try:
    if start_ticks(pid) != expected_start: raise RuntimeError('pid identity changed during pidfd_open')
    signal.pidfd_send_signal(fd, raw_signal)
finally:
    os.close(fd)
`;

async function assertVerifiedReleaseArtifact(
  filePath: string,
  immediatelyAfterRevalidation?: () => Promise<void>
): Promise<void> {
  const expectedPath = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_PATH?.trim();
  const expectedSha = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_ORCHESTRATOR_SHA256?.trim();
  const rawPayload = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_PAYLOAD;
  const manifestPath = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_PATH;
  const manifestSha = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_SHA256;
  const closureSha = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_CLOSURE_SHA256;
  const closureRoot = process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_ROOT?.trim();
  if (!expectedPath || !expectedSha) {
    throw new Error('Verified release payload evidence is missing.');
  }
  const resolvedPath = path.resolve(filePath);
  const resolvedExpectedPath = path.resolve(expectedPath);
  if (
    resolvedPath !== resolvedExpectedPath ||
    /(?:^|[-_/])cli-(?:source|dev)(?:$|[-_/])|cli-source/.test(resolvedPath)
  ) {
    throw new Error('Release canary rejected a source, dev, or foreign orchestrator artifact.');
  }
  if (!rawPayload || !manifestPath || !manifestSha || !closureSha) {
    throw new Error('Verified release payload evidence is missing.');
  }
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1' && !closureRoot) {
    throw new Error('Verified release payload root evidence is missing.');
  }
  const resolvedClosureRoot = closureRoot ? path.resolve(closureRoot) : null;
  if (resolvedClosureRoot) {
    const root = statSync(resolvedClosureRoot, { bigint: true });
    if (!root.isDirectory() || (Number(root.mode) & 0o222) !== 0) {
      throw new Error('Verified release payload root is not immutable.');
    }
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    throw new Error('Verified release payload evidence is malformed.');
  }
  if (!Array.isArray(payload) || payload.length < 4) {
    throw new Error('Verified release payload closure is incomplete.');
  }
  if (process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1') {
    const authorization = getLiveStressAuthorization();
    if (!authorization.ok || !authorization.issuer) {
      throw new Error(`Verified release capability is unavailable: ${authorization.reason}`);
    }
    assertSealedReleaseAssertion(
      process.env.PROVIDER_LAUNCH_STRESS_SEALED_RELEASE_ASSERTION,
      process.env.PROVIDER_LAUNCH_STRESS_SEALED_RELEASE_ASSERTION_SIGNATURE,
      authorization.issuer,
      authorization.wrapperTrustAnchor,
      resolvedClosureRoot,
      payload,
      expectedSha,
      manifestSha
    );
  }
  const descriptors: ReleaseDescriptor[] = [];
  try {
    const manifest = openVerifiedReleaseDescriptor(manifestPath, { sha256: manifestSha });
    descriptors.push(manifest);
    if (resolvedClosureRoot && !isPathInsideReleaseClosure(manifestPath, resolvedClosureRoot)) {
      throw new Error('Verified release manifest escaped its immutable closure.');
    }
    if (manifest.sha256 !== manifestSha.toLowerCase()) {
      throw new Error('Release payload manifest bytes changed after wrapper verification.');
    }
    const canonicalPayload: ReleasePayloadEntry[] = [];
    const roles = new Set<string>();
    let includesWrapper = false;
    for (const item of payload) {
      if (!isReleasePayloadEntry(item))
        throw new Error('Verified release payload entry is malformed.');
      const descriptor = openVerifiedReleaseDescriptor(item.realPath, item);
      descriptors.push(descriptor);
      if (resolvedClosureRoot && !isPathInsideReleaseClosure(item.realPath, resolvedClosureRoot)) {
        throw new Error(`Verified release payload escaped its immutable closure: ${item.realPath}`);
      }
      if ((Number(fstatSync(descriptor.fd, { bigint: true }).mode) & 0o222) !== 0) {
        throw new Error(`Verified release payload entry is writable: ${item.realPath}`);
      }
      if (descriptor.sha256 !== item.sha256.toLowerCase()) {
        throw new Error(`Release payload changed or was replaced: ${item.realPath}`);
      }
      roles.add(item.role);
      canonicalPayload.push(item);
      if (
        path.resolve(item.realPath) === resolvedPath &&
        descriptor.sha256 === expectedSha.toLowerCase()
      ) {
        includesWrapper = item.role === 'wrapper';
      }
    }
    if (!includesWrapper)
      throw new Error('Verified release payload does not include the executable wrapper.');
    for (const role of ['wrapper', 'entry', 'build-metadata', 'lockfile']) {
      if (!roles.has(role)) throw new Error(`Verified release payload closure omits ${role}.`);
    }
    const canonical = [
      `manifest\u0000${path.resolve(manifestPath)}\u0000${manifestSha.toLowerCase()}`,
      ...canonicalPayload
        .sort((left, right) => left.realPath.localeCompare(right.realPath))
        .map((entry) => `${entry.realPath}\u0000${entry.sha256}\u0000${entry.role}`),
    ].join('\n');
    if (createHash('sha256').update(canonical).digest('hex') !== closureSha.toLowerCase()) {
      throw new Error('Release payload closure changed after wrapper verification.');
    }
    // The descriptors, not a second pathname lookup, are the release closure.
    // Check the same open objects immediately before this guard returns to a
    // teardown effect; a rename or symlink swap cannot redirect a read/hash.
    for (const descriptor of descriptors) revalidateReleaseDescriptor(descriptor);
    if (immediatelyAfterRevalidation) await immediatelyAfterRevalidation();
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor.fd);
  }
}

function assertSealedReleaseAssertion(
  serialized: string | undefined,
  signature: string | undefined,
  issuer: CapabilityIssuer,
  wrapperTrustAnchor: string | undefined,
  closureRoot: string | null,
  payload: unknown[],
  expectedWrapperSha: string,
  expectedManifestSha: string
): void {
  if (!serialized || !signature || !closureRoot || !wrapperTrustAnchor) {
    throw new Error('Sealed release assertion is missing from the wrapper capability.');
  }
  if (!verify(null, Buffer.from(serialized), issuer.publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('Sealed release assertion was not signed by the pinned wrapper issuer.');
  }
  let assertion: unknown;
  try {
    assertion = JSON.parse(serialized);
  } catch {
    throw new Error('Sealed release assertion is malformed.');
  }
  const record = assertion as Partial<SealedReleaseAssertion>;
  const semanticPayload = payload.map((item) => {
    if (!isReleasePayloadEntry(item)) throw new Error('Sealed release payload entry is malformed.');
    const relativePath = path.relative(closureRoot, item.realPath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      throw new Error('Sealed release payload escaped its asserted backing.');
    }
    return `${relativePath}\u0000${item.sha256}\u0000${item.role}`;
  });
  const payloadSha256 = createHash('sha256')
    .update(semanticPayload.sort().join('\n'))
    .digest('hex');
  if (
    record.version !== 1 ||
    record.wrapperTrustAnchor !== wrapperTrustAnchor ||
    record.wrapperSha256 !== expectedWrapperSha.toLowerCase() ||
    record.manifestSha256 !== expectedManifestSha.toLowerCase() ||
    record.payloadSha256 !== payloadSha256
  ) {
    throw new Error('Sealed release assertion does not bind the copied payload metadata and hashes.');
  }
}

function isPathInsideReleaseClosure(candidate: string, root: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function openVerifiedReleaseDescriptor(
  target: string,
  expected: Partial<Pick<ReleasePayloadEntry, 'dev' | 'ino' | 'size' | 'sha256'>> = {}
): ReleaseDescriptor {
  const fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(MAX_RELEASE_DESCRIPTOR_BYTES)
    ) {
      throw new Error(`Release descriptor is not a bounded regular file: ${target}`);
    }
    const descriptor: ReleaseDescriptor = {
      fd,
      path: target,
      dev: String(before.dev),
      ino: String(before.ino),
      size: String(before.size),
      sha256: hashOpenReleaseDescriptor(fd, Number(before.size)),
    };
    if (
      (expected.dev && descriptor.dev !== expected.dev) ||
      (expected.ino && descriptor.ino !== expected.ino) ||
      (expected.size && descriptor.size !== expected.size) ||
      (expected.sha256 && descriptor.sha256 !== expected.sha256.toLowerCase())
    )
      throw new Error(`Release descriptor identity changed while opening: ${target}`);
    revalidateReleaseDescriptor(descriptor);
    return descriptor;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function hashOpenReleaseDescriptor(fd: number, size: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  for (let offset = 0; offset < size; ) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read <= 0) throw new Error('Release descriptor was truncated during bounded read.');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest('hex');
}

// Read from a pinned descriptor at explicit offsets.  No accounting snapshot
// performs a pathname lookup, and an external collector can append without
// changing the descriptor identity observed by the suite.
function readPinnedDescriptorBytes(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RELEASE_DESCRIPTOR_BYTES) {
    throw new Error('Pinned accounting descriptor has an invalid size.');
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  for (let offset = 0; offset < size; ) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read <= 0) throw new Error('Pinned accounting descriptor was truncated during read.');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    offset += read;
  }
  return Buffer.concat(chunks, size);
}

function revalidateReleaseDescriptor(descriptor: ReleaseDescriptor): void {
  const before = fstatSync(descriptor.fd, { bigint: true });
  if (
    String(before.dev) !== descriptor.dev ||
    String(before.ino) !== descriptor.ino ||
    String(before.size) !== descriptor.size ||
    hashOpenReleaseDescriptor(descriptor.fd, Number(before.size)) !== descriptor.sha256
  )
    throw new Error(`Release descriptor changed before teardown effect: ${descriptor.path}`);
  const after = fstatSync(descriptor.fd, { bigint: true });
  if (
    String(after.dev) !== descriptor.dev ||
    String(after.ino) !== descriptor.ino ||
    String(after.size) !== descriptor.size
  ) {
    throw new Error(
      `Release descriptor identity changed before teardown effect: ${descriptor.path}`
    );
  }
}

function isReleasePayloadEntry(value: unknown): value is ReleasePayloadEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ['realPath', 'sha256', 'dev', 'ino', 'size', 'role'].every(
      (key) => typeof record[key] === 'string'
    ) &&
    ['wrapper', 'entry', 'build-metadata', 'lockfile', 'module-or-asset'].includes(
      record.role as string
    )
  );
}

/** Load the actual release launcher instead of maintaining a harmless copy. */
function readSealedPayloadLauncherForTest(): string {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../scripts/prove-provider-launch-stress.mjs'
  );
  const source = readFileSync(scriptPath, 'utf8');
  const match = /const SEALED_PAYLOAD_LAUNCHER = String\.raw`([\s\S]*?)`;/m.exec(source);
  if (!match?.[1]) throw new Error('Provider stress release launcher source is unavailable.');
  return match[1];
}

async function cleanupActiveScenario(
  active: ActiveScenario,
  _options: { preserveFiles: boolean }
): Promise<void> {
  const cleanupDeadline = Date.now() + SCENARIO_CLEANUP_TIMEOUT_MS;
  const failures: Error[] = [];
  const attempt = async (
    label: string,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> => {
    try {
      await runCleanupEffectExactlyOnce(
        active,
        `cleanup ${label} for ${active.teamName}`,
        cleanupDeadline,
        work
      );
    } catch (error) {
      failures.push(
        new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        })
      );
    }
  };
  const mutation = async (
    label: string,
    work: (options: TeardownMutationOptions) => Promise<void>
  ): Promise<void> => {
    await attempt(label, async (signal) => {
      if (signal.aborted || Date.now() >= cleanupDeadline) {
        throw new Error(`${label} cannot begin after cleanup deadline.`);
      }
      await assertTeardownClosureBeforeEffect(active, label);
      if (process.env.PROVIDER_LAUNCH_STRESS_LIVE === '1') {
        const artifact = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim();
        if (!artifact) throw new Error(`Release closure is unavailable before teardown ${label}.`);
        // This second check intentionally keeps the exact opened release
        // descriptors alive through the deletion/stop invocation.
        await assertVerifiedReleaseArtifact(artifact, () =>
          work({ signal, deadline: cleanupDeadline })
        );
      } else {
        await work({ signal, deadline: cleanupDeadline });
      }
      if (signal.aborted || Date.now() >= cleanupDeadline) {
        throw new Error(`${label} crossed its cancellation boundary.`);
      }
    });
  };
  // Close this synchronously, before any awaited teardown work.  A dispatch
  // already in flight is drained (and receives the abort signal) before stop
  // can race it; a later dispatch is rejected at its fence.
  active.teardownStarted = true;
  await attempt('fence and drain dispatches', async () => {
    await fenceAndDrainDispatches(active);
  });
  let owned = true;
  const validateOwnership = async (
    label: string,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> => {
    try {
      await runCleanupEffectExactlyOnce(
        active,
        `cleanup ${label} for ${active.teamName}`,
        cleanupDeadline,
        work
      );
    } catch (error) {
      owned = false;
      failures.push(
        new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        })
      );
    }
  };
  // Only these two gates decide whether team/process mutations are safe.  A
  // dispatch drain failure is operational evidence, not an ownership failure.
  await validateOwnership('validate reservation', async () => {
    await assertActiveReservation(active);
  });
  await validateOwnership('validate team ownership', async () => {
    if (active.markerWritten) await assertOwnedTeam(active);
  });

  // Do not mutate a team which failed the ownership gate.  Harness and Codex
  // cleanup remain independent and are still attempted below; every failure
  // is retained in this fixed-order aggregate.
  let beforeStopSnapshot: TeamAgentRuntimeSnapshot | null = null;
  let afterStopSnapshot: TeamAgentRuntimeSnapshot | null = null;
  if (owned) {
    if (active.phase !== 'reserved') {
      await attempt('capture runtime before teardown', async () => {
        beforeStopSnapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
        captureSnapshotProcessIdentities(active, beforeStopSnapshot, 'provider-receipt');
      });
      await attempt('capture exact-owned descendants before stop', async () => {
        captureExactOwnedDescendants(active);
      });
      await mutation(
        'stop team while continuously discovering owned descendants',
        async ({ signal, deadline }) => {
          await stopTeamWithContinuousOwnedDiscovery(active, signal, deadline);
        }
      );
      await attempt('rescan exact-owned descendants until stable after stop', async (signal) => {
        await rescanOwnedProcessesUntilStable(active, signal, cleanupDeadline);
      });
    }
    if (active.teardown?.disposeHarness) {
      await attempt('wait for OpenCode lanes after stop', async () => {
        await waitForOpenCodeLanesStopped(active.teamName, 90_000);
      });
    }
    await attempt('terminate process backends after stop', async (signal) => {
      await terminateProcessBackends(active, beforeStopSnapshot, signal, cleanupDeadline);
    });
    await attempt('capture runtime after teardown', async () => {
      afterStopSnapshot = await active.svc.getTeamAgentRuntimeSnapshot(active.teamName);
      captureSnapshotProcessIdentities(active, afterStopSnapshot, 'provider-receipt');
    });
    await attempt('terminate remaining process backends', async (signal) => {
      await terminateProcessBackends(active, afterStopSnapshot, signal, cleanupDeadline);
    });
  }
  if (active.teardown?.disposeHarness) {
    await mutation('dispose OpenCode harness', async (options) => {
      await invokeAbortableHarnessDispose(active, options);
    });
    await attempt('wait for OpenCode lanes after disposal', async () => {
      await waitForOpenCodeLanesStopped(active.teamName, 90_000);
    });
  }
  if (active.teardown?.cleanupCodex) {
    await mutation('clean up Codex feature', async (options) => {
      await active.teardown!.cleanupCodex!(options);
    });
  }
  if (owned && active.proofAudit) {
    // The final billing/accounting observation belongs after every teardown
    // drain, including harness disposal. Taking it earlier can bless a clean
    // stop while a late lane emits one more debit/effect receipt.
    await attempt('drain all teardown descendants before final proof snapshot', async (signal) => {
      await rescanOwnedProcessesUntilStable(active, signal, cleanupDeadline);
    });
    await attempt('validate final exactly-once proof snapshot after drain', async () => {
      await new Promise((resolve) => setTimeout(resolve, POST_STOP_QUIET_PERIOD_MS));
      const finalSnapshot = await snapshotProofEffects(active);
      assertExactProofSnapshot(active.proofAudit!, active.proofAudit!.beforeStop, active.teamName);
      assertExactProofSnapshot(
        active.proofAudit!,
        finalSnapshot,
        active.teamName,
        active.proofAudit!.acceptedSettlementIdentityMultiset
      );
      assertFinalSealedAccountingProofReconciliation(
        active.proofAudit!.beforeStop,
        finalSnapshot,
        active.teamName,
        active.proofAudit!.accounting.issuerId
      );
      assertQuietProofSnapshot(active.proofAudit!.beforeStop, finalSnapshot, active.teamName);
    });
  }
  if (active.teardownDiagnostics.length > 0) {
    failures.push(
      new Error(
        `Provider launch stress teardown retained evidence: ${active.teardownDiagnostics.join('; ')}`
      )
    );
  }
  if (owned) {
    await mutation('publish stopped reservation evidence', async (options) => {
      assertTeardownMutationDeadline(
        options.signal,
        options.deadline,
        'publish stopped reservation'
      );
      active.phase = 'stopped';
      assertTeardownMutationDeadline(
        options.signal,
        options.deadline,
        'publish stopped reservation'
      );
      await updateTeamReservation(active);
    });
  }
  // A successful canary may retain its descriptor-bound tombstone because
  // Linux cannot prove final root deletion without resolving a mutable name.
  // Retention is not itself a cleanup failure; only a failed stop/dispose or
  // unresolved ownership/receipt is allowed to fail the provider sequence.
  if (
    [...(active.pendingTeardownReceipts?.values() ?? [])].some(
      (receipt) => receipt.state === 'pending'
    )
  ) {
    failures.push(
      new Error(
        `Provider launch stress teardown has fenced operations pending settlement for ${active.teamName}.`
      )
    );
  }
  if (failures.length > 0) {
    active.failed = true;
    throw new AggregateError(
      failures,
      'Provider launch stress teardown failed; evidence retained.'
    );
  }
}

function assertQuietProofSnapshot(before: string, after: string, teamName = 'test-team'): void {
  if (after !== before)
    throw new Error(`Late or duplicate provider effect detected after stop for ${teamName}.`);
}

async function terminateProcessBackends(
  active: ActiveScenario,
  snapshot: TeamAgentRuntimeSnapshot | null,
  cancellation?: AbortSignal,
  absoluteDeadline = Date.now() + PROCESS_ESCALATION_TIMEOUT_MS
): Promise<void> {
  const deadline = Math.min(absoluteDeadline, Date.now() + PROCESS_ESCALATION_TIMEOUT_MS);
  captureSnapshotProcessIdentities(active, snapshot, 'provider-receipt');
  const ordered = () =>
    [...active.capturedProcesses.values()].sort((left, right) => right.pid - left.pid);
  const rescanExactOwnedDescendants = (): boolean => {
    return captureExactOwnedDescendants(active);
  };
  // Re-scan to a bounded quiescent point at each escalation level.  Every
  // retained identity is immutable and is rechecked before signalling, so a
  // reparented child is terminated but a reused PID is never touched.
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (let pass = 0; pass < 3 && Date.now() < deadline; pass += 1) {
      const discovered = rescanExactOwnedDescendants();
      for (const identity of ordered()) {
        if (Date.now() >= deadline || cancellation?.aborted) break;
        await signalExactProcess(active, identity, signal, deadline, cancellation);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const survivors = ordered().some((identity) => identityStatus(active, identity) === 'same');
      if (!discovered && !survivors) break;
    }
  }
  if (Date.now() >= deadline) {
    noteTeardownDiagnostic(
      active,
      `process escalation exceeded absolute deadline for ${active.teamName}`
    );
  }
  const survivors = ordered().filter((identity) => identityStatus(active, identity) !== 'gone');
  if (survivors.length > 0) {
    noteTeardownDiagnostic(
      active,
      `Owned process descendants survived or became identity-uncertain: ${survivors.map((item) => `${item.pid}@${item.startTicks}`).join(', ')}.`
    );
  }
}

function captureExactOwnedDescendants(active: ActiveScenario): boolean {
  const before = active.capturedProcesses.size;
  // cgroup membership, unlike an ancestry poll, survives both setsid and
  // reparenting. It is the authoritative descendant boundary for live runs.
  captureKernelOwnedCgroupMembers(active);
  // This traversal starts only from immutable launch identities.  It may add
  // a child after teardown begins, but only when /proc proves it was a direct
  // descendant of an already-exact identity at collection time.
  for (const identity of collectProcessTree(active, active.capturedProcesses.values()).values()) {
    captureProcessIdentity(active, identity, 'proven-descendant');
  }
  return active.capturedProcesses.size !== before;
}

async function installCodexAccountFeature(): Promise<
  (options: TeardownMutationOptions) => Promise<void>
> {
  const [{ createCodexAccountFeature }, { ProviderConnectionService }] = await Promise.all([
    import('../../../../src/features/codex-account/main/composition/createCodexAccountFeature'),
    import('../../../../src/main/services/runtime/ProviderConnectionService'),
  ]);
  const feature = createCodexAccountFeature({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    configManager: {
      getConfig: () => ({
        providerConnections: {
          codex: {
            preferredAuthMode: 'chatgpt' as const,
          },
        },
      }),
    },
  });
  const providerConnectionService = ProviderConnectionService.getInstance();
  providerConnectionService.setCodexAccountFeature(feature);
  return async ({ signal, deadline }) => {
    assertTeardownMutationDeadline(signal, deadline, 'Codex feature cleanup');
    providerConnectionService.setCodexAccountFeature(null);
    assertTeardownMutationDeadline(signal, deadline, 'Codex feature disposal');
    // The feature's public facade intentionally has no cancellation argument.
    // Do not invent one with a cast: the owning teardown boundary checkpoints
    // before and after this real dispose call instead.
    await feature.dispose();
    assertTeardownMutationDeadline(signal, deadline, 'Codex feature disposal');
  };
}

function assertTeardownMutationDeadline(
  signal: AbortSignal,
  deadline: number,
  label: string
): void {
  if (signal.aborted || Date.now() >= deadline) {
    throw new Error(`${label} cannot cross its cancellation boundary.`);
  }
}

async function formatStressDiagnostics(
  svc: ProviderLaunchStressDiagnosticsService,
  teamName: string,
  progressEvents: TeamProvisioningProgress[]
): Promise<string> {
  const [spawnStatuses, runtimeSnapshot, artifact] = await Promise.all([
    svc.getMemberSpawnStatuses(teamName).catch((error) => ({ error: String(error) })),
    svc.getTeamAgentRuntimeSnapshot(teamName).catch((error) => ({ error: String(error) })),
    readLatestArtifactManifest(teamName),
  ]);
  return redactSecrets(
    JSON.stringify(
      {
        progress: progressEvents.map((progress) => ({
          state: progress.state,
          message: progress.message,
          messageSeverity: progress.messageSeverity,
          error: progress.error,
          launchDiagnostics: progress.launchDiagnostics,
        })),
        spawnStatuses,
        runtimeSnapshot,
        artifact,
        releasePayload: {
          manifestPath: process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_PATH,
          manifestSha256: process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_MANIFEST_SHA256,
          files: process.env.PROVIDER_LAUNCH_STRESS_VERIFIED_RELEASE_PAYLOAD,
        },
      },
      null,
      2
    )
  );
}

async function readLatestArtifactManifest(teamName: string): Promise<unknown> {
  try {
    const latest = JSON.parse(
      await fs.readFile(
        path.join(getTeamsBasePath(), teamName, 'launch-failure-artifacts', 'latest.json'),
        'utf8'
      )
    ) as { manifestPath?: unknown };
    if (typeof latest.manifestPath !== 'string') return latest;
    return JSON.parse(await fs.readFile(latest.manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function usingAnthropicSubscriptionAuth(): boolean {
  const mode = process.env.PROVIDER_LAUNCH_STRESS_ANTHROPIC_AUTH?.trim().toLowerCase();
  return mode === 'subscription' || mode === 'oauth';
}

async function assertCodexSubscriptionAuthAvailable(codexHome: string): Promise<void> {
  const legacyAuthPath = path.join(codexHome, 'auth.json');
  if (await pathReadable(legacyAuthPath)) {
    const legacyAuth = await readJsonObject(legacyAuthPath);
    if (isCodexChatGptSubscriptionAuth(legacyAuth)) return;
  }

  const accountsDir = path.join(codexHome, 'accounts');
  const registry = await readJsonObject(path.join(accountsDir, 'registry.json')).catch(() => null);
  const activeAccountId =
    readStringProperty(registry, 'active_account_id') ??
    readStringProperty(registry, 'activeAccountId') ??
    readStringProperty(registry, 'current_account_id') ??
    readStringProperty(registry, 'currentAccountId');

  const candidates = new Set<string>();
  if (activeAccountId) {
    candidates.add(path.join(accountsDir, `${activeAccountId}.auth.json`));
    candidates.add(path.join(accountsDir, activeAccountId));
  }
  const entries = await fs.readdir(accountsDir).catch(() => []);
  for (const entry of entries) {
    if (entry.endsWith('.auth.json')) candidates.add(path.join(accountsDir, entry));
  }
  for (const candidate of candidates) {
    const auth = await readJsonObject(candidate).catch(() => null);
    if (isCodexChatGptSubscriptionAuth(auth)) return;
  }
  throw new Error(`Codex subscription auth not found in ${codexHome}`);
}

async function pathReadable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function readStringProperty(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isCodexChatGptSubscriptionAuth(source: Record<string, unknown> | null): boolean {
  if (!source) return false;
  const direct = readStringProperty(source, 'refresh_token');
  const tokens = source.tokens;
  const nested =
    tokens && typeof tokens === 'object' && !Array.isArray(tokens)
      ? readStringProperty(tokens as Record<string, unknown>, 'refresh_token')
      : null;
  return Boolean(direct || nested);
}

async function writeTrustedClaudeConfig(configDir: string, projectPath: string): Promise<void> {
  const normalizedProjectPath = path.normalize(await fs.realpath(projectPath)).replace(/\\/g, '/');
  const approvedApiKeySuffix = process.env.ANTHROPIC_API_KEY?.trim().slice(-20);
  const config: {
    projects: Record<string, { hasTrustDialogAccepted: true }>;
    customApiKeyResponses?: { approved: string[]; rejected: string[] };
  } = {
    projects: {
      [normalizedProjectPath]: {
        hasTrustDialogAccepted: true,
      },
    },
  };
  if (approvedApiKeySuffix) {
    config.customApiKeyResponses = { approved: [approvedApiKeySuffix], rejected: [] };
  }
  await fs.writeFile(
    path.join(configDir, '.claude.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
}

async function upsertTrustedClaudeProjectConfig(
  configDir: string,
  projectPath: string
): Promise<void> {
  const configPath = path.join(configDir, '.claude.json');
  const previous = await fs.readFile(configPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const existing = previous ? (JSON.parse(previous) as Record<string, unknown>) : {};
  const normalizedProjectPath = path.normalize(await fs.realpath(projectPath)).replace(/\\/g, '/');
  const projects =
    existing.projects && typeof existing.projects === 'object' && !Array.isArray(existing.projects)
      ? { ...(existing.projects as Record<string, unknown>) }
      : {};
  const current =
    projects[normalizedProjectPath] &&
    typeof projects[normalizedProjectPath] === 'object' &&
    !Array.isArray(projects[normalizedProjectPath])
      ? (projects[normalizedProjectPath] as Record<string, unknown>)
      : {};
  projects[normalizedProjectPath] = { ...current, hasTrustDialogAccepted: true };
  await fs.writeFile(configPath, `${JSON.stringify({ ...existing, projects }, null, 2)}\n`, 'utf8');
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-api03-[A-Za-z0-9_-]+/g, '<redacted-anthropic-key>')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/g, '<redacted-api-key>');
}
