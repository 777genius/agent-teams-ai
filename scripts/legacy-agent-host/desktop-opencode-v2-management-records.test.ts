import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
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
import type { StoredRuntimeSourceCommand } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import type { PublishRuntimeSource } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';

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

/** Pure archived-record assertions only: no filesystem or native operation under this tuple. */
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
    onRead?: (state: State) => void; onPause?: (state: State) => void } = {}) => {
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
        commands: async () => { state.commands++; return state.commands === 1 ? [] : [receipt]; },
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
  const ordinary = setup('project-test'); await ordinary.run();
  assert.equal(ordinary.state.clicks, 1); assert.equal(ordinary.state.reads, 0); assert.equal(ordinary.state.pauses, 0);
  assert.equal(ordinary.state.finishes, 1); assert.equal(ordinary.effects.length, 1);
});
