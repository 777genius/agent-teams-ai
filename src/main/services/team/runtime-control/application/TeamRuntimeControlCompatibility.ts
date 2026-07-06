import {
  createOpenCodeRuntimeControlApi,
  type OpenCodeRuntimeControlApi,
  type OpenCodeRuntimeControlApiPorts,
} from './OpenCodeRuntimeControlApi';
import {
  createOpenCodeRuntimeControlRouter,
  type OpenCodeRuntimeControlPort,
} from './OpenCodeRuntimeControlProvider';

export interface TeamRuntimeControlCompatibilityApiPorts {
  openCode: OpenCodeRuntimeControlPort;
  resolveOpenCodeRuntimeLaneId: OpenCodeRuntimeControlApiPorts['resolveOpenCodeRuntimeLaneId'];
}

export function createTeamRuntimeControlCompatibilityApi(
  ports: TeamRuntimeControlCompatibilityApiPorts
): OpenCodeRuntimeControlApi {
  return createOpenCodeRuntimeControlApi({
    runtimeControl: createOpenCodeRuntimeControlRouter(ports.openCode),
    resolveOpenCodeRuntimeLaneId: ports.resolveOpenCodeRuntimeLaneId,
  });
}
