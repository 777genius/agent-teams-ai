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
            ownerRevision:controller.session.ownerRevision,partRevisions:{commentText:controller.session.partRevisions.commentText,pendingAttachments:controller.session.partRevisions.pendingAttachments},
            pendingPreparationCount:controller.session.pendingAttachmentPreparationIds.length,canSubmit:controller.canSubmit,attachmentError:controller.attachmentError,
            pendingAttachmentCount:controller.session.pendingAttachments.length,canEditNow:controller.canEditNow?.()===true,canResolveClarification:controller.canResolveClarification===true,selector:'[role="dialog"] textarea[id='+JSON.stringify(input.id)+']'});
          break;
        }
      }
    }
    if(matches.length>1)throw Error('ambiguous current Task comment owner/surface');
    return matches[0]??null;
  })()`;
}

/** Observe the original assignment, its clarification control, or later in-progress comment stage. */
export function desktopTaskBoardAssignmentReadyExpression(
  handleId: string,
  taskId: string,
  captured: { contextId: string; surfaceId: string },
  stage?: 'in-progress-comment' | 'clarification' | 'clarification-cleared'
): string {
  assert.ok(captured.contextId && captured.surfaceId);
  return `(async()=>{
    const {isTeamDataRefreshPending}=await import('/store/slices/teamSlice.ts');
    const {captureTaskDetailReadScope,isTaskDetailTeamUnavailable}=await import('/store/team/taskDetailReadAuthority.ts');
    const owner=${desktopTaskCommentInputExpression(handleId, taskId)};
    if(!owner||!owner.canEditNow||owner.identity.contextId!==${desktopJsLiteral(captured.contextId)}||owner.surfaceId!==${desktopJsLiteral(captured.surfaceId)})return null;
    const s=window.__agentTeamsDevStore.getState(),i=owner.identity;
    const detail=s.taskDetailById[JSON.stringify([i.contextId,i.teamName,i.taskId])];
    if(s.isContextSwitching||s.activeContextId!==i.contextId||s.selectedTeamName!==i.teamName||
      !detail||detail.identity.contextId!==i.contextId||detail.identity.teamName!==i.teamName||detail.identity.taskId!==i.taskId||
      detail.phase!=='ready'||(detail.loading&&${stage !== 'clarification'})||detail.refreshPending||detail.full?.id!==i.taskId||detail.full.owner!=='alice'||
      isTeamDataRefreshPending(i.teamName,window.__agentTeamsDevStore.getState)||
      isTaskDetailTeamUnavailable(s,i.teamName,captureTaskDetailReadScope(i.teamName,i.contextId)))return null;
    ${stage === 'clarification' ? `
      const key=JSON.stringify([i.contextId,i.teamName,i.taskId]),session=s.taskDetailSessionById?.[key];
      if(owner.canResolveClarification!==true||!session||session.ownerSurfaceId!==owner.surfaceId||
        session.ownerRevision!==owner.ownerRevision||detail.error!==null||detail.deletionIntent!==null||
        detail.full.needsClarification!=='user'||detail.full.deletedAt||detail.full.status==='deleted')return null;
      if(detail.loading){
        const token=detail.fullToken,scope=captureTaskDetailReadScope(i.teamName,i.contextId);
        if(!token||token.resource!=='full'||token.key!=='full:'+key||!token.scope||
          token.scope.contextId!==scope.contextId||token.scope.teamName!==scope.teamName||
          token.scope.contextEpoch!==scope.contextEpoch||token.scope.teamStateEpoch!==scope.teamStateEpoch)return null;
      }
    ` : stage === 'clarification-cleared' ? `
      const key=JSON.stringify([i.contextId,i.teamName,i.taskId]),session=s.taskDetailSessionById?.[key];
      if(!session||session.ownerSurfaceId!==owner.surfaceId||session.ownerRevision!==owner.ownerRevision||
        detail.loading!==false||detail.refreshPending!==false||detail.error!==null||detail.deletionIntent!==null||
        detail.full.needsClarification!==undefined||detail.full.deletedAt||detail.full.status==='deleted')return null;
    ` : ''}
    const input=document.getElementById(owner.inputId),dialog=input?.closest('[role="dialog"]');
    const triggers=dialog?.querySelectorAll('button[role="combobox"]');
    ${stage === 'in-progress-comment'
      ? "if(detail.full.status!=='in_progress'||triggers?.length!==0)return null;"
      : "if(triggers?.length!==1||triggers[0].disabled||triggers[0].getAttribute('aria-expanded')!=='false'||triggers[0].textContent.trim()!=='alice')return null;"}
    ${stage === 'clarification-cleared' ? `
      const elements = [...dialog.querySelectorAll('button')].filter(e => {
        const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&e.textContent.trim()==='Close';
      });
      if(elements.length!==1)return {unavailableTarget:true,matches:Math.min(elements.length,256)};
      const e=elements[0], r=e.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y), disabled=e.matches(':disabled');
      if(!hit||!(hit===e||e.contains(hit))||disabled)return {
        unavailableTarget:true,matches:1,disabled,ariaDisabled:e.getAttribute('aria-disabled')==='true',
        pointerEventsNone:getComputedStyle(e).pointerEvents==='none',
        centerInViewport:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hitPresent:Boolean(hit)
      };
      return {x,y,text:e.textContent.trim().slice(0,300),tag:e.tagName};
    ` : 'return owner;'}
  })()`;
}

/** Close the original assigned Task only after its current owner and cleared detail are ready. */
export function clickDesktopTaskBoardClearedClose(
  ui: { clickExpression(expression: string, label: string, selector?: string, text?: string): Promise<void> },
  handleId: string,
  taskId: string,
  captured: { contextId: string; surfaceId: string }
): Promise<void> {
  return ui.clickExpression(
    desktopTaskBoardAssignmentReadyExpression(handleId, taskId, captured, 'clarification-cleared'),
    'close original Task detail',
    '[role="dialog"] button',
    'Close'
  );
}
