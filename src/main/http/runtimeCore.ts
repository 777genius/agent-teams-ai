import type { HttpServices } from './index';
import type {
  RuntimeCoreProviderJsonParsingServices,
  RuntimeCoreTeamUseCases,
} from '@features/runtime-core/main';

export function getHttpProviderJsonParsingServices(
  services: HttpServices
): RuntimeCoreProviderJsonParsingServices {
  return services.runtimeCore?.providerJsonParsing ?? services;
}

export function getHttpTeamUseCases(services: HttpServices): RuntimeCoreTeamUseCases | null {
  return services.runtimeCore?.teams ?? null;
}
