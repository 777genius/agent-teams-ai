import { digest, effectId } from '../team/identity.js';
import type { CapturedCrossTeamSide } from './contracts.js';

/** Same captured owner tuple used by Main routing and the private Host profile. */
export function crossTeamOwnerResourceRef(owner: {
  ownerId:string;revision:string;storageRoot:string;profileId:string;protocolVersion:1;
  buildId:string;nodeSha256:string;hostEntrySha256:string;
}):string {
  return digest(owner);
}

/** Stable scope identity for navigation matching only; never a current send capability. */
export function crossTeamTeamResourceRef(
  ownerFingerprint: string,
  scope: CapturedCrossTeamSide['scope']
): string {
  return effectId('cross-team-team', ownerFingerprint, digest(scope));
}

/** Current target selection binds the original grant and exact recipient generation. */
export function crossTeamTargetResourceRef(
  teamResourceRef: string,
  principalId: string,
  grantRevision: number,
  recipient: { memberId: string; name: string; runId: string; generation: string }
): string {
  return effectId(
    'cross-team-target',
    teamResourceRef,
    principalId,
    String(grantRevision),
    digest(recipient)
  );
}
