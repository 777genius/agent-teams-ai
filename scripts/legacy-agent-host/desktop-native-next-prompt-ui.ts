import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { desktopJsLiteral } from './desktop-ui-controls.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { qualifyNativeNextPromptAttachmentEdit, qualifyNativeNextPromptChipEdit } from './desktop-native-next-prompt-edit-guards-ui.ts';

import type { UiCdpPort, createDesktopUiControls } from './desktop-ui-controls.ts';

type Ui = ReturnType<typeof createDesktopUiControls>;
export type NativeNextPromptUiTurn =
  'NATIVE_TEAM_TWO' | 'NATIVE_TEAM_THREE' | 'NATIVE_TEAM_FOUR' | 'NATIVE_TEAM_FIVE' |
  'NATIVE_TEAM_SIX' | 'NATIVE_TEAM_SEVEN' | 'NATIVE_TEAM_EIGHT';

// Real SDK generation may filter machine-like markers; use genuine user phrasing.
const expectedPrompt = (turn: NativeNextPromptUiTurn) =>
  turn === 'NATIVE_TEAM_TWO' ? 'Review the completed tests and open a PR' :
    turn === 'NATIVE_TEAM_THREE' ? 'Summarize the changes and check for regressions.' :
      turn === 'NATIVE_TEAM_FOUR' ? 'Verify the final results and prepare a report.' :
        turn === 'NATIVE_TEAM_FIVE' ? 'Check the final report and summarize the remaining work.' :
          turn === 'NATIVE_TEAM_SIX' ? 'Review the attachment changes and verify the result.' :
            turn === 'NATIVE_TEAM_SEVEN' ? 'Review the referenced file and summarize the result.' :
              'Review the current action mode and verify the result.';

/** Actual CDP keyboard interaction; never assign a controlled draft through DOM evaluation. */
async function key(cdp: UiCdpPort, name: string, code: string, virtual: number, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: name, code,
    windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: name, code,
    windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers,
  });
}

async function clearInsertedDraft(cdp: UiCdpPort, ui: Ui) {
  // The Insert button receives focus on click. Return focus to the actual editor
  // before physical Command+A/Backspace; never mutate React's draft via JS.
  await ui.click('.message-composer-flat-layout textarea', 'focus original editor for physical clear');
  await key(cdp, 'a', 'KeyA', 65, 4);
  await key(cdp, 'Backspace', 'Backspace', 8);
  await ui.waitRead(
    "document.querySelector('.message-composer-flat-layout textarea')?.value === ''",
    'ordinary editor is empty after physical clear',
  );
}

/** Shift+Tab belongs to the existing action-mode shortcut, not browser focus navigation. */
async function qualifyActionModeShiftTab(cdp: UiCdpPort, ui: Ui, visibleOffer: boolean) {
  const selector = '.message-composer-flat-layout .message-composer-action-modes';
  type ModeState = {
    modes: string[]; mode: string; empty: boolean; focused: boolean; offer: boolean;
  };
  const readState = `(() => {
    const groups=[...document.querySelectorAll(${desktopJsLiteral(selector)})];
    const editor=document.querySelector('.message-composer-flat-layout textarea');
    if(groups.length!==1||!editor)return null;
    const radios=[...groups[0].querySelectorAll('button[role="radio"]')];
    const selected=radios.filter(radio=>radio.getAttribute('aria-checked')==='true');
    if(selected.length!==1||radios.some(radio=>radio.disabled||!radio.getClientRects().length))return null;
    return {modes:radios.map(radio=>radio.textContent.trim()),mode:selected[0].textContent.trim(),
      empty:editor.value==='',focused:document.activeElement===editor,
      offer:!!document.querySelector('[data-testid="native-next-prompt-row"]')};
  })()`;
  const before = await ui.waitRead(readState, 'original selected action mode') as ModeState;
  assert.deepEqual(before.modes, before.modes.includes('Delegate')
    ? ['Do', 'Ask', 'Delegate'] : ['Do', 'Ask']);
  assert.ok(before.empty && before.focused, 'physical shortcut starts in the empty original editor');
  assert.equal(before.offer, visibleOffer, 'the shortcut starts with the expected real offer state');
  const nextMode = before.modes[(before.modes.indexOf(before.mode) + 1) % before.modes.length];
  assert.ok(typeof nextMode === 'string' && nextMode !== before.mode);
  const waitMode = async (mode: string, label: string) => {
    const value = await ui.waitRead(readState, label, 30_000, value => {
      const state = value as ModeState | null;
      return Boolean(state?.mode === mode && state.empty && state.focused && !state.offer);
    }) as ModeState;
    assert.deepEqual(value.modes, before.modes, 'the original action modes remain available');
    return value;
  };
  await key(cdp, 'Tab', 'Tab', 9, 8);
  const after = await waitMode(nextMode,
    'Shift+Tab cycles the original mode, refocuses the empty editor and invalidates any offer');
  await ui.click(selector + ' button[role="radio"]',
    'restore original action mode through its existing radio', before.mode);
  const restored = await waitMode(before.mode, 'original action mode restored without inserting text');
  // Observe a later renderer turn after mode restoration, not just a transient hidden row.
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  const settled = await cdp.evaluate(readState) as ModeState | null;
  assert.ok(settled?.mode === before.mode && settled.empty && settled.focused && !settled.offer,
    'restoring the original mode cannot resurrect or insert the invalidated offer');
  return { beforeMode: before.mode, nextMode: after.mode, restoredMode: restored.mode,
    visibleOffer: before.offer, draftStayedEmpty: true, offerAbsentAfterRestore: true };
}

