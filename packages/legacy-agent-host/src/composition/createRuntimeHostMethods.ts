import { createTeamMemberActionMethods } from './createTeamMemberActionMethods.js';
import type { RuntimeMemberActionOperation } from './executeRuntimeMemberAction.js';
import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { RUNTIME_CONTROL_OPERATIONS } from './runtimeControlValues.js';
import type { JsonValue } from '../contracts.js';
import type { HostMethod } from '../index.js';
import type { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';

/** Finite Runtime routes retain the Host's original captured-envelope authorization. */
export function createRuntimeHostMethods(options: {
  runtime: Pick<RuntimeTeamCoordinator, 'execute'> & {
    executeMemberAction?(
      teamId: string,
      operation: RuntimeMemberActionOperation,
      commandId: string,
      raw: unknown
    ): Promise<unknown>;
  };
  parse(raw: unknown): { teamId: string; commandId: string; payload: unknown };
}): Record<string, HostMethod> {
  const methods: Record<string, HostMethod> = {};
  for (const operation of RUNTIME_CONTROL_OPERATIONS) {
    methods[`runtime.${operation}`] = {
      lane: ['open', 'dispatch', 'restore'].includes(operation) ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        try {
          const input = options.parse(raw);
          return {
            ok: true,
            value: await options.runtime.execute(
              input.teamId,
              operation,
              input.payload,
              input.commandId
            ),
          };
        } catch (error) {
          const code =
            error instanceof RuntimeOwnerError ||
            error instanceof TeamOwnerError ||
            error instanceof TeamLaunchError
              ? error.code
              : error instanceof z.ZodError
                ? 'invalid'
                : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  }
  if (options.runtime.executeMemberAction)
    Object.assign(
      methods,
      createTeamMemberActionMethods({
        parse: options.parse,
        execute: (teamId, operation, commandId, raw) =>
          options.runtime.executeMemberAction!(teamId, operation, commandId, raw),
      })
    );
  return methods;
}
