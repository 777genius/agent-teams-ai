import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { readNativeHostCostProof } from '../../packages/legacy-agent-host/tests/fixtures/native-host-cost.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { sendDesktopNativeCommandFromComposer } from './desktop-native-commands-ui-proof.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { json, record, rows } from './desktop-resume-records.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
type Model = { observations: readonly unknown[]; probes: readonly unknown[]; failures: readonly string[] };
type Options = {
  root: string;
  handleId: string;
  session: Row;
  model: Model;
  evidence: Row;
  assertOwnedRenderer(): void;
};
async function query(cdp: UiCdpPort, options: Options, operation: 'team.activity.stats.read' | 'command.lookup',
  commandId: string, payload: Row) {
  options.assertOwnedRenderer();
  const result = record(await cdp.evaluate('window.electronAPI.agentBackend.invoke(' +
    JSON.stringify({ handle: { handleId: options.handleId }, operation, commandId, payload }) + ')'));
  assert.equal(result.ok, true, 'read-only ' + operation);
  assert.equal(JSON.stringify(result).includes(options.root), false);
  return result;
}
function controls(cdp: UiCdpPort, options: Options, proof: Row) {
  const step = (value: Row) => { assert.ok(Array.isArray(proof.steps)); proof.steps.push(value); };
  return { ui: createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step }), step };
}
async function showReply(cdp: UiCdpPort, options: Options, proof: Row, text: string, suffix: string) {
  const { ui, step } = controls(cdp, options, proof);
  await ui.waitRead('document.body.innerText.replace(/\\s+/g," ").includes(' +
    desktopJsLiteral(text.replace(/\s+/g, ' ')) + ')', 'original Codex /cost report appears in the conversation');
  await revealDesktopReply(cdp, text, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const shot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  assert.equal(typeof shot.data, 'string');
  const path = join(options.root, 'ui-codex-host-cost-' + suffix + '.png');
  await writeFile(path, Buffer.from(String(shot.data), 'base64'), { mode: 0o600 });
  return { path, sha256: await fileDigest(path) };
}

/** Actual Composer selection/Send once. The existing Host owns the local report and original receipt. */
export async function runDesktopCodexCostUiProof(
  cdp: UiCdpPort, options: Options, afterResume = false
): Promise<void> {
  const { root, model } = options;
  const retained = afterResume ? record(options.evidence.codexCostProof) : undefined;
  if (retained) { assert.equal(retained.phase, 'cold-original-retained'); retained.status = 'INCOMPLETE'; }
  const requestCount = afterResume ? 11 : 8;
  assert.equal(model.observations.length, requestCount);
  assert.deepEqual(model.failures, []);
  const binding = record(options.session.binding), bindingKey = runtimeDigest(binding);
  assert.equal(binding.memberId, 'alice-id');
  const beforeInputs = structuredClone(options.session.inputs);
  assert.ok(Array.isArray(beforeInputs) && beforeInputs.length === 1);
  assert.equal(record(beforeInputs[0]).phase, 'terminal');
  const proof: Row = { status: 'INCOMPLETE', phase: 'before-send', steps: [], originalBinding: binding,
    originalInputs: beforeInputs, rendererTimeOrigin: await cdp.evaluate('performance.timeOrigin') };
  if (retained) retained.afterResume = proof;
  else options.evidence.codexCostProof = proof;
  const { ui } = controls(cdp, options, proof);
  await ui.observeInput();
  const statsRead = await query(cdp, options, 'team.activity.stats.read',
    afterResume ? 'TEST-codex-cost-stats-resumed' : 'TEST-codex-cost-stats', { memberName: 'alice' });
  const stats = record(record(statsRead.value).stats);
  assert.equal(stats.generations, afterResume ? 2 : 1);
  if (retained) {
    const activity = await json(join(root, 'hoststore/runtime-events', bindingKey + '.json'));
    const { digest, ...body } = activity;
    assert.equal(runtimeDigest(body), digest); assert.deepEqual(activity.binding, binding);
    assert.ok(Array.isArray(activity.events) && activity.events.length <= 256);
    const input = record(beforeInputs[0]);
    const usage = activity.events.map(record).filter(event => record(event.data).kind === 'usage' &&
      event.inputId === record(input.intent).inputId && event.operationRef === input.operationRef).at(-1);
    assert.ok(usage, 'resumed input has its own actual native usage snapshot');
    const units = record(usage.data), previous = record(retained.stats);
    for (const field of ['inputTokens', 'outputTokens']) {
      assert.ok(typeof units[field] === 'number' && Number.isSafeInteger(units[field]) && Number(units[field]) > 0);
      assert.equal(stats[field], Number(previous[field]) + Number(units[field]),
        'Stats includes original and resumed input once: ' + field);
    }
    proof.currentInputUsage = units;
  }
  const commandDirectory = join(root, 'hoststore/teams/test-desktop-backend/.host-owner/commands');
  const beforeCommands = new Set((await rows(commandDirectory)).map(row => row.commandId));
  const probesBefore = model.probes.length;
  const raw = await sendDesktopNativeCommandFromComposer(cdp, ui, 'cost', '', catalog => {
    assert.deepEqual(catalog, ['/cost'], 'captured Codex capability does not borrow Claude commands');
    proof.catalog = catalog;
  });
  assert.equal(raw, '/cost');
  proof.phase = 'sent-once';
  const until = Date.now() + 60_000;
  let receipt: Row | undefined;
  for (;;) {
    options.assertOwnedRenderer();
    assert.deepEqual(model.failures, []);
    const matches = (await rows(commandDirectory)).filter(row => !beforeCommands.has(row.commandId) &&
      row.principalId === 'TEST-human' && record(row.command).operation === 'message.send' &&
      record(record(row.command).payload).text === raw);
    assert.ok(matches.length <= 1, 'one original UI intent');
    if (matches[0]?.phase === 'completed') { receipt = matches[0]; break; }
    assert.ok(Date.now() < until, 'original /cost receipt is incomplete; never repeat Send');
    await new Promise<void>(done => setTimeout(done, 100));
  }
  assert.ok(receipt);
  const commandId = String(receipt.commandId);
  assert.match(commandId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const original = await readNativeHostCostProof({
    teamRoot: join(root, 'hoststore/teams/test-desktop-backend'), commandId,
    memberName: 'alice', principalId: 'TEST-human', binding, stats,
  });
  const sessions = (await readDesktopNativeStopSessions(root)).filter(row => runtimeDigest(row.binding) === bindingKey);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.inputs, beforeInputs, 'local /cost does not allocate a Runtime input');
  assert.equal(model.observations.length, requestCount);
  assert.equal(model.probes.length, probesBefore);
  const lookup = await query(cdp, options, 'command.lookup', commandId, {});
  assert.equal(record(lookup.value).commandId, commandId);
  assert.equal(record(lookup.value).phase, 'completed');
  assert.equal(record(lookup.value).hostCommand, undefined);
  assert.equal(record(lookup.value).deliveryId, undefined);
  proof.original = original;
  proof.stats = stats;
  proof.publicLookup = lookup;
  proof.modelRequestsBefore = requestCount;
  proof.modelRequestsAfter = model.observations.length;
  proof.probeRequestsBefore = probesBefore;
  proof.probeRequestsAfter = model.probes.length;
  proof.screenshot = await showReply(cdp, options, proof, String(original.reply.text), afterResume ? 'resumed-report' : 'original');
  proof.phase = 'original-completed';
  if (retained) {
    const first = record(retained.original);
    assert.deepEqual(await readNativeHostCostProof({
      teamRoot: join(root, 'hoststore/teams/test-desktop-backend'), commandId: String(first.commandId),
      memberName: 'alice', principalId: 'TEST-human', binding: record(retained.originalBinding), stats: record(retained.stats),
    }), first, 'new /cost does not rewrite the first captured report');
    proof.status = 'PASS'; retained.phase = 'resumed-report-completed'; retained.status = 'PASS';
  }
}

/** Existing cold app/Host Resume supplies the boundary; this only looks up the retained report. */
export async function verifyDesktopCodexCostAfterColdResume(cdp: UiCdpPort, options: Options): Promise<void> {
  const { root, model } = options;
  const proof = record(options.evidence.codexCostProof), original = record(proof.original);
  assert.equal(proof.phase, 'original-completed');
  assert.equal(record(options.evidence.coldResumeBoundary).status, 'PASS');
  assert.equal(record(record(options.evidence.coldResumeBoundary).secondEpoch).status, 'PASS');
  assert.notEqual(await cdp.evaluate('performance.timeOrigin'), proof.rendererTimeOrigin);
  assert.equal(model.observations.length, 8);
  const probeCount = model.probes.length;
  const originalBinding = record(proof.originalBinding);
  assert.notEqual(runtimeDigest(options.session.binding), runtimeDigest(originalBinding));
  assert.deepEqual({ ...record(options.session.binding), generation: originalBinding.generation }, originalBinding);
  assert.deepEqual(options.session.inputs, [], 'Resume has not dispatched a fresh prompt');
  const stats = record(record((await query(cdp, options, 'team.activity.stats.read',
    'TEST-codex-cost-stats-cold', { memberName: 'alice' })).value).stats);
  assert.equal(stats.generations, 2);
  for (const field of ['inputTokens', 'outputTokens'])
    assert.equal(stats[field], record(proof.stats)[field], 'cold Resume retains original usage: ' + field);
  proof.coldStats = stats;
  const retained = await readNativeHostCostProof({
    teamRoot: join(root, 'hoststore/teams/test-desktop-backend'), commandId: String(original.commandId),
    memberName: 'alice', principalId: 'TEST-human', binding: originalBinding, stats: record(proof.stats),
  });
  assert.deepEqual(retained, original, 'snapshot, elapsed value, canonical reply and original identity survive cold Resume');
  assert.deepEqual(await query(cdp, options, 'command.lookup', retained.commandId, {}), proof.publicLookup);
  const old = (await readDesktopNativeStopSessions(root)).filter(row =>
    runtimeDigest(row.binding) === runtimeDigest(originalBinding));
  assert.equal(old.length, 1);
  assert.equal(old[0]!.phase, 'closed');
  assert.equal(old[0]!.custody, 'released');
  assert.deepEqual(old[0]!.inputs, proof.originalInputs);
  proof.coldScreenshot = await showReply(cdp, options, proof, String(retained.reply.text), 'cold-resume');
  assert.equal(model.observations.length, 8);
  assert.equal(model.probes.length, probeCount);
  assert.deepEqual(model.failures, []);
  proof.retainedOriginalAfterColdResume = true;
  proof.noRuntimeInputOrModelReplay = true;
  proof.phase = 'cold-original-retained';
  proof.status = 'PASS';
}
