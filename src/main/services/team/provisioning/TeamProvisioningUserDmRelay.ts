import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import { armSilentTeammateForward } from './TeamProvisioningInboxRelayCandidates';
import {
  getCanonicalSendMessageFieldRule,
  getCanonicalSendMessageToolRule,
} from './TeamProvisioningPromptBuilders';

import type { ProvisioningRun } from './TeamProvisioningRunModel';

export type TeamProvisioningUserDmRelayRun = Pick<
  ProvisioningRun,
  | 'teamName'
  | 'provisioningComplete'
  | 'child'
  | 'silentUserDmForward'
  | 'silentUserDmForwardClearHandle'
>;

export interface TeamProvisioningUserDmRelayPorts<TRun extends TeamProvisioningUserDmRelayRun> {
  getAliveRunId(teamName: string): string | null | undefined;
  getRun(runId: string): TRun | undefined;
  sendMessageToRun(run: TRun, message: string): Promise<void>;
  nowIso(): string;
}

export interface TeamProvisioningUserDmRelayInput {
  teamName: string;
  teammateName: string;
  userText: string;
  userSummary?: string;
}

export function buildUserDmRelayMessage(input: {
  teammateName: string;
  userText: string;
  userSummary?: string;
}): string {
  const summaryLine = input.userSummary?.trim() ? `Summary: ${input.userSummary.trim()}` : null;
  const internal = wrapAgentBlock(
    [
      `UI relay request — forward a direct message to teammate "${input.teammateName}".`,
      `MUST: ${getCanonicalSendMessageToolRule(input.teammateName)}`,
      `MUST: if they reply to the human, the destination must be to="user" (short answer).`,
      `CRITICAL: Do NOT send any message to="user" for this turn.`,
      getCanonicalSendMessageFieldRule(),
    ].join('\n')
  );
  return [
    `User DM relay (internal).`,
    internal,
    ``,
    `Message to forward:`,
    ...(summaryLine ? [summaryLine] : []),
    input.userText,
  ].join('\n');
}

export async function forwardUserDmToTeammateWithPorts<TRun extends TeamProvisioningUserDmRelayRun>(
  input: TeamProvisioningUserDmRelayInput,
  ports: TeamProvisioningUserDmRelayPorts<TRun>
): Promise<void> {
  const runId = ports.getAliveRunId(input.teamName);
  if (!runId) {
    throw new Error(`No active process for team "${input.teamName}"`);
  }
  const run = ports.getRun(runId);
  if (!run?.child?.stdin?.writable) {
    throw new Error(`Team "${input.teamName}" process stdin is not writable`);
  }
  if (!run.provisioningComplete) {
    return;
  }

  armSilentTeammateForward(run, input.teammateName, 'user_dm', ports.nowIso());

  await ports.sendMessageToRun(
    run,
    buildUserDmRelayMessage({
      teammateName: input.teammateName,
      userText: input.userText,
      userSummary: input.userSummary,
    })
  );
}
