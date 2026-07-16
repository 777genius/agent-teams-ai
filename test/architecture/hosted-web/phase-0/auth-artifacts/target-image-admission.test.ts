import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  collectTargetImageDecision,
  evaluateTargetImageAdmission,
  normalizeDecisionFacts,
  REQUIRED_CANONICAL_SOURCE_COMMIT,
  REQUIRED_CANONICAL_SOURCE_TREE,
  runProviderCanaryFixture,
  TARGET_IMAGE_DECISION_PATH,
  TERMINAL_SENSITIVE_SURFACES,
  verifyCommittedTargetImageDecision,
  // @ts-expect-error The repository-owned JavaScript admission harness has no declaration file.
} from '../../../../../scripts/hosted-web/phase-0/auth-artifacts/prove-target-image-admission.mjs';

// The canonical-source gates read git objects of the pinned historical commit; a shallow
// clone (e.g. default CI fetch-depth) cannot serve them. CI deep-fetches to run these;
// shallow local clones skip them visibly instead of failing on git plumbing.
const canonicalCommitReachable =
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- same PATH-resolved git the admission harness itself uses; test-only capability probe
  spawnSync('git', ['cat-file', '-e', `${REQUIRED_CANONICAL_SOURCE_COMMIT}^{commit}`], {
    encoding: 'utf8',
  }).status === 0;
const canonicalSourceIt = canonicalCommitReachable ? it : it.skip;

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function admittedInput() {
  return {
    image: {
      identity: {
        digest: digest('1'),
        manifestDigest: digest('2'),
        configDigest: digest('7'),
        baseImageDigests: [digest('3')],
      },
      profile: {
        os: 'debian-slim',
        architecture: 'linux-x64',
        nodeMajor: 24,
        uid: 10001,
        gid: 10001,
        readOnlyRoot: true,
        noNewPrivileges: true,
        capabilityDrop: ['ALL'],
        seccompProfileDigest: digest('4'),
        init: { present: true, path: '/usr/bin/tini' },
        launcherBeforeNode: true,
        startupOrder: [
          '/usr/bin/tini',
          '/app/bin/agent-teams-instance-lock',
          '/app/bin/agent-teams-process-anchor',
          'node',
        ],
      },
      inventory: {
        complete: true,
        observedFromImageDigest: digest('1'),
        scannerDigest: digest('8'),
        packages: ['nodejs'],
        files: [
          '/app/bin/agent-teams-instance-lock',
          '/app/bin/agent-teams-process-anchor',
          '/app/bin/agent-teams-workspace-guard',
          '/app/dist-standalone/index.cjs',
        ],
        routes: ['/api/hosted/v1'],
        migrations: ['internal-storage-v1'],
        capabilities: ['hosted-command'],
        processes: [
          '/usr/bin/tini',
          '/app/bin/agent-teams-instance-lock',
          '/app/bin/agent-teams-process-anchor',
          'node',
        ],
        rendererChunks: ['hosted-app.js'],
        ports: ['127.0.0.1:3456'],
        volumes: ['/data/state'],
      },
    },
    controllerArtifacts: [
      ['agent-teams-instance-lock', '/app/bin/agent-teams-instance-lock'],
      ['agent-teams-process-anchor', '/app/bin/agent-teams-process-anchor'],
      ['agent-teams-workspace-guard', '/app/bin/agent-teams-workspace-guard'],
    ].map(([artifactId, finalImagePath], index) => ({
      artifactId,
      finalImagePath,
      binaryDigest: digest('5'),
      builderImageDigest: digest('6'),
      compilerIdentity: `cc-fixture-v${index + 1}`,
      uid: 0,
      gid: 0,
      mode: 0o755,
    })),
    providerCanaries: {
      status: 'passed_target_image',
      rawCredentialValueRecorded: false,
      records: ['anthropic', 'codex', 'gemini', 'opencode'].map((provider) => ({
        provider,
        executedInTargetImage: true,
        targetImageDigest: digest('1'),
        canaryEvidenceDigest: digest('9'),
        expectedCanaryPresent: true,
        crossProviderCanaryKeys: [],
        rawCredentialValueRecorded: false,
        outputRedactionVerified: true,
      })),
    },
  };
}

function committedDecision() {
  return JSON.parse(readFileSync(TARGET_IMAGE_DECISION_PATH, 'utf8'));
}

function unset(object: unknown, key: string) {
  delete (object as Record<string, unknown>)[key];
}

