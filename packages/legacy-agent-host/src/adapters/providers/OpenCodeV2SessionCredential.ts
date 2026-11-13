import { createOpenCodeV2CredentialClient } from '@agent-teams/provider-implementations/opencode';

import { ManagementCommandError } from '../../management/commandRecords.js';
import { OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';

import type {
  createOpenCodeV2OwnedSessionClient,
  OpenCodeV2OwnedSessionSelection,
  OpenCodeV2TransportConfig,
} from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

type NativeClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
type Witness = OpenCodeV2OwnedSessionSelection['credential'];
type CredentialTransport = Omit<OpenCodeV2TransportConfig, 'nativeSessionId'>;
const held = (): never => { throw new ManagementCommandError('held'); };

/** Captures the existing auth source before allocation. No app credential journal or prompt marker. */
export function captureOpenCodeV2SessionCredential(
  profile: Pick<OpenCodeManagementProfile, 'environment' | 'accountBinding'>,
  providerId: string,
  isCurrent: () => boolean,
) {
  const captured = new OpenCodeV2CredentialScope(profile, providerId, isCurrent).capture();
  let prepared: Promise<Witness> | undefined;
  const current = captured.isCurrent;
  const check = () => { if (!current()) held(); };
  async function prepare(config: CredentialTransport, owner: NativeClient, restored?: Awaited<ReturnType<NativeClient['readSession']>>): Promise<Witness> {
    check();
    if (!captured.present) {
      if (restored?.credential !== undefined) return held();
      return undefined;
    }
    if (restored && restored.credential?.scopeDigest !== captured.digest) return held();
    const catalog = await owner.readCatalog(providerId);
    check();
    const integrationId = catalog.provider?.integrationId ??
      (await owner.readDirectory()).integrations.find(row => row.id === providerId)?.id;
    if (!integrationId) return held();
    const key = createOpenCodeV2CredentialClient({ ...config, version: '2.1.4', integrationId });
    let witness: Witness, failure: unknown, failed = false;
    try {
      if (restored) {
        const observed = await key.read(), connection = observed.connections[0];
        if (!observed.plainKey || observed.connections.length !== 1 || connection?.type !== 'credential' ||
            connection.method !== 'key' || connection.id !== restored.credential?.credentialId) return held();
        witness = restored.credential;
      } else {
        const connected = await key.connectKey(captured.readKey()!);
        witness = { scopeDigest: captured.digest, credentialId: connected.credentialId };
      }
      check();
    } catch (error) { failed = true; failure = error; }
    try { await key.dispose(); } catch (error) { failed = true; failure = error; }
    if (failed) throw failure;
    check();
    return witness;
  }
  return Object.freeze({
    isCurrent: current,
    prepare: (config: CredentialTransport, owner: NativeClient,
      restored?: Awaited<ReturnType<NativeClient['readSession']>>) =>
      (prepared ??= prepare(config, owner, restored)),
  });
}
