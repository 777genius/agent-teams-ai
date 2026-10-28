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

/** Observe completion of the original board assignment before another Task action. */
export function desktopTaskBoardAssignmentReadyExpression(
  handleId: string,
  taskId: string,
  captured: { contextId: string; surfaceId: string }
): string {
  assert.ok(captured.contextId && captured.surfaceId);
  return `(async()=>{
    const {isTeamDataRefreshPending}=await import('/store/slices/teamSlice.ts');
    const {captureTaskDetailReadScope,isTaskDetailTeamUnavailable}=await import('/store/team/taskDetailReadAuthority.ts');
    const owner=${desktopTaskCommentInputExpression(handleId, taskId)};
    if(!owner||owner.identity.contextId!==${desktopJsLiteral(captured.contextId)}||owner.surfaceId!==${desktopJsLiteral(captured.surfaceId)})return null;
    const s=window.__agentTeamsDevStore.getState(),i=owner.identity;
    const detail=s.taskDetailById[JSON.stringify([i.contextId,i.teamName,i.taskId])];
    if(s.isContextSwitching||s.activeContextId!==i.contextId||s.selectedTeamName!==i.teamName||
      !detail||detail.identity.contextId!==i.contextId||detail.identity.teamName!==i.teamName||detail.identity.taskId!==i.taskId||
      detail.phase!=='ready'||detail.loading||detail.refreshPending||detail.full?.id!==i.taskId||detail.full.owner!=='alice'||
      isTeamDataRefreshPending(i.teamName,window.__agentTeamsDevStore.getState)||
      isTaskDetailTeamUnavailable(s,i.teamName,captureTaskDetailReadScope(i.teamName,i.contextId)))return null;
    const input=document.getElementById(owner.inputId),dialog=input?.closest('[role="dialog"]');
    const triggers=dialog?.querySelectorAll('button[role="combobox"]');
    if(triggers?.length!==1||triggers[0].disabled||triggers[0].getAttribute('aria-expanded')!=='false'||triggers[0].textContent.trim()!=='alice')return null;
    return owner;
  })()`;
}
