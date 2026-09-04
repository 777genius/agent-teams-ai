import { isLeadMember } from '@shared/utils/leadDetection';

/**
 * Delivery of the launch dialog's optional lead prompt for an aggregate
 * OpenCode launch. The prompt is never handed to the orchestrator as its
 * `leadPrompt`, because a memoryless cloud lead re-executes that prompt on
 * every session rebuild and the bootstrap briefing has to label it as
 * historical. It reaches the lead through the inbox once the lanes are ready
 * instead, on the same path and reply contract as a message typed in the UI.
 */
export interface OpenCodeAggregateLaunchPromptPorts {
  deliverOpenCodeLaunchPromptToLead(input: {
    teamName: string;
    leadName: string;
    prompt: string;
    /**
     * Ownership fence evaluated at the delivery boundary itself, under the
     * inbox write lock. The lead inbox belongs to the team rather than to one
     * run, so a launch that lost the team while it was waiting for that lock
     * must not leave its prompt behind for the run that replaced it.
     */
    isLaunchStillCurrent: () => boolean;
  }): Promise<void>;
}

/** Inbox owner when a launch carries no recognizable lead member. */
export const FALLBACK_OPEN_CODE_LAUNCH_PROMPT_LEAD_NAME = 'team-lead';

export interface OpenCodeAggregateLaunchPromptDelivery {
  /** Prompt for the orchestrator; empty whenever the lead inbox owns delivery. */
  readonly orchestratorPrompt: string;
  /** Prompt to queue for the lead, or null when there is nothing to queue. */
  readonly leadInboxPrompt: string | null;
}

export function resolveOpenCodeAggregateLaunchPromptDelivery(
  prompt: string
): OpenCodeAggregateLaunchPromptDelivery {
  const trimmed = prompt.trim();
  return trimmed.length > 0
    ? { orchestratorPrompt: '', leadInboxPrompt: trimmed }
    : { orchestratorPrompt: prompt, leadInboxPrompt: null };
}

export function resolveOpenCodeAggregateLaunchPromptLeadName(
  members: readonly { name?: unknown; role?: unknown; agentType?: unknown }[]
): string {
  const lead = members.find((member) => isLeadMember(member));
  const leadName = typeof lead?.name === 'string' ? lead.name.trim() : '';
  return leadName || FALLBACK_OPEN_CODE_LAUNCH_PROMPT_LEAD_NAME;
}

/**
 * Queues the launch prompt as a regular user message in the lead's inbox.
 *
 * A team whose lead inbox refuses the message is still a launched team, so the
 * failure is recorded as a launch diagnostic and never thrown: the prompt is
 * one message, the launch is the whole team.
 */
export async function queueLaunchPromptToLeadInbox(
  input: {
    teamName: string;
    leadName: string;
    prompt: string;
    diagnostics: string[];
    isLaunchStillCurrent: () => boolean;
  },
  ports: OpenCodeAggregateLaunchPromptPorts
): Promise<boolean> {
  try {
    await ports.deliverOpenCodeLaunchPromptToLead({
      teamName: input.teamName,
      leadName: input.leadName,
      prompt: input.prompt,
      isLaunchStillCurrent: input.isLaunchStillCurrent,
    });
    return true;
  } catch (error) {
    input.diagnostics.push(
      `Launch prompt could not be queued for ${input.leadName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}
