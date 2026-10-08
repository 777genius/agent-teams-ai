// @vitest-environment node
import assert from 'node:assert/strict';

import { describe, expect, it } from 'vitest';

import {
  canonical,
  digest,
  MANIFEST,
  manifestFor,
  platformNames,
  textProof,
} from '../../scripts/ci/release/contract.js';
import {
  checkWindowsPriorFixture,
  nativeScenarioRows,
  verifyNativeReadiness,
} from '../../scripts/ci/release/nativeReadiness.js';
import {
  ARM211_FILES,
  ARM211_SHA,
  DECODER_ARCHIVE_SHA,
} from '../../scripts/ci/release/windowsArmPriorFixture.js';

// Independent labels from the official W11 run 37704738528 jobs response.
it('matches official Windows matrix job names without treating included architecture as an OTA axis', () => {
  const rows = nativeScenarioRows(37704738528, 1).filter((row) => row.kind === 'windows');
  expect(rows.map((row) => [row.scenario, row.jobName])).toEqual([
    ['windows-x64-fresh', 'fresh-windows (windows-2025, x64)'],
    ['windows-x64-full', 'windows-ota (windows-2025, full)'],
    ['windows-x64-cold', 'windows-ota (windows-2025, cold)'],
    ['windows-x64-warm', 'windows-ota (windows-2025, warm)'],
    ['windows-arm64-fresh', 'fresh-windows (windows-11-arm, arm64)'],
    ['windows-arm64-full', 'windows-ota (windows-11-arm, full)'],
    ['windows-arm64-cold', 'windows-ota (windows-11-arm, cold)'],
    ['windows-arm64-warm', 'windows-ota (windows-11-arm, warm)'],
  ]);
});

