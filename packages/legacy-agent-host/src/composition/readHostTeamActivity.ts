import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { readTeamActivity, summarizeTeamActivity } from './readTeamActivity.js';
import type { JsonValue } from '../contracts.js';
import type { TeamActivityReadOptions } from './readTeamActivity.js';
import type { HostedTeam } from './MemberEntry.js';

type ReadOptions = Omit<TeamActivityReadOptions, 'team' | 'taskCause'> & {
  team: HostedTeam | undefined;
};
const statsQuery = z
  .object({
    memberName: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/u.test(value)),
  })
  .strict();

/** Existing viewer authority and retained Task cause qualify these read-only Team queries. */
export function readHostTeamActivity(
  options: ReadOptions,
  kind: 'logs' | 'stats',
  raw: unknown
): JsonValue {
  try {
    options.assertCurrent();
    const { team } = options;
    if (!team) throw new TeamOwnerError('invalid');
    const query = kind === 'stats' ? statsQuery.parse(raw) : undefined;
    const logs = readTeamActivity(
      {
        ...options,
        team,
        taskCause: (intent) => team.owner.readTaskInputCause(options.principalId, intent),
      },
      query ?? raw
    );
    const result = query
      ? { kind: 'team-activity-stats', stats: summarizeTeamActivity(query.memberName, logs) }
      : { kind: 'team-activity-logs', logs };
    return JSON.parse(JSON.stringify(result)) as JsonValue;
  } catch (error) {
    if (error instanceof RuntimeOwnerError)
      throw new TeamOwnerError(error.code === 'busy' ? 'hold' : error.code);
    throw error;
  }
}
