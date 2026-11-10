import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { TEAM_FEED_SCOPE } from '../../../src/features/team-direct-chats/renderer';
import { crossTeamActivityPresentation } from '../../../src/renderer/components/team/activity/crossTeamActivityPresentation';
import { useMessageReplyRouting } from '../../../src/renderer/components/team/messages/useMessageReplyRouting';

import type { InboxMessage } from '../../../src/shared/types';

it('keeps captured navigation and reply state in the originating view while preserving local reply behavior', async () => {
  const message:InboxMessage={from:'alpha.lead',to:'lead',text:'TEST cross',read:false,timestamp:'TEST-time',source:'cross_team',conversationId:'TEST-conversation',
    crossTeamNavigation:{fromTeamName:'alpha',toTeamName:'beta',fromTeamKey:'host-team:original.with.dot',toTeamKey:'host-team:beta'}};
  const onTeamClick=vi.fn(),onReply=vi.fn(),openTeamFeed=vi.fn(),focusComposer=vi.fn(),fetchTargets=vi.fn().mockResolvedValue(true);
  const presentation=crossTeamActivityPresentation({message,teamName:'host-team:beta',isCrossTeam:true,isCrossTeamSent:false,
    prefixFrom:'alpha.lead',sentTarget:null,onTeamClick,onReply});
  expect(presentation.origin).toEqual({teamName:'alpha',memberName:'lead'});
  presentation.originTeamClick?.('ignored-latest-name');
  expect(onTeamClick).toHaveBeenCalledWith('host-team:original.with.dot');
  expect(crossTeamActivityPresentation({...{message,teamName:'host-team:beta',isCrossTeam:true,isCrossTeamSent:false,sentTarget:null},
    message:{...message,crossTeamNavigation:undefined},onTeamClick,onReply}).replyClick).toBeUndefined();
  let routing:ReturnType<typeof useMessageReplyRouting>|undefined;
  function Harness({contextId}:{contextId:string}) {
    routing=useMessageReplyRouting({contextId,teamName:'host-team:beta',scope:TEAM_FEED_SCOPE,members:[{name:'lead'}],
      onReply,openTeamFeed,focusComposer,fetchTargets});return null;
  }
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>{root.render(createElement(Harness,{contextId:'TEST-A'}));});
    if(!routing)throw new Error('TEST hook missing');
    await act(async()=>{routing?.handleReplyToTimelineMessage(message);});
    expect(routing.crossTeamReply).toEqual({toTeam:'host-team:original.with.dot',toMember:'lead',conversationId:'TEST-conversation'});
    expect(openTeamFeed).toHaveBeenCalledTimes(1);expect(fetchTargets).toHaveBeenCalledTimes(1);expect(focusComposer).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
    await act(async()=>{root.render(createElement(Harness,{contextId:'TEST-B'}));});
    expect(routing.crossTeamReply).toBeNull();expect(routing.replyAddressRequest).toBeNull();
    await act(async()=>{routing?.handleReplyToTimelineMessage({...message,source:'inbox',from:'lead',crossTeamNavigation:undefined});});
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({from:'lead'}),'lead');
  } finally {await act(async()=>root.unmount());container.remove();}
});
