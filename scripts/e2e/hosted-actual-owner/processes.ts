import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { assertFileCurrent, assertRootCurrent, procFdPath } from './anchors';
import {
  RAW_ORIGINS,
  canonicalJson,
  exactRecord,
  sha256,
  validateDecimal,
  validateRecordId,
  type ClosurePin,
  type RawOrigin,
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
  readonly rawFiles: Readonly<Record<RawOrigin, RawFileEvidence>>;
  readonly transcriptSha256: string;
  readonly transcript: Buffer;
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
  return Object.freeze({
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    controllerNonce: admission.descriptor.controllerNonce,
    runId: sandbox.runId,
    maximumRuntimeMs: 900_000,
    shutdownGraceMs: 5_000,
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
    expectedArgv: Object.freeze({
      supervisor: Object.freeze(['--p3c-supervisor']),
      opencode: Object.freeze(['serve', '--hostname', '127.0.0.1', '--port', '4096']),
      owner: Object.freeze(['--p3c-acceptance-manifest-fd=3']),
      product: Object.freeze([
        '--p3c-composition-descriptor-fd=3',
        '--host=127.0.0.1',
        '--port=45131',
      ]),
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
      'rawFiles',
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
    rawFiles: parseRawFiles(result.rawFiles, starts, supervisorStart),
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
    processState: 'P',
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
      identities.push(anchor);
      continue;
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
  if (await boundedOwnedDrain(marker, 'SIGTERM', timeoutMs, dependencies)) return;
  if (await boundedOwnedDrain(marker, 'SIGKILL', timeoutMs, dependencies)) return;
  throw new Error('p3c_supervisor_capture_failed_group_occupied');
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
  ]);
  const plan = buildSupervisorPlan(admission, sandbox);
  const ownershipMarker = plan.processOwnership.marker;
  await assertOneRunAuthorizationConsumed(admission, consumedAttempt);
  const supervisor = spawn('/proc/self/fd/9', ['--p3c-supervisor'], {
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
  const provisionalAnchor = registerProvisionalDetachedProcessAnchor(supervisor, ownershipMarker);
  const supervisorClosed = once(supervisor, 'close').catch(() => []);
  const supervisorExit = once(supervisor, 'exit');
  const stdout = collectBoundedStream(supervisor.stdout, MAX_TRANSCRIPT_BYTES);
  const stderr = collectBoundedStream(supervisor.stderr, 4 * 1024 * 1024);
  void stdout.catch(() => undefined);
  void stderr.catch(() => undefined);
  const planPipe = supervisor.stdio[3];
  let processAnchor: DetachedProcessAnchor;
  try {
    processAnchor = await withDeadline(
      captureDetachedProcessAnchor(supervisor, ownershipMarker, undefined, provisionalAnchor),
      CLEANUP_OPERATION_TIMEOUT_MS,
      'p3c_supervisor_process_anchor_timeout'
    );
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
