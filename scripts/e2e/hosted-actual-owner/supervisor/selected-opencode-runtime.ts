import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { readSelectedPrivateResponse, SelectedProbeUnavailable } from './selected-private-http-probe';
import type { SupervisorPlan } from '../processes';
import { canonicalJson, sha256 } from './canonical';
import type { ExpectedSupervisedOpenCode } from './bootstrap-v2';
import { loadOwnerPreparationModule, type SelectedPreparationInput, type ResolvedConfigObservations } from './owner-preparation-module';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { executingImage, processIdentity } from './selected-process-observation';
import type { FilePin } from '../contracts';
import { retainSelectedProfileCurrentness } from './selected-profile-currentness';
import { loadSelectedKernel, retainSelectedProcess, type SelectedProcessHandle } from './selected-kernel';
import { drainSelectedProcess, SELECTED_PROCESS_LIFETIME } from './selected-process-drain';
import { observeSelectedDirectProducer, observeSelectedDirectProducerExit } from './selected-producer-observation';
import { SelectedCapture } from './selected-capture';

export interface SelectedOpenCodeInputs {
  readonly stackManifestSha256: string;
  readonly preparationModule: FilePin;
  readonly paths: { data: string; cache: string };
  readonly sourceHomePath: string;
  readonly sourceAuthPaths: readonly string[];
  readonly globalAuthPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly appMcp: { command: string; entry: string; moduleDirectory: string; repositoryRoot: string };
  readonly modelOutputLimitOverrides?: SelectedPreparationInput['options']['modelOutputLimitOverrides'];
  readonly credentials: { username: string; password: string };
  readonly serverAuthId: string;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_opencode_${reason}`);
}
function privatePath(path: string): void {
  check(typeof path === 'string' && path.startsWith('/sandbox/') && path.length <= 4096 &&
    !path.includes('\\') && !path.includes('\0') && path.split('/').slice(1).every(v => v && v !== '.' && v !== '..'), 'private_path');
}
function listener(pid: number): string {
  const rows = readFileSync(`/proc/${pid}/net/tcp`, 'utf8');
  check(Buffer.byteLength(rows) <= 1024 * 1024, 'listener_bound');
  const matches = rows.split('\n').map(row => row.trim().split(/\s+/u))
    .filter(row => row[1] === '0100007F:1000' && row[3] === '0A');
  check(matches.length === 1 && /^[1-9][0-9]*$/u.test(matches[0][9]), 'listener');
  const inode = matches[0][9];
  const fds = readdirSync(`/proc/${pid}/fd`);
  check(fds.length <= 1024 && fds.some(fd => {
    try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`; }
    catch { return false; }
  }), 'listener_process');
  return inode;
}

/** One real preparation and one real OpenCode child. Credentials/configuration
 * and original response bytes remain inside this private lifetime; only public
 * fingerprints/process facts are available to launch composition. */
export async function startSelectedOpenCode(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  input: SelectedOpenCodeInputs, signal: AbortSignal) {
  try { return await startSelectedOpenCodePrivate(plan, admission, input, signal); }
  catch {
    // Resolver and preparation failures can contain configuration, credentials,
    // or private paths. They occur before child ownership exists and must use
    // the same public failure policy as errors after spawn. No original cause
    // is attached to the error crossing this private lifetime boundary.
    throw new Error('selected_opencode_start_failed');
  }
}

