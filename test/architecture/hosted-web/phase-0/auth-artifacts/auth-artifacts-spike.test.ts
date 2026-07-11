import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AUTH_ACTION_TYPES,
  authTransition,
  buildStandaloneCharacterizationProjection,
  drainEvidenceFor,
  evaluateAuthorityCookieInput,
  evaluateFinalImageTerminalAbsence,
  evaluateHostedArtifactContract,
  evaluateProxyRequest,
  evaluateV1TerminalAbsence,
  runAbiSmokeProbe,
  runAuthSchedule,
  scanStandalone,
  validateStandaloneCharacterizationProjection,
} from '../../../../../scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs';

const proxyConfig = {
  publicOrigin: 'https://teams.example.test',
  trustedProxyPeers: ['10.0.0.2'],
  corsOrigin: 'https://teams.example.test',
};

function pairedState() {
  const state = runAuthSchedule([]).state;
  return runAuthSchedule([
    { type: 'bootstrap', drainEvidence: drainEvidenceFor(state, 'pairing', 0) },
    { type: 'pair' },
  ]).state;
}

describe('ADR-7 transition schedules', () => {
  it('consumes a pairing challenge exactly once', () => {
    const state = runAuthSchedule([]).state;
    const first = runAuthSchedule([
      { type: 'bootstrap', drainEvidence: drainEvidenceFor(state, 'pairing', 0) },
      { type: 'pair' },
    ]);
    expect(first.trace.map(({ code }) => code)).toEqual([
      'challenge_issued',
      'paired_device_and_session',
    ]);
    expect(authTransition(first.state, { type: 'pair' }).code).toBe('challenge_invalid');
  });

  it('keeps durable authority through restart and rotates after idle or absolute expiry', () => {
    for (const deadline of ['idle', 'absolute']) {
      let state = pairedState();
      state = authTransition(state, { type: 'restart' }).state;
      expect(state.challenge).toMatchObject({ consumed: true });
      state = authTransition(state, {
        type: 'expire_session',
        sessionRef: 'session-ref-1',
        deadline,
      }).state;
      expect(authTransition(state, { type: 'restart' }).state.mutationAdmission).toBe(false);
      const renewed = authTransition(state, { type: 'renew', presentedGeneration: 1 });
      expect(renewed).toMatchObject({ outcome: 'accepted', code: 'device_rotated' });
      expect(renewed.state.device?.generation).toBe(2);
      expect(renewed.state.sessions['session-ref-1']).toMatchObject({
        active: false,
        expiredBy: deadline,
      });
    }
  });

  it('recovers lost rotation response and two-tab contention only by moving forward', () => {
    const first = authTransition(pairedState(), {
      type: 'renew',
      presentedGeneration: 1,
      responseLost: true,
    });
    expect(first.response).toEqual({ delivered: false, sessionRef: null, deviceGeneration: null });
    expect(first.state.sessions['session-ref-1']).toMatchObject({
      active: false,
      revokedReason: 'session_rotation',
    });
    const retry = authTransition(first.state, { type: 'renew', presentedGeneration: 1 });
    expect(retry.code).toBe('predecessor_grace_rotated_forward');
    expect(retry.state.device?.generation).toBe(3);
    expect(retry.state.device?.predecessor?.generation).toBe(2);
  });

  it('revokes the entire family on predecessor replay outside grace', () => {
    const rotated = authTransition(pairedState(), { type: 'renew', presentedGeneration: 1 });
    const advanced = authTransition(rotated.state, { type: 'renew', presentedGeneration: 2 });
    const replay = authTransition(advanced.state, { type: 'renew', presentedGeneration: 1 });
    expect(replay.code).toBe('device_family_revoked_replay');
    expect(replay.state.device?.revokedReason).toBe('predecessor_replay_outside_grace');
    expect(Object.values(replay.state.sessions).every((session) => session.revokedReason)).toBe(
      true
    );
    expect(authTransition(replay.state, { type: 'restart' }).state.mutationAdmission).toBe(false);
  });

  it('fails closed on missing keyring and does not mint pairing material', () => {
    const lost = authTransition(pairedState(), { type: 'lose_keyring' });
    const restarted = authTransition(lost.state, { type: 'restart' });
    const bootstrap = authTransition(restarted.state, { type: 'bootstrap' });
    expect(restarted.state.mutationAdmission).toBe(false);
    expect(bootstrap.code).toBe('auth_not_ready_keyring');
    expect(bootstrap.state.challenge).toMatchObject({ consumed: true });
  });

  it('resumes a durable host-reset intent after keyring loss/restart and waits for drain', () => {
    let state = authTransition(pairedState(), { type: 'lose_keyring' }).state;
    state = authTransition(state, { type: 'begin_reset', generation: 1 }).state;
    const blocked = authTransition(state, { type: 'advance_reset' });
    expect(blocked.code).toBe('typed_drain_required');
    expect(blocked.state.challenge).toMatchObject({ consumed: true });
    state = authTransition(blocked.state, { type: 'restart' }).state;
    expect(state.resetIntent?.stage).toBe('draining');
    expect(state.mutationAdmission).toBe(false);
    const stale = drainEvidenceFor(state, 'host_reset', 1, {
      drained: { processAnchorGeneration: 0 },
    });
    expect(authTransition(state, { type: 'record_drain_evidence', evidence: stale }).code).toBe(
      'drain_process_anchor_generation_stale'
    );
    const unclassified = drainEvidenceFor(state, 'host_reset', 1, {
      drained: { outcome: 'unclassified', residuals: ['escaped_group'] },
    });
    expect(
      authTransition(state, { type: 'record_drain_evidence', evidence: unclassified }).code
    ).toBe('runtime_state_unclassified');
    const recorded = authTransition(state, {
      type: 'record_drain_evidence',
      evidence: drainEvidenceFor(state, 'host_reset', 1),
    });
    expect(recorded.code).toBe('typed_drain_recorded');
    state = recorded.state;
    const stages = [];
    for (let index = 0; index < 5; index += 1) {
      const next = authTransition(state, { type: 'advance_reset' });
      stages.push(next.code);
      state = next.state;
    }
    expect(stages).toEqual([
      'new_key_staged',
      'authority_revoked',
      'key_activated',
      'challenge_issued',
      'reset_completed',
    ]);
    expect(state.challenge).toMatchObject({ consumed: false });
    expect(authTransition(state, { type: 'begin_reset', generation: 1 }).code).toBe(
      'reset_generation_not_newer'
    );
  });

  it('keeps mutation closed and resumes forward after restart at every reset stage', () => {
    const expectAuthAdmissionClosed = (resetState: ReturnType<typeof pairedState>) => {
      for (const action of [
        { type: 'renew', presentedGeneration: resetState.device?.generation },
        { type: 'bootstrap' },
        { type: 'pair' },
      ]) {
        const result = authTransition(resetState, action);
        expect(result).toMatchObject({ outcome: 'rejected', code: 'reset_in_progress' });
        expect(result.state.mutationAdmission).toBe(false);
      }
    };
    let state = authTransition(pairedState(), { type: 'begin_reset', generation: 1 }).state;
    expect(state.resetIntent?.stage).toBe('requested');
    expectAuthAdmissionClosed(state);
    state = authTransition(state, { type: 'restart' }).state;
    expect(state.mutationAdmission).toBe(false);

    state = authTransition(state, { type: 'advance_reset' }).state;
    expect(state.resetIntent?.stage).toBe('draining');
    expectAuthAdmissionClosed(state);
    state = authTransition(state, { type: 'restart' }).state;
    expect(state.mutationAdmission).toBe(false);

    state = authTransition(state, {
      type: 'record_drain_evidence',
      evidence: drainEvidenceFor(state, 'host_reset', 1),
    }).state;
    expect(state.resetIntent?.stage).toBe('drained');
    expectAuthAdmissionClosed(state);
    state = authTransition(state, { type: 'restart' }).state;

    for (const stage of [
      'new_key_staged',
      'authority_revoked',
      'key_activated',
      'challenge_issued',
    ]) {
      state = authTransition(state, { type: 'advance_reset' }).state;
      expect(state.resetIntent?.stage).toBe(stage);
      expectAuthAdmissionClosed(state);
      state = authTransition(state, { type: 'restart' }).state;
      expect(state.mutationAdmission).toBe(false);
    }

    state = authTransition(state, { type: 'advance_reset' }).state;
    expect(state.resetIntent).toBeNull();
    expect(authTransition(state, { type: 'restart' }).state.mutationAdmission).toBe(false);
  });

  it('preserves the admission fence for every modeled action from every active reset stage', () => {
    const states = [];
    let state = authTransition(pairedState(), { type: 'begin_reset', generation: 1 }).state;
    states.push(state);
    state = authTransition(state, { type: 'advance_reset' }).state;
    states.push(state);
    state = authTransition(state, {
      type: 'record_drain_evidence',
      evidence: drainEvidenceFor(state, 'host_reset', 1),
    }).state;
    states.push(state);
    for (let index = 0; index < 4; index += 1) {
      state = authTransition(state, { type: 'advance_reset' }).state;
      states.push(state);
    }

    for (const resetState of states) {
      const actionByType = {
        bootstrap: { type: 'bootstrap' },
        pair: { type: 'pair' },
        renew: { type: 'renew', presentedGeneration: resetState.device?.generation },
        restart: { type: 'restart' },
        lose_keyring: { type: 'lose_keyring' },
        expire_session: { type: 'expire_session', sessionRef: 'session-ref-1', deadline: 'idle' },
        logout: { type: 'logout', sessionRef: 'session-ref-1' },
        forget_device: { type: 'forget_device' },
        begin_reset: { type: 'begin_reset', generation: 2 },
        record_drain_evidence: {
          type: 'record_drain_evidence',
          evidence: drainEvidenceFor(resetState, 'host_reset', 1),
        },
        advance_reset: { type: 'advance_reset' },
      };
      expect(Object.keys(actionByType).sort()).toEqual([...AUTH_ACTION_TYPES].sort());
      for (const action of Object.values(actionByType)) {
        expect(authTransition(resetState, action).state.mutationAdmission).toBe(false);
      }
    }
  });

  it('accepts only the exact W4 ready/drained shapes and current trusted control provenance', () => {
    const state = pairedState();
    const reset = authTransition(state, { type: 'begin_reset', generation: 1 }).state;
    for (const [evidence, code] of [
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { residuals: ['owned-child'] } }),
        'runtime_residuals_present',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { controlChannelRef: 'stale-channel' }),
        'drain_provenance_mismatch',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { mainPidfdReady: false } }),
        'drain_anchor_not_ready',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { inventedGeneration: 1 } }),
        'drain_response_shape_mismatch',
      ],
      [drainEvidenceFor(reset, 'pairing', 1), 'drain_purpose_mismatch'],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { purpose: 'pairing' } }),
        'drain_purpose_mismatch',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { purpose: 'pairing' } }),
        'drain_purpose_mismatch',
      ],
      [drainEvidenceFor(reset, 'host_reset', 999), 'drain_reset_generation_stale'],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { resetGeneration: 999 } }),
        'drain_reset_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { resetGeneration: 999 } }),
        'drain_reset_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { deploymentGeneration: 999 } }),
        'drain_deployment_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { deploymentGeneration: 999 } }),
        'drain_deployment_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { processAnchorGeneration: 999 } }),
        'drain_process_anchor_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, {
          drained: { processAnchorGeneration: 999 },
        }),
        'drain_process_anchor_generation_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { ready: { protocolVersion: 999 } }),
        'drain_protocol_version_stale',
      ],
      [
        drainEvidenceFor(reset, 'host_reset', 1, { drained: { protocolVersion: 999 } }),
        'drain_protocol_version_stale',
      ],
    ]) {
      expect(authTransition(reset, { type: 'record_drain_evidence', evidence }).code).toBe(code);
    }
    const currentEvidence = drainEvidenceFor(reset, 'host_reset', 1);
    const recorded = authTransition(reset, {
      type: 'record_drain_evidence',
      evidence: currentEvidence,
    });
    expect(
      authTransition(recorded.state, {
        type: 'record_drain_evidence',
        evidence: currentEvidence,
      }).code
    ).toBe('drain_anchor_not_ready');
  });

  it('distinguishes session logout from device-family revocation', () => {
    const logout = authTransition(pairedState(), { type: 'logout', sessionRef: 'session-ref-1' });
    expect(logout.state.device?.revokedReason).toBeUndefined();
    const forgotten = authTransition(logout.state, { type: 'forget_device' });
    expect(forgotten.state.device?.revokedReason).toBe('forget_device');
    expect(authTransition(logout.state, { type: 'restart' }).state.mutationAdmission).toBe(false);
    expect(authTransition(forgotten.state, { type: 'restart' }).state.mutationAdmission).toBe(
      false
    );
  });

  it('models exact opaque-cookie set, rotate and clear transitions', () => {
    const state = runAuthSchedule([]).state;
    const pairing = runAuthSchedule([
      { type: 'bootstrap', drainEvidence: drainEvidenceFor(state, 'pairing', 0) },
      { type: 'pair' },
    ]);
    expect(pairing.trace.at(-1)?.code).toBe('paired_device_and_session');
    const renewal = authTransition(pairing.state, { type: 'renew', presentedGeneration: 1 });
    expect(renewal.cookieTransitions).toEqual([
      expect.objectContaining({ cookie: '__Secure-atd', operation: 'rotate', domain: null }),
      expect.objectContaining({ cookie: '__Host-ats', operation: 'rotate', domain: null }),
    ]);
    const forgotten = authTransition(renewal.state, { type: 'forget_device' });
    expect(forgotten.cookieTransitions?.map(({ operation }) => operation)).toEqual([
      'clear',
      'clear',
    ]);
  });
});

