import { validateNativeArchivePaths } from '../../scripts/ci/release/nativeReadinessGithub.js';
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- Pinned release TS7 enables noUncheckedIndexedAccess; the renderer lint project does not. */
import { promoteExistingDraft } from '../../scripts/ci/promote-existing-draft.mjs';
import { writeFile } from 'node:fs/promises';
import { publishFullRelease } from '../../scripts/ci/release/publication.js';
import type { PublicationPort } from '../../scripts/ci/release/publication.js';
import { manualCapturePaths } from '../../scripts/ci/release/macManualReadiness.js';
// @vitest-environment node
import assert from 'node:assert/strict';

import { describe, expect, it } from 'vitest';

import {
  canonical,
  compareNames,
  aliases,
  renderFeed,
  digest,
  MANIFEST,
  manifestFor,
  platformNames,
  textProof,
} from '../../scripts/ci/release/contract.js';
import {
  checkWindowsPriorFixture,
  nativeScenarioRows,
  fullNativeScenarioRows,
  verifyNativeReadiness,
} from '../../scripts/ci/release/nativeReadiness.js';
import {
  ARM211_FILES,
  ARM211_SHA,
  DECODER_ARCHIVE_SHA,
  usesRepairedArm211,
} from '../../scripts/ci/release/windowsArmPriorFixture.js';
import { finalWindowsReleaseProved } from '../../scripts/ci/release/windowsReleaseScenario.js';

