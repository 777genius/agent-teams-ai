import { resolveAppLocale } from '../domain/localePolicy';

import type { AppLocalePreference, ResolvedAppLocale } from '../../contracts';

export interface ResolveRuntimeLocaleInput {
  readonly preference: AppLocalePreference;
  readonly systemLocale: string | null;
}

export function resolveRuntimeLocale(input: ResolveRuntimeLocaleInput): ResolvedAppLocale {
  return resolveAppLocale({
    preference: input.preference,
    systemLocale: input.systemLocale,
  });
}
