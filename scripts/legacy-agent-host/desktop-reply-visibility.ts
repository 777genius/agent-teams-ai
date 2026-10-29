import assert from 'node:assert/strict';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** Read real text geometry and, when needed, reveal it with ordinary wheel input. */
export async function revealDesktopReply(
  cdp: UiCdpPort,
  reply: string,
  options: {
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  for (let attempt = 0; attempt < 12; attempt++) {
    options.assertOwnedRenderer();
    const observation = await cdp.evaluate(`(() => {
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      const matches=[];let n;
      while(n=walker.nextNode())if(n.textContent.trim()===${JSON.stringify(reply)})matches.push(n);
      if(!matches.length)return null;
      const node=matches.find(n=>n.parentElement.closest('p'))??matches.at(-1),element=node.parentElement,range=document.createRange();range.selectNodeContents(node);
      const r=range.getBoundingClientRect();let top=0,bottom=innerHeight,left=0,right=innerWidth,scroll=null;
      for(let e=element;e;e=e.parentElement){
        const style=getComputedStyle(e),rect=e.getBoundingClientRect();
        if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}
        if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}
        if(!scroll&&/auto|scroll/.test(style.overflowY)&&e.scrollHeight>e.clientHeight+2)scroll={x:rect.x+rect.width/2,y:rect.y+Math.min(40,rect.height/2),top:rect.top,bottom:rect.bottom};
      }
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      const visible=r.width>0&&r.height>0&&r.top>=top&&r.bottom<=bottom&&r.left>=left&&r.right<=right&&hit&&(element===hit||element.contains(hit)||hit.contains(element));
      return {visible:Boolean(visible),text:node.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip:{top,bottom,left,right},scroll,deltaY:r.bottom>bottom?r.bottom-bottom+24:r.top-top-24};
    })()`);
    assert.ok(observation && typeof observation === 'object');
    const value = observation as Record<string, unknown>;
    if (value.visible === true) {
      options.step({
        assertion: 'exact native reply fully visible within all clipped ancestors',
        reply,
        observation,
      });
      return observation;
    }
    if (!value.scroll || typeof value.scroll !== 'object') {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      continue;
    }
    const scroll = value.scroll as { x: number; y: number };
    const deltaY = Math.max(-600, Math.min(600, Number(value.deltaY)));
    assert.ok(Number.isFinite(deltaY) && deltaY !== 0);
    options.assertOwnedRenderer();
    options.step({ action: 'mouseWheel', reply, x: scroll.x, y: scroll.y, deltaY });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: scroll.x,
      y: scroll.y,
      deltaX: 0,
      deltaY,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Reply viewport visibility unconfirmed; no business mutation replay');
}
