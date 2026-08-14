import { statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHostedV1ForegroundSubprocess } from '../hosted-v1/foregroundSubprocess';
import {
  ACTUAL_OWNER_DRIVER_PROTOCOL,
  ACTUAL_OWNER_PURPOSE,
  expandActualOwnerToken,
  parseActualOwnerCliOptions,
  parseActualOwnerIntegrationManifest,
  type ActualOwnerIntegrationManifest,
  type ActualOwnerProcessName,
  type ActualOwnerProcessTemplate,
  type ActualOwnerRuntimeManifest,
} from './contracts';
import {
  copyPrivateCapture,
  createActualOwnerEvidenceDirectory,
  initialActualOwnerEvidence,
  readJsonCapture,
  readNdjsonCapture,
  validateActualOwnerCompletionEvidence,
  writeActualOwnerEvidence,
  type ActualOwnerBrowserResults,
  type ActualOwnerDiskEvidence,
  type ActualOwnerEvidenceDocument,
  type ActualOwnerNegativeEvidence,
  type ActualOwnerPostLedgerEntry,
  type ActualOwnerProtectedEffectEntry,
  type ActualOwnerRestartEvidence,
  type ActualOwnerTimelineEvent,
} from './evidence';
import {
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
}): ActualOwnerRuntimeManifest {
  const browserRoot = join(input.sandbox.root, 'browser');
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: input.sandbox.runId,
    sandboxRoot: input.sandbox.root,
    markerPath: input.sandbox.markerPath,
    evidenceRoot: input.evidenceDirectory,
    driverBaseUrl: input.integration.driverBaseUrl,
    productBaseUrl: input.integration.productBaseUrl,
    approvalPath: input.integration.approvalPath,
    browser: Object.freeze({
      ownerStorageStatePath: join(browserRoot, 'owner-storage-state.json'),
      nonOwnerStorageStatePath: join(browserRoot, 'non-owner-storage-state.json'),
      tracePath: join(browserRoot, 'browser-trace.zip'),
      resultsPath: join(input.sandbox.captureRoot, 'browser-results.json'),
    }),
    capture: Object.freeze({
      conditionalPostLedgerPath: join(input.sandbox.captureRoot, 'conditional-post-ledger.ndjson'),
      negativeResultsPath: join(input.sandbox.captureRoot, 'negative-results.json'),
      openCodeTimelinePath: join(input.sandbox.captureRoot, 'opencode-timeline.ndjson'),
      ownerWalTimelinePath: join(input.sandbox.captureRoot, 'owner-wal-timeline.ndjson'),
      productTimelinePath: join(input.sandbox.captureRoot, 'product-timeline.ndjson'),
      protectedEffectLedgerPath: join(input.sandbox.captureRoot, 'protected-effect-ledger.json'),
    }),
    refs: Object.freeze({
      openCode: input.preflight.artifact.sourceCommit,
      openCodeExecutableSha256: input.preflight.artifact.sha256,
      orchestrator: input.preflight.orchestrator.head,
      product: input.preflight.product.head,
    }),
  });
}

function replacements(input: {
  readonly evidenceDirectory: string;
  readonly options: ReturnType<typeof parseActualOwnerCliOptions>;
  readonly runtimeManifestPath: string;
  readonly sandbox: ActualOwnerSandbox;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    'evidence-root': input.evidenceDirectory,
    'orchestrator-root': input.options.orchestratorRoot,
    'product-root': input.options.productRoot,
    'runtime-manifest': input.runtimeManifestPath,
    'sandbox-root': input.sandbox.root,
    'workspace-root': input.sandbox.workspaceRoot,
  });
}

