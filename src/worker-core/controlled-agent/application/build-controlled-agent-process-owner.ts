import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  ControlledAgentProcessOwnerKind,
  type ControlledAgentProcessOwner,
} from "../domain/controlled-agent";

export type BuildControlledAgentProcessOwnerInput = {
  readonly kind?: ControlledAgentProcessOwnerKind;
  readonly ownerId?: string;
  readonly now?: Date;
  readonly pid?: number;
  readonly hostname?: string;
  readonly runtimeVersion?: string;
  readonly runtimeSha?: string;
};

export function buildControlledAgentProcessOwner(
  input: BuildControlledAgentProcessOwnerInput = {},
): ControlledAgentProcessOwner {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    ownerId: input.ownerId ?? randomUUID(),
    kind: input.kind ?? ControlledAgentProcessOwnerKind.DurableMcp,
    startedAt: now,
    heartbeatAt: now,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    hostname: input.hostname ?? hostname(),
    ...(input.runtimeVersion === undefined ? {} : {
      runtimeVersion: input.runtimeVersion,
    }),
    ...(input.runtimeSha === undefined ? {} : { runtimeSha: input.runtimeSha }),
  };
}
