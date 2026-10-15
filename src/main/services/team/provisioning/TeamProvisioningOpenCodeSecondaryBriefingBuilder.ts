import {
  boundOpenCodeAppManagedBriefingText,
  OPEN_CODE_APP_MANAGED_BRIEFING_MAX_CHARS,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import { buildChatVisualizationBriefing } from './TeamProvisioningVisualizationPrompt';

export interface OpenCodeSecondaryBriefingController {
  taskBoard: {
    memberBriefing(
      memberName: string,
      options: {
        runtimeProvider: 'opencode';
        includeActiveProcesses: false;
        includeChatVisualizationProtocol: false;
      }
    ): Promise<unknown> | unknown;
  };
  tasks: {
    memberBriefing(
      memberName: string,
      options: {
        runtimeProvider: 'opencode';
        includeActiveProcesses: false;
        includeChatVisualizationProtocol: false;
      }
    ): Promise<unknown> | unknown;
  };
}

export interface OpenCodeSecondaryBriefingControllerInput {
  teamName: string;
  claudeDir: string;
  allowUserMessageSender: false;
}

export interface OpenCodeSecondaryBriefingBuilderPorts {
  createController(
    input: OpenCodeSecondaryBriefingControllerInput
  ): OpenCodeSecondaryBriefingController;
  getClaudeBasePath(): string;
}

export interface BuildOpenCodeSecondaryAppManagedLaunchPromptInput {
  teamName: string;
  memberName: string;
}

export interface TeamProvisioningOpenCodeSecondaryBriefingBuilder {
  buildOpenCodeSecondaryAppManagedLaunchPrompt(
    input: BuildOpenCodeSecondaryAppManagedLaunchPromptInput
  ): Promise<string>;
}

export function createTeamProvisioningOpenCodeSecondaryBriefingBuilder(
  ports: OpenCodeSecondaryBriefingBuilderPorts
): TeamProvisioningOpenCodeSecondaryBriefingBuilder {
  return {
    buildOpenCodeSecondaryAppManagedLaunchPrompt: (input) =>
      buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(input, ports),
  };
}

export async function buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(
  input: BuildOpenCodeSecondaryAppManagedLaunchPromptInput,
  ports: OpenCodeSecondaryBriefingBuilderPorts
): Promise<string> {
  const controller = ports.createController({
    teamName: input.teamName,
    claudeDir: ports.getClaudeBasePath(),
    allowUserMessageSender: false,
  });
  const briefing = await controller.taskBoard.memberBriefing(input.memberName, {
    runtimeProvider: 'opencode',
    includeActiveProcesses: false,
    includeChatVisualizationProtocol: false,
  });
  const boundedBriefing = boundOpenCodeAppManagedBriefingText(String(briefing ?? ''));
  if (!boundedBriefing) {
    throw new Error(`OpenCode app-managed member briefing was empty for ${input.memberName}`);
  }
  const prefix = [
    '<agent_teams_app_managed_briefing_source>',
    'This briefing was loaded by the desktop app via member_briefing with includeActiveProcesses=false.',
    'Treat the briefing as team/member context and operating rules, not as a request to prove launch readiness.',
  ].join('\n');
  const suffix = '</agent_teams_app_managed_briefing_source>';
  const briefingBudget =
    OPEN_CODE_APP_MANAGED_BRIEFING_MAX_CHARS - prefix.length - suffix.length - 2;
  return [prefix, buildChatVisualizationBriefing(boundedBriefing, briefingBudget), suffix].join(
    '\n'
  );
}
