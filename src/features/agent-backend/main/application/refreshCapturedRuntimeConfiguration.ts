import { randomUUID } from 'node:crypto';

import { openCodeManagedPreferencesDigest } from '@agent-teams/legacy-agent-host/runtime-sources';

import { CapturedRuntimeSourceError } from '../infrastructure/CapturedRuntimeSources';

import { BackendRoutingError } from './backendBinding';

import type { CapturedRuntimeSources } from '../infrastructure/CapturedRuntimeSources';
import type { RuntimeSourcePublication } from '@agent-teams/legacy-agent-host/runtime-sources';

const preparations = new WeakMap<object, { tail: Promise<unknown>; pending: number }>();

/** Existing management Save/Refresh keeps one original source owner and its durable publication. */
export async function refreshCapturedRuntimeConfiguration(
  sources: CapturedRuntimeSources,
  selection?: object
) {
  if (!selection) return refreshConfiguration(sources);
  const queue = preparations.get(selection) ?? { tail: Promise.resolve(), pending: 0 };
  if (queue.pending >= 32) throw new BackendRoutingError('hold', 'not-dispatched');
  // Serialize preparation only. Every caller keeps its own original source and guard.
  const pending = queue.tail.catch(() => {}).then(() => refreshConfiguration(sources));
  queue.tail = pending;
  queue.pending++;
  preparations.set(selection, queue);
  try {
    return await pending;
  } finally {
    if (--queue.pending === 0 && preparations.get(selection) === queue)
      preparations.delete(selection);
  }
}

async function refreshConfiguration(sources: CapturedRuntimeSources) {
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
