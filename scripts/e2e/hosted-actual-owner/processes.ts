import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, fstatSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { assertFileCurrent, assertRootCurrent, procFdPath } from './anchors';
import {
  RAW_ORIGINS,
  OWNER_CHILD_FDS,
  OWNER_SEALED_PROTOCOL_ARGUMENT,
  OWNER_WRAPPER_ARGUMENT,
  OWNER_CHILD_PROTOCOL,
  PRODUCER_PROVENANCE_CONTRACT,
  PRODUCER_PROVENANCE_CONTRACT_SHA256,
  RUNTIME_CAPTURE_NAMES,
  RUNTIME_CAPTURE_PRODUCER_MAPPINGS,
  RUNTIME_CAPTURE_STREAMS,
  canonicalJson,
  exactRecord,
  sha256,
  validateDecimal,
  validateRecordId,
  type ClosurePin,
  type RawOrigin,
  type RuntimeCaptureName,
  type VerifiedProducerCandidateBinding,
} from './contracts';
import { assertOneRunAuthorizationConsumed, type PreflightAdmission } from './preflight';
import { assertSandboxCurrent, type DisposableSandbox } from './sandbox';
import type { WrittenFileEvidence } from './secure-files';

export const SUPERVISOR_PROTOCOL = 'agent-teams.p3c.supervisor-transcript/v1' as const;
export const OWNER_RESTART_BOUNDARIES = Object.freeze([
  'initial',
  'after-pending-before-decision',
  'after-decision-before-provider',
  'after-effect-before-owner-recording',
] as const);
export const CHROMIUM_DESCENDANT_ROLES = Object.freeze([
  'chromium-browser',
  'chromium-network',
  'chromium-gpu',
  'chromium-renderer',
] as const);

const ROOT_PROCESS_SCHEDULE = Object.freeze([
  {
    role: 'opencode',
    instanceId: 'opencode-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'owner',
    instanceId: 'owner-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'product',
    instanceId: 'product-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'browser',
    instanceId: 'browser-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'owner',
    instanceId: 'owner-2',
    generation: 2,
    restartBoundary: OWNER_RESTART_BOUNDARIES[1],
  },
  {
    role: 'owner',
    instanceId: 'owner-3',
    generation: 3,
    restartBoundary: OWNER_RESTART_BOUNDARIES[2],
  },
  {
    role: 'owner',
    instanceId: 'owner-4',
    generation: 4,
    restartBoundary: OWNER_RESTART_BOUNDARIES[3],
  },
] as const);

type RootProcessRole = (typeof ROOT_PROCESS_SCHEDULE)[number]['role'];
type ChromiumRole = (typeof CHROMIUM_DESCENDANT_ROLES)[number];
export type ProcessEvidenceRole = RootProcessRole | ChromiumRole | 'supervisor';
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const CLEANUP_OPERATION_TIMEOUT_MS = 2_000;
const MAX_PROC_ENVIRON_BYTES = 256 * 1024;

export interface SupervisorPlan {
  readonly schemaVersion: 2;
  readonly protocol: typeof SUPERVISOR_PROTOCOL;
  readonly controllerNonce: string;
  readonly runId: string;
  readonly maximumRuntimeMs: 900000;
  readonly shutdownGraceMs: 5000;
  readonly runtimeManifest: Readonly<{
    schemaVersion: 1;
    purpose: 'agent-teams.hosted-actual-owner-e2e/v1';
    runId: string;
    sandboxRoot: '/sandbox';
    markerPath: '/sandbox/.p3c-sandbox.json';
    evidenceRoot: '/sandbox/evidence';
    driverBaseUrl: 'http://127.0.0.1:45130/';
    productBaseUrl: 'http://127.0.0.1:45131/';
    approvalPath: '/api/hosted/v1/team-approvals/decisions';
    browser: Readonly<{ workers: 1; retries: 0 }>;
    capture: Readonly<Record<RuntimeCaptureName, string>>;
    captureEmissionContract: Readonly<{
      contract: typeof PRODUCER_PROVENANCE_CONTRACT.contract;
      version: typeof PRODUCER_PROVENANCE_CONTRACT.version;
      contractSha256: string;
      environment: typeof PRODUCER_PROVENANCE_CONTRACT.environment;
      framing: typeof PRODUCER_PROVENANCE_CONTRACT.framing;
      descriptorSlots: typeof PRODUCER_PROVENANCE_CONTRACT.descriptorSlots;
      verifierMayProduceBytes: false;
      producerNativeIdentitiesComposed: true;
      captureAuthority: 'verified-signed-four-producer-candidate';
      producerCandidate: VerifiedProducerCandidateBinding;
      captureMappings: typeof RUNTIME_CAPTURE_PRODUCER_MAPPINGS;
    }>;
    refs: Readonly<{
      openCode: string;
      openCodeExecutableSha256: string;
      orchestrator: string;
      product: string;
    }>;
  }>;
  readonly ownerChildProtocol: Readonly<{
    wrapperArgv: readonly [typeof OWNER_WRAPPER_ARGUMENT, '/sandbox/runtime-manifest.json'];
    sealedArgv: readonly [
      typeof OWNER_SEALED_PROTOCOL_ARGUMENT,
      typeof OWNER_WRAPPER_ARGUMENT,
      '/sandbox/runtime-manifest.json',
    ];
    childLocalDescriptors: typeof OWNER_CHILD_FDS;
    descriptorContract: typeof OWNER_CHILD_PROTOCOL;
    parentSourceDescriptors: 'arbitrary-distinct-owned';
    closeParentCopiesAfterSpawn: true;
    compatibilityProbing: false;
    socketPathReconnect: false;
  }>;
  readonly network: {
    readonly namespace: 'new';
    readonly mountNamespace: 'new';
    readonly loopbackOnly: true;
    readonly outbound: 'deny';
    readonly expectedListeners: readonly [
      {
        readonly address: '127.0.0.1';
        readonly port: 4096;
        readonly role: 'opencode';
      },
      {
        readonly address: '127.0.0.1';
        readonly port: 45131;
        readonly role: 'product';
      },
    ];
  };
  readonly filesystem: {
    readonly mountNamespace: 'new';
    readonly pidNamespace: 'new';
    readonly pivotRoot: true;
    readonly rootFilesystem: 'private-tmpfs';
    readonly ambientHostFilesystem: 'deny';
    readonly expectedTopLevelEntries: readonly [
      'browser',
      'composition',
      'dev',
      'opencode',
      'owner',
      'p3b2',
      'proc',
      'product',
      'sandbox',
      'toolchain',
    ];
    readonly expectedMounts: readonly {
      readonly target: string;
      readonly access: 'read-only' | 'read-write' | 'private';
      readonly sourceDescriptor: number | null;
    }[];
    readonly ambientPathProbes: readonly ['/host', '/home', '/root', '/tmp', '/var/data'];
  };
  readonly processOwnership: {
    readonly environmentKey: typeof PROCESS_OWNERSHIP_ENV;
    readonly marker: string;
    readonly census: '/proc';
    readonly identity: 'pid-start-time';
    readonly signals: readonly ['SIGTERM', 'SIGKILL'];
    readonly escapedDescendants: 'independent-proc-census';
  };
  readonly cleanupAudit: {
    readonly injectionPoints: readonly ['owner', 'opencode'];
    readonly escapedCensusKinds: readonly ['setsid', 'double-fork'];
    readonly escalationSignals: readonly ['SIGTERM', 'SIGKILL'];
    readonly outsideSandboxSentinelPath: '/outside-sandbox-sentinel';
  };
  readonly sandbox: {
    readonly descriptor: 10;
    readonly device: string;
    readonly inode: string;
    readonly mountId: string;
    readonly mountPath: '/sandbox';
  };
  readonly inputs: {
    readonly productRuntimeDescriptor: 4;
    readonly browserBundleDescriptor: 5;
    readonly ownerEntryDescriptor: 6;
    readonly openCodeDescriptor: 7;
    readonly browserDescriptor: 8;
    readonly toolchainDescriptor: 11;
    readonly p3b2Descriptor: 12;
    readonly productCompositionDescriptor: 13;
    readonly nodeRelativePath: string;
    readonly loaderRelativePath: string;
  };
  readonly closures: {
    readonly productRuntime: ClosurePin;
    readonly browserBundle: ClosurePin;
    readonly toolchain: ClosurePin;
    readonly p3b2: ClosurePin;
  };
  readonly expectedCwd: Readonly<
    Record<'supervisor' | RootProcessRole, { readonly device: string; readonly inode: string }>
  >;
  readonly expectedExecutableSha256: Readonly<Record<ProcessEvidenceRole, string>>;
  readonly expectedExecutableDevice: Readonly<Record<ProcessEvidenceRole, string>>;
  readonly expectedExecutableInode: Readonly<Record<ProcessEvidenceRole, string>>;
  readonly expectedProducerArtifactSha256: Readonly<Record<RootProcessRole, string>>;
  readonly expectedProducerModuleSha256: Readonly<Record<RootProcessRole, string>>;
  readonly expectedArgv: Readonly<Record<'supervisor' | RootProcessRole, readonly string[]>>;
  readonly startSchedule: typeof ROOT_PROCESS_SCHEDULE;
  readonly chromiumDescendants: typeof CHROMIUM_DESCENDANT_ROLES;
  readonly playwrightWorkers: 1;
  readonly playwrightRetries: 0;
}

export interface ProcessStartEvidence {
  readonly role: ProcessEvidenceRole;
  readonly instanceId: string;
  readonly generation: number;
  readonly restartBoundary: string;
  readonly pid: number;
  readonly pidfdInode: string;
  readonly startTime: string;
  readonly observedMonotonicNs: string;
  readonly startToken: string;
  readonly parentStartToken: string | null;
  readonly observerStartToken: string | null;
  readonly executableDevice: string;
  readonly executableInode: string;
  readonly executableSha256: string;
  readonly argvSha256: string;
  readonly cwdDevice: string;
  readonly cwdInode: string;
}

export interface ProcessExitEvidence {
  readonly startToken: string;
  readonly pidfdInode: string;
  readonly observedMonotonicNs: string;
  readonly observerStartToken: string;
  readonly disposition: 'controlled-exit' | 'replacement-boundary-exit';
}

interface OwnerSocketEvidence {
  readonly device: string;
  readonly inode: string;
  readonly generation: number;
  readonly ownerStartToken: string;
}

export interface DetachedProcessAnchor {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: string;
  readonly processState: string;
  readonly verification: 'verified-owned' | 'unverified-provisional';
}

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: string;
  readonly processState: string;
}

type PinnedSignalResult = 'signalled-or-exited' | 'identity-mismatch' | 'marker-mismatch';

/** @internal Dependency seams used only by deterministic cleanup regression fixtures. */
export interface ProcessCleanupDependencies {
  readonly readSpawnedProcessStat?: (pid: number) => string;
  readonly readProcessEnvironment?: (pid: number) => Promise<Buffer>;
  readonly readProcessIdentity?: (pid: number) => Promise<OwnedProcessIdentity>;
  readonly signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly signalDirectChild?: (child: ChildProcess, signal: NodeJS.Signals) => boolean;
  readonly processGroupHasMembers?: (processGroupId: number) => boolean;
  readonly childHasExited?: (child: ChildProcess) => boolean;
  readonly processEnvironmentTimeoutMs?: number;
  readonly cleanupOperationTimeoutMs?: number;
}

const PROCESS_OWNERSHIP_ENV = 'P3C_PROCESS_OWNERSHIP_MARKER';
const childForAnchor = new WeakMap<DetachedProcessAnchor, ChildProcess>();
const ownershipValidatedAnchors = new WeakSet<DetachedProcessAnchor>();
const provisionalAnchors = new WeakSet<DetachedProcessAnchor>();
const runOwnedRegistry = new Map<string, Set<DetachedProcessAnchor>>();

export function processOwnershipMarker(controllerNonce: string, runId: string): string {
  return sha256(`agent-teams.p3c.process-owner/v1\0${controllerNonce}\0${runId}`);
}

export interface NetworkEvidence {
  readonly namespaceInode: string;
  readonly parentNamespaceInode: string;
  readonly interfaces: readonly unknown[];
  readonly routes: readonly unknown[];
  readonly listeners: readonly unknown[];
  readonly outboundProbes: readonly unknown[];
  readonly recordSha256: string;
}

export interface FilesystemEvidence {
  readonly mountNamespaceInode: string;
  readonly parentMountNamespaceInode: string;
  readonly pidNamespaceInode: string;
  readonly parentPidNamespaceInode: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly recordSha256: string;
}

export interface RawFileEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly captureDevice: string;
  readonly captureInode: string;
  readonly producerStartTokens: readonly string[];
  readonly producerPidfdInodes: readonly string[];
  readonly parentCreatedExclusive: true;
  readonly writerDescriptorsClosed: true;
  readonly sealedBeforeParse: true;
}

export interface ProducerCaptureShardEvidence {
  readonly authority: 'kernel-observed';
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly contractSha256: string;
  readonly stream: (typeof RUNTIME_CAPTURE_STREAMS)[RuntimeCaptureName];
  readonly captureDevice: string;
  readonly captureInode: string;
  readonly producerPid: number;
  readonly producerStartToken: string;
  readonly producerPidfdInode: string;
  readonly producerRole: RootProcessRole;
  readonly producerFd: 9 | 10;
  readonly producerArtifactSha256: string;
  readonly producerModuleSha256: string;
  readonly allocation: Readonly<{
    observationMethod: 'openat-exclusive-no-follow';
    flags: 'O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY|O_APPEND|O_CLOEXEC';
    mode: 384;
    nlink: 1;
    initialSize: 0;
    captureDevice: string;
    captureInode: string;
  }>;
  readonly parentClose: Readonly<{
    supervisorPid: number;
    supervisorStartToken: string;
    writerFd: number;
    descriptorPath: string;
    captureDevice: string;
    captureInode: string;
    observedOpenMonotonicNs: string;
    spawnBoundaryMonotonicNs: string;
    observedClosedMonotonicNs: string;
    closeObservationMethod: 'fstat-ebadf';
    closedErrno: 'EBADF';
  }>;
  readonly producerOpen: Readonly<{
    descriptorPath: string;
    captureDevice: string;
    captureInode: string;
    observationMethod: 'proc-fd-identity';
    observedMonotonicNs: string;
  }>;
  readonly producerClose: Readonly<{
    observationMethod: 'proc-fd-absent' | 'pidfd-exact-exit';
    observedMonotonicNs: string;
    descriptorPath: string;
    producerStartToken: string;
    producerPidfdInode: string;
  }>;
  readonly descendantCensus: Readonly<{
    observationMethod: 'proc-fd-inode-census';
    observedMonotonicNs: string;
    processEvidenceSetId: string;
    inspectedStartTokens: readonly string[];
    retainedWriterCount: 0;
  }>;
  readonly seal: Readonly<{
    observationMethod: 'read-only-stable-hash';
    observedMonotonicNs: string;
    captureDevice: string;
    captureInode: string;
    mode: 256;
    nlink: 1;
    size: number;
    sha256: string;
    manifestSha256: string;
  }>;
}

