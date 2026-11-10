import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { NATIVE_MEMBER } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/member-creation.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
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
/** Existing solo Create continuation only: original Composer → actual native tools, never API setup. */
export async function runDesktopCreateMemberUi(
  cdp: UiCdpPort,
  options: {
    root: string;
    launchId: unknown;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    evidence: Row;
    assertOwnedRenderer(): void;
    step(value: Row): void;
  }
) {
  const ui = createDesktopUiControls(cdp, options);
  const observations = options.model.nativeMemberObservations;
  assert.ok(observations, 'explicit native member TEST oracle required');
  const read = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
  const statePath = join(
    options.root,
    'hoststore/teams/test-created-native/.host-owner/state.json'
  );
  const launchPath = join(
    options.root,
    'hoststore/teams/test-created-native/.host-owner/launches',
    runtimeDigest(options.launchId) + '.json'
  );
  const sessions = async () =>
    (await readDesktopNativeStopSessions(options.root)).filter(
      (value) => row(value.binding).runId === options.launchId
    );
  const beforeOwner = await read(statePath),
    beforeLaunch = await read(launchPath),
    before = await sessions();
  assert.equal(rows(beforeOwner.members).length, 1);
  assert.equal(before.length, 1);
  const originalLead = before[0]!;
  assert.equal(originalLead.phase, 'allocated');
  assert.equal(originalLead.custody, 'owned');
  assert.equal(rows(originalLead.inputs).length, 1);
  const proof: Row = {
    status: 'INCOMPLETE',
    scope:
      'One original lead Do input creates a persistent native peer via existing MCP; original lookup, real addressed peer work/reply, next-input current roster once, ordinary Stop/reload',
    beforeOwner,
    beforeLaunch,
    originalLead,
  };
  options.evidence.nativeMemberCreationProof = proof;
  const send = async (text: string, reply: string) => {
    await ui.click(
      '.message-composer-action-modes button[role="radio"]',
      'original lead Do mode',
      'Do'
    );
    await ui.waitRead(
      `Boolean([...document.querySelectorAll('.message-composer-action-modes button[role="radio"]')].find(e=>e.textContent.trim()==='Do'&&e.getAttribute('aria-checked')==='true'))`,
      'original lead Do selected'
    );
    await ui.click('.message-composer-flat-layout textarea', 'original lead Composer');
    await cdp.send('Input.insertText', { text });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${desktopJsLiteral(text)}`,
      'original native teammate intent retained'
    );
    await ui.click(
      'button.message-composer-send-button',
      'send original native teammate intent once',
      'Send'
    );
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===''&&document.body.innerText.includes(${desktopJsLiteral(reply)})`,
      'original native teammate reply',
      90_000
    );
    await revealDesktopReply(cdp, reply, options);
  };
  await send(NATIVE_MEMBER.create, NATIVE_MEMBER.created);
  const deadline = Date.now() + 90_000;
  let owner = await read(statePath),
    after = await sessions();
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    assert.deepEqual(options.model.failures, []);
    owner = await read(statePath);
    after = await sessions();
    if (
      after.length === 2 &&
      after.every(
        (value) =>
          value.phase === 'allocated' &&
          value.custody === 'owned' &&
          value.nativeReady === true &&
          rows(value.inputs).length ===
            (row(value.binding).memberId === row(originalLead.binding).memberId ? 2 : 1) &&
          rows(value.inputs).every(
            (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
          )
      )
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(after.length, 2, 'exactly one additional native allocation');
  assert.ok(
    after.every(
      (value) =>
        value.phase === 'allocated' && value.custody === 'owned' && value.nativeReady === true
    )
  );
  const member = one(rows(owner.members), (value) => value.name === NATIVE_MEMBER.name);
  const originalMember = rows(beforeOwner.members)[0]!;
  assert.deepEqual(
    one(rows(owner.members), (value) => value.memberId === originalMember.memberId),
    originalMember,
    'original lead binding and settings stay immutable'
  );
  const lead = one(
    after,
    (value) => runtimeDigest(value.binding) === runtimeDigest(originalLead.binding)
  );
  assert.equal(lead.sessionRef, originalLead.sessionRef);
  assert.equal(lead.openFingerprint, originalLead.openFingerprint);
  assert.deepEqual(
    rows(lead.inputs)[0],
    rows(originalLead.inputs)[0],
    'original completed work is never replayed'
  );
  assert.equal(rows(lead.inputs).length, 2);
  const peer = one(after, (value) => row(value.binding).memberId === member.memberId);
  assert.deepEqual(peer.binding, {
    ...row(originalLead.binding),
    memberId: member.memberId,
    generation: row(member.delivery).generation,
  });
  assert.equal(rows(peer.inputs).length, 1, 'new teammate works only after explicit message_send');
  assert.ok(
    after.every((value) =>
      rows(value.inputs).every(
        (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
      )
    )
  );
  for (const grant of rows(beforeOwner.grants))
    assert.deepEqual(
      one(rows(owner.grants), (value) => value.principalId === grant.principalId),
      grant,
      'existing grant unchanged'
    );
  const commands = rows(owner.rosterCommands),
    creation = one(commands, (value) => value.commandId === NATIVE_MEMBER.commandId),
    native = row(creation.nativeCreation);
  assert.equal(native.phase, 'completed');
  assert.equal(row(native.input).commandId, NATIVE_MEMBER.commandId);
  assert.equal(row(native.member).memberId, member.memberId);
  assert.deepEqual(row(native.selection).delivery, member.delivery);
  const launch = await read(launchPath);
  assert.equal(rows(launch.definition && row(launch.definition).members).length, 2);
  assert.equal(rows(launch.nativeAdditions).length, 1);
  assert.equal(rows(launch.nativeAdditions)[0]!.commandId, NATIVE_MEMBER.commandId);
  assert.deepEqual(
    rows(row(launch.definition).members)[0],
    rows(row(beforeLaunch.definition).members)[0],
    'original launch member unchanged'
  );
  assert.deepEqual(owner.runtimeCaptures, beforeOwner.runtimeCaptures);
  assert.deepEqual(owner.savedSettings, beforeOwner.savedSettings);
  assert.ok(observations.some((value) => value.originalLookup));
  const epochs = rows(owner.contextEpochs).filter((value) =>
    String(value.sourceRef).startsWith('native-roster:')
  );
  assert.equal(epochs.length, 1);
  assert.equal(
    epochs[0]!.represented,
    undefined,
    'no hidden reminder input while original creating input runs'
  );
  proof.afterCreation = { owner, launch, sessions: after };
  await ui.click('button[aria-label="Back to chats"]', 'original Back to chats for created peer');
  await ui.click(
    `button[aria-label^=${desktopJsLiteral(NATIVE_MEMBER.name + ',')}]`,
    'original newly created peer thread'
  );
  await ui.waitRead(
    `document.body.innerText.includes(${desktopJsLiteral(NATIVE_MEMBER.reply)})`,
    'actual new teammate reply in original chat',
    90_000
  );
  proof.peerReplyVisible = await revealDesktopReply(cdp, NATIVE_MEMBER.reply, options);
  await ui.click(
    'button[aria-label="Back to chats"]',
    'original Back to chats for continuing lead'
  );
  await ui.click('button[aria-label^="lead,"]', 'original lead thread after native addition');
  // Same actual lead thread; the native response must observe the new canonical roster once.
  await send(NATIVE_MEMBER.next, NATIVE_MEMBER.contextReply);
  await send(NATIVE_MEMBER.followup, NATIVE_MEMBER.followupReply);
  let final = await sessions();
  const finalDeadline = Date.now() + 90_000;
  const settled = (values: Row[]) =>
    values.length === 2 &&
    values.every(
      (value) =>
        rows(value.inputs).length ===
          (row(value.binding).memberId === row(originalLead.binding).memberId ? 4 : 1) &&
        rows(value.inputs).every(
          (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
        )
    );
  while (!settled(final) && Date.now() < finalDeadline) {
    options.assertOwnedRenderer();
    assert.deepEqual(options.model.failures, []);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    final = await sessions();
  }
  assert.ok(settled(final), 'all five original inputs finish before ordinary Stop');
  const finalOwner = await read(statePath);
  const finalLead = one(
    final,
    (value) => runtimeDigest(value.binding) === runtimeDigest(originalLead.binding)
  );
  assert.equal(final.length, 2);
  assert.equal(rows(finalLead.inputs).length, 4);
  assert.deepEqual(
    one(final, (value) => runtimeDigest(value.binding) === runtimeDigest(peer.binding)).inputs,
    peer.inputs,
    'later lead work cannot repeat peer dispatch'
  );
  const reminderInputs = rows(finalLead.inputs).filter(
    (value) => value.preparation !== undefined && row(value.preparation).prefix !== undefined
  );
  assert.equal(reminderInputs.length, 1, 'one prepared original input, never a hidden turn');
  assert.ok(String(row(reminderInputs[0]!.preparation).prefix).includes(NATIVE_MEMBER.name));
  assert.ok(
    rows(finalOwner.contextEpochs).some(
      (value) => value.epochId === epochs[0]!.epochId && value.represented
    )
  );
  assert.equal(observations.length, 11);
  assert.equal(options.model.observations.length, 8, 'original Create proof is unchanged');
  assert.deepEqual(options.model.failures, []);
  Object.assign(proof, {
    status: 'NATIVE_PASS_AWAITING_STOP',
    creation,
    originalLookup: observations.find((value) => value.originalLookup),
    finalSessions: final,
    currentRosterReminderExactlyOnce: true,
  });
  return {
    proof,
    expectedSessions: 2,
    observations: observations.length,
    assertRetained(retained: Row) {
      const productMembers = (value: Row) =>
        rows(value.members)
          .map((member) => ({
            memberId: member.memberId,
            name: member.name,
            role: member.role,
            settings: member.settings,
          }))
          .sort((a, b) => String(a.memberId).localeCompare(String(b.memberId)));
      assert.deepEqual(
        productMembers(retained),
        productMembers(owner),
        'reload preserves both exact product identities and configured settings'
      );
      assert.deepEqual(
        one(rows(retained.rosterCommands), (value) => value.commandId === NATIVE_MEMBER.commandId),
        creation,
        'Stop/reload preserves the exact original creation receipt and selected delivery'
      );
      assert.deepEqual(
        retained.runtimeCaptures,
        beforeOwner.runtimeCaptures,
        'no replacement run after Stop/reload'
      );
      return { members: productMembers(retained), creation };
    },
  };
}
