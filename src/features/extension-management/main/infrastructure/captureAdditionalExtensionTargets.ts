import { realpath } from 'node:fs/promises';

import { buildPassiveProviderStatusCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { discoverTargets } from '@uap/management-sdk/node';

import { canonicalExtensionPath } from './captureAuthoringRoots';
import { resolveUapExecutable } from './resolveUapExecutable';

import type { UnavailableExtensionTarget } from '../../contracts';

export interface CapturedExtensionTarget {
  id: string;
  client: string;
  configRoot: string;
  executable?: string;
  detectionStatus?: 'detected' | 'not_detected';
}

/** Go owns detection and support policy; these observations cannot expand local authoring roots. */
export async function captureAdditionalExtensionTargets(
  resourceRoot: string,
  primaryClients: readonly string[]
) {
  const { env } = buildPassiveProviderStatusCliEnv({});
  const discovered = await discoverTargets({
    executable: await resolveUapExecutable(resourceRoot),
    env,
  });
  const profiles: CapturedExtensionTarget[] = [];
  const unavailableTargets: UnavailableExtensionTarget[] = [];
  const labels: Record<string, string> = {};
  const clients = new Set(primaryClients);
  const ids = new Set(primaryClients);
  for (const observation of discovered.targets) {
    if (primaryClients.includes(observation.client)) continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(observation.client) || clients.has(observation.client))
      throw new Error('The extension manager returned an invalid native client inventory.');
    clients.add(observation.client);
    const profile = observation.profile;
    if (!profile) {
      if (observation.detectionStatus === 'detected')
        unavailableTargets.push({
          client: observation.client,
          label: observation.label,
          reason:
            observation.reason || 'This native client is not available for managed installation.',
        });
      continue;
    }
    if (profile.client !== observation.client || ids.has(profile.id))
      throw new Error('The extension manager returned an inconsistent native target identity.');
    ids.add(profile.id);
    labels[profile.client] = observation.label;
    profiles.push({
      id: profile.id,
      client: profile.client,
      configRoot: await canonicalExtensionPath(profile.configRoot),
      ...(profile.executable ? { executable: await realpath(profile.executable) } : {}),
      detectionStatus: observation.detectionStatus,
    });
  }
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  unavailableTargets.sort((left, right) => left.client.localeCompare(right.client));
  return { profiles, unavailableTargets, labels };
}
