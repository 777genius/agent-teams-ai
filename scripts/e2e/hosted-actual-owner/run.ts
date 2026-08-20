import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHostedV1ForegroundSubprocess } from '../hosted-v1/foregroundSubprocess';
import {
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
  ACTUAL_OWNER_DESCRIPTOR_TOKENS,
  ACTUAL_OWNER_INHERITED_FDS,
  ACTUAL_OWNER_PURPOSE,
  actualOwnerTimelineAuthorityPayload,
  expandActualOwnerToken,
  parseActualOwnerCliOptions,
  parseActualOwnerIntegrationManifest,
  type ActualOwnerIntegrationManifest,
  type ActualOwnerProcessName,
  type ActualOwnerProcessTemplate,
  type ActualOwnerRuntimeManifest,
} from './contracts';
import {
  sealActualOwnerStageDirectories,
  stageActualOwnerExecutable,
  stageActualOwnerSourceFile,
} from './anchors';
import {
  copyPrivateCapture,
  assertAuthenticatedDecisionNonceIssuances,
  assertActualOwnerTimelineCaptureCurrent,
  createActualOwnerEvidenceDirectory,
  initialActualOwnerEvidence,
  readActualOwnerTimelineCapture,
  readJsonCapture,
  readNdjsonCapture,
  validateActualOwnerCompletionEvidence,
  writeActualOwnerEvidence,
  type ActualOwnerBrowserResults,
  type ActualOwnerCapabilityEvidence,
  type ActualOwnerDiskEvidence,
  type ActualOwnerEvidenceDocument,
  type ActualOwnerNegativeEvidence,
  type ActualOwnerPostLedgerEntry,
  type ActualOwnerProtectedEffectEntry,
  type ActualOwnerRestartEvidence,
} from './evidence';
import {
  assertCleanExactRepository,
  assertPrivateCanonicalManifest,
  runActualOwnerPreflight,
  assertTrackedSourceFile,
  type ActualOwnerPreflightEvidence,
} from './preflight';
import {
  ActualOwnerProcessCleanupUnprovedError,
  actualOwnerBootstrapFrame,
  assertActualOwnerManagedProcessIdentity,
  launchActualOwnerProcess,
  stopActualOwnerProcesses,
  type ActualOwnerManagedProcess,
} from './processes';
import {
  cleanupActualOwnerSandbox,
  createActualOwnerSandbox,
  initializeActualOwnerSandboxProject,
  isPathWithinActualOwnerSandbox,
  type ActualOwnerSandbox,
} from './sandbox';
import { atomicAnchoredPrivateFile, chmodAnchoredPrivateFile } from './secure-files';

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_048)
    : 'hosted_actual_owner_unknown_failure';
}

async function diskEvidence(path: string): Promise<ActualOwnerDiskEvidence> {
  const stats = await statfs(path, { bigint: true });
  const blockSize = stats.bsize;
  const asNumber = (value: bigint): number => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('hosted_actual_owner_disk_value_unsafe');
    return Number(value);
  };
  return Object.freeze({
    availableBytes: asNumber(stats.bavail * blockSize),
    freeBytes: asNumber(stats.bfree * blockSize),
    totalBytes: asNumber(stats.blocks * blockSize),
  });
}

function runtimeManifestFor(input: {
  readonly evidenceDirectory: string;
  readonly integration: ActualOwnerIntegrationManifest;
  readonly preflight: ActualOwnerPreflightEvidence;
  readonly sandbox: ActualOwnerSandbox;
  readonly openCodeExecutable: ActualOwnerPreflightEvidence['productExecutable'];
  readonly productContractAnchor: Awaited<ReturnType<typeof stageActualOwnerSourceFile>>;
  readonly ownerToken: string;
}): ActualOwnerRuntimeManifest {
  const browserRoot = join(input.sandbox.root, 'browser');
  const sandboxToken = ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot;
  const descriptor = asyncDescriptor;
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: input.sandbox.runId,
    sandboxRoot: sandboxToken,
    markerPath: `${sandboxToken}/${input.sandbox.markerPath.slice(input.sandbox.root.length + 1)}`,
    evidenceRoot: input.evidenceDirectory,
    driverBaseUrl: input.integration.driverBaseUrl,
    productBaseUrl: input.integration.productBaseUrl,
    approvalPath: input.integration.approvalPath,
    capabilityEndpoint: new URL('v1/capability', input.integration.driverBaseUrl).toString(),
    ownerWalTimelineRawPath: `${sandboxToken}/capture/owner-wal-timeline.ndjson`,
    ownerBinding: Object.freeze({
      ownerUid: process.getuid?.() ?? -1,
      ownerSessionId: `session_${input.sandbox.runId}`,
      ownerTokenSha256: createHash('sha256').update(input.ownerToken).digest('hex'),
    }),
    socketIdentity: Object.freeze({
      driverSocket: new URL(input.integration.driverBaseUrl).host,
      productSocket: new URL(input.integration.productBaseUrl).host,
    }),
    contract: Object.freeze({
      path: `${sandboxToken}/${input.productContractAnchor.path.slice(input.sandbox.root.length + 1)}`,
      sha256: input.productContractAnchor.stagedEvidence.sha256,
      byteCount: input.productContractAnchor.stagedEvidence.size,
      gitBlob: input.productContractAnchor.stagedEvidence.gitBlob,
      sourceCommit: input.productContractAnchor.stagedEvidence.sourceCommit,
      repositoryPath: ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
      device: input.productContractAnchor.stagedEvidence.device,
      inode: input.productContractAnchor.stagedEvidence.inode,
      mode: String(input.productContractAnchor.stagedEvidence.mode),
    }),
    descriptors: Object.freeze({
      sandboxRoot: descriptor(ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot, input.sandbox.root),
      productRoot: descriptor(
        ACTUAL_OWNER_DESCRIPTOR_TOKENS.productRoot,
        input.preflight.product.root
      ),
      orchestratorRoot: descriptor(
        ACTUAL_OWNER_DESCRIPTOR_TOKENS.orchestratorRoot,
        input.preflight.orchestrator.root
      ),
      openCodeExecutable: Object.freeze({
        ...descriptor(
          ACTUAL_OWNER_DESCRIPTOR_TOKENS.openCodeExecutable,
          input.openCodeExecutable.executable
        ),
        size: String(input.openCodeExecutable.size),
        sha256: input.openCodeExecutable.sha256,
      }),
    }),
    browser: Object.freeze({
      ownerStorageStatePath: `${sandboxToken}/${join(browserRoot, 'owner-storage-state.json').slice(input.sandbox.root.length + 1)}`,
      nonOwnerStorageStatePath: `${sandboxToken}/${join(browserRoot, 'non-owner-storage-state.json').slice(input.sandbox.root.length + 1)}`,
      tracePath: `${sandboxToken}/${join(browserRoot, 'browser-trace.zip').slice(input.sandbox.root.length + 1)}`,
      resultsPath: `${sandboxToken}/${join(input.sandbox.captureRoot, 'browser-results.json').slice(input.sandbox.root.length + 1)}`,
    }),
    capture: Object.freeze({
      browserResultsPath: `${sandboxToken}/${join(input.sandbox.captureRoot, 'browser-results.json').slice(input.sandbox.root.length + 1)}`,
      conditionalPostLedgerPath: `${sandboxToken}/capture/conditional-post-ledger.ndjson`,
      negativeResultsPath: `${sandboxToken}/capture/negative-results.json`,
      openCodeTimelinePath: `${sandboxToken}/capture/opencode-timeline.ndjson`,
      ownerWalTimelinePath: `${sandboxToken}/capture/owner-wal-timeline.ndjson`,
      productTimelinePath: `${sandboxToken}/capture/product-timeline.ndjson`,
      protectedEffectLedgerPath: `${sandboxToken}/capture/protected-effect-ledger.json`,
    }),
    refs: Object.freeze({
      openCode: input.preflight.artifact.sourceCommit,
      openCodeExecutableSha256: input.preflight.artifact.sha256,
      orchestrator: input.preflight.orchestrator.head,
      product: input.preflight.product.head,
    }),
  });
}

function asyncDescriptor(token: string, path: string) {
  const stat = requireDescriptorStat(path);
  return Object.freeze({
    token,
    path,
    device: stat.dev,
    inode: stat.inode,
    mode: stat.mode,
    uid: stat.uid,
  });
}

const descriptorStats = new Map<
  string,
  { dev: string; inode: string; mode: string; uid: string }
>();
function requireDescriptorStat(path: string) {
  const value = descriptorStats.get(path);
  if (!value) throw new Error('hosted_actual_owner_descriptor_stat_missing');
  return value;
}

async function registerDescriptor(path: string): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  descriptorStats.set(path, {
    dev: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: (stat.mode & 0o777n).toString(),
    uid: stat.uid.toString(),
  });
}