/** Change the real isolated app through its existing Appearance and layout controls. */
export async function prepareNativeNextPromptImeUi(cdp: UiCdpPort, ui: Ui): Promise<void> {
  await ui.click('button[aria-label="More actions"]', 'open ordinary application menu');
  await ui.click('button', 'open ordinary Settings', 'Settings');
  await ui.click('[data-testid="settings-nav-appearance"]', 'open Appearance settings');
  await ui.click('[data-testid="appearance-theme-light"]', 'select actual Light theme');
  await ui.waitRead(`window.electronAPI.config.get().then(config =>
    config.general.theme === 'light' && document.documentElement.classList.contains('light'))`,
  'Light theme persisted through original config IPC');
  await key(cdp, 'w', 'KeyW', 87, 4);
  await ui.waitRead("Boolean(document.querySelector('.message-composer-flat-layout textarea'))",
    'closing Settings restores the original conversation');
  const inline = await cdp.evaluate(`Boolean([...document.querySelectorAll(
    'button[aria-label="Move messages to bottom sheet"]')].find(button => button.getClientRects().length))`);
  if (inline) {
    await ui.click('button[aria-label="Move messages to bottom sheet"]', 'open actual bottom sheet');
  } else {
    await ui.click('button[aria-label="Message panel actions"]', 'open ordinary message layout menu');
    await ui.click('[role="menuitem"]', 'select actual bottom sheet', 'Move to bottom sheet');
  }
  await ui.waitRead('Boolean(document.querySelector(\'[data-messages-thread-layout="wide"] textarea\'))',
    'bottom sheet uses original compact composer');
  // Its initial snap is composer-only. Physically expand the existing sheet so
  // the same canonical native reply remains visible above the compact editor.
  const gripExpression = `(() => {
    const button=document.querySelector('button[aria-label="Message bottom sheet actions"]');
    const header=button?.closest('.relative.h-10');
    if(!header)return null;const rect=header.getBoundingClientRect();
    const x=rect.x+rect.width/2,y=rect.y+8,hit=document.elementFromPoint(x,y);
    return rect.width>0&&rect.top>=0&&rect.bottom<=innerHeight&&
      !!hit&&(hit===header||header.contains(hit))?{x,y}:null;
  })()`;
  await ui.hoverExpression(gripExpression, 'stable original sheet drag handle');
  const grip = await ui.waitRead(gripExpression, 'original sheet drag origin') as { x: number; y: number };
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...grip, button: 'left', buttons: 1, clickCount: 1,
  });
  const endY = Math.min(grip.y, 96);
  for (let index = 1; index <= 8; index++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x,
      y: grip.y + (endY - grip.y) * index / 8, button: 'left', buttons: 1 });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: grip.x, y: endY, button: 'left', buttons: 0, clickCount: 1,
  });
  await ui.waitRead(`(() => {
    const thread=document.querySelector('[data-messages-thread-layout="wide"]');
    return !!thread && thread.getBoundingClientRect().height > 400;
  })()`, 'expanded sheet leaves room for the original reply and compact composer');
}

/**
 * Extends the existing original Electron + captured Host + actual Claude SDK
 * composer proof. The only synthetic dependency is localhost model inference.
 * Input is physical CDP pointer/keyboard; assertions read canonical Host receipts.
 */
