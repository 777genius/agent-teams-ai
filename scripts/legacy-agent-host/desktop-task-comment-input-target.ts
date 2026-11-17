import assert from 'node:assert/strict';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

/** Read current owner/surface from the existing React dialog; return its actual input ID, never synthesize one. */
export function desktopTaskCommentInputExpression(handleId: string, taskId: string): string {
  return desktopTaskInputOwnerExpression(handleId, taskId, false);
}

// Only the clarification observer may use the session lease while ordinary edits are disabled.
function desktopTaskInputOwnerExpression(handleId: string, taskId: string, clarification: boolean): string {
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
    ${clarification ? `if([...document.querySelectorAll('[role="dialog"]')].filter(d=>d.getClientRects().length).length!==1)return null;` : ''}
    for(const dialog of document.querySelectorAll('[role="dialog"]')){
      if(!dialog.getClientRects().length)continue;
      const controllers=new Set();
      for(let fiber=currentFiber(dialog),depth=0;fiber&&depth<128;fiber=fiber.return,depth++){
        const p=fiber.memoizedProps,c=p?.sessionController,i=c?.identity;
        if(p?.open===true&&p.teamName===owner&&p.task?.id===taskId&&i?.teamName===owner&&i.taskId===taskId&&
          typeof i.contextId==='string'&&i.contextId&&typeof c.surfaceId==='string'&&c.surfaceId&&
          ${clarification ? '' : 'c.isOwner===true&&'}c.session?.ownerSurfaceId===c.surfaceId)controllers.add(c);
      }
      if(controllers.size!==1)continue;const controller=[...controllers][0],identity=controller.identity;
      for(const input of dialog.querySelectorAll('textarea')){
        if(!input.id||input.disabled||!input.getClientRects().length)continue;
        for(let fiber=currentFiber(input),depth=0;fiber&&depth<128;fiber=fiber.return,depth++){
          const p=fiber.memoizedProps;
          if(p?.controller!==controller||p.contextId!==identity.contextId||p.teamName!==owner||p.taskId!==taskId||p.surfaceId!==controller.surfaceId)continue;
          if([...document.querySelectorAll('textarea')].filter(e=>e.id===input.id).length!==1)throw Error('duplicate current Task comment input ID');
          matches.push({teamName:owner,taskId,identity:{contextId:identity.contextId,teamName:identity.teamName,taskId:identity.taskId},
            isOwner:controller.isOwner===true,surfaceId:controller.surfaceId,inputId:input.id,commentText:controller.session.commentText,
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
  captured: { contextId: string; surfaceId: string; ownerRevision?: number;
    readScope?: { contextId: string; teamName: string; contextEpoch: number; teamStateEpoch: number } },
  stage?: 'in-progress-comment' | 'clarification'
): string {
  assert.ok(captured.contextId && captured.surfaceId);
  return `(async()=>{
    const {isTeamDataRefreshPending}=await import('/store/slices/teamSlice.ts');
    const {captureTaskDetailReadScope,isTaskDetailTeamUnavailable,isTaskDetailTokenCurrent}=await import('/store/team/taskDetailReadAuthority.ts');
    ${stage === 'clarification' ? `const {isTaskDetailReadTokenForResource,isSameTaskDetailReadScope}=await import(${desktopJsLiteral('/@fs' + new URL('../../src/features/team-task-detail/core/domain/taskDetailReadProvenance.ts', import.meta.url).pathname)});` : ''}
    const owner=${desktopTaskInputOwnerExpression(handleId, taskId, stage === 'clarification')};
    if(!owner||${stage === 'clarification' ? '' : '!owner.canEditNow||'}owner.identity.contextId!==${desktopJsLiteral(captured.contextId)}||owner.surfaceId!==${desktopJsLiteral(captured.surfaceId)})return null;
    const s=window.__agentTeamsDevStore.getState(),i=owner.identity;
    const scope=captureTaskDetailReadScope(i.teamName,i.contextId);
    let pendingClarification=false;
    const detail=s.taskDetailById[JSON.stringify([i.contextId,i.teamName,i.taskId])];
    if(s.isContextSwitching||s.activeContextId!==i.contextId||s.selectedTeamName!==i.teamName||
      !detail||detail.identity.contextId!==i.contextId||detail.identity.teamName!==i.teamName||detail.identity.taskId!==i.taskId||
      detail.phase!=='ready'||(detail.loading&&${stage !== 'clarification'})||detail.refreshPending||detail.full?.id!==i.taskId||detail.full.owner!=='alice'||
      isTeamDataRefreshPending(i.teamName,window.__agentTeamsDevStore.getState)||
      (${stage !== 'clarification'}&&isTaskDetailTeamUnavailable(s,i.teamName,scope)))return null;
    ${stage === 'clarification' ? `
      const key=JSON.stringify([i.contextId,i.teamName,i.taskId]),session=s.taskDetailSessionById?.[key];
      if(owner.canResolveClarification!==true||!session||session.ownerSurfaceId!==owner.surfaceId||
        session.ownerRevision!==owner.ownerRevision||owner.ownerRevision!==${desktopJsLiteral(captured.ownerRevision ?? null)}||
        !Number.isSafeInteger(owner.ownerRevision)||owner.ownerRevision<=0||
        !${desktopJsLiteral(captured.readScope ?? null)}||!isSameTaskDetailReadScope(scope,${desktopJsLiteral(captured.readScope ?? null)})||
        s.teamDataCacheByName?.[i.teamName]?.config?.deletedAt||s.selectedTeamData?.config?.deletedAt||
        s.teamByName?.[i.teamName]?.deletedAt||s.teamManagementNoticeByTeam?.[i.teamName]?.kind==='trashed'||detail.error!==null||detail.deletionIntent!==null||
        detail.full.needsClarification!=='user'||detail.full.deletedAt||detail.full.status==='deleted')return null;
      if(detail.loading){
        const token=detail.fullToken;
        if(!token?.scope||!isTaskDetailReadTokenForResource(token,i)||!isSameTaskDetailReadScope(token.scope,scope)||
          !Number.isSafeInteger(token.serial)||token.serial<=0||!Number.isSafeInteger(token.sourceEpoch)||token.sourceEpoch<0||
          !Number.isSafeInteger(token.physicalStartOrder)||token.physicalStartOrder<=0||!isTaskDetailTokenCurrent(token,scope))return null;
        pendingClarification=true;
      }
      if(!pendingClarification&&(!owner.isOwner||!owner.canEditNow||isTaskDetailTeamUnavailable(s,i.teamName,scope)))return null;
    ` : ''}
    const input=document.getElementById(owner.inputId),dialog=input?.closest('[role="dialog"]');
    const triggers=dialog?.querySelectorAll('button[role="combobox"]');
    ${stage === 'in-progress-comment'
      ? "if(detail.full.status!=='in_progress'||triggers?.length!==0)return null;"
      : "if(triggers?.length!==1||(triggers[0].disabled&&!pendingClarification)||triggers[0].getAttribute('aria-expanded')!=='false'||triggers[0].textContent.trim()!=='alice')return null;"}
    ${stage === 'clarification' ? `const buttons=[...dialog.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Mark resolved');
    if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true'||!buttons[0].getClientRects().length)return null;` : ''}
    return {...owner,readScope:scope};
  })()`;
}

/** Freeze the accepted assignment lease and read scope before the original clarification click. */
export function desktopTaskBoardClarificationCapture(
  original: Record<string, unknown>, ready: unknown
): { contextId: string; surfaceId: string; ownerRevision: number;
  readScope: { contextId: string; teamName: string; contextEpoch: number; teamStateEpoch: number } } {
  assert.ok(ready && typeof ready === 'object');
  const accepted = ready as Record<string, unknown>;
  assert.equal(accepted.ownerRevision, original.ownerRevision);
  assert.equal(accepted.surfaceId, original.surfaceId);
  assert.ok(original.identity && typeof original.identity === 'object');
  const identity = original.identity as Record<string, unknown>;
  assert.ok(accepted.readScope && typeof accepted.readScope === 'object');
  const scope = accepted.readScope as Record<string, unknown>;
  assert.equal(scope.contextId, identity.contextId);
  assert.equal(scope.teamName, identity.teamName);
  assert.ok(typeof original.surfaceId === 'string' && typeof original.ownerRevision === 'number' &&
    typeof scope.contextId === 'string' && typeof scope.teamName === 'string' &&
    typeof scope.contextEpoch === 'number' && typeof scope.teamStateEpoch === 'number');
  return { contextId: scope.contextId, surfaceId: original.surfaceId, ownerRevision: original.ownerRevision,
    readScope: { contextId: scope.contextId, teamName: scope.teamName,
      contextEpoch: scope.contextEpoch, teamStateEpoch: scope.teamStateEpoch } };
}
