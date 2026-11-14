import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManagedPreferences } from '../../src/features/runtime-provider-management/core/domain/managedProviderPreferences.ts';
import { runtimeSourceRecordSchema } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { runtimeCaptureSourceSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { validateLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/validateLaunchRecord.js';
import { captureDesktopNativeExecutable, selectedDesktopRuntime } from './desktop-captured-app.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { replace } from './desktop-mixed-dialog-settings.ts';
import { mixedDesktopTeamName } from './desktop-mixed-native-fixture.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';
import type { StoredModelProbe } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import type { RuntimeSourceRecord } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import type { TeamLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/contracts.js';
import type { SettingsModelProbe } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import type { createDesktopUiControls, UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
type Controls = ReturnType<typeof createDesktopUiControls>;
type Snapshot = { sha256: string; value: Row };
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
class SnapshotChanged extends Error {}
const tick = () => new Promise<void>(done => setTimeout(done, 100));

/** Bounded original-file evidence only. No store constructor, recovery or mutation. */
async function snapshot(path: string, maximum = 1024 * 1024, optional = false): Promise<Snapshot | null> {
  const linked = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!linked) return null;
  assert.ok(linked.isFile() && !linked.isSymbolicLink() && linked.nlink === 1);
  assert.ok(linked.size <= maximum && (linked.mode & 0o077) === 0);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (before.dev !== linked.dev || before.ino !== linked.ino) throw new SnapshotChanged();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat(), current = await lstat(path);
    assert.ok(current.isFile() && !current.isSymbolicLink() && current.nlink === 1);
    if (length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
      key => after[key as keyof typeof after] !== before[key as keyof typeof before] ||
        current[key as keyof typeof current] !== before[key as keyof typeof before]
    )) throw new SnapshotChanged();
    assert.ok(length <= maximum);
    const body = bytes.subarray(0, length);
    return {
      sha256: createHash('sha256').update(body).digest('hex'),
      value: object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))),
    };
  } finally {
    await file.close();
  }
}

async function directorySnapshot(directory: string, settled: boolean) {
  const before = await lstat(directory);
  assert.ok(before.isDirectory() && !before.isSymbolicLink());
  const rows: Array<{ name: string; file: Snapshot }> = [];
  let count = 0;
  for await (const entry of await opendir(directory)) {
    assert.ok(++count <= 256, 'finite original TEST directory traversal');
    assert.ok(entry.isFile());
    if (/^\.tmp-[a-f0-9-]{36}$/.test(entry.name)) {
      if (settled) throw new SnapshotChanged();
      continue;
    }
    assert.match(entry.name, /^[a-f0-9]{64}\.json$/);
    assert.ok(rows.length < 64, 'finite original TEST receipt set');
    rows.push({ name: entry.name, file: (await snapshot(join(directory, entry.name), 2 * 1024 * 1024))! });
  }
  const after = await lstat(directory);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new SnapshotChanged();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function journal(root: string, settled = false) {
  const rows = await directorySnapshot(join(root, 'hoststore/management-commands'), settled);
  return rows.map(({ name, file }) => {
    const { digest, ...body } = file.value;
    assert.equal(digest, managementDigest(body));
    const command = storedManagementCommandSchema.parse(body);
    assert.equal(name, managementDigest(command.commandId) + '.json');
    if (settled) {
      if (command.kind === 'model.probe' && command.phase === 'running' ||
          command.kind === 'runtime.source' && ['prepared', 'verifying', 'verified'].includes(command.phase))
        throw new SnapshotChanged();
      assert.equal(command.resourceHeld, false, 'every original management resource settled before cold');
      assert.ok(command.kind === 'runtime.source' && command.phase === 'published' ||
        command.kind === 'model.probe' && (command.phase === 'completed' && command.ok || command.phase === 'cancelled'),
      'only known original source publications and settled model checks');
    }
    return { name, sha256: file.sha256, command };
  });
}

async function sourceIndex(root: string) {
  const file = (await snapshot(join(root, 'hoststore/runtime-sources/index.json'), 8 * 1024 * 1024))!;
  const { digest, ...body } = file.value;
  assert.deepEqual(Object.keys(body).sort(), ['current', 'records', 'schemaVersion']);
  assert.equal(body.schemaVersion, 1);
  assert.equal(digest, runtimeDigest(body));
  assert.ok(Array.isArray(body.records) && body.records.length <= 1024);
  assert.ok(Array.isArray(body.current) && body.current.length <= 256);
  const records = body.records.map(value => runtimeSourceRecordSchema.parse(value));
  assert.equal(new Set(records.map(row => row.revision)).size, records.length);
  assert.equal(new Set(records.map(row => row.commandId)).size, records.length);
  for (const { revision, ...selection } of records) assert.equal(revision, runtimeDigest(selection));
  const current = body.current.map(object);
  assert.equal(new Set(current.map(row => row.sourceId)).size, current.length);
  for (const pointer of current) {
    assert.deepEqual(Object.keys(pointer).sort(), ['commandId', 'revision', 'sourceId']);
    const selected = records.filter(row => row.revision === pointer.revision);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.grant.targetId, pointer.sourceId);
    assert.equal(selected[0]!.commandId, pointer.commandId);
  }
  return { sha256: file.sha256, records, current };
}

