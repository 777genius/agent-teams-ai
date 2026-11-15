import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { clearInsertedDraft } from './desktop-native-next-prompt-ui.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type {
  SuggestionActor,
  SuggestionFixture,
  SuggestionModels,
  SuggestionTeam,
} from './desktop-native-next-prompt-mixed-fixture.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const rows = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value) && value.length <= 128);
  return value.map(row);
};
const editor = '.message-composer-flat-layout textarea';
const offer = '[data-testid="native-next-prompt-row"]';
const ownerKey = (team: SuggestionTeam) => 'host-team:' + encodeURIComponent(team.handleId);
const json = async (path: string): Promise<Row> => row(JSON.parse(await readFile(path, 'utf8')));

async function key(cdp: UiCdpPort, name: string, code: string, virtual: number, modifiers = 0) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code,
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: virtual,
      modifiers,
    });
}

/** Actual native providers and original Host/Main/Composer, with finite localhost inference. */
export async function runDesktopNativeNextPromptMixedUi(
  cdp: UiCdpPort,
  options: {
    fixture: SuggestionFixture;
    models: SuggestionModels;
    group: number;
    evidence: Row;
    assertOwnedRenderer(): void;
  }
) {
  const { fixture, models } = options;
  const steps: Row[] = [],
    accepted: Row[] = [],
    isolated: Row[] = [];
  const proof = {
    status: 'INCOMPLETE',
    originalHumanInputs: 0,
    noAutoSend: false,
    nativeCustodyReleased: false,
    steps,
    accepted,
    isolated,
    screenshots: [] as Row[],
    scope:
      'Claude and Codex 0.169 lead/peer in reversed mixed teams; original native input, Main IPC, Insert/Tab and late-event recipient/team isolation',
  };
  options.evidence.nativeNextPromptMixedUi = proof;
  const step = (value: Row) => steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const assertModels = () => {
    for (const actor of models.actors)
      assert.deepEqual((actor.claude ?? actor.codex)!.failures, []);
  };
  const wait = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      assertModels();
      const value = await read();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Original native suggestion proof did not settle: ${label}`);
  };
  const invoke = async (
    team: SuggestionTeam,
    operation: string,
    commandId: string,
    payload: unknown
  ) => {
    options.assertOwnedRenderer();
    const result = row(
      await cdp.evaluate(
        `window.electronAPI.agentBackend.invoke(${desktopJsLiteral({
          handle: { handleId: team.handleId },
          operation,
          commandId,
          payload,
        })})`
      )
    );
    assert.equal(result.ok, true, `${operation} for original TEST ${team.key}`);
    return row(result.value);
  };
  await ui.observeInput();
  assert.equal(
    await cdp.evaluate(`window.electronAPI.config.get().then(config =>
    config.general.nativeNextPromptSuggestionsEnabled === true)`),
    true,
    'original Electron Main loaded the private TEST opt-in before provider allocation'
  );
  assert.equal(
    await cdp.evaluate(`(() => {
    const bridge=window.electronAPI?.nativePromptSuggestions;
    if(typeof bridge?.onUpdated!=='function')return false;
    window.__TEST_mixedSuggestionNotices=[];
    bridge.onUpdated(value=>{
      const notices=window.__TEST_mixedSuggestionNotices;
      if(!Array.isArray(notices)||notices.length>=24)return;
      notices.push(value);
    });
    return true;
  })()`),
    true,
    'passive subscription to the existing scoped preload channel'
  );

  for (const team of fixture.suggestionTeams) {
    const selection = await invoke(
      team,
      'team.launch.read',
      `TEST-suggestion-read-${team.key}`,
      {}
    );
    assert.deepEqual(
      rows(selection.members)
        .map((member) => member.memberId)
        .sort(),
      ['alice-id', 'lead-id']
    );
    const configuration = {
      members: models.actors
        .filter((actor) => actor.team === team.key)
        .map((actor) => ({
          memberId: actor.memberId,
          model: actor.provider === 'codex' ? 'mock-model' : 'claude-opus-4-6',
          ...(actor.provider === 'claude'
            ? { effort: 'medium', fastMode: false, context: 'model-default', permissions: 'bypass' }
            : {}),
        })),
    };
    await invoke(team, 'team.launch.start', `TEST-suggestion-launch-${team.key}`, {
      launchId: selection.launchId,
      rosterRevision: selection.rosterRevision,
      configuration,
    });
    const ready = await wait(async () => {
      const current = await invoke(
        team,
        'team.launch.read',
        `TEST-suggestion-progress-${team.key}`,
        {}
      );
      return current.status === 'ready' ? current : undefined;
    }, `both members ready in ${team.key}`);
    assert.equal(ready.ready, 2);
    step({
      assertion: 'original TEST setup launch reached two native ready members',
      team: team.key,
      configuration,
    });
  }
  const table = processTable();
  const hosts = table.filter(
    (item) =>
      item.pgid === options.group && command(item.pid) === `${fixture.node} ${fixture.hostEntry}`
  );
  assert.equal(hosts.length, 1);
  const hostPid = hosts[0]!.pid;
  const nativeChildren = table.filter((item) => item.ppid === hostPid);
  assert.equal(nativeChildren.length, 4, 'four actual captured native providers');
  assert.equal(
    nativeChildren.filter((item) => command(item.pid).startsWith(models.pins.executable.path))
      .length,
    2
  );
  assert.equal(
    nativeChildren.filter((item) =>
      command(item.pid).startsWith(process.env.LEGACY_DESKTOP_CLAUDE_PATH!)
    ).length,
    2
  );
  options.evidence.nativeSetup = {
    scope: 'Two canonical TEST teams, four original native providers',
    nativeChildren,
  };

  const teamFor = (actor: SuggestionActor) =>
    fixture.suggestionTeams.find((team) => team.key === actor.team)!;
  const teamDirectory = (team: SuggestionTeam) =>
    join(fixture.root, 'hoststore/teams', team.teamName);
  const humanCommands = async (team: SuggestionTeam) => {
    const directory = join(teamDirectory(team), '.host-owner/commands');
    const files = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]+\.json$/u.test(name));
    assert.ok(files.length <= 128);
    return (await Promise.all(files.map((name) => json(join(directory, name))))).filter(
      (command) =>
        command.principalId === 'TEST-human' && row(command.command).operation === 'message.send'
    );
  };
  const originals: {
    actor: SuggestionActor;
    team: SuggestionTeam;
    marker: string;
    messageId: string;
    inputId: string;
    operationRef: string;
  }[] = [];
  const totalInputs = async () =>
    (await Promise.all(fixture.suggestionTeams.map(humanCommands))).reduce(
      (total, commands) => total + commands.length,
      0
    );
  let selectedTeam: string | undefined;
  const select = async (actor: SuggestionActor) => {
    const team = teamFor(actor);
    if (await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Back to chats"]'))`))
      await ui.click(
        'button[aria-label="Back to chats"]',
        'return through original chat navigation'
      );
    if (selectedTeam !== team.key) {
      await ui.clickSidebar(team.seed.subject);
      selectedTeam = team.key;
    }
    await ui.click(
      `button[aria-label^=${desktopJsLiteral((actor.name === 'team-lead' ? 'lead' : actor.name) + ',')}]`,
      `open original ${actor.key} direct chat`
    );
    await ui.waitRead(
      `(() => {
      const state=window.__agentTeamsDevStore?.getState?.();
      return state?.selectedTeamName===${desktopJsLiteral(ownerKey(team))}&&
        state.selectedTeamData?.members?.some(member=>member.hostMemberId===${desktopJsLiteral(actor.memberId)}&&
          member.runtimeOwner==='captured-host')&&Boolean(document.querySelector(${desktopJsLiteral(editor)}));
    })()`,
      `original owner and member selected for ${actor.key}`
    );
  };
  const noOffer = async (label: string) => {
    const expression = `document.querySelector(${desktopJsLiteral(offer)})===null&&document.querySelector(${desktopJsLiteral(editor)})?.value===''`,
      initial = await ui.waitRead(expression, label);
    assert.equal(initial, true);
    // A notice is observed before React paints; check the next renderer turn too.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(await cdp.evaluate(expression), true, label);
  };
  const send = async (actor: SuggestionActor, marker: string) => {
    const team = teamFor(actor);
    await ui.click(editor, 'focus original native Composer');
    await cdp.send('Input.insertText', { text: marker });
    await ui.waitRead(
      `document.querySelector(${desktopJsLiteral(editor)})?.value===${desktopJsLiteral(marker)}`,
      'original human draft is retained'
    );
    await ui.click('button.message-composer-send-button', `send ${actor.key} input once`, 'Send');
    await ui.waitRead(
      `document.querySelector(${desktopJsLiteral(editor)})?.value===''`,
      'original Send clears the draft'
    );
    const receipt = await wait(async () => {
      const matches = (await humanCommands(team)).filter(
        (command) => row(row(command.command).payload).text === marker
      );
      assert.ok(matches.length <= 1, 'one original command per physical Send');
      return matches[0]?.phase === 'completed' ? matches[0] : undefined;
    }, `canonical ${actor.key} source command`);
    const payload = row(row(receipt.command).payload);
    assert.equal(payload.to, actor.name);
    const messageId = String(receipt.commandId);
    assert.match(messageId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    assert.equal(payload.messageId, messageId);
    assert.equal(row(receipt.effects).messageId, messageId);
    const inputId = String(row(receipt.effects).deliveryId);
    const outbox = await wait(async () => {
      const current = await json(
        join(teamDirectory(team), '.host-owner/outbox', inputId + '.json')
      );
      return current.phase === 'admitted' ? current : undefined;
    }, `original ${actor.key} delivery admitted after the completed human command`);
    assert.equal(outbox.messageId, messageId);
    assert.equal(outbox.inputId, inputId);
    assert.deepEqual(
      [
        row(outbox.binding).teamId,
        row(outbox.binding).runId,
        row(outbox.binding).memberId,
        row(outbox.binding).generation,
      ],
      [team.teamId, team.runId, actor.memberId, '1']
    );
    const input = await wait(async () => {
      const sessions = await readDesktopNativeStopSessions(fixture.root);
      const matches = sessions.filter(
        (session) =>
          row(session.binding).teamId === team.teamId &&
          row(session.binding).memberId === actor.memberId
      );
      assert.equal(matches.length, 1);
      const selected = rows(matches[0]!.inputs).filter(
        (input) => row(input.intent).inputId === inputId
      );
      assert.ok(selected.length <= 1);
      if (selected[0]?.phase !== 'terminal') return undefined;
      assert.equal(selected[0].terminal, 'succeeded');
      assert.equal(row(selected[0].intent).messageId, messageId);
      return selected[0];
    }, `successful original ${actor.key} native input`);
    assert.equal(typeof input.operationRef, 'string');
    if (actor.claude) {
      const observations = actor.claude.observations.filter((value) => value.turn === marker);
      assert.ok(
        observations.length > 0 &&
          observations.every(
            (value) =>
              value.incomingMessageId === messageId &&
              value.contextEffective &&
              value.visibleReplyContract &&
              !value.toolResultError
          )
      );
      const inbox = JSON.parse(
        await readFile(join(teamDirectory(team), 'inboxes/user.json'), 'utf8')
      ) as unknown;
      const reply = marker === 'NATIVE_TEAM_ONE' ? 'REPLY_NATIVE_ONE' : 'REPLY_NATIVE_TWO';
      assert.equal(
        rows(inbox).filter((value) => value.from === actor.name && value.text === reply).length,
        1
      );
    } else
      assert.equal(
        actor.codex!.requests.filter((value) => value.marker === marker && value.kind === 'turn')
          .length,
        1
      );
    const original = {
      actor,
      team,
      marker,
      messageId,
      inputId,
      operationRef: String(input.operationRef),
    };
    originals.push(original);
    step({
      assertion: 'independent canonical command, delivery and successful Runtime source agree',
      actor: actor.key,
      marker,
      messageId,
      inputId,
      operationRef: original.operationRef,
    });
    return original;
  };
  const notice = async (original: (typeof originals)[number]) => {
    const value = row(
      await ui.waitRead(
        `(() => {
      const notices=window.__TEST_mixedSuggestionNotices;
      const matches=Array.isArray(notices)?notices.filter(value=>value.messageId===${desktopJsLiteral(original.messageId)}):[];
      return matches.length===1?matches[0]:false;
    })()`,
        'one actual Main notice for the original human source',
        40_000
      )
    );
    const { actor, team } = original;
    assert.deepEqual(
      [
        value.ownerHandle,
        value.teamId,
        value.runId,
        value.memberId,
        value.memberName,
        value.provider,
        value.generation,
        value.conversationRef,
        value.messageId,
        value.inputId,
        value.operationRef,
      ],
      [
        ownerKey(team),
        team.teamId,
        team.runId,
        actor.memberId,
        actor.name,
        actor.provider,
        '1',
        `direct:${actor.name}`,
        original.messageId,
        original.inputId,
        original.operationRef,
      ]
    );
    assert.ok(typeof value.completedTurnRef === 'string' && value.completedTurnRef.length > 0);
    if (actor.codex) {
      assert.notEqual(value.completedTurnRef, original.operationRef);
      const samples = actor.codex.requests.filter(
        (request) => request.marker === original.marker && request.kind === 'suggestion'
      );
      assert.equal(samples.length, 1);
      assert.equal(samples[0]!.tools, 0, 'native follow-up has no model tools');
    } else {
      assert.equal(
        value.completedTurnRef,
        original.operationRef,
        'Claude SDK follow-up uses its original Host operation when no separate native turn ID exists'
      );
      const samples = actor.claude!.suggestionRequests;
      assert.ok(samples);
      assert.equal(samples.filter((request) => request.turn === original.marker).length, 1);
    }
    return value;
  };

  for (const actor of models.actors) {
    await select(actor);
    await noOffer('new actor starts with no foreign offer or draft');
    await send(actor, actor.turns[0]!);
    const original = await send(actor, actor.turns[1]!);
    const emitted = await notice(original);
    assert.equal(emitted.text, actor.suggestion);
    await ui.waitRead(
      `document.querySelector(${desktopJsLiteral(offer)})?.textContent.includes(${desktopJsLiteral(actor.suggestion)})`,
      `actual ${actor.key} native candidate is visible`
    );
    const screenshot = row(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    assert.ok(typeof screenshot.data === 'string' && screenshot.data.length > 100);
    const path = join(fixture.root, `native-suggestion-${actor.key}.png`);
    await writeFile(path, Buffer.from(screenshot.data, 'base64'), { mode: 0o600, flag: 'wx' });
    proof.screenshots.push({ actor: actor.key, path, sha256: await fileDigest(path) });
    const count = await totalInputs();
    if (actor.role === 'lead')
      await ui.click('button[aria-label="Insert"]', `accept ${actor.key} through Insert`);
    else {
      await ui.click(editor, `focus ${actor.key} original editor for Tab`);
      await key(cdp, 'Tab', 'Tab', 9);
    }
    await ui.waitRead(
      `document.querySelector(${desktopJsLiteral(editor)})?.value===${desktopJsLiteral(actor.suggestion)}&&
      !document.querySelector(${desktopJsLiteral(offer)})`,
      'native candidate inserted after original Runtime validation'
    );
    assert.equal(await totalInputs(), count, 'Insert and Tab never submit a human message');
    await clearInsertedDraft(cdp, ui);
    await noOffer('clearing the inserted draft cannot resurrect its offer');
    accepted.push({
      actor: actor.key,
      provider: actor.provider,
      role: actor.role,
      team: actor.team,
      messageId: original.messageId,
      inputId: original.inputId,
      operationRef: original.operationRef,
      completedTurnRef: emitted.completedTurnRef,
      action: actor.role === 'lead' ? 'Insert' : 'Tab',
    });
  }

  const peer = models.actors.find((actor) => actor.key === 'codex-peer')!;
  for (const boundary of ['RECIPIENT', 'TEAM'] as const) {
    await select(peer);
    const marker = `TEST_SUGGEST_CODEX_PEER_ISOLATION_${boundary}`;
    const original = await send(peer, marker);
    await wait(
      async () => (peer.codex!.held(marker) ? true : undefined),
      'actual native auxiliary request is held'
    );
    const other = models.actors.find(
      (actor) => actor.key === (boundary === 'RECIPIENT' ? 'claude-lead' : 'claude-peer')
    )!;
    await select(other);
    await noOffer('destination has no offer before actual late native completion');
    peer.codex!.release(marker);
    await notice(original);
    await noOffer(`late native notice is isolated at the ${boundary.toLowerCase()} boundary`);
    await select(peer);
    await noOffer('returning to the original recipient never replays the old event');
    isolated.push({
      boundary,
      from: peer.key,
      to: other.key,
      originalMessageId: original.messageId,
      sameMemberId: peer.memberId === other.memberId,
      sameTeam: peer.team === other.team,
    });
  }
  assert.equal(originals.length, 10);
  proof.originalHumanInputs = await totalInputs();
  assert.equal(
    proof.originalHumanInputs,
    originals.length,
    'only the ten physical Send actions admitted human commands'
  );
  const beforeStop = await readDesktopNativeStopSessions(fixture.root);
  assert.equal(beforeStop.length, 4);
  const runtimeInputs = beforeStop.flatMap((session) => rows(session.inputs));
  assert.deepEqual(
    runtimeInputs.map((input) => row(input.intent).inputId).sort(),
    originals.map((input) => input.inputId).sort(),
    'native sampling and UI acceptance created no auxiliary business input'
  );
  assert.ok(
    runtimeInputs.every((input) => input.phase === 'terminal' && input.terminal === 'succeeded')
  );
  proof.noAutoSend = true;
  for (const team of fixture.suggestionTeams) {
    await select(models.actors.find((actor) => actor.team === team.key && actor.role === 'lead')!);
    await ui.click('button[aria-label="Stop"]', `ordinary Stop for team ${team.key}`, 'Stop');
    await ui.waitRead(
      `![...document.querySelectorAll('button')].some(button=>
      button.getAttribute('aria-label')==='Stop'||button.getAttribute('aria-label')?.startsWith('Stopping'))`,
      'ordinary Stop settles before Quit'
    );
  }
  const closed = await readDesktopNativeStopSessions(fixture.root);
  assert.equal(closed.length, 4);
  assert.ok(
    closed.every((session) => session.phase === 'closed' && session.custody === 'released')
  );
  const after = processTable();
  assert.ok(
    nativeChildren.every((child) => !after.some((current) => current.pid === child.pid)),
    'all four captured native children are physically absent before original app Quit'
  );
  proof.nativeCustodyReleased = true;
  assertModels();
  for (const actor of models.actors) {
    if (actor.claude)
      assert.deepEqual(
        actor.claude.observations.map((value) => [value.turn, value.step]),
        actor.turns.flatMap((turn) => [
          [turn, 0],
          [turn, 1],
        ]),
        'each actual Claude DM has one native message_send and its successful completion'
      );
    else
      assert.equal(
        actor.codex!.requests.filter((value) => value.kind === 'turn').length,
        actor.role === 'lead' ? 2 : 4,
        'Codex sees only the original deliberate human turns'
      );
  }
  await models.pins.verify();
  proof.status = 'PASS';
  step({
    assertion:
      'all four Runtime sessions closed/released and captured native children absent before Quit',
  });
  return { hostPid, nativeChildren };
}
