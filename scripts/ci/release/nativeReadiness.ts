import { fullNativeScenarioRows, nativeScenarioRows } from './nativeReadinessRows.js';
import type { NativeScenarioRow as Row } from './nativeReadinessRows.js';
export { fullNativeScenarioRows, nativeScenarioRows } from './nativeReadinessRows.js';
import { createNativeExecutionResolver } from './nativeReadinessExecution.js';
import { RELEASE220_WINDOWS_RESUME_EXECUTION as windowsResume } from './release220WindowsResumeExecutionPins.js';
import { checkMacManual, manualCapturePaths } from './macManualReadiness.js';
import {
  at,
  isClosedWindowsResumeHead,
  list,
  object,
  release220Execution,
  validateWorkflow,
  verifyRelease220WindowsProvenance,
} from './nativeReadinessAuthority.js';
import type { Release220ExecutionProof, ExecutionProof } from './nativeReadinessAuthority.js';
import { assertArmPriorFixture, usesRepairedArm211 } from './windowsArmPriorFixture.js';
import type { ArmPriorFixture } from './windowsArmPriorFixture.js';

import {
  canonical,
  digest,
  MANIFEST,
  manifestFor,
  platformNames,
  requireThat,
  textProof,
  version,
} from './contract.js';
import type { StagePlan } from './contract.js';

