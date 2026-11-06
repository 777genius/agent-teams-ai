import { listTeamCommandEntries } from '../team/commandEntries.js';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { crossTeamInboundRow } from './crossTeamInbound.js';
import { crossTeamSenderCopy } from './crossTeamRecords.js';
import type { JsonValue } from '../contracts.js';
import type { TeamStore, TeamPolicyPort } from '../team/ports.js';
import type { CapturedCrossTeamIntent } from './contracts.js';

/** Navigation metadata is derived only from original private receipts, never sender-name lookup. */
function origin(intent:CapturedCrossTeamIntent) {
  const {source,target}=intent.pair;
  return {fromTeamResourceRef:source.teamResourceRef,toTeamResourceRef:target.teamResourceRef,
    fromTeamName:source.teamName,toTeamName:target.teamName,
    ...(source.handleId===undefined?{}:{fromHandleId:source.handleId}),
    ...(target.handleId===undefined?{}:{toHandleId:target.handleId})};
}

/** Called inside the existing Team read fence; unknown imported history stays archive data. */
export function projectCrossTeamMessages(options:{store:TeamStore;policy:TeamPolicyPort;
  messages:JsonValue[];actor:string;readAll:boolean}):JsonValue[] {
  const entries=listTeamCommandEntries(options.store);
  const incoming=entries.filter(entry=>!('family' in entry) && entry.crossTeam);
  const outgoing=entries.filter(entry=>'family' in entry && entry.family==='cross-team');
  const sent=(options.policy.readSentMessages?.()??[]).filter(row=>
    row && typeof row==='object' && !Array.isArray(row) &&
    row.source==='cross_team_sent' &&
    (options.readAll || row.from===options.actor));
  return [...options.messages,...sent].map(row=>{
    if (!row || typeof row!=='object' || Array.isArray(row) || typeof row.messageId!=='string') return row;
    const candidates:CapturedCrossTeamIntent[]=[];
    if(row.source==='cross_team') for(const entry of incoming) {
      if('family' in entry || !entry.crossTeam || entry.effects.messageId!==row.messageId) continue;
      if(digest({...row,read:false})!==digest(crossTeamInboundRow(entry,entry.crossTeam))) throw new TeamOwnerError('hold');
      candidates.push(entry.crossTeam);
    }
    if(row.source==='cross_team_sent') for(const entry of outgoing) {
      if(!('family' in entry) || entry.family!=='cross-team' || entry.intent.request.messageId!==row.messageId) continue;
      if(digest(row)!==digest(crossTeamSenderCopy(entry.intent))) throw new TeamOwnerError('hold');
      candidates.push(entry.intent);
    }
    if(candidates.length>1) throw new TeamOwnerError('hold');
    return candidates[0]?{...row,crossTeamOrigin:origin(candidates[0])}:row;
  });
}
