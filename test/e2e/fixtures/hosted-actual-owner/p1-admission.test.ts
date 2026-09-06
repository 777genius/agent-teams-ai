import { describe, expect, it } from 'vitest';

import { RUNTIME_CAPTURE_NAMES } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { assembleEvidence, makeRawRecord, parseRawOrigin, prepareEvidence } from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import { prepareNativeEvidence } from '../../../../scripts/e2e/hosted-actual-owner/evidence-preparation';
import { P1AdmissionUnverified } from '../../../../scripts/e2e/hosted-actual-owner/p1-admission';
import { parseRawFiles } from '../../../../scripts/e2e/hosted-actual-owner/raw-file-evidence';
import { assertRawRecordWriters } from '../../../../scripts/e2e/hosted-actual-owner/raw-writer-binding';

import { legacyOpenCodeRecord, rewriteContext, rewriteNative, selectionFixture } from './p1-repair.fixtures';
import { context, fixture, hex, joint, ledger, owner, peer, rawRecord, recordData, retainChanges } from './raw-http.fixtures';

import type { HttpFixture } from './raw-http.fixtures';

function admissionFailure(input: HttpFixture): P1AdmissionUnverified {
  try {
    prepareEvidence({ ...input, httpCorrelations: input.correlations });
  } catch (error) {
    expect(error).toBeInstanceOf(P1AdmissionUnverified);
    return error as P1AdmissionUnverified;
  }
  throw new Error('P1 must remain unverified');
}

describe('P1 admission is separate from retained-byte correlation', () => {
  it('never presents a caller publication digest as a verified receipt', () => {
    const input = fixture();
    const original = admissionFailure(input);
    input.correlations[0] = { ...input.correlations[0]!, claimedActivationPublicationSha256: hex(999) };
    const substituted = admissionFailure(input);
    for (const failure of [original, substituted]) {
      expect(failure.admission).toBe('unverified');
      expect(failure.correlation?.status).toBe('correlated-unverified');
      expect(failure.correlation?.admission).toBe('unverified');
      expect(failure.correlation?.exchanges[0]?.facts).toHaveLength(3);
      expect(failure.correlation?.exchanges[0]).not.toHaveProperty('activationPublicationSha256');
      expect(failure.correlation?.exchanges[0]).not.toHaveProperty('appliedReceipt');
      expect(failure.correlation?.exchanges[0]?.appliedReceiptObservation?.status).toBe('applied');
      expect(failure.missing).toContain('verified-ed25519-activation-publication-and-signed-routes-bound-to-owner-start');
      expect(failure.nextGate.missing).toEqual([
        'owner-wal-disk-custody-and-verified-native-corpus',
        'native-scenario-derivation-without-legacy-effect-total-rows',
      ]);
    }
    expect(substituted.correlation?.exchanges[0]?.claimedActivationPublicationSha256).toBe(hex(999));
    expect(original.correlation?.exchanges[0]?.claimedActivationPublicationSha256).toBe(hex(130));
    expect(() => assembleEvidence({ ...input, httpCorrelations: input.correlations })).toThrow('p3c_p1_admission_unverified');
  });

  it.each(['bootstrapV2HeaderSha256', 'expectedHostSha256', 'descriptorMapSha256', 'captureId', 'routeId'] as const)(
    'keeps jointly substituted raw and asserted %s unverified', (field) => {
      const input = fixture();
      rewriteContext(input, { ...context, [field]: field === 'routeId' ? 'route_other' : hex(999) });
      expect(admissionFailure(input).correlation?.status).toBe('correlated-unverified');
    }
  );

  it('keeps jointly rewritten activation statements unverified', () => {
    const input = fixture();
    rewriteContext(input, { ...context, activation: {
      ...context.activation, bootstrapDigest: hex(990), admissionDocumentDigest: `sha256:${hex(991)}`,
      ownerArtifactDigest: `sha256:${hex(992)}`,
    } });
    expect(admissionFailure(input).correlation?.admission).toBe('unverified');
  });

  it.each(RUNTIME_CAPTURE_NAMES)('rejects a cross-role activation replacement in %s', (name) => {
    const input = fixture();
    rewriteNative(input, name, (record) => {
      Object.assign(record.activation as object, { stackManifestSha256: hex(999) });
    });
    expect(() => joint(input)).toThrow('p3c_p1_native_stack_disagreement');
    expect(() => prepareEvidence(input)).toThrow('p3c_p1_native_stack_disagreement');
  });

  it('cannot admit a jointly replaced stack across all native families and raw assertions', () => {
    const input = fixture();
    for (const name of RUNTIME_CAPTURE_NAMES) {
      rewriteNative(input, name, (record) => {
        Object.assign(record.activation as object, { stackManifestSha256: hex(999) });
      });
    }
    rewriteContext(input, { ...context, activation: { ...context.activation, stackManifestSha256: hex(999) } });
    const failure = admissionFailure(input);
    expect(failure.correlation?.status).toBe('correlated-unverified');
    expect(failure.missing).toContain('selected-supervisor-launch-observations-and-stack-manifest');
  });

  it('preserves the immutable selection made before launch but does not turn it into admission', () => {
    const input = fixture();
    const { plan, selection } = selectionFixture(input);
    Object.assign(plan.expectedExecutableSha256, { owner: hex(999) });
    expect(selection.producers.owner.sha256).toBe(owner.executableSha256);
    expect(Object.isFrozen(selection.producers.owner)).toBe(true);
    expect(() => prepareEvidence({ ...input, selectedLaunch: selection })).toThrow('p3c_p1_admission_unverified');
  });

  it('copies the retained bytes and context before any later input mutation', () => {
    const input = fixture();
    const snapshot = prepareNativeEvidence({ ...input, httpCorrelations: input.correlations });
    const raw = Buffer.from(input.raw.opencode);
    const native = Buffer.from(input.captures.openCodeTimelinePath[0]!);
    input.raw.opencode.fill(0);
    input.captures.openCodeTimelinePath[0]!.fill(0);
    Object.assign(input.outcome.rawFiles.opencode, { producerStartTokens: [peer.startToken] });
    input.correlations[0] = { ...input.correlations[0]!, context: { ...context, routeId: 'changed' } };
    expect(snapshot.raw.opencode).toEqual(raw);
    expect(snapshot.captures.openCodeTimelinePath[0]).toEqual(native);
    expect(snapshot.outcome.rawFiles.opencode.producerStartTokens).toEqual([owner.startToken]);
    expect(snapshot.correlations?.[0]?.context.routeId).toBe(context.routeId);
    expect(Object.isFrozen(snapshot.correlations?.[0]?.context.activation)).toBe(true);
    expect(Object.isFrozen(snapshot.outcome.rawFiles.opencode)).toBe(true);
  });

  it.each(RUNTIME_CAPTURE_NAMES)('binds %s producer pins to the separate launch selection', (name) => {
    const input = fixture();
    const { selection } = selectionFixture(input);
    rewriteNative(input, name, (record) => {
      Object.assign(record.producer as object, { artifactManifestSha256: hex(999) });
    });
    Object.assign(input.outcome.captureFiles[name].shards[0]!, { producerArtifactSha256: hex(999) });
    expect(() => prepareEvidence({ ...input, selectedLaunch: selection })).toThrow('p3c_p1_selected_producer_disagreement');
  });

  it('cannot bypass the common native pass with a forged prepared object', () => {
    const input = fixture();
    rewriteNative(input, 'protectedEffectLedgerPath', (record, index) => {
      if (index === 0) record.contract = 'substituted';
    });
    const forged = { ...input, prepared: { status: 'ADMITTED_P1', native: {}, p1: joint(fixture()) } };
    expect(() => prepareEvidence(forged)).toThrow('p3c_runtime_capture_binding:protectedEffectLedgerPath:0');
    expect(() => assembleEvidence(forged)).toThrow('p3c_runtime_capture_binding:protectedEffectLedgerPath:0');
  });
});

