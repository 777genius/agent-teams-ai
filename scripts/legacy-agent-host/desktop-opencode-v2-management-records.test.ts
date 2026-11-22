import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { teamHostProfileSchema } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { selectOpenCodeV2ManagementModel } from '../../packages/legacy-agent-host/dist/composition/openCodeV2ModelSelection.js';
import { selectRuntimeSourceSeed } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceGrantAuthority.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { assertDesktopV2ManagementSourceHistory, bindDesktopV2ManagementReceipt,
  captureDesktopV2ManagementAuthority, readDesktopV2ManagementPublication } from './desktop-opencode-v2-management-records.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';
import { captureDesktopSourceMetadataLineage, assertDesktopMetadataLineageReleased } from './desktop-opencode-metadata-lineage.ts';
import { createDesktopMetadataWitness, readDesktopMetadataSourceFile } from './desktop-metadata-witness.ts';
import { createDesktopLinuxMetadataBirthReader, createDesktopMetadataBirthCensus } from './desktop-metadata-birth-census.ts';
import type { StoredRuntimeSourceCommand } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import type { PublishRuntimeSource } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';
import './desktop-live-membership-census.test.ts';

async function retainedEvidence() {
  const bytes = await readFile(new URL('./fixtures/c226-opencode-v2-management.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f3720ccacff5f36965ed38f018da34e6427eac53249e3da7cafc857b9e202ce2');
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.equal(evidence.provenance.artifactId, 14132244497);
  assert.equal(evidence.provenance.artifactSha256, '0bf8c381830ba401266d2702081e2a0a425e27838ead18b5bbedd34b14d94d44');
  assert.equal(evidence.profile.management[0].embedded.platform, 'linux');
  assert.equal(evidence.profile.management[0].embedded.arch, 'x64');
  return evidence;
}

/** Pure archived records or injected in-memory I/O only: no real filesystem/native operation under this tuple. */
function withTuple<T>(platform: 'linux' | 'darwin', arch: 'x64' | 'arm64', work: () => T): T {
  const original = { platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
    arch: Object.getOwnPropertyDescriptor(process, 'arch')! };
  assert.ok(original.platform && original.arch);
  try {
    Object.defineProperties(process, { platform: { ...original.platform, value: platform },
      arch: { ...original.arch, value: arch } });
    return work();
  } finally { Object.defineProperties(process, original); }
}

function decodeRetained(evidence: Awaited<ReturnType<typeof retainedEvidence>>) {
  const profile = teamHostProfileSchema.parse(evidence.profile);
  const commands = evidence.commandFiles.map((file: { name: string; envelope: Record<string, unknown> }) => {
    const { digest, ...body } = file.envelope;
    assert.equal(digest, managementDigest(body));
    const row = storedManagementCommandSchema.parse(body);
    assert.equal(file.name, managementDigest(row.commandId) + '.json'); return row;
  }) as ReturnType<typeof storedManagementCommandSchema.parse>[];
  const publication = commands.find((row): row is StoredRuntimeSourceCommand => row.kind === 'runtime.source')!;
  const command = commands.find(row => row.kind === 'credential.set')!;
  assert.ok(publication && command);
  const authority = captureDesktopV2ManagementAuthority(evidence.root, profile, evidence.descriptor);
  return { evidence, profile, commands, publication, command, authority };
}

async function retained(assertions: (fixture: ReturnType<typeof decodeRetained>) => void) {
  const evidence = await retainedEvidence();
  withTuple('linux', 'x64', () => assertions(decodeRetained(evidence)));
}

test('retained c226 original rejected-key receipt joins its published seed and exact observed native probe', () => retained(({ evidence, profile, commands, publication, command, authority }) => {
  // The old seed-only comparison is the actual recorded CI failure, before any second intent.
  assert.throws(() => assert.equal(command.profileId, profile.management![0]!.profileId));
  const selected = bindDesktopV2ManagementReceipt(authority, commands, command, 'reject-key');
  assert.equal(selected.evidence.commandId, publication.commandId);
  assert.equal(selected.evidence.sourceId, '5d2039fc7d18b20e4ae45268eddb08d91114a10e25fd8f3ad4eda588553c581c');
  assert.equal(selected.evidence.revision, 'b8f6d61925db80b67831f090b33414555515ab550bd85fa958ccd0c3a3d46c80');
  assert.equal(selected.profile.profileId, command.profileId);
  assert.deepEqual(selected.profile.executable, profile.management![0]!.executable);
  assert.deepEqual(selected.profile.environment, profile.management![0]!.environment);
  assert.equal(selected.profile.accountBinding, profile.management![0]!.accountBinding);
  assert.equal(command.kind, 'credential.set'); if (command.kind !== 'credential.set') throw new Error('Original key command missing');
  const nativeProfile = selectOpenCodeV2ManagementModel(selected.profile, {
    providerId: 'test-local', modelId: command.openCodeV2!.verification!.modelId,
  });
  const prefix = 'agent-teams-v2-probe-' + managementDigest({ profile: nativeProfile,
    commandId: command.openCodeV2!.verification!.commandId }).slice(0, 16) + '-';
  assert.ok(basename(evidence.probe.dataRoot).startsWith(prefix));
  assert.equal(prefix, 'agent-teams-v2-probe-c66864101ac6d673-');
}));

test('V2 receipt binding rejects foreign revisions, scope, seed owner, engine and executable', () => retained(({ commands, command, authority }) => {
  for (const field of ['profileId', 'configRevision'] as const)
    assert.throws(() => bindDesktopV2ManagementReceipt(authority, commands,
      { ...command, [field]: 'runtime-source:' + 'f'.repeat(64) }, 'reject-key'));
  assert.throws(() => bindDesktopV2ManagementReceipt(authority, commands, command, 'project-default'));
  for (const mutate of [
    (next: typeof authority) => { next.profile.owner.ownerId = 'TEST-foreign-owner'; },
    (next: typeof authority) => { next.profile.management![0]!.executable.sha256 = 'f'.repeat(64); },
    (next: typeof authority) => {
      const seed = next.profile.management![0]!;
      if (seed.provider !== 'opencode') throw new Error('Expected V2 seed');
      Object.defineProperty(seed, 'protocolRevision', { value: 'TEST-foreign-version' });
    },
  ]) {
    const changed = structuredClone(authority); mutate(changed);
    assert.throws(() => bindDesktopV2ManagementReceipt(changed, commands, command, 'reject-key'));
  }
}));

test('V2 publication rejects an internally rehashed foreign descriptor grant or replacement executable', () => retained(({ publication, authority }) => {
  for (const mutate of [
    (input: PublishRuntimeSource) => { input.grant.ownerId = 'TEST-foreign-owner'; },
    (input: PublishRuntimeSource) => { input.grant.contextId = 'TEST-foreign-context'; },
    (input: PublishRuntimeSource) => { input.candidate.executable.sha256 = 'f'.repeat(64); },
  ]) {
    const input = JSON.parse(publication.publicationJson!); mutate(input);
    const changed = { ...publication, fingerprint: runtimeDigest(input), publicationJson: JSON.stringify(input),
      selectionDigest: runtimeDigest({ grant: input.grant, seed: authority.profile.management![0] }),
      revision: runtimeDigest({ previousRevision: input.expectedRevision, commandId: input.commandId,
        grant: input.grant, candidate: input.candidate, intent: input.intent }) };
    assert.throws(() => readDesktopV2ManagementPublication(authority, changed));
  }
}));

test('V2 source history accounts for every publication and the exact retained current chain', () => retained(({ publication, authority, commands, command }) => {
  const input = JSON.parse(publication.publicationJson!);
  const body = { schemaVersion: 1, records: [{ previousRevision: input.expectedRevision,
    commandId: input.commandId, grant: input.grant, candidate: input.candidate, intent: input.intent,
    revision: publication.revision }], current: [{ sourceId: publication.sourceId,
    revision: publication.revision, commandId: publication.commandId }] };
  const index = { ...body, digest: runtimeDigest(body) };
  assert.equal(assertDesktopV2ManagementSourceHistory(authority, commands, index).length, 1);
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, [command], index));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, [...commands, publication], index));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority,
    commands.map(row => row.kind === 'runtime.source' ? { ...row, phase: 'held' } : row), index));
  const rewritten = structuredClone(body); rewritten.current[0]!.revision = 'f'.repeat(64);
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, commands,
    { ...rewritten, digest: runtimeDigest(rewritten) }));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, commands,
    { ...index, digest: 'f'.repeat(64) }));
}));