export interface ProducerCaptureFileEvidence {
  readonly stream: (typeof RUNTIME_CAPTURE_STREAMS)[RuntimeCaptureName];
  readonly contractSha256: string;
  readonly shards: readonly ProducerCaptureShardEvidence[];
}

export function producerCaptureSealManifestSha256(input: {
  readonly path: string;
  readonly stream: (typeof RUNTIME_CAPTURE_STREAMS)[RuntimeCaptureName];
  readonly contractSha256: string;
  readonly captureDevice: string;
  readonly captureInode: string;
  readonly size: number;
  readonly sha256: string;
  readonly producerPid: number;
  readonly producerStartToken: string;
  readonly producerPidfdInode: string;
  readonly producerRole: RootProcessRole;
  readonly producerFd: 9 | 10;
  readonly producerArtifactSha256: string;
  readonly producerModuleSha256: string;
}): string {
  return sha256(
    `agent-teams.p3c.producer-capture-seal/v1\0${canonicalJson(input)}`
  );
}

export interface SupervisorOutcome {
  readonly controllerNonce: string;
  readonly runId: string;
  readonly zeroOwnedSurvivors: boolean;
  readonly supervisorStart: ProcessStartEvidence;
  readonly starts: readonly ProcessStartEvidence[];
  readonly descendants: readonly ProcessStartEvidence[];
  readonly exits: readonly ProcessExitEvidence[];
  readonly network: NetworkEvidence;
  readonly filesystem: FilesystemEvidence;
  readonly processEvidenceSetId: string;
  readonly ownerChildDescriptorCleanup: Readonly<{
    contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2';
    ownerStartTokens: readonly string[];
    records: readonly ParentDescriptorLifecycleRecord[];
  }>;
  readonly rawFiles: Readonly<Record<RawOrigin, RawFileEvidence>>;
  readonly captureFiles: Readonly<Record<RuntimeCaptureName, ProducerCaptureFileEvidence>>;
  readonly transcriptSha256: string;
  readonly transcript: Buffer;
}

export const PARENT_DESCRIPTOR_ROLES = Object.freeze([
  'sealed-launcher-lease',
  'bootstrap',
  'activation-v2',
] as const);

export interface ParentDescriptorBeforeSpawnObservation {
  readonly method: 'proc-fd-identity';
  readonly observedMonotonicNs: string;
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
}

export interface ParentDescriptorAfterSpawnObservation {
  readonly method: 'fstat-ebadf';
  readonly observedMonotonicNs: string;
  readonly errno: 'EBADF';
}

export interface ParentDescriptorLifecycleRecord {
  readonly wrapperPid: number;
  readonly wrapperStartToken: string;
  readonly spawnNonce: string;
  readonly spawnBoundaryMonotonicNs: string;
  readonly childPublication: ChildDescriptorPublication;
  readonly descriptors: readonly Readonly<{
    role: (typeof PARENT_DESCRIPTOR_ROLES)[number];
    parentFd: number;
    beforeSpawn: ParentDescriptorBeforeSpawnObservation;
    afterSpawn: ParentDescriptorAfterSpawnObservation;
  }>[];
}

export interface ChildDescriptorPublication {
  readonly schemaVersion: 1;
  readonly contract: 'agent-teams.hosted-owner-child-fd-map/v1';
  readonly wrapperPid: number;
  readonly wrapperStartToken: string;
  readonly spawnNonce: string;
  readonly descriptors: readonly Readonly<{
    readonly role: (typeof PARENT_DESCRIPTOR_ROLES)[number];
    readonly childFd: 3 | 4 | 5;
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
  }>[];
}

type ParentDescriptorCleanupObservation = Omit<ParentDescriptorLifecycleRecord, 'childPublication'>;

/** @internal Kernel observation seams used only by deterministic fail-closed regressions. */
export interface ParentDescriptorObservationDependencies {
  readonly fstatDescriptor?: typeof fstatSync;
  readonly statProcDescriptor?: typeof statSync;
}

export interface WrapperProcessStartIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly startToken: string;
}

/** Derives the wrapper identity from the kernel's current `/proc` process-start record. */
export function readCurrentWrapperProcessStartIdentity(): WrapperProcessStartIdentity {
  const pid = process.pid;
  const anchor = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
  return Object.freeze({
    pid,
    startTime: anchor.startTime,
    startToken: sha256(
      canonicalJson({
        contract: 'agent-teams.hosted-owner-wrapper-process-start/v1',
        pid,
        startTime: anchor.startTime,
      })
    ),
  });
}

/** Captures the current supervising wrapper and its descriptors without caller-supplied identity. */
export function observeCurrentWrapperDescriptorsBeforeSpawn(
  parentFds: readonly number[]
): ReturnType<typeof observeParentDescriptorsBeforeSpawn> {
  const wrapper = readCurrentWrapperProcessStartIdentity();
  return observeParentDescriptorsBeforeSpawn(wrapper.pid, wrapper.startToken, parentFds);
}

/**
 * Accepts the child's diagnostic publication only when FD3/FD4/FD5 are the exact identities the
 * parent observed before spawn. This publication proves canonical mapping; cleanup authority still
 * comes exclusively from the supervising parent's EBADF observations.
 */
