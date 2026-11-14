import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { effectId } from '../../packages/legacy-agent-host/dist/team/identity.js';
import {
  COMMAND_ARGS,
  COMPACT_AUTHORIZATION,
  REVIEW_ARGS,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-compaction/model.ts';
import {
  NATIVE_COMMAND_UI_REPLY,
  NATIVE_COMMAND_UI_REPLY_ID,
  NATIVE_REVIEW_UI_REPLY,
  NATIVE_REVIEW_UI_REPLY_ID,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-commands/model.ts';
import { sanitizeDisplayContent } from '../../src/shared/utils/contentSanitizer.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { nativeCommandUiState } from './desktop-native-commands-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const rows = (value: unknown) => {
  assert.ok(Array.isArray(value));
  return value.map(record);
};

/** TEST-only reuse of the exact native suggestion → original Composer Send path. */
export async function sendDesktopNativeCommandFromComposer(
  cdp: UiCdpPort,
  ui: ReturnType<typeof createDesktopUiControls>,
  name: string,
  args: string,
  inspectCatalog: (catalog: readonly unknown[]) => void
): Promise<string> {
  const raw = '/' + name + (args ? ' ' + args : '');
  await ui.click('.message-composer-flat-layout textarea', 'focus original lead Composer');
  assert.equal(
    await cdp.evaluate(`document.querySelector('.message-composer-flat-layout textarea')?.value`),
    ''
  );
  await cdp.send('Input.insertText', { text: '/' });
  const catalog = await ui.waitRead(
    `(() => { const names=[...document.querySelectorAll('[role="listbox"] [role="option"] .font-medium')].map(e=>e.textContent.trim()); return names.includes(${desktopJsLiteral('/' + name)})?names:null; })()`,
    'captured native command suggestions'
  );
  assert.ok(Array.isArray(catalog));
  inspectCatalog(catalog);
  const target = `(() => {const rows=[...document.querySelectorAll('[role="listbox"] [role="option"]')].filter(e=>e.querySelector('.font-medium')?.textContent.trim()===${desktopJsLiteral('/' + name)});if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y,tag:e.tagName}:null;})()`;
  await ui.clickExpression(target, 'choose actual native /' + name);
  const selected = await cdp.evaluate(
    `document.querySelector('.message-composer-flat-layout textarea')?.value`
  );
  assert.equal(typeof selected, 'string');
  assert.equal(String(selected).trim(), '/' + name);
  if (args)
    await cdp.send('Input.insertText', {
      text: (String(selected).endsWith(' ') ? '' : ' ') + args,
    });
  await ui.waitRead(
    `document.querySelector('.message-composer-flat-layout textarea')?.value.trim()===${desktopJsLiteral(raw)}`,
    'selected command retains exact arguments'
  );
  await ui.click(
    'button.message-composer-send-button',
    'Send original /' + name + ' once',
    'Send'
  );
  await ui.waitRead(
    `document.querySelector('.message-composer-flat-layout textarea')?.value===''`,
    'command admission clears Composer'
  );
  return raw;
}

/** Called after the existing Launch turn and before its Stop; every send comes from actual Composer controls. */
export async function runDesktopNativeCommandsUiProof(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { subject: string };
    session: Row;
    model: {
      observations: readonly unknown[];
      commandRequests: readonly unknown[];
      failures: readonly string[];
    };
    evidence: Row;
    assertOwnedRenderer(): void;
  }
) {
  const { root, model } = options;
  assert.equal(process.env.LEGACY_DESKTOP_COMMANDS_UI, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'native-launch-ui');
  assert.match(root, /\/TEST-desktop-backend-[^/]+$/);
  const binding = record(options.session.binding),
    bindingKey = runtimeDigest(binding);
  const { backendId, teamId } = binding;
  assert.ok(typeof backendId === 'string' && backendId.length > 0);
  assert.ok(typeof teamId === 'string' && teamId.length > 0);
  assert.equal(binding.memberId, 'alice-id');
  assert.equal(model.observations.length, 8, 'existing actual Launch has completed');
  assert.equal(model.commandRequests.length, 0);
  const steps: Row[] = [],
    step = (value: Row) => steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  const proof: Row = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Actual lead command suggestions, original Composer Send, native compact/cost/skill, visible replies and renderer reload',
    excluded: [
      'vendor authentication/inference',
      'cold Host recovery (separate native fixture)',
      'plugin command',
      'other providers',
    ],
    sourceSha256: await fileDigest(import.meta.filename),
  };
  options.evidence.nativeCommandsUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const team = join(root, 'hoststore/teams/test-desktop-backend');
  const commandRows = async () => {
    const directory = join(team, '.host-owner/commands');
    const files = (await readdir(directory))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .sort();
    assert.ok(files.length <= 128);
    return Promise.all(files.map(async (name) => record(await json(join(directory, name)))));
  };
  const session = async () => {
    const found = (await readDesktopNativeStopSessions(root)).filter(
      (row) => runtimeDigest(row.binding) === bindingKey
    );
    assert.equal(found.length, 1);
    return found[0]!;
  };
  const events = async () =>
    rows(record(await json(join(root, 'hoststore/runtime-events', `${bindingKey}.json`))).events);
  const inbox = async () => rows(await json(join(team, 'inboxes/user.json')));
  const owner = async () => record(await json(join(team, '.host-owner/state.json')));
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, []);
      const value = await read();
      if (accept(value)) return value;
      assert.ok(Date.now() < deadline, label + '; the original mutation is never repeated');
      await new Promise<void>((done) => setTimeout(done, 100));
    }
  };
  const screenshot = async (name: string) => {
    options.assertOwnedRenderer();
    const value = record(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    assert.equal(typeof value.data, 'string');
    const path = join(root, name);
    await writeFile(path, Buffer.from(String(value.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const commands: { commandId: string; inputId: string; operationRef: unknown; name: string }[] =
    [];
  await ui.observeInput();
  await ui.waitRead(
    `Boolean(document.querySelector('.message-composer-flat-layout textarea'))`,
    'original lead Composer'
  );

  const send = async (name: string, args = '') => {
    const before = new Set((await commandRows()).map((row) => row.commandId));
    const raw = await sendDesktopNativeCommandFromComposer(cdp, ui, name, args, catalog => {
      for (const required of [
        '/compact',
        '/cost',
        '/review',
        '/test-project-command',
        '/test-user-command',
      ])
        assert.ok(catalog.includes(required));
      for (const excluded of ['/test-hidden-command', '/model', '/effort', '/fast', '/clear'])
        assert.equal(catalog.includes(excluded), false);
      proof.catalog = catalog;
    });
    const original = await poll(
      commandRows,
      (entries) =>
        entries.some(
          (row) =>
            !before.has(row.commandId) &&
            row.principalId === 'TEST-human' &&
            record(row.command).operation === 'message.send' &&
            String(record(record(row.command).payload).text).trim() === raw
        ),
      'original UI command receipt'
    );
    const matches = original.filter(
      (row) =>
        !before.has(row.commandId) &&
        row.principalId === 'TEST-human' &&
        record(row.command).operation === 'message.send' &&
        String(record(record(row.command).payload).text).trim() === raw
    );
    assert.equal(matches.length, 1);
    const receipt = matches[0]!,
      payload = record(record(receipt.command).payload);
    assert.equal(receipt.phase, 'completed');
    assert.equal(payload.to, 'alice');
    assert.equal(payload.nativeCommand, true);
    assert.equal(payload.messageId, receipt.commandId);
    const inputId = String(record(receipt.effects).deliveryId);
    const completed = await poll(
      session,
      (value) =>
        rows(value.inputs).some(
          (row) => record(row.intent).inputId === inputId && row.phase === 'terminal'
        ),
      'exact native command terminal'
    );
    const input = rows(completed.inputs).find((row) => record(row.intent).inputId === inputId)!;
    assert.equal(input.terminal, 'succeeded');
    assert.equal(record(input.intent).content, raw);
    assert.equal(input.preparation, undefined, 'native slash is not prefixed with a Team reminder');
    const outbox = record(await json(join(team, '.host-owner/outbox', inputId + '.json')));
    assert.equal(outbox.content, raw);
    assert.equal(outbox.messageId, receipt.commandId);
    const originalIdentity = {
      commandId: String(receipt.commandId),
      inputId,
      operationRef: input.operationRef,
      name,
    };
    commands.push(originalIdentity);
    step({ assertion: 'original UI/native command identity', ...originalIdentity });
    return originalIdentity;
  };
  const costReplies: Row[] = [];
  const cost = async () => {
    const modelCount = model.commandRequests.length;
    const original = await send('cost');
    const commandId = `native-command-output-${runtimeDigest({ binding, inputId: original.inputId })}`;
    const replies = await poll(
      inbox,
      (values) => values.some((row) => row.messageId === commandId),
      'exact native local output published to original Team'
    );
    const reply = replies.find((row) => row.messageId === commandId)!;
    assert.equal(reply.from, 'alice');
    assert.equal(reply.summary, '/cost');
    assert.ok(typeof reply.text === 'string' && reply.text.length > 0);
    const local = (await events()).filter(
      (event) =>
        event.inputId === original.inputId &&
        event.operationRef === original.operationRef &&
        record(event.data).kind === 'text' &&
        String(record(event.data).messageRef).startsWith('local-command:')
    );
    assert.equal(local.length, 1);
    assert.equal(record(local[0]!.data).text, reply.text);
    assert.equal(model.observations.length, 8);
    assert.equal(model.commandRequests.length, modelCount, '/cost makes no model request');
    const display = sanitizeDisplayContent(reply.text);
    assert.ok(display.length > 0, 'actual output is available for display');
    const originalRows = `[...document.querySelectorAll('[data-timeline-row-key]')].filter(e=>e.getAttribute('data-timeline-row-key')===${desktopJsLiteral(commandId)})`;
    const visible = `(() => {const rows=${originalRows};return rows.length===1&&rows[0].innerText.replace(/\\s+/g,' ').trim().includes(${desktopJsLiteral(display.replace(/\s+/g, ' ').trim())});})()`;
    await ui.waitRead(visible, 'actual local command output appears in the conversation');
    const cardRead = (body: string) => `(() => {
      const rows=${originalRows};if(rows.length!==1)return null;
      const cards=[...rows[0].querySelectorAll('article.activity-timeline-card')].filter(e=>
        e.textContent.replace(/\\s+/g,' ').trim().includes(${desktopJsLiteral(display.replace(/\s+/g, ' ').trim())}));
      if(cards.length!==1)return null;const card=cards[0];${body}
    })()`;
    options.assertOwnedRenderer();
    const expanded = await cdp.evaluate(cardRead('return card.getAttribute("data-expanded");'));
    assert.ok(expanded === 'true' || expanded === 'false', 'one exact native cost report card');
    if (expanded === 'false') {
      await ui.clickExpression(cardRead(`
        if(card.getAttribute('data-expanded')!=='false')return null;
        const e=card.firstElementChild;if(e?.getAttribute('role')!=='button')return null;
        const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y,tag:e.tagName}:null;
      `), 'expand exact native cost reply once');
      await ui.waitRead(cardRead('return card.getAttribute("data-expanded")==="true";'),
        'original native cost report card expanded');
    }
    await revealDesktopReply(cdp, display, {
      messageId: commandId,
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
    });
    costReplies.push({
      commandId,
      inputId: original.inputId,
      nativeMessageRef: record(local[0]!.data).messageRef,
      text: reply.text,
    });
  };

  await cost();
  await writeFile(nativeCommandUiState(root), JSON.stringify({ phase: 'compact' }), {
    mode: 0o600,
  });
  const compact = await send('compact', COMPACT_AUTHORIZATION);
  const boundary = (await events()).filter(
    (event) =>
      event.inputId === compact.inputId &&
      event.operationRef === compact.operationRef &&
      record(event.data).kind === 'compaction'
  );
  assert.equal(boundary.length, 1);
  assert.equal(record(boundary[0]!.data).reason, 'manual');
  const epochs = rows((await owner()).contextEpochs);
  assert.equal(epochs.length, 1);
  assert.equal(epochs[0]!.represented, undefined);
  await cost();
  assert.equal(
    rows((await owner()).contextEpochs)[0]!.represented,
    undefined,
    'local /cost preserves the pending Team reminder'
  );
  for (const selected of [
    {
      phase: 'project-command',
      name: 'test-project-command',
      args: COMMAND_ARGS,
      replyId: NATIVE_COMMAND_UI_REPLY_ID,
      reply: NATIVE_COMMAND_UI_REPLY,
    },
    {
      phase: 'review',
      name: 'review',
      args: REVIEW_ARGS,
      replyId: NATIVE_REVIEW_UI_REPLY_ID,
      reply: NATIVE_REVIEW_UI_REPLY,
    },
  ] as const) {
    await writeFile(nativeCommandUiState(root), JSON.stringify({ phase: selected.phase }), {
      mode: 0o600,
    });
    const original = await send(selected.name, selected.args);
    const replies: Row[] = (await inbox()).filter(
      (row) => row.messageId === effectId('message', backendId, teamId, selected.replyId)
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.text, selected.reply);
    await ui.waitRead(
      `document.body.innerText.includes(${desktopJsLiteral(selected.reply)})`,
      'actual native /' + selected.name + ' MCP reply visible'
    );
    await revealDesktopReply(cdp, selected.reply, {
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
    });
    if (selected.phase === 'review')
      proof.builtinReview = {
        ...original,
        exactArguments: selected.args,
        replyId: selected.replyId,
      };
  }
  assert.deepEqual(
    model.commandRequests.map((value) => record(value).phase),
    ['compact', 'project-command', 'project-command', 'review', 'review']
  );
  await writeFile(nativeCommandUiState(root), JSON.stringify({ phase: 'idle' }), {
    mode: 0o600,
  });
  proof.screenshot = await screenshot('ui-native-command-output.png');
  const before = {
    inputs: (await session()).inputs,
    commands: await commandRows(),
    inbox: await inbox(),
    nativeRequests: model.commandRequests.length,
  };
  const oldOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(oldOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'original renderer reload'
  );
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button[aria-label^="alice,"]', 'open same lead conversation after reload');
  await ui.waitRead(
    `document.body.innerText.includes(${desktopJsLiteral(NATIVE_REVIEW_UI_REPLY)})`,
    'same native review reply after reload'
  );
  assert.deepEqual((await session()).inputs, before.inputs);
  assert.deepEqual(await commandRows(), before.commands);
  assert.deepEqual(await inbox(), before.inbox);
  assert.equal(model.commandRequests.length, before.nativeRequests);
  assert.equal(model.observations.length, 8);
  assert.deepEqual(model.failures, []);
  const sources = record(await json(join(root, 'native-commands-ui-sources.json')));
  for (const source of rows(sources.sources))
    assert.equal(await fileDigest(String(source.path)), source.sha256);
  proof.status = 'PASS';
  proof.commands = commands;
  proof.localReplies = costReplies;
  proof.compaction = boundary[0];
  proof.commandRequests = model.commandRequests;
  proof.originalIdsRetainedAfterReload = true;
  proof.noReplayAfterReload = true;
  proof.sourcesUnchanged = true;
}