test('original Host rejects old other-project cwd and accepts only its separate exact private-account seed', () => retained(({ authority, evidence, profile }) => {
  const foreignCwd = authority.grants.find(row => row.projectPath === join(evidence.root, 'workspace-other'))!;
  assert.throws(() => selectRuntimeSourceSeed(profile, foreignCwd));
  const other = { ...structuredClone(profile.management![0]!), profileId: 'TEST-v2-settings-management-other',
    cwd: join(evidence.root, 'workspace-other') };
  profile.management!.push(other); evidence.descriptor.management[2].profileId = other.profileId;
  const corrected = captureDesktopV2ManagementAuthority(evidence.root, profile, evidence.descriptor);
  assert.deepEqual(corrected.grants.map(grant => selectRuntimeSourceSeed(profile, grant).profileId),
    [profile.management![0]!.profileId, profile.management![0]!.profileId, other.profileId]);
  assert.deepEqual(other.environment, profile.management![0]!.environment);
  assert.deepEqual(other.executable, profile.management![0]!.executable);
  assert.equal(other.accountBinding, profile.management![0]!.accountBinding);
}));

test('archived V2 tuple isolation restores the real runner and preserves foreign-platform refusal', async () => {
  const evidence = await retainedEvidence();
  const original = () => ({ platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch') });
  const before = original();
  const refused = () => {
    const result = teamHostProfileSchema.safeParse(evidence.profile);
    assert.equal(result.success, false);
    if (result.success) assert.fail('Foreign archived tuple must remain inadmissible');
    assert.ok(result.error.issues.some(issue => issue.message === 'OpenCode V2 delivery must match the native platform' &&
      JSON.stringify(issue.path) === JSON.stringify(['management', 0, 'embedded'])));
  };
  if (process.platform !== 'linux' || process.arch !== 'x64') refused();
  withTuple('darwin', 'arm64', refused);
  withTuple('linux', 'arm64', refused);
  assert.deepEqual(original(), before);
  const failure = new Error('TEST pure archived assertion failure');
  assert.throws(() => withTuple('linux', 'x64', () => {
    assert.equal(teamHostProfileSchema.safeParse(evidence.profile).success, true);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(original(), before, 'failed assertions also restore exact original property descriptors');
});

test('original V2 default intent joins its selected saving row within the same receipt deadline', async () => {
  const source = await readFile(new URL('./desktop-opencode-v2-management-ui.ts', import.meta.url), 'utf8');
  const start = '  const originalStep = async (', end = '  const dialog = \'[role="dialog"]\';';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  let block = source.slice(source.indexOf(start), source.indexOf(end));
  for (const [before, after] of [
    ['(step: DesktopV2ManagementStep, selector: string, label: string)', '(step, selector, label)'],
    ['let receipt: Awaited<ReturnType<typeof commands>>[number] | undefined;', 'let receipt;'],
    ['new Promise<void>', 'new Promise'],
  ] as const) {
    assert.equal(block.split(before).length, 2, 'only the original TypeScript annotation is erased');
    block = block.replace(before, after);
  }
  type State = { now: number; commands: number; clicks: number; scrolls: number; reads: number;
    pauses: number; finishes: number; begins: number; bindings: number; native: number; guards: number;
    busy: boolean; selected: boolean; rowCount: number; buttonCount: number; width: number; revoked: boolean };
  const setup = (step: string, settings: { initial?: Partial<State>;
    onRead?: (state: State) => void; onPause?: (state: State) => void;
    onCommands?: (state: State) => void } = {}) => {
    const state: State = { now: 0, commands: 0, clicks: 0, scrolls: 0, reads: 0, pauses: 0,
      finishes: 0, begins: 0, bindings: 0, native: 0, guards: 0, busy: true, selected: true,
      rowCount: 1, buttonCount: 1, width: 10, revoked: false, ...settings.initial };
    const modelA = 'test-local/TEST-model', modelB = 'test-local/TEST-project-model';
    const defaultIntent = step === 'global-default' || step === 'project-default';
    const expectedModel = step === 'global-default' ? modelA : modelB;
    const expectedRow = '[role="dialog"] [data-testid=' +
      JSON.stringify('runtime-provider-model-row-' + expectedModel) + ']';
    const receipt = { commandId: 'TEST-original-command', kind: 'model.probe', phase: 'completed',
      resourceHeld: false, providerId: 'test-local', ok: true, modelId: expectedModel };
    const effects: Record<string, unknown>[] = [], authority = {}, evidence = { original: true };
    const revoked = new Error('TEST original owner revoked');
    const button = {
      disabled: true,
      getBoundingClientRect: () => ({ width: state.width, height: 10 }),
      getAttribute: (name: string) => { assert.equal(name, 'aria-pressed'); return String(state.selected); },
      querySelector: (selector: string) => {
        assert.equal(selector, ':scope > svg.animate-spin'); return state.busy ? {} : null;
      },
    };
    const row = { querySelectorAll: (selector: string) => {
      assert.equal(selector, 'button[aria-pressed]'); return Array.from({ length: state.buttonCount }, () => button);
    } };
    const run: (step: string, selector: string, label: string) => Promise<void> = runInNewContext(
      '(function () {\n' + block + '\nreturn originalStep; })()', {
        assert, desktopJsLiteral, desktopV2ProviderId: 'test-local', modelA, modelB,
        dialog: '[role="dialog"]', authority, effects, Date: { now: () => state.now },
        commands: async () => {
          state.commands++;
          settings.onCommands?.(state);
          return state.commands === 1 ? [] : [receipt];
        },
        bindDesktopV2ManagementReceipt: (owner: unknown, rows: unknown[], command: unknown, intent: string) => {
          assert.equal(owner, authority); assert.equal(rows[0], receipt);
          assert.equal(command, receipt); assert.equal(intent, step); state.bindings++; return { evidence };
        },
        options: {
          assertOwnedRenderer: () => { state.guards++; if (state.revoked) throw revoked; },
          observeNative: async () => { state.native++; },
        },
        model: {
          begin: (intent: string) => { assert.equal(intent, step); state.begins++; },
          finish: (intent: string) => {
            assert.equal(intent, step);
            if (defaultIntent) assert.equal(state.busy, false, 'terminal probe must not finish the still-saving default intent');
            state.finishes++;
          },
        },
        ui: {
          scrollTo: async () => { state.scrolls++; },
          click: async () => { state.clicks++; },
        },
        cdp: { evaluate: async (expression: string) => {
          state.reads++;
          const result = runInNewContext(expression, { document: { querySelectorAll: (selector: string) => {
            assert.equal(selector, expectedRow, 'read only the exact original model and dialog');
            return Array.from({ length: state.rowCount }, () => row);
          } } });
          settings.onRead?.(state); return result;
        } },
        setTimeout: (complete: () => void, delay: number) => {
          assert.equal(delay, 100); state.pauses++; state.now += delay;
          if (settings.onPause) settings.onPause(state); else state.busy = false;
          complete();
        },
      });
    return { state, receipt, effects, evidence, revoked, run: () => run(step, 'TEST original selector', 'TEST original label') };
  };
  for (const step of ['global-default', 'project-default']) {
    const f = setup(step); await f.run();
    assert.deepEqual({ clicks: f.state.clicks, scrolls: f.state.scrolls, reads: f.state.reads, pauses: f.state.pauses,
      begins: f.state.begins, finishes: f.state.finishes, bindings: f.state.bindings, native: f.state.native,
      commands: f.state.commands }, {
      clicks: 1, scrolls: 1, reads: 2, pauses: 1, begins: 1, finishes: 1, bindings: 1, native: 2, commands: 4,
    });
    assert.equal(f.state.now, 100); assert.equal(f.state.busy, false);
    assert.equal(f.effects.length, 1); assert.equal(f.effects[0]!.commandId, f.receipt.commandId);
    assert.equal(f.effects[0]!.source, f.evidence);
  }
  for (const initial of [
    { rowCount: 0 }, { rowCount: 2 }, { buttonCount: 0 }, { buttonCount: 2 },
    { selected: false }, { width: 0 }, { busy: true },
  ]) {
    const f = setup('global-default', { initial: { busy: false, ...initial },
      onPause: state => { state.now = 250_000; } });
    await assert.rejects(f.run(), /original V2 Settings command settled before its deadline/u);
    assert.equal(f.state.clicks, 1); assert.equal(f.state.reads, 1); assert.equal(f.state.pauses, 1);
    assert.equal(f.state.finishes, 0); assert.equal(f.state.bindings, 0); assert.equal(f.effects.length, 0);
  }
  for (const now of [250_000, 250_001]) {
    const f = setup('project-default', { initial: { busy: false }, onRead: state => { state.now = now; } });
    await assert.rejects(f.run(), /original default intent completes before its deadline/u);
    assert.equal(f.state.reads, 1); assert.equal(f.state.pauses, 0);
    assert.equal(f.state.finishes, 0); assert.equal(f.effects.length, 0);
  }
  const revoked = setup('global-default', { initial: { busy: false }, onRead: state => { state.revoked = true; } });
  await assert.rejects(revoked.run(), error => error === revoked.revoked);
  assert.equal(revoked.state.clicks, 1); assert.equal(revoked.state.reads, 1);
  assert.equal(revoked.state.finishes, 0); assert.equal(revoked.effects.length, 0);
  for (const step of ['global-default', 'project-default']) {
    const beforeRead = setup(step, { initial: { busy: false },
      onCommands: state => { if (state.commands === 2) state.revoked = true; } });
    await assert.rejects(beforeRead.run(), error => error === beforeRead.revoked);
    assert.equal(beforeRead.state.commands, 2, 'owner is revoked by the original awaited receipt read');
    assert.equal(beforeRead.state.clicks, 1);
    assert.equal(beforeRead.state.reads, 0, 'no DOM evaluation after the receipt read revokes its owner');
    assert.equal(beforeRead.state.finishes, 0);
    assert.equal(beforeRead.state.bindings, 0);
    assert.equal(beforeRead.effects.length, 0);
  }
  const ordinary = setup('project-test'); await ordinary.run();
  assert.equal(ordinary.state.clicks, 1); assert.equal(ordinary.state.reads, 0); assert.equal(ordinary.state.pauses, 0);
  assert.equal(ordinary.state.finishes, 1); assert.equal(ordinary.effects.length, 1);
});

test('metadata read failures cannot acquire or retire an original native lifecycle', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-metadata-observation-')));
  try {
    const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host', command: '/TEST/node' };
    const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-child', command: '/TEST/bun' };
    const ready = { hostPid: host.pid, profileHash: 'a'.repeat(64), mode: 'directory', providerHash: null,
      pid: child.pid, startIdentityHash: 'b'.repeat(64), stage: 'ready' };
    const preReadyFailure = { hostPid: host.pid, profileHash: 'c'.repeat(64), mode: 'directory', providerHash: null,
      stage: 'read-failed', readStage: 'native-client', reason: 'unknown', elapsedMs: 0,
      deadlineExpired: false, aborted: null };
    const liveFailure = { ...preReadyFailure, profileHash: ready.profileHash, mode: 'provider', providerHash: 'd'.repeat(64),
      readStage: 'directory', reason: 'transport_failure', elapsedMs: 3_600_000, deadlineExpired: true, aborted: true };
    const captured = { host, children: [child] };
    const directory = join(root, 'userData/logs'); await mkdir(directory, { recursive: true });
    const write = (rows: readonly unknown[]) => writeFile(join(directory, 'app-errors.ndjson'),
      rows.map(row => JSON.stringify({ namespace: 'Host:OpenCodeMetadata',
        message: 'OpenCode metadata stage ' + JSON.stringify(row) })).join('\n') + '\n');
    await write([ready]);
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    const original = captureDesktopSourceMetadataLineage({ ...options, observed: [child] });
    await write([preReadyFailure, ready, liveFailure]);
    assert.deepEqual(captureDesktopSourceMetadataLineage({ ...options, observed: [child], original }), original,
      'closed read failures neither create another profile/partition nor retire the already-ready original child');
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed: [], original }),
      /original ready is physically present/);
    const partition = original.partitions[0]; assert.ok(partition);
    const owned = { ...captured, metadataLineage: partition };
    assert.throws(() => assertDesktopMetadataLineageReleased(root, owned, []), /confirmed close/);
    await write([preReadyFailure]);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed: [] }),
      /finite original metadata lifecycle observations/, 'a pre-ready failure cannot synthesize custody');
    await write([ready, liveFailure, { ...ready, stage: 'cleanup-unknown' }]);
    assert.throws(() => assertDesktopMetadataLineageReleased(root, owned, []), /unknown cleanup/);
    const released = { ...ready, stage: 'released' };
    await write([preReadyFailure, ready, liveFailure, released, { ...liveFailure, aborted: false }]);
    const closed = assertDesktopMetadataLineageReleased(root, owned, []);
    assert.deepEqual(closed.events, [ready, released]);
    assert.deepEqual(closed.births, [child]);
    assert.throws(() => assertDesktopMetadataLineageReleased(root, owned, [{ pid: child.pid }]), /metadata PID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('metadata observation separation still refuses malformed diagnostics and unknown lifecycle rows', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-metadata-closed-shape-')));
  try {
    const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host', command: '/TEST/node' };
    const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-child', command: '/TEST/bun' };
    const ready = { hostPid: host.pid, profileHash: 'a'.repeat(64), mode: 'directory', providerHash: null,
      pid: child.pid, startIdentityHash: 'b'.repeat(64), stage: 'ready' };
    const failure = { hostPid: host.pid, profileHash: ready.profileHash, mode: 'directory', providerHash: null,
      stage: 'read-failed', readStage: 'native-client', reason: 'held', elapsedMs: 1,
      deadlineExpired: false, aborted: null };
    const directory = join(root, 'userData/logs'); await mkdir(directory, { recursive: true });
    for (const invalid of [
      { ...failure, extra: 'TEST-private' }, { ...failure, pid: child.pid },
      { ...failure, startIdentityHash: ready.startIdentityHash }, { ...failure, aborted: undefined },
      { ...failure, readStage: 'unknown-stage' }, { ...failure, reason: 'TEST-private-reason' },
      { ...failure, profileHash: 'TEST-invalid' }, { ...failure, mode: 'provider' },
      { ...failure, providerHash: 'd'.repeat(64) }, { ...failure, elapsedMs: -1 },
      { ...failure, elapsedMs: 3_600_001 }, { ...failure, elapsedMs: 0.5 },
      { ...failure, elapsedMs: null }, { ...failure, deadlineExpired: 1 }, { ...failure, aborted: 1 },
      { ...failure, stage: 'unknown' }, { ...failure, stage: 'released' },
      { ...ready, extra: true }, { ...ready, startIdentityHash: undefined }, { ...ready, pid: 1 },
    ]) {
      await writeFile(join(directory, 'app-errors.ndjson'), [ready, invalid].map(row => JSON.stringify({
        namespace: 'Host:OpenCodeMetadata', message: 'OpenCode metadata stage ' + JSON.stringify(row),
      })).join('\n') + '\n');
      assert.throws(() => captureDesktopSourceMetadataLineage({ root, host, profileHashes: [ready.profileHash],
        observed: [child], executable: child.command }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Constructed finite observations reproduce the original 806 Create-time handoff, not native acceptance.
async function withEarlyMetadata(work: (fixture: {
  root: string;
  host: { pid: number; parentPid: number; groupId: number; birth: string; command: string };
  child: { pid: number; parentPid: number; groupId: number; birth: string; command: string };
  ready: { hostPid: number; profileHash: string; mode: 'provider'; providerHash: string;
    pid: number; startIdentityHash: string; stage: 'ready' };
  write(events: readonly unknown[]): Promise<unknown>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-early-metadata-')));
  try {
    const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'linux-starttime:100', command: '/TEST/node' };
    const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
    const ready = { hostPid: host.pid, profileHash: 'a'.repeat(64), mode: 'provider' as const,
      providerHash: 'c'.repeat(64), pid: child.pid, startIdentityHash: createHash('sha256').update('11:110').digest('hex'),
      stage: 'ready' as const };
    const directory = join(root, 'userData/logs'); await mkdir(directory, { recursive: true });
    const write = (events: readonly unknown[]) => writeFile(join(directory, 'app-errors.ndjson'),
      events.map(event => JSON.stringify({ namespace: 'Host:OpenCodeMetadata',
        message: 'OpenCode metadata stage ' + JSON.stringify(event) })).join('\n') + '\n');
    await work({ root, host, child, ready, write });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('early live metadata witness survives release before the first membership census', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: ['d'.repeat(64), ready.profileHash], executable: child.command };
    let observed = [child];
    const witness = createDesktopMetadataWitness(() => ({ ...options, observed }));
    await write([ready]); witness.observe();
    assert.deepEqual(witness.read()!.partitions[0]!.births, [child]);
    await write([ready, { ...ready, stage: 'released' }]); observed = [];
    witness.observe();
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed }),
      /a retired profile needs its previously retained physical lineage/, 'the original missing-witness refusal is unchanged');
    const current = captureDesktopSourceMetadataLineage({ ...options, observed, witness });
    assert.deepEqual(current.live, []);
    assert.deepEqual(current.partitions[0]!.births, [child]);
    assert.deepEqual(current.events.map(row => row.stage), ['ready', 'released']);
  });
});

test('a metadata release after the sampled live census cannot replace its original event snapshot', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    // The reader already observed these ready bytes and this live kernel birth before release.
    const witness = createDesktopMetadataWitness(() => ({ ...options, observed: [child], events: [ready] }));
    await write([ready, { ...ready, stage: 'released' }]);
    witness.observe();
    assert.deepEqual(witness.read()!.events, [ready]);
    const released = captureDesktopSourceMetadataLineage({ ...options, observed: [], witness });
    assert.deepEqual(released.partitions[0]!.births, [child]); assert.deepEqual(released.live, []);
    await write([{ ...ready, startIdentityHash: 'e'.repeat(64) }, { ...ready, stage: 'released' }]);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed: [], witness }), /immutable whole-log prefix/);
  });
});

