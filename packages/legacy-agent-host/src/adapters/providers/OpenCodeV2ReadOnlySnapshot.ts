import { createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';
import { awaitOpenCodeV2OwnerReadback } from './OpenCodeV2OwnerReadback.js';

import type { OpenCodeV2TransportConfig } from '@agent-teams/provider-implementations/opencode';

type OwnedClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
export type OpenCodeV2ReadOnlyClient = Pick<OwnedClient,
  'identity' | 'readSession' | 'readCatalog' | 'savedPermissionsEmpty' |
  'builtinPluginsOnly' | 'readMcp' | 'instructions'>;
interface SnapshotAuthority {
  assertCurrent(): void;
  assertCustody(signal: AbortSignal): Promise<void>;
  cleanupUnknown(): void;
}
const unavailable = (): never => { throw new Error('OpenCode V2 read snapshot unavailable'); };

/** One finite read pass for the same owned child. No bytes or native authority are cached. */
export async function readOpenCodeV2Snapshot<T>(
  supplied: OpenCodeV2TransportConfig,
  authority: SnapshotAuthority,
  callback: (client: OpenCodeV2ReadOnlyClient) => Promise<T>,
): Promise<T> {
  const config = { ...supplied }, checkOwner = authority.assertCurrent,
    fullCustody = authority.assertCustody, cleanupUnknown = authority.cleanupUnknown;
  if (!Number.isSafeInteger(config.deadline)) return unavailable();
  const deadline = Math.min(config.deadline, Date.now() + 30_000);
  if (Date.now() >= deadline) return unavailable();
  const controller = new AbortController();
  const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  let active = true, requests = 0, pendingReads = 0;
  const check = () => {
    signal.throwIfAborted(); checkOwner(); signal.throwIfAborted();
    if (Date.now() >= deadline) unavailable();
  };
  const checkLease = () => { if (!active) unavailable(); check(); };
  const attest = async () => {
    check();
    await awaitOpenCodeV2OwnerReadback(() => fullCustody(signal), signal);
    check();
  };
  const read = <R>(invoke: () => Promise<R>): Promise<R> => {
    const work = (async () => {
      checkLease(); pendingReads++;
      try { return await invoke(); } finally { pendingReads--; }
    })();
    // A borrowed function may be invoked without awaiting its refusal. It still
    // cannot issue I/O after settlement, and its rejection is always observed.
    void work.catch(() => undefined);
    return work;
  };
  try {
    await attest();
    const fetchImpl = config.fetchImpl ?? fetch, readPassword = config.readPassword;
    const client = createOpenCodeV2OwnedSessionClient({
      ...config, signal, deadline,
      beforeRequest: async requestSignal => {
        checkLease(); requestSignal.throwIfAborted();
        if (++requests > 16) unavailable();
      },
      readPassword: () => {
        checkLease(); const password = readPassword(); checkLease(); return password;
      },
      fetchImpl: (input, init) => {
        checkLease();
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method !== 'GET') return unavailable();
        return fetchImpl(input, init);
      },
    });
    // Actual methods, not only a narrower TypeScript view of the mutating client.
    const port: OpenCodeV2ReadOnlyClient = Object.freeze({
      identity: () => read(() => client.identity()),
      readSession: () => read(() => client.readSession()),
      readCatalog: (providerId: string) => read(() => client.readCatalog(providerId)),
      savedPermissionsEmpty: () => read(() => client.savedPermissionsEmpty()),
      builtinPluginsOnly: () => read(() => client.builtinPluginsOnly()),
      readMcp: () => read(() => client.readMcp()),
      instructions: () => read(() => client.instructions()),
    });
    let failed = false, failure: unknown, result!: T;
    try {
      result = await awaitOpenCodeV2OwnerReadback(() => callback(port), signal);
      if (pendingReads !== 0) unavailable();
      // All pinned read methods return finite DTOs. Never export a lazy stream,
      // promise or a borrowed native function across this snapshot boundary.
      result = structuredClone(result);
    } catch (error) { failed = true; failure = error; }
    finally { active = false; }
    try { await client.dispose(); }
    catch (error) {
      cleanupUnknown();
      if (!failed) { failed = true; failure = error; }
    }
    if (failed) throw failure;
    await attest();
    check();
    return result;
  } finally {
    active = false;
    clearTimeout(timer);
    controller.abort();
  }
}
