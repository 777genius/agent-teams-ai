import assert from 'node:assert/strict';

import { desktopJsLiteral } from './desktop-ui-controls.ts';

import type { createDesktopUiControls } from './desktop-ui-controls.ts';

/** This save-only owner-routing scenario needs a shared physical board. A new
 * per-project definition correctly has no board until its first native Launch.
 * Select the existing creation control before publishing the immutable mode.
 */
export async function selectOwnerRoutingSharedHistory(
  ui: Pick<ReturnType<typeof createDesktopUiControls>, 'waitRead' | 'scrollTo' | 'click'>
): Promise<void> {
  const section = await ui.waitRead(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="create-team-page"] button[aria-controls]')]
      .filter(button => [...button.querySelectorAll('span')]
        .some(span => span.textContent.trim() === 'Optional settings'));
    if (buttons.length !== 1) return null;
    return { id: buttons[0].getAttribute('aria-controls'), expanded: buttons[0].getAttribute('aria-expanded') };
  })()`, 'original save-only history settings');
  assert.ok(section && typeof section === 'object' && !Array.isArray(section));
  const { id, expanded } = section as { id: unknown; expanded: unknown };
  assert.ok(typeof id === 'string' && id.length > 0);
  assert.ok(expanded === 'true' || expanded === 'false');
  if (expanded === 'false') {
    const trigger = '[data-testid="create-team-page"] button[aria-controls=' + desktopJsLiteral(id) + ']';
    await ui.scrollTo(trigger, 'original save-only history settings');
    await ui.click(trigger, 'expand original save-only history settings');
  }
  const history = '[data-testid="create-team-page"] #team-project-context-mode';
  await ui.scrollTo(history, 'original Team history control');
  await ui.click(history, 'open original Team history choice');
  await ui.click('[role="option"]', 'select shared original owner history', 'Shared across projects');
  await ui.waitRead(`document.querySelector(${desktopJsLiteral(history)})?.textContent.trim() === 'Shared across projects'`,
    'original shared history retained before Create');
}
