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
    `(async()=>{const e=${expression};if(!e)throw Error('UI target missing');e.scrollIntoView({block:'center',behavior:'instant'});let last='',stable=0,lastEvidence='';for(let i=0;i<120;i++){await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);for(let a=e.parentElement;a;a=a.parentElement){const style=getComputedStyle(a),clip=a.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}}const viewport={x:(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y:(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2,width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)};const clipped={x:(left+right)/2,y:(top+bottom)/2,width:right-left,height:bottom-top};const p=[viewport,clipped].find(p=>p.width>0&&p.height>0&&e.contains(document.elementFromPoint(p.x,p.y)))??clipped;const signature=JSON.stringify(p);const hit=document.elementFromPoint(p.x,p.y);lastEvidence=JSON.stringify({point:p,rect:{x:r.x,y:r.y,width:r.width,height:r.height},target:e.outerHTML.slice(0,500),hit:hit?.outerHTML.slice(0,500)});stable=signature===last&&e.contains(hit)&&p.width>0&&p.height>0?stable+1:0;last=signature;if(stable>=3)return p;}throw Error('UI target did not become stable and receive pointer input: '+lastEvidence);})()`
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
