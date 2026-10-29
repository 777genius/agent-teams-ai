import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  return raw as Record<string, unknown>;
};

/** Continues the real Launch smoke only after original Stop/reload/prefill completed. */
export async function runDesktopRelaunchUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  evidence: Record<string, unknown>;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  firstCapture: Record<string, unknown>;
  firstSession: Record<string, unknown>;
  savedSettings: Record<string, unknown>;
  nativeTask: Record<string, unknown>;
  assertOwnedRenderer(): void;
}): Promise<void> {
  const { fixture, model, evidence, firstCapture } = options;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE', steps,
    scope: 'Host-owned stopped Team fresh Launch via reopened original dialog; two separate native conversations',
    excluded: ['native checkpoint Resume', 'legacy namespace import', 'live-team Relaunch', 'real vendor inference/authentication', 'full Stage1'],
  };
  evidence.relaunchDialogProof = proof;
  const step = (value: Record<string, unknown>) => steps.push(value);
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const teamRoot = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
  const state = () => json(join(teamRoot, '.host-owner/state.json'));
  const sessions = () => readDesktopNativeStopSessions(fixture.root);
  const capturedIds = new Set([firstCapture.launchId]);
  const capturedSessions = async () => (await sessions()).filter(row => capturedIds.has(record(row.binding).runId));
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 60000;
    let value = await read();
    while (!accept(value) && Date.now() < deadline) {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, [], 'native oracle cannot hide failed tools');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      value = await read();
    }
    assert.ok(accept(value), label);
    return value;
  };
  assert.equal(model.observations.length, 8);
  const before = await capturedSessions();
  assert.equal(before.length, 1, 'original runtime is the only retained session before fresh launch');
  assert.deepEqual(before[0]!.binding, options.firstSession.binding);
  assert.equal(record(before[0]!.binding).runId, firstCapture.launchId);
  assert.equal(before[0]!.phase, 'closed');
  assert.equal(before[0]!.custody, 'released');
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'visible reopened original prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'focus reopened original prompt');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.insertText', { text: 'NATIVE_TEAM_TWO' });
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_TWO'`, 'fresh launch prompt typed');
  await ui.scrollTo('[role="dialog"] button', 'visible original second Launch team control', 'Launch team');
  await ui.click('[role="dialog"] button', 'submit original fresh Launch team exactly once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'fresh launch dialog closes', 60000);
  const secondState = await poll(state, value => Array.isArray(value.runtimeCaptures) && value.runtimeCaptures.length === 2, 'exactly two captures');
  const captures = secondState.runtimeCaptures as unknown[];
  assert.deepEqual(captures[0], firstCapture, 'original capture immutable');
  const secondCapture = record(captures[1]);
  capturedIds.add(secondCapture.launchId);
  assert.notEqual(secondCapture.launchId, firstCapture.launchId);
  assert.deepEqual(secondState.savedSettings, { ...options.savedSettings, prompt: 'NATIVE_TEAM_TWO' });
  const secondMember = record((secondCapture.members as unknown[])[0]);
  const firstMember = record((firstCapture.members as unknown[])[0]);
  assert.equal(secondMember.memberId, firstMember.memberId);
  assert.notEqual(secondMember.principalId, firstMember.principalId);
  assert.notEqual(record(secondMember.delivery).generation, record(firstMember.delivery).generation);
  const terminal = await poll(capturedSessions, rows => rows.length === 2 && rows.every(session => {
    const inputs = session.inputs as unknown[];
    return inputs.length === 1 && record(inputs[0]).phase === 'terminal' && record(inputs[0]).terminal === 'succeeded';
  }), 'two original inputs only, both terminal');
  const original = terminal.find(session => record(session.binding).runId === firstCapture.launchId)!;
  const second = terminal.find(session => record(session.binding).runId === secondCapture.launchId)!;
  assert.ok(original && second);
  const predecessors = (await sessions()).filter(row => !capturedIds.has(record(row.binding).runId));
  assert.ok(predecessors.length <= 1, 'only the exact static descriptor predecessor may remain');
  const profile = await json(fixture.profilePath);
  const definition = record((profile.teams as unknown[])[0]);
  const member = record((definition.members as unknown[]).find(raw => record(raw).memberId === firstMember.memberId));
  const { teamName: _teamName, ...predecessorBinding } = record(member.delivery);
  for (const predecessor of predecessors) {
    assert.deepEqual(predecessor.binding, predecessorBinding);
    assert.equal(predecessor.phase, 'closed');
    assert.equal(predecessor.custody, 'released');
    assert.deepEqual(predecessor.inputs, [], 'descriptor predecessor never receives a native input');
    assert.equal(predecessor.config, null, 'descriptor predecessor never selects native config');
    assert.equal(predecessor.openFingerprint, null);
  }
  assert.equal(original.phase, 'closed');
  assert.equal(original.custody, 'released');
  assert.notDeepEqual(second.binding, original.binding);
  assert.equal(second.restoredFrom, undefined, 'fresh launch never uses checkpoint restore');
  assert.equal(model.observations.length, 11);
  const secondRequests = model.observations.filter(row => row.turn === 'NATIVE_TEAM_TWO');
  assert.equal(secondRequests.length, 3);
  assert.deepEqual(secondRequests.map(row => row.step), [0, 1, 2]);
  assert.ok(secondRequests.every(row => !row.priorTurn && row.contextEffective && row.requestedModel === 'claude-opus-4-6' && row.requestedEffort === 'medium'));
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
  assert.deepEqual(await json(join(fixture.root, 'hoststore/tasks/test-desktop-backend', `${options.nativeTask.id}.json`)), options.nativeTask, 'completed original native Task retained');
  const inbox = JSON.parse(await readFile(join(teamRoot, 'inboxes/user.json'), 'utf8')) as unknown;
  assert.ok(Array.isArray(inbox));
  const canonicalReplyCounts: Record<string, number> = {};
  for (const reply of ['REPLY_NATIVE_ONE', 'REPLY_NATIVE_TWO']) {
    canonicalReplyCounts[reply] = inbox.map(record).filter(row => row.text === reply && row.from === 'alice').length;
    assert.equal(canonicalReplyCounts[reply], 1);
  }
  proof.canonicalReplyCounts = canonicalReplyCounts;
  if (!(await cdp.evaluate(`Boolean(document.querySelector('.message-composer-flat-layout textarea'))`)))
    await ui.click('button[aria-label^="alice,"]', 'open original alice chat after fresh launch');
  await ui.waitRead(`document.body.innerText.includes('REPLY_NATIVE_TWO')`, 'fresh native reply visible');
  await ui.waitRead(`document.body.innerText.includes('REPLY_NATIVE_ONE')`, 'original reply retained in same product history');
  await revealDesktopReply(cdp, 'REPLY_NATIVE_TWO', { assertOwnedRenderer: options.assertOwnedRenderer, step });
  await revealDesktopReply(cdp, 'REPLY_NATIVE_ONE', { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  assert.equal(typeof screenshot.data, 'string');
  const path = join(fixture.root, 'ui-original-fresh-relaunch-native.png');
  await writeFile(path, Buffer.from(screenshot.data as string, 'base64'), { mode: 0o600 });
  const hosts = processTable().filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1);
  const children = processTable().filter(row => row.ppid === hosts[0]!.pid);
  assert.ok(children.length >= 1);
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original Stop after fresh launch');
  await ui.click('button[aria-label="Stop"]', 'original second Stop once', 'Stop');
  const stopped = await poll(capturedSessions, rows => rows.length === 2 && rows.every(row => row.phase === 'closed' && row.custody === 'released'), 'both fresh runs released before Quit');
  assert.deepEqual((await sessions()).filter(row => !capturedIds.has(record(row.binding).runId)), predecessors, 'static predecessor stays unchanged through second Stop');
  await poll(async () => processTable(), rows => children.every(child => !rows.some(row => row.pid === child.pid)), 'second native children physically absent');
  assert.equal(model.observations.length, 11);
  assert.deepEqual(model.failures, []);
  proof.captures = captures;
  proof.sessionsBeforeStop = terminal;
  proof.sessionsAfterStop = stopped;
  proof.staticPredecessors = predecessors;
  proof.stop = { nativeChildren: children, releasedBeforeQuit: true };
  proof.screenshot = { path, sha256: await fileDigest(path) };
  proof.nativeTaskRetained = options.nativeTask.id;
  proof.freshNativeHistory = secondRequests;
  proof.status = 'PASS';
}