describe('Phase 0 target-image narrowing and Phase 5 admission', () => {
  it('admits only a complete immutable, terminal-negative image/profile proof', () => {
    expect(evaluateTargetImageAdmission(admittedInput())).toEqual({
      admitted: true,
      disposition: 'admitted',
      violations: [],
      terminalNegative: true,
    });
  });

  canonicalSourceIt(
    'preserves all 51 canonical-source obligations and all nine terminal surfaces',
    () => {
      const decision = collectTargetImageDecision();
      const gaps = decision.phase5AdmissionGate.canonicalSourceGaps;
      expect(gaps).toHaveLength(51);
      const counts = gaps.reduce((result: Record<string, number>, gap: string) => {
        const group = gap.split(':')[0];
        result[group] = (result[group] ?? 0) + 1;
        return result;
      }, {});
      expect(counts).toEqual({
        composition: 21,
        image: 4,
        inventory: 3,
        profile: 12,
        provider_runtime: 2,
        terminal_negative: 9,
      });
      expect(decision.phase5AdmissionGate.terminalSensitiveSurfaces).toEqual(
        TERMINAL_SENSITIVE_SURFACES
      );
      expect(decision.phase5AdmissionGate.terminalNegative).toBe(false);
      expect(committedDecision().phase5AdmissionGate.canonicalSourceGaps).toEqual(gaps);
    }
  );

  it.each([
    [
      'identity.digest',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.identity, 'digest'),
    ],
    [
      'identity.manifestDigest',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.identity, 'manifestDigest'),
    ],
    [
      'identity.configDigest',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.identity, 'configDigest'),
    ],
    [
      'identity.baseImageDigests',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.identity, 'baseImageDigests'),
    ],
    ['profile.os', (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'os')],
    [
      'profile.architecture',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'architecture'),
    ],
    [
      'profile.nodeMajor',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'nodeMajor'),
    ],
    ['profile.uid', (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'uid')],
    ['profile.gid', (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'gid')],
    [
      'profile.readOnlyRoot',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'readOnlyRoot'),
    ],
    [
      'profile.noNewPrivileges',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'noNewPrivileges'),
    ],
    [
      'profile.capabilityDrop',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'capabilityDrop'),
    ],
    [
      'profile.seccompProfileDigest',
      (input: ReturnType<typeof admittedInput>) =>
        unset(input.image.profile, 'seccompProfileDigest'),
    ],
    [
      'profile.init',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'init'),
    ],
    [
      'profile.launcherBeforeNode',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'launcherBeforeNode'),
    ],
    [
      'profile.startupOrder',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.profile, 'startupOrder'),
    ],
    [
      'inventory.complete',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.inventory, 'complete'),
    ],
    [
      'inventory.observedFromImageDigest',
      (input: ReturnType<typeof admittedInput>) =>
        unset(input.image.inventory, 'observedFromImageDigest'),
    ],
    [
      'inventory.scannerDigest',
      (input: ReturnType<typeof admittedInput>) => unset(input.image.inventory, 'scannerDigest'),
    ],
  ])('fails closed when %s is absent', (_label, mutate) => {
    const input = admittedInput();
    mutate(input);
    expect(evaluateTargetImageAdmission(input).admitted).toBe(false);
  });

  it.each([
    'binaryDigest',
    'builderImageDigest',
    'compilerIdentity',
    'uid',
    'gid',
    'mode',
    'finalImagePath',
  ] as const)('fails closed when a native artifact %s is absent', (field) => {
    const input = admittedInput();
    unset(input.controllerArtifacts[0], field);
    expect(evaluateTargetImageAdmission(input).admitted).toBe(false);
  });

  it('fails closed for missing artifacts, invalid startup order and unbound provider canaries', () => {
    const missingArtifact = admittedInput();
    missingArtifact.controllerArtifacts.pop();
    expect(evaluateTargetImageAdmission(missingArtifact).admitted).toBe(false);

    const badStartup = admittedInput();
    badStartup.image.profile.startupOrder = [
      '/usr/bin/tini',
      'node',
      '/app/bin/agent-teams-instance-lock',
      '/app/bin/agent-teams-process-anchor',
    ];
    expect(evaluateTargetImageAdmission(badStartup).admitted).toBe(false);

    const unboundCanary = admittedInput();
    unboundCanary.providerCanaries.records[0].targetImageDigest = digest('a');
    expect(evaluateTargetImageAdmission(unboundCanary).admitted).toBe(false);
  });

  it('rejects terminal, PTY and xterm markers on every final-image surface', () => {
    for (const surface of TERMINAL_SENSITIVE_SURFACES) {
      const input = admittedInput();
      (input.image.inventory as unknown as Record<string, string[]>)[surface].push(
        'xterm-negative-canary'
      );
      const result = evaluateTargetImageAdmission(input);
      expect(result.admitted).toBe(false);
      expect(
        result.violations.some((value: string) => value.startsWith('terminal_negative:'))
      ).toBe(true);
    }
  });

  it('runs synthetic provider fixtures without cross-provider or raw-value exposure', () => {
    const fixture = runProviderCanaryFixture();
    expect(fixture).toMatchObject({
      status: 'passed_fixture_only',
      executionBoundary: 'synthetic_environment_records_no_project_opened',
      rawCredentialValueRecorded: false,
      redactionToken: '[REDACTED]',
    });
    expect(fixture.records).toHaveLength(4);
    for (const record of fixture.records) {
      expect(record.crossProviderCanaryKeys).toEqual([]);
      expect(Object.values(record.canaryRendering)).toEqual(['[REDACTED]']);
    }
  });

  it('accepts the Phase 0 narrowing while keeping the Phase 5 gate closed', () => {
    expect(committedDecision()).toMatchObject({
      decision: {
        id: 'P0.D.TARGET_IMAGE',
        state: 'accepted',
        outcome: 'capability_narrowed',
        phase0Gate: 'closed_by_accepted_narrowing',
        exactImageEarliestOwner: 'phase-5',
      },
      sourceIdentity: {
        canonicalCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
        canonicalTree: REQUIRED_CANONICAL_SOURCE_TREE,
      },
      scope: {
        realUserProjectsOpened: false,
        dockerSocketRequiredForPhase0Decision: false,
        liveContainerRuntimeObservationInDeterministicFacts: false,
      },
      phase5AdmissionGate: { state: 'fail_closed', admitted: false },
    });
    expect(Object.values(committedDecision().claims)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  canonicalSourceIt('separates immutable source identity from descendant evidence identity', () => {
    const decision = committedDecision();
    const descendantHead = 'f'.repeat(40);
    const result = verifyCommittedTargetImageDecision(decision, {
      repositoryHeadAtVerification: descendantHead,
      sourceRelationship: 'source_or_descendant',
    });
    expect(result).toMatchObject({
      ok: true,
      normalizedFactsMatch: true,
      sourceIdentityValid: true,
      authorityProvenanceValid: true,
      sourceRelationshipValid: true,
      evidenceIdentity: {
        repositoryHeadAtVerification: descendantHead,
        canonicalSourceCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
        sourceRelationship: 'source_or_descendant',
      },
    });
    expect(decision.sourceIdentity.canonicalCommit).toBe(REQUIRED_CANONICAL_SOURCE_COMMIT);
    expect(decision).not.toHaveProperty('repositoryHeadAtVerification');
  });

  canonicalSourceIt('rejects a non-descendant evidence identity and provenance tampering', () => {
    const decision = committedDecision();
    expect(
      verifyCommittedTargetImageDecision(decision, {
        repositoryHeadAtVerification: 'e'.repeat(40),
        sourceRelationship: 'not_source_or_descendant',
      }).ok
    ).toBe(false);

    decision.authorities[0].sha256 = '0'.repeat(64);
    const tampered = verifyCommittedTargetImageDecision(decision, {
      repositoryHeadAtVerification: REQUIRED_CANONICAL_SOURCE_COMMIT,
      sourceRelationship: 'source_or_descendant',
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.authorityProvenanceValid).toBe(false);
  });

  canonicalSourceIt('uses normalized fact comparison rather than serialized object order', () => {
    const decision = committedDecision();
    const reordered = Object.fromEntries(Object.entries(decision).reverse());
    expect(normalizeDecisionFacts(reordered)).toEqual(normalizeDecisionFacts(decision));
    expect(
      verifyCommittedTargetImageDecision(reordered, {
        repositoryHeadAtVerification: REQUIRED_CANONICAL_SOURCE_COMMIT,
        sourceRelationship: 'source_or_descendant',
      }).ok
    ).toBe(true);
  });

  it('keeps live Docker state outside the deterministic decision and verifier', () => {
    const source = readFileSync(
      'scripts/hosted-web/phase-0/auth-artifacts/prove-target-image-admission.mjs',
      'utf8'
    );
    expect(source).not.toContain('docker version');
    expect(source).not.toContain('probeContainerRuntime');
    expect(committedDecision()).not.toHaveProperty('containerRuntimeProbe');
  });

  canonicalSourceIt('contains no real-project path or raw credential', () => {
    const serialized = JSON.stringify(collectTargetImageDecision());
    for (const pattern of [
      /phase0:(?:anthropic|codex|gemini|opencode):credential:canary/,
      /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
      /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
      /\bBearer\s+[A-Za-z0-9._~-]+/,
    ]) {
      expect(serialized).not.toMatch(pattern);
    }
  });
});
