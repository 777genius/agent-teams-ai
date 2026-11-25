import type { NativeNextPromptProvider } from '@features/native-prompt-suggestions/contracts';

export interface NativePromptSettingsSelection {
  /** Compatibility input when the caller does not provide per-provider settings. */
  readonly nativeNextPromptEnabled?: boolean;
  readonly nativeNextPromptProviders?: readonly NativeNextPromptProvider[];
}

/** Immutable trusted Main startup settings, reused unchanged for explicit Host recovery. */
export function captureNativePromptSettings(selection: NativePromptSettingsSelection) {
  const explicit = selection.nativeNextPromptProviders !== undefined;
  const values = selection.nativeNextPromptProviders ??
    (selection.nativeNextPromptEnabled === true ? ['claude', 'codex'] as const : []);
  if (values.some(provider => provider !== 'claude' && provider !== 'codex') ||
      new Set(values).size !== values.length) throw new TypeError('Invalid native suggestion providers');
  const providers: readonly NativeNextPromptProvider[] = Object.freeze([...values]);
  return Object.freeze({
    providers,
    explicit,
    enabled: providers.length > 0,
    environment: Object.freeze({
      // A per-provider choice cannot enable every provider on an older boolean-only Host.
      AGENT_TEAMS_NATIVE_NEXT_PROMPT_ENABLED: !explicit && selection.nativeNextPromptEnabled === true ? '1' : '0',
      AGENT_TEAMS_NATIVE_NEXT_PROMPT_PROVIDERS: providers.join(','),
    }),
  });
}
