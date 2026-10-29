import assert from 'node:assert/strict';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
interface ExpectedCard {
  contextId: string;
  teamName: string;
  taskId: string;
  subject: unknown;
  status: unknown;
  reviewState: unknown;
  boardColumn: unknown;
}

/** Read the committed original card, not a previous column's retained DOM or pending React work. */
export function desktopTaskReviewCardReadinessExpression(
  card: string,
  expected: ExpectedCard
): string {
  return `(() => {
    const nodes=[...document.querySelectorAll(${desktopJsLiteral(card)})],want=${desktopJsLiteral(expected)};
    if(nodes.length!==1)return null;const node=nodes[0];
    const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$')),attached=key?node[key]:null;
    let current=null;
    for(const candidate of [attached,attached?.alternate]){
      if(!candidate)continue;let root=candidate,depth=0;while(root.return&&depth++<256)root=root.return;
      if(!root.return&&root.stateNode?.current===root){current=candidate;break;}
    }
    for(let fiber=current,depth=0;fiber&&depth<128;fiber=fiber.return,depth++){
      const p=fiber.memoizedProps;
      if(p?.contextId!==want.contextId||p.teamName!==want.teamName||p.task?.id!==want.taskId||!('kanbanTaskState' in p))continue;
      if(p.task.subject!==want.subject||p.task.status!==want.status||(p.task.reviewState??null)!==want.reviewState||(p.kanbanTaskState?.column??null)!==want.boardColumn)return null;
      return {taskId:p.task.id,status:p.task.status,reviewState:p.task.reviewState??null,columnId:p.columnId,boardColumn:p.kanbanTaskState?.column??null};
    }
    return null;
  })()`;
}

/** Existing bounded scroll/hover preparation, with a renderer publication and stable hit barrier. */
export async function revealDesktopTaskReviewCard(options: {
  cdp: UiCdpPort;
  ui: ReturnType<typeof createDesktopUiControls>;
  card: string;
  expected: ExpectedCard;
  assertOwnedRenderer(): void;
  step(value: Row): void;
}): Promise<void> {
  const { cdp, ui, card } = options;
  const rendered = await ui.waitRead(
    desktopTaskReviewCardReadinessExpression(card, options.expected),
    'original committed Task card matches canonical status and review column'
  );
  options.step({
    observation: 'original rendered Task state settled before scroll/hover',
    value: rendered,
  });
  let lastGeometry: string | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const geometry = (await ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();let p=e.parentElement;while(p&&!(p.scrollWidth>p.clientWidth&&/auto|scroll/.test(getComputedStyle(p).overflowX)))p=p.parentElement;if(!p)return {visible:true};const b=p.getBoundingClientRect(),left=Math.max(0,b.left),right=Math.min(innerWidth,b.right),top=Math.max(0,b.top),bottom=Math.min(innerHeight,b.bottom);if(right<=left||bottom<=top)return null;return {visible:r.left>=left&&r.right<=right,x:(left+right)/2,y:(top+bottom)/2,deltaX:Math.max(-600,Math.min(600,r.x+r.width/2-(left+right)/2))};})()`,
      'original board horizontal viewport'
    )) as Row;
    if (geometry.visible === true) {
      await ui.scrollTo(card, 'original Task card viewport');
      const hit = await cdp.evaluate(
        `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&hit&&(hit===e||e.contains(hit))?{x:r.x,y:r.y,width:r.width,height:r.height}:null;})()`
      );
      const signature = hit ? JSON.stringify(hit) : undefined;
      if (signature && signature === lastGeometry) return;
      lastGeometry = signature;
      continue;
    }
    lastGeometry = undefined;
    options.assertOwnedRenderer();
    options.step({ action: 'mouseWheel', label: 'reveal original Task column', ...geometry });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: geometry.x,
      y: geometry.y,
      deltaX: geometry.deltaX,
      deltaY: 0,
    });
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  assert.fail('Original Task card did not settle in its visible viewport; no product action retry');
}
