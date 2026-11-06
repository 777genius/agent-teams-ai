import { z } from 'zod';
import { createTeamRegistryPayloadSchema } from '../team-registry/contracts.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { CreateTeamLaunchCoordinator } from './CreateTeamLaunchCoordinator.js';

type CreationSelection = {
  coordinator: Pick<CreateTeamLaunchCoordinator, 'prepare' | 'submit' | 'lookup'>;
  commandId: string;
  payload: unknown;
};

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Finite creation routes keep the Host's captured-envelope admission and original coordinator. */
export function createTeamCreationMethods(options: {
  select(raw: unknown): CreationSelection;
}): Record<string, HostMethod> {
  const methods: Record<string, HostMethod> = {};
  for (const operation of ['prepare', 'probe.read', 'probe.cancel', 'submit', 'lookup'] as const) {
    methods[`team.creation.${operation}`] = {
      lane:
        operation === 'probe.read' || operation === 'probe.cancel' || operation === 'lookup'
          ? 'control'
          : 'work',
      async handle(raw): Promise<JsonValue> {
        try {
          const { coordinator, commandId, payload } = options.select(raw);
          const value =
            operation === 'submit'
              ? await coordinator.submit(commandId, payload)
              : operation === 'lookup'
                ? coordinator.lookup(commandId, payload)
                : await coordinator.prepare(
                    operation === 'prepare'
                      ? 'start'
                      : operation === 'probe.read'
                        ? 'read'
                        : 'cancel',
                    payload
                  );
          return { ok: true, value: json(value) };
        } catch (error) {
          const code =
            error instanceof TeamLaunchError ||
            error instanceof TeamOwnerError ||
            error instanceof RuntimeOwnerError ||
            error instanceof ManagementCommandError
              ? error.code === 'held' || error.code === 'busy'
                ? 'hold'
                : error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return {
            ok: false,
            code,
            outcome: code === 'hold' ? 'unknown' : 'rejected',
            ...(error instanceof TeamLaunchError ? { reason: error.reason } : {}),
          };
        }
      },
    };
  }
  return methods;
}

/** Registry routes share the same captured owner admission, without changing registry journals. */
export function createTeamRegistryMethods(options: {
  select(raw: unknown): {
    registry: Pick<TeamRegistry, 'create' | 'lookup' | 'list'>;
    commandId: string;
    payload: unknown;
  };
}): Record<string, HostMethod> {
  const id = z.string().min(1).max(256);
  const methods: Record<string, HostMethod> = {};
  for (const operation of ['create', 'lookup', 'list'] as const) {
    methods[`team.registry.${operation}`] = {
      lane: operation === 'create' ? 'work' : 'control',
      handle(raw): JsonValue {
        try {
          const { registry, commandId, payload: rawPayload } = options.select(raw);
          let value;
          if (operation === 'create') value = registry.create(commandId, rawPayload);
          else if (operation === 'lookup') {
            const payload = z
              .object({ contextId: id, expected: createTeamRegistryPayloadSchema.optional() })
              .strict()
              .parse(rawPayload);
            value = registry.lookup(commandId, payload.contextId, payload.expected);
          } else {
            const payload = z.object({ contextId: id }).strict().parse(rawPayload);
            value = registry.list(payload.contextId);
          }
          return { ok: true, value: json(value) };
        } catch (error) {
          const code =
            error instanceof TeamOwnerError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  }
  return methods;
}
