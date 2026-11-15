import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { CHAT_PNG } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/chat-attachments.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort, createDesktopUiControls } from './desktop-ui-controls.ts';

type Ui = ReturnType<typeof createDesktopUiControls>;
const composer = '.message-composer-flat-layout';
const editor = `${composer} textarea`;
const offer = '[data-testid="native-next-prompt-row"]';
const filename = 'TEST-native-next-prompt-context.txt';
const attachmentFilename = 'TEST-native-next-prompt-image.png';
const contents = 'TEST private attachment and file chip; never sent to a native turn.\n';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const rawEmpty = `document.querySelector(${desktopJsLiteral(editor)})?.value===''`;

async function assertNoResurrection(cdp: UiCdpPort, ui: Ui, removedControl: string) {
  const settled = `${rawEmpty}&&!document.querySelector(${desktopJsLiteral(removedControl)})`;
  await ui.waitRead(settled, 'original removal committed and the actual editor is empty');
  // A temporarily hidden row during removal must not become a false pass.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await cdp.evaluate(`${settled}&&!document.querySelector(${desktopJsLiteral(offer)})`),
    true,
    'the old native offer stays absent after the removal render'
  );
  await ui.click(editor, 'focus the empty original editor after removing its local edit');
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      modifiers: 0,
    });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await cdp.evaluate(`${settled}&&!document.querySelector(${desktopJsLiteral(offer)})`),
    true,
    'Tab after removal cannot insert the invalidated native offer'
  );
}

/** Real file input and removal; the textarea remains empty throughout this regression. */
export async function qualifyNativeNextPromptAttachmentEdit(
  cdp: UiCdpPort,
  ui: Ui,
  options: { root: string; step(value: Record<string, unknown>): void }
) {
  assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_EDIT_GUARDS, '1');
  assert.match(basename(options.root), /^TEST-desktop-backend-/u);
  const workspace = join(options.root, 'workspace');
  assert.equal(await realpath(workspace), workspace);
  const path = join(workspace, attachmentFilename);
  await writeFile(path, Buffer.from(CHAT_PNG, 'base64'), { flag: 'wx', mode: 0o600 });
  await writeFile(join(workspace, filename), contents, { flag: 'wx', mode: 0o600 });
  assert.equal(await cdp.evaluate(rawEmpty), true);
  await ui.waitRead(
    `(() => {
    const area=document.querySelector(${desktopJsLiteral(editor)});
    const inputs=area?.closest(${desktopJsLiteral(composer)})?.querySelectorAll('input[type="file"]');
    if(!inputs||inputs.length!==1)return false;
    const attach=inputs[0].parentElement?.querySelector('button');
    return attach instanceof HTMLButtonElement&&!attach.disabled;
  })()`,
    'the captured Claude composer exposes its enabled original attachment input'
  );
  const document = row(await cdp.send('DOM.getDocument', { depth: 0 }));
  const selected = row(
    await cdp.send('DOM.querySelectorAll', {
      nodeId: row(document.root).nodeId,
      selector: `${composer} input[type="file"]`,
    })
  );
  assert.ok(Array.isArray(selected.nodeIds) && selected.nodeIds.length === 1);
  options.step({
    action: 'DOM.setFileInputFiles',
    filename: attachmentFilename,
    nativePicker: false,
    assertion: 'no plaintext draft edit precedes the real attachment change',
  });
  await cdp.send('DOM.setFileInputFiles', { nodeId: selected.nodeIds[0], files: [path] });
  const remove = `${composer} button[aria-label=${desktopJsLiteral('Remove ' + attachmentFilename)}]`;
  const previewImage = `${composer} img[alt=${desktopJsLiteral(attachmentFilename)}]`;
  await ui.waitRead(
    `${rawEmpty}&&Boolean(document.querySelector(${desktopJsLiteral(remove)}))&&
    document.querySelector(${desktopJsLiteral(previewImage)})?.complete===true&&
    !document.querySelector(${desktopJsLiteral(offer)})`,
    'completed file preparation invalidates the native offer without any text edit'
  );
  await ui.hoverExpression(
    `(() => {
    const button=document.querySelector(${desktopJsLiteral(remove)});
    const preview=button?.parentElement;if(!preview)return null;
    const r=preview.getBoundingClientRect();return r.width>0&&r.height>0?
      {x:r.x+r.width/2,y:r.y+r.height/2}:null;
  })()`,
    'hover the exact TEST attachment preview'
  );
  await ui.click(remove, 'remove only the original TEST attachment');
  await assertNoResurrection(cdp, ui, remove);
  return {
    filename: attachmentFilename,
    sha256: await fileDigest(path),
    rawTextEmptyThroughout: true,
    removal: 'original attachment Remove button',
    noResurrection: true,
  };
}

