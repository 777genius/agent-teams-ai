import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  assetByName,
  canonical,
  checkInput,
  checkMetadata,
  checkRelease,
  digest,
  fileProof,
  requireThat,
  sameProof,
  textProof,
  validateFeed,
} from '../../ci/release/contract.ts';
import type {
  NativeProbe,
  NativeProbeArtifact,
  Original,
  Release,
  StagePlan,
} from '../../ci/release/contract.ts';

import { downloadGithubFile } from './github-download.mts';

// This checkpoint verifies shipped signatures, not application launch or OTA behavior.
const repository = '777genius/agent-teams-ai';
const sourceTag = 'v2.17.1';
const sourceApplicationSha = '395572f9ff2a261cb28224754883a39d2c3c8827';
const teamIdentifier = '6C84CW694S';
const sourceReleaseId = 398386033;
const workflowPath = '.github/workflows/updater-mac-source.yml';
function githubCli(): string {
  if (process.platform !== 'darwin') return '/usr/bin/gh';
  if (process.arch === 'arm64') return '/opt/homebrew/bin/gh';
  return '/usr/local/bin/gh';
}
const ghBinary = githubCli();
const pins = [
  {
    name: 'Agent.Teams.AI-2.17.1-arm64-mac.zip',
    assetId: 595801891,
    size: 249381570,
    sha256: '15094309ed73be77f12928cef0d4413cc52366e8697fa399fee7a7b9f3f1a347',
  },
  {
    name: 'Agent.Teams.AI-2.17.1-arm64.dmg',
    assetId: 595801616,
    size: 249856838,
    sha256: 'ef028b523ace7635abdbd050687b816de78bd887eea4d87a79919b8ea401756e',
  },
  {
    name: 'Agent.Teams.AI-2.17.1-x64-mac.zip',
    assetId: 595811620,
    size: 259250901,
    sha256: 'af5a2044cc2c816df27f346a31ec5c47934f351f0184a64d5a767fe8eaf9c355',
  },
  {
    name: 'Agent.Teams.AI-2.17.1-x64.dmg',
    assetId: 595811076,
    size: 259656716,
    sha256: '7a6f2700813940bdc379bd01db568999099c19bda40383ac3e01241ee305de6d',
  },
  {
    name: 'latest-mac.yml',
    assetId: 595898126,
    size: 854,
    sha256: 'a3ba32007f1d5e12a0c7b71c33b1b5a1dd0f6853a91af1d960e92051934ee8c2',
  },
] as const;
type Architecture = NativeProbe['architecture'];
type CommandProof = NativeProbe['commands'][number] & { logFile: string };
interface Result extends CommandProof {
  stdout: string;
  stderr: string;
}
interface Artifact {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
  workflow_run: { id: number; head_sha: string };
}
interface Lane {
  schemaVersion: 1;
  inputDigest: string;
  toolingSha: string;
  sourceTag: string;
  sourceApplicationSha: string;
  architecture: Architecture;
  producer: {
    repository: string;
    runId: number;
    runAttempt: number;
    job: string;
    runnerArch: string;
    platform: string;
  };
  scope: 'source-signatures-only';
  gatekeeperNetwork: 'online';
  dmgContainerSigning: 'unsigned';
  assets: NativeProbe[];
  commands: CommandProof[];
  failures: string[];
  passed: boolean;
}

class Recorder {
  readonly commands: CommandProof[] = [];
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  async finish(
    label: string,
    command: string,
    exitCode: number,
    stdout: string,
    stderr: string
  ): Promise<Result> {
    const logFile = `logs/${String(this.commands.length + 1).padStart(3, '0')}-${label}.log`;
    const bytes = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    const proof = { command, exitCode, outputSha256: digest(bytes), logFile };
    await writeFile(path.join(this.directory, logFile), bytes, { flag: 'wx' });
    this.commands.push(proof);
    process.stdout.write(`${label}: exit ${exitCode}, output sha256 ${proof.outputSha256}\n`);
    return { ...proof, stdout, stderr };
  }

