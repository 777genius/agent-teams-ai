import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { waitFor } from './cdp.mts';
import type { Cdp } from './cdp.mts';

export const macAbout = `(() => {const name=[...document.querySelectorAll('p')].find(p=>p.textContent.trim()==='Agent Teams AI');return name?.parentElement?.parentElement??null;})()`;
export class MacOldUi {
  readonly renderer: Cdp;
  readonly output: string;
  constructor(renderer: Cdp, output: string) {
    this.renderer = renderer;
    this.output = output;
  }
  async snapshot() {
    return this.renderer.evaluate<{ body: string; dialogs: string[] }>(
      '({body:document.body.innerText,dialogs:[...document.querySelectorAll("[role=dialog]")].map(e=>e.textContent)})'
    );
  }
  async screenshot(label: string) {
    const capture = await this.renderer.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    await writeFile(path.join(this.output, `${label}.png`), Buffer.from(capture.data, 'base64'));
  }
  async point(pattern: string, root = 'document') {
    return this.renderer.evaluate<{ x: number; y: number; text: string } | null>(
      `(() => { const scope=${root};if(!scope)return null;const regex=new RegExp(${JSON.stringify(pattern)},'i');for(const b of scope.querySelectorAll('button')) {if(b.disabled||!regex.test(b.textContent.trim()))continue;const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(r.width&&r.height&&b.contains(document.elementFromPoint(x,y)))return {x,y,text:b.textContent.trim()};}return null;})()`
    );
  }
  async click(pattern: string, root = 'document') {
    const location = await waitFor(
      () => this.point(pattern, root),
      `hit-tested ${pattern}`,
      15_000
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.renderer.send('Input.dispatchMouseEvent', {
        type,
        x: location.x,
        y: location.y,
        button: 'left',
        clickCount: 1,
      });
    return location;
  }
  async settings() {
    const location = await waitFor(
      () =>
        this.renderer.evaluate<{ x: number; y: number } | null>(
          `(() => {const b=document.querySelector('button[aria-label="More actions"]');if(!b)return null;const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width&&r.height&&b.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`
        ),
      'More actions'
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.renderer.send('Input.dispatchMouseEvent', {
        type,
        x: location.x,
        y: location.y,
        button: 'left',
        clickCount: 1,
      });
    await this.click('^Settings$');
  }
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
export async function macDebugPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
export async function macDebugTargets(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok ? ((await response.json()) as Target[]) : null;
  } catch {
    return null;
  }
}
