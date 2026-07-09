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

export interface TeamRuntimeControlCompatibilityServiceHost {
  createOpenCodeRuntimeDeliveryBoundary(): Omit<
    OpenCodeRuntimeControlPort,
    'answerOpenCodeRuntimePermission'
  >;
  createOpenCodeRuntimePermissionAnswerBoundary(): Pick<
    OpenCodeRuntimeControlPort,
    'answerOpenCodeRuntimePermission'
  >;
  resolveOpenCodeRuntimeLaneId: TeamRuntimeControlCompatibilityApiPorts['resolveOpenCodeRuntimeLaneId'];
}

export function createTeamRuntimeControlCompatibilityApiFromService(
  service: TeamRuntimeControlCompatibilityServiceHost
): OpenCodeRuntimeControlApi {
  return createTeamRuntimeControlCompatibilityApi({
    openCode: {
      recordOpenCodeRuntimeBootstrapCheckin: (raw) =>
        service.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeBootstrapCheckin(raw),
      deliverOpenCodeRuntimeMessage: (raw) =>
        service.createOpenCodeRuntimeDeliveryBoundary().deliverOpenCodeRuntimeMessage(raw),
      recordOpenCodeRuntimeTaskEvent: (raw) =>
        service.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeTaskEvent(raw),
      recordOpenCodeRuntimeHeartbeat: (raw) =>
        service.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeHeartbeat(raw),
      answerOpenCodeRuntimePermission: (raw) =>
        service
          .createOpenCodeRuntimePermissionAnswerBoundary()
          .answerOpenCodeRuntimePermission(raw),
    },
    resolveOpenCodeRuntimeLaneId: (input) => service.resolveOpenCodeRuntimeLaneId(input),
  });
}