test('early metadata pending observations never supply readiness or erase a retained prefix', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    let pending = true;
    const witness = createDesktopMetadataWitness(() => pending ? undefined : { ...options, observed: [child] });
    await write([]); witness.observe(); assert.equal(witness.read(), undefined);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed: [], witness }),
      /finite original metadata lifecycle observations/);
    await write([ready]); pending = false; witness.observe();
    pending = true;
    let refusal: unknown;
    assert.throws(() => { try { witness.observe(); } catch (error) { refusal = error; throw error; } }, /cannot disappear/);
    pending = false;
    assert.throws(() => witness.observe(), error => error === refusal);
    assert.throws(() => witness.read(), error => error === refusal);
  });
});

test('an unobserved retired metadata birth remains sticky debt even after a later live observation', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    let observed: typeof child[] = [];
    const witness = createDesktopMetadataWitness(() => ({ ...options, observed }));
    await write([ready, { ...ready, stage: 'released' }]);
    let refusal: unknown;
    assert.throws(() => { try { witness.observe(); } catch (error) { refusal = error; throw error; } }, /retired profile/);
    await write([ready]); observed = [child];
    assert.throws(() => witness.observe(), error => error === refusal);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed, witness }), error => error === refusal);
  });
});

test('a same-profile successor missed between early fences remains sticky missing-birth debt', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    const successor = { ...child, pid: 12, groupId: 12, birth: 'linux-starttime:120' };
    const nextReady = { ...ready, pid: successor.pid,
      startIdentityHash: createHash('sha256').update('12:120').digest('hex') };
    const later = { ...child, pid: 13, groupId: 13, birth: 'linux-starttime:130' };
    const laterReady = { ...ready, pid: later.pid,
      startIdentityHash: createHash('sha256').update('13:130').digest('hex') };
    for (const route of ['observe', 'retain'] as const) {
      let observed = [child];
      const witness = createDesktopMetadataWitness(() => ({ ...options, observed }));
      await write([ready]); witness.observe();
      const retained = witness.read()!;
      const missed = [ready, { ...ready, stage: 'released' }, nextReady, { ...nextReady, stage: 'released' }];
      await write(missed); observed = [];
      let refusal: unknown;
      assert.throws(() => {
        try {
          if (route === 'observe') witness.observe();
          else witness.retain(captureDesktopSourceMetadataLineage({ ...options, observed, witness }));
        } catch (error) { refusal = error; throw error; }
      }, /every ready metadata process needs its original retained physical birth/);
      await write([...missed, laterReady]); observed = [later];
      assert.throws(() => witness.observe(), error => error === refusal);
      assert.throws(() => witness.read(), error => error === refusal);
      assert.throws(() => witness.retain(retained), error => error === refusal);
    }
  });
});

