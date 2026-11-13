import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { readNativePlugins } from '../../packages/legacy-agent-host/dist/extensions/readNativeExtensionState.js';
import {
  EXTENSION_USER_SKILL, EXTENSION_PROJECT_SKILL, extensionReply, extensionReplyId,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-extensions/model.ts';
import { nativeExtensionUiSources, nativeExtensionUiState } from './desktop-native-extension-consumption-fixture.ts';
import type { NativeExtensionSources } from './desktop-native-extension-consumption-fixture.ts';
import type { NativeExtensionProofSelection } from './desktop-native-extensions-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { sendDesktopNativeCommandFromComposer } from './desktop-native-commands-ui-proof.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const rows = (value: unknown) => {
  assert.ok(Array.isArray(value));
  return value.map(record);
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
type Model = { observations: readonly unknown[]; extensionRequests: readonly unknown[]; failures: readonly string[] };
type Options = { root: string; session: Row; model: Model; evidence: Row; assertOwnedRenderer(): void };

/** The only product dispatch is the reused actual Composer suggestion/Send path. */
export async function runDesktopNativeExtensionCommandsUi(cdp: UiCdpPort, options: Options): Promise<Row> {
  const { root, model } = options;
  assert.equal(model.observations.length, 8);
  assert.equal(model.extensionRequests.length, 0);
  const sources = await json(nativeExtensionUiSources(root)) as NativeExtensionSources;
  const binding = record(options.session.binding), bindingKey = runtimeDigest(binding);
  assert.equal(binding.memberId, 'alice-id');
  const steps: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', steps, namespaceSha256: sources.namespaceSha256,
    firstBinding: binding, installedPlugin: sources.plugin };
  options.evidence.nativeExtensionConsumption = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value),
  });
  const team = join(root, 'hoststore/teams/test-desktop-backend');
  const commandRows = async () => {
    const directory = join(team, '.host-owner/commands');
    const names = (await readdir(directory)).filter(name => /^[A-Za-z0-9_-]+\.json$/u.test(name));
    assert.ok(names.length <= 128);
    return Promise.all(names.sort().map(async name => record(await json(join(directory, name)))));
  };
  const currentSession = async () => {
    const selected = (await readDesktopNativeStopSessions(root))
      .filter(row => runtimeDigest(row.binding) === bindingKey);
    assert.equal(selected.length, 1);
    return selected[0]!;
  };
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const until = Date.now() + 60_000;
    for (;;) {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, []);
      const value = await read();
      if (accept(value)) return value;
      assert.ok(Date.now() < until, label + '; original Send is never repeated');
      await new Promise<void>(done => setTimeout(done, 100));
    }
  };
  const originalInputs = rows(options.session.inputs);
  assert.equal(originalInputs.length, 1);
  const commands: Row[] = [], receipts: Row[] = [];
  await ui.observeInput();
  for (const [index, phase] of (['user-skill', 'project-skill', 'plugin'] as const).entries()) {
    const selected = sources.invocations[phase];
    await writeFile(nativeExtensionUiState(root), JSON.stringify({ phase }), { mode: 0o600 });
    const before = new Set((await commandRows()).map(row => row.commandId));
    const raw = await sendDesktopNativeCommandFromComposer(cdp, ui, selected.name, selected.args, catalog => {
      for (const invocation of Object.values(sources.invocations))
        assert.ok(catalog.includes('/' + invocation.name), 'actual Query exposes each installed source');
      proof.nativeCatalogBefore = catalog;
    });
    const accepted = await poll(commandRows, entries => entries.some(row => !before.has(row.commandId) &&
      row.phase === 'completed' && row.principalId === 'TEST-human' && record(row.command).operation === 'message.send' &&
      record(record(row.command).payload).text === raw), 'exact original UI receipt');
    const matches = accepted.filter(row => !before.has(row.commandId) && row.principalId === 'TEST-human' &&
      record(row.command).operation === 'message.send' && record(record(row.command).payload).text === raw);
    assert.equal(matches.length, 1);
    const receipt = matches[0]!, payload = record(record(receipt.command).payload);
    assert.equal(receipt.phase, 'completed');
    assert.equal(payload.to, 'alice');
    assert.equal(payload.nativeCommand, true);
    assert.equal(payload.messageId, receipt.commandId);
    const inputId = String(record(receipt.effects).deliveryId);
    const terminal = await poll(currentSession, value => rows(value.inputs).some(input =>
      record(input.intent).inputId === inputId && input.phase === 'terminal'), 'native command terminal');
    const inputs = rows(terminal.inputs);
    assert.equal(inputs.length, index + 2, 'one native input per original marked Send');
    const input = inputs.find(value => record(value.intent).inputId === inputId)!;
    assert.equal(input.terminal, 'succeeded');
    assert.equal(record(input.intent).content, raw);
    assert.equal(input.preparation, undefined);
    assert.deepEqual(inputs[0], originalInputs[0]);
    const outbox = record(await json(join(team, '.host-owner/outbox', inputId + '.json')));
    assert.equal(outbox.content, raw);
    assert.equal(outbox.messageId, receipt.commandId);
    const replies = rows(await json(join(team, 'inboxes/user.json')))
      .filter(row => row.messageId === extensionReplyId(phase));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.from, 'alice');
    assert.equal(replies[0]!.text, extensionReply(phase));
    assert.equal(model.extensionRequests.length, (index + 1) * 2);
    await ui.waitRead('document.body.innerText.includes(' + desktopJsLiteral(extensionReply(phase)) + ')',
      'actual native ' + phase + ' reply is visible');
    await revealDesktopReply(cdp, extensionReply(phase), {
      assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value),
    });
    commands.push({ phase, commandId: receipt.commandId, inputId, operationRef: input.operationRef,
      sourceSha256: selected.sourceSha256, replyId: extensionReplyId(phase) });
    receipts.push(receipt);
  }
  await writeFile(nativeExtensionUiState(root), JSON.stringify({ phase: 'idle' }), { mode: 0o600 });
  assert.equal(model.observations.length, 8);
  assert.deepEqual(model.failures, []);
  const finalSession = await currentSession();
  proof.commands = commands;
  proof.originalCommandReceipts = receipts;
  proof.firstInputs = finalSession.inputs;
  proof.nativeRequests = [...model.extensionRequests];
  proof.firstQueryConsumedSources = true;
  return finalSession;
}

