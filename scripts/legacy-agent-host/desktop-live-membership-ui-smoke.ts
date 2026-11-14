/** Separate explicit TEST case; all mutations use the original visible product controls. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeSourceRecordSchema } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { storedModelProbeSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { launchReadinessSchema } from '../../packages/legacy-agent-host/dist/team-launch/launchReadiness.js';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { command } from './desktop-backend-observations.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { checked, replace } from './desktop-mixed-dialog-settings.ts';
import { mixedDesktopTeamName, readMixedLiveMembershipIdentity } from './desktop-mixed-native-fixture.ts';
import type { DesktopLiveMemberSelection, DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { captureDesktopSourceMetadataLineage, desktopMetadataProfileHash } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
type Provider = 'claude' | 'codex' | 'opencode';
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
const rows = (value: unknown, maximum = 1024): Row[] => {
  assert.ok(Array.isArray(value) && value.length <= maximum); return value.map(record);
};
const text = (value: unknown): string => { assert.ok(typeof value === 'string' && value); return value; };

/** One bounded regular-file observation, without opening a production store or recovering work. */
async function read(path: string, maximum = 1024 * 1024): Promise<Row> {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum);
  assert.equal(await realpath(path), path);
  const same = (after: typeof before) => {
    assert.ok(after.isFile() && !after.isSymbolicLink());
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'] as const)
      assert.equal(after[key], before[key], 'original file observation is current');
  };
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    same(await file.stat()); const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    assert.equal(length, before.size); assert.ok(length <= maximum);
    same(await file.stat()); same(await lstat(path));
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
  } finally { await file.close(); }
}

export async function runDesktopLiveMembershipUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>> & {
    membershipProject?: { path: string; sha256: string; dev: number; ino: number };
  };
  models: DesktopMixedModels;
  capturedGroup(): number;
  restartSameProfile(handleId: string, afterOriginalQuit: () => Promise<void>): Promise<UiCdpPort>;
  evidence: Row;
  assertOwnedRenderer(): void;
}) {
  assert.equal(process.env.LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'native-mixed-create-launch-ui');
  const { fixture, models } = options, membership = models.membership, project = fixture.membershipProject;
  assert.ok(membership && project);
  const steps: Row[] = [], proof: Row = { status: 'INCOMPLETE', kind: 'mixed-live-membership',
    openCodeGeneration: models.openCodeGeneration, steps };
  options.evidence.liveMembershipProof = proof;
  const modelRows = [models.claude, models.codex, models.opencode];
  const current = () => {
    options.assertOwnedRenderer();
    for (const model of modelRows) assert.deepEqual(model.failures, []);
    for (const model of [models.claude, models.codex]) {
      assert.equal(model.observations.length, 0); assert.equal(model.notificationObservations?.length ?? 0, 0);
    }
  };
  const step = (value: Row) => { assert.ok(steps.length < 512); steps.push({ monotonicMs: Math.round(performance.now()), ...value }); };
  let ui = createDesktopUiControls(cdp, { assertOwnedRenderer: current, step });
  const poll = async <T>(observe: () => Promise<T>, accepts: (value: T) => boolean, label: string) => {
    const cutoff = Date.now() + 90_000; let value = await observe();
    while (!accepts(value) && Date.now() < cutoff) {
      current(); await new Promise<void>(resolve => setTimeout(resolve, 100)); value = await observe();
    }
    assert.ok(accepts(value), label); return value;
  };
  const workspace = join(fixture.root, 'workspace');
  const ownerDirectory = join(fixture.root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner');
  const owner = () => read(join(ownerDirectory, 'state.json'));
  const profile = await read(fixture.profilePath), descriptor = await read(fixture.descriptorPath);
  const originalOwner = record(profile.owner), templates = rows(record(profile.runtime).providerTemplates, 3);
  const recipe = (provider: Provider) => {
    const selected = templates.filter(row => row.provider === provider); assert.equal(selected.length, 1); return selected[0]!;
  };
  const management = rows(profile.management).filter(row => row.provider === 'opencode');
  assert.equal(management.length, 1); const metadataProfile = management[0]!;
  const openCodeExecutable = record(recipe('opencode').executable);
  const v2 = models.openCodeGeneration === 'v2';
  const embeddedEntry = v2 ? await realpath(join(dirname(fixture.hostEntry), 'adapters/providers/OpenCodeV2EmbeddedChild.js')) : undefined;
  const engine = v2 ? record(recipe('opencode').embedded) : undefined;
  if (engine) assert.equal(engine.version, '2.1.4');
  const executablePins = [...templates.map(row => record(row.executable)),
    ...(engine ? [{ path: join(text(engine.directory), 'opencode-v2-engine-manifest.json'), sha256: text(engine.manifestSha256) }] : []),
    ...(embeddedEntry ? [{ path: embeddedEntry, sha256: await fileDigest(embeddedEntry) }] : [])];
  const pins = async () => {
    assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
    assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
    for (const pin of executablePins) {
      assert.equal(await realpath(text(pin.path)), pin.path); assert.equal(await fileDigest(text(pin.path)), pin.sha256);
    }
    const stat = await lstat(project.path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024 && (stat.mode & 0o777) === 0o600);
    assert.equal(stat.dev, project.dev); assert.equal(stat.ino, project.ino);
    assert.equal(project.path, join(workspace, 'opencode.json')); assert.equal(await realpath(project.path), project.path);
    assert.equal(await fileDigest(project.path), project.sha256);
  };
  let sourceSeen = false;
  let previousSourceRecords: ReturnType<typeof runtimeSourceRecordSchema.parse>[] = [];
  const sourceProfiles = async () => {
    let envelope: Row;
    try { envelope = await read(join(fixture.root, 'hoststore/runtime-sources/index.json'), 8 * 1024 * 1024); sourceSeen = true; }
    catch (error) {
      if (!sourceSeen && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return { records: [], current: [], profileHashes: [desktopMetadataProfileHash({
          profileId: text(metadataProfile.profileId), configRevision: text(metadataProfile.configRevision) })] };
      throw error;
    }
    const { digest, ...body } = envelope; assert.equal(digest, runtimeDigest(body));
    assert.deepEqual(Object.keys(body).sort(), ['current', 'records', 'schemaVersion']); assert.equal(body.schemaVersion, 1);
    const records = rows(body.records).map(row => runtimeSourceRecordSchema.parse(row)), pointers = rows(body.current, 256);
    assert.equal(new Set(records.map(row => row.revision)).size, records.length);
    assert.equal(new Set(records.map(row => row.commandId)).size, records.length);
    assert.equal(new Set(pointers.map(row => row.sourceId)).size, pointers.length);
    for (const { revision, ...value } of records) assert.equal(revision, runtimeDigest(value));
    assert.deepEqual(records.slice(0, previousSourceRecords.length), previousSourceRecords);
    for (const pointer of pointers) {
      assert.deepEqual(Object.keys(pointer).sort(), ['commandId', 'revision', 'sourceId']);
      const selected = records.find(row => row.revision === pointer.revision); assert.ok(selected);
      assert.equal(selected.commandId, pointer.commandId); assert.equal(selected.grant.targetId, pointer.sourceId);
    }
    const selected = records.filter(row => row.grant.runtimeId === 'opencode'); assert.ok(selected.length <= 2);
    for (const row of selected) {
      assert.equal(row.intent, 'configuration'); assert.equal(row.candidate.sourceKind, 'captured');
      assert.equal(row.grant.ownerId, originalOwner.ownerId); assert.equal(row.grant.ownerRevision, originalOwner.revision);
      assert.equal(row.grant.profileId, metadataProfile.profileId); assert.equal(row.grant.configRevision, metadataProfile.configRevision);
      assert.ok(row.grant.projectPath === null || row.grant.projectPath === workspace);
      assert.deepEqual(row.candidate.executable, openCodeExecutable);
      const grants = rows(descriptor.management).filter(grant => grant.runtimeId === 'opencode' &&
        grant.projectPath === row.grant.projectPath && grant.profileId === row.grant.profileId &&
        grant.configRevision === row.grant.configRevision && grant.contextId === row.grant.contextId);
      assert.equal(grants.length, 1);
      assert.deepEqual(grants[0]!.owner, { ownerId: originalOwner.ownerId, revision: originalOwner.revision });
      assert.ok(pointers.some(pointer => pointer.sourceId === row.grant.targetId && pointer.revision === row.revision));
      if (v2) assert.equal(row.candidate.openCodeConfiguration?.scope, row.grant.projectPath === null ? 'global' : 'project');
    }
    previousSourceRecords = records;
    return { records, current: pointers, profileHashes: [desktopMetadataProfileHash({
      profileId: text(metadataProfile.profileId), configRevision: text(metadataProfile.configRevision) }),
      ...selected.map(row => desktopMetadataProfileHash({ profileId: 'runtime-source:' + row.revision,
        configRevision: 'runtime-source:' + row.revision }))] };
  };
  const probeLedger = async () => {
    const directory = join(fixture.root, 'hoststore/management-commands'), names = await readdir(directory);
    assert.ok(names.length <= 256); const result: { commandId: string; fingerprint: string; digest: string }[] = [];
    for (const name of names.sort()) {
      if (/^\.tmp-[a-f0-9-]{36}$/.test(name)) continue;
      assert.match(name, /^[a-f0-9]{64}\.json$/);
      const { digest, ...body } = await read(join(directory, name), 256 * 1024);
      assert.equal(digest, managementDigest(body));
      if (body.kind !== 'model.probe') continue;
      const probe = storedModelProbeSchema.parse(body);
      assert.equal(name, managementDigest(probe.commandId) + '.json');
      assert.equal(probe.resourceHeld, false);
      assert.ok(probe.phase === 'completed' || probe.phase === 'cancelled');
      result.push({ commandId: probe.commandId, fingerprint: probe.fingerprint, digest: text(digest) });
    }
    return result;
  };
  const epochs: Row[] = []; proof.physicalEpochs = epochs;
  let host: ProcessFact | undefined, lineage: DesktopSourceMetadataLineage | undefined, metadataBirths: ProcessFact[] = [];
  const v1MetadataCommand = v2 ? '' : text(openCodeExecutable.path) + ' serve --hostname 127.0.0.1 --port ' +
    new URL(text(metadataProfile.endpoint)).port;
  const observe = async (providers: readonly Provider[]) => {
    current(); await pins(); const sources = await sourceProfiles(), table = processFacts();
    const found = table.filter(row => row.groupId === options.capturedGroup() && command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
    assert.equal(found.length, 1); if (host) assert.deepEqual(found[0], host); else host = found[0]!;
    const children = table.filter(row => row.parentPid === host!.pid);
    let metadata: readonly ProcessFact[];
    if (v2) {
      const next = captureDesktopSourceMetadataLineage({ root: fixture.root, host, profileHashes: sources.profileHashes,
        observed: table, executable: text(openCodeExecutable.path), ...(lineage ? { original: lineage } : {}) });
      for (const row of children.filter(row => row.command === openCodeExecutable.path))
        assert.equal(command(row.pid), text(openCodeExecutable.path) + ' --no-env-file --config=/dev/null --no-install ' + embeddedEntry);
      lineage = next; metadata = next.live;
    } else {
      metadata = children.filter(row => command(row.pid) === v1MetadataCommand); assert.ok(metadata.length <= 1);
      for (const birth of metadataBirths) {
        const live = table.find(row => row.pid === birth.pid);
        if (live) { assert.deepEqual(live, birth); assert.ok(metadata.some(row => row.pid === birth.pid)); }
      }
      for (const row of metadata) if (!metadataBirths.some(birth => birth.pid === row.pid)) {
        assert.equal(row.command, openCodeExecutable.path); metadataBirths.push({ ...row });
      }
      assert.ok(metadataBirths.length <= 128);
    }
    const natives = children.filter(row => !metadata.some(birth => birth.pid === row.pid));
    assert.equal(natives.length, providers.length, 'every remaining original Host child is one expected Runtime');
    const selected = new Map<Provider, ProcessFact>();
    for (const provider of providers) {
      const executable = text(record(recipe(provider).executable).path);
      const matches = natives.filter(row => row.command === executable);
      assert.equal(matches.length, 1); const birth = matches[0]!;
      assert.equal(birth.groupId, birth.pid);
      assert.ok(command(birth.pid).startsWith(executable + ' '));
      if (provider === 'opencode' && !v2) assert.equal(command(birth.pid),
        executable + ' serve --hostname 127.0.0.1 --port ' + new URL(text(recipe(provider).endpoint)).port);
      selected.set(provider, { ...birth });
    }
    assert.equal(new Set([...selected.values()].map(row => row.pid)).size, providers.length);
    assert.deepEqual(await sourceProfiles(), sources);
    proof.currentPhysical = { host, metadata, natives, sources };
    return selected;
  };
  const releasedEpoch = async () => {
    assert.ok(host); const table = processFacts(); assert.ok(!table.some(row => row.pid === host!.pid));
    if (v2) {
      assert.ok(lineage);
      lineage = captureDesktopSourceMetadataLineage({ root: fixture.root, host,
        profileHashes: (await sourceProfiles()).profileHashes, observed: table,
        executable: text(openCodeExecutable.path), original: lineage, released: true });
    } else for (const row of metadataBirths) assert.ok(!table.some(live => live.pid === row.pid));
    epochs.push({ host, ...(lineage ? { lineage } : { metadataBirths: [...metadataBirths] }), released: true });
    await pins();
  };
  await pins(); await ui.observeInput();
  await openOriginalCreateForm(cdp, ui, workspace, mixedDesktopTeamName);
  const create = '[data-testid="create-team-page"]';
  await checked(cdp, ui, create + ' #launch-team', false);
  await checked(cdp, ui, create + ' #sync-models-with-lead', false);
  const leadToggle = create + ' button[aria-label*=" provider,"]';
  await ui.scrollTo(leadToggle, 'original explicit lead model');
  if (!await cdp.evaluate('Boolean(document.querySelector(' + literal(create + ' #lead-effort') + '))'))
    await ui.click(leadToggle, 'expand original lead model');
  const opus = create + ' [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]';
  await ui.scrollTo(opus, 'original Opus4.6 choice'); await ui.click(opus, 'select original Opus4.6');
  await ui.scrollTo(create + ' button', 'original Medium effort', 'Medium');
  await ui.click(create + ' button', 'select original Medium effort', 'Medium');
  await ui.scrollTo(leadToggle, 'original configured lead model');
  await ui.click(leadToggle, 'collapse original configured lead model');
  const optional = record(await ui.waitRead('(() => {const rows=[...document.querySelectorAll(' +
    literal(create + ' button[aria-controls]') + ')].filter(e=>e.textContent.includes("Optional launch settings"));return rows.length===1?{id:rows[0].getAttribute("aria-controls"),expanded:rows[0].getAttribute("aria-expanded")}:null})()', 'original optional launch settings'));
  if (optional.expanded !== 'true') await ui.click(create + ' button[aria-controls=' + literal(optional.id) + ']', 'expand original optional launch settings');
  await checked(cdp, ui, create + ' #create-skip-permissions', true);
  await replace(cdp, ui, create + ' #team-prompt', '', 'empty original launch prompt');
  await ui.scrollTo(create + ' button', 'original member JSON editor', 'Edit as JSON');
  await ui.click(create + ' button', 'open original member JSON editor', 'Edit as JSON');
  await ui.scrollTo(create + ' .cm-editor', 'original member JSON input');
  await ui.click(create + ' .cm-editor .cm-content .cm-line:first-child', 'focus original member JSON input');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.insertText', { text: JSON.stringify([{ name: 'bob', providerId: 'codex',
    model: 'mock-model', role: 'developer', workflow: 'TEST mixed codex workflow: use only the supplied business input.' }], null, 2) });
  await ui.waitRead('(() => {const rows=[...document.querySelectorAll(' +
    literal(create + ' [data-role="member-row"] input[aria-label^="Member "]') +
    ')];return rows.length===1&&rows[0].value==="bob"})()', 'one original Codex teammate');
  await ui.scrollTo(create + ' button', 'original save-only Create', 'Create');
  await ui.click(create + ' button', 'save original two-member roster once', 'Create');
  await ui.waitRead('!document.querySelector(' + literal(create + ' #team-name') + ')', 'original Create closes', 90_000);
  const saved = await poll(owner, value => rows(value.members).length === 2, 'two saved members');
  assert.deepEqual(rows(saved.members).map(row => [row.name, row.role]), [['team-lead', 'lead'], ['bob', 'member']]);
  assert.equal(record(saved.savedSettings).cwd, workspace);
  assert.equal(record(saved.savedSettings).providerId, 'anthropic');
  assert.equal(record(saved.savedSettings).model, 'claude-opus-4-6');
  assert.equal(record(saved.savedSettings).effort, 'medium');
  assert.equal(record(saved.savedSettings).prompt, '');
  assert.equal(record(saved.savedSettings).skipPermissions, true);
  assert.equal(record(saved.savedSettings).syncModelsWithLead, false);
  assert.equal(record(rows(saved.members)[1]!.settings).providerId, 'codex');
  assert.equal(record(rows(saved.members)[1]!.settings).model, 'mock-model');
  assert.equal(rows(saved.runtimeCaptures ?? []).length, 0);
  assert.ok(rows(saved.members).every(row => row.delivery === undefined));
  assert.equal(models.opencode.probes.length, 0);
  const registryPath = join(fixture.root, 'hoststore/.host-team-registry/records'), names = await readdir(registryPath);
  assert.ok(names.length <= 256);
  const registry = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => read(join(registryPath, name))));
  const created = registry.filter(row => row.phase === 'published' && record(row.record).teamName === mixedDesktopTeamName);
  assert.equal(created.length, 1); const handleId = text(record(record(created[0]!.record).binding).handleId);
  const teamSelector = '[role="button"][data-team-name=' + literal(hostTeamSelectionKey(handleId)) + ']';
  const openTeam = async () => {
    await ui.click('button[aria-label="More actions"]', 'original application menu');
    await ui.click('button', 'original Teams list', 'Teams');
    await ui.scrollTo(teamSelector, 'exact original Team card'); await ui.click(teamSelector, 'open exact original Team');
  };
  await openTeam(); await observe([]);
  await ui.click('button', 'open original Launch dialog once', 'Launch');
  await ui.waitRead('Boolean(document.querySelector("[role=dialog]"))', 'original Launch dialog');
  await ui.waitRead('[...document.querySelectorAll("[role=dialog] button")].some(e=>e.textContent.trim()==="Launch team"&&!e.disabled)',
    'original selected provider preflights enable Launch', 90_000);
  assert.equal(models.opencode.probes.length, 0);
  assert.equal(rows((await owner()).runtimeCaptures ?? []).length, 0);
  await ui.scrollTo('[role="dialog"] button', 'original Launch team control', 'Launch team');
  await ui.click('[role="dialog"] button', 'one original empty-prompt Launch', 'Launch team');
  await ui.waitRead('!document.querySelector("[role=dialog]")', 'original Launch closes', 90_000);
  const launched = await poll(owner, value => rows(value.runtimeCaptures ?? []).length === 1, 'one original native capture');
  const capture = rows(launched.runtimeCaptures)[0]!, launchId = text(capture.launchId);
  assert.equal(rows(capture.members).length, 2);
  const launch = () => read(join(ownerDirectory, 'launches', runtimeDigest(launchId) + '.json'));
  const sessions = async () => (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === launchId);
  await ui.waitRead('/Team is ready\\.|Team launched/.test(document.body.innerText)', 'original two-member native readiness', 90_000);
  const initialSessions = await poll(sessions, value => value.length === 2 && value.every(row =>
    row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true && row.sealed === false), 'two original native sessions ready');
  for (const row of initialSessions) assert.deepEqual(row.inputs, []);
  const peerProviders = ['claude', 'codex'] as const, initialPhysical = await observe(peerProviders);
  const peers = peerProviders.map(provider => ({ provider, identity: readMixedLiveMembershipIdentity(fixture.root, provider),
    physical: initialPhysical.get(provider)! }));
  const peerProbeCounts = [models.claude.probes.length, models.codex.probes.length];
  assert.ok(peerProbeCounts[0]! >= 1 && peerProbeCounts[0]! <= 9 && peerProbeCounts[1]! >= 1 && peerProbeCounts[1]! <= 8);
  proof.initial = { handleId, capture, sessions: initialSessions, peers, probeCounts: peerProbeCounts,
    source: await sourceProfiles(), project: { path: project.path, sha256: project.sha256 } };
  const assertPeers = async (physical?: Map<Provider, ProcessFact>) => {
    current(); assert.deepEqual([models.claude.probes.length, models.codex.probes.length], peerProbeCounts);
    const selected = await sessions();
    for (const peer of peers) {
      assert.deepEqual(readMixedLiveMembershipIdentity(fixture.root, peer.provider), peer.identity);
      const original = initialSessions.find(row => runtimeDigest(row.binding) === runtimeDigest(peer.identity.binding)); assert.ok(original);
      assert.deepEqual(selected.find(row => runtimeDigest(row.binding) === runtimeDigest(peer.identity.binding)), original);
      if (physical) assert.deepEqual(physical.get(peer.provider), peer.physical);
    }
  };
  const commandAfter = async (before: Row, kind: 'add' | 'remove' | 'restore') => {
    const prior = rows(before.rosterCommands ?? []).map(row => row.commandId);
    const state = await poll(owner, value => rows(value.rosterCommands ?? []).some(row =>
      !prior.includes(row.commandId) && row.liveMembership !== undefined && record(row.liveMembership).phase === 'completed'), 'original ' + kind + ' completes');
    const commands = rows(state.rosterCommands).filter(row => !prior.includes(row.commandId));
    assert.equal(commands.length, 1); const command = commands[0]!, decision = record(command.liveMembership);
    assert.equal(decision.phase, 'completed'); assert.equal(record(decision.delta).kind, kind);
    assert.equal(decision.launchId, launchId); assert.equal(decision.sourceCaptureDigest, runtimeDigest(record((await launch()).definition).capture));
    return { state, command, target: { commandId: text(command.commandId), memberId: text(record(decision.delta).targetId) } };
  };
  const ready = async (target: DesktopLiveMemberSelection, expectedProbeCount: 1 | 2) => {
    const identity = readMixedLiveMembershipIdentity(fixture.root, 'opencode', target);
    const state = await owner(), commands = rows(state.rosterCommands).filter(row => row.commandId === target.commandId);
    assert.equal(commands.length, 1); const decision = record(commands[0]!.liveMembership), view = record(decision.capture);
    const commandId = 'live-model-' + runtimeDigest({ commandId: target.commandId, capture: view.captureDigest });
    const context = runtimeDigest({ team: state.binding, commandId: target.commandId, capture: view.captureDigest });
    const currentLaunch = await launch(), readiness = launchReadinessSchema.parse(currentLaunch.readiness);
    const groups = readiness.groups.filter(row => row.commandId === commandId); assert.equal(groups.length, 1);
    const reference = groups[0]!, consumers = readiness.consumers.filter(row => row.groupCommandId === commandId);
    assert.equal(consumers.length, 1); const consumer = consumers[0]!;
    assert.equal(consumer.disposition, 'consumed'); assert.deepEqual(consumer.binding, identity.binding);
    assert.equal(consumer.memberId, target.memberId); assert.equal(consumer.configurationDigest, identity.selected.configurationDigest);
    assert.equal(consumer.configRevision, identity.selected.configRevision); assert.equal(reference.context, context);
    const envelope = await read(join(fixture.root, 'hoststore/management-commands', managementDigest(commandId) + '.json'), 256 * 1024);
    const { digest, ...body } = envelope; assert.equal(digest, managementDigest(body));
    const probe = storedModelProbeSchema.parse(body);
    assert.equal(probe.commandId, commandId); assert.equal(probe.context, context);
    assert.equal(probe.phase, 'completed'); assert.equal(probe.ok, true); assert.equal(probe.resourceHeld, false);
    assert.equal(probe.purpose, 'native-local-readiness-v1'); assert.equal(probe.readinessRetired, undefined);
    assert.equal(probe.readiness?.evidence.ordinary, 'confirmed');
    assert.equal(probe.readiness?.evidence.decision, 'allow');
    assert.equal(probe.readiness?.evidence.coordination, 'not-applicable');
    for (const key of ['profileId', 'configRevision', 'fingerprint', 'selectionDigest', 'resourceId', 'expiresAt'] as const)
      assert.equal(reference[key], probe[key]);
    assert.equal(reference.purpose, probe.purpose);
    assert.equal(reference.preparationDigest, managementDigest({ scope: probe.readinessScope,
      anchor: probe.localModelReadinessPreparation ?? null, origin: probe.localModelReadinessOrigin ?? null,
      ...(probe.nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness: managementDigest(probe.nativeFileKeyWitness) }) }));
    assert.ok(probe.readinessScope); assert.equal(probe.readinessScope.kind, 'team');
    assert.equal(reference.mechanismDigest, probe.readinessScope.mechanismDigest);
    assert.equal(probe.readinessScope.teamBindingDigest, runtimeDigest(state.binding));
    assert.equal(probe.readinessScope.sourceRevision, view.captureDigest);
    assert.equal(probe.readinessScope.actionDigest, runtimeDigest({ commandId: target.commandId, context }));
    assert.equal(probe.readinessScope.selectionDigest, runtimeDigest({ payload: decision.input, capture: view }));
    assert.equal(probe.readinessScope.rosterRevision, record(decision.input).expectedRevision);
    assert.equal(consumer.cutoff, reference.expiresAt);
    assert.ok(reference.expiresAt <= probe.readinessScope.cutoff);
    assert.equal(probe.readinessScope.workspace, workspace);
    assert.equal(probe.providerId, models.openCodeProviderId); assert.equal(probe.modelId, 'TEST-model');
    assert.deepEqual(probe.readinessScope.destinationKeys, [runtimeDigest({ launchId, memberId: target.memberId })]);
    assert.equal(models.opencode.probes.length, expectedProbeCount);
    const selected = await poll(sessions, value => value.some(row => runtimeDigest(row.binding) === runtimeDigest(identity.binding) &&
      row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true && row.sealed === false), 'original target native readiness');
    const session = selected.find(row => runtimeDigest(row.binding) === runtimeDigest(identity.binding))!;
    const config = record(session.config);
    assert.equal(config.sessionId, identity.sessionId); assert.equal(config.generation, identity.selected.runtimeGeneration);
    assert.equal(config.configRevision, identity.selected.configRevision); assert.deepEqual(session.inputs, []);
    const physical = await observe(['claude', 'codex', 'opencode']); await assertPeers(physical);
    const result = { identity, session, physical: physical.get('opencode')!, readiness: { reference, consumer,
      commandId, phase: probe.phase, resourceHeld: probe.resourceHeld, evidence: probe.readiness!.evidence } };
    step({ action: 'released-original-probe-before-runtime-census', commandId, binding: identity.binding }); return result;
  };
  const backToChats = async () => {
    if (await cdp.evaluate('Boolean(document.querySelector(\'button[aria-label="Back to chats"]\'))')) {
      await ui.scrollTo('button[aria-label="Back to chats"]', 'original Back to chats');
      await ui.click('button[aria-label="Back to chats"]', 'original Back to chats');
    }
  };
  const send = async (selected: Awaited<ReturnType<typeof ready>>, marker: 'TEST_LIVE_MEMBERSHIP_ADD' | 'TEST_LIVE_MEMBERSHIP_RESTORE', expected: 2 | 4) => {
    await backToChats(); await ui.click('button[aria-label^="carol,"]', 'original current Carol chat');
    await ui.click('.message-composer-flat-layout textarea', 'original Carol Composer');
    await cdp.send('Input.insertText', { text: marker });
    await ui.waitRead('document.querySelector(".message-composer-flat-layout textarea")?.value===' + literal(marker), 'original input retained');
    await ui.click('button.message-composer-send-button', 'send one explicit ' + marker, 'Send');
    await ui.waitRead('document.querySelector(".message-composer-flat-layout textarea")?.value===""&&document.body.innerText.includes(' +
      literal('REPLY_' + marker) + ')', 'real MCP message reply', 90_000);
    await revealDesktopReply(cdp, 'REPLY_' + marker, { assertOwnedRenderer: current, step });
    const terminal = await poll(sessions, value => {
      const session = value.find(row => runtimeDigest(row.binding) === runtimeDigest(selected.identity.binding));
      if (!session) return false; const inputs = rows(session.inputs);
      return inputs.length === 1 && inputs[0]!.phase === 'terminal' && inputs[0]!.terminal === 'succeeded';
    }, 'one original input reaches a native terminal');
    const session = terminal.find(row => runtimeDigest(row.binding) === runtimeDigest(selected.identity.binding))!;
    const input = rows(session.inputs)[0]!, intent = record(input.intent);
    assert.deepEqual(intent.binding, selected.identity.binding);
    assert.ok(text(intent.content).endsWith('\n\n' + marker));
    assert.equal(models.opencode.observations.length, expected);
    assert.deepEqual(models.opencode.observations.slice(expected - 2).map(row => [row.turn, row.step]), [[marker, 0], [marker, 1]]);
    await assertPeers(await observe(['claude', 'codex', 'opencode']));
    return { binding: selected.identity.binding, sessionRef: session.sessionRef, input, observations: models.opencode.observations.slice(expected - 2) };
  };
  await backToChats();
  const beforeAdd = await owner();
  await ui.scrollTo('[data-section-id="team"] button', 'original Add Members control', 'Add');
  await ui.click('[data-section-id="team"] button', 'open original Add Members dialog', 'Add');
  await ui.waitRead('Boolean(document.querySelector(\'[role="dialog"] input[aria-label="Member 1 name"]\'))', 'original member name input');
  await replace(cdp, ui, '[role="dialog"] input[aria-label="Member 1 name"]', 'carol', 'exact new member name');
  const picker = '[role="dialog"] button[aria-label*=" provider,"]';
  await ui.scrollTo(picker, 'original new member model selector'); await ui.click(picker, 'expand original new member model selector');
  const local = '[role="dialog"] [data-testid="team-model-selector-provider-nav-local-models"]';
  await ui.scrollTo(local, 'original Local models navigation'); await ui.click(local, 'select original Local models');
  const model = '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]';
  await ui.scrollTo(model, 'original configured keyed TEST-model'); await ui.click(model, 'select original configured TEST-model');
  assert.equal(models.opencode.probes.length, 0, 'passive keyed inventory does not run a model probe');
  assert.equal(models.opencode.observations.length, 0); await assertPeers(await observe(peerProviders));
  membership.advance('add');
  await ui.scrollTo('[role="dialog"] > div:last-child > button', 'original Add submit', 'Add member');
  await ui.click('[role="dialog"] > div:last-child > button', 'one original live Add', 'Add member');
  const added = await commandAfter(beforeAdd, 'add');
  await ui.waitRead('!document.querySelector(\'[role="dialog"] input[aria-label="Member 1 name"]\')', 'original Add dialog closes');
  const addedMember = rows(added.state.members).find(row => row.memberId === added.target.memberId); assert.ok(addedMember);
  assert.equal(addedMember.name, 'carol'); assert.equal(record(addedMember.settings).providerId, 'opencode');
  assert.equal(record(addedMember.settings).model, models.openCodeProviderId + '/TEST-model');
  const addedReady = await ready(added.target, 1); membership.advance('add-ready', added.target);
  proof.added = { commandId: added.target.commandId, ...addedReady };
  proof.addInput = await send(addedReady, 'TEST_LIVE_MEMBERSHIP_ADD', 2);
  await backToChats();
  const beforeRemove = await owner(); membership.advance('remove');
  await ui.scrollTo('[data-section-id="team"] [role="button"] span.font-medium', 'original exact Carol detail', 'carol');
  await ui.click('[data-section-id="team"] [role="button"] span.font-medium', 'open original exact Carol detail', 'carol');
  await ui.click('[role="dialog"] button', 'request original Remove once', 'Remove');
  const confirmation = text(await ui.waitRead('(() => {const dialogs=[...document.querySelectorAll(\'[role="dialog"]\')].filter(node=>' +
    'node.querySelector("h2")?.textContent.trim()==="Remove member"&&node.textContent.includes("Tasks and messages will be preserved"));' +
    'return dialogs.length===1&&dialogs[0].id||null})()', 'original Remove member confirmation'));
  await ui.click('[role="dialog"][id=' + literal(confirmation) + '] > div:last-child > button', 'confirm original Remove once', 'Remove');
  const removed = await commandAfter(beforeRemove, 'remove'); assert.equal(removed.target.memberId, added.target.memberId);
  assert.equal(rows(removed.state.members).length, 2);
  const tombstones = rows(removed.state.removedMembers).filter(row => row.memberId === added.target.memberId);
  assert.equal(tombstones.length, 1); assert.equal(tombstones[0]!.name, 'carol'); assert.ok(tombstones[0]!.removedAt);
  assert.deepEqual(tombstones[0]!.settings, addedMember.settings);
  assert.ok(rows(removed.state.grants).filter(row => row.principalId === addedReady.identity.principalId).every(row => row.revoked === true));
  const removedSessions = await poll(sessions, value => value.some(row => runtimeDigest(row.binding) === runtimeDigest(addedReady.identity.binding) &&
    row.phase === 'closed' && row.custody === 'released'), 'original removed generation is released');
  await poll(async () => processFacts(), table => !table.some(row => row.pid === addedReady.physical.pid), 'original removed native process absent');
  current();
  const configurationResult = record(await cdp.evaluate('window.electronAPI.agentBackend.invoke({handle:' +
    literal({ handleId }) + ',commandId:crypto.randomUUID(),operation:"team.launch.configuration.read",payload:' + literal({ launchId }) + '})'));
  current(); assert.equal(configurationResult.ok, true);
  const configuration = record(configurationResult.value);
  assert.equal(record(configuration.launch).launchId, launchId);
  const configuredMembers = rows(configuration.members, 3);
  assert.deepEqual(configuredMembers.map(row => row.memberId).sort(),
    [...peers.map(peer => peer.identity.memberId), added.target.memberId].sort());
  assert.equal(configuredMembers.find(row => row.memberId === added.target.memberId)!.selected, null,
    'removed current configuration remains nonrunnable while its history is retained');
  for (const peer of peers)
    assert.equal(record(configuredMembers.find(row => row.memberId === peer.identity.memberId)!.selected).provider, peer.provider);
  await assertPeers(await observe(peerProviders));
  assert.deepEqual([models.opencode.probes.length, models.opencode.observations.length], [1, 2]);
  proof.removed = { commandId: removed.target.commandId, member: tombstones[0], sessions: removedSessions, configuration, released: true };
  const restoreSelector = '[data-section-id="team"] button[aria-label="Restore teammate"]';
  await ui.waitRead('(() => {const controls=[...document.querySelectorAll(' + literal(restoreSelector) +
    ')];return controls.length===1&&controls[0].closest(\'[role="button"]\')?.querySelector("span.font-medium")?.textContent.trim()==="carol"})()',
    'Restore belongs to the exact original Carol');
  const beforeRestore = await owner(); membership.advance('restore');
  await ui.scrollTo(restoreSelector, 'original removed Carol control'); await ui.click(restoreSelector, 'restore original Carol once');
  const restored = await commandAfter(beforeRestore, 'restore'); assert.equal(restored.target.memberId, added.target.memberId);
  assert.equal(rows(restored.state.members).length, 3); assert.equal(rows(restored.state.removedMembers).length, 0);
  assert.deepEqual(rows(restored.state.members).find(row => row.memberId === added.target.memberId)!.settings, addedMember.settings);
  const restoredReady = await ready(restored.target, 2);
  for (const field of ['principalId', 'sessionId'] as const) assert.notEqual(restoredReady.identity[field], addedReady.identity[field]);
  assert.notEqual(restoredReady.identity.binding.generation, addedReady.identity.binding.generation);
  assert.notEqual(restoredReady.identity.selected.runtimeGeneration, addedReady.identity.selected.runtimeGeneration);
  assert.notEqual(text(restoredReady.session.sessionRef), text(addedReady.session.sessionRef));
  assert.notEqual(restoredReady.physical.pid, addedReady.physical.pid);
  assert.ok(!processFacts().some(row => row.pid === addedReady.physical.pid));
  membership.advance('restore-ready', restored.target);
  proof.restored = { commandId: restored.target.commandId, ...restoredReady };
  proof.restoreInput = await send(restoredReady, 'TEST_LIVE_MEMBERSHIP_RESTORE', 4);
  await ui.scrollTo('button[aria-label="Stop"]', 'original whole Team Stop');
  await ui.click('button[aria-label="Stop"]', 'one original whole Team Stop', 'Stop');
  const stopped = await poll(sessions, value => value.length === 4 &&
    value.every(row => row.phase === 'closed' && row.custody === 'released'), 'all four original Runtime generations released');
  assert.equal(stopped.reduce((total, row) => total + rows(row.inputs).length, 0), 2);
  const allBirths = [...peers.map(row => row.physical), addedReady.physical, restoredReady.physical];
  assert.equal(new Set(allBirths.map(row => row.pid)).size, 4);
  await poll(async () => processFacts(), table => allBirths.every(row => !table.some(live => live.pid === row.pid)), 'all four original native births absent');
  await observe([]); membership.advance('stopped'); await pins();
  const beforeColdOwner = await owner(), beforeColdLaunch = await launch(), beforeColdSource = await sourceProfiles();
  const beforeQuitProbes = await probeLedger(); let afterQuitProbes: Awaited<ReturnType<typeof probeLedger>> | undefined;
  assert.equal(rows(beforeColdOwner.runtimeCaptures).length, 1);
  assert.equal(rows(beforeColdOwner.rosterCommands).filter(row => row.liveMembership !== undefined).length, 3);
  const currentBindings = rows(beforeColdOwner.members).map(row => ({ memberId: row.memberId, delivery: row.delivery }));
  assert.equal(currentBindings.length, 3);
  proof.beforeCold = { sessions: stopped, currentBindings, launch: beforeColdLaunch,
    rosterCommands: beforeColdOwner.rosterCommands, sources: beforeColdSource, nativeBirthsAbsent: allBirths };
  cdp = await options.restartSameProfile(handleId, async () => {
    await releasedEpoch(); afterQuitProbes = await probeLedger();
    assert.deepEqual(afterQuitProbes.map(({ commandId, fingerprint }) => ({ commandId, fingerprint })),
      beforeQuitProbes.map(({ commandId, fingerprint }) => ({ commandId, fingerprint })));
    proof.originalProbeLedgerAfterQuit = afterQuitProbes;
  });
  assert.ok(afterQuitProbes);
  host = undefined; lineage = undefined; metadataBirths = [];
  ui = createDesktopUiControls(cdp, { assertOwnedRenderer: current, step });
  await ui.observeInput(); await observe([]);
  assert.deepEqual(await sessions(), stopped);
  assert.deepEqual(await sourceProfiles(), beforeColdSource);
  assert.deepEqual(await probeLedger(), afterQuitProbes, 'cold discovery cannot prepare a new group');
  const coldOwner = await owner();
  assert.deepEqual(coldOwner.rosterCommands, beforeColdOwner.rosterCommands);
  assert.deepEqual(coldOwner.runtimeCaptures, beforeColdOwner.runtimeCaptures);
  assert.deepEqual(rows(coldOwner.members).map(row => ({ memberId: row.memberId, delivery: row.delivery })), currentBindings);
  assert.deepEqual(await launch(), beforeColdLaunch);
  await openTeam(); await backToChats(); await ui.click('button[aria-label^="carol,"]', 'original restored Carol cold history');
  await ui.waitRead('document.body.innerText.includes("TEST_LIVE_MEMBERSHIP_ADD")&&document.body.innerText.includes("TEST_LIVE_MEMBERSHIP_RESTORE")',
    'both original user input histories visible without sending');
  assert.deepEqual(readMixedLiveMembershipIdentity(fixture.root, 'opencode', restored.target), restoredReady.identity);
  assert.deepEqual([models.opencode.probes.length, models.opencode.observations.length], [2, 4]);
  assert.deepEqual([models.claude.probes.length, models.codex.probes.length], peerProbeCounts);
  assert.deepEqual(await sessions(), stopped); await observe([]); await pins();
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  const screenshotPath = join(fixture.root, 'ui-original-live-membership.png');
  await writeFile(screenshotPath, Buffer.from(text(screenshot.data), 'base64'), { mode: 0o600, flag: 'wx' });
  proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  proof.coldHistory = { unchanged: true, noPreparation: true, noInput: true, noRuntimeAllocation: true };
  return { finishSettings: async () => {
    await releasedEpoch();
    assert.equal(epochs.length, 2);
    for (const model of modelRows) assert.deepEqual(model.failures, []);
    for (const model of [models.claude, models.codex]) {
      assert.equal(model.observations.length, 0); assert.equal(model.notificationObservations?.length ?? 0, 0);
    }
    assert.deepEqual([models.claude.probes.length, models.codex.probes.length], peerProbeCounts);
    assert.deepEqual([models.opencode.probes.length, models.opencode.observations.length], [2, 4]);
    assert.deepEqual(await sessions(), stopped); assert.deepEqual(await sourceProfiles(), beforeColdSource);
    assert.deepEqual(await probeLedger(), afterQuitProbes);
    await pins();
    proof.counts = { ordinaryProbes: 2, businessRequests: 4, inputs: 2, runtimeGenerations: 4 };
    proof.status = 'PASS';
  } };
}