  async run(label: string, executable: string, args: string[], timeout = 120_000): Promise<Result> {
    assert(/^[a-z0-9-]+$/.test(label));
    const command = [
      path.basename(executable),
      ...args.map((arg) => (/^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg))),
    ].join(' ');
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let length = 0;
    let limited = false;
    let timedOut = false;
    const capture = (list: Buffer[]) => (bytes: Buffer) => {
      length += bytes.length;
      if (length > 8 * 1024 * 1024) {
        limited = true;
        child.kill('SIGKILL');
      } else list.push(bytes);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    let spawnError = '';
    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', (error) => {
        spawnError = error.message;
      });
      child.on('close', (code) => resolve(code ?? 128));
    });
    clearTimeout(timer);
    const details = [
      Buffer.concat(stderr).toString(),
      spawnError,
      timedOut ? 'Command timed out' : '',
      limited ? 'Command output limit exceeded' : '',
    ]
      .filter(Boolean)
      .join('\n');
    let resultCode = exitCode;
    if (limited) resultCode = 125;
    if (timedOut) resultCode = 124;
    return this.finish(label, command, resultCode, Buffer.concat(stdout).toString(), details);
  }

  async text(label: string, executable: string, args: string[]): Promise<string> {
    const result = await this.run(label, executable, args);
    requireThat(
      result.exitCode === 0,
      `${label} failed (${result.exitCode}); see ${result.logFile}`
    );
    return result.stdout;
  }

  async api<T>(label: string, endpoint: string): Promise<T> {
    return JSON.parse(await this.text(label, ghBinary, ['api', endpoint])) as T;
  }

  async download(label: string, endpoint: string, file: string): Promise<void> {
    const { exitCode, stderr, error } = await downloadGithubFile(ghBinary, endpoint, file);
    const proof = await this.finish(
      label,
      `gh api ${endpoint} (stdout streamed to file)`,
      exitCode,
      '',
      `${stderr}${error}`
    );
    requireThat(exitCode === 0 && !error, `${label} failed; see ${proof.logFile}`);
  }
}

function immutableValue(value: string | undefined, pattern: RegExp, label: string): string {
  requireThat(value && pattern.test(value), `Invalid ${label}`);
  return value;
}
function integer(value: string | undefined, label: string): number {
  const number = Number(immutableValue(value, /^[1-9]\d*$/, label));
  requireThat(Number.isSafeInteger(number), `Invalid ${label}`);
  return number;
}
function original(plan: StagePlan, name: string): Original {
  const proof = plan.input.originals.find((item) => item.name === name);
  requireThat(proof, `Missing immutable source asset: ${name}`);
  return proof;
}

