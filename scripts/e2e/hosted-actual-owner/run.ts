import { createHash } from 'node:crypto';
import { lstat, realpath, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHostedV1ForegroundSubprocess } from '../hosted-v1/foregroundSubprocess';
import {
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_DESCRIPTOR_TOKENS,
  ACTUAL_OWNER_PURPOSE,
  expandActualOwnerToken,
  parseActualOwnerCliOptions,
  parseActualOwnerIntegrationManifest,
  type ActualOwnerIntegrationManifest,
  type ActualOwnerProcessName,
  type ActualOwnerProcessTemplate,
  type ActualOwnerRuntimeManifest,
} from './contracts';
import { stageActualOwnerExecutable, stageActualOwnerSourceFile } from './anchors';
import {
  copyPrivateCapture,
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
  type ActualOwnerPreflightEvidence,
} from './preflight';
import {
  ActualOwnerProcessCleanupUnprovedError,
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

function uriArgument(value: string): boolean {
  const equals = value.indexOf('=');
  const candidate = equals > 0 && value.startsWith('-') ? value.slice(equals + 1) : value;
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate) && !candidate.startsWith('file://');
}

export function filesystemArgument(value: string, cwd: string): string | null {
  const equals = value.indexOf('=');
  const candidate = equals > 0 && value.startsWith('-') ? value.slice(equals + 1) : value;
  if (candidate.startsWith('file://')) {
    try {
      return fileURLToPath(candidate);
    } catch {
      throw new Error('hosted_actual_owner_file_url_invalid');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) return null;
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
  readonly timeoutMs: number;
}): Promise<ActualOwnerCapabilityEvidence> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertRuntimeDescriptorIdentities(input.manifest);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(2_000, input.timeoutMs));
      const response = await fetch(new URL('v1/capability', input.baseUrl), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (response.status !== 200) throw new Error(`driver_status_${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      const keys = Object.keys(body).sort().join(',');
      const markerPath =
        `${input.manifest.descriptors.sandboxRoot.path}` +
        input.manifest.markerPath.slice(input.manifest.descriptors.sandboxRoot.token.length);
      if (
        keys !== 'markerPath,noFakeRuntime,protocol,refs,schemaVersion' ||
        body.schemaVersion !== 1 ||
        body.protocol !== ACTUAL_OWNER_DRIVER_PROTOCOL ||
        body.noFakeRuntime !== true ||
        body.markerPath !== markerPath ||
        JSON.stringify(body.refs) !== JSON.stringify(input.manifest.refs)
      ) {
        throw new Error('driver_capability_invalid');
      }
      return Object.freeze({
        checkedAt: new Date().toISOString(),
        markerPath,
        noFakeRuntime: true,
        refsSha256: createHash('sha256').update(JSON.stringify(body.refs)).digest('hex'),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error('hosted_actual_owner_driver_readiness_timeout', { cause: lastError });
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
      ],
      anchors: [input.orchestratorLauncherAnchor, input.orchestratorAcceptanceAnchor],
    },
    {
      name: 'product',
      command: input.productAnchor.path,
      sourceRef: input.options.productRef,
      template: input.integration.processes.product,
      extraArgs: [],
      expectedExecutable: input.productAnchor.evidence,
      anchors: [input.productAnchor],
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
          template: definition.template,
          tokens,
        }),
        logRoot: join(input.sandbox.root, 'logs'),
        name: definition.name,
        shutdownMs: input.integration.timeouts.shutdownMs,
        sourceRef: definition.sourceRef,
        expectedExecutable: definition.expectedExecutable,
        anchors: definition.anchors,
      })
    );
  }
  return Object.freeze([...input.processes]);
}

async function runBrowser(input: {
  readonly integration: ActualOwnerIntegrationManifest;
  readonly options: ReturnType<typeof parseActualOwnerCliOptions>;
  readonly runtimeManifestPath: string;
  readonly sandbox: ActualOwnerSandbox;
}): Promise<void> {
  try {
    await runHostedV1ForegroundSubprocess({
      command: '/usr/local/bin/pnpm',
      args: [
        'exec',
        'playwright',
        'test',
        'test/e2e/hosted-web/actual-owner-approval.spec.ts',
        '--workers=1',
        '--retries=0',
        `--timeout=${input.integration.timeouts.browserMs}`,
        `--output=${join(input.sandbox.root, 'browser', 'playwright-output')}`,
      ],
      cwd: input.options.productRoot,
      environment: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HOME: join(input.sandbox.root, 'home'),
        TMPDIR: join(input.sandbox.root, 'tmp'),
        HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST: input.runtimeManifestPath,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      },
      timeoutMs: input.integration.timeouts.browserMs + 30_000,
    });
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
}): Promise<ActualOwnerEvidenceDocument> {
  const capturePath = (value: string) => {
    const descriptor = input.manifest.descriptors.sandboxRoot;
    if (value !== descriptor.token && !value.startsWith(`${descriptor.token}/`)) {
      throw new Error('hosted_actual_owner_capture_descriptor_binding_invalid');
    }
    return `${descriptor.path}${value.slice(descriptor.token.length)}`;
  };
  const [browser, ownerWal, product, openCode, postLedger, effects, negativeBundle] =
    await Promise.all([
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
  await copyPrivateCapture(capturePath(input.manifest.browser.tracePath), tracePath);
  return Object.freeze({
    ...input.base,
    timelines: Object.freeze({ ownerWal, product, openCode }),
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
        orchestratorLauncherSource: preflight.orchestratorLauncherSource,
        orchestratorAcceptanceSource: preflight.orchestratorAcceptanceSource,
        orchestratorLauncherStaged: orchestratorLauncherAnchor.stagedEvidence,
        orchestratorAcceptanceStaged: orchestratorAcceptanceAnchor.stagedEvidence,
      }),
    });
    await writeActualOwnerEvidence(runEvidenceDirectory, evidence);
    const runtimeManifest = runtimeManifestFor({
      evidenceDirectory: runEvidenceDirectory,
      integration,
      preflight,
      sandbox,
      openCodeExecutable: openCodeAnchor.evidence,
    });
    const runtimeManifestPath = join(sandbox.runtimeRoot, 'runtime-manifest.json');
    await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await assertRuntimeDescriptorIdentities(runtimeManifest);
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
      timeoutMs: integration.timeouts.processReadyMs,
    });
    evidence = Object.freeze({ ...evidence, capability });
    await runBrowser({ integration, options, runtimeManifestPath, sandbox });
    await Promise.all(processes.map(assertActualOwnerManagedProcessIdentity));
    evidence = await collectEvidence({
      base: evidence,
      evidenceDirectory: runEvidenceDirectory,
      manifest: runtimeManifest,
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
