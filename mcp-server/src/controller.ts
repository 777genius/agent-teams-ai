import * as agentTeamsControllerModule from 'agent-teams-controller';

type ControllerModule = typeof import('agent-teams-controller') & {
  default?: typeof import('agent-teams-controller');
};

const controllerModule =
  (agentTeamsControllerModule as ControllerModule).default ?? agentTeamsControllerModule;
const { createController } = controllerModule;

export function getController(teamName: string, claudeDir?: string) {
  return createController({
    teamName,
    ...(claudeDir ? { claudeDir } : {}),
  });
}