describe('per-record writer and retained ledger binding', () => {
  it('requires the OpenCode writer for legacy records even if both raw and ledger claim Owner', () => {
    const input = fixture();
    const original = legacyOpenCodeRecord();
    const parse = (record: typeof original) => parseRawOrigin(ledger([record]), 'opencode', input.controllerNonce);
    const legacyOutcome = structuredClone(input.outcome);
    Object.assign(legacyOutcome.rawFiles.opencode, {
      producerStartTokens: [peer.startToken], producerPidfdInodes: [peer.pidfdInode],
    });
    expect(() => assertRawRecordWriters('opencode', parse(original), legacyOutcome)).not.toThrow();
    const forged = makeRawRecord({ ...original, processStartToken: owner.startToken,
      payload: JSON.parse(Buffer.from(original.payloadBase64, 'base64').toString('utf8')) });
    expect(() => assertRawRecordWriters('opencode', parse(forged), input.outcome)).toThrow('p3c_evidence_process_start_disagreement');
    input.records = [forged];
    retainChanges(input);
    expect(() => prepareEvidence(input)).toThrow('p3c_evidence_process_start_disagreement');
  });

  it.each(['opencode', 'wrong-pidfd', 'mixed-writers'] as const)('refuses HTTP %s writer attribution before admission', (mode) => {
    const input = fixture();
    Object.assign(input.outcome.rawFiles.opencode, mode === 'opencode' ? {
      producerStartTokens: [peer.startToken], producerPidfdInodes: [peer.pidfdInode],
    } : mode === 'wrong-pidfd' ? {
      producerPidfdInodes: [peer.pidfdInode],
    } : {
      producerStartTokens: [owner.startToken, peer.startToken].sort(),
      producerPidfdInodes: [owner.pidfdInode, peer.pidfdInode].sort(),
    });
    expect(() => prepareEvidence(input)).toThrow('p3c_evidence_process_start_disagreement');
    expect(() => joint(input)).toThrow('recorder_writer');
  });

  it('rejects a mixed legacy/HTTP ledger with either writer list and their union', () => {
    for (const writers of [[owner], [peer], [owner, peer]]) {
      const input = fixture();
      input.records = [legacyOpenCodeRecord(), rawRecord(recordData(input.records[0]!), 2)];
      retainChanges(input);
      Object.assign(input.outcome.rawFiles.opencode, {
        producerStartTokens: writers.map((p) => p.startToken).sort(),
        producerPidfdInodes: writers.map((p) => p.pidfdInode).sort(),
      });
      if (writers.length === 1) {
        expect(() => parseRawFiles(input.outcome.rawFiles, input.outcome.starts, input.outcome.supervisorStart)).not.toThrow();
      } else {
        expect(() => parseRawFiles(input.outcome.rawFiles, input.outcome.starts, input.outcome.supervisorStart)).toThrow('p3c_supervisor_raw_file');
      }
      expect(() => prepareEvidence(input)).toThrow('p3c_evidence_process_start_disagreement');
      expect(() => joint(input)).toThrow('mixed_recorder_kinds');
    }
  });
});