// Receipt policy only: these synthetic claims never qualify a native run.
it('requires honest byte-bound repaired ARM211 receipts only for216 predecessor cases', () => {
  const bytes = {
    size: 100,
    sha256: 'a'.repeat(64),
    sha512: Buffer.alloc(64, 2).toString('base64'),
  };
  const prior = { ...bytes, size: 196906862, sha256: ARM211_SHA };
  const install = String.raw`C:\TEST-updater-windows-fixture\install`;
  const receipt = {
    fixtureKind: 'repaired-original-arm64-211',
    originalPriorFreshInstallProved: false,
    actualNsisExitCode: 0,
    source: prior,
    sourceApplicationSha: '395572f9ff2a261cb28224754883a39d2c3c8827',
    archive: bytes,
    decoder: {
      archive: { ...bytes, size: 491981, sha256: DECODER_ARCHIVE_SHA },
      executable: bytes,
    },
    preserved: {
      'resources/app.asar': bytes,
      'resources/app-update.yml': bytes,
      'cache/installer.exe': prior,
      'Uninstall AgentTeamsAI.exe': bytes,
    },
    registry: {
      installLocation: install,
      uninstallString: `"${install}\\Uninstall AgentTeamsAI.exe" /currentuser`,
      quietUninstallString: `"${install}\\Uninstall AgentTeamsAI.exe" /currentuser /S`,
      version: '2.17.1',
    },
    files: ARM211_FILES.map((name) => ({
      name: String(name),
      source: { ...bytes },
      installed: { ...bytes },
      architecture: 'arm64',
    })),
  };
  const value = {
    predecessorFixture: receipt,
    initialInstall: { code: 0, arguments: ['/S', `/D=${install}`] },
    installedBefore: { packageVersion: '2.17.1' },
  };
  expect(() => checkWindowsPriorFixture(value, 'arm64', 'cold', '2.17.6')).not.toThrow();
  const mutations = [
    (v: typeof value) => {
      v.predecessorFixture.originalPriorFreshInstallProved = true;
    },
    (v: typeof value) => {
      v.predecessorFixture.source.sha256 = '0'.repeat(64);
    },
    (v: typeof value) => {
      v.predecessorFixture.decoder.archive.sha256 = '0'.repeat(64);
    },
    (v: typeof value) => {
      const file = v.predecessorFixture.files[0];
      assert(file);
      file.architecture = 'x64';
    },
    (v: typeof value) => {
      const file = v.predecessorFixture.files[0];
      assert(file);
      file.installed.sha256 = '0'.repeat(64);
    },
    (v: typeof value) => {
      const file = v.predecessorFixture.files[0];
      assert(file);
      file.name = 'unexpected.exe';
    },
    (v: typeof value) => {
      v.predecessorFixture.registry.installLocation = 'C:\\foreign';
    },
    (v: typeof value) => {
      v.predecessorFixture.registry.uninstallString = '"C:\\foreign\\uninstall.exe" /currentuser';
    },
    (v: typeof value) => {
      v.initialInstall.code = 1;
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(value);
    mutate(invalid);
    expect(() => checkWindowsPriorFixture(invalid, 'arm64', 'cold', '2.17.6')).toThrow();
  }
  expect(() => checkWindowsPriorFixture({}, 'arm64', 'cold', '2.17.6')).toThrow();
  for (const [arch, mode, version] of [
    ['x64', 'cold', '2.17.6'],
    ['arm64', 'fresh', '2.17.6'],
    ['arm64', 'cold', '2.17.5'],
  ] as const) {
    expect(() => checkWindowsPriorFixture(value, arch, mode, version)).toThrow();
    expect(() => checkWindowsPriorFixture({}, arch, mode, version)).not.toThrow();
  }
});

import type { StagePlan } from '../../scripts/ci/release/contract.js';
import type {
  NativeArtifact,
  NativeJob,
  NativeReadinessPort,
  NativeReadinessReceipt,
  NativeRun,
} from '../../scripts/ci/release/nativeReadiness.js';

// This contract test becomes red if publication accepts a forged, stale, skipped or partial native proof.
function fixture() {
  const toolingSha = 'a'.repeat(40);
  const applicationSha = 'b'.repeat(40);
  const p = 'c'.repeat(64);
  const proof = (name: string) => textProof(name, name);
  const snapshot = {
    id: 123,
    tag: 'v2.17.4',
    applicationSha,
    createdAt: '2026-10-06T00:00:00Z',
    name: 'Release',
    body: '',
  };
  const plan: StagePlan = {
    schemaVersion: 1,
    input: {
      repository: '777genius/agent-teams-ai',
      mode: 'carry-mac',
      toolingSha,
      target: snapshot,
      latest: { id: 120, tag: 'v2.17.1' },
      originals: [],
      macSource: { release: { ...snapshot, id: 120, tag: 'v2.17.1' }, productMinimum: '12.0' },
      build: { runId: 1, attempt: 1, jobIds: [2] },
      macProductMinimum: '12.0',
    },
    feeds: { 'latest-mac.yml': 'carried feed' },
    aliases: {},
    outputs: [
      ...platformNames('2.17.4').windows.flatMap((name) => [name, `${name}.blockmap`]),
      ...platformNames('2.17.4').linux,
      ...platformNames('2.17.1').mac,
    ].map(proof),
  };
  const d = digest(canonical(plan.input));
  const manifest = textProof(MANIFEST, `${canonical(manifestFor(plan))}\n`);
  const start = '2026-10-06T01:00:00Z',
    finish = '2026-10-06T01:10:00Z',
    uploadStart = '2026-10-06T01:10:01Z',
    end = '2026-10-06T01:10:10Z';
  const runs = new Map<number, NativeRun>();
  const jobs = new Map<number, NativeJob[]>();
  const artifacts = new Map<number, NativeArtifact>();
  const sources = new Map<string, string>();
  const archives = new Map<number, { sha256: string; entries: Record<string, Buffer> }>();
  const values = new Map<string, Record<string, unknown>>();
  const receipt: NativeReadinessReceipt = {
    schemaVersion: 1,
    repository: plan.input.repository,
    toolingSha,
    planSha256: p,
    inputDigest: d,
    applicationSha,
    targetReleaseId: 123,
    artifacts: [],
  };
  const events = (version: string) => [{ type: 'not-available', version }];
  const signature = (architecture: string, version = '2.17.1') => ({
    architecture,
    version,
    productMinimum: '12.0',
    teamIdentifier: '6C84CW694S',
  });
  const rows = nativeScenarioRows(200, 2);
  const paths = [...new Set(rows.map((row) => row.workflow))];
  for (const [index, workflow] of paths.entries()) {
    const runId = 200 + index;
    const subset = nativeScenarioRows(runId, 2).filter((row) => row.workflow === workflow);
    runs.set(runId, {
      id: runId,
      run_attempt: 2,
      head_sha: toolingSha,
      path: workflow,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      repository: { full_name: plan.input.repository },
    });
    const sourceJobs: Record<string, unknown> = {};
    const name =
      index === 0
        ? 'verified-windows-inputs'
        : index === 1
          ? 'verified-inputs'
          : index === 2
            ? 'inputs'
            : 'prepare-mac-inputs';
    const preparation =
      index === 0
        ? 'Verify immutable native producer and extract exact plan-bound inputs'
        : index === 1
          ? 'Read exact official predecessor and draft bytes'
          : index === 2
            ? 'Download and verify immutable official packages'
            : 'Authenticate and hash real release inputs without native application execution';
    const stepNames = [preparation];
    if (index === 1 || index === 2)
      stepNames.push(
        'Require explicit prepared artifact identity',
        index === 1
          ? 'Download immutable prepared stage'
          : 'Download immutable prepared stage for the current target'
      );
    if (index >= 3) stepNames.push('Upload authenticated immutable Mac inputs');
    jobs.set(runId, [
      {
        id: 3000 + index,
        run_id: runId,
        run_attempt: 2,
        head_sha: toolingSha,
        name,
        status: 'completed',
        conclusion: 'success',
        started_at: start,
        completed_at: finish,
        steps: stepNames.map((step) => ({
          name: step,
          status: 'completed',
          conclusion: 'success',
          started_at: start,
          completed_at: finish,
        })),
      },
    ]);

    for (const artifactName of new Set(subset.map((row) => row.artifact))) {
      const grouped = subset.filter((row) => row.artifact === artifactName);
      const row = grouped[0]!;
      const jobId = 1000 + artifacts.size;
      const artifactId = 2000 + artifacts.size;
      const archiveSha = digest(artifactName);
      const success = {
        status: 'completed',
        conclusion: 'success',
        started_at: start,
        completed_at: finish,
      };
      const job: NativeJob = {
        ...success,
        id: jobId,
        run_id: runId,
        run_attempt: 2,
        head_sha: toolingSha,
        name: row.jobName,
        completed_at: end,
        steps: [
          { ...success, name: row.execute },
          { ...success, name: row.upload, started_at: uploadStart, completed_at: end },
        ],
      };
      jobs.set(runId, [...(jobs.get(runId) ?? []), job]);
      sourceJobs[row.job] = {
        steps: [
          { name: row.execute, run: 'execute pinned native harness' },
          { name: row.upload, uses: 'actions/upload-artifact@v7' },
        ],
      };
      artifacts.set(artifactId, {
        id: artifactId,
        name: artifactName,
        digest: `sha256:${archiveSha}`,
        expired: false,
        created_at: uploadStart,
        workflow_run: { id: runId, head_sha: toolingSha },
      });
      const archive = { sha256: archiveSha, entries: {} as Record<string, Buffer> };
      archives.set(artifactId, archive);
      const reference = {
        runId,
        runAttempt: 2,
        jobId,
        artifactId,
        artifactName,
        artifactSha256: archiveSha,
        entries: [] as NativeReadinessReceipt['artifacts'][number]['entries'],
      };
      receipt.artifacts.push(reference);
      for (const current of grouped) {
        const value: Record<string, unknown> = { passed: true, finishedAt: finish };
        if (current.kind === 'windows')
          Object.assign(value, {
            mode: current.mode,
            arch: current.architecture,
            finalReleaseProved: true,
            finalPromotionFeed: true,
            inputDigest: d,
            targetBinding: {
              plan: { input: plan.input, sha256: p },
              legacyFixture: false,
              targetVersion: '2.17.4',
              stagedMetadata: { releaseId: 123 },
            },
            inputs: plan.outputs,
            cleanup: { passed: true },
            initialInstall: {},
            installedBefore: { packageVersion: '2.17.4', architecture: current.architecture },
            initialLaunch: {},
            signatures: {},
            desktopSession: {},
            freshInstallProved: true,
            nativeWindow: {},
            events: { events: events('2.17.4') },
            fullOtaProved: true,
            automaticSuccessorProved: true,
            automaticSuccessor: {
              installed: { packageVersion: '2.17.4', architecture: current.architecture },
            },
            automaticWindow: {},
            downloadedInstaller: {
              hash: {
                sha256: plan.outputs.find(
                  (item) =>
                    item.name ===
                    platformNames('2.17.4').windows[current.architecture === 'x64' ? 0 : 1]
                )!.sha256,
              },
            },
            downloadMode: { mode: current.mode, differentialProved: current.mode !== 'full' },
            installerProcesses: [{ command: 'setup --updated /S --force-run' }],
            profileAfterAutomatic: { general: { theme: 'light' } },
            postUpdate: {
              events: { events: events('2.17.4') },
              profile: { general: { theme: 'light' } },
            },
          });
        else if (current.kind === 'package' || current.kind === 'appimage') {
          const packageKind = current.scenario.split('-')[1]!;
          Object.assign(value, {
            scope:
              current.kind === 'appimage'
                ? current.mode === 'fresh'
                  ? 'Linux AppImage native fresh installation'
                  : 'Linux AppImage native OTA from 2.17.1'
                : `Linux ${packageKind} ${current.mode}`,
            mode: current.mode,
            stageBoundScenarioProved: true,
            sandboxEnabled: true,
            historicalPreview: false,
            targetVersion: '2.17.4',
            binding: {
              manifestBound: true,
              inputDigest: d,
              planSha256: p,
              manifestSha256: manifest.sha256,
            },
            inputs:
              current.kind === 'appimage'
                ? [
                    {
                      name: 'Agent.Teams.AI-2.17.1.AppImage',
                      size: 273263953,
                      sha256: '02c35d4497f019e02d6fca113ad25ffbd9b63c6ca3c7ae71286cd8af309799e6',
                    },
                    {
                      name: 'agent-teams-ai_2.17.1_amd64.deb',
                      size: 193985224,
                      sha256: 'd2daf11bc93fde813d1df2fef25bfc5d6beebd419f7d47b8082d8da9e0ccf6ec',
                    },
                    plan.outputs.find((item) => item.name === 'Agent.Teams.AI-2.17.4.AppImage')!,
                  ]
                : plan.outputs,
            isolation: {},
            postUpdate: { noInstallerGet: true, preference: 'light' },
            automaticSuccessorProved: true,
            sandbox: {
              canonicalGatePassed: true,
              samples: [{ noSandbox: false, command: ['app'] }],
            },
            freshPackage: {},
            freshDesktop: {},
            successor: {},
            automaticWindow: {},
            container: {
              uid: 1000,
              osRelease: `ID=${{ deb: 'ubuntu', rpm: 'fedora', pacman: 'arch' }[packageKind as 'deb' | 'rpm' | 'pacman']}`,
            },
            initialPackage: {},
            automaticLaunchSeal: {
              launch: { command: ['app'], home: '/TEST-home', userData: '/TEST-profile' },
              target: { sha256: 'payload' },
            },
            automaticSealAfterPaint: {
              command: ['app'],
              markers: { HOME: '/TEST-home', AGENT_TEAMS_ELECTRON_USER_DATA_DIR: '/TEST-profile' },
              payload: { sha256: 'payload' },
            },
            automaticPackage: {},
            automaticDesktop: {},
            finalReleaseAcceptance: false,
          });
        } else {
          const os = {
            command: '/usr/bin/sw_vers -productVersion',
            exitCode: 0,
            stdout: '15.6\n',
            stderr: '',
            outputSha256: digest('stdout:\n15.6\n\nstderr:\n'),
          };
          Object.assign(value, {
            finalPromotionFeed: true,
            planBindingVerified: true,
            feedMode: 'staged',
            targetApplicationSha: applicationSha,
            testedOperatingSystem: '15.6',
            commands: [os],
            inputs: {
              planSha256: p,
              inputDigest: d,
              toolingSha,
              targetBefore: { id: 123, target_commitish: applicationSha, tag_name: 'v2.17.4' },
              targetAfter: { id: 123, target_commitish: applicationSha, tag_name: 'v2.17.4' },
              binding: {
                inputDigest: d,
                manifest,
                draftFeed: { releaseId: 123, proof: textProof('latest-mac.yml', 'carried feed') },
              },
              downloads: plan.outputs
                .filter((item) => item.name.includes('2.17.1'))
                .map((item) => ({ proof: item })),
            },
            scenario:
              current.kind === 'mac-current'
                ? 'mac-current-no-update'
                : current.mode === 'older'
                  ? 'mac-2.17.0-to-carried-2.17.1'
                  : 'mac-fresh-2.17.1',
            architecture: current.architecture,
            signatureBefore: signature(
              current.architecture,
              current.mode === 'older' ? '2.17.0' : '2.17.1'
            ),
            signatureAfter: signature(current.architecture),
            signatureFinal: signature(current.architecture),
            signatureAfterAutomatic: signature(current.architecture),
            renderedNoUpdate: 'Up to date',
            nativeWindow: {},
            observation: { events: events('2.17.1') },
            noUpdate: { checked: { events: events('2.17.1') } },
            postUpdate: { checked: { events: events('2.17.1') } },
            automaticSuccessorProved: true,
            automaticSuccessor: {},
            automaticDesktop: {},
            diagnosticRelaunchOnly: false,
            minimumOsExecutionProved: false,
          });
        }
        values.set(current.scenario, value);
        const bytes = Buffer.from(JSON.stringify(value));
        archive.entries[current.path] = bytes;
        reference.entries.push({
          scenario: current.scenario,
          path: current.path,
          sha256: digest(bytes),
          sealedSha256: digest(canonical(value)),
        });
      }
    }
    sources.set(workflow, JSON.stringify({ jobs: sourceJobs }));
  }
  const port: NativeReadinessPort = {
    run: async (_, key) => runs.get(key)!,
    jobs: async (_, key) => jobs.get(key)!,
    artifact: async (_, key) => artifacts.get(key)!,
    workflow: async (_, __, key) => sources.get(key)!,
    archive: async (_, key) => archives.get(key)!,
  };
  function reseal(scenario: string) {
    const ref = receipt.artifacts.find((item) =>
      item.entries.some((entry) => entry.scenario === scenario)
    )!;
    const entry = ref.entries.find((item) => item.scenario === scenario)!;
    const value = values.get(scenario)!;
    const bytes = Buffer.from(JSON.stringify(value));
    archives.get(ref.artifactId)!.entries[entry.path] = bytes;
    entry.sha256 = digest(bytes);
    entry.sealedSha256 = digest(canonical(value));
  }
  return { plan, p, port, receipt, jobs, runs, archives, values, reseal };
}
describe('native readiness publication boundary', () => {
  it('accepts exactly 22 actual closed scenarios in 18 authenticated outcomes, with Linux historical flag false and Mac12 unclaimed', async () => {
    const f = fixture();
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).resolves.toBeUndefined();
  });
  it('rejects a native family assembled from two individually successful current runs', async () => {
    const f = fixture();
    const reference = f.receipt.artifacts.find((item) =>
      item.entries.some((entry) => entry.scenario === 'windows-x64-fresh')
    );
    assert(reference);
    const run = f.runs.get(reference.runId);
    const jobs = f.jobs.get(reference.runId);
    assert(run && jobs);
    const runId = 299;
    f.runs.set(runId, { ...structuredClone(run), id: runId });
    f.jobs.set(
      runId,
      jobs.map((job) => ({ ...structuredClone(job), id: job.id + 10_000, run_id: runId }))
    );
    const row = nativeScenarioRows(runId, reference.runAttempt).find(
      (item) => item.scenario === 'windows-x64-fresh'
    );
    assert(row);
    reference.runId = runId;
    reference.jobId += 10_000;
    reference.artifactName = row.artifact;
    const artifact = await f.port.artifact(f.receipt.repository, reference.artifactId);
    artifact.name = row.artifact;
    artifact.workflow_run.id = runId;
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow(
      'Mixed native family runs'
    );
  });
  it('keeps schema2 closed for any other plan despite caller-selected executor claims', async () => {
    const f = fixture();
    Object.assign(f.receipt, { schemaVersion: 2, executions: { windows: 'e'.repeat(40) } });
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow(
      'original closed release216 plan'
    );
  });
  it('does not authorize a different actual executor through schema1 caller role claims', async () => {
    const f = fixture();
    Object.assign(f.receipt, { executions: { windows: 'e'.repeat(40) } });
    f.runs.get(200)!.head_sha = 'e'.repeat(40);
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow(
      'native tooling SHA'
    );
  });
  for (const conclusion of ['failure', 'skipped'])
    it(`rejects a whole ${conclusion} native run with successful selected jobs`, async () => {
      const f = fixture();
      f.runs.get(200)!.conclusion = conclusion;
      await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow(
        'native run'
      );
    });
  it('rejects altered target AppImage bytes in the authentic three-entry producer ledger', async () => {
    const f = fixture();
    const value = f.values.get('linux-appimage-ota')!;
    const inputs = value.inputs as { name: string; sha256: string }[];
    expect(inputs).toHaveLength(3);
    inputs.find((item) => item.name === 'Agent.Teams.AI-2.17.4.AppImage')!.sha256 = 'f'.repeat(64);
    f.reseal('linux-appimage-ota');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects a skipped native execution even when preparation and upload succeeded', async () => {
    const f = fixture();
    f.jobs.get(200)![1]!.steps[0]!.conclusion = 'skipped';
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects stale attempt artifacts', async () => {
    const f = fixture();
    f.runs.get(200)!.run_attempt = 3;
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects a partial two-scenario artifact', async () => {
    const f = fixture();
    f.receipt.artifacts.find((item) => item.entries.length === 2)!.entries.pop();
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects altered downloaded archives despite matching claimed artifact metadata', async () => {
    const f = fixture();
    f.archives.get(2000)!.sha256 = 'f'.repeat(64);
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects resealed Windows evidence for another target plan', async () => {
    const f = fixture();
    (f.values.get('windows-x64-fresh')!.targetBinding as { plan: { sha256: string } }).plan.sha256 =
      'e'.repeat(64);
    f.reseal('windows-x64-fresh');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects forged Linux sandbox success with an actual no-sandbox command', async () => {
    const f = fixture();
    (
      f.values.get('linux-appimage-ota')!.sandbox as { samples: { command: string[] }[] }
    ).samples[0]!.command.push('--no-sandbox');
    f.reseal('linux-appimage-ota');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects missing genuine Mac no-update even if passed was resealed', async () => {
    const f = fixture();
    f.values.get('mac-arm64-current')!.observation = { events: [] };
    f.reseal('mac-arm64-current');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it('rejects a changed sealed Linux successor profile', async () => {
    const f = fixture();
    (
      f.values.get('linux-deb-ota')!.automaticSealAfterPaint as { markers: { HOME: string } }
    ).markers.HOME = '/user-project';
    f.reseal('linux-deb-ota');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
});
