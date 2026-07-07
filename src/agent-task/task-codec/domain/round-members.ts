import type { AgentTaskRoundMemberIdentity } from "./agent-task-contracts";

export type AgentTaskRoundIndependenceFailure =
  | "same-provider-model"
  | "same-independence-group";

export type AgentTaskRoundIndependenceResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly failure: AgentTaskRoundIndependenceFailure;
      readonly safeMessage: string;
    };

export function compareAgentTaskRoundMembers(
  member: AgentTaskRoundMemberIdentity,
  other: AgentTaskRoundMemberIdentity,
): AgentTaskRoundIndependenceResult {
  if (providerModelKey(member) === providerModelKey(other)) {
    return {
      ok: false,
      failure: "same-provider-model",
      safeMessage: "Round members must use distinct provider/model identities.",
    };
  }
  if (normalized(member.independenceGroup) === normalized(other.independenceGroup)) {
    return {
      ok: false,
      failure: "same-independence-group",
      safeMessage: "Round members must use distinct independence groups.",
    };
  }
  return { ok: true };
}

export function assertAgentTaskRoundMembersIndependent(
  member: AgentTaskRoundMemberIdentity,
  other: AgentTaskRoundMemberIdentity,
): void {
  const result = compareAgentTaskRoundMembers(member, other);
  if (!result.ok) throw new Error(result.safeMessage);
}

export function agentTaskRoundMemberFingerprint(
  member: AgentTaskRoundMemberIdentity,
): string {
  return [
    member.id,
    member.adapterId,
    member.agentType,
    member.provider,
    member.model,
    member.independenceGroup,
  ].map(fingerprintSegment).join("|");
}

function providerModelKey(member: AgentTaskRoundMemberIdentity): string {
  return `${normalized(member.provider)}:${normalized(member.model)}`;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function fingerprintSegment(value: string): string {
  const text = normalized(value);
  return `${text.length}:${text}`;
}