describe('ADR-7/14 proxy and origin ordering', () => {
  const accepted = {
    peer: '10.0.0.2',
    socketEncrypted: false,
    host: 'app:3456',
    forwarded: { proto: 'https', host: 'teams.example.test' },
    browserRequest: true,
    origin: 'https://teams.example.test',
  };

  it('accepts only the configured origin through an explicitly trusted peer', () => {
    expect(evaluateProxyRequest(accepted, proxyConfig)).toMatchObject({
      accepted: true,
      stage: 'auth_next',
      bodyParsed: false,
    });
  });

  it.each([
    ['direct HTTP', { ...accepted, peer: '203.0.113.8', forwarded: {} }, 'direct_http_forbidden'],
    ['forwarded spoof', { ...accepted, peer: '203.0.113.8' }, 'forwarded_header_spoof'],
    [
      'ambiguous forwarding',
      { ...accepted, forwarded: { proto: 'https,http', host: 'teams.example.test' } },
      'ambiguous_forwarded_authority',
    ],
    [
      'sibling authority',
      { ...accepted, forwarded: { proto: 'https', host: 'teams.example.test:444' } },
      'unexpected_authority',
    ],
    ['cross origin', { ...accepted, origin: 'https://evil.example.test' }, 'unexpected_origin'],
    ['missing origin', { ...accepted, origin: undefined }, 'origin_required'],
  ])('rejects %s before cookie/body/idempotency work', (_name, request, code) => {
    expect(evaluateProxyRequest(request, proxyConfig)).toMatchObject({
      accepted: false,
      code,
      cookieLookup: false,
      bodyParsed: false,
      idempotencyClaimed: false,
    });
  });

  it('refuses wildcard CORS at readiness', () => {
    expect(evaluateProxyRequest(accepted, { ...proxyConfig, corsOrigin: '*' })).toMatchObject({
      accepted: false,
      code: 'cors_origin_must_equal_public_origin',
      stage: 'readiness',
    });
  });

  it('keeps browser cookie authority disjoint from machine runtime ingress', () => {
    expect(evaluateProxyRequest({ ...accepted, surface: 'runtime' }, proxyConfig)).toMatchObject({
      accepted: false,
      code: 'browser_runtime_trust_surfaces_disjoint',
      cookieLookup: false,
    });
  });

  it.each([
    [
      'malformed',
      { parseStatus: 'malformed', headerBytes: 10, maxHeaderBytes: 4096, cookieNames: [] },
    ],
    [
      'oversized',
      { parseStatus: 'parsed', headerBytes: 5000, maxHeaderBytes: 4096, cookieNames: [] },
    ],
    [
      'duplicate',
      {
        parseStatus: 'parsed',
        headerBytes: 30,
        maxHeaderBytes: 4096,
        cookieNames: ['__Host-ats', '__Host-ats'],
      },
    ],
  ])('rejects %s authority-cookie shape before server lookup', (_name, input) => {
    expect(evaluateAuthorityCookieInput(input)).toMatchObject({
      accepted: false,
      cookieLookup: false,
    });
  });
});

