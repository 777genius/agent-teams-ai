#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  drainEvidenceEnvelopeId,
  validateDrainEvidenceEnvelope,
} from '../w4-w6-contract/drain-evidence-envelope.mjs';
import {
  evaluateV1TerminalAbsence,
  repoRoot,
  scanStandalone,
} from './standalone-artifact-evidence.mjs';

export * from './standalone-artifact-evidence.mjs';

export function newAuthState() {
  return {
    processEpoch: 1,
    processAnchor: {
      status: 'ready',
      protocolVersion: 1,
      deploymentGeneration: 'deployment-generation-1',
      processAnchorGeneration: 'process-anchor-generation-1',
      processAnchorGenerationOrdinal: 1,
      anchorIdentity: 'anchor-identity-ref-1',
      spawnNonceHash: 'spawn-nonce-hash-ref-1',
    },
    keyring: { status: 'ready', keyId: 'key-ref-1' },
    resetGeneration: 0,
    resetIntent: null,
    challenge: null,
    device: null,
    sessions: {},
    mutationAdmission: false,
  };
}

export const AUTH_ACTION_TYPES = Object.freeze([
  'bootstrap',
  'pair',
  'restart',
  'lose_keyring',
  'expire_session',
  'renew',
  'logout',
  'forget_device',
  'begin_reset',
  'record_drain_evidence',
  'advance_reset',
]);

const activeAuthorityExists = (state) =>
  state.keyring.status === 'ready' &&
  Boolean(state.device?.familyRef) &&
  !state.device?.revokedReason &&
  Object.values(state.sessions).some((session) => session.active && !session.revokedReason);

export function validateDrainEvidence(state, evidence, purpose, resetGeneration, recorded = false) {
  if (!evidence) return 'typed_drain_required';
  if (evidence.envelopeId !== drainEvidenceEnvelopeId) return 'controller_drain_envelope_mismatch';
  const ready = evidence.ready;
  const drained = evidence.drained;
  if (!ready || !drained) {
    return 'runtime_state_unclassified';
  }
  const controllerValidation = validateDrainEvidenceEnvelope(evidence);
  if (!controllerValidation.ok) {
    const violations = controllerValidation.violations;
    if (violations.some((violation) => violation === 'const:ready:protocolVersion')) {
      return 'drain_protocol_version_stale';
    }
    if (violations.some((violation) => violation === 'const:drained:protocolVersion')) {
      return 'drain_protocol_version_stale';
    }
    if (violations.some((violation) => violation.startsWith('generation_binding:purpose'))) {
      return 'drain_purpose_mismatch';
    }
    if (
      violations.some((violation) => violation.startsWith('generation_binding:resetGeneration'))
    ) {
      return 'drain_reset_generation_stale';
    }
    if (
      violations.some((violation) =>
        violation.startsWith('generation_binding:deploymentGeneration')
      )
    ) {
      return 'drain_deployment_generation_stale';
    }
    if (
      violations.some((violation) =>
        violation.startsWith('generation_binding:processAnchorGeneration')
      )
    ) {
      return 'drain_process_anchor_generation_stale';
    }
    if (
      violations.some(
        (violation) =>
          violation === 'const:ready:mainPidfdReady' ||
          violation === 'const:ready:ownedProcessGroupReady'
      )
    ) {
      return 'drain_anchor_not_ready';
    }
    if (
      violations.some(
        (violation) => violation === 'const:drained:kind' || violation === 'const:drained:outcome'
      )
    ) {
      return 'runtime_state_unclassified';
    }
    if (violations.some((violation) => violation === 'max_items:drained:residuals')) {
      return 'runtime_residuals_present';
    }
    if (violations.some((violation) => violation.includes(':drained:'))) {
      return 'drain_response_shape_mismatch';
    }
    return 'drain_evidence_shape_mismatch';
  }
  const anchor = state.processAnchor;
  if (anchor.status !== (recorded ? 'drained' : 'ready')) return 'drain_anchor_not_ready';
  if (
    ready.anchorIdentity !== anchor.anchorIdentity ||
    ready.spawnNonceHash !== anchor.spawnNonceHash
  ) {
    return 'drain_provenance_mismatch';
  }
  if (
    ready.protocolVersion !== anchor.protocolVersion ||
    drained.protocolVersion !== anchor.protocolVersion
  ) {
    return 'drain_protocol_version_stale';
  }
  if (
    ready.deploymentGeneration !== anchor.deploymentGeneration ||
    drained.deploymentGeneration !== anchor.deploymentGeneration
  ) {
    return 'drain_deployment_generation_stale';
  }
  if (
    ready.processAnchorGeneration !== anchor.processAnchorGeneration ||
    drained.processAnchorGeneration !== anchor.processAnchorGeneration
  ) {
    return 'drain_process_anchor_generation_stale';
  }
  if (ready.mainPidfdReady !== true || ready.ownedProcessGroupReady !== true) {
    return 'drain_anchor_not_ready';
  }
  if (ready.purpose !== purpose || drained.purpose !== purpose) return 'drain_purpose_mismatch';
  if (ready.resetGeneration !== resetGeneration || drained.resetGeneration !== resetGeneration) {
    return 'drain_reset_generation_stale';
  }
  if (drained.kind !== 'process_drain_outcome_v1' || drained.outcome !== 'drained') {
    return 'runtime_state_unclassified';
  }
  if (!drained.classificationId || !Array.isArray(drained.residuals)) {
    return 'runtime_state_unclassified';
  }
  if (drained.residuals.length !== 0) return 'runtime_residuals_present';
  return null;
}

