import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamOwnerError } from '../team/contracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { HostScheduledRuns } from './HostScheduledRuns.js';
import { envelopeSchema, equalFields, json } from './teamHostEnvelope.js';
import { scheduledRunInputSchema, scheduledRunKeySchema } from './scheduledRunContracts.js';
import type { HostMethod } from '../index.js';
import type { HostedTeam } from './MemberEntry.js';

/** Main-only schedule facade. No renderer generic-operation or MCP registration. */
export function createHostScheduledRunComposition(options: ConstructorParameters<typeof HostScheduledRuns>[0] & {
  teams: ReadonlyMap<string, HostedTeam>;
}) {
  const runs = new HostScheduledRuns(options), methods: Record<string, HostMethod> = {};
  for (const operation of ['start', 'read', 'cancel'] as const)
    methods[`schedule.run.${operation}`] = {
      lane: operation === 'start' ? 'work' : 'control',
      async handle(raw) {
        try {
          options.assertWriter();
          const input = envelopeSchema.parse(raw), team = options.teams.get(input.binding.scope.teamId);
          if (!team || !equalFields(input.binding.owner, options.profile.owner) ||
              !equalFields(input.binding.scope, team.definition.scope)) throw new RuntimeOwnerError('forbidden');
          if (operation === 'start') {
            const selected = scheduledRunInputSchema.parse(input.payload);
            if (selected.runId !== input.commandId) throw new RuntimeOwnerError('conflict');
            return { ok: true, value: json(runs.start(team, selected)) };
          }
          const { runId, scheduleId } = scheduledRunKeySchema.parse(input.payload);
          return { ok: true, value: json(operation === 'read' ? runs.read(team, runId, scheduleId) : await runs.cancel(team, runId, scheduleId)) };
        } catch (error) {
          const code = error instanceof RuntimeOwnerError || error instanceof TeamOwnerError || error instanceof TeamLaunchError
            ? error.code : error instanceof z.ZodError ? 'invalid' : 'hold';
          return { ok: false, code, outcome: code === 'hold' ? 'unknown' : 'rejected' };
        }
      },
    };
  return { methods, seal: () => runs.seal(), close: () => runs.close() };
}