export interface NativeEntryReference {
  scenario: string;
  path: string;
  sha256: string;
  sealedSha256: string;
}
export interface NativeArtifactReference {
  runId: number;
  runAttempt: number;
  jobId: number;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
  entries: NativeEntryReference[];
}
export interface NativeReadinessReceipt {
  schemaVersion: 1 | 2 | 3;
  repository: string;
  toolingSha: string;
  planSha256: string;
  inputDigest: string;
  targetReleaseId: number;
  applicationSha: string;
  artifacts: NativeArtifactReference[];
}
export interface NativeStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string;
}
export interface NativeJob extends NativeStep {
  id: number;
  run_id: number;
  head_sha: string;
  run_attempt: number;
  steps: NativeStep[];
}
export interface NativeRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  repository: { full_name: string };
}
export interface NativeArtifact {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
  created_at: string;
  workflow_run: { id: number; head_sha: string };
}
export interface NativeReadinessPort {
  release220ExecutionProof?(): Promise<Release220ExecutionProof>;
  release220MacExecutionProof?(): Promise<ExecutionProof>;
  release220WindowsExecutionProof?(): Promise<ExecutionProof>;
  release220WindowsResumeExecutionProof?(executionSha?: string): Promise<ExecutionProof>;
  executionProof?(repository: string, executionSha: string): Promise<ExecutionProof>;
  run(repository: string, runId: number): Promise<NativeRun>;
  runAttempt?(repository: string, runId: number, attempt: number): Promise<NativeRun>;
  jobs(repository: string, runId: number, attempt: number): Promise<NativeJob[]>;
  artifact(repository: string, artifactId: number): Promise<NativeArtifact>;
  workflow(repository: string, toolingSha: string, workflowPath: string): Promise<string>;
  archive(
    repository: string,
    artifactId: number,
    entries: string[]
  ): Promise<{
    sha256: string;
    entries: Record<string, Buffer>;
  }>;
}
type Json = Record<string, unknown>;
function equal(actual: unknown, expected: unknown, label: string): void {
  requireThat(canonical(actual) === canonical(expected), `Native proof mismatch: ${label}`);
}
function truth(value: unknown, ...fields: string[]) {
  for (const field of fields)
    requireThat(at(value, field) === true, `Native proof not complete: ${field}`);
}
function present(value: unknown, ...fields: string[]) {
  for (const field of fields) object(at(value, field), field);
}
function positive(value: number) {
  requireThat(Number.isSafeInteger(value) && value > 0, 'Invalid native identity');
}
function sha(value: string) {
  requireThat(/^[a-f0-9]{64}$/.test(value), 'Invalid native SHA256');
}
function time(value: string) {
  const result = Date.parse(value);
  requireThat(Number.isFinite(result), 'Missing native timestamp');
  return result;
}
function successful(value: NativeStep) {
  equal(value.status, 'completed', value.name);
  equal(value.conclusion, 'success', value.name);
}
function step(job: NativeJob, name: string) {
  const matches = job.steps.filter((item) => item.name === name);
  const result = matches[0];
  requireThat(matches.length === 1 && result, `Missing/duplicate native step: ${name}`);
  successful(result);
  return result;
}
function validatePreparation(jobs: NativeJob[], row: Row, run: NativeRun) {
  const kind = row.kind === 'mac-current' || row.kind === 'mac-old' ? 'mac' : row.kind;
  const producers = {
    windows: [
      'verified-windows-inputs',
      'Verify immutable native producer and extract exact plan-bound inputs',
    ],
    appimage: ['verified-inputs', 'Read exact official predecessor and draft bytes'],
    package: ['inputs', 'Download and verify immutable official packages'],
    'mac-manual': [
      'prepare-mac-manual-inputs',
      'Authenticate prepared plan and uploaded original 211 and target 220 bytes',
    ],
    mac: [
      'prepare-mac-inputs',
      'Authenticate and hash real release inputs without native application execution',
    ],
  } as const;
  const [name, preparation] = producers[kind];
  const matches = jobs.filter((job) => job.name === name);
  const job = matches[0];
  requireThat(matches.length === 1 && job, 'Missing current immutable input producer');
  successful(job);
  equal(job.run_id, run.id, 'input producer run');
  equal(job.run_attempt, run.run_attempt, 'input producer attempt');
  equal(job.head_sha, run.head_sha, 'input producer tooling');
  if (row.kind === 'windows' && isClosedWindowsResumeHead(run.head_sha)) {
    requireThat(row.mode !== 'fresh', 'Windows resume executor cannot qualify fresh installation');
    const auth = step(job, windowsResume.preparation);
    const upload = step(job, windowsResume.custodyUpload);
    requireThat(
      time(job.started_at) <= time(auth.started_at) &&
        time(auth.started_at) <= time(auth.completed_at) &&
        time(auth.completed_at) <= time(upload.started_at) &&
        time(upload.started_at) <= time(upload.completed_at) &&
        time(upload.completed_at) <= time(job.completed_at),
      'Invalid Windows resume preparation custody order'
    );
  } else step(job, preparation);
  if (row.kind === 'appimage' || row.kind === 'package') {
    step(job, 'Require explicit prepared artifact identity');
    step(
      job,
      row.kind === 'appimage'
        ? 'Download immutable prepared stage'
        : 'Download immutable prepared stage for the current target'
    );
  }
  if (row.kind === 'mac-manual') step(job, 'Upload authenticated manual migration inputs');
  if (row.kind === 'mac-current' || row.kind === 'mac-old')
    step(job, 'Upload authenticated immutable Mac inputs');
  return job;
}
function byteLedger(values: unknown[], expected: StagePlan['outputs']) {
  for (const proof of expected) {
    const matches = values
      .map((item) => object(item, 'input proof'))
      .filter((item) => item.name === proof.name);
    const matched = matches[0];
    requireThat(matches.length === 1 && matched, `Missing/duplicate native input: ${proof.name}`);
    for (const field of ['sha256', 'sha512', 'size'] as const)
      equal(matched[field], proof[field], `${proof.name}.${field}`);
  }
}
function events(value: unknown, expectedVersion: string) {
  const items = list(value, 'updater events').map((item) => object(item, 'event'));
  requireThat(
    items.some((item) => item.type === 'not-available' && item.version === expectedVersion),
    'Genuine no-update missing'
  );
  requireThat(
    !items.some((item) => ['available', 'downloaded', 'progress'].includes(String(item.type))),
    'Unexpected post-update download'
  );
}
function signature(value: unknown, architecture: string, expectedVersion: string) {
  for (const [field, expected] of Object.entries({
    architecture,
    version: expectedVersion,
    teamIdentifier: '6C84CW694S',
    productMinimum: '12.0',
  }))
    equal(at(value, field), expected, `signature.${field}`);
}
function noSandbox(command: unknown) {
  const values = list(command, 'sandbox command');
  requireThat(
    values.length > 0 &&
      values.every(
        (item) => typeof item === 'string' && !/(?:^|\s)--no-sandbox(?:=|\s|$)/.test(item)
      ),
    'Disabled Electron sandbox'
  );
}
export function checkWindowsPriorFixture(
  value: Json,
  architecture: string,
  mode: string,
  targetVersion: string
) {
  if (!usesRepairedArm211(architecture, mode, targetVersion)) {
    requireThat(
      value.predecessorFixture === undefined,
      'Unrepaired Windows case cannot claim a fixture'
    );
    return;
  }
  const fixture = object(
    value.predecessorFixture,
    'Explicit repaired original ARM211 fixture'
  ) as unknown as ArmPriorFixture;
  assertArmPriorFixture(fixture);
  equal(at(value, 'initialInstall', 'code'), 0, 'Actual original NSIS exit');
  const args = list(at(value, 'initialInstall', 'arguments'), 'Original NSIS arguments');
  equal(args[0], '/S', 'Original NSIS silent mode');
  equal(args.length, 2, 'Original NSIS argument count');
  equal(
    args[1],
    `/D=${fixture.registry.installLocation}`,
    'Actual original installation directory'
  );
  const uninstall = `"${fixture.registry.installLocation}\\Uninstall AgentTeamsAI.exe" /currentuser`;
  equal(fixture.registry.uninstallString, uninstall, 'Original owned uninstaller');
  equal(fixture.registry.quietUninstallString, `${uninstall} /S`, 'Original quiet uninstaller');
  equal(fixture.registry.version, '2.17.1', 'Original registry version');
  equal(
    at(value, 'installedBefore', 'packageVersion'),
    '2.17.1',
    'Original repaired prior version'
  );
}
function checkWindows(value: Json, row: Row, plan: StagePlan, p: string, d: string) {
  equal(value.mode, row.mode, 'Windows mode');
  equal(value.arch, row.architecture, 'Windows architecture');
  checkWindowsPriorFixture(value, row.architecture, row.mode, version(plan.input.target.tag));
  truth(value, 'finalReleaseProved', 'finalPromotionFeed');
  equal(value.inputDigest, d, 'Windows input digest');
  equal(at(value, 'targetBinding', 'plan', 'sha256'), p, 'Windows plan hash');
  equal(at(value, 'targetBinding', 'plan', 'input'), plan.input, 'Windows plan input');
  equal(at(value, 'targetBinding', 'legacyFixture'), false, 'Windows legacy fixture');
  equal(
    at(value, 'targetBinding', 'targetVersion'),
    version(plan.input.target.tag),
    'Windows target version'
  );
  equal(
    at(value, 'targetBinding', 'stagedMetadata', 'releaseId'),
    plan.input.target.id,
    'Windows staged release'
  );
  const names = platformNames(version(plan.input.target.tag)).windows.flatMap((name) => [
    name,
    `${name}.blockmap`,
  ]);
  byteLedger(
    list(value.inputs, 'Windows ledger'),
    plan.outputs.filter((item) => names.includes(item.name))
  );
  equal(at(value, 'cleanup', 'passed'), true, 'Windows cleanup');
  present(
    value,
    'initialInstall',
    'installedBefore',
    'initialLaunch',
    'signatures',
    'desktopSession'
  );
  if (row.mode === 'fresh') {
    truth(value, 'freshInstallProved');
    present(value, 'nativeWindow');
    equal(
      at(value, 'installedBefore', 'packageVersion'),
      version(plan.input.target.tag),
      'Fresh installed Windows version'
    );
    equal(
      at(value, 'installedBefore', 'architecture'),
      row.architecture,
      'Fresh installed Windows architecture'
    );
    events(at(value, 'events', 'events'), version(plan.input.target.tag));
  } else {
    truth(value, 'fullOtaProved', 'automaticSuccessorProved');
    present(value, 'automaticSuccessor', 'automaticWindow', 'downloadedInstaller', 'postUpdate');
    equal(
      at(value, 'automaticSuccessor', 'installed', 'packageVersion'),
      version(plan.input.target.tag),
      'Windows automatic installed version'
    );
    equal(
      at(value, 'automaticSuccessor', 'installed', 'architecture'),
      row.architecture,
      'Windows automatic architecture'
    );
    const name = platformNames(version(plan.input.target.tag)).windows[
      row.architecture === 'x64' ? 0 : 1
    ];
    equal(
      at(value, 'downloadedInstaller', 'hash', 'sha256'),
      plan.outputs.find((item) => item.name === name)!.sha256,
      'Downloaded actual installer bytes'
    );
    equal(at(value, 'downloadMode', 'mode'), row.mode, 'Actual Windows transport mode');
    equal(
      at(value, 'downloadMode', 'differentialProved'),
      row.mode !== 'full',
      'Windows differential proof'
    );
    requireThat(
      list(value.installerProcesses, 'installer processes').some(
        (item) =>
          /\s--updated(?:\s|$)/.test(String(at(item, 'command'))) &&
          /\s--force-run(?:\s|$)/.test(String(at(item, 'command')))
      ),
      'Actual NSIS restart absent'
    );
    events(at(value, 'postUpdate', 'events', 'events'), version(plan.input.target.tag));
    equal(
      at(value, 'profileAfterAutomatic', 'general', 'theme'),
      'light',
      'Windows automatic retained preference'
    );
    equal(
      at(value, 'postUpdate', 'profile', 'general', 'theme'),
      'light',
      'Windows retained preference'
    );
  }
}
function checkLinux(value: Json, row: Row, plan: StagePlan, p: string, d: string) {
  truth(value, 'stageBoundScenarioProved', 'sandboxEnabled');
  equal(value.historicalPreview, false, 'Linux preview');
  equal(value.targetVersion, version(plan.input.target.tag), 'Linux version');
  equal(at(value, 'binding', 'manifestBound'), true, 'Linux manifest binding');
  equal(at(value, 'binding', 'inputDigest'), d, 'Linux input digest');
  equal(at(value, 'binding', 'planSha256'), p, 'Linux plan hash');
  equal(
    at(value, 'binding', 'manifestSha256'),
    textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`).sha256,
    'Linux exact target manifest'
  );
  byteLedger(
    list(value.inputs, 'Linux ledger'),
    plan.outputs.filter((item) =>
      row.kind === 'appimage'
        ? item.name === platformNames(version(plan.input.target.tag)).linux[0]
        : platformNames(version(plan.input.target.tag)).linux.includes(item.name)
    )
  );
  present(value, 'isolation', 'postUpdate');
  const fresh = row.mode === 'fresh';
  if (row.kind === 'appimage') {
    equal(
      value.scope,
      fresh ? 'Linux AppImage native fresh installation' : 'Linux AppImage native OTA from 2.17.1',
      'AppImage scenario'
    );
    equal(at(value, 'sandbox', 'canonicalGatePassed'), true, 'AppImage sandbox');
    const samples = list(at(value, 'sandbox', 'samples'), 'AppImage sandbox samples');
    requireThat(samples.length > 0, 'Missing sandbox sample');
    for (const sample of samples) {
      equal(at(sample, 'noSandbox'), false, 'AppImage sample');
      noSandbox(at(sample, 'command'));
    }
    if (fresh) present(value, 'freshPackage', 'freshDesktop');
    else present(value, 'successor', 'automaticWindow');
  } else {
    equal(value.mode, row.mode, 'Linux package mode');
    const kind = row.scenario.split('-')[1] ?? '';
    equal(value.scope, `Linux ${kind} ${row.mode}`, 'Linux package format');
    const container = object(value.container, 'Linux container');
    requireThat(typeof container.uid === 'number' && container.uid > 0, 'Root GUI is forbidden');
    requireThat(
      new RegExp({ deb: '^ID=ubuntu$', rpm: '^ID=fedora$', pacman: '^ID=arch$' }[kind]!, 'm').test(
        String(container.osRelease)
      ),
      'Wrong native distribution'
    );
    if (fresh) present(value, 'initialPackage', 'freshDesktop');
    else {
      present(
        value,
        'automaticLaunchSeal',
        'automaticSealAfterPaint',
        'automaticPackage',
        'automaticDesktop'
      );
      const seal = at(value, 'automaticLaunchSeal', 'launch');
      noSandbox(at(seal, 'command'));
      const kernel = value.automaticSealAfterPaint;
      equal(
        at(kernel, 'payload'),
        at(value, 'automaticLaunchSeal', 'target'),
        'Sealed successor payload'
      );
      const command = list(at(kernel, 'command'), 'kernel command');
      const sealed = list(at(seal, 'command'), 'sealed command');
      requireThat(
        canonical(command) === canonical(sealed) ||
          (command.length === 1 && command[0] === sealed.join(' ')),
        'Sealed successor command changed'
      );
      const inspector = object(value.automaticReadOnlyInspector, 'automatic successor Inspector');
      const identity = object(inspector.identity, 'automatic successor identity');
      requireThat(
        typeof identity.pid === 'number' &&
          Number.isSafeInteger(identity.pid) &&
          identity.pid > 0 &&
          typeof identity.start === 'string' &&
          identity.start.length > 0,
        'Missing automatic successor generation'
      );
      equal(identity.pid, at(kernel, 'identity', 'pid'), 'Successor Inspector PID');
      equal(identity.start, at(kernel, 'identity', 'start'), 'Successor Inspector start');
      equal(identity.pid, at(value, 'automaticProcess', 'pid'), 'Automatic successor PID');
      equal(identity.start, at(value, 'automaticProcess', 'start'), 'Automatic successor start');
      const actual = object(inspector.actual, 'automatic successor runtime');
      equal(actual.pid, identity.pid, 'Successor runtime PID');
      for (const field of ['home', 'profile', 'userData', 'version', 'executable'])
        requireThat(
          typeof actual[field] === 'string' && actual[field].trim().length > 0,
          `Missing successor runtime ${field}`
        );
      equal(actual.home, at(seal, 'home'), 'Successor HOME');
      equal(actual.profile, at(seal, 'userData'), 'Successor profile');
      equal(actual.userData, at(seal, 'userData'), 'Successor Electron userData');
      const argv = list(actual.argv, 'successor argv');
      const execArgv = list(actual.execArgv, 'successor execArgv');
      requireThat(
        [...argv, ...execArgv].every((item) => typeof item === 'string'),
        'Invalid successor runtime arguments'
      );
      equal(argv, sealed, 'Successor argv');
      equal(execArgv, at(seal, 'runtime', 'execArgv'), 'Successor execArgv');
      equal(actual.version, value.targetVersion, 'Successor version');
      equal(actual.executable, at(kernel, 'executable'), 'Successor executable');
      const markers = object(at(kernel, 'markers'), 'successor kernel markers');
      if (markers.HOME !== undefined) equal(markers.HOME, at(seal, 'home'), 'Sealed HOME');
      if (markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR !== undefined)
        equal(markers.AGENT_TEAMS_ELECTRON_USER_DATA_DIR, at(seal, 'userData'), 'Sealed profile');
    }
  }
  if (!fresh) {
    truth(value, 'automaticSuccessorProved');
    equal(at(value, 'postUpdate', 'preference'), 'light', 'Linux retained preference');
  }
  equal(at(value, 'postUpdate', 'noInstallerGet'), true, 'Linux repeated installer download');
}
function checkMac(value: Json, row: Row, plan: StagePlan, p: string, d: string) {
  truth(value, 'finalPromotionFeed', 'planBindingVerified');
  equal(value.feedMode, 'staged', 'Mac staged mode');
  const input = object(value.inputs, 'Mac inputs');
  equal(input.planSha256, p, 'Mac plan hash');
  equal(input.inputDigest, d, 'Mac input digest');
  equal(input.toolingSha, plan.input.toolingSha, 'Mac tooling');
  equal(value.targetApplicationSha, plan.input.target.applicationSha, 'Mac target application');
  for (const key of ['targetBefore', 'targetAfter']) {
    equal(at(input, key, 'id'), plan.input.target.id, 'Mac numeric target');
    equal(at(input, key, 'target_commitish'), plan.input.target.applicationSha, 'Mac target SHA');
    equal(at(input, key, 'tag_name'), plan.input.target.tag, 'Mac target tag');
  }
  equal(at(input, 'binding', 'inputDigest'), d, 'Mac staged digest');
  equal(
    at(input, 'binding', 'manifest'),
    textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`),
    'Mac manifest byte proof'
  );
  const macFeed = plan.feeds['latest-mac.yml'];
  requireThat(typeof macFeed === 'string', 'Missing Mac feed');
  equal(
    at(input, 'binding', 'draftFeed', 'proof'),
    textProof('latest-mac.yml', macFeed),
    'Mac feed byte proof'
  );
  equal(at(input, 'binding', 'draftFeed', 'releaseId'), plan.input.target.id, 'Mac feed target');
  const macVersion = version(plan.input.macSource!.release.tag);
  const names = platformNames(macVersion).mac.filter((name) =>
    name.includes(`-${row.architecture}`)
  );
  byteLedger(
    list(input.downloads, 'Mac downloads').map((item) => at(item, 'proof')),
    plan.outputs.filter((item) => names.includes(item.name))
  );
  requireThat(
    typeof value.testedOperatingSystem === 'string' &&
      /^15\.\d+(?:\.\d+)?$/.test(value.testedOperatingSystem),
    'Actual tested macOS 15 version missing'
  );
  const commands = list(value.commands, 'Mac native commands').map((item) =>
    object(item, 'Mac command')
  );
  const os = commands.filter((item) => item.command === '/usr/bin/sw_vers -productVersion');
  const actualOs = os[0];
  requireThat(
    os.length === 1 &&
      actualOs?.exitCode === 0 &&
      String(actualOs.stdout).trim() === value.testedOperatingSystem,
    'Actual OS command missing'
  );
  for (const command of commands)
    equal(
      command.outputSha256,
      digest(`stdout:\n${String(command.stdout)}\nstderr:\n${String(command.stderr)}`),
      'Mac command digest'
    );
  const current = row.kind === 'mac-current';
  let scenario = row.mode === 'older' ? 'mac-2.17.0-to-carried-2.17.1' : 'mac-fresh-2.17.1';
  if (current) scenario = 'mac-current-no-update';
  equal(value.scenario, scenario, 'Mac scenario');
  signature(value.signatureBefore, row.architecture, row.mode === 'older' ? '2.17.0' : macVersion);
  signature(current ? value.signatureAfter : value.signatureFinal, row.architecture, macVersion);
  if (current) {
    present(value, 'nativeWindow', 'observation');
    requireThat(
      typeof value.renderedNoUpdate === 'string' && value.renderedNoUpdate.includes('Up to date'),
      'Rendered genuine no-update absent'
    );
    events(at(value, 'observation', 'events'), macVersion);
  } else if (row.mode === 'fresh') {
    equal(value.architecture, row.architecture, 'Mac architecture');
    present(value, 'nativeWindow', 'noUpdate');
    events(at(value, 'noUpdate', 'checked', 'events'), macVersion);
  } else {
    truth(value, 'automaticSuccessorProved');
    present(value, 'automaticSuccessor', 'automaticDesktop', 'postUpdate');
    signature(value.signatureAfterAutomatic, row.architecture, macVersion);
    events(at(value, 'postUpdate', 'checked', 'events'), macVersion);
    equal(value.diagnosticRelaunchOnly, false, 'Mac automatic relaunch');
  }
}
export async function verifyNativeReadiness(
  port: NativeReadinessPort,
  plan: StagePlan,
  planSha256: string,
  receipt: NativeReadinessReceipt
): Promise<void> {
  sha(planSha256);
  const full = plan.input.mode === 'full';
  const reuse = receipt.schemaVersion === 3;
  requireThat(
    full || (plan.input.mode === 'carry-mac' && plan.input.macSource),
    'Unsupported native matrix'
  );
  if (full)
    requireThat(
      (receipt.schemaVersion === 2 || reuse) &&
        plan.input.target.tag === 'v2.17.10' &&
        plan.input.macProductMinimum === '13.0' &&
        !plan.input.macSource,
      'Full220 requires schema2/3 native proof, macOS13 floor and full Mac assets'
    );
  const scenarioRows = full ? fullNativeScenarioRows : nativeScenarioRows;
  const d = digest(canonical(plan.input));
  if (reuse) {
    requireThat(full, 'Schema3 requires the original closed full220 plan');
    release220Execution('windows', plan, planSha256, d);
    requireThat(typeof port.runAttempt === 'function', 'Missing native attempt run capability');
  }
  for (const [field, expected] of Object.entries({
    schemaVersion: reuse ? 3 : receipt.schemaVersion === 2 ? 2 : 1,
    repository: plan.input.repository,
    toolingSha: plan.input.toolingSha,
    planSha256,
    inputDigest: d,
    targetReleaseId: plan.input.target.id,
    applicationSha: plan.input.target.applicationSha,
  }))
    equal(at(receipt, field), expected, `receipt.${field}`);
  requireThat(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length === (full ? 14 : 18),
    'Exact native outcome artifact count required'
  );
  const seenScenarios = new Set<string>();
  const seenArtifacts = new Set<number>();
  const seenJobs = new Set<number>();
  const cachedRuns = new Map<string, { run: NativeRun; jobs: NativeJob[] }>();
  const sources = new Map<string, string>();
  const familyRuns = new Map<string, string>();
  const executionFor = createNativeExecutionResolver(port, receipt, plan, planSha256, d, full);
  async function verifyArtifact(reference: NativeArtifactReference) {
    for (const id of [reference.runId, reference.runAttempt, reference.jobId, reference.artifactId])
      positive(id);
    sha(reference.artifactSha256);
    requireThat(
      !seenArtifacts.has(reference.artifactId) && !seenJobs.has(reference.jobId),
      'Duplicate native artifact/job'
    );
    seenArtifacts.add(reference.artifactId);
    seenJobs.add(reference.jobId);
    const matches = scenarioRows(reference.runId, reference.runAttempt).filter(
      (row) => row.artifact === reference.artifactName
    );
    const row = matches[0];
    requireThat(
      matches.length > 0 && row && reference.entries.length === matches.length,
      'Unknown/partial native artifact'
    );
    const cohort = `${reference.runId}:${reference.runAttempt}`;
    const familyRun = familyRuns.get(row.kind);
    requireThat(reuse || !familyRun || familyRun === cohort, 'Mixed native family runs');
    familyRuns.set(row.kind, cohort);
    let state = cachedRuns.get(cohort);
    if (!state) {
      state = {
        run: reuse
          ? await port.runAttempt!(receipt.repository, reference.runId, reference.runAttempt)
          : await port.run(receipt.repository, reference.runId),
        jobs: await port.jobs(receipt.repository, reference.runId, reference.runAttempt),
      };
      cachedRuns.set(cohort, state);
    }
    const run = state.run;
    const executionSha = await executionFor(row, run.head_sha);
    if (reuse)
      requireThat(
        run.status === 'completed' &&
          (run.conclusion === 'success' || run.conclusion === 'failure'),
        'Native attempt must complete with success or failure'
      );
    else successful({ ...run, name: 'native run', started_at: '', completed_at: '' });
    equal(run.id, reference.runId, 'run identity');
    equal(run.repository.full_name, receipt.repository, 'run repository');
    equal(run.run_attempt, reference.runAttempt, 'current run attempt');
    equal(run.head_sha, executionSha, 'native tooling SHA');
    equal(run.event, 'workflow_dispatch', 'native run event');
    equal(run.path.split('@')[0], row.workflow, 'native workflow');
    const jobs = state.jobs.filter((job) => job.id === reference.jobId);
    const job = jobs[0];
    requireThat(jobs.length === 1 && job, 'Native job outside current attempt');
    const preparation = validatePreparation(state.jobs, row, run);
    successful(job);
    equal(job.run_id, reference.runId, 'native job run');
    equal(job.run_attempt, reference.runAttempt, 'native job attempt');
    equal(job.head_sha, executionSha, 'native job SHA');
    equal(job.name, row.jobName, 'native matrix job');
    const execution = step(job, row.execute);
    const upload = step(job, row.upload);
    if (row.kind === 'windows' && isClosedWindowsResumeHead(executionSha)) {
      const retrieval = step(job, windowsResume.retrieval);
      requireThat(
        time(job.started_at) <= time(retrieval.started_at) &&
          time(retrieval.started_at) <= time(retrieval.completed_at) &&
          time(retrieval.completed_at) <= time(execution.started_at),
        'Windows resume source bytes must authenticate before native effects'
      );
    }
    requireThat(
      (!reuse ||
        (time(preparation.started_at) <= time(preparation.completed_at) &&
          time(preparation.completed_at) <= time(job.started_at))) &&
        time(job.started_at) <= time(execution.started_at) &&
        time(execution.started_at) <= time(execution.completed_at) &&
        time(execution.completed_at) <= time(upload.started_at) &&
        time(upload.started_at) <= time(upload.completed_at) &&
        time(upload.completed_at) <= time(job.completed_at),
      'Invalid native execution/upload order'
    );
    const sourceKey = `${executionSha}:${row.workflow}`;
    let source = sources.get(sourceKey);
    if (!source) {
      source = await port.workflow(receipt.repository, executionSha, row.workflow);
      sources.set(sourceKey, source);
    }
    validateWorkflow(source, row);
    const artifact = await port.artifact(receipt.repository, reference.artifactId);
    equal(artifact.id, reference.artifactId, 'artifact identity');
    equal(artifact.name, reference.artifactName, 'artifact name');
    equal(artifact.expired, false, 'artifact expiry');
    equal(artifact.digest, `sha256:${reference.artifactSha256}`, 'API artifact digest');
    equal(artifact.workflow_run.id, reference.runId, 'artifact run');
    equal(artifact.workflow_run.head_sha, executionSha, 'artifact tooling');
    requireThat(
      time(artifact.created_at) >= time(upload.started_at) &&
        time(artifact.created_at) <= time(upload.completed_at) + 1000,
      'Artifact outside current upload'
    );
    const archive = await port.archive(receipt.repository, reference.artifactId, [
      ...matches.map((item) => item.path),
      ...(row.kind === 'mac-manual' ? manualCapturePaths : []),
    ]);
    equal(archive.sha256, reference.artifactSha256, 'Downloaded ZIP digest');
    function verifyEntry(entry: NativeEntryReference) {
      const actualRows = matches.filter(
        (item) => item.scenario === entry.scenario && item.path === entry.path
      );
      const actualRow = actualRows[0];
      requireThat(
        actualRows.length === 1 && actualRow && !seenScenarios.has(entry.scenario),
        'Unknown/duplicate native scenario'
      );
      seenScenarios.add(entry.scenario);
      sha(entry.sha256);
      sha(entry.sealedSha256);
      const bytes = archive.entries[entry.path];
      requireThat(Buffer.isBuffer(bytes), 'Native ZIP entry missing');
      equal(digest(bytes), entry.sha256, 'Raw native entry digest');
      const value = object(JSON.parse(bytes.toString('utf8')), 'native result');
      equal(digest(canonical(value)), entry.sealedSha256, 'Sealed actual native fields');
      truth(value, 'passed');
      requireThat(
        !value.error && !value.cleanupError && !value.networkRestoreError,
        'Native result contains a failure'
      );
      requireThat(
        typeof value.finishedAt === 'string' &&
          time(value.finishedAt) >= time(execution.started_at) &&
          time(value.finishedAt) <= time(execution.completed_at) + 1000,
        'Native outcome outside execution interval'
      );
      if (actualRow.kind === 'windows') {
        verifyRelease220WindowsProvenance(
          value,
          plan.input.toolingSha,
          executionSha,
          reference.runId,
          reference.runAttempt,
          actualRow.job
        );
        checkWindows(value, actualRow, plan, planSha256, d);
      } else if (actualRow.kind === 'appimage' || actualRow.kind === 'package')
        checkLinux(value, actualRow, plan, planSha256, d);
      else if (actualRow.kind === 'mac-manual')
        checkMacManual(
          value,
          actualRow.architecture,
          plan,
          planSha256,
          d,
          reference.runId,
          reference.runAttempt,
          archive.entries,
          executionSha
        );
      else checkMac(value, actualRow, plan, planSha256, d);
    }
    for (const entry of reference.entries) verifyEntry(entry);
  }
  for (const reference of receipt.artifacts) await verifyArtifact(reference);
  const expected = scenarioRows(1, 1).map((row) => row.scenario);
  requireThat(
    seenScenarios.size === (full ? 18 : 22) && expected.every((name) => seenScenarios.has(name)),
    'Exact native scenario matrix missing'
  );
}
