import { parse } from 'yaml';

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
  schemaVersion: 1;
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
  run(repository: string, runId: number): Promise<NativeRun>;
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
interface Row {
  scenario: string;
  workflow: string;
  job: string;
  jobName: string;
  artifact: string;
  path: string;
  execute: string;
  upload: string;
  architecture: 'x64' | 'arm64';
  mode: string;
  kind: 'windows' | 'appimage' | 'package' | 'mac-current' | 'mac-old';
}
const workflow = (name: string) => `.github/workflows/${name}.yml`;
// These are closed producer contracts, not caller-supplied success predicates.
export function nativeScenarioRows(runId: number, attempt: number): Row[] {
  const suffix = `${runId}-${attempt}`;
  const rows: Row[] = [];
  for (const architecture of ['x64', 'arm64'] as const) {
    const runner = architecture === 'x64' ? 'windows-2025' : 'windows-11-arm';
    for (const mode of ['fresh', 'full', 'cold', 'warm']) {
      const fresh = mode === 'fresh';
      rows.push({
        scenario: `windows-${architecture}-${mode}`,
        architecture,
        mode,
        kind: 'windows',
        workflow: workflow('updater-windows-ota'),
        job: fresh ? 'fresh-windows' : 'windows-ota',
        jobName: fresh
          ? `fresh-windows (${runner}, ${architecture})`
          : `windows-ota (${runner}, ${mode}, ${architecture})`,
        artifact: fresh
          ? `TEST-windows-fresh-${architecture}-${suffix}`
          : `TEST-windows-ota-${architecture}-${mode}-${suffix}`,
        path: 'summary.json',
        execute: fresh
          ? 'Fresh official target installation on a separate native VM'
          : 'Original updater download install and automatic native restart',
        upload: fresh
          ? 'Preserve independently installed target reference and native proof'
          : 'Preserve actual transport installer successor preference and UI proof',
      });
    }
  }
  for (const mode of ['ota', 'fresh'])
    rows.push({
      scenario: `linux-appimage-${mode}`,
      architecture: 'x64',
      mode,
      kind: 'appimage',
      workflow: workflow('updater-native-feasibility'),
      job: 'linux-native-ota',
      jobName: 'linux-native-ota',
      artifact: `TEST-linux-native-ota-${suffix}`,
      path: `${mode}/evidence.json`,
      execute: 'Exercise real OTA and separate fresh target desktop',
      upload: 'Preserve native OTA proof on success and failure',
    });
  for (const [format, image] of [
    ['deb', 'ubuntu:24.04'],
    ['rpm', 'fedora:44'],
    ['pacman', 'archlinux:base'],
  ]) {
    for (const mode of ['ota', 'fresh'])
      rows.push({
        scenario: `linux-${format}-${mode}`,
        architecture: 'x64',
        mode,
        kind: 'package',
        workflow: workflow('updater-linux-packages'),
        job: 'native',
        jobName: `native (${format}, ${image})`,
        artifact: `TEST-linux-${format}-native-${suffix}`,
        path: `TEST-linux-package-evidence/${mode}/native/evidence.json`,
        execute:
          'Real native package install and unprivileged GUI in offline disposable containers',
        upload: 'Preserve real native evidence even on failure',
      });
  }
  for (const architecture of ['arm64', 'x64'] as const) {
    rows.push({
      scenario: `mac-${architecture}-current`,
      architecture,
      mode: 'current',
      kind: 'mac-current',
      workflow: workflow('updater-mac-updater'),
      job: 'mac-current-no-update',
      jobName: `mac-current-no-update (${architecture})`,
      artifact: `TEST-mac-current-no-update-${architecture}-staged-${suffix}`,
      path: 'TEST-mac-updater-evidence/mac-current-no-update.json',
      execute: 'Native signed current Mac app completes genuine no-update with OS containment',
      upload: 'Preserve native UI, Aqua capture, logs, source hashes and failure gates',
    });
    for (const mode of ['older', 'fresh'])
      rows.push({
        scenario: `mac-${architecture}-${mode}`,
        architecture,
        mode,
        kind: 'mac-old',
        workflow: workflow('updater-mac-old-updater'),
        job: 'mac-older-and-fresh',
        jobName: `mac-older-and-fresh (${mode}, ${architecture}, staged)`,
        artifact: `TEST-mac-${mode}-${architecture}-staged-${suffix}`,
        path: `TEST-mac-old-evidence-${mode}/mac-native-result.json`,
        execute: 'Real signed Squirrel OTA or fresh carried install in a separate Aqua VM',
        upload: 'Preserve native OTA, automatic Aqua successor, preferences and binding evidence',
      });
  }
  return rows;
}
function object(value: unknown, label: string): Json {
  requireThat(
    value && typeof value === 'object' && !Array.isArray(value),
    `Missing object: ${label}`
  );
  return value as Json;
}
function list(value: unknown, label: string): unknown[] {
  requireThat(Array.isArray(value), `Missing array: ${label}`);
  return value;
}
function at(value: unknown, ...keys: string[]): unknown {
  let result = value;
  for (const key of keys) result = object(result, keys.join('.'))[key];
  return result;
}
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
  requireThat(matches.length === 1, `Missing/duplicate native step: ${name}`);
  const result = matches[0]!;
  successful(result);
  return result;
}
function validateWorkflow(source: string, row: Row) {
  const jobs = object(at(parse(source), 'jobs'), 'workflow jobs');
  const producer = object(jobs[row.job], row.job);
  const steps = list(producer.steps, 'workflow steps').map((item) => object(item, 'workflow step'));
  const native = steps.filter((item) => item.name === row.execute);
  const upload = steps.filter((item) => item.name === row.upload);
  requireThat(
    native.length === 1 && typeof native[0]?.run === 'string',
    'Untrusted native execution step'
  );
  requireThat(
    upload.length === 1 && /^actions\/upload-artifact@/.test(String(upload[0]?.uses)),
    'Untrusted native upload step'
  );
  const order = steps.indexOf(native[0]!) < steps.indexOf(upload[0]!);
  requireThat(order, 'Upload must follow native execution');
}
function validatePreparation(jobs: NativeJob[], row: Row, run: NativeRun) {
  const name =
    row.kind === 'windows'
      ? 'verified-windows-inputs'
      : row.kind === 'appimage'
        ? 'verified-inputs'
        : row.kind === 'package'
          ? 'inputs'
          : 'prepare-mac-inputs';
  const matches = jobs.filter((job) => job.name === name);
  requireThat(matches.length === 1, 'Missing current immutable input producer');
  const job = matches[0]!;
  successful(job);
  equal(job.run_id, run.id, 'input producer run');
  equal(job.run_attempt, run.run_attempt, 'input producer attempt');
  equal(job.head_sha, run.head_sha, 'input producer tooling');
  const preparation =
    row.kind === 'windows'
      ? 'Verify immutable native producer and extract exact plan-bound inputs'
      : row.kind === 'appimage'
        ? 'Read exact official predecessor and draft bytes'
        : row.kind === 'package'
          ? 'Download and verify immutable official packages'
          : 'Authenticate and hash real release inputs without native application execution';
  step(job, preparation);
  if (row.kind === 'appimage' || row.kind === 'package') {
    step(job, 'Require explicit prepared artifact identity');
    step(
      job,
      row.kind === 'appimage'
        ? 'Download immutable prepared stage'
        : 'Download immutable prepared stage for the current target'
    );
  }
  if (row.kind === 'mac-current' || row.kind === 'mac-old')
    step(job, 'Upload authenticated immutable Mac inputs');
}
function byteLedger(values: unknown[], expected: StagePlan['outputs']) {
  for (const proof of expected) {
    const matches = values
      .map((item) => object(item, 'input proof'))
      .filter((item) => item.name === proof.name);
    requireThat(matches.length === 1, `Missing/duplicate native input: ${proof.name}`);
    for (const field of ['sha256', 'sha512', 'size'] as const)
      equal(matches[0]![field], proof[field], `${proof.name}.${field}`);
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
function checkWindows(value: Json, row: Row, plan: StagePlan, p: string, d: string) {
  equal(value.mode, row.mode, 'Windows mode');
  equal(value.arch, row.architecture, 'Windows architecture');
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
      platformNames(version(plan.input.target.tag)).linux.includes(item.name)
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
    const kind = row.scenario.split('-')[1]!;
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
      equal(at(kernel, 'markers', 'HOME'), at(seal, 'home'), 'Sealed HOME');
      equal(
        at(kernel, 'markers', 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR'),
        at(seal, 'userData'),
        'Sealed profile'
      );
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
  equal(
    at(input, 'binding', 'draftFeed', 'proof'),
    textProof('latest-mac.yml', plan.feeds['latest-mac.yml']!),
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
  requireThat(
    os.length === 1 &&
      os[0]!.exitCode === 0 &&
      String(os[0]!.stdout).trim() === value.testedOperatingSystem,
    'Actual OS command missing'
  );
  for (const command of commands)
    equal(
      command.outputSha256,
      digest(`stdout:\n${String(command.stdout)}\nstderr:\n${String(command.stderr)}`),
      'Mac command digest'
    );
  const current = row.kind === 'mac-current';
  equal(
    value.scenario,
    current
      ? 'mac-current-no-update'
      : row.mode === 'older'
        ? 'mac-2.17.0-to-carried-2.17.1'
        : 'mac-fresh-2.17.1',
    'Mac scenario'
  );
  signature(value.signatureBefore, row.architecture, row.mode === 'older' ? '2.17.0' : macVersion);
  signature(current ? value.signatureAfter : value.signatureFinal, row.architecture, macVersion);
  if (current) {
    present(value, 'nativeWindow', 'observation');
    requireThat(
      typeof value.renderedNoUpdate === 'string' && /Up to date/.test(value.renderedNoUpdate),
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
  requireThat(
    plan.input.mode === 'carry-mac' && plan.input.macSource,
    'This native matrix requires carried Mac'
  );
  const d = digest(canonical(plan.input));
  for (const [field, expected] of Object.entries({
    schemaVersion: 1,
    repository: plan.input.repository,
    toolingSha: plan.input.toolingSha,
    planSha256,
    inputDigest: d,
    targetReleaseId: plan.input.target.id,
    applicationSha: plan.input.target.applicationSha,
  }))
    equal(at(receipt, field), expected, `receipt.${field}`);
  requireThat(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length === 18,
    'Exactly 18 native outcome artifacts required'
  );
  const seenScenarios = new Set<string>();
  const seenArtifacts = new Set<number>();
  const seenJobs = new Set<number>();
  const cachedRuns = new Map<number, { run: NativeRun; jobs: NativeJob[] }>();
  const sources = new Map<string, string>();
  for (const reference of receipt.artifacts) {
    for (const id of [reference.runId, reference.runAttempt, reference.jobId, reference.artifactId])
      positive(id);
    sha(reference.artifactSha256);
    requireThat(
      !seenArtifacts.has(reference.artifactId) && !seenJobs.has(reference.jobId),
      'Duplicate native artifact/job'
    );
    seenArtifacts.add(reference.artifactId);
    seenJobs.add(reference.jobId);
    const matches = nativeScenarioRows(reference.runId, reference.runAttempt).filter(
      (row) => row.artifact === reference.artifactName
    );
    requireThat(
      matches.length > 0 && reference.entries.length === matches.length,
      'Unknown/partial native artifact'
    );
    const row = matches[0]!;
    let state = cachedRuns.get(reference.runId);
    if (!state) {
      state = {
        run: await port.run(receipt.repository, reference.runId),
        jobs: await port.jobs(receipt.repository, reference.runId, reference.runAttempt),
      };
      cachedRuns.set(reference.runId, state);
    }
    const run = state.run;
    successful({ ...run, name: 'native run', started_at: '', completed_at: '' });
    equal(run.id, reference.runId, 'run identity');
    equal(run.repository.full_name, receipt.repository, 'run repository');
    equal(run.run_attempt, reference.runAttempt, 'current run attempt');
    equal(run.head_sha, plan.input.toolingSha, 'native tooling SHA');
    equal(run.event, 'workflow_dispatch', 'native run event');
    equal(run.path.split('@')[0], row.workflow, 'native workflow');
    const jobs = state.jobs.filter((job) => job.id === reference.jobId);
    requireThat(jobs.length === 1, 'Native job outside current attempt');
    const job = jobs[0]!;
    validatePreparation(state.jobs, row, run);
    successful(job);
    equal(job.run_id, reference.runId, 'native job run');
    equal(job.run_attempt, reference.runAttempt, 'native job attempt');
    equal(job.head_sha, plan.input.toolingSha, 'native job SHA');
    equal(job.name, row.jobName, 'native matrix job');
    const execution = step(job, row.execute);
    const upload = step(job, row.upload);
    requireThat(
      time(job.started_at) <= time(execution.started_at) &&
        time(execution.started_at) <= time(execution.completed_at) &&
        time(execution.completed_at) <= time(upload.started_at) &&
        time(upload.started_at) <= time(upload.completed_at) &&
        time(upload.completed_at) <= time(job.completed_at),
      'Invalid native execution/upload order'
    );
    let source = sources.get(row.workflow);
    if (!source) {
      source = await port.workflow(receipt.repository, plan.input.toolingSha, row.workflow);
      sources.set(row.workflow, source);
    }
    validateWorkflow(source, row);
    const artifact = await port.artifact(receipt.repository, reference.artifactId);
    equal(artifact.id, reference.artifactId, 'artifact identity');
    equal(artifact.name, reference.artifactName, 'artifact name');
    equal(artifact.expired, false, 'artifact expiry');
    equal(artifact.digest, `sha256:${reference.artifactSha256}`, 'API artifact digest');
    equal(artifact.workflow_run.id, reference.runId, 'artifact run');
    equal(artifact.workflow_run.head_sha, plan.input.toolingSha, 'artifact tooling');
    requireThat(
      time(artifact.created_at) >= time(upload.started_at) &&
        time(artifact.created_at) < time(upload.completed_at) + 1000,
      'Artifact outside current upload'
    );
    const archive = await port.archive(
      receipt.repository,
      reference.artifactId,
      matches.map((item) => item.path)
    );
    equal(archive.sha256, reference.artifactSha256, 'Downloaded ZIP digest');
    for (const entry of reference.entries) {
      const actualRows = matches.filter(
        (item) => item.scenario === entry.scenario && item.path === entry.path
      );
      requireThat(
        actualRows.length === 1 && !seenScenarios.has(entry.scenario),
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
      const actualRow = actualRows[0]!;
      if (actualRow.kind === 'windows') checkWindows(value, actualRow, plan, planSha256, d);
      else if (actualRow.kind === 'appimage' || actualRow.kind === 'package')
        checkLinux(value, actualRow, plan, planSha256, d);
      else checkMac(value, actualRow, plan, planSha256, d);
    }
  }
  const expected = nativeScenarioRows(1, 1).map((row) => row.scenario);
  requireThat(
    seenScenarios.size === 22 && expected.every((name) => seenScenarios.has(name)),
    'Exact 22-scenario native matrix missing'
  );
}
