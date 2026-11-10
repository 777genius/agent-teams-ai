import type { CapturedCrossTeamIntent } from './contracts.js';
import type { CrossTeamOutboxMessage } from './CrossTeamOutbox.js';

export function crossTeamTaskRefs(intent:CapturedCrossTeamIntent) {
  return intent.request.taskRefs?.map(ref=>({taskId:ref.taskId,displayId:ref.displayId,
    teamName:ref.team==='source'?intent.pair.source.teamName:intent.pair.target.teamName}));
}

/** Exact existing durable outbox representation of one immutable source intent. */
export function crossTeamOutboxRecord(intent:CapturedCrossTeamIntent):CrossTeamOutboxMessage {
  const request=intent.request,refs=crossTeamTaskRefs(intent);
  return {authorityFingerprint:intent.authorityFingerprint,messageId:request.messageId,
    fromTeam:intent.pair.source.teamName,fromMember:intent.pair.source.actor,
    toTeam:intent.pair.target.teamName,toMember:intent.pair.target.recipient.name,text:request.text,
    conversationId:request.conversationId,timestamp:intent.timestamp,chainDepth:request.chainDepth??0,
    ...(request.replyToConversationId===undefined?{}:{replyToConversationId:request.replyToConversationId}),
    ...(request.summary?.trim()?{summary:request.summary.trim()}:{}),
    ...(refs?.length?{taskRefs:refs}:{}),};
}

/** Existing sentMessages representation, shared by publication and read-side verification. */
export function crossTeamSenderCopy(intent:CapturedCrossTeamIntent) {
  const request=intent.request,refs=crossTeamTaskRefs(intent);
  return {from:intent.pair.source.actor,to:`${intent.pair.target.teamName}.${intent.pair.target.recipient.name}`,
    text:request.text,timestamp:intent.timestamp,messageId:request.messageId,read:true,
    summary:request.summary?.trim()||`Cross-team message to ${intent.pair.target.teamName}`,
    source:'cross_team_sent',conversationId:request.conversationId,
    ...(request.replyToConversationId===undefined?{}:{replyToConversationId:request.replyToConversationId}),
    ...(refs?.length?{taskRefs:refs}:{}),};
}