/** Existing @file control adds/removes a real inline chip; no draft/store event is fabricated. */
export async function qualifyNativeNextPromptChipEdit(
  cdp: UiCdpPort,
  ui: Ui,
  options: { root: string; step(value: Record<string, unknown>): void }
) {
  assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_EDIT_GUARDS, '1');
  const workspace = join(options.root, 'workspace'),
    path = join(workspace, filename);
  assert.equal(
    await readFile(path, 'utf8'),
    contents,
    'reuse the original TEST-owned fixture file'
  );
  assert.equal(
    await cdp.evaluate(
      `window.__agentTeamsDevStore?.getState?.().selectedTeamData?.config.projectPath`
    ),
    workspace,
    'the original saved project path owns the file suggestion lookup'
  );
  assert.equal(await cdp.evaluate(rawEmpty), true);
  await ui.click(editor, 'focus the original editor for its file mention control');
  await cdp.send('Input.insertText', { text: '@' + filename });
  await ui.waitRead(
    `!document.querySelector(${desktopJsLiteral(offer)})`,
    'ordinary mention typing owns the draft before file selection'
  );
  await ui.waitRead(
    `(() => {
    const options=[...document.querySelectorAll('[role="option"]')]
      .filter(option=>option.textContent.includes(${desktopJsLiteral(filename)}));
    return options.length===1;
  })()`,
    'original project file search finds only the TEST file'
  );
  await ui.clickExpression(
    `(() => {
    const matches=[...document.querySelectorAll('[role="option"]')]
      .filter(option=>option.textContent.includes(${desktopJsLiteral(filename)}));
    if(matches.length!==1)return null;const option=matches[0],r=option.getBoundingClientRect();
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return r.width>0&&r.height>0&&!!hit&&(hit===option||option.contains(hit))?{x,y}:null;
  })()`,
    'choose the original TEST file mention'
  );
  const chip = `${composer} button[aria-label=${desktopJsLiteral('Open ' + filename)}]`;
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(editor)})?.value===${desktopJsLiteral('📄' + filename)}&&
    document.querySelectorAll(${desktopJsLiteral(chip)}).length===1&&
    !document.querySelector(${desktopJsLiteral(offer)})`,
    'actual inline file chip is present and owns the draft'
  );
  await ui.hoverExpression(
    `(() => {
    const button=document.querySelector(${desktopJsLiteral(chip)});if(!button)return null;
    const r=button.getBoundingClientRect();return r.width>0&&r.height>0?
      {x:r.x+r.width/2,y:r.y+r.height/2}:null;
  })()`,
    'hover the exact original file chip'
  );
  // The chip's X is the adjacent sibling of its exact Open button, never an attachment control.
  await ui.click(`${chip} + button`, 'remove the original inline file chip through its own X');
  await assertNoResurrection(cdp, ui, chip);
  options.step({
    assertion: 'complete original @file chip add/remove cycle stays invalidated',
    filename,
    independentChipOnlyCounterProof: false,
  });
  return {
    filename,
    sha256: await fileDigest(path),
    path: 'original @file menu and chip X',
    independentChipOnlyCounterProof: false,
    noResurrection: true,
  };
}
