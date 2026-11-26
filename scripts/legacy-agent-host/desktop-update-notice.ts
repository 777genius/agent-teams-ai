import assert from 'node:assert/strict';

import { createDesktopUiControls } from './desktop-ui-controls.ts';

import type { UiCdpPort } from './desktop-ui-controls.ts';

// English packaged TEST profiles can receive the ordinary release notice
// over another dialog. Select only that exact visible update notice, and
// require its own Later button to win the real center hit-test.
const originalNoticeTarget = `
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible';};
  const dialogs=[...document.querySelectorAll('[data-testid="update-dialog"][role="dialog"]')].filter(visible);
  if(dialogs.length!==1)return null;
  const dialog=dialogs[0];
  if(dialog.getAttribute('data-testid')!=='update-dialog')return null;
  const titleId=dialog.getAttribute('aria-labelledby');
  if(typeof titleId!=='string'||titleId.length===0||titleId.length>128)return null;
  const title=document.getElementById(titleId);
  if(!title||!dialog.contains(title)||title.textContent.trim()!=='Update available')return null;
  const buttons=[...dialog.querySelectorAll('button')];
  if(buttons.length>32)return null;
  const matches=buttons.filter(e=>visible(e)&&e.textContent.trim()==='Later');
  if(matches.length!==1)return null;
  const e=matches[0];
  if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')return null;
  const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
  const hit=document.elementFromPoint(x,y);
  if(!hit||!(hit===e||e.contains(hit)))return null;
`;

type NoticeUi = Pick<ReturnType<typeof createDesktopUiControls>, 'clickExpression' | 'waitRead'>;

/** One ordinary dismissal under the caller's captured Main and original phase deadline. */
export async function dismissOriginalUpdateNotice(
  cdp: Pick<UiCdpPort, 'evaluate'>,
  ui: NoticeUi,
  options: { assertOwnedRenderer(): void; remainingMs(): number; beforeDismiss?(): void }
): Promise<boolean> {
  options.assertOwnedRenderer();
  const present = await cdp.evaluate(`(() => {${originalNoticeTarget}return true;})()`);
  options.assertOwnedRenderer();
  if (present === null) return false;
  assert.equal(present, true, 'Original update notice lookup returns a closed result');
  options.beforeDismiss?.();
  await ui.clickExpression(`(() => {${originalNoticeTarget}
    return {x,y,text:'Later',tag:'BUTTON'};
  })()`, 'dismiss original available update notice', '[data-testid="update-dialog"] button', 'Later');
  options.assertOwnedRenderer();
  await ui.waitRead(`(() => {
    return ![...document.querySelectorAll('[data-testid="update-dialog"][role="dialog"]')]
      .some(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible';});
  })()`, 'original available update notice dismissed', options.remainingMs());
  options.assertOwnedRenderer();
  return true;
}

/** Opt-in preparation for one original packaged caller; never retries a business click. */
export function createDesktopUpdateNoticePreparation(
  cdp: UiCdpPort,
  options: { assertOwnedRenderer(): void; step(value: Record<string, unknown>): void }
): (deadline: number) => Promise<void> {
  let attempted = false;
  return async (deadline) => {
    if (attempted) return;
    assert.ok(Number.isFinite(deadline));
    const assertCurrent = (): void => {
      options.assertOwnedRenderer();
      if (Date.now() >= deadline)
        throw new Error('Original UI update notice preparation exceeded its captured deadline; no mutation retry');
    };
    const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: assertCurrent, step: options.step });
    await dismissOriginalUpdateNotice(cdp, ui, {
      assertOwnedRenderer: assertCurrent,
      remainingMs: () => { assertCurrent(); return deadline - Date.now(); },
      beforeDismiss: () => {
        assert.equal(attempted, false, 'Original update notice dismissal was already reserved');
        attempted = true;
      },
    });
  };
}
