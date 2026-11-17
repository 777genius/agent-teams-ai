import type { NativeNextPromptProvider } from '../contracts';

/** The per-provider switch stored in each provider's connection settings. */
export interface NativeNextPromptFlag {
  nativeNextPromptSuggestionsEnabled: boolean;
}
interface Connections {
  readonly anthropic: NativeNextPromptFlag;
  readonly codex: NativeNextPromptFlag;
}

/** The providers whose setting is on. Settings use the app names: anthropic means Claude. */
export function selectNativeNextPromptProviders(connections: {
  readonly anthropic?: Partial<NativeNextPromptFlag>;
  readonly codex?: Partial<NativeNextPromptFlag>;
}): NativeNextPromptProvider[] {
  return [
    ...(connections.anthropic?.nativeNextPromptSuggestionsEnabled === true
      ? (['claude'] as const)
      : []),
    ...(connections.codex?.nativeNextPromptSuggestionsEnabled === true ? (['codex'] as const) : []),
  ];
}

/**
 * Keep an explicit boolean from `source`, otherwise the fallback's value. A malformed persisted or
 * renderer-provided value is never coerced, so only a real `false` turns a provider off.
 */
export function withNativeNextPromptFlags<T extends { anthropic: object; codex: object }>(
  connections: T,
  source: { readonly anthropic?: unknown; readonly codex?: unknown } | undefined,
  fallback: Connections
): T & Connections {
  const choose = (provider: 'anthropic' | 'codex'): boolean => {
    const value = (source?.[provider] as Partial<NativeNextPromptFlag> | undefined)
      ?.nativeNextPromptSuggestionsEnabled;
    return typeof value === 'boolean'
      ? value
      : fallback[provider].nativeNextPromptSuggestionsEnabled;
  };
  return {
    ...connections,
    anthropic: {
      ...connections.anthropic,
      nativeNextPromptSuggestionsEnabled: choose('anthropic'),
    },
    codex: { ...connections.codex, nativeNextPromptSuggestionsEnabled: choose('codex') },
  };
}