export function acceptCanonicalChildDescriptorPublication(
  value: unknown,
  before: ReturnType<typeof observeParentDescriptorsBeforeSpawn>
): ChildDescriptorPublication {
  const publication = exactRecord(
    value,
    ['schemaVersion', 'contract', 'wrapperPid', 'wrapperStartToken', 'spawnNonce', 'descriptors'],
    'child_descriptor_publication'
  );
  if (
    publication.schemaVersion !== 1 ||
    publication.contract !== 'agent-teams.hosted-owner-child-fd-map/v1' ||
    publication.wrapperPid !== before.wrapperPid ||
    publication.wrapperStartToken !== before.wrapperStartToken ||
    publication.spawnNonce !== before.spawnNonce ||
    typeof publication.spawnNonce !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(publication.spawnNonce) ||
    !Array.isArray(publication.descriptors) ||
    publication.descriptors.length !== PARENT_DESCRIPTOR_ROLES.length
  ) {
    throw new Error('p3c_child_descriptor_publication');
  }
  const descriptors = publication.descriptors.map((candidate, index) => {
    const descriptor = exactRecord(
      candidate,
      ['role', 'childFd', 'device', 'inode', 'mode'],
      `child_descriptor_publication_${index}`
    );
    const expected = before.descriptors[index];
    if (
      expected === undefined ||
      descriptor.role !== expected.role ||
      descriptor.childFd !== index + 3 ||
      descriptor.device !== expected.beforeSpawn.device ||
      descriptor.inode !== expected.beforeSpawn.inode ||
      descriptor.mode !== expected.beforeSpawn.mode
    ) {
      throw new Error('p3c_child_descriptor_publication');
    }
    return Object.freeze({
      role: expected.role,
      childFd: (index + 3) as 3 | 4 | 5,
      device: expected.beforeSpawn.device,
      inode: expected.beforeSpawn.inode,
      mode: expected.beforeSpawn.mode,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    contract: 'agent-teams.hosted-owner-child-fd-map/v1',
    wrapperPid: before.wrapperPid,
    wrapperStartToken: before.wrapperStartToken,
    spawnNonce: before.spawnNonce,
    descriptors: Object.freeze(descriptors),
  });
}

/** Captures kernel descriptor identities immediately before the wrapper spawn boundary. */
export function observeParentDescriptorsBeforeSpawn(
  wrapperPid: number,
  wrapperStartToken: string,
  parentFds: readonly number[],
  dependencies?: ParentDescriptorObservationDependencies
): Omit<
  ParentDescriptorLifecycleRecord,
  'descriptors' | 'spawnBoundaryMonotonicNs' | 'childPublication'
> & {
  readonly descriptors: readonly Omit<
    ParentDescriptorLifecycleRecord['descriptors'][number],
    'afterSpawn'
  >[];
} {
  if (
    !Number.isSafeInteger(wrapperPid) ||
    wrapperPid < 2 ||
    wrapperPid !== process.pid ||
    !/^[0-9a-f]{64}$/u.test(wrapperStartToken) ||
    parentFds.length !== PARENT_DESCRIPTOR_ROLES.length ||
    new Set(parentFds).size !== parentFds.length
  ) {
    throw new Error('p3c_parent_fd_lifecycle_input');
  }
  return Object.freeze({
    wrapperPid,
    wrapperStartToken,
    spawnNonce: randomBytes(32).toString('hex'),
    descriptors: Object.freeze(
      PARENT_DESCRIPTOR_ROLES.map((role, index) => {
        const parentFd = parentFds[index];
        if (!Number.isSafeInteger(parentFd) || parentFd === undefined || parentFd < 0) {
          throw new Error('p3c_parent_fd_lifecycle_input');
        }
        const stat = (dependencies?.fstatDescriptor ?? fstatSync)(parentFd, { bigint: true });
        const path = `/proc/${wrapperPid}/fd/${parentFd}`;
        const procStat = (dependencies?.statProcDescriptor ?? statSync)(path, { bigint: true });
        if (procStat.dev !== stat.dev || procStat.ino !== stat.ino || procStat.mode !== stat.mode) {
          throw new Error('p3c_parent_fd_identity_mismatch');
        }
        return Object.freeze({
          role,
          parentFd,
          beforeSpawn: Object.freeze({
            method: 'proc-fd-identity' as const,
            observedMonotonicNs: process.hrtime.bigint().toString(),
            path,
            device: String(procStat.dev),
            inode: String(procStat.ino),
            mode: Number(procStat.mode & 0o7777n),
          }),
        });
      })
    ),
  });
}

/** Fails closed unless every exact parent descriptor is now rejected by the kernel with EBADF. */
export function observeParentDescriptorsClosed(
  before: ReturnType<typeof observeParentDescriptorsBeforeSpawn>,
  spawnBoundaryMonotonicNs = process.hrtime.bigint().toString()
): ParentDescriptorCleanupObservation {
  if (
    !/^\d+$/u.test(spawnBoundaryMonotonicNs) ||
    before.descriptors.some(
      ({ beforeSpawn }) =>
        BigInt(beforeSpawn.observedMonotonicNs) >= BigInt(spawnBoundaryMonotonicNs)
    )
  ) {
    throw new Error('p3c_parent_fd_spawn_boundary_invalid');
  }
  return Object.freeze({
    wrapperPid: before.wrapperPid,
    wrapperStartToken: before.wrapperStartToken,
    spawnNonce: before.spawnNonce,
    spawnBoundaryMonotonicNs,
    descriptors: Object.freeze(
      before.descriptors.map((descriptor) => {
        try {
          fstatSync(descriptor.parentFd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EBADF') {
            return Object.freeze({
              ...descriptor,
              afterSpawn: Object.freeze({
                method: 'fstat-ebadf' as const,
                observedMonotonicNs: process.hrtime.bigint().toString(),
                errno: 'EBADF' as const,
              }),
            });
          }
          throw error;
        }
        throw new Error('p3c_parent_fd_copy_still_open');
      })
    ),
  });
}

function browserArgv(admission: PreflightAdmission): readonly string[] {
  return Object.freeze([
    `/browser/${admission.descriptor.product.playwrightEntry.relativePath}`,
    'test',
    `/browser/${admission.descriptor.product.playwrightSpec.relativePath}`,
    '--config',
    `/browser/${admission.descriptor.product.playwrightConfig.relativePath}`,
    '--workers=1',
    '--retries=0',
  ]);
}

export function buildSupervisorPlan(
  admission: PreflightAdmission,
  sandbox: DisposableSandbox
): SupervisorPlan {
  const cwd = (name: 'project' | 'run') =>
    Object.freeze({
      device: sandbox.directoryIdentities[name].device,
      inode: sandbox.directoryIdentities[name].inode,
    });
  const chromium = admission.descriptor.product.chromiumExecutable;
  const capture = Object.freeze(
    Object.fromEntries(
      RUNTIME_CAPTURE_NAMES.map((name) => [name, `/sandbox/capture/${name}.ndjson`])
    ) as Record<RuntimeCaptureName, string>
  );
  const executableSha256 = {
    owner: admission.execution.ownerEntry.pin.sha256,
    opencode: admission.execution.openCode.pin.sha256,
    supervisor: admission.execution.supervisor.pin.sha256,
    product: admission.descriptor.product.compositionEntry.sha256,
    browser: admission.descriptor.toolchain.node.sha256,
    ...Object.fromEntries(CHROMIUM_DESCENDANT_ROLES.map((role) => [role, chromium.sha256])),
  } as Record<ProcessEvidenceRole, string>;
  const executableDevice = {
    owner: admission.execution.ownerEntry.pin.device,
    opencode: admission.execution.openCode.pin.device,
    supervisor: admission.execution.supervisor.pin.device,
    product: admission.descriptor.product.compositionEntry.device,
    browser: admission.descriptor.toolchain.node.device,
    ...Object.fromEntries(CHROMIUM_DESCENDANT_ROLES.map((role) => [role, chromium.device])),
  } as Record<ProcessEvidenceRole, string>;
  const executableInode = {
    owner: admission.execution.ownerEntry.pin.inode,
    opencode: admission.execution.openCode.pin.inode,
    supervisor: admission.execution.supervisor.pin.inode,
    product: admission.descriptor.product.compositionEntry.inode,
    browser: admission.descriptor.toolchain.node.inode,
    ...Object.fromEntries(CHROMIUM_DESCENDANT_ROLES.map((role) => [role, chromium.inode])),
  } as Record<ProcessEvidenceRole, string>;
  const producer = (role: 'browser' | 'opencode' | 'owner' | 'product-producer') => {
    const identity = admission.producerCandidate.payload.producers.find(
      (candidate) => candidate.role === role
    );
    if (!identity) throw new Error(`p3c_supervisor_missing_producer_${role}`);
    return identity;
  };
  const expectedProducerArtifactSha256 = Object.freeze({
    owner: producer('owner').artifactManifestSha256,
    opencode: producer('opencode').artifactManifestSha256,
    product: producer('product-producer').artifactManifestSha256,
    browser: producer('browser').artifactManifestSha256,
  });
  const expectedProducerModuleSha256 = Object.freeze({
    owner: producer('owner').moduleSha256,
    opencode: producer('opencode').moduleSha256,
    product: producer('product-producer').moduleSha256,
    browser: producer('browser').moduleSha256,
  });
  return Object.freeze({
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    controllerNonce: admission.descriptor.controllerNonce,
    runId: sandbox.runId,
    maximumRuntimeMs: 900_000,
    shutdownGraceMs: 5_000,
    runtimeManifest: Object.freeze({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
      runId: sandbox.runId,
      sandboxRoot: '/sandbox',
      markerPath: '/sandbox/.p3c-sandbox.json',
      evidenceRoot: '/sandbox/evidence',
      driverBaseUrl: 'http://127.0.0.1:45130/',
      productBaseUrl: 'http://127.0.0.1:45131/',
      approvalPath: '/api/hosted/v1/team-approvals/decisions',
      browser: Object.freeze({ workers: 1, retries: 0 }),
      capture,
      captureEmissionContract: Object.freeze({
        contract: PRODUCER_PROVENANCE_CONTRACT.contract,
        version: PRODUCER_PROVENANCE_CONTRACT.version,
        contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
        environment: PRODUCER_PROVENANCE_CONTRACT.environment,
        framing: PRODUCER_PROVENANCE_CONTRACT.framing,
        descriptorSlots: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots,
        verifierMayProduceBytes: false as const,
        producerNativeIdentitiesComposed: true as const,
        captureAuthority: 'verified-signed-four-producer-candidate' as const,
        producerCandidate: admission.producerCandidate.binding,
        captureMappings: RUNTIME_CAPTURE_PRODUCER_MAPPINGS,
      }),
      refs: Object.freeze({
        openCode: producer('opencode').sourceCommit,
        openCodeExecutableSha256: producer('opencode').executableSha256,
        orchestrator: producer('owner').sourceCommit,
        product: producer('browser').sourceCommit,
      }),
    }),
    ownerChildProtocol: Object.freeze({
      wrapperArgv: Object.freeze([
        OWNER_WRAPPER_ARGUMENT,
        '/sandbox/runtime-manifest.json',
      ] as const),
      sealedArgv: Object.freeze([
        OWNER_SEALED_PROTOCOL_ARGUMENT,
        OWNER_WRAPPER_ARGUMENT,
        '/sandbox/runtime-manifest.json',
      ] as const),
      childLocalDescriptors: OWNER_CHILD_FDS,
      descriptorContract: OWNER_CHILD_PROTOCOL,
      parentSourceDescriptors: 'arbitrary-distinct-owned',
      closeParentCopiesAfterSpawn: true,
      compatibilityProbing: false,
      socketPathReconnect: false,
    }),
    network: Object.freeze({
      namespace: 'new',
      mountNamespace: 'new',
      loopbackOnly: true,
      outbound: 'deny',
      expectedListeners: Object.freeze([
        Object.freeze({ address: '127.0.0.1', port: 4096, role: 'opencode' }),
        Object.freeze({ address: '127.0.0.1', port: 45131, role: 'product' }),
      ] as const),
    }),
    filesystem: Object.freeze({
      mountNamespace: 'new',
      pidNamespace: 'new',
      pivotRoot: true,
      rootFilesystem: 'private-tmpfs',
      ambientHostFilesystem: 'deny',
      expectedTopLevelEntries: Object.freeze([
        'browser',
        'composition',
        'dev',
        'opencode',
        'owner',
        'p3b2',
        'proc',
        'product',
        'sandbox',
        'toolchain',
      ] as const),
      expectedMounts: Object.freeze([
        Object.freeze({
          target: '/',
          access: 'private' as const,
          sourceDescriptor: null,
        }),
        Object.freeze({
          target: '/proc',
          access: 'private' as const,
          sourceDescriptor: null,
        }),
        Object.freeze({
          target: '/dev',
          access: 'private' as const,
          sourceDescriptor: null,
        }),
        Object.freeze({
          target: '/product',
          access: 'read-only' as const,
          sourceDescriptor: 4,
        }),
        Object.freeze({
          target: '/browser',
          access: 'read-only' as const,
          sourceDescriptor: 5,
        }),
        Object.freeze({
          target: '/owner',
          access: 'read-only' as const,
          sourceDescriptor: 6,
        }),
        Object.freeze({
          target: '/opencode',
          access: 'read-only' as const,
          sourceDescriptor: 7,
        }),
        Object.freeze({
          target: '/sandbox',
          access: 'read-write' as const,
          sourceDescriptor: 10,
        }),
        Object.freeze({
          target: '/toolchain',
          access: 'read-only' as const,
          sourceDescriptor: 11,
        }),
        Object.freeze({
          target: '/p3b2',
          access: 'read-only' as const,
          sourceDescriptor: 12,
        }),
        Object.freeze({
          target: '/composition',
          access: 'read-only' as const,
          sourceDescriptor: 13,
        }),
      ]),
      ambientPathProbes: Object.freeze(['/host', '/home', '/root', '/tmp', '/var/data'] as const),
    }),
    processOwnership: Object.freeze({
      environmentKey: PROCESS_OWNERSHIP_ENV,
      marker: processOwnershipMarker(admission.descriptor.controllerNonce, sandbox.runId),
      census: '/proc',
      identity: 'pid-start-time',
      signals: Object.freeze(['SIGTERM', 'SIGKILL'] as const),
      escapedDescendants: 'independent-proc-census',
    }),
    cleanupAudit: Object.freeze({
      injectionPoints: Object.freeze(['owner', 'opencode'] as const),
      escapedCensusKinds: Object.freeze(['setsid', 'double-fork'] as const),
      escalationSignals: Object.freeze(['SIGTERM', 'SIGKILL'] as const),
      outsideSandboxSentinelPath: '/outside-sandbox-sentinel' as const,
    }),
    sandbox: Object.freeze({
      descriptor: 10,
      device: sandbox.device,
      inode: sandbox.inode,
      mountId: sandbox.mountId,
      mountPath: '/sandbox',
    }),
    inputs: Object.freeze({
      productRuntimeDescriptor: 4,
      browserBundleDescriptor: 5,
      ownerEntryDescriptor: 6,
      openCodeDescriptor: 7,
      browserDescriptor: 8,
      toolchainDescriptor: 11,
      p3b2Descriptor: 12,
      productCompositionDescriptor: 13,
      nodeRelativePath: admission.descriptor.toolchain.node.relativePath,
      loaderRelativePath: admission.descriptor.toolchain.loader.relativePath,
    }),
    closures: Object.freeze({
      productRuntime: admission.descriptor.product.runtimeClosure,
      browserBundle: admission.descriptor.product.browserBundle,
      toolchain: admission.descriptor.toolchain.closure,
      p3b2: admission.descriptor.p3b2.closure,
    }),
    expectedCwd: Object.freeze({
      supervisor: cwd('run'),
      opencode: cwd('project'),
      owner: cwd('project'),
      product: cwd('project'),
      browser: cwd('project'),
    }),
    expectedExecutableSha256: Object.freeze(executableSha256),
    expectedExecutableDevice: Object.freeze(executableDevice),
    expectedExecutableInode: Object.freeze(executableInode),
    expectedProducerArtifactSha256,
    expectedProducerModuleSha256,
    expectedArgv: Object.freeze({
      supervisor: Object.freeze([]),
      opencode: Object.freeze(['serve', '--hostname', '127.0.0.1', '--port', '4096']),
      owner: Object.freeze([OWNER_WRAPPER_ARGUMENT, '/sandbox/runtime-manifest.json']),
      product: Object.freeze([]),
      browser: browserArgv(admission),
    }),
    startSchedule: ROOT_PROCESS_SCHEDULE,
    chromiumDescendants: CHROMIUM_DESCENDANT_ROLES,
    playwrightWorkers: 1,
    playwrightRetries: 0,
  });
}

function parseStart(
  value: unknown,
  plan: SupervisorPlan,
  expected: (typeof ROOT_PROCESS_SCHEDULE)[number],
  sequence: number,
  supervisorToken: string
): ProcessStartEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'role',
      'instanceId',
      'generation',
      'restartBoundary',
      'pid',
      'pidfdInode',
      'startTime',
      'observedMonotonicNs',
      'startToken',
      'parentStartToken',
      'observerStartToken',
      'ownershipMarkerSha256',
      'executableDevice',
      'executableInode',
      'executableSha256',
      'argvSha256',
      'cwdDevice',
      'cwdInode',
    ],
    'supervisor_start'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'process-start' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    item.role !== expected.role ||
    item.instanceId !== expected.instanceId ||
    item.generation !== expected.generation ||
    item.restartBoundary !== expected.restartBoundary ||
    item.parentStartToken !== supervisorToken ||
    item.observerStartToken !== supervisorToken ||
    item.ownershipMarkerSha256 !== sha256(plan.processOwnership.marker) ||
    !Number.isSafeInteger(item.pid) ||
    (item.pid as number) < 2 ||
    item.executableDevice !== plan.expectedExecutableDevice[expected.role] ||
    item.executableInode !== plan.expectedExecutableInode[expected.role] ||
    item.executableSha256 !== plan.expectedExecutableSha256[expected.role] ||
    item.argvSha256 !== sha256(canonicalJson(plan.expectedArgv[expected.role])) ||
    item.cwdDevice !== plan.expectedCwd[expected.role].device ||
    item.cwdInode !== plan.expectedCwd[expected.role].inode
  )
    throw new Error('p3c_supervisor_start_binding');
  return Object.freeze({
    role: expected.role,
    instanceId: expected.instanceId,
    generation: expected.generation,
    restartBoundary: expected.restartBoundary,
    pid: item.pid as number,
    pidfdInode: validateDecimal(item.pidfdInode, 'supervisor_pidfd'),
    startTime: validateDecimal(item.startTime, 'supervisor_start_time'),
    observedMonotonicNs: validateDecimal(item.observedMonotonicNs, 'supervisor_observed_monotonic'),
    startToken: validateRecordId(item.startToken, 'supervisor_start_token'),
    parentStartToken: supervisorToken,
    observerStartToken: supervisorToken,
    executableDevice: validateDecimal(item.executableDevice, 'supervisor_executable_device'),
    executableInode: validateDecimal(item.executableInode, 'supervisor_executable_inode'),
    executableSha256: validateRecordId(item.executableSha256, 'supervisor_executable_sha'),
    argvSha256: validateRecordId(item.argvSha256, 'supervisor_argv_sha'),
    cwdDevice: validateDecimal(item.cwdDevice, 'supervisor_cwd_device'),
    cwdInode: validateDecimal(item.cwdInode, 'supervisor_cwd_inode'),
  });
}

function parseDescendant(
  value: unknown,
  plan: SupervisorPlan,
  role: ChromiumRole,
  sequence: number,
  supervisorToken: string,
  parentToken: string
): ProcessStartEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'role',
      'instanceId',
      'generation',
      'restartBoundary',
      'pid',
      'pidfdInode',
      'startTime',
      'observedMonotonicNs',
      'startToken',
      'parentStartToken',
      'observerStartToken',
      'ownershipMarkerSha256',
      'executableDevice',
      'executableInode',
      'executableSha256',
      'argvSha256',
      'cwdDevice',
      'cwdInode',
    ],
    'supervisor_descendant'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'descendant-start' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    item.role !== role ||
    item.instanceId !== `${role}-1` ||
    item.generation !== 1 ||
    item.restartBoundary !== 'initial' ||
    item.parentStartToken !== parentToken ||
    item.observerStartToken !== supervisorToken ||
    item.ownershipMarkerSha256 !== sha256(plan.processOwnership.marker) ||
    !Number.isSafeInteger(item.pid) ||
    (item.pid as number) < 2 ||
    item.executableDevice !== plan.expectedExecutableDevice[role] ||
    item.executableInode !== plan.expectedExecutableInode[role] ||
    item.executableSha256 !== plan.expectedExecutableSha256[role] ||
    typeof item.argvSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(item.argvSha256) ||
    item.cwdDevice !== plan.expectedCwd.browser.device ||
    item.cwdInode !== plan.expectedCwd.browser.inode
  )
    throw new Error('p3c_supervisor_descendant_binding');
  return Object.freeze({
    role,
    instanceId: `${role}-1`,
    generation: 1,
    restartBoundary: 'initial',
    pid: item.pid as number,
    pidfdInode: validateDecimal(item.pidfdInode, 'descendant_pidfd'),
    startTime: validateDecimal(item.startTime, 'descendant_start_time'),
    observedMonotonicNs: validateDecimal(item.observedMonotonicNs, 'descendant_monotonic'),
    startToken: validateRecordId(item.startToken, 'descendant_start_token'),
    parentStartToken: parentToken,
    observerStartToken: supervisorToken,
    executableDevice: validateDecimal(item.executableDevice, 'descendant_device'),
    executableInode: validateDecimal(item.executableInode, 'descendant_inode'),
    executableSha256: validateRecordId(item.executableSha256, 'descendant_sha'),
    argvSha256: validateRecordId(item.argvSha256, 'descendant_argv_sha'),
    cwdDevice: validateDecimal(item.cwdDevice, 'descendant_cwd_device'),
    cwdInode: validateDecimal(item.cwdInode, 'descendant_cwd_inode'),
  });
}

function parseNetwork(value: unknown, plan: SupervisorPlan, sequence: number): NetworkEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'namespaceInode',
      'parentNamespaceInode',
      'interfaces',
      'routes',
      'listeners',
      'outboundProbes',
    ],
    'supervisor_network'
  );
  const expectedInterfaces = [
    {
      name: 'lo',
      flags: ['LOOPBACK', 'UP'],
      addresses: ['127.0.0.1/8', '::1/128'],
    },
  ];
  const expectedRoutes = [
    { destination: '127.0.0.0/8', interface: 'lo', scope: 'host' },
    { destination: '::1/128', interface: 'lo', scope: 'host' },
  ];
  const expectedOutbound = [
    { destination: '198.51.100.1:443', result: 'denied' },
    { destination: '[2001:db8::1]:443', result: 'denied' },
  ];
  const namespaceInode = validateDecimal(item.namespaceInode, 'network_namespace');
  const parentNamespaceInode = validateDecimal(
    item.parentNamespaceInode,
    'network_parent_namespace'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'network-evidence' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    namespaceInode === parentNamespaceInode ||
    canonicalJson(item.interfaces) !== canonicalJson(expectedInterfaces) ||
    canonicalJson(item.routes) !== canonicalJson(expectedRoutes) ||
    canonicalJson(item.listeners) !== canonicalJson(plan.network.expectedListeners) ||
    canonicalJson(item.outboundProbes) !== canonicalJson(expectedOutbound)
  )
    throw new Error('p3c_supervisor_network_binding');
  return Object.freeze({
    namespaceInode,
    parentNamespaceInode,
    interfaces: Object.freeze(expectedInterfaces),
    routes: Object.freeze(expectedRoutes),
    listeners: plan.network.expectedListeners,
    outboundProbes: Object.freeze(expectedOutbound),
    recordSha256: sha256(canonicalJson(item)),
  });
}

