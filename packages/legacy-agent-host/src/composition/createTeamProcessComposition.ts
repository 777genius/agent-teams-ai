import { z } from 'zod';
import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { createTeamProcessMethods } from '../process/createTeamProcessMethods.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RegisteredProcessNative } from '../process/registeredProcessContracts.js';
const bindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    handleId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes('\0')),
    owner: z.unknown(),
    scope: z.unknown(),
  })
  .strict();
/** Product process owner + private cold kernel adapter. No path/PID/token adoption from UI. */
export function createTeamProcessComposition(options: {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId'>;
  teams: ReadonlyMap<string, HostedTeam>;
  assertCurrent(): void;
  native?: Pick<RegisteredProcessNative, 'observe' | 'signal'>;
}) {
  return {
    methods: createTeamProcessMethods({
      resolve(raw) {
        options.assertCurrent();
        const parsed = bindingSchema.safeParse(raw);
        if (!parsed.success) throw new TeamOwnerError('invalid');
        const binding = parsed.data;
        const scope = binding.scope as { teamId?: string } | null;
        const selected =
          scope && typeof scope.teamId === 'string' ? options.teams.get(scope.teamId) : undefined;
        if (
          !selected ||
          digest(binding.owner) !== digest(options.profile.owner) ||
          digest(binding.scope) !== digest(selected.definition.scope)
        )
          throw new TeamOwnerError('forbidden');
        const commands = selected.owner.processCommands(options.profile.principalId, {
          assertCurrent: options.assertCurrent,
          ...(options.native
            ? {
                native: {
                  capture() {
                    throw new TeamOwnerError('forbidden');
                  },
                  observe(capture) {
                    options.assertCurrent();
                    const observed = options.native!.observe(capture);
                    options.assertCurrent();
                    return observed;
                  },
                  signal(capture) {
                    options.assertCurrent();
                    return options.native!.signal(capture);
                  },
                },
              }
            : {}),
        });
        return { commands, assertCurrent: options.assertCurrent };
      },
    }),
  };
}