async function preparedPlan(
  recorder: Recorder,
  values: Record<string, string | undefined>,
  temporary: string
): Promise<StagePlan> {
  const toolingSha = immutableValue(
    values['tooling-sha'],
    /^[a-f0-9]{40}$/,
    'reviewed tooling SHA'
  );
  requireThat(
    process.env.GITHUB_SHA === toolingSha,
    'Workflow SHA differs from reviewed tooling SHA'
  );
  requireThat(
    (await recorder.text('checkout-sha', '/usr/bin/git', ['rev-parse', 'HEAD'])).trim() ===
      toolingSha,
    'Checkout differs from reviewed tooling SHA'
  );
  const runId = integer(values['prepared-run-id'], 'prepared run ID');
  const attempt = integer(values['prepared-run-attempt'], 'prepared run attempt');
  const artifactId = integer(values['prepared-artifact-id'], 'prepared artifact ID');
  const artifactSha256 = immutableValue(
    values['prepared-artifact-sha256'],
    /^[a-f0-9]{64}$/,
    'prepared artifact SHA256'
  );
  const planSha256 = immutableValue(
    values['plan-sha256'],
    /^[a-f0-9]{64}$/,
    'prepared plan SHA256'
  );
  const inputDigest = immutableValue(
    values['input-digest'],
    /^[a-f0-9]{64}$/,
    'manifest input digest'
  );
  const run = await recorder.api<{
    head_sha: string;
    run_attempt: number;
    status: string;
    conclusion: string;
    path: string;
    event: string;
  }>('prepared-run', `repos/${repository}/actions/runs/${runId}`);
  requireThat(
    run.head_sha === toolingSha &&
      run.run_attempt === attempt &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.event === 'workflow_dispatch' &&
      run.path.split('@')[0] === '.github/workflows/stage-existing-partial-draft.yml',
    'Prepared plan producer identity/conclusion mismatch'
  );
  const artifact = await recorder.api<Artifact>(
    'prepared-artifact',
    `repos/${repository}/actions/artifacts/${artifactId}`
  );
  requireThat(
    artifact.name === 'existing-draft-stage-plan' &&
      !artifact.expired &&
      artifact.digest === `sha256:${artifactSha256}` &&
      artifact.workflow_run.id === runId &&
      artifact.workflow_run.head_sha === toolingSha,
    'Prepared artifact identity/digest mismatch'
  );
  const zip = path.join(temporary, 'prepared-plan.zip');
  await recorder.download(
    'download-plan',
    `repos/${repository}/actions/artifacts/${artifactId}/zip`,
    zip
  );
  requireThat(
    (await fileProof(zip, 'prepared-plan.zip')).sha256 === artifactSha256,
    'Prepared artifact actual SHA256 mismatch'
  );
  const listing = (await recorder.text('plan-entries', '/usr/bin/unzip', ['-Z1', zip]))
    .trim()
    .split('\n');
  requireThat(
    listing.filter((entry) => entry === 'stage-plan.json').length === 1,
    'Prepared artifact must contain one exact stage-plan.json'
  );
  const raw = await recorder.text('prepared-plan', '/usr/bin/unzip', [
    '-p',
    zip,
    'stage-plan.json',
  ]);
  requireThat(digest(raw) === planSha256, 'Prepared plan byte digest mismatch');
  const plan = JSON.parse(raw) as StagePlan;
  requireThat(plan.schemaVersion === 1, 'Unknown stage plan schema');
  checkInput(plan.input);
  requireThat(
    plan.input.mode === 'carry-mac' &&
      plan.input.repository === repository &&
      plan.input.toolingSha === toolingSha &&
      digest(canonical(plan.input)) === inputDigest,
    'Native probe input/tooling mismatch'
  );
  const source = plan.input.macSource;
  requireThat(
    source?.release.tag === sourceTag &&
      source.release.id === sourceReleaseId &&
      source.release.applicationSha === sourceApplicationSha &&
      source.productMinimum === '12.0',
    'Probe requires the pinned official Mac source'
  );
  for (const pin of pins) {
    const proof = original(plan, pin.name);
    requireThat(
      proof.assetId === pin.assetId &&
        proof.size === pin.size &&
        proof.sha256 === pin.sha256 &&
        proof.releaseId === sourceReleaseId &&
        proof.tag === sourceTag,
      `Prepared source bytes differ from independent pin: ${pin.name}`
    );
  }
  const feed = plan.feeds['latest-mac.yml'];
  requireThat(typeof feed === 'string', 'Prepared source feed required');
  validateFeed(
    feed,
    '2.17.1',
    pins.slice(0, 4).map((pin) => original(plan, pin.name))
  );
  sameProof(textProof('latest-mac.yml', feed), original(plan, 'latest-mac.yml'));
  await writeFile(path.join(recorder.directory, 'stage-plan.json'), raw, { flag: 'wx' });
  return plan;
}