async function assertRuntimeDescriptorIdentities(
  manifest: ActualOwnerRuntimeManifest
): Promise<void> {
  for (const descriptor of Object.values(manifest.descriptors)) {
    const current = await lstat(descriptor.path, { bigint: true });
    if (
      (await realpath(descriptor.path)) !== descriptor.path ||
      current.dev.toString() !== descriptor.device ||
      current.ino.toString() !== descriptor.inode ||
      (current.mode & 0o777n).toString() !== descriptor.mode ||
      current.uid.toString() !== descriptor.uid
    ) {
      throw new Error('hosted_actual_owner_runtime_descriptor_rotated');
    }
  }
  const contractPath = `${manifest.descriptors.sandboxRoot.path}${manifest.contract.path.slice(
    manifest.descriptors.sandboxRoot.token.length
  )}`;
  const contractStat = await lstat(contractPath, { bigint: true });
  const contractBytes = await readFile(contractPath);
  if (
    contractStat.dev.toString() !== manifest.contract.device ||
    contractStat.ino.toString() !== manifest.contract.inode ||
    (contractStat.mode & 0o777n).toString() !== manifest.contract.mode ||
    contractStat.nlink !== 1n ||
    contractBytes.byteLength !== manifest.contract.byteCount ||
    createHash('sha256').update(contractBytes).digest('hex') !== manifest.contract.sha256
  ) {
    throw new Error('hosted_actual_owner_contract_bundle_rotated');
  }
}

function replacements(input: {
  readonly evidenceDirectory: string;
  readonly options: ReturnType<typeof parseActualOwnerCliOptions>;
  readonly runtimeManifestPath: string;
  readonly sandbox: ActualOwnerSandbox;
  readonly openCodeExecutable: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    [ACTUAL_OWNER_DESCRIPTOR_TOKENS.sandboxRoot]: input.sandbox.root,
    [ACTUAL_OWNER_DESCRIPTOR_TOKENS.productRoot]: input.options.productRoot,
    [ACTUAL_OWNER_DESCRIPTOR_TOKENS.orchestratorRoot]: input.options.orchestratorRoot,
    [ACTUAL_OWNER_DESCRIPTOR_TOKENS.openCodeExecutable]: input.openCodeExecutable,
  });
}

async function isolatedEnvironment(input: {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly sandbox: ActualOwnerSandbox;
  readonly runtimeManifestPath: string;
  readonly ownerToken: string;
  readonly template: ActualOwnerProcessTemplate;
  readonly tokens: Readonly<Record<string, string>>;
}): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: join(input.sandbox.root, 'home'),
    TMPDIR: join(input.sandbox.root, 'tmp'),
    XDG_CONFIG_HOME: join(input.sandbox.root, 'home', '.config'),
    XDG_CACHE_HOME: join(input.sandbox.root, 'home', '.cache'),
    XDG_DATA_HOME: join(input.sandbox.root, 'home', '.local', 'share'),
    HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST: input.runtimeManifestPath,
    HOSTED_ACTUAL_OWNER_E2E_MARKER: input.sandbox.markerPath,
    HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN: input.ownerToken,
  };
  for (const [key, value] of Object.entries(input.template.environment)) {
    const expanded = expandActualOwnerToken(value, input.tokens);
    const candidate = filesystemArgument(expanded, input.cwd);
    if (
      uriArgument(expanded) ||
      (candidate && !hasDescriptorToken(value)) ||
      (isAbsolute(expanded) && resolve(expanded) !== expanded) ||
      (candidate && !(await candidateWithinRoots(candidate, input.allowedRoots)))
    ) {
      throw new Error(`hosted_actual_owner_${key.toLowerCase()}_escaped_allowed_roots`);
    }
    environment[key] = expanded;
  }
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    const value = environment[key];
    if (!value || !isPathWithinActualOwnerSandbox(resolve(value), input.sandbox)) {
      throw new Error(`hosted_actual_owner_${key.toLowerCase()}_escaped_sandbox`);
    }
  }
  return environment;
}

