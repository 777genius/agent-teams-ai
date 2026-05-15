import { rankCommandItems } from '../domain/policies/rankCommandItems';

import type { CommandContext } from '../domain/models/CommandContext';
import type { CommandItem } from '../domain/models/CommandItem';
import type { CommandProvider } from '../domain/models/CommandProvider';
import type { CommandProviderItems } from '../domain/policies/rankCommandItems';

export interface CommandProviderFailure {
  providerId: string;
  phase: 'sync' | 'async';
  error: unknown;
}

export interface ResolveCommandPaletteItemsInput {
  query: string;
  context: CommandContext;
  providers: readonly CommandProvider[];
  signal: AbortSignal;
  limit?: number;
}

export interface ResolveCommandPaletteItemsResult {
  items: readonly CommandItem[];
  failures: readonly CommandProviderFailure[];
  aborted: boolean;
}

const ABORTED = Symbol('command-palette-aborted');

function isAbortedResult(value: CommandProviderItems | typeof ABORTED): value is typeof ABORTED {
  return value === ABORTED;
}

function waitForAbort(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) {
    return Promise.resolve(ABORTED);
  }

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
}

async function resolveProviderItems(
  provider: CommandProvider,
  providerIndex: number,
  query: string,
  context: CommandContext,
  signal: AbortSignal,
  failures: CommandProviderFailure[]
): Promise<CommandProviderItems | typeof ABORTED> {
  if (signal.aborted) {
    return ABORTED;
  }

  const items: CommandItem[] = [];
  try {
    items.push(...provider.match(query, context));
  } catch (error) {
    failures.push({ providerId: provider.id, phase: 'sync', error });
  }

  if (provider.matchAsync && !signal.aborted) {
    try {
      const asyncItems = await Promise.race([
        provider.matchAsync(query, context, signal),
        waitForAbort(signal),
      ]);
      if (asyncItems === ABORTED || signal.aborted) {
        return ABORTED;
      }
      items.push(...asyncItems);
    } catch (error) {
      if (signal.aborted) {
        return ABORTED;
      }
      failures.push({ providerId: provider.id, phase: 'async', error });
    }
  }

  return { providerIndex, items };
}

export async function resolveCommandPaletteItems({
  query,
  context,
  providers,
  signal,
  limit,
}: ResolveCommandPaletteItemsInput): Promise<ResolveCommandPaletteItemsResult> {
  const failures: CommandProviderFailure[] = [];
  const buckets = await Promise.all(
    providers.map((provider, providerIndex) =>
      resolveProviderItems(provider, providerIndex, query, context, signal, failures)
    )
  );

  if (signal.aborted || buckets.some(isAbortedResult)) {
    return {
      items: [],
      failures,
      aborted: true,
    };
  }

  const providerBuckets = buckets.filter(
    (bucket): bucket is CommandProviderItems => !isAbortedResult(bucket)
  );

  return {
    items: rankCommandItems(query, providerBuckets, limit).map((entry) => entry.item),
    failures,
    aborted: false,
  };
}