async function verifySource(recorder: Recorder, plan: StagePlan, suffix: string): Promise<Release> {
  const release = await recorder.api<Release>(
    `source-release-${suffix}`,
    `repos/${repository}/releases/tags/${sourceTag}`
  );
  checkRelease(release, plan.input.macSource!.release, false);
  const pages = await recorder.api<Release['assets']>(
    `source-assets-${suffix}`,
    `repos/${repository}/releases/${sourceReleaseId}/assets?per_page=100`
  );
  // A source release currently has <100 assets; explicitly reject pagination ambiguity.
  requireThat(pages.length < 100, 'Source assets require a paginated audit');
  release.assets = pages;
  checkRelease(release, plan.input.macSource!.release, false);
  const commit = await recorder.api<{ sha: string }>(
    `source-tag-${suffix}`,
    `repos/${repository}/commits/${sourceTag}`
  );
  requireThat(commit.sha === sourceApplicationSha, 'Source application tag moved');
  for (const pin of pins)
    checkMetadata(assetByName(release, pin.name), original(plan, pin.name), pin.assetId);
  const metadata = await recorder.api<{ content: string }>(
    `source-metadata-${suffix}`,
    `repos/${repository}/contents/package.json?ref=${sourceApplicationSha}`
  );
  const sourcePackage = JSON.parse(Buffer.from(metadata.content, 'base64').toString()) as {
    version: string;
    build: { appId: string; mac: { minimumSystemVersion: string }; dmg: { sign: boolean } };
  };
  requireThat(
    // The frozen source stores 2.1.2; release.yml sets 2.17.1 from the tag before building.
    // bundleProbe independently requires the delivered, signed app version to be 2.17.1.
    sourcePackage.version === '2.1.2' &&
      sourcePackage.build.appId === 'com.agent-teams.app' &&
      sourcePackage.build.mac.minimumSystemVersion === '12.0' &&
      sourcePackage.build.dmg.sign === false,
    'Source package signature/minimum metadata differs'
  );
  return release;
}

async function bundleProbe(
  recorder: Recorder,
  app: string,
  architecture: Architecture
): Promise<{ version: string; teamIdentifier: string }> {
  const start = recorder.commands.length;
  const failures: string[] = [];
  const run = async (label: string, executable: string, args: string[]) => {
    const result = await recorder.run(label, executable, args);
    if (result.exitCode !== 0) failures.push(`${label}: exit ${result.exitCode}`);
    return result;
  };
  const verify = await run('codesign-verify', '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    app,
  ]);
  const signature = await run('codesign-details', '/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    app,
  ]);
  const details = `${signature.stdout}\n${signature.stderr}`;
  const actualTeam = /^TeamIdentifier=(\S+)$/m.exec(details)?.[1];
  if (
    actualTeam !== teamIdentifier ||
    !/^Authority=Developer ID Application:/m.test(details) ||
    !/^Identifier=com\.agent-teams\.app$/m.test(details) ||
    !/flags=.*\(runtime\)/.test(details)
  )
    failures.push('Unexpected signing identity or hardened-runtime flags');
  const info = path.join(app, 'Contents', 'Info.plist');
  const plist = async (key: string) =>
    (
      await run(`plist-${key.toLowerCase()}`, '/usr/libexec/PlistBuddy', [
        '-c',
        `Print :${key}`,
        info,
      ])
    ).stdout.trim();
  const actualVersion = await plist('CFBundleShortVersionString');
  const bundleVersion = await plist('CFBundleVersion');
  const bundleId = await plist('CFBundleIdentifier');
  const minimum = await plist('LSMinimumSystemVersion');
  const executable = await plist('CFBundleExecutable');
  if (
    actualVersion !== '2.17.1' ||
    bundleVersion !== '2.17.1' ||
    bundleId !== 'com.agent-teams.app' ||
    minimum !== '12.0' ||
    executable !== 'Agent Teams AI'
  )
    failures.push('Unexpected bundle version/identity/minimum/executable');
  const expectedArch = architecture === 'arm64' ? 'arm64' : 'x86_64';
  for (const [label, file] of [
    ['launcher', path.join(app, 'Contents', 'MacOS', 'Agent Teams AI')],
    [
      'electron',
      path.join(
        app,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Electron Framework'
      ),
    ],
  ] as const) {
    const arches = await run(`macho-${label}`, '/usr/bin/lipo', ['-archs', file]);
    if (arches.stdout.trim() !== expectedArch)
      failures.push(`${label}: expected native ${expectedArch}, got ${arches.stdout.trim()}`);
  }
  // Validate the existing ticket on the .app for both ZIP and unsigned DMG delivery.
  await run('stapler-validate-app', '/usr/bin/xcrun', ['stapler', 'validate', '-v', app]);
  // Network remains available. This is a real online assessment, not offline proof.
  const gatekeeper = await run('gatekeeper-assess', '/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    '--ignore-cache',
    '--no-cache',
    app,
  ]);
  if (
    !`${gatekeeper.stdout}\n${gatekeeper.stderr}`.includes('accepted') ||
    !`${gatekeeper.stdout}\n${gatekeeper.stderr}`.includes('source=Notarized Developer ID')
  )
    failures.push('Gatekeeper did not report Notarized Developer ID acceptance');
  requireThat(
    verify.exitCode === 0 &&
      recorder.commands.slice(start).every((command) => command.exitCode === 0) &&
      failures.length === 0,
    failures.join('; ')
  );
  return { version: actualVersion, teamIdentifier: actualTeam! };
}