// Receipt policy only: these synthetic claims never qualify a native run.
it('requires honest byte-bound repaired ARM211 receipts for216/217 predecessor cases', () => {
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
  for (const targetVersion of ['2.17.6', '2.17.7'])
    expect(() => checkWindowsPriorFixture(value, 'arm64', 'cold', targetVersion)).not.toThrow();
  const mutations = [
    (v: typeof value) => {
      v.predecessorFixture.originalPriorFreshInstallProved = true;
    },
    (v: typeof value) => {
      v.predecessorFixture.source.sha256 = '0'.repeat(64);
    },
    (v: typeof value) => {
      v.predecessorFixture.sourceApplicationSha = '0'.repeat(40);
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
    for (const targetVersion of ['2.17.6', '2.17.7'])
      expect(() => checkWindowsPriorFixture(invalid, 'arm64', 'cold', targetVersion)).toThrow();
  }
  for (const targetVersion of ['2.17.6', '2.17.7'])
    expect(() => checkWindowsPriorFixture({}, 'arm64', 'cold', targetVersion)).toThrow();
  for (const [arch, mode, version] of [
    ['x64', 'cold', '2.17.6'],
    ['arm64', 'fresh', '2.17.6'],
    ['arm64', 'cold', '2.17.5'],
  ] as const) {
    expect(() => checkWindowsPriorFixture(value, arch, mode, version)).toThrow();
    expect(() => checkWindowsPriorFixture({}, arch, mode, version)).not.toThrow();
  }
});

it('selects repaired original ARM211 for reviewed predecessor probes and OTA scenarios', () => {
  for (const version of ['2.17.6', '2.17.7']) {
    for (const mode of ['predecessor', 'full', 'cold', 'warm']) {
      expect(usesRepairedArm211('arm64', mode, version)).toBe(true);
      expect(usesRepairedArm211('x64', mode, version)).toBe(false);
    }
    expect(usesRepairedArm211('arm64', 'fresh', version)).toBe(false);
    expect(usesRepairedArm211('arm64', 'unsupported', version)).toBe(false);
  }
  for (const version of ['2.17.5', '2.17.8', '2.18.0', '2.17.7-beta.1']) {
    for (const mode of ['predecessor', 'full', 'cold', 'warm']) {
      expect(usesRepairedArm211('arm64', mode, version)).toBe(false);
    }
  }
});

it.each(['2.17.6', '2.17.7'])(
  'marks only successful plan-bound Windows %s native proofs as final',
  (targetVersion) => {
    // Synthetic predicate inputs prove policy only; they never qualify a native execution.
    const valid = {
      architecture: 'arm64',
      mode: 'cold',
      targetVersion,
      legacyFixture: false,
      plan: { input: { target: { tag: `v${targetVersion}`, id: 1234 } } },
      stagedMetadata: { releaseId: 1234 },
      passed: true,
      freshInstallProved: false,
      fullOtaProved: true,
    };
    for (const architecture of ['x64', 'arm64']) {
      for (const mode of ['full', 'cold', 'warm']) {
        expect(finalWindowsReleaseProved({ ...valid, architecture, mode })).toBe(true);
      }
      expect(
        finalWindowsReleaseProved({
          ...valid,
          architecture,
          mode: 'fresh',
          freshInstallProved: true,
          fullOtaProved: false,
        })
      ).toBe(true);
    }
    for (const change of [
      { passed: false },
      { fullOtaProved: false },
      { legacyFixture: true },
      { plan: undefined },
      { stagedMetadata: undefined },
      { stagedMetadata: { releaseId: 9999 } },
      { plan: { input: { target: { tag: 'v2.17.5', id: 1234 } } } },
      { targetVersion: '2.17.8' },
      { architecture: 'ia32' },
      { mode: 'unsupported' },
      { mode: 'fresh', freshInstallProved: false },
    ]) {
      expect(finalWindowsReleaseProved({ ...valid, ...change })).toBe(false);
    }
  }
);

import type { StagePlan, Release } from '../../scripts/ci/release/contract.js';
import type {
  NativeArtifact,
  NativeJob,
  NativeReadinessPort,
  NativeReadinessReceipt,
  NativeRun,
} from '../../scripts/ci/release/nativeReadiness.js';

// This contract test becomes red if publication accepts a forged, stale, skipped or partial native proof.
// The closed synthetic matrix is intentionally kept together for scenario mutation tests.
// eslint-disable-next-line sonarjs/cognitive-complexity
function fixture(full = false) {
  const targetVersion = full ? '2.17.7' : '2.17.4';
  const scenarioRows = full ? fullNativeScenarioRows : nativeScenarioRows;
  const toolingSha = full ? 'b'.repeat(40) : 'a'.repeat(40);
  const applicationSha = 'b'.repeat(40);
  const p = 'c'.repeat(64);
  const proof = (name: string) => textProof(name, name);
  const snapshot = {
    id: 123,
    tag: `v${targetVersion}`,
    applicationSha,
    createdAt: '2026-10-06T00:00:00Z',
    name: 'Release',
    body: '',
  };
  const plan: StagePlan = {
    schemaVersion: 1,
    input: {
      repository: '777genius/agent-teams-ai',
      mode: full ? 'full' : 'carry-mac',
      toolingSha,
      target: snapshot,
      latest: { id: 120, tag: 'v2.17.1' },
      originals: [],
      ...(full
        ? { macSource: null }
        : {
            macSource: {
              release: { ...snapshot, id: 120, tag: 'v2.17.1' },
              productMinimum: '12.0',
            },
          }),
      build: { runId: 1, attempt: 1, jobIds: [2] },
      macProductMinimum: full ? '13.0' : '12.0',
    },
    feeds: { 'latest-mac.yml': 'carried feed' },
    aliases: {},
    outputs: [
      ...platformNames(targetVersion).windows.flatMap((name) => [name, `${name}.blockmap`]),
      ...platformNames(targetVersion).linux,
      ...platformNames(full ? targetVersion : '2.17.1').mac,
    ].map(proof),
  };
  if (full) {
    plan.input.macSource = null;
    plan.input.originals = plan.outputs.map((item, index) => ({
      ...item,
      assetId: 500 + index,
      releaseId: plan.input.target.id,
      tag: plan.input.target.tag,
    }));
    plan.aliases = aliases(targetVersion, targetVersion);
    const names = platformNames(targetVersion);
    plan.feeds = Object.fromEntries(
      [
        ['latest.yml', names.windows],
        ['latest-linux.yml', names.linux],
        ['latest-mac.yml', names.mac],
      ].map(([name, files]) => [
        name,
        renderFeed(
          targetVersion,
          (files as string[]).map((name) => plan.outputs.find((item) => item.name === name)!),
          plan.input.target.createdAt,
          name === 'latest-mac.yml' ? '22.0.0' : undefined
        ),
      ])
    );
    plan.outputs = [
      ...plan.outputs,
      ...Object.entries(plan.aliases).map(([name, source]) => ({
        ...plan.outputs.find((item) => item.name === source)!,
        name,
      })),
      ...Object.entries(plan.feeds).map(([name, raw]) => textProof(name, raw)),
    ].sort((a, b) => compareNames(a.name, b.name));
  }
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
    schemaVersion: full ? 2 : 1,
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
  const rows = scenarioRows(200, 2);
  const paths = [...new Set(rows.map((row) => row.workflow))];
  for (const [index, workflow] of paths.entries()) {
    const runId = 200 + index;
    const subset = scenarioRows(runId, 2).filter((row) => row.workflow === workflow);
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
    const producerNames = [
      'verified-windows-inputs',
      'verified-inputs',
      'inputs',
      full ? 'prepare-mac-manual-inputs' : 'prepare-mac-inputs',
    ];
    const preparations = [
      'Verify immutable native producer and extract exact plan-bound inputs',
      'Read exact official predecessor and draft bytes',
      'Download and verify immutable official packages',
      full
        ? 'Authenticate prepared plan and uploaded original 211 and target 217 bytes'
        : 'Authenticate and hash real release inputs without native application execution',
    ];
    const name = producerNames[index] ?? 'prepare-mac-inputs';
    const preparation =
      preparations[index] ??
      'Authenticate and hash real release inputs without native application execution';
    const stepNames = [preparation];
    if (index === 1 || index === 2)
      stepNames.push(
        'Require explicit prepared artifact identity',
        index === 1
          ? 'Download immutable prepared stage'
          : 'Download immutable prepared stage for the current target'
      );
    if (index >= 3)
      stepNames.push(
        full
          ? 'Upload authenticated manual migration inputs'
          : 'Upload authenticated immutable Mac inputs'
      );
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
        if (current.kind === 'windows') {
          Object.assign(value, {
            mode: current.mode,
            arch: current.architecture,
            finalReleaseProved: true,
            finalPromotionFeed: true,
            inputDigest: d,
            targetBinding: {
              plan: { input: plan.input, sha256: p },
              legacyFixture: false,
              targetVersion: targetVersion,
              stagedMetadata: { releaseId: 123 },
            },
            inputs: plan.outputs,
            cleanup: { passed: true },
            initialInstall: {},
            installedBefore: { packageVersion: targetVersion, architecture: current.architecture },
            initialLaunch: {},
            signatures: {},
            desktopSession: {},
            freshInstallProved: true,
            nativeWindow: {},
            events: { events: events(targetVersion) },
            fullOtaProved: true,
            automaticSuccessorProved: true,
            automaticSuccessor: {
              installed: { packageVersion: targetVersion, architecture: current.architecture },
            },
            automaticWindow: {},
            downloadedInstaller: {
              hash: {
                sha256: plan.outputs.find(
                  (item) =>
                    item.name ===
                    platformNames(targetVersion).windows[current.architecture === 'x64' ? 0 : 1]
                )!.sha256,
              },
            },
            downloadMode: { mode: current.mode, differentialProved: current.mode !== 'full' },
            installerProcesses: [{ command: 'setup --updated /S --force-run' }],
            profileAfterAutomatic: { general: { theme: 'light' } },
            postUpdate: {
              events: { events: events(targetVersion) },
              profile: { general: { theme: 'light' } },
            },
          });
          if (full && current.architecture === 'arm64' && current.mode !== 'fresh')
            Object.assign(value, fullArmPriorFixture());
        } else if (current.kind === 'package' || current.kind === 'appimage') {
          const packageKind = current.scenario.split('-')[1];
          const appimageScope =
            current.mode === 'fresh'
              ? 'Linux AppImage native fresh installation'
              : 'Linux AppImage native OTA from 2.17.1';
          Object.assign(value, {
            scope:
              current.kind === 'appimage' ? appimageScope : `Linux ${packageKind} ${current.mode}`,
            mode: current.mode,
            stageBoundScenarioProved: true,
            sandboxEnabled: true,
            historicalPreview: false,
            targetVersion: targetVersion,
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
                    plan.outputs.find(
                      (item) => item.name === `Agent.Teams.AI-${targetVersion}.AppImage`
                    )!,
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
        } else if (current.kind === 'mac-manual') {
          Object.assign(
            value,
            manualValue(plan, p, d, current.architecture, runId, archive.entries)
          );
        } else {
          const os = {
            command: '/usr/bin/sw_vers -productVersion',
            exitCode: 0,
            stdout: '15.6\n',
            stderr: '',
            outputSha256: digest('stdout:\n15.6\n\nstderr:\n'),
          };
          const macScenario =
            current.mode === 'older' ? 'mac-2.17.0-to-carried-2.17.1' : 'mac-fresh-2.17.1';
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
              targetBefore: {
                id: 123,
                target_commitish: applicationSha,
                tag_name: `v${targetVersion}`,
              },
              targetAfter: {
                id: 123,
                target_commitish: applicationSha,
                tag_name: `v${targetVersion}`,
              },
              binding: {
                inputDigest: d,
                manifest,
                draftFeed: { releaseId: 123, proof: textProof('latest-mac.yml', 'carried feed') },
              },
              downloads: plan.outputs
                .filter((item) => item.name.includes('2.17.1'))
                .map((item) => ({ proof: item })),
            },
            scenario: current.kind === 'mac-current' ? 'mac-current-no-update' : macScenario,
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
    run: (_, key) => Promise.resolve(runs.get(key)!),
    jobs: (_, key) => Promise.resolve(jobs.get(key)!),
    artifact: (_, key) => Promise.resolve(artifacts.get(key)!),
    workflow: (_, __, key) => Promise.resolve(sources.get(key)!),
    archive: (_, key) => Promise.resolve(archives.get(key)!),
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

// Synthetic receipt claims exercise policy and never represent a qualifying native run.
function manualValue(
  plan: StagePlan,
  p: string,
  d: string,
  architecture: 'arm64' | 'x64',
  runId: number,
  entries: Record<string, Buffer>
) {
  const root = '/TEST/TEST-mac-manual-owned-case';
  const file = textProof('seeded-config.json', JSON.stringify({ general: { theme: 'light' } }));
  const normalized = textProof(
    'seeded-config.json',
    JSON.stringify({ general: { theme: 'light', externalAgentCdpEnabled: false } })
  );
  const signature = (version: string) => ({
    version,
    architecture,
    teamIdentifier: version === '2.17.1' ? '6C84CW694S' : '86399583GS',
    productMinimum: version === '2.17.1' ? '12.0' : '13.0',
    asar: file,
    locks: ['0.0.105', '0.3.3'].map((version) => ({
      version,
      lock: file,
      signedInstalledBinary: file,
      archiveSha256: 'a'.repeat(64),
    })),
  });
  const profileBefore = {
    replacementSignature: signature('2.17.7'),
    profileBefore: file,
    preservedBeforeLaunch: file,
  };
  const phases: Record<string, unknown>[] = [
    { freshSignature: signature('2.17.7') },
    { oldSignature: signature('2.17.1') },
    profileBefore,
  ];
  for (const [index, label] of ['fresh217', 'original211', 'manual217'].entries()) {
    const profile = `${root}/${label === 'fresh217' ? 'fresh-profile' : 'migration-profile'}`;
    const executable = `${root}/Agent Teams AI.app/Contents/MacOS/Agent Teams AI`;
    const bytes = Buffer.alloc(1200, index + 1);
    entries[manualCapturePaths[index]!] = bytes;
    phases.push({
      label,
      profile,
      before: label === 'original211' ? 'system' : 'light',
      theme: 'light',
      ...(label === 'fresh217' ? {} : { configProof: label === 'manual217' ? normalized : file }),
      roots: {
        home: `${profile}/home`,
        nodeHome: `${profile}/home`,
        userData: `${profile}/user-data`,
        executable,
        arch: architecture,
        version: label === 'original211' ? '2.17.1' : '2.17.7',
        packaged: true,
      },
      foregroundBefore: { pid: 42, executable },
      foregroundAfter: { pid: 42, executable },
      painted: {
        owner: { pid: 42, command: executable },
        kCGWindowOwnerPID: 42,
        pixels: { width: 900, height: 600, distinctColors: 100 },
        sha256: digest(bytes),
      },
    });
  }
  return {
    schemaVersion: 1,
    repository: plan.input.repository,
    toolingSha: plan.input.toolingSha,
    sourceSha: plan.input.target.applicationSha,
    version: '2.17.7',
    architecture,
    actualMacOs: '15.6',
    minimumOs13ExecutionProven: false,
    cleanupPassed: true,
    ownedRoot: root,
    producer: {
      run: {
        id: runId,
        run_attempt: 2,
        head_sha: plan.input.toolingSha,
        path: '.github/workflows/updater-mac-manual-migration.yml',
        event: 'workflow_dispatch',
      },
    },
    inputs: {
      schemaVersion: 1,
      toolingSha: plan.input.toolingSha,
      sourceSha: plan.input.target.applicationSha,
      planDigest: p,
      inputDigest: d,
      runId,
      attempt: 2,
      prepared: { toolingSha: plan.input.toolingSha, planDigest: p, inputDigest: d },
      downloads: [
        ...plan.input.originals
          .filter((item) => /\.(dmg|zip)$/.test(item.name))
          .map((item) => ({
            architecture: item.name.includes('-arm64') ? 'arm64' : 'x64',
            releaseId: plan.input.target.id,
            assetId: item.assetId,
            proof: item,
          })),
        {
          architecture: 'arm64',
          releaseId: 398386033,
          assetId: 595801616,
          proof: {
            name: 'Agent.Teams.AI-2.17.1-arm64.dmg',
            size: 249856838,
            sha256: 'ef028b523ace7635abdbd050687b816de78bd887eea4d87a79919b8ea401756e',
          },
        },
        {
          architecture: 'x64',
          releaseId: 398386033,
          assetId: 595811076,
          proof: {
            name: 'Agent.Teams.AI-2.17.1-x64.dmg',
            size: 259656716,
            sha256: '7a6f2700813940bdc379bd01db568999099c19bda40383ac3e01241ee305de6d',
          },
        },
      ],
    },
    phases,
    commands: [
      {
        command: '/usr/bin/sw_vers -productVersion',
        exitCode: 0,
        stdout: '15.6\n',
        stderr: '',
        outputSha256: digest('stdout:\n15.6\n\nstderr:\n'),
      },
    ],
  };
}

describe('full217 frozen-source native readiness', () => {
  it('accepts exactly 18 scenarios, 14 artifacts and four complete workflow cohorts', async () => {
    const f = fixture(true);
    expect(f.receipt.artifacts).toHaveLength(14);
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).resolves.toBeUndefined();
  });
  it.each([
    [
      'prelaunch config bytes altered',
      (v: Record<string, unknown>) => {
        (v.phases as Record<string, unknown>[]).find(
          (p) => p.replacementSignature
        )!.preservedBeforeLaunch = textProof('seeded-config.json', 'altered during replacement');
      },
    ],
    [
      'invalid migrated config byte proof',
      (v: Record<string, unknown>) => {
        (v.phases as Record<string, unknown>[]).find((p) => p.label === 'manual217')!.configProof =
          { sha256: 'invalid', size: 20 };
      },
    ],
    ['missing phase', (v: Record<string, unknown>) => (v.phases as unknown[]).pop()],
    [
      'missing migration config bytes',
      (v: Record<string, unknown>) => {
        delete (v.phases as Record<string, unknown>[]).find((p) => p.label === 'manual217')!
          .configProof;
      },
    ],
    [
      'wrong Team',
      (v: Record<string, unknown>) => {
        (
          (v.phases as Record<string, unknown>[])[0]!.freshSignature as Record<string, unknown>
        ).teamIdentifier = '6C84CW694S';
      },
    ],
    [
      'wrong floor',
      (v: Record<string, unknown>) => {
        (
          (v.phases as Record<string, unknown>[])[0]!.freshSignature as Record<string, unknown>
        ).productMinimum = '12.0';
      },
    ],
    [
      'profile reset',
      (v: Record<string, unknown>) => {
        (v.phases as Record<string, unknown>[]).find((p) => p.label === 'manual217')!.theme =
          'system';
      },
    ],
    [
      'cleanup false',
      (v: Record<string, unknown>) => {
        v.cleanupPassed = false;
      },
    ],
    [
      'invalid timestamp',
      (v: Record<string, unknown>) => {
        v.finishedAt = 'invalid';
      },
    ],
    [
      'claimed macOS13 execution',
      (v: Record<string, unknown>) => {
        v.minimumOs13ExecutionProven = true;
      },
    ],
    [
      'wrong prior bytes',
      (v: Record<string, unknown>) => {
        (
          ((v.inputs as Record<string, unknown>).downloads as Record<string, unknown>[])[4]!
            .proof as Record<string, unknown>
        ).sha256 = 'f'.repeat(64);
      },
    ],
  ] as const)('rejects resealed %s', async (_, mutate) => {
    const f = fixture(true);
    mutate(f.values.get('mac-arm64-manual')!);
    f.reseal('mac-arm64-manual');
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
  it.each([
    'missing architecture',
    'failed cohort',
    'mixed attempt',
    'unknown executor',
    'partial artifact',
    'extra artifact',
    'changed pixels',
  ])('rejects %s', async (failure) => {
    const f = fixture(true);
    if (failure === 'missing architecture') f.receipt.artifacts.pop();
    if (failure === 'failed cohort') f.runs.get(203)!.conclusion = 'failure';
    if (failure === 'mixed attempt') f.receipt.artifacts[13]!.runAttempt = 3;
    if (failure === 'unknown executor') f.runs.get(203)!.head_sha = 'f'.repeat(40);
    if (failure === 'partial artifact')
      f.receipt.artifacts.find((a) => a.entries.length === 2)!.entries.pop();
    if (failure === 'extra artifact')
      f.receipt.artifacts.push(structuredClone(f.receipt.artifacts[0]!));
    if (failure === 'changed pixels')
      f.archives.get(f.receipt.artifacts[12]!.artifactId)!.entries[manualCapturePaths[0]!] =
        Buffer.alloc(1200, 7);
    await expect(verifyNativeReadiness(f.port, f.plan, f.p, f.receipt)).rejects.toThrow();
  });
});

// Every file download reads the original stored bytes; publication only changes visibility.
function fullPublicationFixture() {
  const f = fixture(true);
  const target = {
    id: f.plan.input.target.id,
    tag_name: f.plan.input.target.tag,
    target_commitish: f.plan.input.target.applicationSha,
    created_at: f.plan.input.target.createdAt,
    name: f.plan.input.target.name,
    body: f.plan.input.target.body,
    draft: true,
    prerelease: false,
    assets: [] as Release['assets'],
  };
  const bytes = new Map<number, Buffer>();
  let id = 800;
  for (const output of f.plan.outputs) {
    const original = f.plan.input.originals.find((item) => item.name === output.name);
    const key = original?.assetId ?? id++;
    target.assets.push({
      id: key,
      name: output.name,
      size: output.size,
      digest: `sha256:${output.sha256}`,
    });
    bytes.set(
      key,
      Buffer.from(f.plan.feeds[output.name] ?? f.plan.aliases[output.name] ?? output.name)
    );
  }
  function add(name: string, raw: string) {
    const value = Buffer.from(raw);
    const key = id++;
    target.assets.push({ id: key, name, size: value.length, digest: `sha256:${digest(value)}` });
    bytes.set(key, value);
  }
  add(MANIFEST, `${canonical(manifestFor(f.plan))}\n`);
  add(
    'build-provenance-1-1.json',
    canonical({
      schemaVersion: 1,
      applicationSha: f.plan.input.target.applicationSha,
      tag: f.plan.input.target.tag,
      runId: 1,
      attempt: 1,
      jobs: [{ id: 2, conclusion: 'success', run_id: 1 }],
    })
  );
  const writes: boolean[] = [];
  const port: PublicationPort = {
    release: () => Promise.resolve(structuredClone(target)),
    releaseById: () => Promise.resolve(structuredClone(target)),
    tagSha: () => Promise.resolve(f.plan.input.target.applicationSha),
    latest: () =>
      Promise.resolve(
        target.draft
          ? {
              ...target,
              id: f.plan.input.latest.id,
              tag_name: f.plan.input.latest.tag,
              draft: false,
            }
          : structuredClone(target)
      ),
    minimum: () => Promise.resolve('13.0'),
    download: async (_, asset, destination) => {
      await writeFile(destination, bytes.get(asset.id)!);
    },
    upload: () => {
      throw new Error('Prepared publication must never upload');
    },
    verifyBuild: (_, sha, build, mode) => {
      assert.equal(sha, f.plan.input.target.applicationSha);
      assert.deepEqual(build, f.plan.input.build);
      assert.equal(mode, 'full');
      return Promise.resolve();
    },
    verifyNative: () => {
      throw new Error('Full publication has no carried sidecar');
    },
    setVisibility: (_, snapshot, draft) => {
      assert.deepEqual(snapshot, f.plan.input.target);
      writes.push(draft);
      target.draft = draft;
      return Promise.resolve();
    },
    publicAsset: (_, tag, name) => {
      assert.equal(target.draft, false);
      assert.equal(tag, target.tag_name);
      assert(target.assets.some((a) => a.name === name));
      return Promise.resolve();
    },
    publicRelease: () => {
      assert.equal(target.draft, false);
      return Promise.resolve();
    },
    publicLatest: () => {
      assert.equal(target.draft, false);
      return Promise.resolve();
    },
    publicLatestAsset: (_, name) => {
      assert.equal(target.draft, false);
      assert(target.assets.some((a) => a.name === name));
      return Promise.resolve();
    },
  };
  return { ...f, publicationPort: port, bytes, target, writes };
}
it('prepared full publication preserves qualified feed/alias/manifest bytes exactly', async () => {
  const f = fullPublicationFixture();
  const before = [...f.bytes].map(([id, bytes]) => [id, digest(bytes)]);
  await expect(
    publishFullRelease(f.publicationPort, f.port, f.plan, f.p, f.receipt)
  ).resolves.toMatchObject({ phase: 'published' });
  expect(f.writes).toEqual([false]);
  expect([...f.bytes].map(([id, bytes]) => [id, digest(bytes)])).toEqual(before);
});
it.each(['native failure', 'changed feed', 'extra asset'])(
  'prepared full rejection writes zero for %s',
  async (failure) => {
    const f = fullPublicationFixture();
    if (failure === 'native failure') f.runs.get(203)!.conclusion = 'failure';
    if (failure === 'changed feed')
      f.bytes.set(
        f.target.assets.find((a) => a.name === 'latest-mac.yml')!.id,
        Buffer.from('changed after native qualification')
      );
    if (failure === 'extra asset')
      f.target.assets.push({
        id: 999,
        name: 'unexpected.bin',
        size: 1,
        digest: `sha256:${'f'.repeat(64)}`,
      });
    await expect(
      publishFullRelease(f.publicationPort, f.port, f.plan, f.p, f.receipt)
    ).rejects.toThrow();
    expect(f.writes).toEqual([]);
    expect(f.target.draft).toBe(true);
  }
);

it('rejects legacy full217 promotion before any command or regenerated feed', async () => {
  await expect(
    promoteExistingDraft({
      environment: {
        RELEASE_REPOSITORY: '777genius/agent-teams-ai',
        RELEASE_TAG: 'v2.17.7',
        PUBLISH_RELEASE: 'true',
        PATH: '',
      },
      now: () => {
        throw new Error('Prepared feed bytes must not be regenerated');
      },
    })
  ).rejects.toThrow('Full217 requires publish-full-release.ts');
});

it('reads only the closed manual outcome/capture archive set', () => {
  const paths = ['TEST-mac-manual-evidence/native-manual-receipt.json', ...manualCapturePaths];
  expect(() => validateNativeArchivePaths(paths)).not.toThrow();
  for (const invalid of [
    paths.slice(0, 3),
    [...paths, 'unknown.png'],
    ['../summary.json'],
    ['unknown.png'],
    [paths[0]!, paths[0]!],
  ])
    expect(() => validateNativeArchivePaths(invalid)).toThrow();
});

function fullArmPriorFixture() {
  const bytes = textProof('fixture', 'synthetic prior fixture');
  const prior = { ...bytes, size: 196906862, sha256: ARM211_SHA };
  const install = String.raw`C:\TEST-updater-windows-fixture\install`;
  const uninstall = `"${install}\\Uninstall AgentTeamsAI.exe" /currentuser`;
  return {
    predecessorFixture: {
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
        uninstallString: uninstall,
        quietUninstallString: `${uninstall} /S`,
        version: '2.17.1',
      },
      files: ARM211_FILES.map((name) => ({
        name: String(name),
        source: bytes,
        installed: bytes,
        architecture: 'arm64',
      })),
    },
    initialInstall: { code: 0, arguments: ['/S', `/D=${install}`] },
    installedBefore: { packageVersion: '2.17.1', architecture: 'arm64' },
  };
}
