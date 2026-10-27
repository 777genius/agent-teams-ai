import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { command, processTable } from './desktop-backend-observations.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import {
  mixedDesktopTeamName,
  readMixedCapturedPrincipal,
} from './desktop-mixed-native-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const rows = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value));
  return value.map(row);
};
const one = (values: Row[], accepts: (value: Row) => boolean): Row => {
  const selected = values.filter(accepts);
  assert.equal(selected.length, 1);
  return selected[0]!;
};
/** F06 only: one original Bob Restart, then one finite Composer turn for each current provider. */
export async function runDesktopMixedMemberRestartUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    launchId: unknown;
    appGroup: number;
    node: string;
    hostEntry: string;
    models: DesktopMixedModels;
    assertOwnedRenderer(): void;
    step(value: Row): void;
  }
) {
  const ui = createDesktopUiControls(cdp, options);
  const read = async (path: string): Promise<Row> => row(JSON.parse(await readFile(path, 'utf8')));
  const teamRoot = join(options.root, 'hoststore/teams', mixedDesktopTeamName);
  const launchPath = join(
    teamRoot,
    '.host-owner/launches',
    runtimeDigest(options.launchId) + '.json'
  );
  const beforeLaunch = await read(launchPath),
    beforeOwner = await read(join(teamRoot, '.host-owner/state.json'));
  assert.deepEqual(
    beforeLaunch.memberActions ?? [],
    [],
    'one fresh ordinary action in this TEST run'
  );
  const before = (await readDesktopNativeStopSessions(options.root)).filter(
    (value) => row(value.binding).runId === options.launchId
  );
  assert.equal(before.length, 3);
  assert.ok(
    before.every(
      (value) =>
        value.phase === 'allocated' && value.custody === 'owned' && rows(value.inputs).length === 2
    )
  );
  const bob = one(rows(beforeOwner.members), (value) => value.name === 'bob');
  const source = one(before, (value) => row(value.binding).memberId === bob.memberId);
  const principalId = readMixedCapturedPrincipal(options.root, 'codex');
  const profile = await read(join(options.root, 'host-profile.json'));
  const codexPath = String(
    row(
      one(rows(row(profile.runtime).providerTemplates), (value) => value.provider === 'codex')
        .executable
    ).path
  );
  const hosts = processTable().filter(
    (value) =>
      value.pgid === options.appGroup &&
      command(value.pid) === `${options.node} ${options.hostEntry}`
  );
  assert.equal(hosts.length, 1);
  const hostPid = hosts[0]!.pid,
    childrenBefore = processTable().filter((value) => value.ppid === hostPid);
  assert.equal(childrenBefore.length, 3);
  const bobChildren = childrenBefore.filter((value) =>
    command(value.pid).startsWith(codexPath + ' ')
  );
  assert.equal(bobChildren.length, 1, 'original Codex child under this exact TEST Host');
  const oldBobChild = bobChildren[0]!,
    peers = childrenBefore.filter((value) => value.pid !== oldBobChild.pid);
  // Reuse the exact existing member-card interaction used by desktop-activity-ui-smoke.
  const point = row(
    await ui.waitRead(
      `(() => {
    const cards=[...document.querySelectorAll('[data-section-id="team"] div[role="button"][tabindex="0"]')].filter(e=>[...e.querySelectorAll('span')].some(s=>s.textContent.trim()==='bob'));
    if(cards.length!==1)return null;const e=cards[0],name=[...e.querySelectorAll('span')].find(s=>s.textContent.trim()==='bob');
    if(!name)return null;const r=name.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return r.width>0&&r.height>0&&hit&&!hit.closest('button')&&(hit===e||e.contains(hit))?{x,y}:null;
  })()`,
      'original Bob member card before isolated Restart'
    )
  );
  options.assertOwnedRenderer();
  options.step({ action: 'original-member-card-click', member: 'bob', point });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await ui.waitRead(
    `document.querySelector('[role="dialog"]')?.textContent.includes('bob')&&[...document.querySelectorAll('[role="dialog"] [role="tab"]')].some(e=>e.textContent.trim()==='Logs')`,
    'original Bob MemberDetailDialog'
  );
  await ui.click('[role="dialog"] button', 'original isolated Bob Restart once', 'Restart');
  const deadline = Date.now() + 90_000;
  let afterLaunch: Row = {},
    after: Row[] = [];
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    for (const model of [options.models.claude, options.models.codex, options.models.opencode])
      assert.deepEqual(model.failures, []);
    afterLaunch = await read(launchPath);
    after = (await readDesktopNativeStopSessions(options.root)).filter(
      (value) => row(value.binding).runId === options.launchId
    );
    const actions = rows(afterLaunch.memberActions ?? []);
    if (
      actions.length === 1 &&
      actions[0]!.phase === 'selected' &&
      after.length === 4 &&
      after.some(
        (value) =>
          row(value.binding).memberId === bob.memberId &&
          row(value.binding).generation !== row(source.binding).generation &&
          value.phase === 'allocated' &&
          value.custody === 'owned' &&
          value.nativeReady === true
      )
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const actions = rows(afterLaunch.memberActions);
  assert.equal(actions.length, 1);
  const action = actions[0]!,
    input = row(action.input),
    selectedBinding = row(row(action.selected).binding);
  assert.equal(action.phase, 'selected');
  assert.equal(input.action, 'restart');
  assert.equal(input.memberId, bob.memberId);
  assert.equal(input.launchId, options.launchId);
  assert.equal(input.expectedGeneration, row(source.binding).generation);
  assert.deepEqual(row(action.source).binding, source.binding);
  assert.deepEqual(selectedBinding, {
    ...row(source.binding),
    generation:
      'restart-' + runtimeDigest({ commandId: input.commandId, sourceBinding: source.binding }),
  });
  const retired = one(
    after,
    (value) => runtimeDigest(value.binding) === runtimeDigest(source.binding)
  );
  assert.equal(retired.phase, 'closed');
  assert.equal(retired.custody, 'released');
  assert.deepEqual(retired.inputs, source.inputs);
  const selected = one(
    after,
    (value) => runtimeDigest(value.binding) === runtimeDigest(selectedBinding)
  );
  assert.equal(selected.phase, 'allocated');
  assert.equal(selected.custody, 'owned');
  assert.equal(selected.nativeReady, true);
  assert.deepEqual(selected.inputs, []);
  assert.equal(row(selected.config).generation, Number(row(source.config).generation) + 1);
  for (const peer of before.filter((value) => row(value.binding).memberId !== bob.memberId))
    assert.deepEqual(
      one(after, (value) => runtimeDigest(value.binding) === runtimeDigest(peer.binding)),
      peer,
      'neighbor session unchanged by Bob Restart'
    );
  const currentBindings = rows(row(afterLaunch.definition).members).map((value) =>
    row(value.binding)
  );
  const current = () =>
    readDesktopNativeStopSessions(options.root).then((values) =>
      values.filter((value) =>
        currentBindings.some((binding) => runtimeDigest(binding) === runtimeDigest(value.binding))
      )
    );
  const afterOwner = await read(join(teamRoot, '.host-owner/state.json'));
  for (const key of ['runtimeCaptures', 'members', 'grants'])
    assert.deepEqual(afterOwner[key], beforeOwner[key]);
  assert.equal(
    readMixedCapturedPrincipal(options.root, 'codex'),
    principalId,
    'restart preserves the captured native principal and run'
  );
  const tableAfter = processTable(),
    childrenAfter = tableAfter.filter((value) => value.ppid === hostPid);
  assert.equal(childrenAfter.length, 3);
  assert.ok(!tableAfter.some((value) => value.pid === oldBobChild.pid));
  for (const peer of peers)
    assert.deepEqual(
      childrenAfter.find((value) => value.pid === peer.pid),
      peer,
      'neighbor physical child still owned by original Host'
    );
  const newChildren = childrenAfter.filter(
    (value) => !childrenBefore.some((previous) => previous.pid === value.pid)
  );
  assert.equal(newChildren.length, 1);
  assert.ok(command(newChildren[0]!.pid).startsWith(codexPath + ' '));
  assert.deepEqual(
    [options.models.claude, options.models.codex, options.models.opencode].map(
      (model) => model.observations.length
    ),
    [10, 12, 10],
    'Restart does not replay an original business input'
  );
  await ui.click(
    '[role="dialog"] button',
    'close original Bob member detail after Restart',
    'Close'
  );
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original member detail closed');
  await ui.scrollTo('button[aria-label="Back to chats"]', 'original mixed group Back to chats');
  await ui.click('button[aria-label="Back to chats"]', 'original mixed group Back to chats');
  const continuedInputs: Row[] = [];
  for (const [name, provider, turn, reply] of [
    ['team-lead', 'claude', 'NATIVE_TEAM_TWO', 'REPLY_NATIVE_TWO'],
    ['bob', 'codex', 'CODEX_TEAM_TWO', 'REPLY_CODEX_TWO'],
    ['carol', 'opencode', 'OPENCODE_TEAM_TWO', 'REPLY_OPENCODE_TWO'],
  ] as const) {
    const displayName = name === 'team-lead' ? 'lead' : name;
    await ui.click(
      `button[aria-label^=${desktopJsLiteral(displayName + ',')}]`,
      `original ${provider} direct chat after Bob Restart`
    );
    await ui.click(
      '.message-composer-flat-layout textarea',
      `original ${provider} Composer after Bob Restart`
    );
    await cdp.send('Input.insertText', { text: turn });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${desktopJsLiteral(turn)}`,
      'original continuation input retained'
    );
    await ui.click(
      'button.message-composer-send-button',
      `send one original ${provider} continuation`,
      'Send'
    );
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===''&&document.body.innerText.includes(${desktopJsLiteral(reply)})`,
      'native continuation reply visible',
      90_000
    );
    await revealDesktopReply(cdp, reply, options);
    const selectedMember = one(rows(beforeOwner.members), (value) => value.name === name);
    const session = one(
      await current(),
      (value) => row(value.binding).memberId === selectedMember.memberId
    );
    const previous =
      row(session.binding).memberId === bob.memberId
        ? selected
        : one(before, (value) => row(value.binding).memberId === selectedMember.memberId);
    const admitted = rows(session.inputs).filter(
      (value) =>
        !rows(previous.inputs).some((old) => row(old.intent).inputId === row(value.intent).inputId)
    );
    assert.equal(admitted.length, 1);
    const outbox = await read(
      join(teamRoot, '.host-owner/outbox', String(row(admitted[0]!.intent).inputId) + '.json')
    );
    assert.equal(outbox.phase, 'admitted');
    assert.equal(row(outbox.binding).generation, row(session.binding).generation);
    continuedInputs.push({
      name,
      provider,
      turn,
      reply,
      principalId: readMixedCapturedPrincipal(options.root, provider),
      binding: session.binding,
      input: admitted[0],
      outbox,
    });
  }
  const finishedBy = Date.now() + 90_000;
  let continued: Row[] = [];
  while (Date.now() < finishedBy) {
    options.assertOwnedRenderer();
    continued = await current();
    if (
      continued.length === 3 &&
      continued.every(
        (value) =>
          rows(value.inputs).length === (row(value.binding).memberId === bob.memberId ? 1 : 3) &&
          rows(value.inputs).every(
            (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
          )
      )
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(continued.length, 3);
  assert.ok(
    continued.every(
      (value) =>
        rows(value.inputs).length === (row(value.binding).memberId === bob.memberId ? 1 : 3) &&
        rows(value.inputs).every(
          (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
        )
    )
  );
  assert.deepEqual(
    [options.models.claude, options.models.codex, options.models.opencode].map(
      (model) => model.observations.length
    ),
    [13, 15, 13]
  );
  assert.equal(
    await readFile(join(options.root, 'workspace/native-effect.txt'), 'utf8'),
    'ONE\nONE\nONE\nTWO\nTWO\nTWO\n'
  );
  // Store the final terminal form, not the earlier admitted snapshot observed beside the visible reply.
  for (const proof of continuedInputs)
    proof.input = one(
      rows(
        one(continued, (value) => runtimeDigest(value.binding) === runtimeDigest(proof.binding))
          .inputs
      ),
      (value) => row(value.intent).inputId === row(row(proof.input).intent).inputId
    );
  return {
    status: 'PASS',
    action,
    beforeLaunch,
    afterLaunch,
    before,
    afterRestart: after,
    continued,
    retired,
    continuedInputs,
    originalPrincipalId: principalId,
    currentBindings,
    physical: {
      hostPid,
      childrenBefore,
      oldBobChild,
      childrenAfter,
      newBobChild: newChildren[0],
      peers,
    },
    expectedObservations: [13, 15, 13],
    scope:
      'Original Bob MemberDetail Restart retires only its source generation; same principal/run, one fresh selected Bob, original Claude/OpenCode neighbors continue; three existing Composer turns. No Resume/host restart/shared OpenCode/cross-Team claim.',
  };
}