export async function qualifyNativeNextPromptUiStep(
  cdp: UiCdpPort,
  ui: Ui,
  options: {
    root: string;
    turn: NativeNextPromptUiTurn;
    expectedHumanInputs: number;
    originalHumanSendCount(): Promise<number>;
    modelSampleCount(): number;
    modelSampleCountForTurn(): number;
    step(row: Record<string, unknown>): void;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI, '1');
  const editGuard = options.turn === 'NATIVE_TEAM_SIX' || options.turn === 'NATIVE_TEAM_SEVEN';
  const shiftTabGuard = options.turn === 'NATIVE_TEAM_EIGHT';
  if (shiftTabGuard) assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_SHIFT_TAB, '1');
  if (editGuard || shiftTabGuard) {
    assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_EDIT_GUARDS, '1');
    assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_EXTENDED, '1');
  }
  const suggestion = expectedPrompt(options.turn);
  await ui.waitRead(
    `(() => {
      const rows=[...document.querySelectorAll('[data-testid="native-next-prompt-row"]')];
      return rows.length===1 && rows[0].textContent?.includes(${desktopJsLiteral(suggestion)});
    })()`,
    'real Host offer visible in selected native teammate composer',
    40_000,
  );
  assert.equal(options.modelSampleCountForTurn(), 1,
    'exactly one native SDK inference for this qualified original human turn');
  assert.ok(options.modelSampleCount()<=options.expectedHumanInputs,
    'at most one native SDK follow-up per human turn, including an optional warm-up');

  const appearance = await ui.waitRead(`(() => {
    const row=document.querySelector('[data-testid="native-next-prompt-row"]');
    const preview=row?.querySelector('[aria-live="polite"]');
    if(!row||!preview)return null;const rect=row.getBoundingClientRect();
    const buttons=[...row.querySelectorAll('button')];
    if(buttons.length!==2||rect.width<=0||rect.top<0||rect.bottom>innerHeight+1||
      rect.left<0||rect.right>innerWidth+1)return null;
    const controls=buttons.map(button=>{const r=button.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {label:button.getAttribute('aria-label'),height:r.height,width:r.width,
        reachable:!button.disabled&&r.left>=rect.left&&r.right<=rect.right&&
          !!hit&&(hit===button||button.contains(hit))};});
    if(controls.some(control=>!control.reachable))return null;
    return {theme:document.documentElement.classList.contains('light')?'light':'dark',
      compact:preview.classList.contains('truncate'),plainText:preview.children.length===0,
      controls,previewMatches:preview.textContent===${desktopJsLiteral(suggestion)}};
  })()`, 'real suggestion and controls fit the visible original composer') as {
    theme: string; compact: boolean; plainText: boolean; previewMatches: boolean;
    controls: Array<{ label: string; width: number; height: number; reachable: boolean }>;
  };
  assert.ok(appearance.plainText && appearance.previewMatches);
  assert.deepEqual(appearance.controls.map(control => control.label), ['Insert', 'Dismiss suggestion']);
  assert.ok(appearance.controls.every(control => control.reachable && control.height >= 43 && control.width > 0));
  assert.equal(appearance.theme,
    options.turn === 'NATIVE_TEAM_FIVE' || editGuard || shiftTabGuard ? 'light' : 'dark');
  assert.equal(appearance.compact, options.turn === 'NATIVE_TEAM_FIVE');

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const data = screenshot && typeof screenshot === 'object'
    ? (screenshot as Record<string, unknown>).data : undefined;
  assert.ok(typeof data === 'string' && data.length > 100, 'actual Electron screenshot');
  const imagePath = join(options.root, 'native-next-prompt-' + options.turn + '.png');
  await writeFile(imagePath, Buffer.from(data, 'base64'), { mode: 0o600 });
  const proof = options.evidence.nativeNextPromptUi as {
    screenshots: Array<{turn:string;path:string;sha256:string;theme:string;compact:boolean}>;
    shiftTabPreserved?: boolean; shiftTabWithVisibleOffer?: boolean; imePreserved?: boolean;
    shiftTabActionMode?: Record<string, unknown>;
    attachmentInvalidation?: boolean; chipInvalidation?: boolean;
    attachmentEdit?: Record<string, unknown>; chipEdit?: Record<string, unknown>;
  };
  proof.screenshots.push({ turn: options.turn, path: imagePath, sha256: await fileDigest(imagePath),
    theme: appearance.theme, compact: appearance.compact });
  await ui.click('.message-composer-flat-layout textarea', 'focus ordinary native suggestion editor');

  if (shiftTabGuard) {
    proof.shiftTabActionMode = await qualifyActionModeShiftTab(cdp, ui, true);
    proof.shiftTabPreserved = true;
    proof.shiftTabWithVisibleOffer = true;
  } else if (options.turn === 'NATIVE_TEAM_SIX') {
    proof.attachmentEdit = await qualifyNativeNextPromptAttachmentEdit(cdp, ui, options);
    proof.attachmentInvalidation = true;
  } else if (options.turn === 'NATIVE_TEAM_SEVEN') {
    proof.chipEdit = await qualifyNativeNextPromptChipEdit(cdp, ui, options);
    proof.chipInvalidation = true;
  } else if (options.turn === 'NATIVE_TEAM_FIVE') {
    await cdp.send('Input.imeSetComposition', { text: '検証', selectionStart: 2, selectionEnd: 2 });
    await ui.waitRead(`document.querySelector('.message-composer-flat-layout textarea')?.value==='検証' &&
      !document.querySelector('[data-testid="native-next-prompt-row"]')`,
    'real Chromium IME preedit takes ownership and dismisses the native offer');
    await key(cdp, 'Tab', 'Tab', 9);
    assert.notEqual(await cdp.evaluate("document.querySelector('.message-composer-flat-layout textarea')?.value"),
      suggestion, 'Tab cannot insert the suggestion during IME composition');
    await ui.click('.message-composer-flat-layout textarea', 'focus original IME editor for cancellation');
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await clearInsertedDraft(cdp, ui);
    assert.equal(await cdp.evaluate('document.querySelector(\'[data-testid="native-next-prompt-row"]\') === null'),
      true, 'clearing IME text cannot resurrect the old native offer');
    proof.imePreserved = true;
    await ui.click('button[aria-label="Message bottom sheet actions"]', 'restore original inline conversation');
    await ui.click('[role="menuitem"]', 'return through ordinary layout menu', 'Move to inline');
    await ui.waitRead('!document.querySelector(\'button[aria-label="Message bottom sheet actions"]\')',
      'ordinary inline layout restored before native Stop');
  } else if (options.turn === 'NATIVE_TEAM_THREE') {
    await key(cdp, 'Escape', 'Escape', 27);
    await ui.waitRead(
      "document.querySelector('[data-testid=\"native-next-prompt-row\"]') === null",
      'Escape dismisses native offer without editing',
    );
    assert.equal(
      await cdp.evaluate("document.querySelector('.message-composer-flat-layout textarea')?.value"),
      '',
      'Escape preserves original empty draft',
    );
  } else {
    if (options.turn === 'NATIVE_TEAM_TWO') {
      await ui.click('[data-testid="native-next-prompt-row"] button[aria-label="Insert"]',
        'ordinary Insert click for native suggestion');
    } else {
      await key(cdp, 'Tab', 'Tab', 9);
    }
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${desktopJsLiteral(suggestion)}`,
      'verified native suggestion appears only as editable draft',
      20_000,
    );
    assert.equal(
      await cdp.evaluate('document.querySelector(\'[data-testid="native-next-prompt-row"]\') === null'),
      true,
      'a consumed suggestion cannot remain interactive',
    );
    await clearInsertedDraft(cdp, ui);
    if (options.turn === 'NATIVE_TEAM_TWO' &&
        process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI_SHIFT_TAB !== '1') {
      // Older workflow definitions retain their original turn count. Their shortcut
      // proof runs after Insert/clear; the flagged eighth turn proves a visible offer.
      proof.shiftTabActionMode = await qualifyActionModeShiftTab(cdp, ui, false);
      proof.shiftTabPreserved = true;
    }
  }

  assert.equal(await options.originalHumanSendCount(), options.expectedHumanInputs,
    'Tab, Shift+Tab, Escape, Insert, IME, attachment and chip edits never send a new human message');
  assert.equal(options.modelSampleCountForTurn(), 1,
    'composer interactions cannot start a second native sample');
  options.step({
    assertion: 'native suggestion physical composer interaction',
    turn: options.turn,
    action: options.turn === 'NATIVE_TEAM_TWO' ? 'Insert'
      : options.turn === 'NATIVE_TEAM_THREE' ? 'Escape'
        : options.turn === 'NATIVE_TEAM_FOUR' ? 'Tab'
          : options.turn === 'NATIVE_TEAM_FIVE' ? 'IME'
            : options.turn === 'NATIVE_TEAM_SIX' ? 'Attachment add/remove'
              : options.turn === 'NATIVE_TEAM_SEVEN' ? 'File chip add/remove' : 'Shift+Tab action mode',
    appearance,
    modelSampleCount: options.modelSampleCount(),
    sentHumanMessages: options.expectedHumanInputs,
    screenshotSha256: proof.screenshots.at(-1)?.sha256,
  });
}
