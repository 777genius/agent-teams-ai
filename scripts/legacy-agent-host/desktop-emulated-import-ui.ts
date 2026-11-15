import assert from 'node:assert/strict';
import { readDesktopEmulatedRuntimeEffects } from './desktop-emulated-runtime-fixture.ts';
import { runDesktopStoppedImportUiSmoke } from './desktop-stopped-import-ui-smoke.ts';
import type { DesktopEmulatedClaudeSettingsFixture } from './desktop-emulated-claude-settings-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;

/** The observation belongs to the actual child input; it never manufactures an operation receipt. */
export function assertDesktopEmulatedImportModelChecks(
  receipts: Row[], effects: Row[], selected: { model: unknown; effort?: unknown },
) {
  assert.equal(selected.model, 'claude-sonnet-4-6');
  assert.equal(selected.effort, 'low');
  assert.ok(receipts.length >= 1 && receipts.length <= 8);
  assert.equal(new Set(receipts.map(row => row.commandId)).size, receipts.length);
  for (const receipt of receipts) {
    assert.equal(typeof receipt.profileId, 'string');
    assert.match(String(receipt.profileId), /^team-probe-[a-f0-9]{64}$/u);
    assert.equal(receipt.configRevision, receipt.profileId);
    assert.equal(receipt.providerId, 'anthropic'); assert.equal(receipt.modelContext, 'model-default');
    assert.equal(receipt.kind, 'model.probe'); assert.equal(receipt.modelId, selected.model);
    assert.equal(receipt.effort, selected.effort); assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.ok, true); assert.equal(receipt.resourceHeld, false);
  }
  assert.ok(effects.every(row => (row.role === 'management' || row.role === 'runtime') && row.provider === 'claude'));
  assert.equal(effects.some(row => row.event === 'failure'), false);
  const probes = effects.filter(row => row.event === 'input');
  assert.equal(probes.length, receipts.length, 'one real no-tools input per original model probe command');
  assert.equal(new Set(probes.map(row => row.inputId)).size, probes.length);
  const births = effects.filter(row => row.event === 'launch');
  assert.equal(new Set(births.map(row => row.pid)).size, births.length);
  assert.ok(effects.every(row => births.some(birth => birth.pid === row.pid)),
    'every original child event belongs to one recorded birth');
  assert.equal(births.filter(row => row.role === 'runtime').length, probes.length);
  assert.equal(effects.filter(row => row.event === 'terminal').length, probes.length);
  for (const birth of births) {
    const own = effects.filter(row => row.pid === birth.pid);
    assert.ok(own.every(row => row.role === birth.role));
    if (birth.role === 'runtime') {
      assert.equal(birth.requestedModel, selected.model); assert.equal(birth.requestedEffort, selected.effort);
      assert.equal(own.filter(row => row.event === 'input').length, 1);
      assert.equal(own.some(row => row.event === 'auth-status'), false);
    } else {
      assert.equal(own.some(row => row.event === 'input' || row.event === 'terminal'), false);
      if (birth.command !== undefined) {
        assert.deepEqual(birth.command, ['auth', 'status', '--json']);
        assert.equal(birth.requestedModel, undefined); assert.equal(birth.requestedEffort, undefined);
        assert.deepEqual(own.map(row => row.event), ['launch', 'auth-status']);
        assert.deepEqual(own[1]!.command, birth.command);
      } else {
        assert.equal(birth.requestedModel, null); assert.equal(birth.requestedEffort, null);
        assert.equal(own.some(row => row.event === 'auth-status'), false);
      }
    }
  }
  for (const probe of probes) {
    assert.equal(probe.role, 'runtime', 'Team preflight retains the original runtime-derived selection');
    assert.equal(probe.marker, 'TEST_MODEL_PROBE');
    assert.equal(probe.requestedModel, selected.model); assert.equal(probe.requestedEffort, selected.effort);
    assert.equal(probe.text, 'Reply only OK. Do not use tools, access files or run commands.');
    const launches = effects.filter(row => row.event === 'launch' && row.pid === probe.pid);
    assert.equal(launches.length, 1); assert.equal(launches[0]!.role, probe.role); assert.equal(launches[0]!.sessionId, probe.sessionId);
    assert.equal(launches[0]!.requestedModel, selected.model); assert.equal(launches[0]!.requestedEffort, selected.effort);
    const terminals = effects.filter(row => row.event === 'terminal' && row.pid === probe.pid && row.inputId === probe.inputId);
    assert.equal(terminals.length, 1); assert.equal(terminals[0]!.outcome, 'succeeded');
    assert.equal(terminals[0]!.sessionId, probe.sessionId); assert.equal(terminals[0]!.text, 'OK');
  }
  return probes;
}

/** Original saved-import controls and readback, using finite metadata and Runtime-derived model probes. */
export async function runDesktopEmulatedImportUi(cdp: UiCdpPort, options: {
  fixture: DesktopEmulatedClaudeSettingsFixture;
  evidence: Row;
  electron: string;
  assertOwnedRenderer(): void;
  observeOwnedHost(): void;
}) {
  await runDesktopStoppedImportUiSmoke(cdp, { ...options, finiteProof: {
    kind: 'legacy-format-test-archive',
    observeModelChecks: async (receipts, selected) => assertDesktopEmulatedImportModelChecks(
      receipts, await readDesktopEmulatedRuntimeEffects(options.fixture), selected,
    ),
  } });
}
