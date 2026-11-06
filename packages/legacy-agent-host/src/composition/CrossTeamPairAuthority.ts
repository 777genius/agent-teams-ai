import { TeamOwnerError } from '../team/contracts.js';
import { digest, effectId } from '../team/identity.js';
import { resolveCrossTeamRecipientIdentity } from '../cross-team/CrossTeamRecipientIdentity.js';
import {
  crossTeamTeamResourceRef,
  crossTeamTargetResourceRef,
} from '../cross-team/CrossTeamResourceIdentity.js';
import { validateCrossTeamIntent } from '../cross-team/validateCrossTeamIntent.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type {
  CapturedCrossTeamIntent,
  CapturedCrossTeamSide,
  CapturedCrossTeamIdentity,
} from '../cross-team/contracts.js';

/** Current grants and original resource identity; this owns no message effects. */
export function createCrossTeamPairAuthority(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: ReadonlyMap<string, HostedTeam>;
  assertCurrent(): void;
}) {
  const ownerFingerprint = digest(options.profile.owner);
  function selected(side: CapturedCrossTeamSide): HostedTeam {
    options.assertCurrent();
    const team = options.teams.get(side.teamId);
    if (
      !team ||
      digest(team.definition.scope) !== digest(side.scope) ||
      team.definition.binding.teamName !== side.teamName ||
      side.teamResourceRef !== crossTeamTeamResourceRef(ownerFingerprint, side.scope)
    )
      throw new TeamOwnerError('forbidden');
    return team;
  }
  function base(team: HostedTeam, principalId: string, handleId?: string) {
    options.assertCurrent();
    if (options.teams.get(team.definition.binding.teamId) !== team)
      throw new TeamOwnerError('hold');
    const current = team.owner.crossTeamIdentity(principalId, true);
    const scope = structuredClone(team.definition.scope);
    return {
      current,
      side: {
        scope,
        teamResourceRef: crossTeamTeamResourceRef(ownerFingerprint, scope),
        teamId: team.definition.binding.teamId,
        teamName: team.definition.binding.teamName,
        principalId,
        grantRevision: current.revision,
        actor: current.actor,
        ...(handleId === undefined ? {} : { handleId }),
      },
    };
  }
  function source(team: HostedTeam, principalId: string, handleId?: string): CapturedCrossTeamSide {
    const { current, side } = base(team, principalId, handleId);
    const member = current.members.find((row) =>
      current.actor === 'user' ? row.role === 'lead' : row.name === current.actor
    );
    if (current.actor !== 'user' && !member?.delivery) throw new TeamOwnerError('hold');
    const sender = member?.delivery
      ? {
          memberId: member.memberId,
          runId: member.delivery.runId,
          generation: member.delivery.generation,
        }
      : undefined;
    const runId = sender?.runId ?? side.scope.runId;
    return {
      ...side,
      runId,
      ...(sender ? { sender } : {}),
      resourceRef: effectId(
        'cross-team-source',
        side.teamResourceRef,
        principalId,
        String(current.revision),
        current.actor,
        digest(sender ?? null)
      ),
    };
  }
  function target(
    team: HostedTeam,
    principalId: string,
    toMember?: string,
    handleId?: string
  ): CapturedCrossTeamIdentity['target'] {
    const { current, side } = base(team, principalId, handleId);
    const recipientName = resolveCrossTeamRecipientIdentity({
      sources: {
        config: {
          members: current.members.map((member) => ({
            ...member,
            ...(member.role === 'lead' ? { agentType: 'team-lead' } : {}),
          })),
        },
      },
      rawToMember: toMember,
    }).memberName;
    const member = current.members.find((row) => row.name === recipientName);
    if (!member?.delivery) throw new TeamOwnerError('hold');
    const recipient = {
      memberId: member.memberId,
      name: member.name,
      runId: member.delivery.runId,
      generation: member.delivery.generation,
    };
    return {
      ...side,
      runId: recipient.runId,
      recipient,
      resourceRef: crossTeamTargetResourceRef(
        side.teamResourceRef,
        principalId,
        current.revision,
        recipient
      ),
    };
  }
  function assertPair(intent: CapturedCrossTeamIntent): void {
    validateCrossTeamIntent(intent);
    if (
      intent.pair.ownerId !== options.profile.owner.ownerId ||
      intent.pair.ownerRevision !== options.profile.owner.revision ||
      intent.pair.ownerFingerprint !== ownerFingerprint
    )
      throw new TeamOwnerError('forbidden');
    selected(intent.pair.source);
    selected(intent.pair.target);
  }
  function assertSource(intent: CapturedCrossTeamIntent): void {
    assertPair(intent);
    const original = intent.pair.source,
      team = selected(original);
    if (digest(source(team, original.principalId, original.handleId)) !== digest(original))
      throw new TeamOwnerError('hold');
    const commands = team.owner.crossTeamCommands(original.principalId),
      receipt = commands.lookup(intent.commandId);
    if (!receipt || digest(receipt.intent) !== digest(intent)) throw new TeamOwnerError('hold');
    commands.assertCurrent(receipt);
  }
  function assertTarget(intent: CapturedCrossTeamIntent): void {
    assertPair(intent);
    const original = intent.pair.target,
      team = selected(original);
    if (
      digest(target(team, original.principalId, original.recipient.name, original.handleId)) !==
      digest(original)
    )
      throw new TeamOwnerError('hold');
    assertSource(intent);
  }
  return {
    source,
    target,
    selected,
    assertPair,
    assertSource,
    assertTarget,
    ownerFingerprint,
    sourceAuthorized(intent: CapturedCrossTeamIntent): boolean {
      try {
        assertSource(intent);
        return true;
      } catch {
        return false;
      }
    },
  };
}