function parseFilesystem(
  value: unknown,
  plan: SupervisorPlan,
  sequence: number
): FilesystemEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'mountNamespaceInode',
      'parentMountNamespaceInode',
      'pidNamespaceInode',
      'parentPidNamespaceInode',
      'rootDevice',
      'rootInode',
      'topLevelEntries',
      'mounts',
      'ambientPathProbes',
      'complete',
    ],
    'supervisor_filesystem'
  );
  const mountNamespaceInode = validateDecimal(item.mountNamespaceInode, 'filesystem_mount_ns');
  const parentMountNamespaceInode = validateDecimal(
    item.parentMountNamespaceInode,
    'filesystem_parent_mount_ns'
  );
  const pidNamespaceInode = validateDecimal(item.pidNamespaceInode, 'filesystem_pid_ns');
  const parentPidNamespaceInode = validateDecimal(
    item.parentPidNamespaceInode,
    'filesystem_parent_pid_ns'
  );
  const expectedAmbient = plan.filesystem.ambientPathProbes.map((path) => ({
    path,
    result: 'absent',
  }));
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'filesystem-evidence' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    mountNamespaceInode === parentMountNamespaceInode ||
    pidNamespaceInode === parentPidNamespaceInode ||
    canonicalJson(item.topLevelEntries) !==
      canonicalJson(plan.filesystem.expectedTopLevelEntries) ||
    canonicalJson(item.mounts) !== canonicalJson(plan.filesystem.expectedMounts) ||
    canonicalJson(item.ambientPathProbes) !== canonicalJson(expectedAmbient) ||
    item.complete !== true
  )
    throw new Error('p3c_supervisor_filesystem_binding');
  return Object.freeze({
    mountNamespaceInode,
    parentMountNamespaceInode,
    pidNamespaceInode,
    parentPidNamespaceInode,
    rootDevice: validateDecimal(item.rootDevice, 'filesystem_root_device'),
    rootInode: validateDecimal(item.rootInode, 'filesystem_root_inode'),
    recordSha256: sha256(canonicalJson(item)),
  });
}

function parseExit(
  value: unknown,
  plan: SupervisorPlan,
  start: ProcessStartEvidence,
  sequence: number,
  supervisorToken: string
): ProcessExitEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'startToken',
      'pidfdInode',
      'observedMonotonicNs',
      'observerStartToken',
      'disposition',
    ],
    'supervisor_exit'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'process-exit' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    item.startToken !== start.startToken ||
    item.pidfdInode !== start.pidfdInode ||
    item.observerStartToken !== supervisorToken ||
    item.disposition !== 'controlled-exit' ||
    BigInt(validateDecimal(item.observedMonotonicNs, 'supervisor_exit_monotonic')) <=
      BigInt(start.observedMonotonicNs)
  )
    throw new Error('p3c_supervisor_exit_binding');
  return Object.freeze({
    startToken: start.startToken,
    pidfdInode: start.pidfdInode,
    observedMonotonicNs: item.observedMonotonicNs as string,
    observerStartToken: supervisorToken,
    disposition: 'controlled-exit',
  });
}

function parseOwnerReplacement(
  value: unknown,
  plan: SupervisorPlan,
  previousOwner: ProcessStartEvidence,
  previousSocket: OwnerSocketEvidence,
  nextGeneration: number,
  sequence: number,
  supervisorToken: string
): ProcessExitEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'observerStartToken',
      'previousOwnerStartToken',
      'previousOwnerPidfdInode',
      'previousGeneration',
      'previousExitCause',
      'previousExitObservedMonotonicNs',
      'previousOwnerSurvivorStartTokens',
      'invalidatedSocket',
      'postInvalidationCurrentOwnerStartTokens',
      'postInvalidationCurrentSocketOwners',
      'nextGeneration',
    ],
    'supervisor_owner_replacement'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'owner-replacement' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    item.observerStartToken !== supervisorToken ||
    item.previousOwnerStartToken !== previousOwner.startToken ||
    item.previousOwnerPidfdInode !== previousOwner.pidfdInode ||
    item.previousGeneration !== previousOwner.generation ||
    item.previousExitCause !== 'restart-boundary-complete' ||
    BigInt(validateDecimal(item.previousExitObservedMonotonicNs, 'owner_replacement_exit')) <=
      BigInt(previousOwner.observedMonotonicNs) ||
    canonicalJson(item.previousOwnerSurvivorStartTokens) !== canonicalJson([]) ||
    canonicalJson(item.invalidatedSocket) !== canonicalJson(previousSocket) ||
    canonicalJson(item.postInvalidationCurrentOwnerStartTokens) !== canonicalJson([]) ||
    canonicalJson(item.postInvalidationCurrentSocketOwners) !== canonicalJson([]) ||
    item.nextGeneration !== nextGeneration ||
    nextGeneration !== previousOwner.generation + 1
  )
    throw new Error('p3c_supervisor_owner_replacement');
  return Object.freeze({
    startToken: previousOwner.startToken,
    pidfdInode: previousOwner.pidfdInode,
    observedMonotonicNs: item.previousExitObservedMonotonicNs as string,
    observerStartToken: supervisorToken,
    disposition: 'replacement-boundary-exit',
  });
}

function parseCurrentOwner(
  value: unknown,
  plan: SupervisorPlan,
  owner: ProcessStartEvidence,
  sequence: number,
  supervisorToken: string
): OwnerSocketEvidence {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'observerStartToken',
      'generation',
      'currentOwnerStartTokens',
      'currentSocketOwners',
    ],
    'supervisor_current_owner'
  );
  if (!Array.isArray(item.currentSocketOwners) || item.currentSocketOwners.length !== 1)
    throw new Error('p3c_supervisor_current_owner');
  const socket = exactRecord(
    item.currentSocketOwners[0],
    ['device', 'inode', 'generation', 'ownerStartToken'],
    'supervisor_current_owner_socket'
  );
  if (
    item.schemaVersion !== 2 ||
    item.protocol !== SUPERVISOR_PROTOCOL ||
    item.type !== 'owner-current' ||
    item.sequence !== sequence ||
    item.controllerNonce !== plan.controllerNonce ||
    item.runId !== plan.runId ||
    item.observerStartToken !== supervisorToken ||
    item.generation !== owner.generation ||
    canonicalJson(item.currentOwnerStartTokens) !== canonicalJson([owner.startToken]) ||
    socket.generation !== owner.generation ||
    socket.ownerStartToken !== owner.startToken
  )
    throw new Error('p3c_supervisor_current_owner');
  return Object.freeze({
    device: validateDecimal(socket.device, 'current_owner_socket_device'),
    inode: validateDecimal(socket.inode, 'current_owner_socket_inode'),
    generation: owner.generation,
    ownerStartToken: owner.startToken,
  });
}

function parseRawFiles(
  value: unknown,
  starts: readonly ProcessStartEvidence[],
  supervisorStart: ProcessStartEvidence
): Readonly<Record<RawOrigin, RawFileEvidence>> {
  const item = exactRecord(value, RAW_ORIGINS, 'supervisor_raw_files');
  const result = {} as Record<RawOrigin, RawFileEvidence>;
  for (const origin of RAW_ORIGINS) {
    const file = exactRecord(
      item[origin],
      [
        'path',
        'sha256',
        'size',
        'captureDevice',
        'captureInode',
        'producerStartTokens',
        'producerPidfdInodes',
        'parentCreatedExclusive',
        'writerDescriptorsClosed',
        'sealedBeforeParse',
      ],
      `supervisor_raw_${origin}`
    );
    const producerRoles: Readonly<Record<RawOrigin, readonly ProcessEvidenceRole[]>> = {
      browser: ['browser'],
      'product-http': ['product'],
      'product-sse': ['product'],
      'owner-wal': ['owner'],
      opencode: ['opencode'],
      supervisor: ['supervisor'],
    };
    const producers =
      origin === 'supervisor'
        ? [supervisorStart]
        : starts.filter(({ role }) => producerRoles[origin].includes(role));
    const expectedStartTokens = producers.map(({ startToken }) => startToken).sort();
    const expectedPidfds = producers.map(({ pidfdInode }) => pidfdInode).sort();
    if (
      file.path !== `/sandbox/raw/${origin}.ndjson` ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 1 ||
      (file.size as number) > 64 * 1024 * 1024 ||
      canonicalJson(file.producerStartTokens) !== canonicalJson(expectedStartTokens) ||
      canonicalJson(file.producerPidfdInodes) !== canonicalJson(expectedPidfds) ||
      file.parentCreatedExclusive !== true ||
      file.writerDescriptorsClosed !== true ||
      file.sealedBeforeParse !== true
    )
      throw new Error('p3c_supervisor_raw_file');
    result[origin] = Object.freeze({
      path: file.path,
      sha256: validateRecordId(file.sha256, `supervisor_raw_${origin}_sha`),
      size: file.size as number,
      captureDevice: validateDecimal(file.captureDevice, `supervisor_raw_${origin}_device`),
      captureInode: validateDecimal(file.captureInode, `supervisor_raw_${origin}_inode`),
      producerStartTokens: Object.freeze(expectedStartTokens),
      producerPidfdInodes: Object.freeze(expectedPidfds),
      parentCreatedExclusive: true,
      writerDescriptorsClosed: true,
      sealedBeforeParse: true,
    });
  }
  return Object.freeze(result);
}

