import assert from 'node:assert/strict';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

/** Read current owner/surface from the existing React dialog; return its actual input ID, never synthesize one. */
export function desktopTaskCommentInputExpression(handleId: string, taskId: string): string {
  assert.ok(handleId && taskId);
  return `(() => {
    const owner=${desktopJsLiteral(hostTeamSelectionKey(handleId))},taskId=${desktopJsLiteral(taskId)};
    const currentFiber=node=>{
      const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$')),fiber=key?node[key]:null;
      for(const candidate of [fiber,fiber?.alternate]){
        if(!candidate)continue;let root=candidate,depth=0;
        while(root.return&&depth++<256)root=root.return;
        if(!root.return&&root.stateNode?.current===root)return candidate;
      }
      return null;
    };
    const matches=[];
    for(const dialog of document.querySelectorAll('[role="dialog"]')){
      if(!dialog.getClientRects().length)continue;
      const controllers=new Set();
      for(let fiber=currentFiber(dialog),depth=0;fiber&&depth<128;fiber=fiber.return,depth++){
        const p=fiber.memoizedProps,c=p?.sessionController,i=c?.identity;
        if(p?.open===true&&p.teamName===owner&&p.task?.id===taskId&&i?.teamName===owner&&i.taskId===taskId&&
          typeof i.contextId==='string'&&i.contextId&&typeof c.surfaceId==='string'&&c.surfaceId&&
          c.isOwner===true&&c.session?.ownerSurfaceId===c.surfaceId)controllers.add(c);
      }
      if(controllers.size!==1)continue;const controller=[...controllers][0],identity=controller.identity;
      for(const input of dialog.querySelectorAll('textarea')){
        if(!input.id||input.disabled||!input.getClientRects().length)continue;
        for(let fiber=currentFiber(input),depth=0;fiber&&depth<128;fiber=fiber.return,depth++){
          const p=fiber.memoizedProps;
          if(p?.controller!==controller||p.contextId!==identity.contextId||p.teamName!==owner||p.taskId!==taskId||p.surfaceId!==controller.surfaceId)continue;
          if([...document.querySelectorAll('textarea')].filter(e=>e.id===input.id).length!==1)throw Error('duplicate current Task comment input ID');
          matches.push({teamName:owner,taskId,identity:{contextId:identity.contextId,teamName:identity.teamName,taskId:identity.taskId},
            surfaceId:controller.surfaceId,inputId:input.id,commentText:controller.session.commentText,
            submitPending:controller.session.submitPending,submitError:controller.session.submitError,
            pendingAttachmentCount:controller.session.pendingAttachments.length,selector:'[role="dialog"] textarea[id='+JSON.stringify(input.id)+']'});
          break;
        }
      }
    }
    if(matches.length>1)throw Error('ambiguous current Task comment owner/surface');
    return matches[0]??null;
  })()`;
}