async function probeArchive(
  recorder: Recorder,
  plan: StagePlan,
  architecture: Architecture,
  temporary: string,
  pin: (typeof pins)[number]
): Promise<NativeProbe> {
  const archive = path.join(temporary, pin.name);
  const start = recorder.commands.length;
  const directory = await mkdtemp(path.join(temporary, 'TEST-app-'));
  let attached = false;
  try {
    await recorder.download(
      `download-${architecture}-${pin.name.endsWith('.zip') ? 'zip' : 'dmg'}`,
      `repos/${repository}/releases/assets/${pin.assetId}`,
      archive
    );
    sameProof(await fileProof(archive, pin.name), original(plan, pin.name));
    if (pin.name.endsWith('.zip')) {
      const entries = (await recorder.text('zip-entries', '/usr/bin/unzip', ['-Z1', archive]))
        .trim()
        .split('\n');
      requireThat(
        entries.every(
          (entry) =>
            entry.startsWith('Agent Teams AI.app/') &&
            !entry.split('/').some((part) => part === '..')
        ),
        'Unsafe ZIP entry or unexpected top-level bundle'
      );
      await recorder.text('zip-extract', '/usr/bin/ditto', ['-x', '-k', archive, directory]);
    } else {
      await recorder.text('dmg-verify', '/usr/bin/hdiutil', ['verify', archive]);
      await recorder.text('dmg-mount', '/usr/bin/hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        directory,
        archive,
      ]);
      attached = true;
    }
    requireThat(
      (await readdir(directory)).filter((name) => name.endsWith('.app')).join(',') ===
        'Agent Teams AI.app',
      'Archive must contain one expected app bundle'
    );
    const app = path.join(directory, 'Agent Teams AI.app');
    const resolved = await realpath(app);
    requireThat(
      resolved.startsWith(`${await realpath(directory)}${path.sep}`),
      'Bundle escaped extraction/mount root'
    );
    const bundle = await bundleProbe(recorder, app, architecture);
    // Native payload inspection is read-only; downloading/extracting cannot change source bytes.
    sameProof(await fileProof(archive, pin.name), original(plan, pin.name));
    return {
      assetId: pin.assetId,
      sha256: pin.sha256,
      version: bundle.version,
      architecture,
      productMinimum: '12.0',
      teamIdentifier: bundle.teamIdentifier,
      commands: recorder.commands
        .slice(start)
        .map(({ command, exitCode, outputSha256 }) => ({ command, exitCode, outputSha256 })),
    };
  } finally {
    if (attached) {
      const detach = await recorder.run('dmg-detach', '/usr/bin/hdiutil', ['detach', directory]);
      requireThat(detach.exitCode === 0, `Owned DMG detach failed: ${detach.logFile}`);
    }
  }
}

