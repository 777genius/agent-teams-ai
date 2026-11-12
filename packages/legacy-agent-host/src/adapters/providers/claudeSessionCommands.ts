import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { NativeSessionCommandCapability } from '../../team/nativeSessionCommand.js';

type Commands = Parameters<NonNullable<ClaudeConfig['observeCommands']>>[0];

/** The native Query owns skills and precedence; this adapter admits only proved builtin families. */
export function claudeSessionCommands(
  commands: Commands
): readonly NativeSessionCommandCapability[] {
  const names = new Set(commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const result: NativeSessionCommandCapability[] = [];
  for (const name of names) {
    const exact = commands.filter((command) => command.name === name);
    const aliases = exact.length
      ? []
      : commands.filter((command) => command.aliases?.includes(name));
    const selected =
      exact.find((command) => command.builtin) ??
      exact[0] ??
      (aliases.length === 1 ? aliases[0] : undefined);
    if (!selected || (selected.builtin && !['compact', 'cost', 'review'].includes(name))) continue;
    result.push({ name, description: selected.description });
  }
  return Object.freeze(result.map((command) => Object.freeze(command)));
}
