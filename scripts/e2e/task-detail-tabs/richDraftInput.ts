import assert from 'node:assert/strict';

interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function wait(cdp: Cdp, expression: string, label: string) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (await cdp.evaluate(expression)) return;
    await pause(100);
  }
  throw Error('Timed out: ' + label);
}
async function click(cdp: Cdp, expression: string) {
  const point = (await cdp.evaluate(
    `(()=>{const e=${expression};if(!e)throw Error('UI target missing');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};})()`
  )) as { x: number; y: number; width: number; height: number };
  assert(point.width > 0 && point.height > 0);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    });
}

/** All draft mutations travel through the real mounted controls, not store staging. */
export async function prepareRichTaskDraft(cdp: Cdp, teamName: string): Promise<void> {
  const key = JSON.stringify(['local', teamName, '1']);
  await cdp.evaluate(
    `(()=>{const t=document.querySelector('[role="dialog"] textarea[id^="task-comment-input-"]');t.focus();const value='TEST_HANDOFF_DRAFT_V7 @README';Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,value);t.setSelectionRange(value.length,value.length);t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await wait(
    cdp,
    `!![...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('README.md'))`,
    'real project file suggestion'
  );
  await click(
    cdp,
    `[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('README.md'))`
  );
  await wait(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(key)}]?.commentChips.length===1`,
    'file mention chip through UI'
  );
  await click(
    cdp,
    `document.querySelector('[role="dialog"] [data-task-comment-id] button:has(svg.lucide-reply)')`
  );
  await wait(
    cdp,
    `!!window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(key)}]?.reply`,
    'reply through comment UI'
  );
  await click(
    cdp,
    `document.querySelector('[role="dialog"] button.absolute:has(svg.lucide-pencil)')`
  );
  await wait(
    cdp,
    `!!document.querySelector('[role="dialog"] [contenteditable="true"]')`,
    'real description editor'
  );
  await click(cdp, `document.querySelector('[role="dialog"] [contenteditable="true"]')`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.insertText', { text: 'TESTDIRTYDESCRIPTIONHANDOFF' });
  await wait(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(key)}]?.descriptionDraft.includes('TESTDIRTYDESCRIPTIONHANDOFF')`,
    'typed description draft'
  );
  await click(
    cdp,
    `[...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent.trim()==='TEST A same ID task')`
  );
  await wait(
    cdp,
    `!![...document.querySelectorAll('[role="dialog"] input')].find(e=>e.value==='TEST A same ID task')`,
    'real subject editor'
  );
  await cdp.evaluate(
    `(()=>{const e=[...document.querySelectorAll('[role="dialog"] input')].find(e=>e.value==='TEST A same ID task');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'TEST_DIRTY_SUBJECT_HANDOFF');e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await wait(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(key)}]?.subjectDraft==='TEST_DIRTY_SUBJECT_HANDOFF'`,
    'typed subject draft'
  );
}