function parseCaptureFiles(
  value: unknown,
  plan: SupervisorPlan,
  starts: readonly ProcessStartEvidence[],
  descendants: readonly ProcessStartEvidence[],
  exits: readonly ProcessExitEvidence[],
  supervisorStart: ProcessStartEvidence,
  processEvidenceSetId: string
): Readonly<Record<RuntimeCaptureName, ProducerCaptureFileEvidence>> {
  const producerRoles = {
    conditionalPostLedgerPath: 'product',
    negativeResultsPath: 'browser',
    openCodeTimelinePath: 'opencode',
    ownerWalTimelinePath: 'owner',
    productTimelinePath: 'product',
    protectedEffectLedgerPath: 'opencode',
  } as const satisfies Readonly<Record<RuntimeCaptureName, RootProcessRole>>;
  const expectedSlots = {
    conditionalPostLedgerPath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.conditionalPostLedger,
    negativeResultsPath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.negativeResults,
    openCodeTimelinePath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.openCodeTimeline,
    ownerWalTimelinePath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.ownerWalTimeline,
    productTimelinePath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.productTimeline,
    protectedEffectLedgerPath: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots.protectedEffectLedger,
  };
  const item = exactRecord(value, RUNTIME_CAPTURE_NAMES, 'supervisor_capture_files');
  const result = {} as Record<RuntimeCaptureName, ProducerCaptureFileEvidence>;
  const inspectedStartTokens = [...starts, ...descendants].map(({ startToken }) => startToken).sort();
  for (const name of RUNTIME_CAPTURE_NAMES) {
    const file = exactRecord(item[name], ['stream', 'contractSha256', 'shards'], `capture_${name}`);
    const expectedProducers = starts.filter(({ role }) => role === producerRoles[name]);
    if (
      file.stream !== RUNTIME_CAPTURE_STREAMS[name] ||
      file.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
      !Array.isArray(file.shards) ||
      file.shards.length !== expectedProducers.length ||
      file.shards.length === 0
    ) {
      throw new Error(`p3c_supervisor_capture_${name}`);
    }
    const shards = file.shards.map((candidate, index) => {
      const producer = expectedProducers[index];
      if (producer === undefined) throw new Error(`p3c_supervisor_capture_${name}_producer`);
      const shard = exactRecord(
        candidate,
        [
          'authority',
          'path',
          'sha256',
          'size',
          'contractSha256',
          'stream',
          'captureDevice',
          'captureInode',
          'producerPid',
          'producerStartToken',
          'producerPidfdInode',
          'producerRole',
          'producerFd',
          'producerArtifactSha256',
          'producerModuleSha256',
          'allocation',
          'parentClose',
          'producerOpen',
          'producerClose',
          'descendantCensus',
          'seal',
        ],
        `capture_${name}_shard`
      );
      const parentClose = exactRecord(
        shard.parentClose,
        [
          'supervisorPid',
          'supervisorStartToken',
          'writerFd',
          'descriptorPath',
          'captureDevice',
          'captureInode',
          'observedOpenMonotonicNs',
          'spawnBoundaryMonotonicNs',
          'observedClosedMonotonicNs',
          'closeObservationMethod',
          'closedErrno',
        ],
        `capture_${name}_parent_close`
      );
      const allocation = exactRecord(
        shard.allocation,
        [
          'observationMethod',
          'flags',
          'mode',
          'nlink',
          'initialSize',
          'captureDevice',
          'captureInode',
        ],
        `capture_${name}_allocation`
      );
      const producerOpen = exactRecord(
        shard.producerOpen,
        ['descriptorPath', 'captureDevice', 'captureInode', 'observationMethod', 'observedMonotonicNs'],
        `capture_${name}_producer_open`
      );
      const producerClose = exactRecord(
        shard.producerClose,
        [
          'observationMethod',
          'observedMonotonicNs',
          'descriptorPath',
          'producerStartToken',
          'producerPidfdInode',
        ],
        `capture_${name}_producer_close`
      );
      const census = exactRecord(
        shard.descendantCensus,
        [
          'observationMethod',
          'observedMonotonicNs',
          'processEvidenceSetId',
          'inspectedStartTokens',
          'retainedWriterCount',
        ],
        `capture_${name}_descendant_census`
      );
      const seal = exactRecord(
        shard.seal,
        [
          'observationMethod',
          'observedMonotonicNs',
          'captureDevice',
          'captureInode',
          'mode',
          'nlink',
          'size',
          'sha256',
          'manifestSha256',
        ],
        `capture_${name}_seal`
      );
      const captureDevice = validateDecimal(shard.captureDevice, `capture_${name}_device`);
      const captureInode = validateDecimal(shard.captureInode, `capture_${name}_inode`);
      const parentOpenNs = validateDecimal(parentClose.observedOpenMonotonicNs, 'capture_parent_open');
      const spawnNs = validateDecimal(parentClose.spawnBoundaryMonotonicNs, 'capture_spawn');
      const parentClosedNs = validateDecimal(
        parentClose.observedClosedMonotonicNs,
        'capture_parent_closed'
      );
      const producerOpenNs = validateDecimal(
        producerOpen.observedMonotonicNs,
        'capture_producer_open'
      );
      const producerClosedNs = validateDecimal(
        producerClose.observedMonotonicNs,
        'capture_producer_closed'
      );
      const censusNs = validateDecimal(census.observedMonotonicNs, 'capture_census');
      const sealNs = validateDecimal(seal.observedMonotonicNs, 'capture_seal');
      const expectedPath =
        name === 'ownerWalTimelinePath'
          ? plan.runtimeManifest.capture[name].replace(/\.ndjson$/u, `.${producer.instanceId}.ndjson`)
          : plan.runtimeManifest.capture[name];
      const matchingExit = exits.find(
        ({ startToken, pidfdInode }) =>
          startToken === producer.startToken && pidfdInode === producer.pidfdInode
      );
      const expectedSealManifestSha256 = producerCaptureSealManifestSha256({
        path: shard.path as string,
        stream: RUNTIME_CAPTURE_STREAMS[name],
        contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
        captureDevice,
        captureInode,
        size: shard.size as number,
        sha256: shard.sha256 as string,
        producerPid: producer.pid,
        producerStartToken: producer.startToken,
        producerPidfdInode: producer.pidfdInode,
        producerRole: producer.role as RootProcessRole,
        producerFd: expectedSlots[name],
        producerArtifactSha256: shard.producerArtifactSha256 as string,
        producerModuleSha256: shard.producerModuleSha256 as string,
      });
      if (
        shard.authority !== 'kernel-observed' ||
        shard.path !== expectedPath ||
        shard.stream !== RUNTIME_CAPTURE_STREAMS[name] ||
        shard.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
        !Number.isSafeInteger(shard.size) ||
        (shard.size as number) < 2 ||
        (shard.size as number) > 64 * 1024 * 1024 ||
        shard.producerPid !== producer.pid ||
        shard.producerStartToken !== producer.startToken ||
        shard.producerPidfdInode !== producer.pidfdInode ||
        shard.producerRole !== producer.role ||
        shard.producerFd !== expectedSlots[name] ||
        shard.producerArtifactSha256 !== plan.expectedProducerArtifactSha256[producerRoles[name]] ||
        shard.producerModuleSha256 !== plan.expectedProducerModuleSha256[producerRoles[name]] ||
        allocation.observationMethod !== 'openat-exclusive-no-follow' ||
        allocation.flags !== 'O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY|O_APPEND|O_CLOEXEC' ||
        allocation.mode !== 0o600 ||
        allocation.nlink !== 1 ||
        allocation.initialSize !== 0 ||
        allocation.captureDevice !== captureDevice ||
        allocation.captureInode !== captureInode ||
        parentClose.supervisorPid !== supervisorStart.pid ||
        parentClose.supervisorStartToken !== supervisorStart.startToken ||
        !Number.isSafeInteger(parentClose.writerFd) ||
        (parentClose.writerFd as number) < 3 ||
        parentClose.descriptorPath !== `/proc/${supervisorStart.pid}/fd/${String(parentClose.writerFd)}` ||
        parentClose.captureDevice !== captureDevice ||
        parentClose.captureInode !== captureInode ||
        parentClose.closeObservationMethod !== 'fstat-ebadf' ||
        parentClose.closedErrno !== 'EBADF' ||
        !(BigInt(parentOpenNs) < BigInt(spawnNs) && BigInt(spawnNs) < BigInt(parentClosedNs)) ||
        producerOpen.descriptorPath !== `/proc/${producer.pid}/fd/${expectedSlots[name]}` ||
        producerOpen.captureDevice !== captureDevice ||
        producerOpen.captureInode !== captureInode ||
        producerOpen.observationMethod !== 'proc-fd-identity' ||
        BigInt(producerOpenNs) < BigInt(spawnNs) ||
        producerClose.descriptorPath !== `/proc/${producer.pid}/fd/${expectedSlots[name]}` ||
        producerClose.producerStartToken !== producer.startToken ||
        producerClose.producerPidfdInode !== producer.pidfdInode ||
        typeof producerClose.observationMethod !== 'string' ||
        !['proc-fd-absent', 'pidfd-exact-exit'].includes(producerClose.observationMethod) ||
        matchingExit === undefined ||
        BigInt(producerClosedNs) <= BigInt(producerOpenNs) ||
        (producerClose.observationMethod === 'pidfd-exact-exit'
          ? producerClosedNs !== matchingExit.observedMonotonicNs
          : BigInt(producerClosedNs) >= BigInt(matchingExit.observedMonotonicNs)) ||
        census.observationMethod !== 'proc-fd-inode-census' ||
        census.processEvidenceSetId !== processEvidenceSetId ||
        canonicalJson(census.inspectedStartTokens) !== canonicalJson(inspectedStartTokens) ||
        census.retainedWriterCount !== 0 ||
        BigInt(censusNs) < BigInt(matchingExit.observedMonotonicNs) ||
        seal.observationMethod !== 'read-only-stable-hash' ||
        seal.captureDevice !== captureDevice ||
        seal.captureInode !== captureInode ||
        seal.mode !== 0o400 ||
        seal.nlink !== 1 ||
        seal.size !== shard.size ||
        seal.sha256 !== shard.sha256 ||
        seal.manifestSha256 !== expectedSealManifestSha256 ||
        BigInt(sealNs) < BigInt(censusNs)
      ) {
        throw new Error(`p3c_supervisor_capture_${name}_kernel_proof`);
      }
      return Object.freeze({
        authority: 'kernel-observed' as const,
        path: shard.path as string,
        sha256: validateRecordId(shard.sha256, `capture_${name}_sha`),
        size: shard.size as number,
        contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
        stream: RUNTIME_CAPTURE_STREAMS[name],
        captureDevice,
        captureInode,
        producerPid: producer.pid,
        producerStartToken: producer.startToken,
        producerPidfdInode: producer.pidfdInode,
        producerRole: producer.role as RootProcessRole,
        producerFd: expectedSlots[name],
        producerArtifactSha256: shard.producerArtifactSha256 as string,
        producerModuleSha256: shard.producerModuleSha256 as string,
        allocation: Object.freeze(allocation) as ProducerCaptureShardEvidence['allocation'],
        parentClose: Object.freeze(parentClose) as ProducerCaptureShardEvidence['parentClose'],
        producerOpen: Object.freeze(producerOpen) as ProducerCaptureShardEvidence['producerOpen'],
        producerClose: Object.freeze(producerClose) as ProducerCaptureShardEvidence['producerClose'],
        descendantCensus: Object.freeze(census) as ProducerCaptureShardEvidence['descendantCensus'],
        seal: Object.freeze({
          ...seal,
          sha256: validateRecordId(seal.sha256, `capture_${name}_seal_sha`),
          manifestSha256: validateRecordId(
            seal.manifestSha256,
            `capture_${name}_seal_manifest_sha`
          ),
        }) as ProducerCaptureShardEvidence['seal'],
      });
    });
    result[name] = Object.freeze({
      stream: RUNTIME_CAPTURE_STREAMS[name],
      contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
      shards: Object.freeze(shards),
    });
  }
  return Object.freeze(result);
}

export function parseOwnerChildDescriptorCleanup(
  value: unknown,
  starts: readonly Pick<ProcessStartEvidence, 'role' | 'pid' | 'startToken'>[]
): SupervisorOutcome['ownerChildDescriptorCleanup'] {
  const cleanup = exactRecord(
    value,
    ['schemaVersion', 'contract', 'records'],
    'supervisor_owner_child_descriptor_cleanup'
  );
  const expectedOwnerTokens = starts
    .filter(({ role }) => role === 'owner')
    .map(({ startToken }) => startToken);
  if (!Array.isArray(cleanup.records) || cleanup.records.length !== expectedOwnerTokens.length) {
    throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
  }
  const observedTokens = cleanup.records.map((candidate, index) => {
    const expectedOwner = starts.filter(({ role }) => role === 'owner')[index];
    if (expectedOwner === undefined) {
      throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
    }
    const record = exactRecord(
      candidate,
      [
        'wrapperPid',
        'wrapperStartToken',
        'spawnNonce',
        'spawnBoundaryMonotonicNs',
        'childPublication',
        'descriptors',
      ],
      `supervisor_owner_child_descriptor_cleanup_${index}`
    );
    if (
      record.wrapperPid !== expectedOwner.pid ||
      record.wrapperStartToken !== expectedOwnerTokens[index] ||
      typeof record.spawnNonce !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.spawnNonce) ||
      typeof record.spawnBoundaryMonotonicNs !== 'string' ||
      !/^\d+$/u.test(record.spawnBoundaryMonotonicNs) ||
      !Array.isArray(record.descriptors) ||
      record.descriptors.length !== PARENT_DESCRIPTOR_ROLES.length
    ) {
      throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
    }
    const parentFds = new Set<number>();
    const descriptors = record.descriptors.map((candidateDescriptor, descriptorIndex) => {
      const descriptor = exactRecord(
        candidateDescriptor,
        ['role', 'parentFd', 'beforeSpawn', 'afterSpawn'],
        `supervisor_owner_child_descriptor_${index}_${descriptorIndex}`
      );
      const beforeSpawn = exactRecord(
        descriptor.beforeSpawn,
        ['method', 'observedMonotonicNs', 'path', 'device', 'inode', 'mode'],
        `supervisor_owner_child_descriptor_before_${index}_${descriptorIndex}`
      );
      const afterSpawn = exactRecord(
        descriptor.afterSpawn,
        ['method', 'observedMonotonicNs', 'errno'],
        `supervisor_owner_child_descriptor_after_${index}_${descriptorIndex}`
      );
      const spawnBoundaryMonotonicNs = record.spawnBoundaryMonotonicNs;
      const beforeSpawnMonotonicNs = beforeSpawn.observedMonotonicNs;
      const afterSpawnMonotonicNs = afterSpawn.observedMonotonicNs;
      if (
        descriptor.role !== PARENT_DESCRIPTOR_ROLES[descriptorIndex] ||
        !Number.isSafeInteger(descriptor.parentFd) ||
        (descriptor.parentFd as number) < 0 ||
        parentFds.has(descriptor.parentFd as number) ||
        beforeSpawn.method !== 'proc-fd-identity' ||
        typeof beforeSpawn.observedMonotonicNs !== 'string' ||
        !/^\d+$/u.test(beforeSpawn.observedMonotonicNs) ||
        typeof spawnBoundaryMonotonicNs !== 'string' ||
        typeof beforeSpawnMonotonicNs !== 'string' ||
        BigInt(beforeSpawnMonotonicNs) >= BigInt(spawnBoundaryMonotonicNs) ||
        beforeSpawn.path !== `/proc/${expectedOwner.pid}/fd/${descriptor.parentFd}` ||
        typeof beforeSpawn.device !== 'string' ||
        !/^\d+$/u.test(beforeSpawn.device) ||
        typeof beforeSpawn.inode !== 'string' ||
        !/^[1-9]\d*$/u.test(beforeSpawn.inode) ||
        !Number.isSafeInteger(beforeSpawn.mode) ||
        (beforeSpawn.mode as number) < 0 ||
        (beforeSpawn.mode as number) > 0o7777 ||
        afterSpawn.method !== 'fstat-ebadf' ||
        typeof afterSpawn.observedMonotonicNs !== 'string' ||
        !/^\d+$/u.test(afterSpawn.observedMonotonicNs) ||
        typeof afterSpawnMonotonicNs !== 'string' ||
        BigInt(afterSpawnMonotonicNs) < BigInt(spawnBoundaryMonotonicNs) ||
        afterSpawn.errno !== 'EBADF'
      ) {
        throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
      }
      parentFds.add(descriptor.parentFd as number);
      return Object.freeze({
        role: descriptor.role as (typeof PARENT_DESCRIPTOR_ROLES)[number],
        parentFd: descriptor.parentFd as number,
        beforeSpawn: Object.freeze({
          method: 'proc-fd-identity' as const,
          observedMonotonicNs: beforeSpawn.observedMonotonicNs,
          path: beforeSpawn.path as string,
          device: beforeSpawn.device as string,
          inode: beforeSpawn.inode as string,
          mode: beforeSpawn.mode as number,
        }),
        afterSpawn: Object.freeze({
          method: 'fstat-ebadf' as const,
          observedMonotonicNs: afterSpawn.observedMonotonicNs,
          errno: 'EBADF' as const,
        }),
      });
    });
    const beforeObservation = Object.freeze({
      wrapperPid: record.wrapperPid as number,
      wrapperStartToken: record.wrapperStartToken as string,
      spawnNonce: record.spawnNonce as string,
      descriptors: Object.freeze(
        descriptors.map(({ role, parentFd, beforeSpawn }) =>
          Object.freeze({ role, parentFd, beforeSpawn })
        )
      ),
    });
    const childPublication = acceptCanonicalChildDescriptorPublication(
      record.childPublication,
      beforeObservation
    );
    return Object.freeze({
      token: record.wrapperStartToken as string,
      record: Object.freeze({
        wrapperPid: record.wrapperPid as number,
        wrapperStartToken: record.wrapperStartToken as string,
        spawnNonce: record.spawnNonce as string,
        spawnBoundaryMonotonicNs: record.spawnBoundaryMonotonicNs,
        childPublication,
        descriptors: Object.freeze(descriptors),
      }),
    });
  });
  if (
    cleanup.schemaVersion !== 2 ||
    cleanup.contract !== 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2'
  ) {
    throw new Error('p3c_supervisor_owner_child_descriptor_cleanup');
  }
  return Object.freeze({
    contract: cleanup.contract,
    ownerStartTokens: Object.freeze(observedTokens.map(({ token }) => token)),
    records: Object.freeze(observedTokens.map(({ record }) => record)),
  });
}

function recordType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).type as string | undefined;
}