test('early metadata witness binds the ready hash to the actual Linux kernel birth', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    for (const changed of [
      { ...child, birth: 'TEST-ps-only-birth' },
      { ...child, birth: 'linux-starttime:111' },
      { ...child, parentPid: 99 },
      { ...child, groupId: 99 },
      { ...child, command: '/TEST/other-bun' },
    ]) {
      await write([ready]);
      const witness = createDesktopMetadataWitness(() => ({ ...options, observed: [changed] }));
      assert.throws(() => witness.observe()); assert.throws(() => witness.read());
    }
    await write([{ ...ready, startIdentityHash: 'f'.repeat(64) }]);
    const wrongReady = createDesktopMetadataWitness(() => ({ ...options, observed: [child] }));
    assert.throws(() => wrongReady.observe(), /exact native birth/);
  });
});

test('early metadata refuses changed source, prefix, PID reuse, unknown cleanup and live retired children', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    for (const [events, observed] of [
      [[{ ...ready, startIdentityHash: 'e'.repeat(64) }], [child]],
      [[{ ...ready, profileHash: 'f'.repeat(64) }], [child]],
      [[ready, { ...ready, stage: 'cleanup-unknown' }], []],
      [[ready, { ...ready, stage: 'released' }], [child]],
      [[ready, { ...ready, stage: 'released' }, { ...ready, startIdentityHash: 'e'.repeat(64) }], [child]],
    ] as const) {
      let current: readonly typeof child[] = [child];
      await write([ready]);
      const witness = createDesktopMetadataWitness(() => ({ ...options, observed: current })); witness.observe();
      await write(events); current = observed;
      assert.throws(() => witness.observe()); assert.throws(() => witness.read());
    }
    let current = [child];
    await write([ready]);
    const witness = createDesktopMetadataWitness(() => ({ ...options, observed: current })); witness.observe();
    current = [{ ...child, birth: 'linux-starttime:999' }];
    assert.throws(() => witness.observe(), /birth is unchanged/);
  });
});