function isolatedEnvironment(input: {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly sandbox: ActualOwnerSandbox;
  readonly runtimeManifestPath: string;
  readonly template: ActualOwnerProcessTemplate;
  readonly tokens: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
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
      (isAbsolute(expanded) && resolve(expanded) !== expanded) ||
      (candidate && !input.allowedRoots.some((root) => isWithinOrEqual(root, candidate)))
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

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function assertArgumentsWithinRoots(
  args: readonly string[],
  roots: readonly string[],
  name: ActualOwnerProcessName,
  cwd: string
): void {
  for (const argument of args) {
    const candidate = filesystemArgument(argument, cwd);
    if (
      (isAbsolute(argument) && resolve(argument) !== argument) ||
      (candidate && !roots.some((root) => isWithinOrEqual(root, candidate)))
    ) {
      throw new Error(`hosted_actual_owner_${name}_argument_escaped_allowed_roots`);
    }
  }
}

function filesystemArgument(value: string, cwd: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return null;
  if (isAbsolute(value)) return resolve(value);
  if (value.startsWith('.') || value.includes('/')) return resolve(cwd, value);
  return null;
}

async function waitForDriverCapability(input: {
  readonly baseUrl: string;
  readonly manifest: ActualOwnerRuntimeManifest;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
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
      if (
        keys !== 'markerPath,noFakeRuntime,protocol,refs,schemaVersion' ||
        body.schemaVersion !== 1 ||
        body.protocol !== ACTUAL_OWNER_DRIVER_PROTOCOL ||
        body.noFakeRuntime !== true ||
        body.markerPath !== input.manifest.markerPath ||
        JSON.stringify(body.refs) !== JSON.stringify(input.manifest.refs)
      ) {
        throw new Error('driver_capability_invalid');
      }
      return;
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
}): Promise<readonly ActualOwnerManagedProcess[]> {
  const tokens = replacements(input);
  const definitions: readonly {
    readonly name: ActualOwnerProcessName;
    readonly command: string;
    readonly sourceRef: string;
    readonly template: ActualOwnerProcessTemplate;
    readonly extraArgs: readonly string[];
    readonly expectedExecutable?: ActualOwnerPreflightEvidence['productExecutable'];
  }[] = [
    {
      name: 'opencode',
      command: input.options.openCodeExecutable,
      sourceRef: input.options.openCodeSourceRef,
      template: input.integration.processes.opencode,
      extraArgs: [],
      expectedExecutable: input.preflight.artifact,
    },
    {
      name: 'orchestrator',
      command: input.options.orchestratorSourceLauncher,
      sourceRef: input.options.orchestratorRef,
      template: input.integration.processes.orchestrator,
      extraArgs: [
        '--hosted-actual-owner-acceptance-entry',
        input.options.orchestratorAcceptanceEntry,
        '--runtime-manifest',
        input.runtimeManifestPath,
      ],
    },
    {
      name: 'product',
      command: input.integration.processes.product.executable as string,
      sourceRef: input.options.productRef,
      template: input.integration.processes.product,
      extraArgs: [],
      expectedExecutable: input.preflight.productExecutable,
    },
  ];
  for (const definition of definitions) {
    const cwd = expandActualOwnerToken(definition.template.cwd, tokens);
    const allowedRoots =
      definition.name === 'opencode'
        ? [input.sandbox.root]
        : [
            input.sandbox.root,
            definition.name === 'product'
              ? input.options.productRoot
              : input.options.orchestratorRoot,
          ];
    if (
      (definition.name === 'product' && cwd !== input.options.productRoot) ||
      (definition.name === 'orchestrator' && cwd !== input.options.orchestratorRoot) ||
      (definition.name === 'opencode' && cwd !== input.sandbox.workspaceRoot)
    ) {
      throw new Error(`hosted_actual_owner_${definition.name}_cwd_invalid`);
    }
    const args = [
      ...definition.template.args.map((value) => expandActualOwnerToken(value, tokens)),
      ...definition.extraArgs,
    ];
    assertArgumentsWithinRoots(args, allowedRoots, definition.name, cwd);
    input.processes.push(
      await launchActualOwnerProcess({
        args,
        command: definition.command,
        cwd,
        environment: isolatedEnvironment({
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
  const [browser, ownerWal, product, openCode, postLedger, effects, negativeBundle] =
    await Promise.all([
      readJsonCapture<ActualOwnerBrowserResults>(input.manifest.browser.resultsPath),
      readNdjsonCapture<ActualOwnerTimelineEvent>(input.manifest.capture.ownerWalTimelinePath),
      readNdjsonCapture<ActualOwnerTimelineEvent>(input.manifest.capture.productTimelinePath),
      readNdjsonCapture<ActualOwnerTimelineEvent>(input.manifest.capture.openCodeTimelinePath),
      readNdjsonCapture<ActualOwnerPostLedgerEntry>(
        input.manifest.capture.conditionalPostLedgerPath
      ),
      readJsonCapture<readonly ActualOwnerProtectedEffectEntry[]>(
        input.manifest.capture.protectedEffectLedgerPath
      ),
      readJsonCapture<{
        readonly negatives: readonly ActualOwnerNegativeEvidence[];
        readonly restartMatrix: readonly ActualOwnerRestartEvidence[];
      }>(input.manifest.capture.negativeResultsPath),
    ]);
  const tracePath = join(input.evidenceDirectory, 'browser-trace.zip');
  await copyPrivateCapture(input.manifest.browser.tracePath, tracePath);
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
  const diskBefore = await diskEvidence(options.sandboxParent);
  const sandbox = await createActualOwnerSandbox(options.sandboxParent);
  let evidenceDirectory: string | null = null;
  let evidence = initialActualOwnerEvidence({ diskBefore, runId: sandbox.runId });
  const processes: ActualOwnerManagedProcess[] = [];
  let runnerError: unknown = null;
  let processCleanupProved = true;
  try {
    await initializeActualOwnerSandboxProject(sandbox);
    evidenceDirectory = await createActualOwnerEvidenceDirectory(options.evidenceRoot, sandbox);
    evidence = Object.freeze({
      ...evidence,
      refs: Object.freeze({
        artifact: preflight.artifact,
        orchestrator: preflight.orchestrator,
        product: preflight.product,
        productExecutable: preflight.productExecutable,
      }),
    });
    await writeActualOwnerEvidence(evidenceDirectory, evidence);
    const runtimeManifest = runtimeManifestFor({
      evidenceDirectory,
      integration,
      preflight,
      sandbox,
    });
    const runtimeManifestPath = join(sandbox.runtimeRoot, 'runtime-manifest.json');
    await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await launchProcesses({
      integration,
      options,
      preflight,
      runtimeManifestPath,
      sandbox,
      evidenceDirectory,
      processes,
    });
    await Promise.all(processes.map(assertActualOwnerManagedProcessIdentity));
    evidence = Object.freeze({
      ...evidence,
      processIds: Object.freeze(processes.map(({ evidence: item }) => item)),
    });
    await writeActualOwnerEvidence(evidenceDirectory, evidence);
    await waitForDriverCapability({
      baseUrl: integration.driverBaseUrl,
      manifest: runtimeManifest,
      timeoutMs: integration.timeouts.processReadyMs,
    });
    await runBrowser({ integration, options, runtimeManifestPath, sandbox });
    await Promise.all(processes.map(assertActualOwnerManagedProcessIdentity));
    evidence = await collectEvidence({
      base: evidence,
      evidenceDirectory,
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