function advanceProcessAnchorGeneration(state) {
  const processAnchorGenerationOrdinal = state.processAnchor.processAnchorGenerationOrdinal + 1;
  const processAnchorGeneration = `process-anchor-generation-${processAnchorGenerationOrdinal}`;
  state.processAnchor = {
    status: 'ready',
    protocolVersion: state.processAnchor.protocolVersion,
    deploymentGeneration: state.processAnchor.deploymentGeneration,
    processAnchorGeneration,
    processAnchorGenerationOrdinal,
    anchorIdentity: `anchor-identity-ref-${processAnchorGenerationOrdinal}`,
    spawnNonceHash: `spawn-nonce-hash-ref-${processAnchorGenerationOrdinal}`,
  };
}

export function drainEvidenceFor(state, purpose, resetGeneration, overrides = {}) {
  const drainedOverrides = overrides.drained ?? {};
  const readyOverrides = overrides.ready ?? {};
  const envelopeOverrides = { ...overrides };
  delete envelopeOverrides.drained;
  delete envelopeOverrides.ready;
  return {
    envelopeId: drainEvidenceEnvelopeId,
    ready: {
      protocolVersion: state.processAnchor.protocolVersion,
      spawnNonceHash: state.processAnchor.spawnNonceHash,
      deploymentGeneration: state.processAnchor.deploymentGeneration,
      processAnchorGeneration: state.processAnchor.processAnchorGeneration,
      purpose,
      resetGeneration,
      anchorIdentity: state.processAnchor.anchorIdentity,
      mainPidfdReady: true,
      ownedProcessGroupReady: true,
      ...readyOverrides,
    },
    drained: {
      protocolVersion: state.processAnchor.protocolVersion,
      kind: 'process_drain_outcome_v1',
      outcome: 'drained',
      purpose,
      resetGeneration,
      deploymentGeneration: state.processAnchor.deploymentGeneration,
      processAnchorGeneration: state.processAnchor.processAnchorGeneration,
      classificationId: `anchor-classification-${state.processAnchor.processAnchorGeneration}`,
      residuals: [],
      ...drainedOverrides,
    },
    ...envelopeOverrides,
  };
}

const deviceCookie = (operation) => ({
  cookie: '__Secure-atd',
  operation,
  attributes: ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/api/hosted/v1/auth/renew'],
  domain: null,
});

const sessionCookie = (operation) => ({
  cookie: '__Host-ats',
  operation,
  attributes: ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'],
  domain: null,
});

function revokeAll(state, reason) {
  if (state.device) state.device.revokedReason = reason;
  for (const session of Object.values(state.sessions)) session.revokedReason = reason;
  state.mutationAdmission = false;
}

/**
 * Executable Phase 0 model. References are deliberately symbolic: the model never creates or emits
 * a credential value. Persistent records survive restart; process-local readiness does not.
 */