test('a full original census can extend the early witness without losing either physical birth', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    const successor = { ...child, pid: 12, groupId: 12, birth: 'linux-starttime:120' };
    const nextReady = { ...ready, pid: successor.pid, mode: 'directory', providerHash: null,
      startIdentityHash: createHash('sha256').update('12:120').digest('hex') };
    let observed = [child];
    const witness = createDesktopMetadataWitness(() => ({ ...options, observed }));
    await write([ready]); witness.observe();
    const prefix = [ready, { ...ready, stage: 'released' }, nextReady];
    await write(prefix); observed = [successor];
    const original = captureDesktopSourceMetadataLineage({ ...options, observed, witness });
    witness.retain(original);
    original.partitions[0]!.births[0]!.birth = 'TEST-mutated-return-value';
    await write([...prefix, { ...nextReady, stage: 'released' }]); observed = [];
    witness.observe();
    const closed = captureDesktopSourceMetadataLineage({ ...options, observed, witness, released: true });
    assert.deepEqual(closed.partitions[0]!.births, [child, successor]);
    const copied = witness.read()!; copied.host.birth = 'TEST-mutated-copy';
    assert.equal(witness.read()!.host.birth, host.birth);
    assert.throws(() => witness.retain({ ...closed, host: { ...host, birth: 'linux-starttime:999' } }), /original early metadata Host/);
    assert.throws(() => witness.read(), /original early metadata Host/);
  });
});

