import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import {
  APPROVAL_AFTER,
  APPROVAL_BEFORE,
  APPROVAL_TURNS,
  APPROVAL_ANSWER,
} from './desktop-approval-model.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string): Promise<Record<string, unknown>> =>
  object(JSON.parse(await readFile(path, 'utf8')));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
const sheet = 'div.fixed.bottom-4';
/** Actual original Sheet + Composer controls. TEST setup only allocates the captured native session. */
export async function runDesktopApprovalUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { subject: string };
    evidence: Record<string, unknown>;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    assertOwnedRenderer(): void;
    assertNativeAbsent(): void;
  }
): Promise<void> {
  const configuration = object(object(options.evidence.nativeSetup).configuration);
  assert.ok(Array.isArray(configuration.members) && configuration.members.length === 1);
  assert.equal(
    object(configuration.members[0]).permissions,
    'manual',
    'actual captured launch is manual before any input'
  );
  const model = options.model;
  assert.ok('approvalReceipts' in model && Array.isArray(model.approvalReceipts));
  const steps: Record<string, unknown>[] = [],
    commands: Record<string, unknown>[] = [];
  const proof = {
    status: 'INCOMPLETE',
    steps,
    commands,
    scope:
      'Existing Composer and technical approval/question Sheet through actual SDK/CLI, exact Runtime owner, captured preview and pending-policy synchronization; TEST setup launch, localhost scripted inference',
    excluded: [
      'ordinary Launch UI',
      'vendor inference/authentication',
      'other provider interaction parity',
      'full M06',
    ],
  };
  options.evidence.approvalUiProof = proof;
  const step = (value: Record<string, unknown>) =>
    steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button[aria-label^="alice,"]', 'open original alice chat');
  await ui.waitRead(
    "Boolean(document.querySelector('.message-composer-flat-layout textarea'))",
    'original Composer'
  );
  const team = join(options.root, 'hoststore/teams/test-desktop-backend');
  const launch = object(object(options.evidence.nativeSetup).launch);
  const members = launch.members;
  assert.ok(Array.isArray(members) && members.length === 1);
  const selected = object(members[0]);
  assert.equal(selected.memberId, 'alice-id');
  const session = async () => {
    const values = (await readDesktopNativeStopSessions(options.root)).filter(
      (row) => object(row.binding).runId === launch.launchId
    );
    assert.equal(values.length, 1, 'exact original captured launch Runtime');
    const value = values[0]!;
    assert.equal(object(value.binding).memberId, selected.memberId);
    assert.equal(object(value.binding).generation, selected.generation);
    return value;
  };
  const waitSession = async (
    predicate: (value: Record<string, unknown>) => boolean,
    label: string
  ) => {
    const deadline = Date.now() + 45_000;
    do {
      const value = await session();
      if (predicate(value)) return value;
      await tick();
    } while (Date.now() < deadline);
    throw new Error(`Runtime read timed out: ${label}; no input/action retry`);
  };
  const header = async () =>
    String(
      await ui.waitRead(
        `(() => { const e=document.querySelector(${desktopJsLiteral(sheet)});return e?.querySelector('.text-sm.font-semibold')?.textContent?.trim()||null; })()`,
        'exact original technical Sheet'
      )
    );
  // Prefix selectors only select existing visible original controls. Actions remain CDP mouse events.
  const clickPrefix = async (prefix: string) => {
    const selector = `${sheet} button`;
    const expression = `(() => { const rows=[...document.querySelectorAll(${desktopJsLiteral(selector)})].filter(e=>e.textContent.trim().startsWith(${desktopJsLiteral(prefix)}));if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&!e.disabled&&hit&&(e===hit||e.contains(hit))?{x,y,text:e.textContent.trim()}:null; })()`;
    await cdp.send('Page.bringToFront');
    let point = object(await ui.waitRead(expression, prefix));
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    for (let n = 0; n < 3; n++) {
      await tick();
      const next = object(await ui.waitRead(expression, prefix));
      assert.equal(next.x, point.x);
      assert.equal(next.y, point.y);
      point = next;
    }
    options.assertOwnedRenderer();
    step({ action: 'mouseClick', prefix, target: point, state: 'attempted' });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  };
  for (const turn of APPROVAL_TURNS) {
    assert.deepEqual(model.failures, []);
    await ui.waitRead(
      `!document.querySelector(${desktopJsLiteral(sheet)})`,
      'previous exact request dismissed'
    );
    await ui.click('.message-composer-flat-layout textarea', 'focus original Composer');
    await cdp.send('Input.insertText', { text: turn });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${desktopJsLiteral(turn)}`,
      'exact original input text'
    );
    step({ action: 'Input.insertText', turn });
    await ui.click('button.message-composer-send-button', 'original Send once', 'Send');
    await ui.waitRead(
      "document.querySelector('.message-composer-flat-layout textarea')?.value===''",
      'admitted Send clears original Composer'
    );
    if (turn !== 'M06_AUTO_WRITE') {
      let title = await header();
      if (['M06_ALLOW_WRITE', 'M06_ALLOW_ALL'].includes(turn) && title === 'Read File') {
        step({
          assertion: 'optional actual SDK Read permission precedes Write',
          turn,
        });
        await ui.click(`${sheet} button`, 'Allow original captured Read', 'Allow');
        await ui.waitRead(
          `document.querySelector(${desktopJsLiteral(sheet)})?.querySelector('.text-sm.font-semibold')?.textContent?.trim()==='Write File'`,
          'next exact captured Write'
        );
        title = await header();
      }
      if (turn === 'M06_DENY_COMMAND') {
        assert.equal(title, 'Terminal');
        await ui.click(`${sheet} button`, 'Deny original command once', 'Deny');
      } else if (turn === 'M06_DENY_QUESTION' || turn === 'M06_ANSWER_QUESTION') {
        assert.equal(title, 'Question');
        await ui.waitRead(
          `document.querySelector(${desktopJsLiteral(sheet)})?.innerText.includes('Choose the TEST answer')`,
          'original question text'
        );
        if (turn === 'M06_DENY_QUESTION')
          await ui.click(`${sheet} button`, 'Deny original question once', 'Deny');
        else {
          await clickPrefix(APPROVAL_ANSWER);
          await ui.click(
            `${sheet} button`,
            'Submit selected original question answer once',
            'Submit'
          );
        }
      } else {
        assert.equal(title, 'Write File');
        if (turn === 'M06_ALLOW_WRITE') {
          assert.equal(
            await readFile(join(options.root, 'workspace/approval-preview.txt'), 'utf8'),
            APPROVAL_BEFORE
          );
          await clickPrefix('Preview changes');
          await ui.waitRead(
            `(() => { const e=document.querySelector(${desktopJsLiteral(sheet)});return e?.innerText.includes('TEST_ORIGINAL_PRIVATE_BYTES')&&e.innerText.includes('TEST_APPROVED_NATIVE_WRITE'); })()`,
            'actual captured original/modified preview bytes'
          );
          assert.equal(
            await readFile(join(options.root, 'workspace/approval-preview.txt'), 'utf8'),
            APPROVAL_BEFORE,
            'preview has no write effect'
          );
          const screenshot = object(
            await cdp.send('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
            })
          );
          const path = join(options.root, 'ui-approval-preview.png');
          await writeFile(path, Buffer.from(String(screenshot.data), 'base64'), {
            mode: 0o600,
            flag: 'wx',
          });
          options.evidence.approvalPreviewScreenshot = {
            path,
            sha256: await fileDigest(path),
          };
          await ui.click(`${sheet} button`, 'Allow original Write once', 'Allow');
        } else
          await ui.click(
            `${sheet} button`,
            'original Allow all preference synchronizes pending Write',
            'Allow all'
          );
      }
    }
    await ui.waitRead(
      `document.body.innerText.includes(${desktopJsLiteral(`DONE_${turn}`)})`,
      'actual canonical native reply after permission outcome',
      45_000
    );
    const commandFiles = (await readdir(join(team, '.host-owner/commands'))).filter((name) =>
      /^[A-Za-z0-9_-]+\.json$/.test(name)
    );
    assert.ok(commandFiles.length <= 128);
    const rows = await Promise.all(
      commandFiles.map((name) => json(join(team, '.host-owner/commands', name)))
    );
    const human = rows.filter(
      (row) =>
        row.principalId === 'TEST-human' &&
        object(row.command).operation === 'message.send' &&
        object(object(row.command).payload).text === turn
    );
    assert.equal(human.length, 1, 'one original human command per technical interaction turn');
    const command = human[0]!;
    assert.equal(command.phase, 'completed');
    const id = String(command.commandId),
      inputId = String(object(command.effects).deliveryId);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.match(inputId, /^[a-f0-9-]{36}$/);
    const outbox = await json(join(team, '.host-owner/outbox', inputId + '.json'));
    assert.equal(outbox.messageId, id);
    assert.equal(outbox.inputId, inputId);
    assert.equal(outbox.phase, 'admitted');
    const state = await waitSession(
      (value) =>
        Array.isArray(value.inputs) &&
        value.inputs
          .map(object)
          .some(
            (row) =>
              object(row.intent).inputId === inputId &&
              row.phase === 'terminal' &&
              row.terminal === 'succeeded'
          ),
      turn + ' terminal'
    );
    const interactions = state.interactions;
    assert.ok(Array.isArray(interactions));
    const original = interactions.map(object).filter((row) => row.inputId === inputId);
    assert.ok(original.every((row) => row.phase === 'resolved'));
    if (turn === 'M06_DENY_QUESTION' || turn === 'M06_ANSWER_QUESTION')
      assert.equal(original.filter((row) => row.kind === 'question').length, 1);
    if (turn === 'M06_DENY_COMMAND' || turn === 'M06_ALLOW_WRITE' || turn === 'M06_ALLOW_ALL')
      assert.ok(original.some((row) => row.kind === 'permission'));
    const inbox = JSON.parse(await readFile(join(team, 'inboxes/user.json'), 'utf8')) as unknown;
    assert.ok(Array.isArray(inbox));
    const replies = inbox.map(object).filter((row) => row.text === `DONE_${turn}`);
    assert.equal(replies.length, 1, 'one actual canonical native reply');
    assert.equal(replies[0]!.from, 'alice');
    const observed = model.observations.filter((row) => row.turn === turn);
    assert.ok(observed.length > 0);
    assert.ok(
      observed.every(
        (row) =>
          row.incomingMessageId === id &&
          row.contextEffective &&
          row.visibleReplyContract &&
          row.requestedModel === 'claude-opus-4-6' &&
          row.requestedEffort === 'medium'
      )
    );
    commands.push({ turn, commandId: id, inputId, interactions: original });
    step({
      assertion: 'exact command/input and resolved original interaction with canonical reply',
      turn,
      commandId: id,
      inputId,
    });
  }
  assert.equal(
    await readFile(join(options.root, 'workspace/approval-preview.txt'), 'utf8'),
    APPROVAL_AFTER
  );
  assert.equal(
    await readFile(join(options.root, 'workspace/approval-auto.txt'), 'utf8'),
    'M06_ALLOW_ALL_NATIVE_WRITE\n'
  );
  assert.equal(
    await readFile(join(options.root, 'workspace/approval-auto-next.txt'), 'utf8'),
    'M06_AUTO_WRITE_NATIVE_WRITE\n'
  );
  await assert.rejects(access(join(options.root, 'workspace/approval-denied.txt')), {
    code: 'ENOENT',
  });
  assert.deepEqual(model.failures, []);
  assert.deepEqual(model.probes, []);
  assert.deepEqual(model.unexpectedNoToolsRequests, []);
  const inputIds = commands.map((row) => row.inputId);
  assert.equal(new Set(inputIds).size, APPROVAL_TURNS.length);
  const beforeStop = await session();
  assert.ok(Array.isArray(beforeStop.inputs));
  assert.deepEqual(
    beforeStop.inputs
      .map(object)
      .map((row) => object(row.intent).inputId)
      .sort(),
    [...inputIds].sort()
  );
  options.evidence.approvalNativeBeforeStop = beforeStop;
  await ui.click(
    'button[aria-label="Stop"]',
    'original Stop once after technical interaction proof',
    'Stop'
  );
  await ui.waitRead(
    "![...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop'||e.getAttribute('aria-label')?.startsWith('Stopping'))",
    'original Stop settles'
  );
  const stopped = await session();
  assert.equal(stopped.phase, 'closed');
  assert.equal(stopped.custody, 'released');
  options.assertNativeAbsent();
  options.evidence.approvalNativeAfterStop = stopped;
  options.evidence.approvalUiProof = {
    ...proof,
    status: 'PASS',
    modelReceipts: model.approvalReceipts,
    nativeChildAbsentBeforeQuit: true,
    inputIds,
    settingsProof:
      'Original Allow all synchronizes the pending Write and next Write; questions remain explicit after Allow all',
    policyPersistence:
      'Host-lifetime preferences only; cold policy defaults are covered separately',
  };
}