function hasDescriptorToken(value: string): boolean {
  return Object.values(ACTUAL_OWNER_DESCRIPTOR_TOKENS).some(
    (token) => value === token || value.startsWith(`${token}/`) || value.includes(`=${token}`)
  );
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

export async function assertArgumentsWithinRoots(
  args: readonly string[],
  roots: readonly string[],
  name: ActualOwnerProcessName,
  cwd: string
): Promise<void> {
  for (const argument of args) {
    const candidate = filesystemArgument(argument, cwd);
    if (
      uriArgument(argument) ||
      (isAbsolute(argument) && resolve(argument) !== argument) ||
      (candidate && !(await candidateWithinRoots(candidate, roots)))
    ) {
      throw new Error(`hosted_actual_owner_${name}_argument_escaped_allowed_roots`);
    }
  }
}

export function uriArgument(value: string): boolean {
  const equals = value.indexOf('=');
  const candidate = equals > 0 && value.startsWith('-') ? value.slice(equals + 1) : value;
  return /^[a-z][a-z0-9+.-]*:/iu.test(candidate);
}

export function filesystemArgument(value: string, cwd: string): string | null {
  const equals = value.indexOf('=');
  const candidate = equals > 0 && value.startsWith('-') ? value.slice(equals + 1) : value;
  if (/^file:/iu.test(candidate)) {
    try {
      return fileURLToPath(candidate);
    } catch {
      throw new Error('hosted_actual_owner_file_url_invalid');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) return null;
  if (isAbsolute(candidate)) return resolve(candidate);
  if (candidate.startsWith('.') || candidate.includes('/')) return resolve(cwd, candidate);
  return null;
}

export async function candidateWithinRoots(
  candidate: string,
  roots: readonly string[]
): Promise<boolean> {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
  let existing = candidate;
  for (;;) {
    try {
      const canonical = await realpath(existing);
      const suffix = relative(existing, candidate);
      const resolvedCandidate = resolve(canonical, suffix);
      return roots.some((root) => isWithinOrEqual(root, resolvedCandidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let existing = path;
  for (;;) {
    try {
      return resolve(await realpath(existing), relative(existing, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export async function assertRootsDisjoint(paths: readonly string[]): Promise<void> {
  const canonical = await Promise.all(paths.map(canonicalProspectivePath));
  for (let left = 0; left < canonical.length; left += 1) {
    for (let right = left + 1; right < canonical.length; right += 1) {
      const a = canonical[left] as string;
      const b = canonical[right] as string;
      if (a === b || isWithinOrEqual(a, b) || isWithinOrEqual(b, a)) {
        throw new Error('hosted_actual_owner_roots_not_disjoint');
      }
    }
  }
}

async function waitForDriverCapability(input: {
  readonly baseUrl: string;
  readonly manifest: ActualOwnerRuntimeManifest;
  readonly ownerToken: string;
  readonly processes: readonly ActualOwnerManagedProcess[];
  readonly timeoutMs: number;
}): Promise<ActualOwnerCapabilityEvidence> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertRuntimeDescriptorIdentities(input.manifest);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(2_000, input.timeoutMs));
      if (
        input.manifest.capabilityEndpoint !== new URL('v1/capability', input.baseUrl).toString()
      ) {
        throw new Error('driver_capability_endpoint_identity_invalid');
      }
      const response = await fetch(input.manifest.capabilityEndpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${input.ownerToken}`,
          'x-actual-owner-session': input.manifest.ownerBinding.ownerSessionId,
        },
        redirect: 'manual',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (response.status !== 200) throw new Error(`driver_status_${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      const keys = Object.keys(body).sort().join(',');
      const markerPath =
        `${input.manifest.descriptors.sandboxRoot.path}` +
        input.manifest.markerPath.slice(input.manifest.descriptors.sandboxRoot.token.length);
      const contractPath =
        `${input.manifest.descriptors.sandboxRoot.path}` +
        input.manifest.contract.path.slice(input.manifest.descriptors.sandboxRoot.token.length);
      const expectedContract = { ...input.manifest.contract, path: contractPath };
      const socketIdentity = body.socketIdentity as Record<string, unknown>;
      const driverSocket = socketIdentity?.driverSocket as Record<string, unknown>;
      const productSocket = socketIdentity?.productSocket as Record<string, unknown>;
      const orchestrator = input.processes.find(({ evidence }) => evidence.name === 'orchestrator');
      const product = input.processes.find(({ evidence }) => evidence.name === 'product');
      if (!orchestrator || !product) {
        throw new Error('hosted_actual_owner_listener_process_set_incomplete');
      }
      const [driverSocketFromOs, productSocketFromOs] = await Promise.all([
        readLoopbackSocketIdentity(
          input.manifest.socketIdentity.driverSocket,
          input.manifest.ownerBinding.ownerSessionId,
          orchestrator.evidence.pid,
          input.processes.map(({ evidence }) => evidence.pid)
        ),
        readLoopbackSocketIdentity(
          input.manifest.socketIdentity.productSocket,
          input.manifest.ownerBinding.ownerSessionId,
          product.evidence.pid,
          input.processes.map(({ evidence }) => evidence.pid)
        ),
      ]);
      const expectedSocketKeys = 'device,endpoint,inode,ownerSessionId';
      const socketValid = (socket: Record<string, unknown>, endpoint: string) =>
        socket &&
        Object.keys(socket).sort().join(',') === expectedSocketKeys &&
        socket.endpoint === endpoint &&
        socket.ownerSessionId === input.manifest.ownerBinding.ownerSessionId &&
        typeof socket.device === 'string' &&
        /^\d+$/u.test(socket.device) &&
        typeof socket.inode === 'string' &&
        /^\d+$/u.test(socket.inode);
      if (
        keys !==
          'contract,markerPath,noFakeRuntime,ownerBinding,protocol,refs,schemaVersion,socketIdentity' ||
        body.schemaVersion !== 1 ||
        body.protocol !== ACTUAL_OWNER_DRIVER_PROTOCOL ||
        body.noFakeRuntime !== true ||
        body.markerPath !== markerPath ||
        JSON.stringify(body.contract) !== JSON.stringify(expectedContract) ||
        JSON.stringify(body.ownerBinding) !== JSON.stringify(input.manifest.ownerBinding) ||
        !socketValid(driverSocket, input.manifest.socketIdentity.driverSocket) ||
        !socketValid(productSocket, input.manifest.socketIdentity.productSocket) ||
        driverSocket.device !== driverSocketFromOs.device ||
        driverSocket.inode !== driverSocketFromOs.inode ||
        productSocket.device !== productSocketFromOs.device ||
        productSocket.inode !== productSocketFromOs.inode ||
        (driverSocket.device === productSocket.device &&
          driverSocket.inode === productSocket.inode) ||
        JSON.stringify(body.refs) !== JSON.stringify(input.manifest.refs)
      ) {
        throw new Error('driver_capability_invalid');
      }
      return Object.freeze({
        checkedAt: new Date().toISOString(),
        contractSha256: input.manifest.contract.sha256,
        driverSocket: Object.freeze(driverSocket) as ActualOwnerCapabilityEvidence['driverSocket'],
        markerPath,
        noFakeRuntime: true,
        ownerSessionId: input.manifest.ownerBinding.ownerSessionId,
        productSocket: Object.freeze(
          productSocket
        ) as ActualOwnerCapabilityEvidence['productSocket'],
        refsSha256: createHash('sha256').update(JSON.stringify(body.refs)).digest('hex'),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error('hosted_actual_owner_driver_readiness_timeout', { cause: lastError });
}

async function readLoopbackSocketIdentity(
  endpoint: string,
  ownerSessionId: string,
  expectedPid: number,
  expectedProcessPids: readonly number[]
): Promise<ActualOwnerCapabilityEvidence['driverSocket']> {
  const parsed = new URL(`http://${endpoint}`);
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('hosted_actual_owner_socket_endpoint_invalid');
  }
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const expectedAddress =
    parsed.hostname === '127.0.0.1'
      ? '0100007F'
      : parsed.hostname === '[::1]'
        ? '00000000000000000000000001000000'
        : null;
  if (!expectedAddress) throw new Error('hosted_actual_owner_socket_address_not_exact_loopback');
  const table = await readFile(
    parsed.hostname === '127.0.0.1' ? '/proc/net/tcp' : '/proc/net/tcp6',
    'utf8'
  );
  const inodes = new Set<string>();
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    const local = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (
      local === `${expectedAddress}:${portHex}` &&
      state === '0A' &&
      inode &&
      /^\d+$/u.test(inode)
    ) {
      inodes.add(inode);
    }
  }
  if (inodes.size !== 1) throw new Error('hosted_actual_owner_socket_identity_ambiguous');
  const inode = [...inodes][0]!;
  const socketLink = `socket:[${inode}]`;
  const fdSets = await Promise.all(
    expectedProcessPids.map(async (pid) => {
      const descriptors = await readdir(`/proc/${pid}/fd`);
      const matches: string[] = [];
      for (const descriptor of descriptors) {
        let target: string;
        try {
          target = await readlink(`/proc/${pid}/fd/${descriptor}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (target === socketLink) matches.push(descriptor);
      }
      return Object.freeze({ pid, matches: Object.freeze(matches) });
    })
  );
  const owner = fdSets.find(({ pid }) => pid === expectedPid);
  if (
    !owner ||
    owner.matches.length < 1 ||
    owner.matches.some((descriptor) => !/^\d+$/u.test(descriptor)) ||
    fdSets.some(({ pid, matches }) => pid !== expectedPid && matches.length !== 0)
  ) {
    throw new Error('hosted_actual_owner_socket_process_fd_binding_invalid');
  }
  const namespace = await stat('/proc/self/ns/net', { bigint: true });
  return Object.freeze({
    device: namespace.dev.toString(),
    endpoint,
    inode,
    ownerSessionId,
  });
}

async function launchProcesses(input: {
  readonly integration: ActualOwnerIntegrationManifest;
  readonly options: ReturnType<typeof parseActualOwnerCliOptions>;
  readonly preflight: ActualOwnerPreflightEvidence;
  readonly runtimeManifestPath: string;
  readonly sandbox: ActualOwnerSandbox;
  readonly evidenceDirectory: string;
  readonly processes: ActualOwnerManagedProcess[];
  readonly openCodeAnchor: Awaited<ReturnType<typeof stageActualOwnerExecutable>>;
  readonly productAnchor: Awaited<ReturnType<typeof stageActualOwnerExecutable>>;
  readonly orchestratorLauncherAnchor: Awaited<ReturnType<typeof stageActualOwnerSourceFile>>;
  readonly orchestratorAcceptanceAnchor: Awaited<ReturnType<typeof stageActualOwnerSourceFile>>;
  readonly productContractAnchor: Awaited<ReturnType<typeof stageActualOwnerSourceFile>>;
  readonly ownerToken: string;
}): Promise<readonly ActualOwnerManagedProcess[]> {
  const tokens = replacements({
    ...input,
    openCodeExecutable: input.openCodeAnchor.evidence.executable,
  });
  const definitions: readonly {
    readonly name: ActualOwnerProcessName;
    readonly command: string;
    readonly sourceRef: string;
    readonly template: ActualOwnerProcessTemplate;
    readonly extraArgs: readonly string[];
    readonly expectedExecutable?: ActualOwnerPreflightEvidence['productExecutable'];
    readonly anchors: readonly (
      | Awaited<ReturnType<typeof stageActualOwnerExecutable>>
      | Awaited<ReturnType<typeof stageActualOwnerSourceFile>>
    )[];
  }[] = [
    {
      name: 'opencode',
      command: input.openCodeAnchor.path,
      sourceRef: input.options.openCodeSourceRef,
      template: input.integration.processes.opencode,
      extraArgs: [],
      expectedExecutable: input.openCodeAnchor.evidence,
      anchors: [input.openCodeAnchor],
    },
    {
      name: 'orchestrator',
      command: input.orchestratorLauncherAnchor.path,
      sourceRef: input.options.orchestratorRef,
      template: input.integration.processes.orchestrator,
      extraArgs: [
        '--hosted-actual-owner-acceptance-entry',
        input.orchestratorAcceptanceAnchor.path,
        '--runtime-manifest',
        input.runtimeManifestPath,
        '--actual-owner-contract',
        input.productContractAnchor.path,
        '--actual-owner-contract-sha256',
        input.productContractAnchor.stagedEvidence.sha256,
        '--actual-owner-contract-byte-count',
        String(input.productContractAnchor.stagedEvidence.size),
        '--launcher-lease-fd',
        String(ACTUAL_OWNER_INHERITED_FDS.launcherLeaseFd),
        '--liveness-fd',
        String(ACTUAL_OWNER_INHERITED_FDS.livenessFd),
        '--bootstrap-fd',
        String(ACTUAL_OWNER_INHERITED_FDS.bootstrapFd),
      ],
      anchors: [
        input.orchestratorLauncherAnchor,
        input.orchestratorAcceptanceAnchor,
        input.productContractAnchor,
      ],
    },
    {
      name: 'product',
      command: input.productAnchor.path,
      sourceRef: input.options.productRef,
      template: input.integration.processes.product,
      extraArgs: [
        '--actual-owner-contract',
        input.productContractAnchor.path,
        '--actual-owner-contract-sha256',
        input.productContractAnchor.stagedEvidence.sha256,
        '--actual-owner-contract-byte-count',
        String(input.productContractAnchor.stagedEvidence.size),
      ],
      expectedExecutable: input.productAnchor.evidence,
      anchors: [input.productAnchor, input.productContractAnchor],
    },
  ];
  for (const definition of definitions) {
    const cwd = expandActualOwnerToken(definition.template.cwd, tokens);
    const allowedRoots =
      definition.name === 'opencode'
        ? [input.sandbox.root]
        : definition.name === 'orchestrator'
          ? [
              input.sandbox.root,
              input.options.orchestratorRoot,
              input.options.productRoot,
              input.openCodeAnchor.evidence.executable,
            ]
          : [input.sandbox.root, input.options.productRoot];
    if (
      (definition.name === 'product' && cwd !== input.options.productRoot) ||
      (definition.name === 'orchestrator' && cwd !== input.options.orchestratorRoot) ||
      (definition.name === 'opencode' && cwd !== input.sandbox.workspaceRoot)
    ) {
      throw new Error(`hosted_actual_owner_${definition.name}_cwd_invalid`);
    }
    const templateArgs = definition.template.args.map((value) => ({
      source: value,
      expanded: expandActualOwnerToken(value, tokens),
    }));
    if (
      templateArgs.some(
        ({ source, expanded }) => filesystemArgument(expanded, cwd) && !hasDescriptorToken(source)
      )
    ) {
      throw new Error(`hosted_actual_owner_${definition.name}_argument_not_descriptor_bound`);
    }
    const args = [...templateArgs.map(({ expanded }) => expanded), ...definition.extraArgs];
    await assertArgumentsWithinRoots(args, allowedRoots, definition.name, cwd);
    input.processes.push(
      await launchActualOwnerProcess({
        args,
        command: definition.command,
        cwd,
        environment: await isolatedEnvironment({
          allowedRoots,
          cwd,
          sandbox: input.sandbox,
          runtimeManifestPath: input.runtimeManifestPath,
          ownerToken: input.ownerToken,
          template: definition.template,
          tokens,
        }),
        logRoot: join(input.sandbox.root, 'logs'),
        name: definition.name,
        shutdownMs: input.integration.timeouts.shutdownMs,
        sourceRef: definition.sourceRef,
        expectedExecutable: definition.expectedExecutable,
        anchors: definition.anchors,
        inheritedFds:
          definition.name === 'orchestrator'
            ? {
                launcherLeaseFd: input.orchestratorLauncherAnchor.handle.fd,
                bootstrapFrame: actualOwnerBootstrapFrame({
                  contractSha256: input.productContractAnchor.stagedEvidence.sha256,
                  ownerSessionId: `session_${input.sandbox.runId}`,
                  ownerToken: input.ownerToken,
                  runId: input.sandbox.runId,
                }),
              }
            : undefined,
      })
    );
  }
  return Object.freeze([...input.processes]);
}

interface PlaywrightReleaseFile {
  readonly byteCount: number;
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
}

interface PlaywrightReleaseManifest {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.hosted-actual-owner-e2e.playwright-release/v1';
  readonly productRef: string;
  readonly node: Readonly<{
    readonly byteCount: number;
    readonly path: string;
    readonly release: string;
    readonly sha256: string;
  }>;
  readonly dependencyFiles: readonly PlaywrightReleaseFile[];
  readonly browserFiles: readonly PlaywrightReleaseFile[];
  readonly sourceFiles: readonly PlaywrightReleaseFile[];
}

interface PreparedBrowserClosure {
  readonly browsersPath: string;
  readonly cwd: string;
  readonly nodePath: string;
  readonly outputPath: string;
  readonly runnerPath: string;
  readonly testPath: string;
  readonly close: () => Promise<void>;
  readonly revalidate: () => Promise<void>;
}

export function assertActualOwnerBrowserExecutionBoundary(
  closure: Pick<
    PreparedBrowserClosure,
    'browsersPath' | 'cwd' | 'nodePath' | 'outputPath' | 'runnerPath' | 'testPath'
  >,
  parentPid = process.pid
): void {
  const fdRoot = `/proc/${parentPid}/fd/`;
  const descriptorPath = (value: string) =>
    value.startsWith(fdRoot) && /^\d+$/u.test(value.slice(fdRoot.length));
  if (
    !descriptorPath(closure.cwd) ||
    !descriptorPath(closure.nodePath) ||
    !descriptorPath(closure.outputPath) ||
    closure.browsersPath !== `${closure.cwd}/browsers` ||
    closure.runnerPath !== `${closure.cwd}/node_modules/@playwright/test/cli.js` ||
    closure.testPath !== `${closure.cwd}/${PLAYWRIGHT_TEST_SOURCE}`
  ) {
    throw new Error('hosted_actual_owner_playwright_execution_boundary_invalid');
  }
}

const PLAYWRIGHT_DEPENDENCY_ROOTS = Object.freeze([
  '@playwright/test',
  'playwright',
  'playwright-core',
] as const);

function exactObjectKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`hosted_actual_owner_${label}_keys_invalid`);
  }
}

function parsePlaywrightReleaseFile(value: unknown, label: string): PlaywrightReleaseFile {
  exactObjectKeys(value, ['byteCount', 'mode', 'path', 'sha256'], label);
  if (
    typeof value.path !== 'string' ||
    value.path.length < 1 ||
    value.path.length > 4_096 ||
    isAbsolute(value.path) ||
    resolve('/', value.path) !== `/${value.path}` ||
    value.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    !Number.isSafeInteger(value.byteCount) ||
    (value.byteCount as number) < 0 ||
    (value.byteCount as number) > 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(value.mode) ||
    ![0o400, 0o500].includes(value.mode as number) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  return Object.freeze(value as unknown as PlaywrightReleaseFile);
}

function parsePlaywrightReleaseManifest(
  value: unknown,
  productRef: string
): PlaywrightReleaseManifest {
  exactObjectKeys(
    value,
    [
      'schemaVersion',
      'purpose',
      'productRef',
      'node',
      'dependencyFiles',
      'browserFiles',
      'sourceFiles',
    ],
    'playwright_release_manifest'
  );
  exactObjectKeys(value.node, ['byteCount', 'path', 'release', 'sha256'], 'playwright_node');
  if (
    value.schemaVersion !== 1 ||
    value.purpose !== 'agent-teams.hosted-actual-owner-e2e.playwright-release/v1' ||
    value.productRef !== productRef ||
    typeof value.node.path !== 'string' ||
    !isAbsolute(value.node.path) ||
    resolve(value.node.path) !== value.node.path ||
    typeof value.node.release !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value.node.release) ||
    typeof value.node.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.node.sha256) ||
    !Number.isSafeInteger(value.node.byteCount) ||
    (value.node.byteCount as number) < 1 ||
    (value.node.byteCount as number) > 1024 * 1024 * 1024 ||
    !Array.isArray(value.dependencyFiles) ||
    !Array.isArray(value.browserFiles) ||
    !Array.isArray(value.sourceFiles) ||
    value.dependencyFiles.length < 1 ||
    value.browserFiles.length < 1 ||
    value.sourceFiles.length < 1
  ) {
    throw new Error('hosted_actual_owner_playwright_release_manifest_invalid');
  }
  const dependencyFiles = value.dependencyFiles.map((item, index) =>
    parsePlaywrightReleaseFile(item, `playwright_dependency_${index}`)
  );
  const browserFiles = value.browserFiles.map((item, index) =>
    parsePlaywrightReleaseFile(item, `playwright_browser_${index}`)
  );
  const sourceFiles = value.sourceFiles.map((item, index) =>
    parsePlaywrightReleaseFile(item, `playwright_source_${index}`)
  );
  for (const [label, files] of [
    ['dependency', dependencyFiles],
    ['browser', browserFiles],
    ['source', sourceFiles],
  ] as const) {
    const paths = files.map(({ path }) => path);
    if (new Set(paths).size !== paths.length || paths.join('\n') !== [...paths].sort().join('\n')) {
      throw new Error(`hosted_actual_owner_playwright_${label}_manifest_order_invalid`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e.playwright-release/v1',
    productRef,
    node: Object.freeze({
      byteCount: value.node.byteCount as number,
      path: value.node.path as string,
      release: value.node.release as string,
      sha256: value.node.sha256 as string,
    }),
    dependencyFiles: Object.freeze(dependencyFiles),
    browserFiles: Object.freeze(browserFiles),
    sourceFiles: Object.freeze(sourceFiles),
  });
}

const PLAYWRIGHT_TEST_SOURCE = 'test/e2e/hosted-web/actual-owner-approval.spec.ts';

function relativeTypeScriptImports(source: string): readonly string[] {
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*([^\n)]+)\s*\)/gu)) {
    const argument = match[1]?.trim();
    const literal = argument?.match(/^(['"])([^'"\n]+)\1$/u)?.[2];
    if (!literal?.startsWith('node:')) {
      throw new Error('hosted_actual_owner_playwright_dynamic_module_load_forbidden');
    }
  }
  const imports: string[] = [];
  const patterns = [/\bfrom\s*(['"])([^'"\n]+)\1/gu, /\bimport\s*(['"])([^'"\n]+)\1/gu];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier?.startsWith('.')) imports.push(specifier);
    }
  }
  return Object.freeze(imports);
}

export function resolveActualOwnerPlaywrightSourceClosure(
  sources: ReadonlyMap<string, string>,
  entryPath = PLAYWRIGHT_TEST_SOURCE
): readonly string[] {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    const source = sources.get(path);
    if (source === undefined) {
      throw new Error('hosted_actual_owner_playwright_source_closure_incomplete');
    }
    visited.add(path);
    for (const specifier of relativeTypeScriptImports(source)) {
      const base = resolve('/', dirname(path), specifier);
      const candidates = /\.[cm]?[jt]sx?$/u.test(base)
        ? [base.slice(1)]
        : [`${base.slice(1)}.ts`, `${base.slice(1)}.tsx`, `${base.slice(1)}/index.ts`];
      const resolvedImport = candidates.find((candidate) => sources.has(candidate));
      if (!resolvedImport) {
        throw new Error('hosted_actual_owner_playwright_source_import_unbound');
      }
      pending.push(resolvedImport);
    }
  }
  const closure = [...visited].sort();
  if (closure.length !== sources.size || closure.some((path) => !sources.has(path))) {
    throw new Error('hosted_actual_owner_playwright_source_manifest_not_exact_closure');
  }
  return Object.freeze(closure);
}

async function digestHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const stat = await handle.stat();
  const buffer = Buffer.alloc(Math.min(Math.max(stat.size, 1), 1024 * 1024));
  let offset = 0;
  while (offset < stat.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - offset),
      offset
    );
    if (bytesRead === 0) throw new Error('hosted_actual_owner_playwright_closure_short_read');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

async function openPinnedFileBeneath(root: FileHandle, relativePath: string): Promise<FileHandle> {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('hosted_actual_owner_playwright_path_not_beneath');
  }
  let directory: FileHandle | null = null;
  let currentFd = root.fd;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${currentFd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
      );
      const nextStat = await next.stat({ bigint: true });
      if (!nextStat.isDirectory()) {
        await next.close();
        throw new Error('hosted_actual_owner_playwright_path_ancestor_invalid');
      }
      if (directory) await directory.close();
      directory = next;
      currentFd = next.fd;
    }
    return await open(
      `/proc/self/fd/${currentFd}/${parts.at(-1)}`,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
  } finally {
    if (directory) await directory.close();
  }
}

async function openPinnedDirectoryBeneath(
  root: FileHandle,
  relativePath: string
): Promise<FileHandle> {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('hosted_actual_owner_playwright_directory_not_beneath');
  }
  let directory: FileHandle | null = null;
  let currentFd = root.fd;
  try {
    for (const part of parts) {
      const next = await open(
        `/proc/self/fd/${currentFd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
      );
      const nextStat = await next.stat({ bigint: true });
      if (!nextStat.isDirectory()) {
        await next.close();
        throw new Error('hosted_actual_owner_playwright_directory_ancestor_invalid');
      }
      if (directory) await directory.close();
      directory = next;
      currentFd = next.fd;
    }
    if (!directory) throw new Error('hosted_actual_owner_playwright_directory_empty_path');
    const result = directory;
    directory = null;
    return result;
  } finally {
    if (directory) await directory.close();
  }
}

async function enumeratePinnedFiles(root: FileHandle, prefix = ''): Promise<readonly string[]> {
  const path = prefix ? `/proc/self/fd/${root.fd}/${prefix}` : `/proc/self/fd/${root.fd}`;
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error('hosted_actual_owner_playwright_closure_symlink_forbidden');
    }
    if (entry.isDirectory()) files.push(...(await enumeratePinnedFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error('hosted_actual_owner_playwright_closure_special_file_forbidden');
  }
  return Object.freeze(files);
}

async function sealClosureDirectories(
  root: string,
  files: readonly PlaywrightReleaseFile[],
  handles: FileHandle[]
) {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let parent = dirname(join(root, file.path));
    while (parent !== root) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o500);
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
    );
    const directoryStat = await handle.stat({ bigint: true });
    if (!directoryStat.isDirectory() || Number(directoryStat.mode & 0o777n) !== 0o500) {
      await handle.close();
      throw new Error('hosted_actual_owner_playwright_staged_directory_invalid');
    }
    handles.push(handle);
  }
}

async function copyVerifiedClosureTree(input: {
  readonly files: readonly PlaywrightReleaseFile[];
  readonly sourceRoot: FileHandle;
  readonly stageRoot: string;
  readonly handles: FileHandle[];
}): Promise<void> {
  const enumerated = await enumeratePinnedFiles(input.sourceRoot);
  const expected = input.files.map(({ path }) => path);
  if (enumerated.join('\n') !== expected.join('\n')) {
    throw new Error('hosted_actual_owner_playwright_manifest_closure_incomplete');
  }
  for (const entry of input.files) {
    const source = await openPinnedFileBeneath(input.sourceRoot, entry.path);
    try {
      const before = await source.stat({ bigint: true });
      const sourceMode = Number(before.mode & 0o777n);
      if (
        !before.isFile() ||
        before.nlink < 1n ||
        before.size !== BigInt(entry.byteCount) ||
        (sourceMode & 0o022) !== 0 ||
        ((sourceMode & 0o111) !== 0 ? 0o500 : 0o400) !== entry.mode ||
        (await digestHandle(source)) !== entry.sha256
      ) {
        throw new Error('hosted_actual_owner_playwright_manifest_file_mismatch');
      }
      const targetPath = join(input.stageRoot, entry.path);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const target = await open(
        targetPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        entry.mode
      );
      let targetClosed = false;
      try {
        const bytes = await source.readFile();
        const after = await source.stat({ bigint: true });
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mode !== before.mode ||
          after.nlink !== before.nlink ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs ||
          bytes.byteLength !== entry.byteCount ||
          createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        ) {
          throw new Error('hosted_actual_owner_playwright_source_rotated');
        }
        await target.writeFile(bytes);
        await target.sync();
        await target.chmod(entry.mode);
        const written = await target.stat({ bigint: true });
        if (
          !written.isFile() ||
          written.nlink !== 1n ||
          written.size !== BigInt(entry.byteCount) ||
          Number(written.mode & 0o777n) !== entry.mode ||
          (await digestHandle(target)) !== entry.sha256
        ) {
          throw new Error('hosted_actual_owner_playwright_staged_file_invalid');
        }
        await target.close();
        targetClosed = true;
        const readonlyTarget = await open(
          targetPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        const reopened = await readonlyTarget.stat({ bigint: true });
        if (
          reopened.dev !== written.dev ||
          reopened.ino !== written.ino ||
          reopened.mode !== written.mode ||
          reopened.nlink !== written.nlink ||
          reopened.size !== written.size ||
          reopened.mtimeNs !== written.mtimeNs ||
          reopened.ctimeNs !== written.ctimeNs ||
          (await digestHandle(readonlyTarget)) !== entry.sha256
        ) {
          await readonlyTarget.close();
          throw new Error('hosted_actual_owner_playwright_readonly_reopen_invalid');
        }
        input.handles.push(readonlyTarget);
      } finally {
        if (!targetClosed) await target.close();
      }
    } finally {
      await source.close();
    }
  }
  if ((await enumeratePinnedFiles(input.sourceRoot)).join('\n') !== expected.join('\n')) {
    throw new Error('hosted_actual_owner_playwright_source_closure_rotated');
  }
  await sealClosureDirectories(input.stageRoot, input.files, input.handles);
}

async function prepareBrowserClosure(input: {
  readonly options: ReturnType<typeof parseActualOwnerCliOptions>;
  readonly preflight: ActualOwnerPreflightEvidence;
  readonly sandbox: ActualOwnerSandbox;
}): Promise<PreparedBrowserClosure> {
  const manifest = parsePlaywrightReleaseManifest(
    input.preflight.playwrightReleaseManifest.value,
    input.options.productRef
  );
  const configuredBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!configuredBrowsersPath || !isAbsolute(configuredBrowsersPath)) {
    throw new Error('hosted_actual_owner_playwright_browsers_path_required');
  }
  const productRoot = await open(
    input.options.productRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
  );
  const sandboxRoot = await open(
    input.sandbox.root,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
  );
  const handles: FileHandle[] = [productRoot, sandboxRoot];
  try {
    const dependencyRoot = await openPinnedDirectoryBeneath(productRoot, 'node_modules');
    handles.push(dependencyRoot);
    const canonicalDependencyRoot = await realpath(`/proc/self/fd/${dependencyRoot.fd}`);
    const browsersPath = await realpath(configuredBrowsersPath);
    if (browsersPath !== configuredBrowsersPath) {
      throw new Error('hosted_actual_owner_playwright_browsers_path_not_canonical');
    }
    const browserRelation = relative(canonicalDependencyRoot, browsersPath);
    if (
      browserRelation === '' ||
      browserRelation === '..' ||
      browserRelation.startsWith(`..${sep}`) ||
      isAbsolute(browserRelation)
    ) {
      throw new Error('hosted_actual_owner_playwright_browsers_outside_dependency_root');
    }
    const dependencyPackageRoots = await Promise.all(
      PLAYWRIGHT_DEPENDENCY_ROOTS.map(async (packagePath) => {
        const canonicalPackagePath = await realpath(
          `/proc/self/fd/${dependencyRoot.fd}/${packagePath}`
        );
        const packageRelation = relative(canonicalDependencyRoot, canonicalPackagePath);
        if (
          packageRelation === '' ||
          packageRelation === '..' ||
          packageRelation.startsWith(`..${sep}`) ||
          isAbsolute(packageRelation)
        ) {
          throw new Error('hosted_actual_owner_playwright_package_outside_dependency_root');
        }
        const handle = await openPinnedDirectoryBeneath(
          dependencyRoot,
          packageRelation.split(sep).join('/')
        );
        handles.push(handle);
        return Object.freeze({ handle, packagePath });
      })
    );
    const browsersRoot = await openPinnedDirectoryBeneath(
      dependencyRoot,
      browserRelation.split(sep).join('/')
    );
    handles.push(browsersRoot);
    if ((await realpath(`/proc/self/fd/${browsersRoot.fd}`)) !== browsersPath) {
      throw new Error('hosted_actual_owner_playwright_browsers_root_rotated');
    }
    if (
      (await realpath(manifest.node.path)) !== manifest.node.path ||
      (await realpath(process.execPath)) !== manifest.node.path ||
      manifest.node.release !== process.version
    ) {
      throw new Error('hosted_actual_owner_playwright_node_not_canonical');
    }
    const nodeSource = await open(
      manifest.node.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    handles.push(nodeSource);
    const nodeStat = await nodeSource.stat({ bigint: true });
    if (
      !nodeStat.isFile() ||
      nodeStat.nlink !== 1n ||
      (nodeStat.mode & 0o111n) === 0n ||
      (nodeStat.mode & 0o022n) !== 0n ||
      nodeStat.size !== BigInt(manifest.node.byteCount) ||
      (await digestHandle(nodeSource)) !== manifest.node.sha256
    ) {
      throw new Error('hosted_actual_owner_playwright_node_manifest_mismatch');
    }
    const sourceBytes = new Map<string, Buffer>();
    for (const entry of manifest.sourceFiles) {
      if (entry.mode !== 0o400 || !/\.(?:ts|tsx)$/u.test(entry.path)) {
        throw new Error('hosted_actual_owner_playwright_source_manifest_scope_invalid');
      }
      const evidence = await assertTrackedSourceFile(
        input.options.productRoot,
        join(input.options.productRoot, entry.path),
        `playwright_source_${entry.path.replace(/[^A-Za-z0-9]/gu, '_')}`,
        false,
        input.options.productRef
      );
      if (evidence.size !== entry.byteCount || evidence.sha256 !== entry.sha256) {
        throw new Error('hosted_actual_owner_playwright_source_manifest_file_mismatch');
      }
      const handle = await openPinnedFileBeneath(productRoot, entry.path);
      handles.push(handle);
      const before = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink < 1n ||
        Number(before.mode & 0o777n) & 0o022 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mode !== before.mode ||
        after.nlink !== before.nlink ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        bytes.byteLength !== entry.byteCount ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256
      ) {
        throw new Error('hosted_actual_owner_playwright_source_rotated');
      }
      sourceBytes.set(entry.path, bytes);
    }
    const sourceText = new Map(
      [...sourceBytes].map(([path, bytes]) => {
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) {
          throw new Error('hosted_actual_owner_playwright_source_encoding_invalid');
        }
        return [path, text] as const;
      })
    );
    resolveActualOwnerPlaywrightSourceClosure(sourceText);
    const stageRoot = join(input.sandbox.runtimeRoot, 'playwright-release-closure');
    const stagedDependencies = join(stageRoot, 'node_modules');
    const stagedBrowsers = join(stageRoot, 'browsers');
    await Promise.all([
      mkdir(stagedDependencies, { recursive: true, mode: 0o700 }),
      mkdir(stagedBrowsers, { recursive: true, mode: 0o700 }),
    ]);
    for (const { handle, packagePath } of dependencyPackageRoots) {
      const prefix = `${packagePath}/`;
      const packageFiles = manifest.dependencyFiles
        .filter(({ path }) => path.startsWith(prefix))
        .map((entry) => Object.freeze({ ...entry, path: entry.path.slice(prefix.length) }));
      if (packageFiles.length < 1) {
        throw new Error('hosted_actual_owner_playwright_package_manifest_missing');
      }
      await copyVerifiedClosureTree({
        files: packageFiles,
        sourceRoot: handle,
        stageRoot: join(stagedDependencies, packagePath),
        handles,
      });
    }
    if (
      manifest.dependencyFiles.some(
        ({ path }) =>
          !PLAYWRIGHT_DEPENDENCY_ROOTS.some((packagePath) => path.startsWith(`${packagePath}/`))
      )
    ) {
      throw new Error('hosted_actual_owner_playwright_dependency_scope_invalid');
    }
    await copyVerifiedClosureTree({
      files: manifest.browserFiles,
      sourceRoot: browsersRoot,
      stageRoot: stagedBrowsers,
      handles,
    });
    const nodeBytes = await nodeSource.readFile();
    if (createHash('sha256').update(nodeBytes).digest('hex') !== manifest.node.sha256) {
      throw new Error('hosted_actual_owner_playwright_gate_source_rotated');
    }
    const stageStandalone = async (path: string, bytes: Buffer, mode: number) => {
      const writable = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        mode
      );
      try {
        await writable.writeFile(bytes);
        await writable.sync();
        await writable.chmod(mode);
      } finally {
        await writable.close();
      }
      const readonly = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const fileStat = await readonly.stat({ bigint: true });
      if (
        !fileStat.isFile() ||
        fileStat.nlink !== 1n ||
        Number(fileStat.mode & 0o777n) !== mode ||
        fileStat.size !== BigInt(bytes.byteLength) ||
        (await digestHandle(readonly)) !== createHash('sha256').update(bytes).digest('hex')
      ) {
        await readonly.close();
        throw new Error('hosted_actual_owner_playwright_standalone_stage_invalid');
      }
      handles.push(readonly);
      return readonly;
    };
    const nodeHandle = await stageStandalone(join(stageRoot, 'node'), nodeBytes, 0o500);
    for (const entry of manifest.sourceFiles) {
      const bytes = sourceBytes.get(entry.path);
      if (!bytes) throw new Error('hosted_actual_owner_playwright_source_stage_missing');
      const stagedPath = join(stageRoot, entry.path);
      await mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 });
      await stageStandalone(stagedPath, bytes, entry.mode);
    }
    const joiningDirectories = new Set<string>([
      join(stagedDependencies, '@playwright'),
      stagedDependencies,
    ]);
    for (const entry of manifest.sourceFiles) {
      let directory = dirname(join(stageRoot, entry.path));
      while (directory !== stageRoot) {
        joiningDirectories.add(directory);
        directory = dirname(directory);
      }
    }
    for (const directory of [...joiningDirectories].sort(
      (left, right) => right.length - left.length
    )) {
      await chmod(directory, 0o500);
      const directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
      );
      handles.push(directoryHandle);
    }
    await chmod(stageRoot, 0o500);
    await mkdir(join(input.sandbox.root, 'browser', 'playwright-output'), { mode: 0o700 });
    const outputHandle = await openPinnedDirectoryBeneath(sandboxRoot, 'browser/playwright-output');
    handles.push(outputHandle);
    const closureRoot = await openPinnedDirectoryBeneath(
      sandboxRoot,
      'runtime/playwright-release-closure'
    );
    handles.push(closureRoot);
    const [outputStat, closureStat] = await Promise.all([
      outputHandle.stat({ bigint: true }),
      closureRoot.stat({ bigint: true }),
    ]);
    if (
      !outputStat.isDirectory() ||
      Number(outputStat.mode & 0o777n) !== 0o700 ||
      outputStat.uid !== BigInt(process.getuid?.() ?? -1) ||
      !closureStat.isDirectory() ||
      Number(closureStat.mode & 0o777n) !== 0o500 ||
      closureStat.uid !== BigInt(process.getuid?.() ?? -1)
    ) {
      throw new Error('hosted_actual_owner_playwright_pinned_directory_invalid');
    }
    const snapshots = await Promise.all(
      handles.map(async (handle) => ({ stat: await handle.stat({ bigint: true }) }))
    );
    const parentProc = `/proc/${process.pid}/fd`;
    const close = async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    };
    const revalidate = async () => {
      for (const [index, handle] of handles.entries()) {
        const before = snapshots[index]?.stat;
        const after = await handle.stat({ bigint: true });
        if (
          !before ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mode !== before.mode ||
          after.nlink !== before.nlink ||
          after.uid !== before.uid ||
          after.gid !== before.gid ||
          (handle !== outputHandle && after.size !== before.size) ||
          (handle !== outputHandle &&
            (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs))
        ) {
          throw new Error('hosted_actual_owner_playwright_closure_rotated');
        }
      }
      for (const { handle, packagePath } of dependencyPackageRoots) {
        const prefix = `${packagePath}/`;
        const expected = manifest.dependencyFiles
          .filter(({ path }) => path.startsWith(prefix))
          .map(({ path }) => path.slice(prefix.length));
        if ((await enumeratePinnedFiles(handle)).join('\n') !== expected.join('\n')) {
          throw new Error('hosted_actual_owner_playwright_source_closure_rotated');
        }
      }
      if (
        (await enumeratePinnedFiles(browsersRoot)).join('\n') !==
        manifest.browserFiles.map(({ path }) => path).join('\n')
      ) {
        throw new Error('hosted_actual_owner_playwright_source_closure_rotated');
      }
    };
    await revalidate();
    return Object.freeze({
      browsersPath: `${parentProc}/${closureRoot.fd}/browsers`,
      cwd: `${parentProc}/${closureRoot.fd}`,
      nodePath: `${parentProc}/${nodeHandle.fd}`,
      outputPath: `${parentProc}/${outputHandle.fd}`,
      runnerPath: `${parentProc}/${closureRoot.fd}/node_modules/@playwright/test/cli.js`,
      testPath: `${parentProc}/${closureRoot.fd}/${PLAYWRIGHT_TEST_SOURCE}`,
      close,
      revalidate,
    });
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    throw error;
  }
}

async function runBrowser(input: {
  readonly closure: PreparedBrowserClosure;
  readonly integration: ActualOwnerIntegrationManifest;
  readonly runtimeManifestPath: string;
  readonly sandbox: ActualOwnerSandbox;
  readonly ownerToken: string;
}): Promise<void> {
  try {
    assertActualOwnerBrowserExecutionBoundary(input.closure);
    await input.closure.revalidate();
    await runHostedV1ForegroundSubprocess({
      command: input.closure.nodePath,
      args: [
        input.closure.runnerPath,
        'test',
        input.closure.testPath,
        '--workers=1',
        '--retries=0',
        `--timeout=${input.integration.timeouts.browserMs}`,
        `--output=${input.closure.outputPath}`,
      ],
      cwd: input.closure.cwd,
      environment: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HOME: join(input.sandbox.root, 'home'),
        TMPDIR: join(input.sandbox.root, 'tmp'),
        HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST: input.runtimeManifestPath,
        HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN: input.ownerToken,
        PLAYWRIGHT_BROWSERS_PATH: input.closure.browsersPath,
      },
      timeoutMs: input.integration.timeouts.browserMs + 30_000,
    });
    await input.closure.revalidate();
  } catch (error) {
    if (
      error instanceof AggregateError &&
      error.message === 'hosted_e2e_foreground_subprocess_cleanup_failed'
    ) {
      throw new ActualOwnerProcessCleanupUnprovedError(
        'hosted_actual_owner_browser_cleanup_unproved',
        error
      );
    }
    throw error;
  }
}

async function collectEvidence(input: {
  readonly base: ActualOwnerEvidenceDocument;
  readonly evidenceDirectory: string;
  readonly manifest: ActualOwnerRuntimeManifest;
  readonly ownerToken: string;
}): Promise<ActualOwnerEvidenceDocument> {
  const capturePath = (value: string) => {
    const descriptor = input.manifest.descriptors.sandboxRoot;
    if (value !== descriptor.token && !value.startsWith(`${descriptor.token}/`)) {
      throw new Error('hosted_actual_owner_capture_descriptor_binding_invalid');
    }
    return `${descriptor.path}${value.slice(descriptor.token.length)}`;
  };
  const [
    browser,
    ownerWalCapture,
    productCapture,
    openCodeCapture,
    postLedger,
    effects,
    negativeBundle,
  ] = await Promise.all([
    readJsonCapture<ActualOwnerBrowserResults>(capturePath(input.manifest.browser.resultsPath)),
    readActualOwnerTimelineCapture(capturePath(input.manifest.capture.ownerWalTimelinePath)),
    readActualOwnerTimelineCapture(capturePath(input.manifest.capture.productTimelinePath)),
    readActualOwnerTimelineCapture(capturePath(input.manifest.capture.openCodeTimelinePath)),
    readNdjsonCapture<ActualOwnerPostLedgerEntry>(
      capturePath(input.manifest.capture.conditionalPostLedgerPath)
    ),
    readJsonCapture<readonly ActualOwnerProtectedEffectEntry[]>(
      capturePath(input.manifest.capture.protectedEffectLedgerPath)
    ),
    readJsonCapture<{
      readonly negatives: readonly ActualOwnerNegativeEvidence[];
      readonly restartMatrix: readonly ActualOwnerRestartEvidence[];
    }>(capturePath(input.manifest.capture.negativeResultsPath)),
  ]);
  const tracePath = join(input.evidenceDirectory, 'browser-trace.zip');
  assertAuthenticatedDecisionNonceIssuances({
    browser,
    ownerToken: input.ownerToken,
    postLedger,
    runId: input.manifest.runId,
  });
  const authority = browser.ownerWalAuthority;
  const unsignedAuthority = {
    authority: authority.authority,
    byteCount: authority.byteCount,
    ctimeNs: authority.ctimeNs,
    device: authority.device,
    inode: authority.inode,
    mtimeNs: authority.mtimeNs,
    ownerSessionId: authority.ownerSessionId,
    sha256: authority.sha256,
    size: authority.size,
  };
  const authoritySignature = createHmac('sha256', input.ownerToken)
    .update(actualOwnerTimelineAuthorityPayload(unsignedAuthority))
    .digest('hex');
  if (
    authority.authority !== 'product-owner-wal' ||
    authority.ownerSessionId !== input.manifest.ownerBinding.ownerSessionId ||
    authority.byteCount !== ownerWalCapture.evidence.byteCount ||
    authority.size !== ownerWalCapture.evidence.byteCount ||
    authority.sha256 !== ownerWalCapture.evidence.sha256 ||
    authority.device !== ownerWalCapture.evidence.device ||
    authority.inode !== ownerWalCapture.evidence.inode ||
    authority.mtimeNs !== ownerWalCapture.evidence.mtimeNs ||
    authority.ctimeNs !== ownerWalCapture.evidence.ctimeNs ||
    authority.signature !== authoritySignature
  ) {
    throw new Error('hosted_actual_owner_owner_wal_raw_authority_invalid');
  }
  await copyPrivateCapture(capturePath(input.manifest.browser.tracePath), tracePath);
  return Object.freeze({
    ...input.base,
    timelines: Object.freeze({
      ownerWal: ownerWalCapture.events,
      product: productCapture.events,
      openCode: openCodeCapture.events,
    }),
    timelineCaptures: Object.freeze({
      ownerWal: ownerWalCapture.evidence,
      product: productCapture.evidence,
      openCode: openCodeCapture.evidence,
    }),
    postLedger,
    protectedEffectLedger: effects,
    browserTracePath: tracePath,
    browser,
    restartMatrix: negativeBundle.restartMatrix,
    negatives: negativeBundle.negatives,
  });
}

async function runActualOwnerMain(args: readonly string[]): Promise<string> {
  const options = parseActualOwnerCliOptions(args);
  const integration = parseActualOwnerIntegrationManifest(
    await assertPrivateCanonicalManifest(options.integrationManifest)
  );
  if (integration.processes.product.productRef !== options.productRef) {
    throw new Error('hosted_actual_owner_product_manifest_ref_mismatch');
  }
  const preflight = await runActualOwnerPreflight(options, {
    executable: integration.processes.product.executable as string,
    expectedSha256: integration.processes.product.executableSha256 as string,
  });
  await assertRootsDisjoint([
    options.productRoot,
    options.orchestratorRoot,
    options.sandboxParent,
    options.evidenceRoot,
  ]);
  const diskBefore = await diskEvidence(options.sandboxParent);
  const sandbox = await createActualOwnerSandbox(options.sandboxParent);
  const ownerToken = randomBytes(32).toString('hex');
  let evidenceDirectory: string | null = null;
  let evidence = initialActualOwnerEvidence({ diskBefore, runId: sandbox.runId });
  const processes: ActualOwnerManagedProcess[] = [];
  const stagedHandles: Array<{ close: () => Promise<void> }> = [];
  let runnerError: unknown = null;
  let processCleanupProved = true;
  try {
    await initializeActualOwnerSandboxProject(sandbox);
    const openCodeAnchor = await stageActualOwnerExecutable({
      label: 'opencode',
      source: preflight.artifact,
      stageRoot: sandbox.runtimeRoot,
    });
    stagedHandles.push(openCodeAnchor.handle);
    const productAnchor = await stageActualOwnerExecutable({
      label: 'product',
      source: preflight.productExecutable,
      stageRoot: sandbox.runtimeRoot,
    });
    stagedHandles.push(productAnchor.handle);
    const orchestratorLauncherAnchor = await stageActualOwnerSourceFile({
      executable: true,
      label: 'orchestrator-launcher',
      source: preflight.orchestratorLauncherSource,
      stageRoot: sandbox.runtimeRoot,
    });
    stagedHandles.push(orchestratorLauncherAnchor.handle);
    const orchestratorAcceptanceAnchor = await stageActualOwnerSourceFile({
      executable: false,
      label: 'orchestrator-entry',
      source: preflight.orchestratorAcceptanceSource,
      stageRoot: sandbox.runtimeRoot,
    });
    stagedHandles.push(orchestratorAcceptanceAnchor.handle);
    const productContractAnchor = await stageActualOwnerSourceFile({
      executable: false,
      label: 'product-contract',
      source: preflight.productContractSource,
      stageRoot: sandbox.runtimeRoot,
    });
    stagedHandles.push(productContractAnchor.handle);
    stagedHandles.push(...(await sealActualOwnerStageDirectories(sandbox.runtimeRoot)));
    await Promise.all([
      registerDescriptor(sandbox.root),
      registerDescriptor(options.productRoot),
      registerDescriptor(options.orchestratorRoot),
      registerDescriptor(openCodeAnchor.evidence.executable),
    ]);
    const runEvidenceDirectory = await createActualOwnerEvidenceDirectory(
      options.evidenceRoot,
      sandbox
    );
    evidenceDirectory = runEvidenceDirectory;
    evidence = Object.freeze({
      ...evidence,
      refs: Object.freeze({
        artifact: preflight.artifact,
        orchestrator: preflight.orchestrator,
        product: preflight.product,
        productExecutable: preflight.productExecutable,
        productContractSource: preflight.productContractSource,
        productContractStaged: productContractAnchor.stagedEvidence,
        orchestratorLauncherSource: preflight.orchestratorLauncherSource,
        orchestratorAcceptanceSource: preflight.orchestratorAcceptanceSource,
        orchestratorLauncherStaged: orchestratorLauncherAnchor.stagedEvidence,
        orchestratorAcceptanceStaged: orchestratorAcceptanceAnchor.stagedEvidence,
        playwrightReleaseManifest: Object.freeze({
          byteCount: preflight.playwrightReleaseManifest.byteCount,
          sha256: preflight.playwrightReleaseManifest.sha256,
        }),
      }),
    });
    await writeActualOwnerEvidence(runEvidenceDirectory, evidence);
    const runtimeManifest = runtimeManifestFor({
      evidenceDirectory: runEvidenceDirectory,
      integration,
      preflight,
      sandbox,
      openCodeExecutable: openCodeAnchor.evidence,
      productContractAnchor,
      ownerToken,
    });
    const runtimeManifestPath = join(sandbox.runtimeRoot, 'runtime-manifest.json');
    await atomicAnchoredPrivateFile(
      runtimeManifestPath,
      Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`)
    );
    await chmodAnchoredPrivateFile(runtimeManifestPath, 0o400);
    await assertRuntimeDescriptorIdentities(runtimeManifest);
    const browserClosure = await prepareBrowserClosure({ options, preflight, sandbox });
    stagedHandles.push(browserClosure);
    await launchProcesses({
      integration,
      options,
      preflight,
      runtimeManifestPath,
      sandbox,
      evidenceDirectory: runEvidenceDirectory,
      processes,
      openCodeAnchor,
      productAnchor,
      orchestratorLauncherAnchor,
      orchestratorAcceptanceAnchor,
      productContractAnchor,
      ownerToken,
    });
    await Promise.all(processes.map(assertActualOwnerManagedProcessIdentity));
    await Promise.all([
      assertCleanExactRepository(options.productRoot, options.productRef, 'product'),
      assertCleanExactRepository(options.orchestratorRoot, options.orchestratorRef, 'orchestrator'),
    ]);
    evidence = Object.freeze({
      ...evidence,
      processIds: Object.freeze(processes.map(({ evidence: item }) => item)),
    });
    await writeActualOwnerEvidence(runEvidenceDirectory, evidence);
    const capability = await waitForDriverCapability({
      baseUrl: integration.driverBaseUrl,
      manifest: runtimeManifest,
      ownerToken,
      processes,
      timeoutMs: integration.timeouts.processReadyMs,
    });
    evidence = Object.freeze({ ...evidence, capability });
    await runBrowser({
      closure: browserClosure,
      integration,
      runtimeManifestPath,
      sandbox,
      ownerToken,
    });
    await Promise.all(processes.map(assertActualOwnerManagedProcessIdentity));
    evidence = await collectEvidence({
      base: evidence,
      evidenceDirectory: runEvidenceDirectory,
      manifest: runtimeManifest,
      ownerToken,
    });
  } catch (error) {
    if (error instanceof ActualOwnerProcessCleanupUnprovedError) processCleanupProved = false;
    runnerError = error;
    evidence = Object.freeze({ ...evidence, status: 'failed', failure: safeError(error) });
  } finally {
    try {
      await stopActualOwnerProcesses(processes);
    } catch (cleanupError) {
      processCleanupProved = false;
      runnerError = new AggregateError(
        [runnerError, cleanupError].filter((value) => value !== null),
        'hosted_actual_owner_process_cleanup_failed'
      );
      evidence = Object.freeze({ ...evidence, status: 'failed', failure: safeError(runnerError) });
    }
    const capturedTimelines = Object.values(evidence.timelineCaptures).filter(
      (value) => value !== null
    );
    if (capturedTimelines.length > 0) {
      try {
        await Promise.all(capturedTimelines.map(assertActualOwnerTimelineCaptureCurrent));
      } catch (captureError) {
        runnerError = new AggregateError(
          [runnerError, captureError].filter((value) => value !== null),
          'hosted_actual_owner_timeline_capture_identity_failed'
        );
        evidence = Object.freeze({
          ...evidence,
          status: 'failed',
          failure: safeError(runnerError),
        });
      }
    }
    await Promise.allSettled(stagedHandles.map((handle) => handle.close()));
    const cleanup = processCleanupProved
      ? await cleanupActualOwnerSandbox(sandbox)
      : Object.freeze({
          attempted: false,
          markerVerified: false,
          removed: false,
          root: sandbox.root,
          runId: sandbox.runId,
          retainedReason: 'hosted_actual_owner_process_cleanup_unproved',
        });
    const after = await diskEvidence(options.sandboxParent);
    evidence = Object.freeze({
      ...evidence,
      cleanup,
      disk: Object.freeze({ ...evidence.disk, after }),
    });
    if (runnerError === null) {
      try {
        const violations = validateActualOwnerCompletionEvidence(evidence);
        evidence = Object.freeze({
          ...evidence,
          status: violations.length === 0 ? 'passed' : 'failed',
          assertions: Object.freeze({ checked: true, violations }),
          failure:
            violations.length === 0 ? null : 'hosted_actual_owner_evidence_assertions_failed',
        });
        if (violations.length > 0) {
          runnerError = new Error('hosted_actual_owner_evidence_assertions_failed');
        }
      } catch (validationError) {
        runnerError = validationError;
        evidence = Object.freeze({
          ...evidence,
          status: 'failed',
          assertions: Object.freeze({
            checked: true,
            violations: Object.freeze(['evidence_validation_exception']),
          }),
          failure: safeError(validationError),
        });
      }
    }
    if (evidenceDirectory !== null) await writeActualOwnerEvidence(evidenceDirectory, evidence);
  }
  if (runnerError !== null) throw runnerError;
  if (evidenceDirectory === null) throw new Error('hosted_actual_owner_evidence_directory_missing');
  return join(evidenceDirectory, 'evidence.json');
}

async function main(): Promise<void> {
  const path = await runActualOwnerMain(process.argv.slice(2));
  process.stdout.write(`Hosted actual-owner E2E evidence: ${path}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}

export { runActualOwnerMain };