test('full-census retention cannot bypass early kernel-birth qualification', async () => {
  await withEarlyMetadata(async ({ root, host, child, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], executable: child.command };
    await write([ready]);
    const wrong = captureDesktopSourceMetadataLineage({ ...options, observed: [{ ...child, birth: 'linux-starttime:999' }] });
    const witness = createDesktopMetadataWitness(() => undefined);
    assert.throws(() => witness.retain(wrong), /exact native birth/);
    assert.throws(() => witness.read(), /exact native birth/);
  });
});

test('early metadata read errors stay exact and cannot be retried into a successful witness', () => {
  const refusal = Object.assign(new Error('TEST original proc read failed'), { code: 'ENOENT' });
  let reads = 0;
  const witness = createDesktopMetadataWitness(() => { reads++; if (reads === 1) throw refusal; return undefined; });
  assert.throws(() => witness.observe(), error => error === refusal);
  assert.throws(() => witness.observe(), error => error === refusal);
  assert.throws(() => witness.read(), error => error === refusal);
  assert.equal(reads, 1);
});

test('synchronous early metadata source read preserves the original regular-file limits', async () => {
  await withEarlyMetadata(async ({ root }) => {
    const path = join(root, 'source.json');
    await writeFile(path, '{"schemaVersion":1}');
    assert.deepEqual(readDesktopMetadataSourceFile(path, 64), { schemaVersion: 1 });
    assert.throws(() => readDesktopMetadataSourceFile(path, 1));
    assert.throws(() => readDesktopMetadataSourceFile(root, 64));
    await writeFile(path, '[]'); assert.throws(() => readDesktopMetadataSourceFile(path, 64));
    await writeFile(path, Buffer.from([0xff])); assert.throws(() => readDesktopMetadataSourceFile(path, 64));
    await writeFile(path, '{}');
    const alias = join(root, 'alias.json'); await symlink(path, alias);
    assert.throws(() => readDesktopMetadataSourceFile(alias, 64));
    await link(path, join(root, 'hardlink.json'));
    assert.throws(() => readDesktopMetadataSourceFile(path, 64));
  });
});

test('the real membership UI fence checks census health and original source freshness before owner and model guards', async () => {
  const source = await readFile(new URL('./desktop-live-membership-ui-smoke.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('  const current = () => {'), end = source.indexOf('  const step = ', begin);
  assert.ok(begin > 0 && end > begin);
  const calls: string[] = [], state: { failure?: Error; sourceFailure?: Error } = {};
  const current = runInNewContext('(() => {' + source.slice(begin, end) + 'return current; })()', {
    metadataCensus: { assertHealthy: () => { calls.push('live-witness'); if (state.failure) throw state.failure; } },
    sourceProfilesNow: () => { calls.push('original-source'); if (state.sourceFailure) throw state.sourceFailure; },
    options: { assertOwnedRenderer: () => calls.push('original-owner') },
    modelRows: Array.from({ length: 3 }, () => ({ failures: [] })),
    models: { claude: { observations: [], notificationObservations: [] }, codex: { observations: [], notificationObservations: [] } },
    assert: { deepEqual: (actual: unknown, expected: unknown) => {
      calls.push('original-model'); assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    }, equal: assert.equal },
  }) as () => void;
  current();
  assert.deepEqual(calls, ['live-witness', 'original-source', 'original-owner', 'original-model', 'original-model', 'original-model']);
  state.failure = new Error('TEST original census observation failed');
  const before = calls.length;
  assert.throws(() => current(), error => error === state.failure);
  assert.deepEqual(calls.slice(before), ['live-witness'], 'read uncertainty refuses before the original UI owner guard');
  delete state.failure; state.sourceFailure = new Error('TEST original source prefix changed');
  const beforeSourceRefusal = calls.length;
  assert.throws(() => current(), error => error === state.sourceFailure);
  assert.deepEqual(calls.slice(beforeSourceRefusal), ['live-witness', 'original-source']);
});

async function preReadyMetadataFixture(work: (value: {
  root: string;
  host: { pid: number; parentPid: number; groupId: number; birth: string; command: string };
  birth: { pid: number; parentPid: number; groupId: number; birth: string; command: string };
  ready: { hostPid: number; profileHash: string; mode: 'provider'; providerHash: string;
    pid: number; startIdentityHash: string; stage: 'ready' };
  write(events: readonly unknown[]): Promise<void>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-metadata-pre-ready-')));
  try {
    const directory = join(root, 'userData/logs'); await mkdir(directory, { recursive: true });
    const host = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
    const birth = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
    const ready = { hostPid: 10, profileHash: 'a'.repeat(64), mode: 'provider' as const, providerHash: 'b'.repeat(64),
      pid: 11, startIdentityHash: createHash('sha256').update('11:110').digest('hex'), stage: 'ready' as const };
    const write = (events: readonly unknown[]) => writeFile(join(directory, 'app-errors.ndjson'), events.map(value => JSON.stringify({
      namespace: 'Host:OpenCodeMetadata', message: 'OpenCode metadata stage ' + JSON.stringify(value),
    })).join('\n') + '\n');
    await work({ root, host, birth, ready, write });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('pre-ready physical birth remains required and sufficient after the first source profile retires', async () => {
  await preReadyMetadataFixture(async ({ root, host, birth, ready, write }) => {
    // The observer captures a real-shaped physical observation before any ready event exists.
    let observed = { host, births: [birth] };
    const census = createDesktopMetadataBirthCensus(() => observed);
    try {
    await write([ready, { ...ready, stage: 'released' }]);
    observed = { host, births: [] }; census.sample();
    const originalOptions = { root, host, profileHashes: [ready.profileHash], observed: [], executable: birth.command };
    assert.throws(() => captureDesktopSourceMetadataLineage(originalOptions), /previously retained physical lineage/);
    const witnessedOptions = { ...originalOptions, birthWitness: census.witness() };
    const result = captureDesktopSourceMetadataLineage(witnessedOptions);
    assert.deepEqual(result.partitions[0]!.births, [birth]);
    assert.deepEqual(result.live, []);
    } finally { census.close(); }
  });
});

test('a retired predecessor cannot borrow an active successor physical witness', async () => {
  await preReadyMetadataFixture(async ({ root, host, birth, ready, write }) => {
    const successor = { ...birth, pid: 12, groupId: 12, birth: 'linux-starttime:120' };
    const next = { ...ready, pid: 12, startIdentityHash: createHash('sha256').update('12:120').digest('hex') };
    await write([ready, { ...ready, stage: 'released' }, next]);
    const options = { root, host, profileHashes: [ready.profileHash], observed: [successor], executable: birth.command };
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, birthWitness: { host, births: [successor] } }),
      /retired predecessors.*retained physical birth/);
    const result = captureDesktopSourceMetadataLineage({ ...options, birthWitness: { host, births: [birth, successor] } });
    assert.deepEqual(result.partitions[0]!.births, [birth, successor]);
    assert.deepEqual(result.live, [successor]);
    await write([ready, { ...ready, stage: 'released' }, next, { ...next, stage: 'released' }]);
    const closed = captureDesktopSourceMetadataLineage({ ...options, observed: [], original: result,
      birthWitness: { host, births: [birth, successor] }, released: true });
    assert.deepEqual(closed.partitions[0]!.births, [birth, successor]);
    assert.deepEqual(closed.live, []);
  });
});

test('pre-ready lineage refuses foreign Host, mismatched birth, unknown cleanup, changed prefix and live retirement', async () => {
  await preReadyMetadataFixture(async ({ root, host, birth, ready, write }) => {
    const options = { root, host, profileHashes: [ready.profileHash], observed: [birth], executable: birth.command };
    await write([ready]);
    for (const changed of [
      { ...birth, birth: 'linux-starttime:999' }, { ...birth, birth: 'ps-only-date' },
      { ...birth, parentPid: 99 }, { ...birth, groupId: 99 }, { ...birth, command: '/TEST/foreign-bun' },
    ]) assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, birthWitness: { host, births: [changed] } }));
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options,
      birthWitness: { host: { ...host, birth: 'linux-starttime:999' }, births: [birth] } }), /exact original Host/);
    const original = captureDesktopSourceMetadataLineage({ ...options, birthWitness: { host, births: [birth] } });
    for (const events of [
      [{ ...ready, profileHash: 'f'.repeat(64) }], [{ ...ready, startIdentityHash: 'f'.repeat(64) }],
      [ready, { ...ready, stage: 'cleanup-unknown' }],
      [ready, { ...ready, stage: 'released' }, ready],
    ]) {
      await write(events);
      assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, original, birthWitness: { host, births: [birth] } }));
    }
    await write([ready, { ...ready, stage: 'released' }]);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, original,
      birthWitness: { host, births: [birth] } }), /retired birth is physically absent/);
    assert.throws(() => captureDesktopSourceMetadataLineage({ ...options, observed: [], original,
      birthWitness: { host, births: [] } }), /retained physical birth/);
  });
});

