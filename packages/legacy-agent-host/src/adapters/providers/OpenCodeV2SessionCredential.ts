import { createOpenCodeV2CredentialClient } from '@agent-teams/provider-implementations/opencode';

import { ManagementCommandError } from '../../management/commandRecords.js';
import { isOpenCodeV2ConfigurationKey, isOpenCodeV2DeferredConfigurationKey,
  OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';
import type { CapturedOpenCodeV2Key } from './OpenCodeV2CredentialScope.js';
import type { AcceptedOpenCodeV2FileKey, DeferredOpenCodeV2FileKey } from './OpenCodeV2SelectedFileKey.js';
import type { createOpenCodeV2EmbeddedServer } from './OpenCodeV2EmbeddedServer.js';

import type {
  createOpenCodeV2OwnedSessionClient,
  OpenCodeV2OwnedSessionSelection,
  OpenCodeV2TransportConfig,
} from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

type NativeClient = ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
type Witness = OpenCodeV2OwnedSessionSelection['credential'];
type CredentialTransport = Omit<OpenCodeV2TransportConfig, 'nativeSessionId'>;
type NativeFileBinding = ReturnType<ReturnType<typeof createOpenCodeV2EmbeddedServer>['selectedFileKey']>;
const held = (): never => { throw new ManagementCommandError('held'); };

/** Captures the existing auth source before allocation. No app credential journal or prompt marker. */
export function captureOpenCodeV2SessionCredential(
  profile: Pick<OpenCodeManagementProfile, 'environment' | 'accountBinding'>,
  providerId: string,
  isCurrent: () => boolean,
  selectedKey?: CapturedOpenCodeV2Key,
  selectedFile?: DeferredOpenCodeV2FileKey,
  observePhase?: (phase: `credential-${'catalog' | 'directory' | 'connect' | 'restore' | 'dispose'}-${'start' | 'returned'}`) => void,
) {
  const observe = (phase: Parameters<NonNullable<typeof observePhase>>[0]) => {
    try { observePhase?.(phase); } catch { /* Passive diagnostics cannot replace credential or cleanup results. */ }
  };
  if (selectedKey !== undefined && !isOpenCodeV2ConfigurationKey(selectedKey, profile, providerId, isCurrent)) held();
  if (selectedFile !== undefined && (selectedKey !== undefined ||
      !isOpenCodeV2DeferredConfigurationKey(selectedFile, profile, providerId, isCurrent))) held();
  const captured = selectedFile ? undefined : selectedKey ?? new OpenCodeV2CredentialScope(profile, providerId, isCurrent).capture();
  let prepared: Promise<Witness> | undefined;
  let fileProof: AcceptedOpenCodeV2FileKey | undefined;
  const current = selectedFile ? () => selectedFile.isCurrent() && (fileProof?.filesCurrent() ?? true) : captured!.isCurrent;
  const check = () => { if (!current()) held(); };
  async function prepare(config: CredentialTransport, owner: NativeClient, restored?: Awaited<ReturnType<NativeClient['readSession']>>,
    nativeFile?: (integrationId: string) => NativeFileBinding): Promise<Witness> {
    check();
    if (!selectedFile && !captured!.present) {
      if (restored?.credential !== undefined) return held();
      return undefined;
    }
    if (!selectedFile && restored && restored.credential?.scopeDigest !== captured!.digest) return held();
    observe('credential-catalog-start');
    const catalog = await owner.readCatalog(providerId);
    observe('credential-catalog-returned');
    check();
    let integrationId: string | undefined;
    if (catalog.provider?.integrationId === undefined) {
      observe('credential-directory-start');
      const directory = await owner.readDirectory();
      observe('credential-directory-returned');
      integrationId = directory.integrations.find(row => row.id === providerId)?.id;
    } else integrationId = catalog.provider.integrationId;
    if (!integrationId) return held();
    const source = selectedFile ? nativeFile?.(integrationId) : undefined;
    if (selectedFile && !source) return held();
    const acceptProof = (proof: Parameters<NativeFileBinding['acceptProof']>[0]): undefined => {
      if (!source) return held();
      fileProof = source.acceptProof(proof);
      return undefined;
    };
    const key = createOpenCodeV2CredentialClient({ ...config, version: '2.1.4', integrationId });
    let witness: Witness, failure: unknown, failed = false;
    try {
      if (restored) {
        observe('credential-restore-start');
        const observed = source ? await key.readSelectedSource(source.reference, acceptProof) : await key.read(), connection = observed.connections[0];
        observe('credential-restore-returned');
        if (source && (!fileProof || fileProof.scopeDigest !== restored.credential?.scopeDigest)) return held();
        if (!observed.plainKey || observed.connections.length !== 1 || connection?.type !== 'credential' ||
            connection.method !== 'key' || connection.id !== restored.credential?.credentialId) return held();
        witness = restored.credential;
      } else {
        observe('credential-connect-start');
        const connected = source ? await key.connectSelectedSource(source.reference, acceptProof) : await key.connectKey(captured!.readKey()!);
        observe('credential-connect-returned');
        if (source && !fileProof) return held();
        witness = { scopeDigest: source ? fileProof!.scopeDigest : captured!.digest, credentialId: connected.credentialId };
      }
      check();
    } catch (error) { failed = true; failure = error; }
    try {
      observe('credential-dispose-start');
      await key.dispose();
      observe('credential-dispose-returned');
    } catch (error) { failed = true; failure = error; }
    if (failed) throw failure;
    check();
    return witness;
  }
  return Object.freeze({
    isAbsent: () => {
      try { return selectedFile === undefined && captured?.present === false && current(); }
      catch { return false; }
    },
    isCurrent: current,
    fileProof: () => fileProof,
    prepare: (config: CredentialTransport, owner: NativeClient,
      restored?: Awaited<ReturnType<NativeClient['readSession']>>,
      nativeFile?: (integrationId: string) => NativeFileBinding) =>
      (prepared ??= prepare(config, owner, restored, nativeFile)),
  });
}