/** A genuinely new Query after completed Uninstall, with no attempted stale command dispatch. */
export async function verifyDesktopNativeExtensionsAfterUninstall(cdp: UiCdpPort, options: Options): Promise<void> {
  const { root, model } = options;
  const proof = record(options.evidence.nativeExtensionConsumption);
  const sources = await json(nativeExtensionUiSources(root)) as NativeExtensionSources;
  const selected = await json(join(root, 'native-extensions-selection.json')) as NativeExtensionProofSelection;
  assert.equal(proof.firstQueryConsumedSources, true);
  assert.notEqual(runtimeDigest(options.session.binding), runtimeDigest(proof.firstBinding));
  assert.equal(model.observations.length, 11);
  assert.equal(model.extensionRequests.length, 6);
  assert.deepEqual(readNativePlugins(selected.profile, true, () => {}).entries
    .filter(row => row.pluginId === sources.plugin.id), []);
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer, step: row => { assert.ok(Array.isArray(proof.steps)); proof.steps.push(row); },
  });
  assert.equal(await cdp.evaluate('document.querySelector(".message-composer-flat-layout textarea")?.value'), '');
  await ui.click('.message-composer-flat-layout textarea', 'inspect the new Query command inventory');
  await cdp.send('Input.insertText', { text: '/' });
  const catalog = await ui.waitRead('(() => {const names=[...document.querySelectorAll(\'[role="listbox"] [role="option"] .font-medium\')]' +
    '.map(e=>e.textContent.trim());return names.includes(' + desktopJsLiteral('/' + EXTENSION_USER_SKILL) +
    ')&&names.includes(' + desktopJsLiteral('/' + EXTENSION_PROJECT_SKILL) + ')?names:null;})()',
    'new native Query retains both user/project skills');
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.includes('/' + sources.invocations.plugin.name), false,
    'removed plugin cannot be selected from a stale suggestion');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
    modifiers: 4, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
  await ui.waitRead('document.querySelector(".message-composer-flat-layout textarea")?.value===\'\'',
    'inventory inspection clears without Send');
  const first = (await readDesktopNativeStopSessions(root))
    .filter(row => runtimeDigest(row.binding) === runtimeDigest(proof.firstBinding));
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]!.inputs, proof.firstInputs);
  const commandDirectory = join(root, 'hoststore/teams/test-desktop-backend/.host-owner/commands');
  const files = (await readdir(commandDirectory)).filter(name => /^[A-Za-z0-9_-]+\.json$/u.test(name));
  assert.ok(files.length <= 128);
  const current = await Promise.all(files.map(async name => record(await json(join(commandDirectory, name)))));
  for (const receipt of rows(proof.originalCommandReceipts))
    assert.deepEqual(current.find(row => row.commandId === receipt.commandId), receipt);
  for (const phase of ['user-skill', 'project-skill'] as const)
    assert.equal(await fileDigest(sources.invocations[phase].sourcePath), sources.invocations[phase].sourceSha256);
  assert.equal(await fileDigest(selected.neighborPath), selected.neighborSha256);
  assert.equal(model.extensionRequests.length, 6);
  assert.equal(model.observations.length, 11);
  assert.deepEqual(model.failures, []);
  proof.nativeCatalogAfter = catalog;
  proof.secondBinding = options.session.binding;
  proof.sameNamespaceSha256 = sources.namespaceSha256;
  proof.originalCommandsRetained = true;
  proof.noReplayAfterUninstall = true;
  proof.uninstalledPluginAbsentFromNewQuery = true;
}
