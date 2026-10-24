import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import type { JsonValue } from '../contracts.js';
import type { HostMethod } from '../index.js';
import type { RuntimeMemberActionOperation } from './executeRuntimeMemberAction.js';
/** Uses the same strict captured envelope parser as existing Runtime routes. */
export function createTeamMemberActionMethods(options: {
  parse(raw: unknown): { teamId: string; commandId: string; payload: unknown };
  execute(
    teamId: string,
    operation: RuntimeMemberActionOperation,
    commandId: string,
    raw: unknown
  ): Promise<unknown>;
}): Record<string, HostMethod> {
  const names = {
    'team.member.action.prepare': 'prepare',
    'team.member.action.execute': 'execute',
    'team.member.actions.read': 'read',
    'team.member.action.lookup': 'lookup',
  } as const;
  return Object.fromEntries(
    Object.entries(names).map(([name, operation]) => [
      name,
      {
        lane: operation === 'execute' ? 'work' : 'control',
        async handle(raw: unknown): Promise<JsonValue> {
          try {
            const input = options.parse(raw);
            const value = await options.execute(
              input.teamId,
              operation,
              input.commandId,
              input.payload
            );
            return { ok: true, value: JSON.parse(JSON.stringify(value)) as JsonValue };
          } catch (error) {
            const code =
              error instanceof RuntimeOwnerError ||
              error instanceof TeamOwnerError ||
              error instanceof TeamLaunchError
                ? error.code
                : error instanceof z.ZodError
                  ? 'invalid'
                  : 'hold';
            return {
              ok: false,
              code,
              outcome: operation === 'execute' || code === 'hold' ? 'unknown' : 'rejected',
            };
          }
        },
      },
    ])
  );
}
