import { runDesktopNativeGroupUiSmoke } from './desktop-native-group-ui-smoke.ts';
import { prepareNativeChatAttachments } from './desktop-native-chat-attachments-ui.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function rows(path: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(path)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
  assert.ok(files.length <= 128);
  return Promise.all(files.map(async (name) => record(await json(join(path, name)))));
}
/** Deliberate new conversation scenario; does not repeat the already proven Task-create UI. */
export async function runDesktopComposerUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    repo: string;
    seed: { taskId: string; subject: string; commandId: string };
    assertOwnedRenderer(): void;
    evidence: Record<string, unknown>;
    nativeStop?: { assertNativeAbsent(): void };
    model?: Awaited<ReturnType<typeof startNativeTeamModel>>;
  }
): Promise<void> {
  assert.ok(options.nativeStop && options.model);
  if (process.env.LEGACY_DESKTOP_GROUP_CHATS === '1') {
    await runDesktopNativeGroupUiSmoke(cdp, {
      ...options,
      nativeStop: options.nativeStop,
      model: options.model,
    });
    return;
  }
  const model = options.model;
  const steps: Record<string, unknown>[] = [];
  const step = (value: Record<string, unknown>) => {
    steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  };
  options.evidence.conversationUiProof = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Ordinary Composer/recipient/Send, two actual native Claude turns/MCP/Bash, canonical replies and ordinary Stop before Quit',
    excluded: [
      'ordinary Launch UI',
      'vendor inference/authentication',
      'full activity widgets',
      'full P5/P8',
    ],
  };
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button[aria-label^="alice,"]', 'open ordinary alice direct chat');
  await ui.waitRead(
    `Boolean(document.querySelector('.message-composer-flat-layout textarea'))`,
    'direct chat Composer is visible'
  );
  const team = join(options.root, 'hoststore/teams/test-desktop-backend');
  const commands = join(team, '.host-owner/commands');
  const incomingIds: string[] = [];
  const nativeInputIds: string[] = [];
  for (const [turn, reply] of [
    ['NATIVE_TEAM_ONE', 'REPLY_NATIVE_ONE'],
    ['NATIVE_TEAM_TWO', 'REPLY_NATIVE_TWO'],
  ] as const) {
    await ui.click('.message-composer-flat-layout textarea', 'focus ordinary Composer');
    await cdp.send('Input.insertText', { text: turn });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${JSON.stringify(turn)}`,
      'typed message retained'
    );
    step({ action: 'Input.insertText', turn });
    const verifyAttachments =
      turn === 'NATIVE_TEAM_TWO' && process.env.LEGACY_DESKTOP_CHAT_ATTACHMENTS === '1'
        ? await prepareNativeChatAttachments(cdp, { ...options, step })
        : undefined;
    await ui.click('button.message-composer-send-button', 'ordinary Send once', 'Send');
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===''`,
      'Composer clears after admitted send'
    );
    // Only DOM reads wait for the visible native reply. Never click Send again.
    await ui.waitRead(
      `(() => {
      const e=document.querySelector('.message-composer-flat-layout');
      return Boolean(e)&&document.body.innerText.includes(${JSON.stringify(reply)});
    })()`,
      'native reply visible in ordinary thread',
      45_000
    );
    await revealDesktopReply(cdp, reply, {
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
    });
    assert.deepEqual(model.failures, [], 'local model oracle rejects any failed native MCP action');
    const human = (await rows(commands)).filter((row) => {
      const command = record(row.command);
      return (
        row.principalId === 'TEST-human' &&
        command.operation === 'message.send' &&
        record(command.payload).text === turn
      );
    });
    assert.equal(human.length, 1, 'one original human command per actual Send');
    const receipt = human[0]!;
    assert.equal(receipt.phase, 'completed');
    const id = String(receipt.commandId);
    assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.equal(record(record(receipt.command).payload).messageId, id);
    assert.equal(record(receipt.effects).messageId, id);
    const deliveryId = String(record(receipt.effects).deliveryId);
    assert.match(deliveryId, /^[a-f0-9-]{36}$/);
    const outbox = record(await json(join(team, '.host-owner/outbox', deliveryId + '.json')));
    assert.equal(outbox.messageId, id);
    assert.equal(outbox.inputId, deliveryId);
    nativeInputIds.push(deliveryId);
    assert.equal(outbox.phase, 'admitted');
    assert.equal(record(outbox.binding).memberId, 'alice-id');
    assert.equal(record(outbox.binding).generation, '1');
    const observations = model.observations.filter((row) => row.turn === turn);
    assert.ok(observations.length > 0);
    assert.ok(
      observations.every(
        (row) =>
          row.incomingMessageId === id &&
          row.visibleReplyContract &&
          row.contextEffective &&
          (!row.toolResultError || (row.turn === 'NATIVE_TEAM_ONE' && row.step === 4))
      )
    );
    if (turn === 'NATIVE_TEAM_TWO') assert.ok(observations.every((row) => row.priorTurn));
    if (verifyAttachments) {
      const refs = record(record(receipt.command).payload).attachments;
      assert.ok(
        Array.isArray(refs) && refs.length === 2,
        'same original message receipt retains both canonical references'
      );
      assert.deepEqual(outbox.attachments, refs);
      const expected = record(options.evidence.nativeChatAttachments).files;
      assert.ok(Array.isArray(expected) && expected.length === 2);
      refs.forEach((value, index) => {
        const ref = record(value),
          file = record(expected[index]);
        assert.match(String(ref.artifactId), /^[a-f0-9]{64}$/);
        assert.equal(ref.digest, file.sha256);
        assert.equal(ref.byteLength, file.size);
        assert.equal(ref.mimeType, file.mimeType);
        assert.equal(ref.filePath, undefined);
        assert.equal(ref.base64Data, undefined);
      });
      await verifyAttachments();
    }
    const inbox = await json(join(team, 'inboxes/user.json'));
    assert.ok(Array.isArray(inbox));
    const replies = inbox.map(record).filter((row) => row.text === reply);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.from, 'alice');
    incomingIds.push(id);
    step({
      assertion: 'native reply visible with exact canonical input and MCP actor',
      turn,
      reply,
      commandId: id,
      observations: observations.length,
    });
  }
  const until = Date.now() + 15_000;
  let sessions = await readDesktopNativeStopSessions(options.root);
  const settled = () =>
    sessions.length === 1 &&
    Array.isArray(sessions[0]!.inputs) &&
    (sessions[0]!.inputs as unknown[])
      .map(record)
      .every((row) => row.phase === 'terminal' && row.terminal === 'succeeded');
  while (!settled() && Date.now() < until) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    sessions = await readDesktopNativeStopSessions(options.root);
  }
  assert.ok(settled(), 'all admitted native inputs settle before ordinary Stop');
  const inputIds = (sessions[0]!.inputs as unknown[])
    .map(record)
    .map((row) => record(row.intent).inputId);
  for (const id of nativeInputIds) assert.ok(inputIds.includes(id));
  const tasks = await rows(join(options.root, 'hoststore/tasks/test-desktop-backend'));
  assert.equal(tasks.length, 2, 'seed plus one actual native tool-created Task');
  const task = tasks.find((row) => row.createdBy === 'alice');
  assert.ok(task);
  assert.equal(task.status, 'completed');
  assert.equal(task.owner, 'alice');
  assert.equal(record((task.comments as unknown[])[0]).author, 'alice');
  await ui.waitRead(
    `Boolean(document.querySelector('.kanban-task-card[data-task-id="'+CSS.escape(${JSON.stringify(task.id)})+'"]'))`,
    'native Task automatically appears in ordinary Kanban',
    15_000
  );

  assert.equal(
    await readFile(join(options.root, 'workspace/native-effect.txt'), 'utf8'),
    'ONE\nTWO\n'
  );
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const screenshotPath = join(options.root, 'ui-native-replies.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600 });
  options.evidence.conversationScreenshot = {
    path: screenshotPath,
    sha256: await fileDigest(screenshotPath),
  };
  await ui.click(
    'button[aria-label="Stop"]',
    'ordinary Stop once after native conversation',
    'Stop'
  );
  await ui.waitRead(
    `![...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop'||e.getAttribute('aria-label')?.startsWith('Stopping'))`,
    'Stop settles before Quit'
  );
  sessions = await readDesktopNativeStopSessions(options.root);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.phase, 'closed');
  assert.equal(sessions[0]!.custody, 'released');
  options.nativeStop.assertNativeAbsent();
  step({ assertion: 'exact Native PID absent and Runtime closed/released before any app Quit' });
  assert.deepEqual(model.failures, []);
  assert.ok(model.observations.every((item) => item.requestedModel === 'claude-opus-4-6'));
  assert.ok(model.observations.every((item) => item.requestedEffort === 'medium'));
  options.evidence.conversationUiProof = {
    ...record(options.evidence.conversationUiProof),
    status: 'PASS',
    incomingIds,
    taskId: task.id,
    nativeInputs: inputIds.length,
    nativeChildAbsentBeforeQuit: true,
    custody: 'released',
    effectiveModel: 'claude-opus-4-6',
    effectiveEffort: 'medium',
  };
}
