import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';

export interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(
  cdp: Cdp,
  expression: string,
  label: string,
  ms = 18_000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

export async function click(cdp: Cdp, expression: string): Promise<void> {
  const point = (await cdp.evaluate(
    `(async()=>{const e=${expression};if(!e)throw Error('UI target missing');e.scrollIntoView({block:'center',behavior:'instant'});let last='',stable=0;for(let i=0;i<120;i++){await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();const p={x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};const signature=JSON.stringify(p);const hit=document.elementFromPoint(p.x,p.y);stable=signature===last&&e.contains(hit)&&p.width>0&&p.height>0?stable+1:0;last=signature;if(stable>=3)return p;}throw Error('UI target did not become stable and receive pointer input');})()`
  )) as { x: number; y: number; width: number; height: number };
  assert(point.width > 0 && point.height > 0, 'UI target is not visible');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    });
}

export async function setInputValue(cdp: Cdp, expression: string, value: string): Promise<void> {
  await cdp.evaluate(
    `(()=>{const e=${expression};if(!e)throw Error('Input target missing');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
}

export async function replaceTiptapText(
  cdp: Cdp,
  expression: string,
  value: string
): Promise<void> {
  await click(cdp, expression);
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
  await cdp.send('Input.insertText', { text: value });
}

export async function pressKey(
  cdp: Cdp,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0
): Promise<void> {
  for (const type of ['keyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

export async function replaceJsonAtomically(
  path: string,
  update: (value: Record<string, unknown>) => void
): Promise<void> {
  const value = await readJson(path);
  update(value);
  const temp = path + '.e2e-' + Math.random().toString(16).slice(2) + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

/** A JS string literal, never an array expression coerced by a renderer object index. */
export function taskKeyExpression(teamName: string, taskId = '1'): string {
  return JSON.stringify(JSON.stringify(['local', teamName, taskId]));
}

export function visiblePageExpression(teamName: string): string {
  return `[...document.querySelectorAll('[data-task-detail-page]')].find(p=>p.dataset.taskDetailContext==='local'&&p.dataset.taskDetailTeam===${JSON.stringify(teamName)}&&p.dataset.taskDetailTaskId==='1'&&p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0)`;
}