async function startSelectedOpenCodePrivate(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  input: SelectedOpenCodeInputs, signal: AbortSignal) {
  assertSelectedPlanAdmission(admission, plan);
  const selected = structuredClone(input);
  // The module selection must come from the signed recipe, not this private input.
  check(admission.preparationModule && canonicalJson(admission.preparationModule) ===
    canonicalJson(selected.preparationModule), 'preparation_selection');
  check(admission.kernelModule, 'kernel_selection');
  const kernel = loadSelectedKernel(admission.kernelModule);
  for (const path of [selected.paths.data, selected.paths.cache, selected.sourceHomePath,
    selected.globalAuthPath, ...selected.sourceAuthPaths]) privatePath(path);
  check(selected.sourceAuthPaths.length <= 32 && new Set(selected.sourceAuthPaths).size === selected.sourceAuthPaths.length,
    'auth_roots');
  const node = `/toolchain/${plan.supervisorSourceInvocation!.executable.relativePath}`;
  check(selected.appMcp.command === node && selected.appMcp.entry.startsWith('/p3b2/') &&
    !selected.appMcp.entry.split('/').some(v => v === '..' || v === '.') &&
    !selected.appMcp.entry.includes('\0'), 'app_mcp_selection');
  check(/^[^:\r\n\0]+$/u.test(selected.credentials.username) &&
    /^[^\r\n\0]+$/u.test(selected.credentials.password) &&
    Buffer.byteLength(selected.credentials.username) <= 128 && Buffer.byteLength(selected.credentials.password) <= 4096,
    'credentials');
  const owner = loadOwnerPreparationModule(admission.preparationModule);
  const environment = { ...selected.environment,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: node, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: selected.appMcp.entry };
  const resolved = await owner.resolveOpenCodeAppMcpLaunchConfig({ env: environment,
    workingDirectory: '/sandbox/project', moduleDirectory: selected.appMcp.moduleDirectory,
    repositoryRoot: selected.appMcp.repositoryRoot, home: selected.sourceHomePath,
    entrypoint: selected.appMcp.entry,
    platform: 'linux', resolveExecutable: name => name === 'node' ? node : null });
  check(resolved.config && resolved.config.enabled === true && resolved.config.type === 'local' &&
    canonicalJson(resolved.config.command) === canonicalJson([node, selected.appMcp.entry]), 'app_mcp_required');
  const profile = await owner.prepareOpenCodeProfile({ projectPath: '/sandbox/project',
    paths: selected.paths, sourceHomePath: selected.sourceHomePath, workingDirectory: '/sandbox/project',
    sourceAuthPaths: selected.sourceAuthPaths, globalAuthPath: selected.globalAuthPath, environment,
    platform: 'linux', appMcpConfig: resolved.config,
    options: { modelOutputLimitOverrides: selected.modelOutputLimitOverrides, abortSignal: signal,
      toolApprovalMode: 'manual', includeAppMcp: true, includeManagedSubscriptionPlugins: true } });
  const publication = owner.retainPreparedProfile(profile);
  const privateResponses = new Map<string, Buffer>();
  let child: ChildProcess | undefined;
  let processHandle: SelectedProcessHandle | undefined;
  let processBefore: ReturnType<typeof processIdentity> | undefined;
  let childExit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> | undefined;
  const lifetimeMarker = randomBytes(32).toString('hex');
  const captures: SelectedCapture[] = [];
  const parentWriterClosures: { fd: number; childFd: number; device: string; inode: string;
    observedOpenMonotonicNs: string; spawnBoundaryMonotonicNs: string; observedClosedMonotonicNs: string }[] = [];
  let profileCurrentness: ReturnType<typeof retainSelectedProfileCurrentness>;
  let closed = false;
  try {
    profileCurrentness = retainSelectedProfileCurrentness(profile);
    const provenance = plan.runtimeManifest.captureEmissionContract;
    check(/^[0-9a-f]{64}$/u.test(selected.stackManifestSha256), 'stack_digest');
    const timeline = new SelectedCapture(plan, 'openCodeTimelinePath', 'opencode-1'); captures.push(timeline);
    const effects = new SelectedCapture(plan, 'protectedEffectLedgerPath', 'opencode-1'); captures.push(effects);
    const streams = { openCodeTimeline: timeline, protectedEffectLedger: effects };
    check(timeline.fd === 9 && effects.fd === 10, 'producer_streams');
    const stdio: StdioOptions = ['ignore', 'ignore', 'ignore'];
    for (const stream of captures) {
      while (stdio.length <= stream.fd) stdio.push('ignore');
      stdio[stream.fd] = stream.sourceFd;
    }
    const publicStreams = Object.fromEntries(Object.entries(streams).map(([name, stream]) =>
      [name, { fd: stream.fd, device: stream.device, inode: stream.inode }]));
    const capsule = canonicalJson({ activation: { controllerNonce: plan.controllerNonce, runId: plan.runId,
      stackManifestSha256: selected.stackManifestSha256 },
      contract: provenance.contract, contractSha256: provenance.contractSha256,
      expectedProducer: { artifactManifestSha256: plan.expectedProducerArtifactSha256.opencode,
        executableSha256: plan.expectedExecutableSha256.opencode,
        implementationId: 'agent-teams.opencode.hosted-approval.v1', moduleSha256: plan.expectedProducerModuleSha256.opencode },
      producerRole: 'opencode', streams: publicStreams, version: 2 });
    child = spawn('/opencode', [...plan.expectedArgv.opencode], { cwd: '/sandbox/project', shell: false,
      stdio, env: { ...profile.env, OPENCODE_SERVER_USERNAME: selected.credentials.username,
        OPENCODE_SERVER_PASSWORD: selected.credentials.password,
        [SELECTED_PROCESS_LIFETIME]: lifetimeMarker,
        [plan.processOwnership.environmentKey]: plan.processOwnership.marker,
        [provenance.environment]: capsule } });
    childExit = new Promise((resolve, reject) => {
      child!.once('exit', (code, exitSignal) => resolve(Object.freeze({ code, signal: exitSignal })));
      child!.once('error', () => reject(new Error('selected_opencode_spawn')));
    });
    void childExit.catch(() => undefined);
    const spawnBoundaryMonotonicNs = process.hrtime.bigint().toString();
    // Acquire the kernel anchor synchronously before yielding to libuv, which
    // could reap an already-exited child and make its numeric PID reusable.
    check(child.pid, 'spawn_pid');
    processHandle = retainSelectedProcess(kernel, child.pid);
    processBefore = processIdentity(child.pid);
    for (const stream of captures) parentWriterClosures.push(
      stream.directSpawnClosed(admission.process.processStartToken, spawnBoundaryMonotonicNs));
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve);
      child!.once('error', () => reject(new Error('selected_opencode_spawn'))); });
    check(processBefore.parentPid === process.pid &&
      processBefore.pidNamespaceInode === admission.process.pidNamespaceInode &&
      processBefore.networkNamespaceInode === admission.process.networkNamespaceInode, 'namespace');
    const image = await executingImage(child.pid!, plan.supervisorAdmissionDescriptor!.openCode.linuxX64Binary, signal);
    const probe = async (path: string) => {
      check(canonicalJson(processIdentity(child!.pid!)) === canonicalJson(processBefore), 'process_changed');
      const observed = await readSelectedPrivateResponse(path, selected.credentials, signal);
      const initial = privateResponses.get(path);
      if (initial) {
        try { check(initial.equals(observed.bytes), 'private_configuration_changed'); }
        finally { observed.bytes.fill(0); }
      } else {
        check(privateResponses.size < 6, 'private_proof_budget');
        privateResponses.set(path, observed.bytes);
      }
      listener(child!.pid!);
      check(canonicalJson(processIdentity(child!.pid!)) === canonicalJson(processBefore), 'process_changed');
      return { status: observed.status, data: observed.data };
    };
    // Poll only transport readiness; successful bytes are always returned by
    // this child, never substituted on timeout or authentication failure.
    const deadline = performance.now() + 30_000;
    let health: Awaited<ReturnType<typeof probe>> | undefined;
    while (!health) {
      signal.throwIfAborted();
      try { health = await probe('/global/health'); }
      catch (error) {
        if (!(error instanceof SelectedProbeUnavailable)) throw error;
        check(performance.now() < deadline && child.exitCode === null && child.signalCode === null, 'health_deadline');
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
    }
    check(health.data && typeof health.data === 'object' && Reflect.get(health.data, 'healthy') === true, 'health');
    const observations: ResolvedConfigObservations = { config: await probe('/config'),
      configProviders: await probe('/config/providers'), agents: await probe('/agent'), mcp: await probe('/mcp') };
    const fingerprint = owner.buildResolvedConfigFingerprint(observations);
    check(fingerprint && /^[0-9a-f]{64}$/u.test(fingerprint), 'resolved_configuration');
    const capability = (await probe('/experimental/agent-teams/hosted-approval-capability')).data;
    check(capability && typeof capability === 'object' && !Array.isArray(capability) &&
      Object.keys(capability).sort().join(',') === 'authentication,configGeneration,protocol,runtimeInstanceId,schemaVersion' &&
      Reflect.get(capability, 'schemaVersion') === 2 && Reflect.get(capability, 'protocol') === 'agent-teams-hosted-approval-v2' &&
      Reflect.get(capability, 'authentication') === 'opencode-basic' &&
      /^runtime_instance_[0-9a-f]{32}$/u.test(Reflect.get(capability, 'runtimeInstanceId')) &&
      /^config_generation_[0-9a-f]{32}$/u.test(Reflect.get(capability, 'configGeneration')), 'capability');
    const processObservation = await observeSelectedDirectProducer(plan, admission, 'opencode', processHandle, signal);
    for (const capture of captures) capture.observeDirectProducer(processObservation, processHandle);
    const processStartToken = processObservation.startToken;
    const startIdentity: ExpectedSupervisedOpenCode['process']['startIdentity'] =
      `start_${sha256(`${child.pid}\0proc:${processBefore.startTicks}`)}`;
    const base = Object.freeze({ endpoint: { protocol: 'http:' as const, address: '127.0.0.1' as const,
      port: 4096, baseUrl: 'http://127.0.0.1:4096' },
      process: { pid: child.pid!, startTicks: processBefore.startTicks,
        startIdentity,
        supervisorProcessStartToken: processStartToken, pidNamespaceInode: processBefore.pidNamespaceInode,
        networkNamespaceInode: processBefore.networkNamespaceInode },
      executable: { ...image, artifactManifestSha256: plan.expectedProducerArtifactSha256.opencode,
        moduleSha256: plan.expectedProducerModuleSha256.opencode },
      profile: { projectPath: profile.projectPath, profileRootKey: profile.profileRootKey, profileRootPath: profile.profileRootPath,
        projectBehaviorFingerprint: profile.projectBehaviorFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
        resolvedConfigFingerprint: fingerprint, sourceAuthFingerprint: profile.sourceAuthFingerprint,
        managedAuthFingerprint: profile.managedAuthFingerprint, sourceAuthSources: profile.sourceAuthSources ?? [],
        toolApprovalMode: 'manual' as const }, hosted: capability as ExpectedSupervisedOpenCode['hosted'],
      serverAuthId: selected.serverAuthId });
    const guardedPublication = Object.freeze({ publicationId: publication.publicationId,
      transfer(key: Uint8Array, context: Parameters<typeof publication.transfer>[1]) {
        try {
          check(!closed, 'closed'); assertSelectedPlanAdmission(admission, plan);
          check(canonicalJson(processIdentity(child!.pid!)) === canonicalJson(processBefore), 'process_changed');
          profileCurrentness.assertCurrent();
          return publication.transfer(key, context);
        } catch { throw new Error('selected_opencode_transfer_failed'); }
      }, close: () => publication.close() });
    const selectedHandle = processHandle;
    let drained = false;
    let closePromise: Promise<Awaited<ReturnType<typeof drainSelectedProcess>>> | undefined;
    let processExitObservation: ReturnType<typeof observeSelectedDirectProducerExit> | undefined;
    return Object.freeze({ child, processHandle: selectedHandle, processObservation,
      captures: Object.freeze({ ...streams }),
      publication: guardedPublication, processStartToken,
      parentWriterClosures: Object.freeze(parentWriterClosures.map(row => Object.freeze(row))),
      exit: childExit,
      async expectedHost(activation: ExpectedSupervisedOpenCode['activation']): Promise<ExpectedSupervisedOpenCode> {
        try {
          check(!closed, 'closed'); assertSelectedPlanAdmission(admission, plan);
          check(activation.stackManifestSha256 === selected.stackManifestSha256 &&
            activation.controllerNonce === plan.controllerNonce && activation.runId === plan.runId, 'activation');
          check(canonicalJson(processIdentity(child!.pid!)) === canonicalJson(processBefore), 'process_changed');
          await executingImage(child!.pid!, plan.supervisorAdmissionDescriptor!.openCode.linuxX64Binary, signal);
          const behavior = await owner.collectProjectBehaviorMetadata('/sandbox/project');
          check(behavior.projectBehaviorFingerprint === profile.projectBehaviorFingerprint &&
            canonicalJson(behavior.behaviorSources) === canonicalJson(profile.behaviorSources), 'behavior_changed');
          await probe('/global/health');
          const currentConfig: ResolvedConfigObservations = { config: await probe('/config'),
            configProviders: await probe('/config/providers'), agents: await probe('/agent'), mcp: await probe('/mcp') };
          check(owner.buildResolvedConfigFingerprint(currentConfig) === fingerprint, 'resolved_configuration_changed');
          await probe('/experimental/agent-teams/hosted-approval-capability');
          listener(child!.pid!);
          profileCurrentness.assertCurrent();
          check(!closed, 'closed'); assertSelectedPlanAdmission(admission, plan);
          check(canonicalJson(processIdentity(child!.pid!)) === canonicalJson(processBefore), 'process_changed');
          return structuredClone({ ...base, activation });
        } catch { throw new Error('selected_opencode_observation_failed'); }
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
          try {
            const exits = await drainSelectedProcess(kernel, selectedHandle, lifetimeMarker, processBefore!.pidNamespaceInode);
            await childExit;
            processExitObservation = observeSelectedDirectProducerExit(plan, admission, processObservation, selectedHandle);
            drained = true;
            return exits;
          } finally {
            try { publication.close(); }
            finally { for (const bytes of privateResponses.values()) bytes.fill(0); privateResponses.clear(); }
          }
        })();
        return closePromise;
      },
      exitObservation() { check(processExitObservation, 'exit_unobserved'); return processExitObservation; },
      releaseObservation() {
        check(drained, 'process_not_drained');
        try { selectedHandle.close(); }
        finally { for (const capture of captures) capture.close(); }
      },
    });
  } catch {
    try {
      if (processHandle && processBefore) {
        await drainSelectedProcess(kernel, processHandle, lifetimeMarker, processBefore.pidNamespaceInode);
        await childExit;
      } else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } finally {
      processHandle?.close(); publication.close(); for (const bytes of privateResponses.values()) bytes.fill(0); privateResponses.clear();
      for (const capture of captures) capture.close();
    }
    throw new Error('selected_opencode_start_failed');
  }
}
