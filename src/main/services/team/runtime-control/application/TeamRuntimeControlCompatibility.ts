import {
  createOpenCodeRuntimeControlApi,
  type OpenCodeRuntimeControlApi,
  type OpenCodeRuntimeControlApiPorts,
} from './OpenCodeRuntimeControlApi';
import {
  createOpenCodeRuntimeControlRouter,
  type OpenCodeRuntimeControlPort,
} from './OpenCodeRuntimeControlProvider';

import type { RuntimeControlEventSink } from './RuntimeControlPorts';

export interface TeamRuntimeControlCompatibilityApiPorts {
  openCode: OpenCodeRuntimeControlPort;
  resolveOpenCodeRuntimeLaneId: OpenCodeRuntimeControlApiPorts['resolveOpenCodeRuntimeLaneId'];
  eventSink?: RuntimeControlEventSink;
}

export function createTeamRuntimeControlCompatibilityApi(
  ports: TeamRuntimeControlCompatibilityApiPorts
): OpenCodeRuntimeControlApi {
  return createOpenCodeRuntimeControlApi({
    runtimeControl: createOpenCodeRuntimeControlRouter(ports.openCode, {
      eventSink: ports.eventSink,
    }),
    resolveOpenCodeRuntimeLaneId: ports.resolveOpenCodeRuntimeLaneId,
  });
}