export function parseSupervisorTranscript(
  bytes: Uint8Array,
  plan: SupervisorPlan
): SupervisorOutcome {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_TRANSCRIPT_BYTES || bytes.at(-1) !== 0x0a)
    throw new Error('p3c_supervisor_transcript_frame');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n');
  const documents = lines.map((line) => {
    if (!line || line.includes('\r') || line.length > 512 * 1024)
      throw new Error('p3c_supervisor_transcript_line');
    const value = JSON.parse(line) as unknown;
    if (canonicalJson(value) !== line) throw new Error('p3c_supervisor_transcript_noncanonical');
    return value;
  });
  let sequence = 1;
  const hello = exactRecord(
    documents.shift(),
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'planSha256',
      'kernelFeatures',
      'playwrightWorkers',
      'playwrightRetries',
      'supervisorPid',
      'supervisorPidfdInode',
      'supervisorStartTime',
      'supervisorStartToken',
      'supervisorObservedMonotonicNs',
      'processOwnershipMarkerSha256',
      'supervisorExecutableDevice',
      'supervisorExecutableInode',
      'supervisorExecutableSha256',
      'supervisorArgvSha256',
      'supervisorCwdDevice',
      'supervisorCwdInode',
    ],
    'supervisor_hello'
  );
  if (
    hello.schemaVersion !== 2 ||
    hello.protocol !== SUPERVISOR_PROTOCOL ||
    hello.type !== 'hello' ||
    hello.sequence !== sequence ||
    hello.controllerNonce !== plan.controllerNonce ||
    hello.runId !== plan.runId ||
    hello.planSha256 !== sha256(canonicalJson(plan)) ||
    hello.playwrightWorkers !== 1 ||
    hello.playwrightRetries !== 0 ||
    canonicalJson(hello.kernelFeatures) !==
      canonicalJson([
        'pidfd_open',
        'pidfd_send_signal',
        'openat2',
        'execveat',
        'mount_namespace',
        'network_namespace',
        'pid_namespace',
        'pivot_root',
      ]) ||
    hello.supervisorExecutableDevice !== plan.expectedExecutableDevice.supervisor ||
    hello.supervisorExecutableInode !== plan.expectedExecutableInode.supervisor ||
    hello.supervisorExecutableSha256 !== plan.expectedExecutableSha256.supervisor ||
    hello.supervisorArgvSha256 !== sha256(canonicalJson(plan.expectedArgv.supervisor)) ||
    hello.supervisorCwdDevice !== plan.expectedCwd.supervisor.device ||
    hello.supervisorCwdInode !== plan.expectedCwd.supervisor.inode ||
    !Number.isSafeInteger(hello.supervisorPid) ||
    (hello.supervisorPid as number) < 2 ||
    hello.processOwnershipMarkerSha256 !== sha256(plan.processOwnership.marker)
  )
    throw new Error('p3c_supervisor_hello');
  const supervisorToken = validateRecordId(hello.supervisorStartToken, 'supervisor_self_token');
  const supervisorStart = Object.freeze({
    role: 'supervisor' as const,
    instanceId: 'supervisor-1',
    generation: 1,
    restartBoundary: 'initial',
    pid: hello.supervisorPid as number,
    pidfdInode: validateDecimal(hello.supervisorPidfdInode, 'supervisor_self_pidfd'),
    startTime: validateDecimal(hello.supervisorStartTime, 'supervisor_self_start'),
    observedMonotonicNs: validateDecimal(
      hello.supervisorObservedMonotonicNs,
      'supervisor_self_monotonic'
    ),
    startToken: supervisorToken,
    parentStartToken: null,
    observerStartToken: null,
    executableDevice: validateDecimal(hello.supervisorExecutableDevice, 'supervisor_self_device'),
    executableInode: validateDecimal(hello.supervisorExecutableInode, 'supervisor_self_inode'),
    executableSha256: validateRecordId(hello.supervisorExecutableSha256, 'supervisor_self_sha'),
    argvSha256: validateRecordId(hello.supervisorArgvSha256, 'supervisor_self_argv'),
    cwdDevice: validateDecimal(hello.supervisorCwdDevice, 'supervisor_self_cwd_device'),
    cwdInode: validateDecimal(hello.supervisorCwdInode, 'supervisor_self_cwd_inode'),
  });

  const starts: ProcessStartEvidence[] = [];
  const replacementExits: ProcessExitEvidence[] = [];
  let previousOwner: ProcessStartEvidence | undefined;
  let previousOwnerSocket: OwnerSocketEvidence | undefined;
  for (const expected of plan.startSchedule) {
    if (expected.role === 'owner' && expected.generation > 1) {
      if (previousOwner === undefined || previousOwnerSocket === undefined)
        throw new Error('p3c_supervisor_owner_replacement_missing');
      sequence += 1;
      replacementExits.push(
        parseOwnerReplacement(
          documents.shift(),
          plan,
          previousOwner,
          previousOwnerSocket,
          expected.generation,
          sequence,
          supervisorToken
        )
      );
    }
    sequence += 1;
    const start = parseStart(documents.shift(), plan, expected, sequence, supervisorToken);
    if (
      start.role === 'owner' &&
      start.generation > 1 &&
      BigInt(start.observedMonotonicNs) <=
        BigInt(replacementExits.at(-1)?.observedMonotonicNs ?? '0')
    )
      throw new Error('p3c_supervisor_owner_replacement_order');
    starts.push(start);
    if (start.role === 'owner') {
      sequence += 1;
      previousOwnerSocket = parseCurrentOwner(
        documents.shift(),
        plan,
        start,
        sequence,
        supervisorToken
      );
      previousOwner = start;
    }
  }
  const browserStart = starts.find(({ role }) => role === 'browser');
  if (!browserStart) throw new Error('p3c_supervisor_browser_start_missing');
  let chromiumBrowserToken = '';
  const descendants = plan.chromiumDescendants.map((role) => {
    sequence += 1;
    const parentToken =
      role === 'chromium-browser' ? browserStart.startToken : chromiumBrowserToken;
    const descendant = parseDescendant(
      documents.shift(),
      plan,
      role,
      sequence,
      supervisorToken,
      parentToken
    );
    if (role === 'chromium-browser') chromiumBrowserToken = descendant.startToken;
    return descendant;
  });
  if (recordType(documents[0]) === 'descendant-start')
    throw new Error('p3c_supervisor_unexpected_descendant');
  sequence += 1;
  const descendantEnumeration = exactRecord(
    documents.shift(),
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'observerStartToken',
      'browserRootStartToken',
      'enumeratedStartTokens',
      'unexpectedStartTokens',
      'ownershipAmbiguities',
      'complete',
    ],
    'supervisor_descendant_enumeration'
  );
  const expectedDescendantTokens = descendants.map(({ startToken }) => startToken).sort();
  if (
    descendantEnumeration.schemaVersion !== 2 ||
    descendantEnumeration.protocol !== SUPERVISOR_PROTOCOL ||
    descendantEnumeration.type !== 'descendant-enumeration' ||
    descendantEnumeration.sequence !== sequence ||
    descendantEnumeration.controllerNonce !== plan.controllerNonce ||
    descendantEnumeration.runId !== plan.runId ||
    descendantEnumeration.observerStartToken !== supervisorToken ||
    descendantEnumeration.browserRootStartToken !== browserStart.startToken ||
    canonicalJson(descendantEnumeration.enumeratedStartTokens) !==
      canonicalJson(expectedDescendantTokens) ||
    canonicalJson(descendantEnumeration.unexpectedStartTokens) !== canonicalJson([]) ||
    canonicalJson(descendantEnumeration.ownershipAmbiguities) !== canonicalJson([]) ||
    descendantEnumeration.complete !== true
  )
    throw new Error('p3c_supervisor_descendant_enumeration');
  sequence += 1;
  const filesystem = parseFilesystem(documents.shift(), plan, sequence);
  sequence += 1;
  const network = parseNetwork(documents.shift(), plan, sequence);

  const allOwned = [...starts, ...descendants];
  const identitySet = [supervisorStart, ...allOwned];
  if (
    new Set(identitySet.map(({ pidfdInode }) => pidfdInode)).size !== identitySet.length ||
    new Set(identitySet.map(({ startToken }) => startToken)).size !== identitySet.length ||
    new Set(identitySet.map(({ pid, startTime }) => `${pid}:${startTime}`)).size !==
      identitySet.length ||
    starts.filter(({ role }) => role === 'owner').length !== OWNER_RESTART_BOUNDARIES.length ||
    canonicalJson(
      starts.filter(({ role }) => role === 'owner').map(({ restartBoundary }) => restartBoundary)
    ) !== canonicalJson(OWNER_RESTART_BOUNDARIES)
  )
    throw new Error('p3c_supervisor_process_identity');

  const replacementExitTokens = new Set(replacementExits.map(({ startToken }) => startToken));
  const finalExits = [...allOwned]
    .filter(({ startToken }) => !replacementExitTokens.has(startToken))
    .reverse()
    .map((start) => {
      sequence += 1;
      return parseExit(documents.shift(), plan, start, sequence, supervisorToken);
    });
  const exits = [...replacementExits, ...finalExits];
  sequence += 1;
  const cleanupAudit = exactRecord(
    documents.shift(),
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'observerStartToken',
      'injectionPoints',
      'injectedProcessStartTokens',
      'escapedCensusKinds',
      'escapedDescendantStartTokens',
      'escalationSignals',
      'exitCauses',
      'postDrainEscapedDescendantStartTokens',
      'postDrainIndependentCensus',
      'outsideSandboxSentinel',
    ],
    'supervisor_cleanup_audit'
  );
  const injectedTokens = Array.isArray(cleanupAudit.injectedProcessStartTokens)
    ? cleanupAudit.injectedProcessStartTokens.map((value) =>
        validateRecordId(value, 'cleanup_injected_start')
      )
    : [];
  const escapedTokens = Array.isArray(cleanupAudit.escapedDescendantStartTokens)
    ? cleanupAudit.escapedDescendantStartTokens.map((value) =>
        validateRecordId(value, 'cleanup_escaped_start')
      )
    : [];
  const sentinel = exactRecord(
    cleanupAudit.outsideSandboxSentinel,
    ['path', 'digestBefore', 'digestAfter', 'mutationObserved'],
    'supervisor_cleanup_sentinel'
  );
  const exitCauses = Array.isArray(cleanupAudit.exitCauses)
    ? cleanupAudit.exitCauses.map((value) =>
        exactRecord(value, ['injectionPoint', 'startToken', 'cause'], 'cleanup_exit_cause')
      )
    : [];
  if (
    cleanupAudit.schemaVersion !== 2 ||
    cleanupAudit.protocol !== SUPERVISOR_PROTOCOL ||
    cleanupAudit.type !== 'cleanup-audit' ||
    cleanupAudit.sequence !== sequence ||
    cleanupAudit.controllerNonce !== plan.controllerNonce ||
    cleanupAudit.runId !== plan.runId ||
    cleanupAudit.observerStartToken !== supervisorToken ||
    canonicalJson(cleanupAudit.injectionPoints) !==
      canonicalJson(plan.cleanupAudit.injectionPoints) ||
    injectedTokens.length !== 2 ||
    new Set(injectedTokens).size !== 2 ||
    canonicalJson(cleanupAudit.escapedCensusKinds) !==
      canonicalJson(plan.cleanupAudit.escapedCensusKinds) ||
    escapedTokens.length !== 2 ||
    new Set(escapedTokens).size !== 2 ||
    canonicalJson(cleanupAudit.escalationSignals) !==
      canonicalJson(plan.cleanupAudit.escalationSignals) ||
    exitCauses.length !== 2 ||
    exitCauses.some(
      (cause, index) =>
        cause.injectionPoint !== plan.cleanupAudit.injectionPoints[index] ||
        cause.startToken !== injectedTokens[index] ||
        cause.cause !== 'sigkill-after-grace'
    ) ||
    canonicalJson(cleanupAudit.postDrainEscapedDescendantStartTokens) !== canonicalJson([]) ||
    cleanupAudit.postDrainIndependentCensus !== true ||
    sentinel.path !== plan.cleanupAudit.outsideSandboxSentinelPath ||
    validateRecordId(sentinel.digestBefore, 'cleanup_sentinel_before') !== sentinel.digestAfter ||
    sentinel.mutationObserved !== false
  )
    throw new Error('p3c_supervisor_cleanup_audit');
  const cleanupAuditRecordSha256 = sha256(canonicalJson(cleanupAudit));
  sequence += 1;
  const drain = exactRecord(
    documents.shift(),
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'observerStartToken',
      'ownedStartTokens',
      'closedPidfdInodes',
      'survivorStartTokens',
      'ownershipAmbiguities',
      'descendantEnumerationRecordSha256',
      'postTerminationDescendantStartTokens',
      'cleanupAuditRecordSha256',
      'processEvidenceSetId',
      'bounded',
      'zeroOwnedSurvivors',
    ],
    'supervisor_drain'
  );
  const expectedTokens = allOwned.map(({ startToken }) => startToken).sort();
  const expectedPidfds = allOwned.map(({ pidfdInode }) => pidfdInode).sort();
  const processEvidenceSetId = sha256(
    `agent-teams.p3c.process-evidence-set/v1\0${canonicalJson({
      networkRecordSha256: network.recordSha256,
      filesystemRecordSha256: filesystem.recordSha256,
      descendantEnumerationRecordSha256: sha256(canonicalJson(descendantEnumeration)),
      ownedStartTokens: expectedTokens,
      closedPidfdInodes: expectedPidfds,
      exitedStartTokens: exits.map(({ startToken }) => startToken),
      cleanupAuditRecordSha256,
    })}`
  );
  if (
    drain.schemaVersion !== 2 ||
    drain.protocol !== SUPERVISOR_PROTOCOL ||
    drain.type !== 'drain' ||
    drain.sequence !== sequence ||
    drain.controllerNonce !== plan.controllerNonce ||
    drain.runId !== plan.runId ||
    drain.observerStartToken !== supervisorToken ||
    canonicalJson(drain.ownedStartTokens) !== canonicalJson(expectedTokens) ||
    canonicalJson(drain.closedPidfdInodes) !== canonicalJson(expectedPidfds) ||
    canonicalJson(drain.survivorStartTokens) !== canonicalJson([]) ||
    canonicalJson(drain.ownershipAmbiguities) !== canonicalJson([]) ||
    drain.descendantEnumerationRecordSha256 !== sha256(canonicalJson(descendantEnumeration)) ||
    canonicalJson(drain.postTerminationDescendantStartTokens) !== canonicalJson([]) ||
    drain.cleanupAuditRecordSha256 !== cleanupAuditRecordSha256 ||
    drain.processEvidenceSetId !== processEvidenceSetId ||
    drain.bounded !== true ||
    drain.zeroOwnedSurvivors !== true
  )
    throw new Error('p3c_supervisor_drain');

  sequence += 1;
  const result = exactRecord(
    documents.shift(),
    [
      'schemaVersion',
      'protocol',
      'type',
      'sequence',
      'controllerNonce',
      'runId',
      'planSha256',
      'networkRecordSha256',
      'filesystemRecordSha256',
      'drainRecordSha256',
      'boundedShutdown',
      'zeroOwnedSurvivors',
      'completeBrowserProcessTree',
      'playwrightWorkers',
      'playwrightRetries',
      'readyInstances',
      'exitedStartTokens',
      'ownerChildDescriptorCleanup',
      'rawFiles',
      'captureFiles',
    ],
    'supervisor_result'
  );
  if (
    documents.length !== 0 ||
    result.schemaVersion !== 2 ||
    result.protocol !== SUPERVISOR_PROTOCOL ||
    result.type !== 'result' ||
    result.sequence !== sequence ||
    result.controllerNonce !== plan.controllerNonce ||
    result.runId !== plan.runId ||
    result.planSha256 !== sha256(canonicalJson(plan)) ||
    result.networkRecordSha256 !== network.recordSha256 ||
    result.filesystemRecordSha256 !== filesystem.recordSha256 ||
    result.drainRecordSha256 !== sha256(canonicalJson(drain)) ||
    result.boundedShutdown !== true ||
    result.zeroOwnedSurvivors !== true ||
    result.completeBrowserProcessTree !== true ||
    result.playwrightWorkers !== 1 ||
    result.playwrightRetries !== 0 ||
    canonicalJson(result.readyInstances) !==
      canonicalJson(starts.map(({ instanceId }) => instanceId)) ||
    canonicalJson(result.exitedStartTokens) !==
      canonicalJson(exits.map(({ startToken }) => startToken))
  )
    throw new Error('p3c_supervisor_result');
  const ownerChildDescriptorCleanup = parseOwnerChildDescriptorCleanup(
    result.ownerChildDescriptorCleanup,
    starts
  );
  return Object.freeze({
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    zeroOwnedSurvivors: true,
    supervisorStart,
    starts: Object.freeze(starts),
    descendants: Object.freeze(descendants),
    exits: Object.freeze(exits),
    network,
    filesystem,
    processEvidenceSetId,
    ownerChildDescriptorCleanup,
    rawFiles: parseRawFiles(result.rawFiles, starts, supervisorStart),
    captureFiles: parseCaptureFiles(
      result.captureFiles,
      plan,
      starts,
      descendants,
      exits,
      supervisorStart,
      processEvidenceSetId
    ),
    transcriptSha256: createHash('sha256').update(bytes).digest('hex'),
    transcript: Buffer.from(bytes),
  });
}

