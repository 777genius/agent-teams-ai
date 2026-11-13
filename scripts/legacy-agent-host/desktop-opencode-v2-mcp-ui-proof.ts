/** Actual Launch/member MCP controls, finite native V2 tools, original permission and Stop. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { record } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { mcpTurnText } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-v2-mcp/model.ts';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { observeDesktopOpenCodeMetadata, readDesktopNativeStopSessions,
  captureDesktopOpenCodeGlobalMetadata, captureDesktopOpenCodeProjectMetadata } from './desktop-native-stop-fixture.ts';
import { DESKTOP_MCP_MEMBERS, desktopCapturedMcpPaths, readDesktopCapturedMcpDescription,
  readDesktopCapturedMcpEvents } from './desktop-opencode-v2-mcp-fixture.ts';
import type { startDesktopCapturedMcpModel } from './desktop-opencode-v2-mcp-fixture.ts';
import type { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const json = async (path: string): Promise<Row> => {
  const bytes = await readFile(path, 'utf8');
  assert.ok(Buffer.byteLength(bytes) <= 2_000_000);
  return record(JSON.parse(bytes));
};
async function rows(path: string, limit = 256): Promise<Row[]> {
  const names = (await readdir(path)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.ok(names.length <= limit);
  return Promise.all(names.map(name => json(join(path, name))));
}
const sheet = 'div.fixed.bottom-4';
const expectedPolicies = [
  { mode: 'strictAllowlist', scopes: { user: true, project: false, local: false }, serverNames: ['TEST.selected'] },
  { mode: 'appOnly' },
];

export async function runDesktopCapturedMcpUiProof(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
  model: Awaited<ReturnType<typeof startDesktopCapturedMcpModel>>;
  group: number;
  evidence: Row;
  assertOwnedRenderer(): void;
}) {
  const { fixture, model, group } = options;
  assert.ok(fixture.uiSeed && fixture.openCodeV2);
  const description = readDesktopCapturedMcpDescription(fixture.root);
  assert.equal(description.nonce, model.nonce);
  const paths = desktopCapturedMcpPaths(fixture.root);
  const team = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const owner = () => json(join(team, '.host-owner/state.json'));
  const steps: Row[] = [], originals: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', provider: 'opencode', variant: 'captured-mcp-member-policies',
    steps, commands: originals, scope: 'Original member allowlist/scopes/app-only controls, one Launch, two Composer inputs, actual native MCP/Allow once, all-member Stop and settings readback' };
  options.evidence.launchDialogProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer,
    step: value => { steps.push(value); } });
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 90_000) => {
    const end = Date.now() + ms;
    let value = await read();
    while (!accept(value) && Date.now() < end) {
      options.assertOwnedRenderer(); assert.deepEqual(model.failures, []);
      await new Promise<void>(done => setTimeout(done, 100)); value = await read();
    }
    assert.ok(accept(value), label); return value;
  };
  const globalMetadata = await captureDesktopOpenCodeGlobalMetadata(cdp, fixture, group, options.assertOwnedRenderer);
  proof.originalGlobalMetadata = globalMetadata;
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  const openSettings = async () => {
    await ui.scrollTo('button', 'visible original Launch control', 'Launch');
    await ui.click('button', 'open original Launch settings', 'Launch');
    const optional = record(await ui.waitRead("(() => { const rows=[...document.querySelectorAll('[role=\"dialog\"] button[aria-controls]')].filter(e=>e.textContent.includes('Optional launch settings')); return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null; })()",
      'original Optional launch settings'));
    if (optional.expanded !== 'true') {
      const selector = '[role="dialog"] button[aria-controls=' + desktopJsLiteral(optional.id) + ']';
      await ui.scrollTo(selector, 'visible original optional settings');
      await ui.click(selector, 'expand original optional settings');
    }
    await ui.waitRead("document.querySelector('[role=\"dialog\"] #dialog-prompt')?.value===''",
      'saved empty prompt: the lead receives no business input');
  };
  const memberRow = (name: string) => '[role="dialog"] [data-role="member-row"]:has(input[value=' + desktopJsLiteral(name) + '])';
  const openPolicy = async (name: string) => {
    const row = memberRow(name);
    const button = row + ' button[aria-label$="Control this member\'s MCP inheritance policy"]';
    await ui.scrollTo(button, 'visible original MCP control for ' + name);
    if (await cdp.evaluate('document.querySelector(' + desktopJsLiteral(button) + ')?.getAttribute("aria-expanded")') !== 'true')
      await ui.click(button, 'expand original MCP control for ' + name);
    await ui.waitRead('Boolean(document.querySelector(' + desktopJsLiteral(row + ' [id$="-mcp-mode"]') + '))',
      'captured member MCP panel');
    return row;
  };
  const scopeState = (row: string, scope: string) => '(() => { const labels=[...document.querySelectorAll(' +
    desktopJsLiteral(row + ' label') + ')].filter(e=>e.querySelector("span")?.textContent.trim()===' +
    desktopJsLiteral(scope) + '); if(labels.length!==1)return null; const c=labels[0].querySelector("[role=checkbox]"); return c?{state:c.getAttribute("data-state"),disabled:c.disabled}:null; })()';
  const scopePoint = (row: string, scope: string) => '(() => { const labels=[...document.querySelectorAll(' +
    desktopJsLiteral(row + ' label') + ')].filter(e=>e.querySelector("span")?.textContent.trim()===' +
    desktopJsLiteral(scope) + '); if(labels.length!==1)return null; const e=labels[0].querySelector("[role=checkbox]"); if(!e||e.disabled)return null; const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y); return r.width&&r.height&&hit&&(e===hit||e.contains(hit))?{x,y}:null; })()';
  const assertPolicy = async (name: string, allow: boolean) => {
    const row = await openPolicy(name);
    assert.equal(await cdp.evaluate('document.querySelector(' + desktopJsLiteral(row + ' [id$="-mcp-mode"]') + ')?.textContent.trim()'),
      allow ? 'Strict allowlist' : 'Agent Teams MCP');
    for (const scope of ['user', 'project', 'local']) {
      const value = record(await ui.waitRead(scopeState(row, scope), 'original ' + name + ' ' + scope + ' state'));
      assert.equal(value.state, allow && scope === 'user' ? 'checked' : 'unchecked');
      assert.equal(value.disabled, !allow);
    }
    if (allow) assert.equal(await cdp.evaluate('document.querySelector(' +
      desktopJsLiteral(row + ' [id$="-mcp-servers"]') + ')?.value'), 'TEST.selected');
  };
  await openSettings();
  for (const [index, selected] of DESKTOP_MCP_MEMBERS.entries()) {
    const row = await openPolicy(selected.name), mode = row + ' [id$="-mcp-mode"]';
    await ui.click(mode, 'open original policy mode for ' + selected.name);
    await ui.click('[role="option"]', 'choose original policy for ' + selected.name,
      index === 0 ? 'Strict allowlist' : 'Agent Teams MCP');
    if (index === 0) {
      for (const scope of ['user', 'project', 'local']) {
        const before = record(await ui.waitRead(scopeState(row, scope), 'original scope before click'));
        const expected = scope === 'user' ? 'checked' : 'unchecked';
        if (before.state !== expected)
          await ui.clickExpression(scopePoint(row, scope), 'select original ' + scope + ' MCP scope');
      }
      const servers = row + ' [id$="-mcp-servers"]';
      assert.equal(await cdp.evaluate('document.querySelector(' + desktopJsLiteral(servers) + ')?.value'), '');
      await ui.scrollTo(servers, 'visible original allowlist'); await ui.click(servers, 'focus original allowlist');
      await cdp.send('Input.insertText', { text: 'TEST.selected' });
    }
    await assertPolicy(selected.name, index === 0);
  }
  await ui.scrollTo('[role="dialog"] #dialog-skip-permissions', 'visible original permissions');
  if (await cdp.evaluate("document.querySelector('[role=\"dialog\"] #dialog-skip-permissions')?.getAttribute('data-state')") === 'checked')
    await ui.click('[role="dialog"] #dialog-skip-permissions', 'choose original manual permission mode');
  assert.equal(await cdp.evaluate("document.querySelector('[role=\"dialog\"] #dialog-skip-permissions')?.getAttribute('data-state')"), 'unchecked');
  await ui.waitRead("[...document.querySelectorAll('[role=\"dialog\"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)",
    'original model preflight permits one Launch', 120_000);
  assert.ok(model.probes.length > 0 && model.probes.length <= 8);
  assert.equal(model.requests.length, 0);
  const metadata = await captureDesktopOpenCodeProjectMetadata(fixture, group, globalMetadata);
  proof.originalMetadataBeforeLaunch = metadata.captured; proof.metadataSources = metadata.metadataSources;
  await ui.scrollTo('[role="dialog"] button', 'visible original Launch team control', 'Launch team');
  await ui.click('[role="dialog"] button', 'one original three-member Launch', 'Launch team');
  await ui.waitRead("!document.querySelector('[role=\"dialog\"] #dialog-prompt')", 'original Launch dialog closes', 180_000);
  const state = await poll(owner, value => Array.isArray(value.runtimeCaptures) && value.runtimeCaptures.length === 1,
    'one original Team runtime capture');
  const capture = record((state.runtimeCaptures as unknown[])[0]);
  const capturedMembers = (capture.members as unknown[]).map(record);
  assert.deepEqual(capturedMembers.map(row => row.memberId).sort(),
    ['alice-id', ...DESKTOP_MCP_MEMBERS.map(row => row.memberId)].sort());
  assert.equal(record(state.savedSettings).prompt ?? '', ''); assert.equal(record(state.savedSettings).skipPermissions, false);
  const savedMembers = (state.members as unknown[]).map(record);
  for (const [index, selected] of DESKTOP_MCP_MEMBERS.entries())
    assert.deepEqual(record(savedMembers.find(row => row.memberId === selected.memberId)!.settings).mcpPolicy, expectedPolicies[index]);
  const artifacts = await Promise.all(capturedMembers.map(async member => {
    const artifactPath = join(team, '.host-owner/launches/mcp-recipes',
      runtimeDigest([capture.commandId, member.memberId]) + '.json');
    const artifact = await json(artifactPath), overlay = record(artifact.overlay);
    assert.equal(artifact.commandId, capture.commandId); assert.equal(artifact.memberId, member.memberId);
    assert.equal(artifact.provider, 'opencode'); assert.equal(artifact.cwd, join(fixture.root, 'workspace'));
    assert.deepEqual(Object.keys(record(overlay.capturedMcpServers)), member.memberId === DESKTOP_MCP_MEMBERS[0].memberId ? ['TEST.selected'] : []);
    assert.equal(overlay.mcpPolicyPlugin, undefined);
    assert.deepEqual(overlay.capturedMcpSource, member.memberId === DESKTOP_MCP_MEMBERS[0].memberId
      ? { userConfigPath: paths.catalog, projectPath: join(fixture.root, 'workspace'), policy: expectedPolicies[0] } : undefined);
    return { memberId: member.memberId, path: artifactPath, sha256: await fileDigest(artifactPath) };
  }));
  proof.capture = capture; proof.savedSettings = state.savedSettings; proof.savedPolicies = expectedPolicies; proof.artifacts = artifacts;
  const sessions = async () => (await readDesktopNativeStopSessions(fixture.root))
    .filter(row => record(row.binding).runId === capture.launchId);
  const readLaunch = async () => {
    options.assertOwnedRenderer();
    const response = record(await cdp.evaluate('window.electronAPI.agentBackend.invoke(' + desktopJsLiteral({
      handle: { handleId: fixture.handleId }, commandId: 'TEST-captured-mcp-ready-read',
      operation: 'team.launch.read', payload: {},
    }) + ')'));
    assert.equal(response.ok, true); return record(response.value);
  };
  const ready = await poll(readLaunch, value => value.status === 'ready' && value.ready === 3, 'all original native members ready', 180_000);
  assert.equal(ready.launchId, capture.launchId);
  let currentSessions = await sessions(); assert.equal(currentSessions.length, 3);
  assert.ok(currentSessions.every(row => Array.isArray(row.inputs) && row.inputs.length === 0));
  assert.equal(model.requests.length, 0, 'empty Launch prompt performs no ordinary inference, including lead');
  const { captured: physical, runtime: nativeChildren } = await observeDesktopOpenCodeMetadata(fixture, group, metadata.captured, 3);
  proof.metadataAtRuntimeObservation = physical;
  assert.equal(nativeChildren.length, 3); assert.ok(nativeChildren.every(row => row.command === process.env.OPENCODE_V2_EMBEDDED_BUN));
  const started = readDesktopCapturedMcpEvents(fixture.root).filter(row => row.event === 'started');
  assert.equal(started.length, 1); const originalActor = started[0]!;
  assert.equal(originalActor.server, 'selected'); assert.match(String(originalActor.instanceId), /^[a-f0-9-]{36}$/);
  const table = processFacts(), actor = table.find(row => row.pid === originalActor.pid);
  assert.ok(actor); assert.equal(actor.command, fixture.node);
  let parent = table.find(row => row.pid === actor.parentPid);
  for (let depth = 0; parent && !nativeChildren.some(row => row.pid === parent!.pid) && depth < 8; depth++)
    parent = table.find(row => row.pid === parent!.parentPid);
  assert.ok(parent && nativeChildren.some(row => runtimeDigest(row) === runtimeDigest(parent)),
    'external actor descends from an original captured native Runtime');
  proof.originalActor = { ...originalActor, physical: actor, runtimeParent: parent };
  const absent = async (path: string) => assert.rejects(readFile(path), { code: 'ENOENT' });
  await absent(paths.effect); await absent(paths.excludedLog); await absent(paths.excludedEffect);
  for (const [index, selected] of DESKTOP_MCP_MEMBERS.entries()) {
    const text = mcpTurnText(selected.turn), reply = 'REPLY_NATIVE_MCP_' + selected.turn;
    await ui.click('button[aria-label^=' + desktopJsLiteral(selected.name + ',') + ']', 'open original ' + selected.name + ' chat');
    await ui.waitRead("Boolean(document.querySelector('.message-composer-flat-layout textarea'))", 'ordinary member Composer');
    await ui.click('.message-composer-flat-layout textarea', 'focus original member Composer');
    await cdp.send('Input.insertText', { text });
    await ui.waitRead('document.querySelector(".message-composer-flat-layout textarea")?.value===' + desktopJsLiteral(text), 'exact original user input');
    await ui.click('button.message-composer-send-button', 'Send original member input once', 'Send');
    const commandRows = await poll(() => rows(join(team, '.host-owner/commands')),
      values => values.some(row => row.principalId === 'TEST-human' && row.phase === 'completed' &&
        record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text),
      'original human command is committed');
    const human = commandRows.filter(row => row.principalId === 'TEST-human' && record(row.command).operation === 'message.send' &&
      record(record(row.command).payload).text === text);
    assert.equal(human.length, 1); const original = human[0]!;
    assert.equal(original.phase, 'completed'); assert.equal(record(record(original.command).payload).to, selected.name);
    const inputId = String(record(original.effects).deliveryId);
    const member = capturedMembers.find(row => row.memberId === selected.memberId)!;
    const outbox = await poll(() => json(join(team, '.host-owner/outbox', inputId + '.json')),
      value => value.phase === 'admitted', 'original input admitted to its captured Runtime');
    assert.equal(outbox.inputId, inputId); assert.equal(outbox.commandId, original.commandId);
    assert.equal(outbox.messageId, record(original.effects).messageId);
    assert.deepEqual(outbox.binding, member.delivery);
    if (index === 0) {
      currentSessions = await poll(sessions, values => values.some(row => record(row.binding).memberId === selected.memberId &&
        (row.interactions as unknown[]).map(record).some(item => item.phase === 'pending')), 'original external permission');
      const session = currentSessions.find(row => record(row.binding).memberId === selected.memberId)!;
      const pending = (session.interactions as unknown[]).map(record).filter(row => row.phase === 'pending');
      assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'permission'); assert.equal(pending[0]!.inputId, inputId);
      assert.deepEqual(model.requests, [{ turn: 'ALLOW', step: 0, tool: 'TEST_selected_write_marker' }]);
      await absent(paths.effect); assert.equal(readDesktopCapturedMcpEvents(fixture.root).filter(row => row.event === 'called').length, 0);
      const beforeAllow = processFacts();
      assert.deepEqual(beforeAllow.find(row => row.pid === actor.pid), actor, 'original external actor birth before Allow');
      assert.deepEqual(beforeAllow.find(row => row.pid === parent!.pid), parent, 'original native Runtime ancestor before Allow');
      await ui.waitRead('Boolean(document.querySelector(' + desktopJsLiteral(sheet) + '))', 'original permission Sheet');
      await ui.click(sheet + ' button', 'Allow this exact original MCP request once', 'Allow');
      proof.manualPermission = { inputId, interactionRef: pending[0]!.interactionRef, beforeEffect: true, decision: 'allow', clicks: 1 };
    }
    currentSessions = await poll(sessions, values => values.some(row => record(row.binding).memberId === selected.memberId &&
      (row.inputs as unknown[]).map(record).some(input => input.inputId === inputId && input.phase === 'terminal')),
      'original member input reaches native terminal');
    const session = currentSessions.find(row => record(row.binding).memberId === selected.memberId)!;
    assert.deepEqual((session.inputs as unknown[]).map(record).map(input => [input.inputId, input.phase, input.terminal]),
      [[inputId, 'terminal', 'succeeded']]);
    await ui.waitRead('document.body.innerText.includes(' + desktopJsLiteral(reply) + ')', 'actual canonical Team reply visible');
    const nativeReply = (await rows(join(team, '.host-owner/commands'))).filter(row =>
      row.commandId === 'TEST-mcp-native-reply-' + selected.turn);
    assert.equal(nativeReply.length, 1); assert.equal(nativeReply[0]!.phase, 'completed');
    assert.equal(nativeReply[0]!.principalId, member.principalId);
    originals.push({ memberId: selected.memberId, command: original, outbox, nativeReply: nativeReply[0], inputId });
    assert.equal(model.requests.length, index === 0 ? 3 : 5);
    await absent(paths.excludedLog); await absent(paths.excludedEffect);
  }
  assert.deepEqual(model.failures, []); assert.equal(model.requests.length, 5);
  const lifecycle = readDesktopCapturedMcpEvents(fixture.root);
  assert.equal(lifecycle.filter(row => row.event === 'started').length, 1);
  assert.equal(lifecycle.filter(row => row.event === 'called').length, 1);
  assert.ok(lifecycle.every(row => row.instanceId === originalActor.instanceId && row.pid === originalActor.pid));
  const effect = await json(paths.effect);
  assert.deepEqual(effect, { server: 'selected', instanceId: originalActor.instanceId, pid: originalActor.pid, nonce: model.nonce });
  proof.externalEffect = effect; proof.catalogSha256 = description.catalogSha256;
  const lead = (await sessions()).find(row => record(row.binding).memberId === 'alice-id')!;
  assert.deepEqual(lead.inputs, [], 'lead remains inference-free after both teammate inputs');
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original all-member Stop');
  await ui.click('button[aria-label="Stop"]', 'Stop original native members once', 'Stop');
  currentSessions = await poll(sessions, values => values.length === 3 && values.every(row => row.phase === 'closed' &&
    row.custody === 'released' && row.sealed === true), 'all original Runtime custody released');
  await poll(async () => processFacts(), values => [...nativeChildren, actor].every(child => !values.some(row => row.pid === child.pid)),
    'all original native and external actor PIDs absent');
  const remaining = (await observeDesktopOpenCodeMetadata(fixture, group, physical, 0)).captured;
  proof.metadataAfterStop = remaining;
  proof.stop = { nativeChildren, actor, releasedBeforeQuit: true, originalActorAbsentBeforeQuit: true };
  const beforeReadback = await owner(), requestsBefore = JSON.stringify(model.requests);
  const closedRuntimeDigest = runtimeDigest(await readDesktopNativeStopSessions(fixture.root));
  const nativeEventsBefore = JSON.stringify(readDesktopCapturedMcpEvents(fixture.root));
  await openSettings();
  for (const [index, selected] of DESKTOP_MCP_MEMBERS.entries()) await assertPolicy(selected.name, index === 0);
  await ui.waitRead("[...document.querySelectorAll('[role=\"dialog\"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)",
    'original readback preflight has settled without another Launch', 120_000);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ui.waitRead("!document.querySelector('[role=\"dialog\"] #dialog-prompt')", 'close settings without another Launch');
  const settledManagement = await poll(() => rows(join(fixture.root, 'hoststore/management-commands'), 128),
    values => values.every(row => row.resourceHeld === false &&
      (row.kind !== 'model.probe' || ['completed', 'cancelled'].includes(String(row.phase)))),
    'original readback probes finished native cleanup');
  proof.metadataAfterReadback = (await observeDesktopOpenCodeMetadata(fixture, group, remaining, 0)).captured;
  assert.equal(runtimeDigest(await readDesktopNativeStopSessions(fixture.root)), closedRuntimeDigest,
    'readback probes do not alter any closed Runtime');
  proof.readbackModelProbes = settledManagement.filter(row => row.kind === 'model.probe')
    .map(row => ({ commandId: row.commandId, phase: row.phase, resourceHeld: row.resourceHeld }));
  proof.readbackRuntimeDigest = closedRuntimeDigest;
  const afterReadback = await owner();
  for (const field of ['members', 'savedSettings', 'runtimeCaptures']) assert.deepEqual(afterReadback[field], beforeReadback[field]);
  const retainedCommands = await rows(join(team, '.host-owner/commands'));
  for (const original of originals) {
    for (const command of [record(original.command), record(original.nativeReply)]) {
      const retained = retainedCommands.filter(row => row.commandId === command.commandId);
      assert.equal(retained.length, 1); assert.deepEqual(retained[0], command);
    }
    assert.deepEqual(await json(join(team, '.host-owner/outbox', String(original.inputId) + '.json')), original.outbox);
  }
  assert.equal(JSON.stringify(model.requests), requestsBefore);
  assert.equal(JSON.stringify(readDesktopCapturedMcpEvents(fixture.root)), nativeEventsBefore);
  for (const artifact of artifacts) assert.equal(await fileDigest(artifact.path), artifact.sha256);
  assert.equal(await fileDigest(paths.catalog), description.catalogSha256);
  await absent(paths.excludedLog); await absent(paths.excludedEffect);
  const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  const imagePath = join(fixture.root, 'ui-native-captured-mcp.png');
  await writeFile(imagePath, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
  Object.assign(proof, { status: 'PASS', ordinaryRequests: model.requests.length, probeRequests: model.probes.length,
    policiesRetainedAfterStop: true, originalCommandsRetained: true, leadInputs: 0, excludedActorStarted: false, externalCalls: 1,
    nativeSessionsAfterStop: currentSessions, screenshot: { path: imagePath, sha256: await fileDigest(imagePath) } });
}
