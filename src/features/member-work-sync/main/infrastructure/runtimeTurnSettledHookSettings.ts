import type { RuntimeTurnSettledProvider } from '../../core/domain';

export const MEMBER_WORK_SYNC_TURN_SETTLED_HOOK_MARKER =
  'agent-teams:member-work-sync-turn-settled:v1';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRuntimeTurnSettledHookCommand(input: {
  scriptPath: string;
  spoolRoot: string;
  provider: RuntimeTurnSettledProvider;
  maxBytes?: number;
}): string {
  return [
    '/bin/sh',
    shellQuote(input.scriptPath),
    shellQuote(input.spoolRoot),
    shellQuote(input.provider),
    shellQuote(String(input.maxBytes ?? 262_144)),
    '#',
    MEMBER_WORK_SYNC_TURN_SETTLED_HOOK_MARKER,
  ].join(' ');
}

export function buildRuntimeTurnSettledHookSettings(input: {
  scriptPath: string;
  spoolRoot: string;
  provider: RuntimeTurnSettledProvider;
  maxBytes?: number;
}): Record<string, unknown> {
  return {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: buildRuntimeTurnSettledHookCommand(input),
            },
          ],
        },
      ],
    },
  };
}
