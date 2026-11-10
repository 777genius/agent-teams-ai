import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

export const mixedEditedDescription =
  'TEST original Edit Team saved once and retained after reload';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const memberSettings = (value: unknown) => {
  assert.ok(Array.isArray(value));
  return value.map(record).map(({ settingsFingerprint: _revisionToken, ...member }) => member);
};

/** Consequential Edit acceptance inside the existing mixed Create/Launch smoke, before native allocation. */
export async function runMixedEditTeamUi(
  cdp: UiCdpPort,
  options: {
    selection: string;
    handleId: string;
    before: Record<string, unknown>;
    evidence: Record<string, unknown>;
    ownerState(): Promise<Record<string, unknown>>;
    assertOwnedRenderer(): void;
    assertNoNativeInputs(): void;
    step(row: Record<string, unknown>): void;
  }
) {
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    scope:
      'Existing stopped mixed Team Detail Edit → description input → one Save → same original Host roster receipt/settings → renderer reload → same Edit hydration/Cancel; zero native inputs',
  };
  options.evidence.editTeam = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: options.step,
  });
  const readConfiguration = async () => {
    options.assertOwnedRenderer();
    const result = record(
      await cdp.evaluate(
        `window.electronAPI.agentBackend.invoke(${desktopJsLiteral({
          handle: { handleId: options.handleId },
          commandId: randomUUID(),
          operation: 'team.roster.read',
          payload: {},
        })})`
      )
    );
    assert.equal(result.ok, true, 'configuration read stays on the captured Host handle');
    return record(result.value);
  };
  const originalConfiguration = await readConfiguration();
  proof.originalRevision = originalConfiguration.revision;
  proof.originalOwner = options.before.binding;
  proof.handleId = options.handleId;
  const beforeSettings = record(options.before.savedSettings);
  const originalCommands = (options.before.rosterCommands as unknown[] | undefined) ?? [];
  await ui.scrollTo('button[aria-label="Edit team"]', 'original stopped Team Edit');
  await ui.click('button[aria-label="Edit team"]', 'open existing EditTeamDialog');
  await ui.waitRead(
    `Boolean(document.querySelector('[role="dialog"] #edit-team-name'))`,
    'existing Edit dialog opens'
  );
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #edit-team-description')?.value===${desktopJsLiteral(beforeSettings.description ?? '')}`,
    'original configured description hydrates'
  );
  const unchangedName = await cdp.evaluate(
    `document.querySelector('[role="dialog"] #edit-team-name')?.value`
  );
  assert.equal(typeof unchangedName, 'string');
  await ui.scrollTo('[role="dialog"] #edit-team-description', 'original Edit description');
  await ui.click('[role="dialog"] #edit-team-description', 'focus existing Edit description');
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    commands: ['selectAll'],
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.insertText', { text: mixedEditedDescription });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #edit-team-description')?.value===${desktopJsLiteral(mixedEditedDescription)}`,
    'typed description remains in the original control'
  );
  options.assertNoNativeInputs();
  await ui.scrollTo('[role="dialog"] button', 'existing Edit Save', 'Save');
  await ui.click('[role="dialog"] button', 'save original Edit intent once', 'Save');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #edit-team-name')`,
    'original Edit closes after its save',
    90_000
  );
  const after = await options.ownerState();
  assert.deepEqual(after.binding, options.before.binding, 'Edit cannot rebind the existing owner');
  assert.deepEqual(
    after.members,
    options.before.members,
    'description edit preserves exact saved member IDs/provider choices'
  );
  assert.deepEqual(
    after.runtimeCaptures ?? [],
    [],
    'Edit never allocates or captures native execution'
  );
  const expectedSettings = {
    ...beforeSettings,
    displayName: unchangedName,
    description: mixedEditedDescription,
    color: beforeSettings.color ?? '',
  };
  assert.deepEqual(
    after.savedSettings,
    expectedSettings,
    'existing choices and explicit false/off survive the single owner save'
  );
  const commands = (after.rosterCommands as unknown[]).map(record);
  assert.equal(
    commands.length,
    originalCommands.length + 1,
    'one original Save creates exactly one roster receipt'
  );
  assert.deepEqual(commands.slice(0, originalCommands.length), originalCommands);
  const configuration = await readConfiguration();
  assert.deepEqual(configuration.savedSettings, expectedSettings);
  assert.notEqual(configuration.revision, originalConfiguration.revision);
  assert.equal(commands.at(-1)!.revision, configuration.revision);
  assert.deepEqual(
    memberSettings(configuration.members),
    memberSettings(originalConfiguration.members),
    'owner-issued member identity/settings remain unchanged apart from revision tokens'
  );
  options.assertNoNativeInputs();
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'real renderer reload after Edit save',
    90_000
  );
  await ui.observeInput();
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
    'original menu after Edit reload',
    90_000
  );
  await ui.click('button[aria-label="More actions"]', 'open original menu after Edit reload');
  await ui.click('button', 'open original Teams list after Edit reload', 'Teams');
  const card = `[data-team-name=${JSON.stringify(options.selection)}]`;
  await ui.scrollTo(card, 'same original Host Team after Edit reload');
  await ui.click(card, 'open original Host Team after Edit reload');
  await ui.scrollTo('button[aria-label="Edit team"]', 'same existing Team Edit after reload');
  await ui.click('button[aria-label="Edit team"]', 'reopen existing EditTeamDialog after reload');
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #edit-team-description')?.value===${desktopJsLiteral(mixedEditedDescription)}`,
    'saved description persists in the same Edit dialog'
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[role="dialog"] #edit-team-name')?.value`),
    unchangedName
  );
  await ui.scrollTo('[role="dialog"] button', 'original unchanged Edit Cancel', 'Cancel');
  await ui.click('[role="dialog"] button', 'close reopened Edit without another save', 'Cancel');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #edit-team-name')`,
    'reopened Edit closes without an effect'
  );
  assert.deepEqual(
    await options.ownerState(),
    after,
    'reload/reopen/Cancel do not write a second roster intent'
  );
  assert.deepEqual(
    await readConfiguration(),
    configuration,
    'saved owner revision remains exact after reload'
  );
  options.assertNoNativeInputs();
  Object.assign(proof, {
    status: 'PASS',
    description: mixedEditedDescription,
    originalRevision: originalConfiguration.revision,
    revision: configuration.revision,
    receipt: commands.at(-1),
    savedSettings: configuration.savedSettings,
    originalOwner: after.binding,
    settingsRetainedAfterReload: true,
    noNativeCapture: true,
  });
  return { proof, state: after };
}
