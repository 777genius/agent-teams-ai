import assert from 'node:assert/strict';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Controls = ReturnType<typeof createDesktopUiControls>;

/** Admit the rendered BOOT preview and open its chat within the original reply budget. */
export async function openDesktopEmulatedBootChat(cdp: UiCdpPort, options: {
  selector: string; timeoutMs: 30_000 | 60_000; replyLabel: string;
  assertOwnedRenderer(): void; step(value: Record<string, unknown>): void;
  beforePreview?(controls: Controls): Promise<void>;
  open(controls: Controls): Promise<void>;
}) {
  const deadline = Date.now() + options.timeoutMs;
  const current = () => {
    options.assertOwnedRenderer();
    assert.ok(Date.now() < deadline, 'original initial conversation deadline');
  };
  const controls = createDesktopUiControls(cdp, { assertOwnedRenderer: current, step: options.step });
  if (options.beforePreview) {
    current(); await options.beforePreview(controls); current();
  }
  await controls.waitRead(`(() => { const rows = [...document.querySelectorAll(${literal(options.selector)})];
    return rows.length === 1 && [...rows[0].querySelectorAll('span')]
      .filter(span => span.textContent.trim() === 'TEST boot ready').length === 1; })()`,
    'original lead BOOT preview', deadline - Date.now());
  current();
  await options.open(controls);
  await controls.waitRead(`document.body.innerText.includes('TEST boot ready')`,
    options.replyLabel, deadline - Date.now());
  current();
}
