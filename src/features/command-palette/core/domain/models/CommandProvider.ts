import type { CommandContext } from './CommandContext';
import type { CommandItem } from './CommandItem';

export interface CommandProvider {
  id: string;
  match(this: void, query: string, context: CommandContext): readonly CommandItem[];
  matchAsync?(
    this: void,
    query: string,
    context: CommandContext,
    signal: AbortSignal
  ): Promise<readonly CommandItem[]>;
}
