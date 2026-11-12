import { ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';
import { OpenCodeV2CredentialScope } from './OpenCodeV2CredentialScope.js';
import { OpenCodeV2ManagementHost, openCodeV2KeyNamespace } from './OpenCodeV2ManagementHost.js';
import { createOpenCodeV2ModelProbe } from './OpenCodeV2ModelProbe.js';

import type { CredentialCommand, CredentialProgressWriter } from '../../management/CredentialCommandOwner.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { OpenCodeV2CredentialProgress } from '../../management/openCodeV2CredentialRecord.js';
import type { RegisteredProcessRootSource } from '../../process/registeredProcessContracts.js';

const held = (): never => { throw new ManagementCommandError('held'); };

/** One native mechanism below CredentialCommandOwner's existing durable intent and resource fence. */
export function createOpenCodeV2CredentialOperation(
  profile: OpenCodeManagementProfile,
  command: Extract<CredentialCommand, { kind: 'credential.set' }>,
  progress: CredentialProgressWriter,
  isCurrent: () => boolean,
  options: { processCustody?: RegisteredProcessRootSource; replaceAuthDigest?: string } = {},
) {
  if (profile.nativeGeneration !== 'v2' || !profile.embedded || !profile.nativeModel ||
      command.metadata && Object.keys(command.metadata).length) throw new ManagementCommandError('invalid');
  const abort = new AbortController();
  let sealed = false, cleanupUnknown = false, probe: ReturnType<typeof createOpenCodeV2ModelProbe> | undefined;
  let running: Promise<{ ok: boolean; settled: boolean; rejected?: boolean }> | undefined;
  let closing: Promise<boolean> | undefined;
  const ownerCurrent = () => !sealed && !abort.signal.aborted && isCurrent();
  const scope = new OpenCodeV2CredentialScope(profile, command.providerId, ownerCurrent);
  const publication = scope.prepare(command.key, options.replaceAuthDigest);
  let auth = publication.before;
  const current = () => ownerCurrent() && auth.isCurrent();
  const check = () => { if (!current()) held(); };
  const host = new OpenCodeV2ManagementHost(profile, current, options.processCustody, {
    retainedCommandId: command.commandId,
  });
  async function close(): Promise<boolean> {
    sealed = true;
    abort.abort();
    return closing ??= (async () => {
      const results = await Promise.allSettled([host.close(), probe?.close() ?? Promise.resolve(true)]);
      return !cleanupUnknown && results.every(row => row.status === 'fulfilled' && row.value);
    })();
  }
  async function run(): Promise<{ ok: boolean; settled: boolean; rejected?: boolean }> {
    let ok = false, rejected = false;
    try {
      check();
      let saved: OpenCodeV2CredentialProgress | undefined;
      const selectedModel = await host.keyOperation(command.providerId, async native => {
        check();
        const before = await native.read();
        check();
        if (!before.plainKey || before.connections.length) { rejected = true; return held(); }
        saved = { phase: 'key-intent', integrationId: native.integrationId,
          nativeNamespace: openCodeV2KeyNamespace(profile, command.commandId), beforeAuthDigest: auth.digest };
        progress(saved);
        const connected = await native.connectKey(command.key);
        check();
        saved = { ...saved, phase: 'key-connected', credentialId: connected.credentialId };
        progress(saved);
        try { auth = publication.publish(); }
        catch (error) {
          // This exact client alone observed empty-before/single-after ownership.
          try { await native.rollbackOwnedKey(); } catch { cleanupUnknown = true; }
          throw error;
        }
        saved = { ...saved, phase: 'key-published', authDigest: auth.digest };
        progress(saved);
        const catalog = await native.readCatalog();
        check();
        const models = catalog.models.filter(model => model.enabled);
        const chosen = models.find(model => profile.nativeModel!.providerId === command.providerId &&
          model.id === profile.nativeModel!.modelId) ?? models.find(model => model.supportsTools);
        if (!catalog.provider || !chosen) return held();
        return chosen.id;
      });
      if (!await host.close()) { cleanupUnknown = true; held(); }
      check();
      const verification = { commandId: 'connect-verify-' + managementDigest(command.commandId).slice(0, 48),
        modelId: command.providerId + '/' + selectedModel };
      saved = { ...saved!, phase: 'probe-intent', verification };
      progress(saved);
      const { providerConfiguration, ...embedded } = profile.embedded!;
      const probeProfile: OpenCodeManagementProfile = { ...profile,
        nativeModel: { providerId: command.providerId, modelId: selectedModel },
        embedded: { ...embedded,
          ...(providerConfiguration && profile.nativeModel!.providerId === command.providerId ? { providerConfiguration } : {}) },
      };
      probe = createOpenCodeV2ModelProbe(probeProfile, { ...verification,
        profileId: profile.profileId, configRevision: profile.configRevision, providerId: command.providerId },
      current, options.processCustody ? { processCustody: options.processCustody } : {});
      ok = await probe.run(abort.signal);
      check();
      if (!await probe.close()) { cleanupUnknown = true; held(); }
      progress({ ...saved, phase: 'probe-completed', verification: { ...verification, ok } });
      // Only a qualified failed terminal permits a later explicit Connect. A
      // boolean false or confirmed process cleanup alone cannot permit replay.
      rejected = !ok && probe.wasRejected();
    } catch { ok = false; }
    const settled = await close();
    return { ok, settled, ...(rejected && settled ? { rejected: true } : {}) };
  }
  return { run: () => (running ??= run()), close };
}