export function exactChildEnvironment(ownershipMarker?: string): Readonly<Record<string, string>> {
  if (ownershipMarker !== undefined && !/^[0-9a-f]{64}$/u.test(ownershipMarker))
    throw new Error('p3c_process_ownership_marker');
  return Object.freeze({
    HOME: '/sandbox/home',
    XDG_CONFIG_HOME: '/sandbox/config',
    XDG_CACHE_HOME: '/sandbox/cache',
    XDG_DATA_HOME: '/sandbox/data',
    XDG_STATE_HOME: '/sandbox/state',
    XDG_RUNTIME_DIR: '/sandbox/run',
    TMPDIR: '/sandbox/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    ...(ownershipMarker === undefined ? {} : { [PROCESS_OWNERSHIP_ENV]: ownershipMarker }),
  });
}

export async function collectBoundedStream(
  stream: NodeJS.ReadableStream | null,
  maximum: number
): Promise<Buffer> {
  if (!stream) throw new Error('p3c_supervisor_stream_missing');
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  for await (const value of stream) {
    const chunk = Buffer.from(value as Uint8Array);
    if (overflow || total + chunk.length > maximum) {
      overflow = true;
      continue;
    }
    total += chunk.length;
    chunks.push(chunk);
  }
  if (overflow) throw new Error('p3c_supervisor_stream_oversize');
  return Buffer.concat(chunks, total);
}

function parseProcStat(source: string, expectedPid: number): DetachedProcessAnchor {
  const closingParen = source.lastIndexOf(')');
  if (!source.startsWith(`${expectedPid} (`) || closingParen < 1)
    throw new Error('p3c_supervisor_process_anchor');
  const fields = source
    .slice(closingParen + 2)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  const processState = fields[0];
  if (
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(sessionId) ||
    !processState ||
    !/^[A-Z]$/u.test(processState) ||
    !startTime ||
    !/^\d+$/u.test(startTime)
  )
    throw new Error('p3c_supervisor_process_anchor');
  return Object.freeze({
    pid: expectedPid,
    processGroupId,
    sessionId,
    startTime,
    processState,
    verification: 'verified-owned',
  });
}

function captureSpawnedProcessIdentity(
  child: ChildProcess,
  dependencies?: ProcessCleanupDependencies
): DetachedProcessAnchor {
  const pid = child.pid;
  if (!pid || pid < 2) throw new Error('p3c_supervisor_process_anchor');
  // This must remain synchronous from spawn() through the /proc read. Returning to the event loop
  // would let libuv reap an already-exited child and make its numeric PID reusable before the
  // anchor exists. A zombie is still the spawned child (and cannot be reused), but is not runnable.
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error('p3c_supervisor_exited_before_process_anchor');
  const anchor = parseProcStat(
    dependencies?.readSpawnedProcessStat?.(pid) ?? readFileSync(`/proc/${pid}/stat`, 'utf8'),
    pid
  );
  if (child.exitCode !== null || child.signalCode !== null || anchor.processState === 'Z')
    throw new Error('p3c_supervisor_exited_before_process_anchor');
  return anchor;
}

/**
 * Register the only group that detached spawn can deterministically create before consulting
 * /proc. This anchor participates in absence censuses immediately, but cannot authorize signals.
 */
export function registerProvisionalDetachedProcessAnchor(
  child: ChildProcess,
  ownershipMarker: string
): DetachedProcessAnchor {
  const pid = child.pid;
  if (!pid || pid < 2) throw new Error('p3c_supervisor_process_anchor');
  const anchor = Object.freeze({
    pid,
    processGroupId: pid,
    sessionId: pid,
    startTime: '',
    processState: 'U',
    verification: 'unverified-provisional' as const,
  });
  provisionalAnchors.add(anchor);
  registerRunOwnedAnchor(ownershipMarker, anchor, child);
  return anchor;
}

function promoteRunOwnedAnchor(
  marker: string,
  provisional: DetachedProcessAnchor,
  verified: DetachedProcessAnchor,
  child: ChildProcess
): void {
  const anchors = runOwnedRegistry.get(marker);
  if (!anchors?.has(provisional)) throw new Error('p3c_supervisor_process_unregistered');
  childForAnchor.set(verified, child);
  ownershipValidatedAnchors.add(verified);
  anchors.add(verified);
  anchors.delete(provisional);
  childForAnchor.delete(provisional);
}

export async function captureDetachedProcessAnchor(
  child: ChildProcess,
  ownershipMarker?: string,
  dependencies?: ProcessCleanupDependencies,
  registeredProvisional?: DetachedProcessAnchor
): Promise<DetachedProcessAnchor> {
  const provisional = ownershipMarker
    ? (registeredProvisional ?? registerProvisionalDetachedProcessAnchor(child, ownershipMarker))
    : undefined;
  const anchor = captureSpawnedProcessIdentity(child, dependencies);
  const pid = anchor.pid;
  if (anchor.processGroupId !== pid || anchor.sessionId !== pid)
    throw new Error('p3c_supervisor_process_group_unanchored');
  childForAnchor.set(anchor, child);
  if (ownershipMarker) {
    if (!(await hasOwnershipMarker(pid, ownershipMarker, dependencies)))
      throw new Error('p3c_supervisor_process_marker_changed');
    if (childHasExited(child, dependencies))
      throw new Error('p3c_supervisor_exited_before_process_anchor');
    const confirmed = await readProcessIdentity(pid, dependencies);
    if (
      childHasExited(child, dependencies) ||
      !sameProcess(confirmed, anchor) ||
      confirmed.processState === 'Z'
    )
      throw new Error('p3c_supervisor_exited_before_process_anchor');
    promoteRunOwnedAnchor(ownershipMarker, provisional!, anchor, child);
  }
  return anchor;
}

function registerRunOwnedAnchor(
  marker: string,
  anchor: DetachedProcessAnchor,
  child: ChildProcess
): void {
  if (!/^[0-9a-f]{64}$/u.test(marker)) throw new Error('p3c_process_ownership_marker');
  childForAnchor.set(anchor, child);
  const anchors = runOwnedRegistry.get(marker) ?? new Set<DetachedProcessAnchor>();
  anchors.add(anchor);
  runOwnedRegistry.set(marker, anchors);
}

function isProcChurn(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function childHasExited(child: ChildProcess, dependencies?: ProcessCleanupDependencies): boolean {
  return (
    dependencies?.childHasExited?.(child) ?? (child.exitCode !== null || child.signalCode !== null)
  );
}

async function readBoundedProcessEnvironment(
  pid: number,
  dependencies?: ProcessCleanupDependencies
): Promise<Buffer> {
  const timeoutMs =
    dependencies?.processEnvironmentTimeoutMs ??
    dependencies?.cleanupOperationTimeoutMs ??
    CLEANUP_OPERATION_TIMEOUT_MS;
  const injected = dependencies?.readProcessEnvironment;
  if (injected) {
    const bytes = await withDeadline(injected(pid), timeoutMs, 'p3c_process_environ_timeout');
    if (bytes.length > MAX_PROC_ENVIRON_BYTES) throw new Error('p3c_process_environ_oversize');
    return bytes;
  }
  let stream: ReturnType<typeof createReadStream> | undefined;
  const operation = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream = createReadStream(`/proc/${pid}/environ`, { highWaterMark: 4 * 1024 });
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_PROC_ENVIRON_BYTES) {
        stream?.destroy(new Error('p3c_process_environ_oversize'));
        return;
      }
      chunks.push(bytes);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks, size)));
  });
  return withDeadline(operation, timeoutMs, 'p3c_process_environ_timeout', () => {
    stream?.destroy(new Error('p3c_process_environ_timeout'));
  });
}

async function hasOwnershipMarker(
  pid: number,
  marker: string,
  dependencies?: ProcessCleanupDependencies
): Promise<boolean> {
  const bytes = await readBoundedProcessEnvironment(pid, dependencies);
  const expected = Buffer.from(`${PROCESS_OWNERSHIP_ENV}=${marker}`);
  return bytes
    .toString('latin1')
    .split('\0')
    .some((entry) => Buffer.from(entry, 'latin1').equals(expected));
}

async function readProcessIdentity(
  pid: number,
  dependencies?: ProcessCleanupDependencies
): Promise<OwnedProcessIdentity> {
  if (dependencies?.readProcessIdentity) return dependencies.readProcessIdentity(pid);
  const anchor = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'), pid);
  return Object.freeze(anchor);
}

function sameProcess(
  left: Pick<OwnedProcessIdentity, 'pid' | 'processGroupId' | 'sessionId' | 'startTime'>,
  right: Pick<OwnedProcessIdentity, 'pid' | 'processGroupId' | 'sessionId' | 'startTime'>
): boolean {
  return (
    left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.sessionId === right.sessionId &&
    left.startTime === right.startTime
  );
}

