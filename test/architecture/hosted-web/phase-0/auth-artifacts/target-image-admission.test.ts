import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderHostedContainerHardeningCompose } from '../../../../../scripts/ci/verify-hosted-container-hardening.mjs';
import {
  collectTargetImageDecision,
  evaluateDisposableInstanceLockMigrationProof,
  evaluateDockerInstanceLockStartup,
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

interface MutableComposeMount {
  read_only?: boolean;
  source?: string;
  target?: string;
  volume?: { nocopy?: boolean };
}

interface MutableComposeService {
  command?: string | string[] | null;
  entrypoint?: string | string[] | null;
  environment?: Record<string, string>;
  volumes?: MutableComposeMount[];
}

interface MutableRenderedCompose {
  services: Record<string, MutableComposeService>;
  volumes?: Record<string, { name?: string }>;
}

function productionStartupSources() {
  const entrypoint = readFileSync('docker/hosted-entrypoint.sh', 'utf8');
  const projectName = `agent-teams-lock-upgrade-${'a'.repeat(32)}`;
  const seededSha256 = { marker: 'b'.repeat(64), database: 'c'.repeat(64) };
  const migrationObservation = {
    observedSha256: { ...seededSha256 },
    applicationDataPath: '/data/.agent-teams/data',
    applicationVolume: `${projectName}_agent-teams-data`,
    lockParentVolume: `${projectName}_agent-teams-instance-lock`,
    lockParent: { uid: 0, gid: 0, mode: '0555', isFile: false },
    lockAnchor: { uid: 0, gid: 0, mode: '0444', isFile: true },
  };
  return {
    dockerfile: readFileSync('docker/Dockerfile', 'utf8'),
    entrypoint,
    imageProbe: {
      Id: digest('a'),
      Config: {
        Entrypoint: ['/usr/local/bin/hosted-entrypoint'],
        Cmd: ['/usr/local/bin/node', '/app/dist-standalone/index.cjs'],
        User: 'node',
      },
      Files: {
        '/data/.agent-teams': { uid: 0, gid: 1000, mode: '1770' },
        '/usr/local/bin/hosted-entrypoint': {
          uid: 0,
          gid: 0,
          mode: '0555',
          sha256: createHash('sha256').update(entrypoint).digest('hex'),
        },
        '/app/bin/agent-teams-instance-lock': { uid: 0, gid: 0, mode: '0555' },
        '/data/.agent-teams/instance-lock': { uid: 0, gid: 0, mode: '0555' },
        '/data/.agent-teams/instance-lock/instance.lock': { uid: 0, gid: 0, mode: '0444' },
      },
    },
    renderedComposes: {
      personal: renderHostedContainerHardeningCompose({
        profile: 'personal',
        environment: { COMPOSE_PROJECT_NAME: 'instance-lock-upgrade-regression' },
      }) as MutableRenderedCompose,
      keycloak: renderHostedContainerHardeningCompose({
        profile: 'keycloak',
        environment: { COMPOSE_PROJECT_NAME: 'instance-lock-upgrade-regression' },
      }) as MutableRenderedCompose,
    },
    migrationProof: {
      format: 'agent-teams-instance-lock-disposable-migration-proof/v1',
      status: 'passed',
      projectName,
      seededSha256,
      profiles: {
        personal: structuredClone(migrationObservation),
        keycloak: structuredClone(migrationObservation),
      },
    },
  };
}

function stateVolume(
  source: ReturnType<typeof productionStartupSources>,
  profile: keyof ReturnType<typeof productionStartupSources>['renderedComposes'],
  serviceName: string
): MutableComposeMount {
  const mount = source.renderedComposes[profile].services[serviceName]?.volumes?.find(
    (candidate) => candidate.target === '/data/.agent-teams'
  );
  if (!mount) throw new Error(`missing test state volume for ${profile}:${serviceName}`);
  return mount;
}

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
  it('builds and copies the production instance lock and makes it the final startup boundary', () => {
    expect(evaluateDockerInstanceLockStartup(productionStartupSources())).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('rejects a direct Node startup bypass and shell command interpolation', () => {
    const directNode = productionStartupSources();
    directNode.dockerfile = directNode.dockerfile.replace(
      'CMD ["/usr/local/bin/node", "/app/dist-standalone/index.cjs"]',
      'CMD ["node", "dist-standalone/index.cjs"]'
    );
    expect(evaluateDockerInstanceLockStartup(directNode)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'dockerfile:absolute_node_cmd_missing',
        'dockerfile:direct_node_bypass',
        'dockerfile:startup_order_invalid',
      ]),
    });

    const interpolated = productionStartupSources();
    interpolated.entrypoint += '\neval "$*"\n';
    expect(evaluateDockerInstanceLockStartup(interpolated)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining(['entrypoint:shell_injection_surface']),
    });
  });

  it('parses active final-stage instructions and requires the built-image ownership probe', () => {
    const commentedEntrypoint = productionStartupSources();
    commentedEntrypoint.dockerfile = commentedEntrypoint.dockerfile.replace(
      'ENTRYPOINT ["/usr/local/bin/hosted-entrypoint"]',
      '# ENTRYPOINT ["/usr/local/bin/hosted-entrypoint"]'
    );
    expect(evaluateDockerInstanceLockStartup(commentedEntrypoint)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'dockerfile:instance_lock_entrypoint_missing',
        'dockerfile:startup_order_invalid',
      ]),
    });

    const wrongOwnership = productionStartupSources();
    wrongOwnership.imageProbe.Files['/app/bin/agent-teams-instance-lock'] = {
      uid: 1000,
      gid: 1000,
      mode: '0755',
    };
    expect(evaluateDockerInstanceLockStartup(wrongOwnership)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'image:file_owner_mismatch:/app/bin/agent-teams-instance-lock',
        'image:file_mode_mismatch:/app/bin/agent-teams-instance-lock',
      ]),
    });

    const mutableAncestor = productionStartupSources();
    mutableAncestor.imageProbe.Files['/data/.agent-teams'] = {
      uid: 1000,
      gid: 1000,
      mode: '0700',
    };
    expect(evaluateDockerInstanceLockStartup(mutableAncestor)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'image:file_owner_mismatch:/data/.agent-teams',
        'image:file_mode_mismatch:/data/.agent-teams',
      ]),
    });
  });

  it('rejects a stale or tampered entrypoint in the built image', () => {
    const staleImage = productionStartupSources();
    staleImage.imageProbe.Files['/usr/local/bin/hosted-entrypoint'].sha256 = 'd'.repeat(64);

    expect(evaluateDockerInstanceLockStartup(staleImage)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining(['image:entrypoint_content_mismatch']),
    });
  });

  it('rejects effective Compose entrypoint bypasses while allowing command-only argv overrides', () => {
    const commandOnly = productionStartupSources();
    commandOnly.renderedComposes.personal.services['agent-teams-personal'].command = [
      '/usr/local/bin/hosted-volume-init',
      'caddy-trust',
    ];
    expect(evaluateDockerInstanceLockStartup(commandOnly)).toEqual({ ok: true, violations: [] });

    const inheritedCommand = productionStartupSources();
    inheritedCommand.renderedComposes.personal.services['agent-teams-personal'].command = null;
    expect(evaluateDockerInstanceLockStartup(inheritedCommand)).toEqual({
      ok: true,
      violations: [],
    });

    for (const [profile, serviceName, override] of [
      [
        'personal',
        'agent-teams-personal',
        ['/usr/local/bin/node', '/app/dist-standalone/index.cjs'],
      ],
      ['keycloak', 'keycloak-volume-init', ['/bin/echo']],
    ] as const) {
      const bypass = productionStartupSources();
      bypass.renderedComposes[profile].services[serviceName].entrypoint = [...override];
      expect(evaluateDockerInstanceLockStartup(bypass)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([`compose:entrypoint_bypass:${profile}:${serviceName}`]),
      });
    }
  });

  it('requires the application lock inode beneath the shared persistent state volume', () => {
    const mutations: Array<(source: ReturnType<typeof productionStartupSources>) => void> = [
      (source) => {
        source.renderedComposes.personal.services['agent-teams-personal'].volumes = [];
      },
      (source) => {
        stateVolume(source, 'keycloak', 'agent-teams-keycloak').read_only = true;
      },
      (source) => {
        stateVolume(source, 'personal', 'agent-teams-personal').source = 'per-container-state';
      },
      (source) => {
        stateVolume(source, 'personal', 'agent-teams-personal').volume = { nocopy: true };
      },
    ];
    for (const mutation of mutations) {
      const bypass = productionStartupSources();
      mutation(bypass);
      expect(evaluateDockerInstanceLockStartup(bypass)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([
          expect.stringMatching(/^compose:shared_persistent_lock_missing:/u),
        ]),
      });
    }
  });

  it('binds each rendered profile to the legacy physical application-data volume', () => {
    const source = productionStartupSources();

    for (const [profile, serviceName] of [
      ['personal', 'agent-teams-personal'],
      ['keycloak', 'agent-teams-keycloak'],
    ] as const) {
      const rendered = source.renderedComposes[profile];
      expect(rendered.volumes).toMatchObject({
        'agent-teams-data': {
          name: 'instance-lock-upgrade-regression_agent-teams-instance-lock',
        },
        'agent-teams-application-data': {
          name: 'instance-lock-upgrade-regression_agent-teams-data',
        },
      });
      expect(rendered.services[serviceName].volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'volume',
            source: 'agent-teams-data',
            target: '/data/.agent-teams',
          }),
          expect.objectContaining({
            type: 'volume',
            source: 'agent-teams-application-data',
            target: '/data/.agent-teams/data',
          }),
        ])
      );
      expect(rendered.services[serviceName].environment?.AUTH_DATA_DIR).toBe(
        '/data/.agent-teams/data'
      );
    }

    expect(evaluateDockerInstanceLockStartup(source)).toEqual({ ok: true, violations: [] });
  });

  it('rejects upgrade admission without byte-identical disposable migration observations', () => {
    const source = productionStartupSources();
    source.migrationProof.profiles.keycloak.observedSha256.database = 'd'.repeat(64);
    source.migrationProof.profiles.personal.lockAnchor.uid = 1000;

    expect(evaluateDisposableInstanceLockMigrationProof(source.migrationProof)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'keycloak_database_bytes_not_preserved',
        'personal_root_owned_lock_anchor_invalid',
      ]),
    });
    expect(evaluateDockerInstanceLockStartup(source)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        'upgrade:keycloak_database_bytes_not_preserved',
        'upgrade:personal_root_owned_lock_anchor_invalid',
      ]),
    });
  });

  it('rejects PATH-resolved stat before the lock boundary', () => {
    const pathResolved = productionStartupSources();
    pathResolved.entrypoint = pathResolved.entrypoint.replaceAll('/usr/bin/stat', 'stat');
    expect(evaluateDockerInstanceLockStartup(pathResolved)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining(['entrypoint:path_resolved_stat']),
    });
  });

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
