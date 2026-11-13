import { randomUUID } from 'node:crypto';

import { openCodeManagedPreferencesDigest } from '@agent-teams/legacy-agent-host/runtime-sources';

import { CapturedRuntimeSourceError } from '../infrastructure/CapturedRuntimeSources';

import type { CapturedRuntimeSources } from '../infrastructure/CapturedRuntimeSources';
import type { RuntimeSourcePublication } from '@agent-teams/legacy-agent-host/runtime-sources';

/** Existing management Save/Refresh keeps one original source owner and its durable publication. */
export async function refreshCapturedRuntimeConfiguration(sources: CapturedRuntimeSources) {
  let current = await sources.current();
  if (current.configurationCurrent === undefined && !sources.capturePreferences) return current;
  const recovered = await sources.recover();
  if (recovered && recovered.phase !== 'published')
    throw new CapturedRuntimeSourceError(recovered.reason ?? 'native-outcome-unknown');
  if (recovered) current = await sources.current();
  const preferences = await sources.capturePreferences?.();
  const preferencesDigest = preferences && openCodeManagedPreferencesDigest(preferences);
  if (current.configurationCurrent !== false &&
      (!preferences || current.preferencesDigest === preferencesDigest)) return current;
  const commandId = randomUUID();
  let result: RuntimeSourcePublication;
  try {
    result = await sources.refreshConfiguration({ commandId, expectedRevision: current.revision,
      ...(preferences ? { openCodePreferences: preferences } : {}) });
  } catch (error) {
    // Lookup only this original intent after lost ACK; never adopt a later available selection.
    const original = await sources.lookup(commandId);
    if (!original) throw error;
    result = original;
  }
  if (result.phase !== 'published' || !result.selection)
    throw new CapturedRuntimeSourceError(result.reason ?? 'native-outcome-unknown');
  return result.selection;
}