async function probe(
  recorder: Recorder,
  plan: StagePlan,
  architecture: Architecture,
  temporary: string
): Promise<void> {
  requireThat(
    process.platform === 'darwin' && process.arch === architecture,
    'Signature probe requires a matching native macOS runner'
  );
  const lane: Lane = {
    schemaVersion: 1,
    inputDigest: digest(canonical(plan.input)),
    toolingSha: plan.input.toolingSha,
    sourceTag,
    sourceApplicationSha,
    architecture,
    producer: {
      repository,
      runId: integer(process.env.GITHUB_RUN_ID, 'run ID'),
      runAttempt: integer(process.env.GITHUB_RUN_ATTEMPT, 'run attempt'),
      job: process.env.GITHUB_JOB ?? '',
      runnerArch: process.env.RUNNER_ARCH ?? '',
      platform: process.platform,
    },
    scope: 'source-signatures-only',
    gatekeeperNetwork: 'online',
    dmgContainerSigning: 'unsigned',
    assets: [],
    commands: recorder.commands,
    failures: [],
    passed: false,
  };
  try {
    requireThat(
      (await recorder.text('native-architecture', '/usr/bin/uname', ['-m'])).trim() ===
        (architecture === 'arm64' ? 'arm64' : 'x86_64'),
      'Runner is not native architecture'
    );
    requireThat(
      (await recorder.text('gatekeeper-status', '/usr/sbin/spctl', ['--status'])).includes(
        'assessments enabled'
      ),
      'Gatekeeper assessment is disabled'
    );
    await recorder.text('macos-version', '/usr/bin/sw_vers', []);
    await recorder.text('xcode-version', '/usr/bin/xcodebuild', ['-version']);
    const release = await verifySource(recorder, plan, 'before');
    const feed = path.join(temporary, 'latest-mac.yml');
    await recorder.download(
      'download-source-feed',
      `repos/${repository}/releases/assets/${assetByName(release, 'latest-mac.yml').id}`,
      feed
    );
    sameProof(await fileProof(feed, 'latest-mac.yml'), original(plan, 'latest-mac.yml'));
    requireThat(
      (await readFile(feed, 'utf8')) === plan.feeds['latest-mac.yml'],
      'Source raw feed changed'
    );
    for (const pin of pins.filter((item) => item.name.includes(`-${architecture}`))) {
      try {
        lane.assets.push(await probeArchive(recorder, plan, architecture, temporary, pin));
      } catch (error) {
        lane.failures.push(
          `${pin.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    await verifySource(recorder, plan, 'after');
    lane.passed = lane.failures.length === 0 && lane.assets.length === 2;
  } catch (error) {
    lane.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await writeFile(
      path.join(recorder.directory, `mac-source-${architecture}.json`),
      `${canonical(lane)}\n`,
      { flag: 'wx' }
    );
  }
  requireThat(lane.passed, `Native source signature lane failed: ${lane.failures.join('; ')}`);
}

interface ProducerJob {
  name: string;
  conclusion: string;
  run_id: number;
  id: number;
}
async function collectLane(
  recorder: Recorder,
  plan: StagePlan,
  temporary: string,
  architecture: Architecture,
  runId: number,
  attempt: number,
  jobs: ProducerJob[],
  artifacts: Artifact[]
) {
  const job = jobs.find((item) => item.name === `mac-source-probe (${architecture})`);
  requireThat(
    job?.conclusion === 'success' && job.run_id === runId,
    `Native ${architecture} producing job did not succeed`
  );
  const name = `TEST-mac-source-lane-${architecture}-${runId}-${attempt}`;
  const matches = artifacts.filter((item) => item.name === name);
  requireThat(matches.length === 1, `Exactly one native ${architecture} artifact required`);
  const artifact = matches[0];
  requireThat(artifact, 'Missing native lane artifact');
  requireThat(
    !artifact.expired &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
      artifact.workflow_run.id === runId &&
      artifact.workflow_run.head_sha === plan.input.toolingSha,
    'Native lane artifact producer/digest mismatch'
  );
  const zip = path.join(temporary, `${architecture}-evidence.zip`);
  await recorder.download(
    `download-lane-${architecture}`,
    `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    zip
  );
  requireThat(
    (await fileProof(zip, `${architecture}-evidence.zip`)).sha256 === artifact.digest.slice(7),
    'Native lane artifact actual byte digest mismatch'
  );
  const entries = (
    await recorder.text(`lane-entries-${architecture}`, '/usr/bin/unzip', ['-Z1', zip])
  )
    .trim()
    .split('\n');
  const entry = `mac-source-${architecture}.json`;
  requireThat(
    entries.filter((item) => item === entry).length === 1,
    'Exactly one native lane result required'
  );
  const lane = JSON.parse(
    await recorder.text(`lane-result-${architecture}`, '/usr/bin/unzip', ['-p', zip, entry])
  ) as Lane;
  requireThat(
    lane.schemaVersion === 1 &&
      lane.passed &&
      lane.failures.length === 0 &&
      lane.scope === 'source-signatures-only' &&
      lane.gatekeeperNetwork === 'online' &&
      lane.dmgContainerSigning === 'unsigned',
    'Native lane failed or claimed incorrect scope'
  );
  requireThat(
    lane.inputDigest === digest(canonical(plan.input)) &&
      lane.toolingSha === plan.input.toolingSha &&
      lane.sourceTag === sourceTag &&
      lane.sourceApplicationSha === sourceApplicationSha &&
      lane.architecture === architecture,
    'Native lane immutable inputs mismatch'
  );
  requireThat(
    lane.producer.repository === repository &&
      lane.producer.runId === runId &&
      lane.producer.runAttempt === attempt &&
      lane.producer.job === 'mac-source-probe' &&
      lane.producer.platform === 'darwin' &&
      lane.producer.runnerArch === (architecture === 'arm64' ? 'ARM64' : 'X64'),
    'Native lane runner identity mismatch'
  );
  requireThat(
    lane.assets.length === 2 && new Set(lane.assets.map((asset) => asset.assetId)).size === 2,
    'Two distinct ZIP/DMG native probes required per architecture'
  );
  for (const command of lane.commands) {
    requireThat(
      /^logs\/\d{3}-[a-z0-9-]+\.log$/.test(command.logFile) &&
        entries.filter((item) => item === command.logFile).length === 1,
      'Missing or unsafe native command log'
    );
    const raw = await recorder.text(`verify-log-${architecture}`, '/usr/bin/unzip', [
      '-p',
      zip,
      command.logFile,
    ]);
    requireThat(digest(raw) === command.outputSha256, 'Native command output byte digest mismatch');
    const directory = path.join(recorder.directory, `native-${architecture}`);
    await mkdir(path.join(directory, 'logs'), { recursive: true });
    await writeFile(path.join(directory, command.logFile), raw, { flag: 'wx' });
  }
  for (const pin of pins.filter((item) => item.name.includes(`-${architecture}`))) {
    const asset = lane.assets.find((item) => item.assetId === pin.assetId);
    requireThat(
      asset?.sha256 === pin.sha256 &&
        asset.version === '2.17.1' &&
        asset.architecture === architecture &&
        asset.productMinimum === '12.0' &&
        asset.teamIdentifier === teamIdentifier,
      'Native asset byte/bundle identity mismatch'
    );
    for (const prefix of [
      'codesign --verify --deep --strict',
      'codesign --display',
      'PlistBuddy -c "Print :CFBundleShortVersionString"',
      'lipo -archs',
      'xcrun stapler validate',
      'spctl --assess',
    ])
      requireThat(
        asset.commands.some((command) => command.command.startsWith(prefix)),
        `Missing native command: ${prefix}`
      );
    requireThat(
      asset.commands.every(
        (command) =>
          command.exitCode === 0 &&
          lane.commands.some(
            (log) =>
              log.command === command.command &&
              log.exitCode === command.exitCode &&
              log.outputSha256 === command.outputSha256
          )
      ),
      'Native signature command failure or missing log'
    );
  }
  await writeFile(
    path.join(recorder.directory, `mac-source-${architecture}.json`),
    `${canonical(lane)}\n`,
    { flag: 'wx' }
  );
  return {
    assets: lane.assets,
    producer: {
      architecture,
      jobId: job.id,
      artifactId: artifact.id,
      artifactName: name,
      artifactSha256: artifact.digest.slice(7),
    },
  };
}

async function aggregate(recorder: Recorder, plan: StagePlan, temporary: string): Promise<void> {
  const runId = integer(process.env.GITHUB_RUN_ID, 'run ID');
  const attempt = integer(process.env.GITHUB_RUN_ATTEMPT, 'run attempt');
  const jobPages = JSON.parse(
    await recorder.text('native-jobs', ghBinary, [
      'api',
      `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      '--paginate',
      '--slurp',
    ])
  ) as { jobs: { name: string; conclusion: string; run_id: number; id: number }[] }[];
  const artifactPages = JSON.parse(
    await recorder.text('native-artifacts', ghBinary, [
      'api',
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      '--paginate',
      '--slurp',
    ])
  ) as { artifacts: Artifact[] }[];
  const assets: NativeProbe[] = [];
  const producers: unknown[] = [];
  for (const architecture of ['arm64', 'x64'] as const) {
    const lane = await collectLane(
      recorder,
      plan,
      temporary,
      architecture,
      runId,
      attempt,
      jobPages.flatMap((page) => page.jobs),
      artifactPages.flatMap((page) => page.artifacts)
    );
    assets.push(...lane.assets);
    producers.push(lane.producer);
  }
  await verifySource(recorder, plan, 'aggregate');
  const artifact: NativeProbeArtifact = {
    schemaVersion: 1,
    inputDigest: digest(canonical(plan.input)),
    toolingSha: plan.input.toolingSha,
    sourceTag,
    sourceApplicationSha,
    assets: pins.slice(0, 4).map((pin) => {
      const asset = assets.find((item) => item.assetId === pin.assetId);
      requireThat(asset, 'Missing aggregate source asset');
      return asset;
    }),
  };
  await writeFile(
    path.join(recorder.directory, 'mac-source-signature-evidence.json'),
    `${canonical(artifact)}\n`,
    { flag: 'wx' }
  );
  await writeFile(
    path.join(recorder.directory, 'native-producers.json'),
    `${canonical({ repository, workflowPath, runId, attempt, toolingSha: plan.input.toolingSha, producers, scope: 'source-signatures-only', gatekeeperNetwork: 'online' })}\n`,
    { flag: 'wx' }
  );
}

const optionNames = [
  'operation',
  'architecture',
  'evidence',
  'tooling-sha',
  'prepared-run-id',
  'prepared-run-attempt',
  'prepared-artifact-id',
  'prepared-artifact-sha256',
  'plan-sha256',
  'input-digest',
];
const { values } = parseArgs({
  options: Object.fromEntries(optionNames.map((name) => [name, { type: 'string' as const }])),
});
let recorder: Recorder | undefined;
let temporary: string | undefined;
try {
  requireThat(
    process.env.GITHUB_ACTIONS === 'true' &&
      process.env.GITHUB_REPOSITORY === repository &&
      process.env.GITHUB_WORKFLOW_REF?.startsWith(`${repository}/${workflowPath}@`),
    'This probe is restricted to its disposable GitHub Actions workflow'
  );
  const runnerTemporary = process.env.RUNNER_TEMP;
  requireThat(runnerTemporary, 'Missing disposable runner temporary root');
  const root = await realpath(runnerTemporary);
  const directory = path.resolve(values.evidence ?? '');
  requireThat(
    directory.startsWith(`${root}${path.sep}TEST-mac-source-`) &&
      !(await readdir(root)).includes(path.basename(directory)),
    'Evidence must be a new owned TEST directory under RUNNER_TEMP'
  );
  await mkdir(path.join(directory, 'logs'), { recursive: true });
  recorder = new Recorder(directory);
  temporary = await mkdtemp(path.join(root, 'TEST-mac-source-inputs-'));
  const plan = await preparedPlan(
    recorder,
    values as Record<string, string | undefined>,
    temporary
  );
  if (values.operation === 'probe') {
    requireThat(
      values.architecture === 'arm64' || values.architecture === 'x64',
      'Native architecture required'
    );
    await probe(recorder, plan, values.architecture, temporary);
  } else {
    requireThat(values.operation === 'aggregate', 'Operation must be probe or aggregate');
    await aggregate(recorder, plan, temporary);
  }
} catch (error) {
  const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
  if (recorder)
    await writeFile(
      path.join(recorder.directory, 'failure.json'),
      `${canonical({ failed: true, failure, commands: recorder.commands })}\n`
    );
} finally {
  if (recorder)
    await writeFile(
      path.join(recorder.directory, 'command-index.json'),
      `${canonical(recorder.commands)}\n`
    );
  // Extraction/mount state is disposable. Never remove an uncertain still-mounted volume.
  if (temporary && process.exitCode !== 1) await rm(temporary, { recursive: true, force: true });
}