/** Extends the original mixed journey. Settings queries never become business input allowance. */
export async function createMixedProviderSettingsProof(options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  models: DesktopMixedModels;
  evidence: Row;
  capturedGroup(): number;
  assertCurrent(): void;
}) {
  const { fixture, models } = options, root = fixture.root;
  const local = models.openCodeGeneration === 'v1';
  const modelA = models.openCodeProviderId + '/TEST-model';
  const modelB = models.openCodeProviderId + '/TEST-project-model';
  const profile = (await snapshot(fixture.profilePath))!.value;
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  const templates = object(profile.runtime).providerTemplates;
  assert.ok(Array.isArray(templates) && templates.length === 3);
  const executables = templates.map(value => {
    const row = object(value), executable = object(row.executable);
    assert.ok(['claude', 'codex', 'opencode'].includes(String(row.provider)));
    assert.equal(typeof executable.path, 'string');
    assert.match(String(executable.sha256), /^[a-f0-9]{64}$/);
    return { provider: String(row.provider), path: String(executable.path), sha256: String(executable.sha256) };
  });
  assert.equal(new Set(executables.map(row => row.provider)).size, 3);
  for (const selected of executables) assert.equal(await fileDigest(selected.path), selected.sha256);
  const witnesses = () => executables.map(selected => ({
    ...selected, capture: captureDesktopNativeExecutable(selected.path, options.capturedGroup()),
  }));
  let native = witnesses();
  const firstGroup = options.capturedGroup();
  const proof: Row = {
    status: 'INCOMPLETE', generation: models.openCodeGeneration,
    scope: 'Original Settings global/project defaults, clear/inheritance, optional visible V1 limits, same-profile cold startup and captured native Launch',
    expectedSettingsRequests: local ? 4 : 3, steps: [],
    excluded: ['vendor inference', 'token-pressure enforcement', 'V2 invented limits editor'],
  };
  options.evidence.providerSettings = proof;
  const observeNative = () => {
    options.assertCurrent();
    for (const row of native) row.capture.observe();
  };
  const assertNoBusinessInputs = () => {
    for (const model of [models.claude, models.codex, models.opencode])
      assert.equal(model.observations.length, 0, 'Settings and save-only never release a business input');
  };
  const noBusiness = () => {
    options.assertCurrent();
    assertNoBusinessInputs();
  };
  const wait = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 30_000;
    do {
      options.assertCurrent();
      try {
        const value = await read();
        if (accept(value)) return value;
      } catch (error) {
        if (!(error instanceof SnapshotChanged)) throw error;
      }
      await tick();
    } while (Date.now() < deadline);
    throw new Error('Original Settings read timed out: ' + label + '; no mutation retry');
  };
  const preferencePaths = [
    join(root, 'preferences/global/global-runtime-preferences.json'),
    join(root, 'preferences/workspace/agent-teams-runtime-preferences.json'),
    join(root, 'preferences/workspace-other/agent-teams-runtime-preferences.json'),
  ];
  const preferences = async () => {
    const files = await Promise.all(preferencePaths.map(path => snapshot(path, 1024 * 1024, true)));
    return files.map(file => ({ sha256: file?.sha256 ?? null,
      value: file ? parseManagedPreferences(file.value) : null }));
  };
  assert.ok((await preferences()).every(row => row.value === null), 'no prewritten managed settings');
  let globalSha: string | undefined;
  const assertPreferences = async (projectDefault: string | null, configuredLimits = false) => {
    const rows = await preferences();
    assert.equal(rows[0]!.value?.defaultModelId, modelA);
    if (globalSha) assert.equal(rows[0]!.sha256, globalSha, 'project mutations preserve original global bytes');
    assert.equal(rows[1]!.value?.defaultModelId ?? null, projectDefault);
    assert.equal(rows[2]!.value, null, 'other project never receives a preference file');
    if (configuredLimits) assert.deepEqual(
      rows[1]!.value?.modelLimitOverrides[modelA] &&
        { contextTokens: rows[1]!.value!.modelLimitOverrides[modelA]!.contextTokens,
          outputTokens: rows[1]!.value!.modelLimitOverrides[modelA]!.outputTokens },
      { contextTokens: 65536, outputTokens: 1536 });
    else assert.deepEqual(rows[1]!.value?.modelLimitOverrides ?? {}, {});
    return rows;
  };
  const originalStep = async (step: SettingsModelProbe['step'], ui: Controls, selector: string, label: string, text?: string) => {
    noBusiness();
    observeNative();
    const before = new Set((await wait(() => journal(root), () => true, 'pre-action receipts'))
      .map(row => row.command.commandId));
    models.settingsProbes.begin(step); // One intent, before the original physical click.
    await ui.scrollTo(selector, label, text);
    await ui.click(selector, label, text);
    const receipt = await wait(async () => {
      const rows = await journal(root);
      const selected = rows.filter(row => !before.has(row.command.commandId) &&
        row.command.kind === 'model.probe' && row.command.providerId === models.openCodeProviderId);
      assert.ok(selected.length <= 1, 'one original OpenCode verification command per Settings action');
      return selected[0]?.command as StoredModelProbe | undefined;
    }, row => row?.phase === 'completed' && row.ok && !row.resourceHeld, label + ' actual completion');
    assert.ok(receipt);
    const source = await sourceIndex(root);
    const selected = source.records.filter(row =>
      receipt.profileId === 'runtime-source:' + row.revision &&
      receipt.configRevision === 'runtime-source:' + row.revision);
    assert.equal(selected.length, 1, 'probe belongs to its original retained source');
    assert.equal(selected[0]!.grant.runtimeId, 'opencode');
    assert.equal(selected[0]!.grant.projectPath, join(root, 'workspace'),
      'global saving still verifies in the original explicitly selected project');
    assert.equal(receipt.modelId, step === 'project-default' || step === 'project-test' ? modelB : modelA);
    if (step === 'local-limits') assert.deepEqual(receipt.limits, { contextTokens: 65536, outputTokens: 1536 });
    else assert.equal(receipt.limits, undefined);
    models.settingsProbes.finish(step);
    observeNative();
    noBusiness();
    (proof.steps as unknown[]).push({ step, commandId: receipt.commandId,
      sourceId: selected[0]!.grant.targetId, revision: selected[0]!.revision,
      modelId: receipt.modelId, phase: receipt.phase, resourceHeld: receipt.resourceHeld });
  };
  const modelsTab = async (ui: Controls) => {
    const selector = '[role="dialog"] [role="tab"][id$="-trigger-models"]';
    await ui.scrollTo(selector, 'original Models tab');
    await ui.click(selector, 'original Models tab');
    await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] [data-testid="opencode-default-inheritance"]'))`,
      'original default inheritance card');
  };
  const selectProject = async (ui: Controls, name: 'workspace' | 'workspace-other') => {
    const selector = '[role="dialog"] [data-testid="runtime-provider-project-context-trigger"]';
    await ui.scrollTo(selector, 'original project context');
    await ui.click(selector, 'original project context');
    await ui.click('[role="option"]', 'select original TEST project', name);
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(selector)})?.textContent.trim()===${desktopJsLiteral(name)}`,
      'original project context retained');
  };
  const defaultId = (ui: Controls, type: 'base' | 'project', model: string) => ui.waitRead(
    `document.querySelector('[role="dialog"] [data-testid="opencode-default-${type}-model-id"]')?.textContent.trim()===${desktopJsLiteral(model)}`,
    'original ' + type + ' default model');
  const choose = async (cdp: UiCdpPort, ui: Controls, scope: 'global' | 'project') => {
    const label = scope === 'global' ? 'Change: Default model' : 'Use another model: This project: workspace';
    const target = '[role="dialog"] button[aria-label=' + JSON.stringify(label) + ']';
    await ui.scrollTo(target, label);
    await ui.click(target, label);
    const header = '[role="dialog"] [data-testid=' +
      JSON.stringify('runtime-provider-row-' + models.openCodeProviderId + '-header') + ']';
    const content = '[role="dialog"] [data-testid=' +
      JSON.stringify('runtime-provider-row-' + models.openCodeProviderId + '-content') + ']';
    if (!(await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(content)}))`))) {
      await ui.scrollTo(header, 'original configured provider');
      await ui.click(header, 'expand original configured provider');
    }
    const selectedModel = scope === 'global' ? modelA : modelB;
    const row = '[role="dialog"] [data-testid=' + JSON.stringify('runtime-provider-model-row-' + selectedModel) + ']';
    await originalStep(scope === 'global' ? 'global-default' : 'project-default', ui,
      row + ' button[aria-pressed="false"]',
      'select and verify original ' + scope + ' default', 'Select');
  };
  const runPrelude = async (cdp: UiCdpPort, ui: Controls) => {
    noBusiness();
    observeNative();
    await ui.click('button[aria-label="More actions"]', 'original menu for Settings');
    await ui.click('button', 'original Settings', 'Settings');
    await ui.click('button', 'original Providers page', 'Providers');
    const manage = '[data-testid="provider-settings-page"] [data-testid="runtime-manage-opencode"]';
    await ui.scrollTo(manage, 'original OpenCode Manage');
    await ui.click(manage, 'original OpenCode Manage');
    await modelsTab(ui);
    await selectProject(ui, 'workspace');
    await choose(cdp, ui, 'global');
    await modelsTab(ui);
    await defaultId(ui, 'base', modelA);
    let stored = await assertPreferences(null);
    globalSha = stored[0]!.sha256!;
    await defaultId(ui, 'project', modelA);
    await choose(cdp, ui, 'project');
    await originalStep('project-test', ui,
      '[role="dialog"] [data-testid=' + JSON.stringify('runtime-provider-model-test-' + modelB) + ']',
      'Test the original project model once');
    const result = '[role="dialog"] [data-testid=' +
      JSON.stringify('runtime-provider-model-result-' + modelB) + ']';
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(result)})?.getAttribute('data-result-status')==='success'`,
      'original project Test visibly succeeded');
    await modelsTab(ui);
    await defaultId(ui, 'project', modelB);
    stored = await assertPreferences(modelB);
    proof.projectOverride = { globalSha256: globalSha, projectSha256: stored[1]!.sha256 };
    await selectProject(ui, 'workspace-other');
    await defaultId(ui, 'project', modelA);
    assert.equal((await preferences())[2]!.value, null);
    await selectProject(ui, 'workspace');
    await defaultId(ui, 'project', modelB);
    const clear = '[role="dialog"] button[aria-label="Use default: This project: workspace"]';
    await ui.scrollTo(clear, 'original project clear override');
    await ui.click(clear, 'clear original project override once');
    await defaultId(ui, 'project', modelA);
    stored = await assertPreferences(null);
    proof.clearedProject = { globalSha256: globalSha, projectSha256: stored[1]!.sha256,
      otherProjectAbsent: true, visibleInheritedModel: modelA };
    await ui.scrollTo('[role="dialog"] > button', 'original Settings Close', 'Close');
    await ui.click('[role="dialog"] > button', 'close original Settings', 'Close');
    await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original Settings closed');
    observeNative();
    models.settingsProbes.beginConfiguration();
  };
  const configureMember = async (cdp: UiCdpPort, ui: Controls) => {
    noBusiness();
    const row = '[data-testid="create-team-page"] [data-role="member-row"]:has(input[aria-label="Member 2"])';
    assert.equal(await cdp.evaluate(`document.querySelector(${desktopJsLiteral(row + ' input[aria-label="Member 2"]')})?.value`), 'carol');
    // Hide the original JSON editor before using the same visible member controls.
    if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="create-team-page"] .cm-editor'))`)) {
      await ui.scrollTo('[data-testid="create-team-page"] button', 'original member JSON close', 'Hide JSON');
      await ui.click('[data-testid="create-team-page"] button', 'close original member JSON', 'Hide JSON');
    }
    const trigger = row + ' button[aria-label*=" provider,"]';
    await ui.scrollTo(trigger, 'original inherited Carol model');
    await ui.click(trigger, 'expand original Carol model');
    const inherited = row + ' [data-testid="team-model-selector-model-option"][aria-label^="Default - TEST-model"]';
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(inherited)})?.getAttribute('aria-pressed')==='true'`,
      'Carol inherits the visible original A default');
    const card = row + ' [data-testid="opencode-local-model-limits-card"]';
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(card)}))`), false,
      'raw Default has no explicit-model limits card');
    if (local) {
      const explicit = row + ' [data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]';
      await ui.scrollTo(explicit, 'original explicit A model');
      await ui.click(explicit, 'temporarily select A through the existing model control');
      await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(card)}))`, 'genuine visible V1 local limits editor');
      await replace(cdp, ui, card + ' input[placeholder="128000"]', '65536', 'original context limit');
      await replace(cdp, ui, card + ' input[placeholder="32768"]', '1536', 'original output limit');
      await originalStep('local-limits', ui, card + ' button', 'Apply and verify original limits once', 'Apply & verify');
      await ui.waitRead(`document.querySelector(${desktopJsLiteral(card)})?.textContent.includes('Saved in Agent Teams and verified through OpenCode.')`,
        'original limits verification succeeds');
      await assertPreferences(null, true);
      await ui.scrollTo(inherited, 'original Default A choice');
      await ui.click(inherited, 'restore original inherited Default before saving');
      await ui.waitRead(`document.querySelector(${desktopJsLiteral(inherited)})?.getAttribute('aria-pressed')==='true'`,
        'original Default restored');
    }
    models.settingsProbes.assertComplete();
    proof.visibleLocalLimits = local ? { contextTokens: 65536, outputTokens: 1536 } : null;
    proof.defaultBeforeSave = {
      selected: true, modelId: modelA, globalPreferenceSha256: globalSha,
    };
    await ui.scrollTo(trigger, 'original Carol model toggle');
    await ui.click(trigger, 'collapse original Carol model');
    observeNative();
    noBusiness();
  };
  let coldSnapshot: unknown;
  const capturedState = async () => {
    const state = (await snapshot(join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner/state.json')))!;
    assert.deepEqual(state.value.runtimeCaptures ?? [], [], 'no native Runtime capture at the cold boundary');
    assert.ok(Array.isArray(state.value.members) && state.value.members.length === 3);
    assert.ok(state.value.members.map(object).every(member => member.delivery === undefined));
    const carol = state.value.members.map(object).filter(member => member.name === 'carol');
    assert.equal(carol.length, 1);
    assert.equal(object(carol[0]!.settings).model, modelA,
      'original Save materializes the selected Default A');
    return state;
  };
  const retainedFiles = async () => ({
    state: await capturedState(),
    registry: await directorySnapshot(join(root, 'hoststore/.host-team-registry/records'), true),
    preferences: await assertPreferences(null, local),
    source: await sourceIndex(root),
    commands: await journal(root, true),
  });
  const beforeCold = async () => {
    noBusiness();
    models.settingsProbes.assertComplete();
    observeNative();
    const retained = await wait(retainedFiles, () => true, 'all original Settings owners settled before Quit');
    coldSnapshot = retained;
    proof.beforeCold = { group: firstGroup, native: native.map(({ provider, capture }) =>
      ({ provider, births: capture.captured() })), retained: {
        stateSha256: retained.state.sha256, sourceIndexSha256: retained.source.sha256,
        registry: retained.registry.map(row => ({ receipt: row.name, sha256: row.file.sha256 })),
        preferences: retained.preferences.map((row, index) => ({ scope: ['global', 'project', 'other'][index],
          sha256: row.sha256, defaultModelId: row.value?.defaultModelId ?? null })),
        commands: retained.commands.map(row => ({ receipt: row.name, sha256: row.sha256,
          kind: row.command.kind, phase: row.command.phase, resourceHeld: row.command.resourceHeld })),
      } };
  };
  const assertAbsent = async () => {
    for (const selected of native) {
      assert.deepEqual(selected.capture.remaining(), [], 'every original selected native birth is absent');
      assert.deepEqual(selectedDesktopRuntime(selected.path), [], 'no unmatched exact selected executable remains');
      assert.equal(await fileDigest(selected.path), selected.sha256);
    }
  };
  const afterOriginalQuit = async () => {
    assert.ok(coldSnapshot);
    assertNoBusinessInputs();
    await assertAbsent();
    assert.deepEqual(await retainedFiles(), coldSnapshot, 'original preferences/source/commands/Team bytes survive Quit');
    proof.originalSettingsOwnersReleased = true;
  };
  const afterCold = async () => {
    assert.equal(proof.originalSettingsOwnersReleased, true);
    assert.notEqual(options.capturedGroup(), firstGroup);
    noBusiness();
    assert.deepEqual(await retainedFiles(), coldSnapshot, 'cold constructor neither replays probes nor rewrites settings');
    native = witnesses();
    observeNative();
    proof.sameSettingsAfterCold = true;
  };
  const assertNoExperimentalOverride = async (cdp: UiCdpPort) => {
    const checkbox = '[role="dialog"] #launch-experimental-local-model';
    const state = await cdp.evaluate(
      `document.querySelector(${desktopJsLiteral(checkbox)})?.getAttribute('data-state')`);
    assert.ok(state === undefined || state === 'unchecked',
      'successful captured readiness does not select a failed-local-model override');
    proof.experimentalOverride = { requested: false, checkedControl: false,
      failedLocalOverrideQualified: false };
  };
  const assertCapture = async (capture: Row, sessions: Row[]) => {
    models.settingsProbes.assertComplete();
    await assertPreferences(null, local);
    assert.equal(typeof capture.launchId, 'string');
    const file = (await snapshot(join(root, 'hoststore/teams', mixedDesktopTeamName,
      '.host-owner/launches', runtimeDigest(capture.launchId) + '.json')))!;
    const launch = file.value as unknown as TeamLaunchRecord;
    assert.equal(launch.fingerprint, runtimeDigest(launch.definition));
    assert.equal(launch.definition.launchId, capture.launchId);
    validateLaunchRecord(launch, launch.fingerprint, 3);
    const source = runtimeCaptureSourceSchema.parse(launch.definition.capture);
    assert.equal(source.commandId, capture.commandId);
    assert.equal(source.configurationRevision, capture.configurationRevision);
    const carol = source.members.filter(member => member.name === 'carol');
    assert.equal(carol.length, 1);
    assert.equal(carol[0]!.settings.model, modelA,
      'Launch retains the original materialized Default A');
    const reference = source.recipeSources?.filter(row => row.memberId === carol[0]!.memberId);
    assert.equal(reference?.length, 1);
    const index = await sourceIndex(root);
    const selected = index.records.filter(row => row.revision === reference![0]!.revision &&
      row.grant.targetId === reference![0]!.sourceId);
    assert.equal(selected.length, 1);
    const original: RuntimeSourceRecord = selected[0]!;
    assert.equal(original.grant.projectPath, join(root, 'workspace'));
    assert.equal(original.grant.runtimeId, 'opencode');
    assert.deepEqual(original.candidate.openCodePreferences, {
      defaultModelId: modelA,
      modelLimitOverrides: local ? { [modelA]: { contextTokens: 65536, outputTokens: 1536 } } : {},
    });
    const commands = await journal(root);
    const publication = commands.filter(row => row.command.kind === 'runtime.source' &&
      row.command.commandId === original.commandId).map(row => row.command);
    assert.equal(publication.length, 1);
    const receipt = publication[0]!;
    assert.equal(receipt.kind, 'runtime.source');
    assert.equal(receipt.phase, 'published');
    assert.equal(receipt.resourceHeld, false);
    const runtime = sessions.filter(row => object(row.binding).memberId === carol[0]!.memberId);
    assert.equal(runtime.length, 1);
    assert.equal(object(runtime[0]!.binding).runId, capture.launchId);
    assert.equal(object(runtime[0]!.config).configRevision,
      'capture-' + runtimeDigest({ source, memberId: carol[0]!.memberId }));
    proof.nativeCapture = { launchId: capture.launchId, memberId: carol[0]!.memberId,
      sourceId: original.grant.targetId, revision: original.revision, recordSha256: file.sha256,
      capturedPreferences: original.candidate.openCodePreferences, originalRuntimeBound: true };
    observeNative();
  };
  const finish = async () => {
    models.settingsProbes.assertComplete();
    await assertPreferences(null, local);
    assert.equal(proof.sameSettingsAfterCold, true);
    assert.ok(proof.nativeCapture);
    assert.ok(models.opencode.observations.length > 0);
    assert.ok(models.opencode.observations.every(row => row.requestedModel === 'TEST-model' &&
      (!local || row.requestedOutputTokens === 1536)));
    await assertAbsent();
    await journal(root, true);
    proof.settingsRequests = models.opencode.probes.filter(row => row.settingsStep !== undefined);
    assert.equal((proof.settingsRequests as unknown[]).length, local ? 4 : 3);
    proof.businessRequests = models.opencode.observations.length;
    proof.successorOwnersReleased = true;
    proof.status = 'PASS';
  };
  return { proof, defaultModel: modelA, runPrelude, configureMember, beforeCold,
    afterOriginalQuit, afterCold, observeNative, assertNoExperimentalOverride, assertCapture, finish };
}
