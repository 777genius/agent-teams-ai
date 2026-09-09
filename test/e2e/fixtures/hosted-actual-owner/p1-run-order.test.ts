import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_CAPTURE_NAMES } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { runDriver } from '../../../../scripts/e2e/hosted-actual-owner/driver';
import * as evidence from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import * as nativeCaptures from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import { P1AdmissionUnverified } from '../../../../scripts/e2e/hosted-actual-owner/p1-admission';
import { admitIntegration, closeAdmission, consumeOneRunAuthorization, readIntegrationDescriptor } from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import { run } from '../../../../scripts/e2e/hosted-actual-owner/run';
import { cleanupSandbox, createSandbox } from '../../../../scripts/e2e/hosted-actual-owner/sandbox';

import { legacyOpenCodeRecord, rewriteNative, selectionFixture } from './p1-repair.fixtures';
import { fixture, hex, peer, retainChanges } from './raw-http.fixtures';

import type { IntegrationDescriptor } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import type { PreflightAdmission } from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import type { DisposableSandbox } from '../../../../scripts/e2e/hosted-actual-owner/sandbox';
import type { WrittenFileEvidence } from '../../../../scripts/e2e/hosted-actual-owner/secure-files';
import type { HttpFixture } from './raw-http.fixtures';

// Only external execution/retention ports are replaced. The real run.ts, common preparation,
// native envelope/kernel parsers and writer checks execute. No fixture grants P1 admission.
vi.mock('../../../../scripts/e2e/hosted-actual-owner/driver', () => ({ runDriver: vi.fn() }));
vi.mock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({
  readIntegrationDescriptor: vi.fn(), admitIntegration: vi.fn(),
  consumeOneRunAuthorization: vi.fn(), closeAdmission: vi.fn(),
}));
vi.mock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({
  createSandbox: vi.fn(), cleanupSandbox: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function arrangeRun(input: HttpFixture) {
  const descriptor = { controllerNonce: input.controllerNonce } as IntegrationDescriptor;
  const admission = { descriptor, roots: { sandboxParent: {}, evidenceRoot: {} } } as PreflightAdmission;
  const close = vi.fn(async () => undefined);
  const sandbox = { runId: input.runId, handle: { close } } as unknown as DisposableSandbox;
  const { selection } = selectionFixture(input);
  vi.mocked(readIntegrationDescriptor).mockResolvedValue(descriptor);
  vi.mocked(admitIntegration).mockResolvedValue(admission);
  vi.mocked(consumeOneRunAuthorization).mockResolvedValue({} as WrittenFileEvidence);
  vi.mocked(createSandbox).mockResolvedValue(sandbox);
  vi.mocked(runDriver).mockResolvedValue({
    raw: input.raw, captures: input.captures, outcome: input.outcome, selectedLaunch: selection,
  });
  vi.mocked(cleanupSandbox).mockImplementation(async (_sandbox, remove) => {
    // A true call would destroy retained evidence; every rejection path must pass false.
    if (remove) throw new Error('unexpected_destructive_cleanup');
    return { disposition: 'preserved', runId: input.runId, path: '/test-only',
      markerVerified: false, zeroOwnedSurvivors: false, reason: 'owned_process_drain_unproven' };
  });
  vi.mocked(closeAdmission).mockResolvedValue(undefined);
  return {
    sandbox, close,
    native: vi.spyOn(nativeCaptures, 'parseKernelBoundNativeCaptures'),
    derive: vi.spyOn(evidence, 'deriveEvidence'),
    retain: vi.spyOn(evidence, 'retainEvidence'),
    failure: vi.spyOn(evidence, 'retainFailureEvidence').mockResolvedValue(hex(800)),
  };
}

describe('actual run.ts native/P1 preparation ordering', () => {
  it('reaches the HTTP admission gate only after the last native family was validated', async () => {
    const input = fixture();
    const observed = arrangeRun(input);
    const error: unknown = await run([]).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(P1AdmissionUnverified);
    expect((error as P1AdmissionUnverified).correlation).toBeNull();
    expect((error as P1AdmissionUnverified).nextGate.missing).toContain('owner-wal-disk-custody-and-verified-native-corpus');
    expect(observed.native).toHaveBeenCalledOnce();
    const parsed = observed.native.mock.results[0]!;
    expect(parsed.type).toBe('return');
    if (parsed.type !== 'return') throw new Error('native pass did not complete');
    expect(Object.keys(parsed.value.shards)).toEqual([...RUNTIME_CAPTURE_NAMES]);
    const last = RUNTIME_CAPTURE_NAMES.at(-1)!;
    expect(parsed.value.shards[last].at(-1)?.parsed.records.at(-1)?.recordType).toBe('producer-close');
    expect(observed.derive).not.toHaveBeenCalled();
    expect(observed.retain).not.toHaveBeenCalled();
    expect(cleanupSandbox).toHaveBeenCalledOnce();
    expect(cleanupSandbox).toHaveBeenCalledWith(observed.sandbox, false);
    expect(observed.failure).toHaveBeenCalledWith(expect.anything(), input.controllerNonce, input.runId, error);
    expect(observed.close).toHaveBeenCalledOnce();
    expect(closeAdmission).toHaveBeenCalledOnce();
  });

  it.each(['http', 'legacy'] as const)('rejects malformed last-family content before %s derivation or destructive cleanup', async (kind) => {
    const input = fixture();
    if (kind === 'legacy') {
      input.records = [legacyOpenCodeRecord()];
      retainChanges(input);
      Object.assign(input.outcome.rawFiles.opencode, {
        producerStartTokens: [peer.startToken], producerPidfdInodes: [peer.pidfdInode],
      });
      expect(evidence.parseRawOrigin(input.raw.opencode, 'opencode', input.controllerNonce)[0]?.kind).toBe('legacy');
    }
    // Rehash the entire shard and its metadata: this tests native CONTENT, not a file SHA failure.
    rewriteNative(input, 'protectedEffectLedgerPath', (record, index) => {
      if (index === 0) record.contract = 'substituted';
    });
    const observed = arrangeRun(input);
    const error: unknown = await run([]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: 'p3c_runtime_capture_binding:protectedEffectLedgerPath:0' });
    expect(observed.native.mock.results[0]?.type).toBe('throw');
    expect(observed.derive).not.toHaveBeenCalled();
    expect(observed.retain).not.toHaveBeenCalled();
    expect(cleanupSandbox).toHaveBeenCalledOnce();
    expect(cleanupSandbox).toHaveBeenCalledWith(observed.sandbox, false);
    expect(observed.native.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(cleanupSandbox).mock.invocationCallOrder[0]!);
    expect(observed.failure).toHaveBeenCalledWith(expect.anything(), input.controllerNonce, input.runId, error);
    expect(observed.close).toHaveBeenCalledOnce();
    expect(closeAdmission).toHaveBeenCalledOnce();
  });

  it('uses one emission-nonce set across the actual runner native pass', async () => {
    const input = fixture();
    const first = JSON.parse(input.captures.conditionalPostLedgerPath[0]!.toString('utf8').split('\n')[0]!);
    rewriteNative(input, 'protectedEffectLedgerPath', (record, index) => {
      if (index === 0) record.emissionNonce = first.emissionNonce;
    });
    const observed = arrangeRun(input);
    await expect(run([])).rejects.toThrow('p3c_runtime_capture_binding:protectedEffectLedgerPath:0');
    expect(observed.derive).not.toHaveBeenCalled();
    expect(cleanupSandbox).toHaveBeenCalledOnce();
    expect(cleanupSandbox).toHaveBeenCalledWith(observed.sandbox, false);
  });

  it('carries the driver selection into every family before reaching the gate', async () => {
    const input = fixture();
    const observed = arrangeRun(input);
    // Mutate native and transcript assertions after arranging the independently selected pins.
    rewriteNative(input, 'productTimelinePath', (record) => {
      Object.assign(record.producer as object, { artifactManifestSha256: hex(999) });
    });
    Object.assign(input.outcome.captureFiles.productTimelinePath.shards[0]!, { producerArtifactSha256: hex(999) });
    await expect(run([])).rejects.toThrow('p3c_p1_selected_producer_disagreement:productTimelinePath');
    expect(observed.derive).not.toHaveBeenCalled();
    expect(cleanupSandbox).toHaveBeenCalledOnce();
    expect(cleanupSandbox).toHaveBeenCalledWith(observed.sandbox, false);
  });
});