export function authTransition(input, action) {
  const state = structuredClone(input);
  if (!AUTH_ACTION_TYPES.includes(action.type)) {
    throw new Error(`unknown auth action: ${action.type}`);
  }
  const preserveResetAdmissionFence = () => {
    if (state.resetIntent) state.mutationAdmission = false;
  };
  const reject = (code) => {
    preserveResetAdmissionFence();
    return { state, outcome: 'rejected', code };
  };
  const accept = (code) => {
    preserveResetAdmissionFence();
    return { state, outcome: 'accepted', code };
  };

  if (state.resetIntent) {
    state.mutationAdmission = false;
    if (['bootstrap', 'pair', 'renew'].includes(action.type)) {
      return reject('reset_in_progress');
    }
  }

  switch (action.type) {
    case 'bootstrap':
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (state.device && !state.device.revokedReason) return accept('existing_device_reused');
      {
        const drainError = validateDrainEvidence(state, action.drainEvidence, 'pairing', 0);
        if (drainError) return reject(drainError);
      }
      state.processAnchor.status = 'drained';
      state.challenge = { ref: `challenge-ref-${state.resetGeneration}`, consumed: false };
      return accept('challenge_issued');
    case 'pair':
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (!state.challenge || state.challenge.consumed) return reject('challenge_invalid');
      state.challenge.consumed = true;
      state.device = { familyRef: 'device-family-ref-1', generation: 1, predecessor: null };
      state.sessions = { 'session-ref-1': { generation: 1, active: true } };
      state.mutationAdmission = true;
      advanceProcessAnchorGeneration(state);
      return {
        ...accept('paired_device_and_session'),
        cookieTransitions: [deviceCookie('set'), sessionCookie('set')],
      };
    case 'restart':
      state.processEpoch += 1;
      state.mutationAdmission = !state.resetIntent && activeAuthorityExists(state);
      return accept(state.mutationAdmission ? 'authority_reloaded' : 'auth_not_ready');
    case 'lose_keyring':
      state.keyring = { status: 'missing', keyId: null };
      state.mutationAdmission = false;
      return accept('keyring_marked_missing');
    case 'expire_session': {
      const session = state.sessions[action.sessionRef];
      if (!session) return reject('session_unknown');
      session.active = false;
      session.expiredBy = action.deadline;
      state.mutationAdmission = false;
      return accept('session_expired');
    }
    case 'renew': {
      if (state.keyring.status !== 'ready') return reject('auth_not_ready_keyring');
      if (!state.device || state.device.revokedReason) return reject('device_revoked');
      const current = state.device.generation;
      const predecessor = state.device.predecessor;
      const currentAccepted = action.presentedGeneration === current;
      const graceAccepted =
        predecessor?.generation === action.presentedGeneration && predecessor.remainingUses > 0;
      if (!currentAccepted && !graceAccepted) {
        revokeAll(state, 'predecessor_replay_outside_grace');
        return reject('device_family_revoked_replay');
      }
      state.device.predecessor = { generation: current, remainingUses: 1 };
      state.device.generation = current + 1;
      for (const session of Object.values(state.sessions)) {
        if (session.active) {
          session.active = false;
          session.revokedReason = 'session_rotation';
        }
      }
      const sessionRef = `session-ref-${state.device.generation}`;
      state.sessions[sessionRef] = { generation: state.device.generation, active: true };
      state.mutationAdmission = true;
      return {
        ...accept(graceAccepted ? 'predecessor_grace_rotated_forward' : 'device_rotated'),
        cookieTransitions: [deviceCookie('rotate'), sessionCookie('rotate')],
        response: action.responseLost
          ? { delivered: false, sessionRef: null, deviceGeneration: null }
          : { delivered: true, sessionRef, deviceGeneration: state.device.generation },
      };
    }
    case 'logout':
      if (state.sessions[action.sessionRef]) {
        state.sessions[action.sessionRef].revokedReason = 'logout';
        state.sessions[action.sessionRef].active = false;
      }
      state.mutationAdmission = false;
      return { ...accept('session_revoked'), cookieTransitions: [sessionCookie('clear')] };
    case 'forget_device':
      revokeAll(state, 'forget_device');
      return {
        ...accept('device_family_revoked'),
        cookieTransitions: [deviceCookie('clear'), sessionCookie('clear')],
      };
    case 'begin_reset':
      if (state.resetIntent) return reject('reset_already_in_progress');
      if (action.generation <= state.resetGeneration) return reject('reset_generation_not_newer');
      state.mutationAdmission = false;
      state.resetIntent = {
        generation: action.generation,
        stage: 'requested',
        drainEvidence: null,
      };
      return accept('reset_requested');
    case 'record_drain_evidence': {
      const intent = state.resetIntent;
      if (!intent) return reject('reset_not_requested');
      const drainError = validateDrainEvidence(
        state,
        action.evidence,
        'host_reset',
        intent.generation
      );
      if (drainError) {
        intent.stage = 'draining';
        return reject(drainError);
      }
      intent.stage = 'drained';
      intent.drainEvidence = structuredClone(action.evidence);
      state.processAnchor.status = 'drained';
      return accept('typed_drain_recorded');
    }
    case 'advance_reset': {
      const intent = state.resetIntent;
      if (!intent) return reject('reset_not_requested');
      if (['requested', 'draining'].includes(intent.stage)) {
        intent.stage = 'draining';
        return reject('typed_drain_required');
      }
      if (intent.stage === 'drained') {
        const drainError = validateDrainEvidence(
          state,
          intent.drainEvidence,
          'host_reset',
          intent.generation,
          true
        );
        if (drainError) return reject(drainError);
        intent.stage = 'new_key_staged';
        return accept('new_key_staged');
      }
      if (intent.stage === 'new_key_staged') {
        revokeAll(state, 'host_reset');
        intent.stage = 'authority_revoked';
        return accept('authority_revoked');
      }
      if (intent.stage === 'authority_revoked') {
        state.resetGeneration = intent.generation;
        state.keyring = { status: 'ready', keyId: `key-ref-reset-${intent.generation}` };
        intent.stage = 'key_activated';
        return accept('key_activated');
      }
      if (intent.stage === 'key_activated') {
        state.challenge = { ref: `challenge-ref-${intent.generation}`, consumed: false };
        intent.stage = 'challenge_issued';
        return accept('challenge_issued');
      }
      if (intent.stage === 'challenge_issued') {
        state.resetIntent = null;
        return accept('reset_completed');
      }
      throw new Error(`unknown reset stage: ${intent.stage}`);
    }
  }
}

