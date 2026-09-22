import {
  getCliProviderExtensionCapability,
  isCliExtensionCapabilityAvailable,
} from './providerExtensionCapabilities';

import type { TeamProviderId } from '@shared/types';
import type { CliInstallationStatus } from '@shared/types';
import type { SkillRootKind } from '@shared/types/extensions';

export type SkillAudience = 'shared' | 'codex';

export interface SkillRootDefinition {
  rootKind: SkillRootKind;
  directoryName: `.${string}`;
  segments: [string, 'skills'];
  audience: SkillAudience;
}

export const SKILL_ROOT_DEFINITIONS: readonly SkillRootDefinition[] = [
  {
    rootKind: 'claude',
    directoryName: '.claude',
    segments: ['.claude', 'skills'],
    audience: 'shared',
  },
  {
    rootKind: 'cursor',
    directoryName: '.cursor',
    segments: ['.cursor', 'skills'],
    audience: 'shared',
  },
  {
    rootKind: 'agents',
    directoryName: '.agents',
    segments: ['.agents', 'skills'],
    audience: 'shared',
  },
  {
    rootKind: 'codex',
    directoryName: '.codex',
    segments: ['.codex', 'skills'],
    audience: 'codex',
  },
] as const;

export function getSkillRootDefinition(rootKind: SkillRootKind): SkillRootDefinition {
  return SKILL_ROOT_DEFINITIONS.find((definition) => definition.rootKind === rootKind)!;
}

export function formatSkillRootKind(rootKind: SkillRootKind): string {
  return getSkillRootDefinition(rootKind).directoryName;
}

export function getSkillAudience(rootKind: SkillRootKind): SkillAudience {
  return getSkillRootDefinition(rootKind).audience;
}

export function getSkillAudienceLabel(rootKind: SkillRootKind): string {
  return getSkillAudience(rootKind) === 'codex' ? 'Codex only' : 'Shared';
}

export function isSkillAvailableForProvider(
  rootKind: SkillRootKind,
  providerId?: TeamProviderId
): boolean {
  return getSkillAudience(rootKind) === 'shared' || providerId === 'codex';
}

export function isCodexSkillOverlayAvailable(
  cliStatus: Pick<CliInstallationStatus, 'flavor' | 'providers'> | null | undefined
): boolean {
  if (cliStatus?.flavor !== 'agent_teams_orchestrator') {
    return false;
  }

  const codexProvider = cliStatus.providers.find((provider) => provider.providerId === 'codex');
  if (!codexProvider?.supported) {
    return false;
  }

  return isCliExtensionCapabilityAvailable(
    getCliProviderExtensionCapability(codexProvider, 'skills')
  );
}