test('read-only census failure is sticky, copies are isolated and closure is idempotent', () => {
  const host = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
  const child = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
  let reads = 0, fail = false;
  const error = new Error('TEST selected Bun observation failed');
  const census = createDesktopMetadataBirthCensus(() => { reads++; if (fail) throw error; return { host, births: [child] }; });
  const first = census.witness(); first.host.birth = 'changed'; first.births[0]!.birth = 'changed';
  assert.deepEqual(census.witness(), { host, births: [child] });
  fail = true;
  assert.throws(() => census.sample(), value => value === error);
  assert.throws(() => census.assertHealthy(), value => value === error);
  assert.throws(() => census.witness(), value => value === error);
  const before = reads;
  assert.deepEqual(census.close(), census.close());
  assert.throws(() => census.sample(), value => value === error);
  assert.equal(reads, before);
});

test('cold census is armed before new Host discovery and cannot borrow the old epoch', () => {
  const host = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
  const birth = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
  let current: { host?: typeof host; births: typeof birth[] } = { host, births: [birth] };
  const old = createDesktopMetadataBirthCensus(() => current);
  old.expectOriginalQuit(); current = { births: [] }; old.sample();
  assert.equal(old.close().originalExitObserved, true);
  const next = createDesktopMetadataBirthCensus(() => current);
  try {
    assert.throws(() => next.witness(), /physically captured original Host/);
    const coldHost = { ...host, pid: 20, groupId: 3, birth: 'linux-starttime:200' };
    const coldBirth = { ...birth, pid: 21, groupId: 21, parentPid: 20, birth: 'linux-starttime:210' };
    current = { host: coldHost, births: [coldBirth] }; next.sample();
    assert.deepEqual(next.witness(), { host: coldHost, births: [coldBirth] });
    current = { host, births: [birth] };
    assert.throws(() => next.sample(), /same actual original metadata Host/);
  } finally { next.close(); }
});

test('unexpected original Host disappearance and physical PID reuse remain refusal', () => {
  const host = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
  const birth = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
  for (const next of [{ births: [] }, { host, births: [{ ...birth, birth: 'linux-starttime:111' }] }]) {
    let current: { host?: typeof host; births: typeof birth[] } = { host, births: [birth] };
    const census = createDesktopMetadataBirthCensus(() => current);
    try { current = next; assert.throws(() => census.sample()); assert.throws(() => census.witness()); }
    finally { assert.equal(census.close().failed, true); }
  }
});

function finiteProcTree() {
  const files = new Map<string, Buffer>(), links = new Map<string, string>();
  const put = (path: string, value: string) => files.set(path, Buffer.from(value));
  const stat = (pid: number, parent: number, group: number, birth: number, state = 'S') => {
    const fields = Array<string>(20).fill('0');
    fields[0] = state; fields[1] = String(parent); fields[2] = String(group); fields[19] = String(birth);
    put(`/proc/${pid}/stat`, `${pid} (TEST finite observation) ${fields.join(' ')}`);
  };
  const child = (pid: number, birth: number, state = 'S') => {
    stat(pid, 10, pid, birth, state); links.set(`/proc/${pid}/exe`, '/TEST/bun');
    put(`/proc/${pid}/cmdline`, '/TEST/bun\0--no-env-file\0--config=/dev/null\0--no-install\0/TEST/embedded.js\0');
  };
  stat(2, 1, 2, 20); put('/proc/2/cmdline', '/TEST/app\0'); put('/proc/2/task/2/children', '10');
  stat(10, 2, 2, 100); links.set('/proc/10/exe', '/TEST/node');
  put('/proc/10/cmdline', '/TEST/node\0/TEST/host.js\0'); put('/proc/10/task/10/children', '11'); child(11, 110);
  const absent = () => Object.assign(new Error('TEST proc entry absent'), { code: 'ENOENT' });
  const io = {
    read(path: string, maximum: number) { const value = files.get(path); if (!value) throw absent();
      assert.ok(value.length <= maximum); return value; },
    realpath(path: string) { const value = links.get(path); if (!value) throw absent(); return value; },
  };
  const options = { group: () => 2, node: '/TEST/node', hostEntry: '/TEST/host.js',
    executable: '/TEST/bun', embeddedEntry: '/TEST/embedded.js' };
  return { files, links, put, stat, child, absent, io, options };
}

