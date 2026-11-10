import type { CliProviderId, TeamProviderId } from '@shared/types';

export const OPENCODE_EXTENSION_BOUND_TEAM_LAUNCH_UNAVAILABLE_REASON =
  'This extension-backed OpenCode route is not supported by the current Agent Teams launch runtime. Choose another OpenCode model.';

export function getUnsupportedTeamModelRouteReason(
  providerId: CliProviderId | TeamProviderId | undefined,
  model: string | undefined
): string | null {
  const sourceId = model?.trim().toLowerCase().split('/', 1)[0];
  return providerId === 'opencode' && (sourceId === 'cursor-acp' || sourceId === 'kiro')
    ? OPENCODE_EXTENSION_BOUND_TEAM_LAUNCH_UNAVAILABLE_REASON
    : null;
}
