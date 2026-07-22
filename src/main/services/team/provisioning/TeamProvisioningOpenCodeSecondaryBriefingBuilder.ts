import { boundOpenCodeAppManagedBriefingText } from './TeamProvisioningOpenCodeDiagnosticsPolicy';

export interface OpenCodeSecondaryBriefingController {
  taskBoard: {
    memberBriefing(
      memberName: string,
      options: {
        runtimeProvider: 'opencode';
        includeActiveProcesses: false;
      }
    ): Promise<unknown> | unknown;
  };
  tasks: {
    memberBriefing(
      memberName: string,
      options: {
        runtimeProvider: 'opencode';
        includeActiveProcesses: false;
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
  });
  const boundedBriefing = boundOpenCodeAppManagedBriefingText(String(briefing ?? ''));
  if (!boundedBriefing) {
    throw new Error(`OpenCode app-managed member briefing was empty for ${input.memberName}`);
  }
  return [
    '<agent_teams_app_managed_briefing_source>',
    'This briefing was loaded by the desktop app via member_briefing with includeActiveProcesses=false.',
    'Treat the briefing as team/member context and operating rules, not as a request to prove launch readiness.',
    boundedBriefing,
    '</agent_teams_app_managed_briefing_source>',
  ].join('\n');
}
