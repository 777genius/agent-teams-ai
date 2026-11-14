import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { desktopJsLiteral } from './desktop-ui-controls.ts';
import { fileDigest } from './desktop-backend-fixture.ts';

import type { UiCdpPort, createDesktopUiControls } from './desktop-ui-controls.ts';

type Ui = ReturnType<typeof createDesktopUiControls>;

const expectedPrompt = (turn: string) => 'TEST_NEXT_PROMPT_' + turn;

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
  // Mac Command+A followed by Backspace; no JS DOM mutation or synthetic React event.
  await key(cdp, 'a', 'KeyA', 65, 4);
  await key(cdp, 'Backspace', 'Backspace', 8);
  await ui.waitRead(
    "document.querySelector('.message-composer-flat-layout textarea')?.value === ''",
    'ordinary editor is empty after physical clear',
  );
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
    turn: 'NATIVE_TEAM_ONE' | 'NATIVE_TEAM_TWO' | 'NATIVE_TEAM_THREE';
    expectedHumanInputs: number;
    originalHumanSendCount(): Promise<number>;
    modelSampleCount(): number;
    step(row: Record<string, unknown>): void;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  assert.equal(process.env.LEGACY_DESKTOP_NATIVE_NEXT_PROMPT_UI, '1');
  const suggestion = expectedPrompt(options.turn);
  await ui.waitRead(
    `(() => {
      const rows=[...document.querySelectorAll('[data-testid="native-next-prompt-row"]')];
      return rows.length===1 && rows[0].textContent?.includes(${desktopJsLiteral(suggestion)});
    })()`,
    'real Host offer visible in selected native teammate composer',
    40_000,
  );
  assert.equal(options.modelSampleCount(), options.expectedHumanInputs,
    'one native SDK follow-up inference for each original human input');

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const data = screenshot && typeof screenshot === 'object'
    ? (screenshot as Record<string, unknown>).data : undefined;
  assert.ok(typeof data === 'string' && data.length > 100, 'actual Electron screenshot');
  const imagePath = join(options.root, 'native-next-prompt-' + options.turn + '.png');
  await writeFile(imagePath, Buffer.from(data, 'base64'), { mode: 0o600 });
  const proof = options.evidence.nativeNextPromptUi as { screenshots: Array<{turn:string;path:string;sha256:string}> };
  proof.screenshots.push({ turn: options.turn, path: imagePath, sha256: await fileDigest(imagePath) });
  await ui.click('.message-composer-flat-layout textarea', 'focus ordinary native suggestion editor');

  if (options.turn === 'NATIVE_TEAM_TWO') {
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
    if (options.turn === 'NATIVE_TEAM_ONE') {
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
  }

  assert.equal(await options.originalHumanSendCount(), options.expectedHumanInputs,
    'Tab, Escape, and Insert never send a new human message');
  options.step({
    assertion: 'native suggestion physical composer interaction',
    turn: options.turn,
    action: options.turn === 'NATIVE_TEAM_ONE' ? 'Insert'
      : options.turn === 'NATIVE_TEAM_TWO' ? 'Escape' : 'Tab',
    modelSampleCount: options.modelSampleCount(),
    sentHumanMessages: options.expectedHumanInputs,
    screenshotSha256: proof.screenshots.at(-1)?.sha256,
  });
}
