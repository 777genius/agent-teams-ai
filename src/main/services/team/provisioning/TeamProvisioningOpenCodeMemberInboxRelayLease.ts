import { INBOX_RELAY_IN_FLIGHT_LEASE_MS } from './TeamProvisioningInboxRelayCandidates';

import type { OpenCodeMemberInboxRelayResult } from './TeamProvisioningOpenCodeMemberInboxRelayResults';

interface OpenCodeMemberInboxRelayLease {
  generation: number;
  work: Promise<OpenCodeMemberInboxRelayResult>;
  expiresAtMs: number;
  expiryHandle: ReturnType<typeof setTimeout> | null;
}

const openCodeMemberInboxRelayLeases = new WeakMap<
  Map<string, Promise<OpenCodeMemberInboxRelayResult>>,
  Map<string, OpenCodeMemberInboxRelayLease>
>();
let nextOpenCodeMemberInboxRelayGeneration = 0;

function getOpenCodeMemberInboxRelayLeaseStore(
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>
): Map<string, OpenCodeMemberInboxRelayLease> {
  let leases = openCodeMemberInboxRelayLeases.get(inFlight);
  if (!leases) {
    leases = new Map();
    openCodeMemberInboxRelayLeases.set(inFlight, leases);
  }
  return leases;
}

function releaseOpenCodeMemberInboxRelayLease(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  lease: OpenCodeMemberInboxRelayLease;
}): void {
  const leases = getOpenCodeMemberInboxRelayLeaseStore(input.inFlight);
  if (leases.get(input.relayKey)?.generation !== input.lease.generation) {
    return;
  }
  if (input.inFlight.get(input.relayKey) === input.lease.work) {
    input.inFlight.delete(input.relayKey);
  }
  if (input.lease.expiryHandle) {
    clearTimeout(input.lease.expiryHandle);
  }
  leases.delete(input.relayKey);
}

function claimOpenCodeMemberInboxRelayLease(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  work: Promise<OpenCodeMemberInboxRelayResult>;
  nowMs?: number;
}): OpenCodeMemberInboxRelayLease {
  const leases = getOpenCodeMemberInboxRelayLeaseStore(input.inFlight);
  const existingLease = leases.get(input.relayKey);
  if (existingLease?.work === input.work) {
    return existingLease;
  }

  const lease: OpenCodeMemberInboxRelayLease = {
    generation: ++nextOpenCodeMemberInboxRelayGeneration,
    work: input.work,
    expiresAtMs: (input.nowMs ?? Date.now()) + INBOX_RELAY_IN_FLIGHT_LEASE_MS,
    expiryHandle: null,
  };
  leases.set(input.relayKey, lease);
  lease.expiryHandle = setTimeout(
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease }),
    INBOX_RELAY_IN_FLIGHT_LEASE_MS
  );
  lease.expiryHandle.unref?.();
  void input.work.then(
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease }),
    () => releaseOpenCodeMemberInboxRelayLease({ ...input, lease })
  );
  return lease;
}

export function getActiveOpenCodeMemberInboxRelayWork(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  nowMs?: number;
}): Promise<OpenCodeMemberInboxRelayResult> | undefined {
  const work = input.inFlight.get(input.relayKey);
  if (!work) {
    return undefined;
  }
  const nowMs = input.nowMs ?? Date.now();
  const lease = claimOpenCodeMemberInboxRelayLease({ ...input, work, nowMs });
  if (nowMs < lease.expiresAtMs) {
    return work;
  }
  releaseOpenCodeMemberInboxRelayLease({ ...input, lease });
  return undefined;
}

export function registerOpenCodeMemberInboxRelayWork(input: {
  inFlight: Map<string, Promise<OpenCodeMemberInboxRelayResult>>;
  relayKey: string;
  work: Promise<OpenCodeMemberInboxRelayResult>;
}): void {
  input.inFlight.set(input.relayKey, input.work);
  claimOpenCodeMemberInboxRelayLease(input);
}
