import { TeamOwnerError } from '../team/contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import type {
  RuntimeBinding,
  RuntimeDelivery,
  RuntimeSessionRecord,
} from '../runtime/contracts.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';

/** One admitted native call keeps its original input. Never recapture the next input after await. */
export function captureNativeInputAuthority(options: {
  binding: RuntimeBinding;
  profileId: string;
  hostIncarnation: string;
  config: NonNullable<RuntimeSessionRecord['config']>;
  readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
  captureTeam(intent: RuntimeDelivery): Readonly<NativeMcpAuthorityProof>;
  assertCurrent(): void;
}) {
  const binding = Object.freeze(normalizeBinding(options.binding));
  const configHash = runtimeDigest(options.config);
  const openFingerprint = runtimeDigest({ profileId: options.profileId, config: options.config });
  function read() {
    options.assertCurrent();
    const { record, attached } = options.readRuntime();
    if (
      !attached ||
      !record ||
      record.schemaVersion !== 1 ||
      record.phase !== 'allocated' ||
      record.sealed ||
      record.custody !== 'owned' ||
      !record.nativeReady ||
      record.control ||
      !record.sessionRef ||
      record.profileId !== options.profileId ||
      record.hostIncarnation !== options.hostIncarnation ||
      runtimeDigest(normalizeBinding(record.binding)) !== runtimeDigest(binding) ||
      runtimeDigest(record.config) !== configHash ||
      record.openFingerprint !== openFingerprint
    )
      throw new TeamOwnerError('hold');
    const active = record.inputs.filter(
      (input) => input.phase === 'claimed' || input.phase === 'consumed'
    );
    if (active.length !== 1) throw new TeamOwnerError('hold');
    const input = active[0]!;
    if (
      !input.operationRef ||
      input.intent.inputId !== input.intent.deliveryId ||
      runtimeDigest(normalizeBinding(input.intent.binding)) !== runtimeDigest(binding) ||
      input.fingerprint !== deliveryFingerprint(input.intent)
    )
      throw new TeamOwnerError('hold');
    return { record, input };
  }
  const initial = read();
  const original = Object.freeze({
    sessionRef: initial.record.sessionRef!,
    inputId: initial.input.intent.inputId,
    operationRef: initial.input.operationRef,
    fingerprint: initial.input.fingerprint,
  });
  const originalIntent = structuredClone(initial.input.intent);
  const team = options.captureTeam(structuredClone(originalIntent));
  // Only this Team proof is re-entered under its own synchronous command fence.
  // Runtime checks happen immediately before that fence; never nest a Runtime fence inside Team.
  function assertTeamCurrent() {
    options.assertCurrent();
    if (options.captureTeam(structuredClone(originalIntent)).fingerprint !== team.fingerprint)
      throw new TeamOwnerError('forbidden');
    options.assertCurrent();
  }
  function assertCurrent() {
    const current = read();
    if (
      current.record.sessionRef !== original.sessionRef ||
      current.input.intent.inputId !== original.inputId ||
      current.input.operationRef !== original.operationRef ||
      current.input.fingerprint !== original.fingerprint
    )
      throw new TeamOwnerError('forbidden');
    const proof = options.captureTeam(structuredClone(current.input.intent));
    if (proof.fingerprint !== team.fingerprint) throw new TeamOwnerError('forbidden');
    options.assertCurrent();
  }
  assertCurrent();
  const runtime = Object.freeze({
    profileId: options.profileId,
    hostIncarnation: options.hostIncarnation,
    configHash,
    openFingerprint,
  });
  return Object.freeze({
    team,
    runtime,
    original,
    fingerprint: runtimeDigest({ team: team.fingerprint, original }),
    assertCurrent,
    assertTeamCurrent,
  });
}