describe('ADR-17 artifact and terminal scanner', () => {
  it('characterizes source without consulting mutable ambient standalone output', () => {
    const scan = scanStandalone();
    const committed = JSON.parse(
      readFileSync(
        'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json',
        'utf8'
      )
    );
    expect(committed.emitted).toMatchObject({
      observed: true,
      internalStorageWorkerPresent: false,
      electronEmptyStubPresent: true,
      terminalServiceMarkerPresent: true,
    });
    expect(committed.emitted.files.length).toBeGreaterThan(0);
    expect(scan.source.nativeCatchAllEmptyStub).toBe(true);
    expect(scan.source.broadElectronStub).toBe(true);
    expect(scan.source.standaloneServiceStubs).toBe(true);
    expect(scan.source.terminalNodeInstallStub).toBe(true);
    expect(scan.source.terminalRuntimeArtifactPresent).toBe(false);
    expect(scan.source.standaloneWorkerEntry).toBe(false);
    expect(scan.source.electronWorkerEntry).toBe(true);
    expect(scan.source).toEqual(committed.source);
    expect(scan.emitted).toMatchObject({ observed: false, files: [] });
    expect(committed.terminalAbsence).toEqual(evaluateV1TerminalAbsence(committed));
  });

  it('rejects stale standalone projections when emitted evidence changes', () => {
    const committed = JSON.parse(
      readFileSync(
        'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json',
        'utf8'
      )
    );
    const manifest = JSON.parse(
      readFileSync(
        'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json',
        'utf8'
      )
    );
    expect(manifest.currentStandalone).toEqual(
      buildStandaloneCharacterizationProjection(committed)
    );
    expect(
      validateStandaloneCharacterizationProjection(committed, manifest.currentStandalone)
    ).toEqual({
      ok: true,
      violations: [],
      expected: manifest.currentStandalone,
    });

    const stale = structuredClone(committed);
    stale.emitted.files[0].sha256 = '0'.repeat(64);
    expect(
      validateStandaloneCharacterizationProjection(stale, manifest.currentStandalone)
    ).toMatchObject({
      ok: false,
      violations: ['standalone_characterization_projection_stale'],
    });
  });

  it('fails the v1 absence gate on the current artifact and passes a clean negative fixture', () => {
    const current = scanStandalone();
    expect(evaluateV1TerminalAbsence(current)).toMatchObject({ passes: false });
    const clean = structuredClone(current);
    clean.source.terminalPackages = [];
    clean.source.terminalNodeInstallStub = false;
    clean.source.productionNodeModulesCopiedWhole = false;
    clean.source.terminalHttpRegistration = false;
    clean.source.terminalMigration = false;
    clean.source.terminalRuntimeArtifactPresent = false;
    clean.emitted.terminalServiceMarkerPresent = false;
    clean.emitted.terminalPlatformMarkerPresent = false;
    expect(evaluateV1TerminalAbsence(clean)).toEqual({ passes: true, violations: [] });
  });

  it('validates the shared W4/W6 artifact contract but keeps release closed while rows are unbuilt', () => {
    const contract = JSON.parse(
      readFileSync(
        'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json',
        'utf8'
      )
    );
    expect(evaluateHostedArtifactContract(contract)).toMatchObject({
      contractPasses: true,
      releasePasses: false,
      hostedV1Admitted: false,
      violations: [],
    });
    expect(contract.capabilityClaims).toEqual({
      remoteAuthReady: false,
      remoteMutationReady: false,
      productionCompositionReady: false,
      terminalAbsenceAchieved: false,
    });
  });

  it('rejects a stale native path without promoting a production composition', () => {
    const contract = JSON.parse(
      readFileSync(
        'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json',
        'utf8'
      )
    );
    contract.artifacts.find(
      ({ artifactId }) => artifactId === 'agent-teams-instance-lock'
    ).finalImagePath = '/opt/agent-teams/bin/agent-teams-instance-lock';
    expect(evaluateHostedArtifactContract(contract)).toMatchObject({
      contractPasses: false,
      releasePasses: false,
      hostedV1Admitted: false,
    });
  });

  it('scans every final-image terminal surface and fails closed when one is unscanned', () => {
    const clean = {
      packages: ['fastify'],
      files: ['/app/dist-standalone/index.cjs'],
      routes: ['/api/hosted/v1/meta'],
      migrations: ['001_coordination'],
      capabilities: ['teams.read'],
      processes: ['agent-teams-instance-lock', 'node'],
      rendererChunks: ['team-console.js'],
      ports: ['443/tcp'],
      volumes: ['/app/state'],
    };
    expect(evaluateFinalImageTerminalAbsence(clean)).toEqual({ passes: true, violations: [] });
    expect(
      evaluateFinalImageTerminalAbsence({ ...clean, packages: ['@terminal-platform/foundation'] })
    ).toMatchObject({ passes: false });
    const { rendererChunks: _omitted, ...incomplete } = clean;
    expect(evaluateFinalImageTerminalAbsence(incomplete)).toMatchObject({
      passes: false,
      violations: ['unscanned_surface:renderer_chunk'],
    });
  });

  it('reproduces Node ABI and SQLite write/read/reopen facts from owned code', () => {
    const probe = runAbiSmokeProbe();
    expect(probe.runtime).toMatchObject({ nodeModuleAbi: 137, electronModuleAbi: 143, napi: 10 });
    expect(probe.sqlite).toEqual([
      expect.objectContaining({ packageName: 'better-sqlite3', reopenedValue: 'better-sqlite3' }),
      expect.objectContaining({
        packageName: 'better-sqlite3-node',
        reopenedValue: 'better-sqlite3-node',
      }),
    ]);
  });
});
