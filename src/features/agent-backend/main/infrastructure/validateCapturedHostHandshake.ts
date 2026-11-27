import {
  HOST_PROTOCOL_VERSION,
  hostProfileLimitCaps,
  resolveHostProfileLimits,
  TEAM_HOST_DISPOSE_TIMEOUT_MS,
} from '@agent-teams/legacy-agent-host/contracts';

import { HostClientError } from './selectedHostProfile';

import type { SelectedHostProfile } from './selectedHostProfile';
import type {
  HostHandshake,
  HostLimits,
  JsonValue,
} from '@agent-teams/legacy-agent-host/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCapturedHostHandshake(
  result: JsonValue,
  profile: SelectedHostProfile
): { handshake: HostHandshake; limits: HostLimits } {
  if (
    !isRecord(result) ||
    result.protocolVersion !== HOST_PROTOCOL_VERSION ||
    result.buildId !== profile.expectedBuildId ||
    typeof result.hostIncarnation !== 'string' ||
    !result.hostIncarnation ||
    !Array.isArray(result.capabilities) ||
    !result.capabilities.every((value) => typeof value === 'string') ||
    !result.capabilities.includes('transport.ndjson') ||
    !isRecord(result.limits)
  ) {
    throw new HostClientError('profile-mismatch', 'unknown');
  }
  try {
    const candidate = result.limits;
    if (profile.reviewTransport && !result.capabilities.includes('transport.review-v1'))
      throw new Error('capability');
    for (const [key, cap] of Object.entries(hostProfileLimitCaps(profile.reviewTransport))) {
      const maximum = key === 'disposeTimeoutMs' ? TEAM_HOST_DISPOSE_TIMEOUT_MS : cap;
      if (typeof candidate[key] !== 'number' || candidate[key] > maximum) throw new Error('limit');
    }
    const limits = resolveHostProfileLimits(
      profile.reviewTransport,
      candidate as unknown as HostLimits
    );
    if (limits.maxPriorityMessages <= limits.reservedControlRequests) throw new Error('limit');
    return { handshake: result as unknown as HostHandshake, limits };
  } catch {
    throw new HostClientError('protocol-error', 'unknown');
  }
}
