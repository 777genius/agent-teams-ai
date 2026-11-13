import assert from 'node:assert/strict';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** Read real text geometry and, when needed, reveal it with ordinary wheel input. */
export async function revealDesktopReply(
  cdp: UiCdpPort,
  reply: string,
  options: {
    messageId?: string;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  const scoped = options.messageId === undefined ? null : `(() => {
    const messageId=${JSON.stringify(options.messageId)},expected=${JSON.stringify(reply.replace(/\s+/g, " ").trim())},normalize=s=>s.replace(/\\s+/g,' ').trim();
    const rows=[...document.querySelectorAll('[data-timeline-row-key]')].filter(e=>e.getAttribute('data-timeline-row-key')===messageId);
    if(rows.length!==1||!expected)return null;
    const elements=[rows[0]],elementWalker=document.createTreeWalker(rows[0],NodeFilter.SHOW_ELEMENT);let child;
    while(child=elementWalker.nextNode()){if(elements.length>=256)return null;elements.push(child);}
    const matches=elements.filter(e=>typeof e.innerText==='string'&&normalize(e.innerText)===expected&&e.getClientRects().length>0);
    const smallest=matches.filter(e=>!matches.some(n=>n!==e&&e.contains(n)));
    if(smallest.length!==1)return null;
    const element=smallest[0],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),fragments=[];let node,textNodes=0;
    while(node=walker.nextNode()){
      if(++textNodes>256)return null;
      if(!node.textContent.trim())continue;
      const range=document.createRange();range.selectNodeContents(node);
      for(const r of range.getClientRects()){
        if(r.width<=0||r.height<=0)continue;
        if(fragments.length>=64)return null;
        let top=0,bottom=innerHeight,left=0,right=innerWidth,scroll=null,rendered=true;
        for(let e=node.parentElement;e;e=e.parentElement){
          const style=getComputedStyle(e),rect=e.getBoundingClientRect();
          const scaleX=e.offsetWidth?rect.width/e.offsetWidth:1,scaleY=e.offsetHeight?rect.height/e.offsetHeight:1;
          const clipTop=rect.top+e.clientTop*scaleY,clipBottom=clipTop+e.clientHeight*scaleY;
          const clipLeft=rect.left+e.clientLeft*scaleX,clipRight=clipLeft+e.clientWidth*scaleX;
          if(style.visibility!=='visible'||Number(style.opacity)===0)rendered=false;
          if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,clipTop);bottom=Math.min(bottom,clipBottom);}
          if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,clipLeft);right=Math.min(right,clipRight);}
          if(!scroll&&/auto|scroll/.test(style.overflowY)&&e.scrollHeight>e.clientHeight+2)
            scroll={x:rect.x+rect.width/2,y:clipTop+Math.min(40,(clipBottom-clipTop)/2),top:clipTop,bottom:clipBottom};
        }
        const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        const visible=rendered&&r.top>=top&&r.bottom<=bottom&&r.left>=left&&r.right<=right&&hit&&(element===hit||element.contains(hit));
        fragments.push({visible:Boolean(visible),rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip:{top,bottom,left,right},scroll});
      }
    }
    if(!fragments.length)return null;
    const top=Math.min(...fragments.map(f=>f.rect.y)),bottom=Math.max(...fragments.map(f=>f.rect.y+f.rect.height));
    const left=Math.min(...fragments.map(f=>f.rect.x)),right=Math.max(...fragments.map(f=>f.rect.x+f.rect.width));
    const firstHidden=fragments.find(f=>!f.visible)??fragments[0],clip=firstHidden.clip;
    return {visible:fragments.every(f=>f.visible),messageId,text:element.innerText,fragments,
      rect:{x:left,y:top,width:right-left,height:bottom-top},clip,scroll:firstHidden.scroll,
      deltaY:bottom>clip.bottom?bottom-clip.bottom+24:top-clip.top-24};
  })()`;
  for (let attempt = 0; attempt < 12; attempt++) {
    options.assertOwnedRenderer();
    const observation = await cdp.evaluate(scoped ?? `(() => {
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
    if (scoped !== null && observation === null) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      continue;
    }
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