export function runAuthSchedule(actions) {
  let state = newAuthState();
  const trace = [];
  for (const action of actions) {
    const result = authTransition(state, action);
    state = result.state;
    trace.push({ action: action.type, outcome: result.outcome, code: result.code });
  }
  return { state, trace };
}

const multiValue = (value) =>
  Array.isArray(value) || (typeof value === 'string' && value.includes(','));

/** Security-order spike: all rejection paths return before cookie/body/idempotency work. */
export function evaluateProxyRequest(request, config) {
  const rejected = (code, stage) => ({
    accepted: false,
    code,
    stage,
    cookieLookup: false,
    bodyParsed: false,
    idempotencyClaimed: false,
  });
  if (request.surface && request.surface !== 'browser') {
    return rejected('browser_runtime_trust_surfaces_disjoint', 'surface');
  }
  let publicOrigin;
  try {
    publicOrigin = new URL(config.publicOrigin);
  } catch {
    return rejected('public_origin_invalid', 'readiness');
  }
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash
  ) {
    return rejected('public_origin_invalid', 'readiness');
  }
  if (config.corsOrigin !== publicOrigin.origin) {
    return rejected('cors_origin_must_equal_public_origin', 'readiness');
  }

  const forwarded = request.forwarded ?? {};
  const hasForwarded = Object.values(forwarded).some(Boolean);
  const trustedProxy = config.trustedProxyPeers.includes(request.peer);
  if (hasForwarded && !trustedProxy) return rejected('forwarded_header_spoof', 'transport');
  if (multiValue(forwarded.proto) || multiValue(forwarded.host)) {
    return rejected('ambiguous_forwarded_authority', 'transport');
  }
  const secure = request.socketEncrypted || (trustedProxy && forwarded.proto === 'https');
  if (!secure) return rejected('direct_http_forbidden', 'transport');
  const authority = trustedProxy ? forwarded.host : request.host;
  if (authority !== publicOrigin.host) return rejected('unexpected_authority', 'authority');
  if (request.browserRequest && request.origin !== publicOrigin.origin) {
    return rejected(request.origin ? 'unexpected_origin' : 'origin_required', 'origin');
  }
  return {
    accepted: true,
    code: 'origin_and_authority_accepted',
    stage: 'auth_next',
    cookieLookup: false,
    bodyParsed: false,
    idempotencyClaimed: false,
  };
}

export function evaluateAuthorityCookieInput(input) {
  const rejected = (code) => ({ accepted: false, code, cookieLookup: false });
  if (input.headerBytes > input.maxHeaderBytes) return rejected('cookie_header_oversized');
  if (input.parseStatus !== 'parsed') return rejected('cookie_header_malformed');
  const authorityNames = new Set(['__Secure-atd', '__Host-ats']);
  const seen = new Set();
  for (const name of input.cookieNames) {
    if (!authorityNames.has(name)) continue;
    if (seen.has(name)) return rejected('duplicate_authority_cookie');
    seen.add(name);
  }
  return { accepted: true, code: 'cookie_shape_accepted', cookieLookup: false };
}

function main() {
  const outputArg = process.argv.indexOf('--output');
  const buildRootArg = process.argv.indexOf('--build-root');
  const scan = scanStandalone(repoRoot, {
    buildRoot: buildRootArg >= 0 ? process.argv[buildRootArg + 1] : null,
  });
  const output = `${JSON.stringify({ ...scan, terminalAbsence: evaluateV1TerminalAbsence(scan) }, null, 2)}\n`;
  if (outputArg >= 0) writeFileSync(resolve(repoRoot, process.argv[outputArg + 1]), output);
  else process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