test('actual Linux reader captures pre-ready stat/exe/argv/stat and rejects zombie or foreign identities', () => withTuple('linux', 'x64', () => {
  const expected = { pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' };
  const base = finiteProcTree();
  const reader = createDesktopLinuxMetadataBirthReader(base.options, base.io);
  const observed = reader({ quitExpected: false });
  assert.deepEqual(observed.births, [expected]);
  assert.equal(observed.host!.birth, 'linux-starttime:100');
  for (const mutate of [
    (tree: ReturnType<typeof finiteProcTree>) => tree.stat(11, 10, 11, 110, 'Z'),
    (tree: ReturnType<typeof finiteProcTree>) => tree.stat(11, 99, 11, 110),
    (tree: ReturnType<typeof finiteProcTree>) => tree.stat(11, 10, 99, 110),
    (tree: ReturnType<typeof finiteProcTree>) => tree.put('/proc/11/cmdline', '/TEST/bun\0foreign\0'),
  ]) {
    const tree = finiteProcTree(); mutate(tree);
    assert.throws(() => createDesktopLinuxMetadataBirthReader(tree.options, tree.io)({ quitExpected: false }));
  }
  const changed = finiteProcTree(); let reads = 0;
  const io = { ...changed.io, read(path: string, maximum: number) {
    if (path === '/proc/11/stat' && ++reads === 3) changed.stat(11, 10, 11, 999);
    return changed.io.read(path, maximum);
  } };
  assert.throws(() => createDesktopLinuxMetadataBirthReader(changed.options, io)({ quitExpected: false }), /kernel birth remains current/);
}));

test('planned Quit racing an original Host read preserves births without adopting a successor', () => withTuple('linux', 'x64', () => {
  const tree = finiteProcTree(); let quit = false;
  const io = { ...tree.io, realpath(path: string) {
    if (quit && path === '/proc/10/exe') { tree.files.delete('/proc/10/stat'); throw tree.absent(); }
    return tree.io.realpath(path);
  } };
  const census = createDesktopMetadataBirthCensus(createDesktopLinuxMetadataBirthReader(tree.options, io));
  const before = census.witness();
  try {
    census.expectOriginalQuit(); quit = true; census.sample();
    assert.deepEqual(census.witness(), before);
    assert.equal(census.close().originalExitObserved, true);
  } finally { census.close(); }
  const reused = finiteProcTree();
  const other = createDesktopMetadataBirthCensus(createDesktopLinuxMetadataBirthReader(reused.options, reused.io));
  try {
    other.expectOriginalQuit(); reused.stat(10, 2, 2, 999, 'Z');
    assert.throws(() => other.sample()); assert.throws(() => other.witness());
  } finally { other.close(); }
}));

test('unknown pre-executable candidates never become witnesses and selected Bun uncertainty stays sticky during Quit', () => withTuple('linux', 'x64', () => {
  const tree = finiteProcTree(); tree.put('/proc/10/task/10/children', '11 99');
  const observed = createDesktopLinuxMetadataBirthReader(tree.options, tree.io)({ quitExpected: false });
  assert.deepEqual(observed.unobservedPids, [99]);
  assert.deepEqual(observed.births.map(row => row.pid), [11]);
  let selected = false;
  const io = { ...tree.io, realpath(path: string) {
    if (path === '/proc/12/exe' && selected) throw tree.absent();
    if (path === '/proc/12/exe') selected = true;
    return tree.io.realpath(path);
  } };
  const census = createDesktopMetadataBirthCensus(createDesktopLinuxMetadataBirthReader(tree.options, io));
  try {
    census.expectOriginalQuit(); tree.child(12, 120); tree.put('/proc/10/task/10/children', '12');
    assert.throws(() => census.sample(), /TEST proc entry absent/);
    assert.throws(() => census.witness(), /TEST proc entry absent/);
  } finally { assert.equal(census.close().failed, true); }
}));

test('one census timer samples before UI fences and outer disposal stops all future reads', async () => {
  let reads = 0;
  const host = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
  let births: { pid: number; parentPid: number; groupId: number; birth: string; command: string }[] = [];
  const census = createDesktopMetadataBirthCensus(() => { reads++; return { host, births }; });
  try {
    births = [{ pid: 11, parentPid: 10, groupId: 11, birth: 'linux-starttime:110', command: '/TEST/bun' }];
    const deadline = Date.now() + 1000;
    while (reads < 2 && Date.now() < deadline) await delay(10);
    assert.ok(reads >= 2); births = [];
    while (reads < 3 && Date.now() < deadline) await delay(10);
    assert.ok(reads >= 3);
    assert.equal(census.witness().births.length, 1, 'physical birth retained between two original UI fences');
    const before = reads; const closure = census.close();
    await delay(75);
    assert.equal(reads, before); assert.equal(closure.closed, true);
    assert.deepEqual(census.close(), closure);
  } finally { census.close(); }
});

test('planned Quit at the final same-Host read retains births across an observed zombie transition', () => withTuple('linux', 'x64', () => {
  const tree = finiteProcTree(); let quit = false;
  const io = { ...tree.io, read(path: string, maximum: number) {
    const value = tree.io.read(path, maximum);
    if (quit && path === '/proc/10/task/10/children') tree.stat(10, 2, 2, 100, 'Z');
    return value;
  } };
  const census = createDesktopMetadataBirthCensus(createDesktopLinuxMetadataBirthReader(tree.options, io));
  const before = census.witness();
  try {
    census.expectOriginalQuit(); tree.put('/proc/10/task/10/children', ''); quit = true; census.sample();
    assert.deepEqual(census.witness(), before);
    assert.equal(census.close().originalExitObserved, true);
  } finally { census.close(); }
}));

test('finite reader tuple restores foreign process descriptors and preserves the production non-Linux refusal', () => {
  const descriptors = () => ({ platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch') });
  const original = descriptors();
  withTuple('darwin', 'arm64', () => {
    const foreign = descriptors(), tree = finiteProcTree(); let reads = 0;
    const io = { ...tree.io, read(path: string, maximum: number) { reads++; return tree.io.read(path, maximum); } };
    assert.throws(() => createDesktopLinuxMetadataBirthReader(tree.options, io)({ quitExpected: false }));
    assert.equal(reads, 0, 'the original platform guard precedes any process observation');
    withTuple('linux', 'x64', () => {
      const observed = createDesktopLinuxMetadataBirthReader(tree.options, io)({ quitExpected: false });
      assert.equal(observed.births[0]!.birth, 'linux-starttime:110');
    });
    assert.deepEqual(descriptors(), foreign, 'the synchronous fake-I/O case restores the actual outer platform');
  });
  assert.deepEqual(descriptors(), original);
});
