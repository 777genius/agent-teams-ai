import { hostname } from "node:os";
import {
  buildControlledAgentProcessOwner,
  type ControlledAgentProcessOwner,
  type ControlledAgentProviderPort,
} from "@vioxen/subscription-runtime/worker-core";

export type ProjectControllerProviderRegistry = {
  readonly get: (sessionId: string) => ControlledAgentProviderPort | undefined;
  readonly set: (
    sessionId: string,
    provider: ControlledAgentProviderPort,
  ) => void;
  readonly delete: (sessionId: string) => void;
};

let processOwner: ControlledAgentProcessOwner | undefined;

export function createInMemoryProjectControllerProviderRegistry():
  ProjectControllerProviderRegistry {
  const providers = new Map<string, ControlledAgentProviderPort>();
  return {
    get(sessionId) {
      return providers.get(sessionId);
    },
    set(sessionId, provider) {
      providers.set(sessionId, provider);
    },
    delete(sessionId) {
      providers.delete(sessionId);
    },
  };
}

export function projectControllerProcessOwner(
  runtimeVersion: string,
): ControlledAgentProcessOwner {
  processOwner ??= buildControlledAgentProcessOwner({
    runtimeVersion,
    ...(process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA === undefined
      ? {}
      : { runtimeSha: process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA }),
    pid: process.pid,
  });
  return processOwner;
}

export function projectControllerOwnerIsLive(
  owner: ControlledAgentProcessOwner,
): boolean {
  if (owner.hostname !== undefined && owner.hostname !== hostname()) return true;
  if (owner.pid === undefined) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}