function processGroupHasMembers(
  processGroupId: number,
  dependencies?: ProcessCleanupDependencies
): boolean {
  if (dependencies?.processGroupHasMembers)
    return dependencies.processGroupHasMembers(processGroupId);
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function forgetRunOwnedAnchor(marker: string, anchor: DetachedProcessAnchor): void {
  const anchors = runOwnedRegistry.get(marker);
  if (!anchors) return;
  anchors.delete(anchor);
  if (anchors.size === 0) runOwnedRegistry.delete(marker);
}

/**
 * Census only groups admitted to this controller's deterministic run-owned registry. A group
 * anchor remains registered after its direct child exits, so an extant descendant keeps the census
 * non-empty. Host /proc is never enumerated.
 */
export async function censusOwnedProcesses(
  marker: string,
  dependencies?: ProcessCleanupDependencies
): Promise<readonly OwnedProcessIdentity[]> {
  if (!/^[0-9a-f]{64}$/u.test(marker)) throw new Error('p3c_process_ownership_marker');
  const identities: OwnedProcessIdentity[] = [];
  const anchors = [...(runOwnedRegistry.get(marker) ?? [])];
  for (const anchor of anchors) {
    const child = childForAnchor.get(anchor);
    if (!child || !processGroupHasMembers(anchor.processGroupId, dependencies)) continue;
    if (provisionalAnchors.has(anchor)) {
      throw new Error('p3c_process_census_unverified_provisional');
    }
    if (childHasExited(child, dependencies)) {
      identities.push(Object.freeze({ ...anchor, processState: 'G' }));
      continue;
    }
    try {
      const current = await readProcessIdentity(anchor.pid, dependencies);
      if (!sameProcess(current, anchor) || current.processState === 'Z') continue;
      if (!(await hasOwnershipMarker(anchor.pid, marker, dependencies))) continue;
      const confirmed = await readProcessIdentity(anchor.pid, dependencies);
      if (!sameProcess(confirmed, anchor) || confirmed.processState === 'Z') continue;
      identities.push(confirmed);
    } catch (error) {
      if (!isProcChurn(error)) throw new Error('p3c_process_census_incomplete');
    }
  }
  return Object.freeze(identities);
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(code));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function signalAnchoredProcessGroup(
  anchor: DetachedProcessAnchor,
  targetMarker: string,
  signalName: NodeJS.Signals,
  dependencies?: ProcessCleanupDependencies
): Promise<PinnedSignalResult> {
  if (!/^[0-9a-f]{64}$/u.test(targetMarker)) throw new Error('p3c_process_ownership_marker');
  const child = childForAnchor.get(anchor);
  if (!child) throw new Error('p3c_supervisor_process_unregistered');
  if (!ownershipValidatedAnchors.has(anchor)) return 'identity-mismatch';
  // Child lifecycle is the non-reusable capability. Once it reports exit, no subsequently read
  // numeric identity (even an exact tuple collision) may authorize a group signal.
  if (childHasExited(child, dependencies)) return 'identity-mismatch';
  try {
    if (!(await hasOwnershipMarker(anchor.pid, targetMarker, dependencies)))
      return 'marker-mismatch';
    if (childHasExited(child, dependencies)) return 'identity-mismatch';
    const current = await readProcessIdentity(anchor.pid, dependencies);
    if (!sameProcess(current, anchor) || current.processState === 'Z') return 'identity-mismatch';
  } catch (error) {
    if (!isProcChurn(error)) throw error;
    return 'identity-mismatch';
  }
  if (childHasExited(child, dependencies)) return 'identity-mismatch';

  if (!processGroupHasMembers(anchor.processGroupId, dependencies)) return 'signalled-or-exited';
  if (childHasExited(child, dependencies)) return 'identity-mismatch';
  try {
    if (dependencies?.signalProcessGroup) {
      dependencies.signalProcessGroup(anchor.processGroupId, signalName);
    } else {
      process.kill(-anchor.processGroupId, signalName);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    // ESRCH from signalling is only a race observation. Settlement is proved separately by the
    // repeated group-existence census below.
  }
  return 'signalled-or-exited';
}

async function boundedOwnedDrain(
  marker: string,
  signal: NodeJS.Signals | null,
  timeoutMs: number,
  dependencies?: ProcessCleanupDependencies
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let emptyCensuses = 0;
  for (;;) {
    if (Date.now() >= deadline) return false;
    const anchors = [...(runOwnedRegistry.get(marker) ?? [])];
    const occupied = anchors.filter((anchor) =>
      processGroupHasMembers(anchor.processGroupId, dependencies)
    );
    if (signal && occupied.some((anchor) => provisionalAnchors.has(anchor)))
      throw new Error('p3c_process_group_signal_unverified_provisional');
    // A detached leader can exit while descendants retain its process group. The registered PGID
    // is still the kernel-owned group identity in that state (a PGID cannot be reused while any
    // member remains). Signal that negative PGID until two censuses prove the owned group empty.
    if (signal) {
      for (const anchor of occupied) {
        try {
          if (dependencies?.signalProcessGroup) {
            dependencies.signalProcessGroup(anchor.processGroupId, signal);
          } else {
            process.kill(-anchor.processGroupId, signal);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    if (occupied.length === 0) {
      emptyCensuses += 1;
      if (emptyCensuses === 2) {
        for (const anchor of anchors) forgetRunOwnedAnchor(marker, anchor);
        return true;
      }
    } else {
      emptyCensuses = 0;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForIdentityExit(
  identity: Pick<OwnedProcessIdentity, 'pid' | 'processGroupId' | 'sessionId' | 'startTime'>,
  timeoutMs: number,
  dependencies?: ProcessCleanupDependencies,
  child?: ChildProcess
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && childHasExited(child, dependencies)) return true;
    try {
      const current = await withDeadline(
        readProcessIdentity(identity.pid, dependencies),
        CLEANUP_OPERATION_TIMEOUT_MS,
        'p3c_process_identity_timeout'
      );
      if (current.processState === 'Z') return true;
      if (!sameProcess(current, identity)) return true;
    } catch (error) {
      if (isProcChurn(error)) return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

export async function waitForOwnedProcessDrain(
  marker: string,
  timeoutMs: number
): Promise<boolean> {
  return boundedOwnedDrain(marker, null, timeoutMs);
}

/** @internal Production capture-failure settlement, exported for deterministic race fixtures. */
export async function settleFailedProcessCapture(
  marker: string,
  timeoutMs: number,
  dependencies?: ProcessCleanupDependencies
): Promise<void> {
  const provisional = [...(runOwnedRegistry.get(marker) ?? [])].filter((anchor) =>
    provisionalAnchors.has(anchor)
  );
  const signalDirectChildren = (signal: NodeJS.Signals): void => {
    for (const anchor of provisional) {
      const child = childForAnchor.get(anchor);
      if (!child || childHasExited(child, dependencies)) continue;
      try {
        if (dependencies?.signalDirectChild) {
          dependencies.signalDirectChild(child, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        throw new Error('p3c_supervisor_unverified_direct_signal_failed', { cause: error });
      }
    }
  };
  const waitForUnverifiedAbsence = async (): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let emptyCensuses = 0;
    for (;;) {
      if (Date.now() >= deadline) return false;
      const leadersExited = provisional.every((anchor) => {
        const child = childForAnchor.get(anchor);
        return !child || childHasExited(child, dependencies);
      });
      const groupsEmpty = provisional.every(
        (anchor) => !processGroupHasMembers(anchor.processGroupId, dependencies)
      );
      if (leadersExited && groupsEmpty) {
        emptyCensuses += 1;
        if (emptyCensuses === 2) {
          for (const anchor of provisional) forgetRunOwnedAnchor(marker, anchor);
          return true;
        }
      } else {
        emptyCensuses = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // A failed /proc or marker capture leaves only the ChildProcess handle as a trustworthy
  // capability. The derived numeric PGID is explicitly unverified and must never authorize a
  // negative-PGID signal: an exec failure or PID/group race could otherwise target host work.
  signalDirectChildren('SIGTERM');
  if (await waitForUnverifiedAbsence()) return;
  signalDirectChildren('SIGKILL');
  if (await waitForUnverifiedAbsence()) return;
  throw new Error('p3c_supervisor_capture_unverified_group_occupied');
}

export async function terminateAnchoredProcessGroup(
  anchor: DetachedProcessAnchor,
  graceMs: number,
  ownershipMarker?: string,
  dependencies?: ProcessCleanupDependencies
): Promise<void> {
  const marker = ownershipMarker;
  if (!marker) {
    throw new Error('p3c_supervisor_ownership_marker_required');
  }
  const child = childForAnchor.get(anchor);
  if (!child) throw new Error('p3c_supervisor_process_unregistered');
  registerRunOwnedAnchor(marker, anchor, child);
  if (provisionalAnchors.has(anchor)) {
    await settleFailedProcessCapture(marker, graceMs, dependencies);
    return;
  }
  if (childHasExited(child, dependencies)) {
    if (await boundedOwnedDrain(marker, 'SIGTERM', graceMs, dependencies)) return;
    if (await boundedOwnedDrain(marker, 'SIGKILL', graceMs, dependencies)) return;
    throw new Error('p3c_supervisor_leader_exited_before_owned_cleanup');
  }
  let identityFailure: Error | undefined;
  try {
    const current = await withDeadline(
      readProcessIdentity(anchor.pid, dependencies),
      CLEANUP_OPERATION_TIMEOUT_MS,
      'p3c_supervisor_process_identity_timeout'
    );
    if (childHasExited(child, dependencies)) {
      if (await boundedOwnedDrain(marker, 'SIGTERM', graceMs, dependencies)) return;
      if (await boundedOwnedDrain(marker, 'SIGKILL', graceMs, dependencies)) return;
      throw new Error('p3c_supervisor_leader_exited_before_owned_cleanup');
    }
    if (!sameProcess(current, anchor)) throw new Error('p3c_supervisor_process_anchor_changed');
    if (!(await hasOwnershipMarker(anchor.pid, marker, dependencies)))
      throw new Error('p3c_supervisor_process_marker_changed');
    if (childHasExited(child, dependencies)) {
      if (await boundedOwnedDrain(marker, 'SIGTERM', graceMs, dependencies)) return;
      if (await boundedOwnedDrain(marker, 'SIGKILL', graceMs, dependencies)) return;
      throw new Error('p3c_supervisor_leader_exited_before_owned_cleanup');
    }
    ownershipValidatedAnchors.add(anchor);
  } catch (error) {
    if (isProcChurn(error)) {
      // A missing leader identity is only an observation. Use the same settlement primitive as
      // every other drain path so one negative group census cannot discard the retained anchor.
      if (await boundedOwnedDrain(marker, 'SIGTERM', graceMs, dependencies)) return;
      if (await boundedOwnedDrain(marker, 'SIGKILL', graceMs, dependencies)) return;
      throw new Error('p3c_supervisor_leader_missing_group_occupied');
    } else {
      if (
        [
          'p3c_supervisor_process_anchor_changed',
          'p3c_supervisor_process_marker_changed',
          'p3c_supervisor_leader_exited_before_owned_cleanup',
        ].includes((error as Error).message)
      )
        throw error;
      identityFailure = error as Error;
    }
  }
  const termLeaderResult = await Promise.allSettled([
    signalAnchoredProcessGroup(anchor, marker, 'SIGTERM', dependencies),
  ]);
  const termRest = await Promise.allSettled([
    boundedOwnedDrain(marker, 'SIGTERM', graceMs, dependencies),
    waitForIdentityExit(anchor, graceMs, dependencies, child),
  ]);
  const termLeader =
    termLeaderResult[0].status === 'fulfilled' ? termLeaderResult[0].value : undefined;
  if (termLeader === 'identity-mismatch') throw new Error('p3c_supervisor_process_anchor_changed');
  if (termLeader === 'marker-mismatch') throw new Error('p3c_supervisor_process_marker_changed');
  const termDrained = termRest[0].status === 'fulfilled' && termRest[0].value;
  const termLeaderDrained = termRest[1].status === 'fulfilled' && termRest[1].value;
  const cleanupFailures = [...termLeaderResult, ...termRest].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (!termDrained || !termLeaderDrained) {
    const killLeaderResult = await Promise.allSettled([
      signalAnchoredProcessGroup(anchor, marker, 'SIGKILL', dependencies),
    ]);
    const killRest = await Promise.allSettled([
      boundedOwnedDrain(marker, 'SIGKILL', graceMs, dependencies),
      waitForIdentityExit(anchor, graceMs, dependencies, child),
    ]);
    const killLeader =
      killLeaderResult[0].status === 'fulfilled' ? killLeaderResult[0].value : undefined;
    if (killLeader === 'identity-mismatch')
      throw new Error('p3c_supervisor_process_anchor_changed');
    if (killLeader === 'marker-mismatch') throw new Error('p3c_supervisor_process_marker_changed');
    cleanupFailures.push(
      ...[...killLeaderResult, ...killRest].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
    );
    const markerDrained = killRest[0].status === 'fulfilled' && killRest[0].value;
    const leaderDrained = killRest[1].status === 'fulfilled' && killRest[1].value;
    if (!markerDrained || !leaderDrained) {
      const residual = markerDrained
        ? []
        : await withDeadline(
            censusOwnedProcesses(marker, dependencies),
            dependencies?.cleanupOperationTimeoutMs ?? CLEANUP_OPERATION_TIMEOUT_MS,
            'p3c_process_final_census_timeout'
          ).catch(() => []);
      throw new Error(
        `p3c_supervisor_timeout_drain_unproven:marker=${markerDrained}:leader=${leaderDrained}:residual=${residual.map(({ pid, startTime }) => `${pid}:${startTime}`).join(',')}`
      );
    }
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      identityFailure ? [identityFailure, ...cleanupFailures] : cleanupFailures,
      'p3c_supervisor_cleanup_degraded'
    );
  if (identityFailure) throw identityFailure;
}

export async function executeSupervisor(
  admission: PreflightAdmission,
  sandbox: DisposableSandbox,
  consumedAttempt: WrittenFileEvidence
): Promise<SupervisorOutcome> {
  await assertSandboxCurrent(sandbox);
  await Promise.all([
    ...Object.values(admission.roots).map(assertRootCurrent),
    ...Object.values(admission.execution).map(assertFileCurrent),
    ...Object.values(admission.producerCandidate.files).map(assertFileCurrent),
  ]);
  const plan = buildSupervisorPlan(admission, sandbox);
  const ownershipMarker = plan.processOwnership.marker;
  await assertOneRunAuthorizationConsumed(admission, consumedAttempt);
  const supervisor = spawn('/proc/self/fd/9', [], {
    cwd: `${procFdPath(sandbox.handle)}/run`,
    detached: true,
    shell: false,
    env: exactChildEnvironment(ownershipMarker),
    stdio: [
      'ignore',
      'pipe',
      'pipe',
      'pipe',
      admission.roots.productRuntime.handle.fd,
      admission.roots.browserBundle.handle.fd,
      admission.execution.ownerEntry.handle.fd,
      admission.execution.openCode.handle.fd,
      admission.execution.browserDescriptor.handle.fd,
      admission.execution.supervisor.handle.fd,
      sandbox.handle.fd,
      admission.roots.toolchain.handle.fd,
      admission.roots.p3b2.handle.fd,
      admission.execution.productCompositionDescriptor.handle.fd,
    ],
  });
  const supervisorSpawnFailure = new Promise<never>((_resolve, reject) => {
    supervisor.once('error', (error) => {
      reject(new Error('p3c_supervisor_spawn_failed', { cause: error }));
    });
  });
  void supervisorSpawnFailure.catch(() => undefined);
  const supervisorClosed = once(supervisor, 'close').catch(() => []);
  const supervisorExit = once(supervisor, 'exit');
  void supervisorExit.catch(() => undefined);
  const stdout = collectBoundedStream(supervisor.stdout, MAX_TRANSCRIPT_BYTES);
  const stderr = collectBoundedStream(supervisor.stderr, 4 * 1024 * 1024);
  void stdout.catch(() => undefined);
  void stderr.catch(() => undefined);
  const planPipe = supervisor.stdio[3];
  let processAnchor: DetachedProcessAnchor;
  try {
    const provisionalAnchor = registerProvisionalDetachedProcessAnchor(supervisor, ownershipMarker);
    processAnchor = await Promise.race([
      withDeadline(
        captureDetachedProcessAnchor(supervisor, ownershipMarker, undefined, provisionalAnchor),
        CLEANUP_OPERATION_TIMEOUT_MS,
        'p3c_supervisor_process_anchor_timeout'
      ),
      supervisorSpawnFailure,
    ]);
  } catch (error) {
    const cleanup = await Promise.allSettled([
      settleFailedProcessCapture(ownershipMarker, plan.shutdownGraceMs),
      withDeadline(supervisorClosed, plan.shutdownGraceMs, 'p3c_supervisor_close_timeout'),
      withDeadline(
        Promise.allSettled([stdout, stderr]),
        plan.shutdownGraceMs,
        'p3c_supervisor_stream_drain_timeout',
        () => {
          supervisor.stdout?.destroy();
          supervisor.stderr?.destroy();
        }
      ),
    ]);
    const cleanupFailure = cleanup.find((result) => result.status === 'rejected');
    if (cleanupFailure)
      throw new AggregateError(
        [error, cleanupFailure.status === 'rejected' ? cleanupFailure.reason : cleanupFailure],
        'p3c_cleanup_failed',
        { cause: error }
      );
    throw error;
  }
  const settleStreams = () =>
    withDeadline(
      Promise.allSettled([stdout, stderr]),
      plan.shutdownGraceMs * 2 + CLEANUP_OPERATION_TIMEOUT_MS * 4,
      'p3c_supervisor_stream_drain_timeout',
      () => {
        supervisor.stdout?.destroy();
        supervisor.stderr?.destroy();
      }
    );
  const terminateAndSettle = async (): Promise<void> => {
    const cleanup = await Promise.allSettled([
      terminateAnchoredProcessGroup(processAnchor, plan.shutdownGraceMs, ownershipMarker),
      settleStreams(),
      withDeadline(
        supervisorClosed,
        plan.shutdownGraceMs * 2 + CLEANUP_OPERATION_TIMEOUT_MS * 4,
        'p3c_supervisor_close_timeout'
      ),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) throw new AggregateError(failures, 'p3c_cleanup_failed');
  };
  if (!planPipe || !('end' in planPipe)) {
    await terminateAndSettle();
    throw new Error('p3c_supervisor_plan_pipe');
  }
  (planPipe as NodeJS.WritableStream).end(Buffer.from(canonicalJson(plan)));
  let timeout: NodeJS.Timeout | undefined;
  const boundedExit = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('p3c_supervisor_bounded_exit_timeout')),
      plan.maximumRuntimeMs + plan.shutdownGraceMs + 5_000
    );
    timeout.unref();
  });
  let exit: number | null;
  try {
    [exit] = (await Promise.race([supervisorExit, boundedExit]).finally(() =>
      clearTimeout(timeout)
    )) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    try {
      await terminateAndSettle();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'p3c_cleanup_failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
  if (!(await waitForOwnedProcessDrain(ownershipMarker, plan.shutdownGraceMs))) {
    await terminateAndSettle();
    throw new Error('p3c_supervisor_exit_left_descendants');
  }
  const [transcript, diagnostics] = await withDeadline(
    Promise.all([stdout, stderr]),
    plan.shutdownGraceMs,
    'p3c_supervisor_stream_drain_timeout',
    () => {
      supervisor.stdout?.destroy();
      supervisor.stderr?.destroy();
    }
  );
  await withDeadline(
    supervisorClosed,
    plan.shutdownGraceMs + CLEANUP_OPERATION_TIMEOUT_MS,
    'p3c_supervisor_close_timeout'
  );
  if (exit !== 0 || diagnostics.length !== 0) {
    await terminateAndSettle();
    throw new Error('p3c_supervisor_nonzero_or_diagnostics');
  }
  return parseSupervisorTranscript(transcript, plan);
}
