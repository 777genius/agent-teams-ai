import {
  authorizeProductionTeamCreateRequest,
  authorizeProductionTeamLaunchRequest,
} from '@main/ipc/teams/authorizeProductionTeamCreateRequest';
import {
  bindAuthoritativeModelExecutionProof,
  canonicalProjectPathComparisonKey,
  captureAuthoritativeProofEpoch,
  claimAuthoritativeModelExecutionProofInvocation,
  consumeLeadRuntimeRestartProof,
  consumeLeadRuntimeRestartProofForCurrentOwner,
  invalidateAuthoritativeModelExecutionProofs,
  invalidateAuthoritativeModelExecutionProofsForProvider,
  issueAuthoritativeModelExecutionProof,
  issueLeadRuntimeRestartProof,
  verifyAuthoritativeModelExecutionProof,
  verifyAuthoritativeModelExecutionProofForRequest,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { buildEffectiveRuntimeRosterRevision } from '@shared/utils/effectiveMemberRuntimeIdentity';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeadRuntimeRestartProofBinding } from '@main/services/team/TeamLaunchExecutionProofAuthority';
import type { TeamLaunchRequest, TeamProvisioningModelCheckRequest } from '@shared/types';

const PROJECT_PATH = process.cwd();

function consumeExecutionProof(
  proof: Parameters<typeof claimAuthoritativeModelExecutionProofInvocation>[0],
  nowMs = Date.now()
): boolean {
  const lease = claimAuthoritativeModelExecutionProofInvocation(proof, nowMs);
  return lease?.beginInvocation(() => undefined).started === true;
}

describe('TeamLaunchExecutionProofAuthority', () => {
  afterEach(() => invalidateAuthoritativeModelExecutionProofs());

  const request = (overrides: Partial<TeamLaunchRequest> = {}): TeamLaunchRequest => {
    const value = {
      teamName: 'team',
      cwd: PROJECT_PATH,
      providerId: 'codex' as const,
      providerBackendId: 'codex-native' as const,
      model: 'gpt-5',
      ...overrides,
    };
    return {
      ...value,
      leadRuntimeSelectionProvenance: overrides.leadRuntimeSelectionProvenance ?? {
        version: 1,
        providerBackendId: value.providerBackendId == null ? 'default' : 'explicit',
        model: value.model?.trim() ? 'explicit' : 'default',
        effort: value.effort ? 'explicit' : 'default',
      },
    };
  };

  const runtimeRosterRevision = (
    launch: TeamLaunchRequest = request(),
    members: Parameters<typeof verifyAuthoritativeModelExecutionProofForRequest>[2] = []
  ) =>
    buildEffectiveRuntimeRosterRevision({
      lead: {
        providerId: launch.providerId ?? 'anthropic',
        providerBackendId: launch.providerBackendId,
        model: launch.model,
        effort: launch.effort,
      },
      leadRuntimeSelectionProvenance: launch.leadRuntimeSelectionProvenance,
      members,
      missingProvenance: 'reject',
    })!;

  const issue = (
    checks: TeamProvisioningModelCheckRequest[],
    completedAtMs = Date.now(),
    revision = runtimeRosterRevision()
  ) =>
    issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
      cwd: PROJECT_PATH,
      checks,
      completedAtMs,
      runtimeRosterRevision: revision,
    });

  it('binds only the exact submitted authority ID and generation', () => {
    const now = Date.now();
    const proof = issue(
      [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' }],
      now
    );
    const submitted = request({ executionProof: proof });
    expect(verifyAuthoritativeModelExecutionProofForRequest(proof, submitted, [], now + 1)).toBe(
      true
    );

    const bound = authorizeProductionTeamLaunchRequest(submitted, [], true).executionProof!;
    expect(bound.authorityId).not.toBe(proof.authorityId);
    expect(bound.generation).toBeGreaterThan(proof.generation);
    expect(verifyAuthoritativeModelExecutionProof(proof, now + 1)).toBe(false);
    expect(consumeExecutionProof(bound, now + 1)).toBe(true);
    expect(consumeExecutionProof(bound, now + 2)).toBe(false);
  });

  it('failed fresh check plus omitted candidate cannot discover or consume an older proof', () => {
    const oldProof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);

    // A failed/aborted refresh publishes no candidate. The main boundary must
    // not search retained authority records by digest to recover oldProof.
    expect(() => authorizeProductionTeamLaunchRequest(request(), [], true)).toThrow(
      'Fresh authoritative launch authorization is required'
    );
    expect(verifyAuthoritativeModelExecutionProof(oldProof)).toBe(true);
  });

  it.each(['api', 'adapter'] as const)(
    'keeps exact Codex backend %s proof separated from a different route',
    (providerBackendId) => {
      const differentBackend = providerBackendId === 'api' ? 'adapter' : 'api';
      const exact = issue(
        [{ providerId: 'codex', providerBackendId, model: 'gpt-5' }],
        Date.now(),
        runtimeRosterRevision(request({ providerBackendId }))
      );
      const different = issue(
        [{ providerId: 'codex', providerBackendId: differentBackend, model: 'gpt-5' }],
        Date.now(),
        runtimeRosterRevision(request({ providerBackendId: differentBackend }))
      );
      const exactRequest = request({ providerBackendId, executionProof: different });

      expect(verifyAuthoritativeModelExecutionProof(exact)).toBe(true);
      expect(verifyAuthoritativeModelExecutionProof(different)).toBe(true);
      expect(() => authorizeProductionTeamLaunchRequest(exactRequest, [], true)).toThrow(
        'Fresh authoritative launch authorization is required'
      );

      const authorized = authorizeProductionTeamLaunchRequest(
        { ...exactRequest, executionProof: exact },
        [],
        true
      );
      expect(authorized.executionProof?.authorityId).not.toBe(exact.authorityId);
      expect(verifyAuthoritativeModelExecutionProof(different)).toBe(true);
    }
  );

  it('does not treat Codex auto as an exact backend proof identity', () => {
    const autoRequest = request({ providerBackendId: 'auto' });
    const proof = issue(
      [{ providerId: 'codex', providerBackendId: 'auto', model: 'gpt-5' }],
      Date.now(),
      runtimeRosterRevision(autoRequest)
    );
    const invoke = vi.fn();
    expect(() => {
      const authorized = authorizeProductionTeamLaunchRequest(
        { ...autoRequest, executionProof: proof },
        [],
        true
      );
      invoke(authorized);
    }).toThrow('Fresh authoritative launch authorization is required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('binds provider, backend, model, effort, cwd, and semantic roster', () => {
    const launch = request({ effort: 'high' });
    const roster = [
      {
        name: 'builder',
        providerId: 'gemini' as const,
        providerBackendId: 'cli-sdk' as const,
        model: 'gemini-2.5-pro',
        effort: 'low' as const,
        runtimeSelectionProvenance: {
          version: 1 as const,
          providerBackendId: 'explicit' as const,
          model: 'explicit' as const,
          effort: 'explicit' as const,
        },
      },
    ];
    const boundProof = issue(
      [
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
        },
        {
          providerId: 'gemini',
          providerBackendId: 'cli-sdk',
          model: 'gemini-2.5-pro',
          effort: 'low',
        },
      ],
      Date.now(),
      runtimeRosterRevision(launch, roster)
    );
    expect(verifyAuthoritativeModelExecutionProofForRequest(boundProof, launch, roster)).toBe(true);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        boundProof,
        { ...launch, effort: 'xhigh' },
        roster
      )
    ).toBe(false);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(boundProof, launch, [
        { ...roster[0], model: 'gemini-mismatch' },
      ])
    ).toBe(false);
  });

  it('preserves explicit null as the Anthropic backend identity', () => {
    const proof = issue(
      [{ providerId: 'anthropic', providerBackendId: null, model: 'claude-sonnet-4-5' }],
      Date.now(),
      runtimeRosterRevision(
        request({
          providerId: 'anthropic',
          providerBackendId: undefined,
          model: 'claude-sonnet-4-5',
        })
      )
    );
    const launch = request({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'claude-sonnet-4-5',
      executionProof: proof,
    });
    expect(verifyAuthoritativeModelExecutionProofForRequest(proof, launch, [])).toBe(true);
  });

  it('verifies against the same non-tombstoned roster that launch dispatch uses', () => {
    const proof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);
    const launch = request({ executionProof: proof });

    expect(
      verifyAuthoritativeModelExecutionProofForRequest(proof, launch, [
        {
          name: 'removed',
          providerId: 'gemini',
          providerBackendId: 'api',
          model: 'gemini-stale',
          removedAt: 1_777_000_000_000,
        },
      ])
    ).toBe(true);
  });

  it('separates the experimental override decision and confirms create/launch candidates once', () => {
    const checks = [
      {
        providerId: 'opencode' as const,
        providerBackendId: 'opencode-cli' as const,
        model: 'ollama/qwen',
      },
    ];
    const launch = request({
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'ollama/qwen',
      allowExperimentalLocalModels: true,
    });
    const proof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
      cwd: PROJECT_PATH,
      checks,
      allowExperimentalLocalModels: true,
      runtimeRosterRevision: runtimeRosterRevision(launch),
    });
    launch.executionProof = proof;
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        proof,
        { ...launch, allowExperimentalLocalModels: undefined },
        []
      )
    ).toBe(false);
    const authorizedLaunch = authorizeProductionTeamLaunchRequest(launch, [], true);
    expect(consumeExecutionProof(authorizedLaunch.executionProof!)).toBe(true);
    expect(consumeExecutionProof(authorizedLaunch.executionProof!)).toBe(false);

    const createProof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
      cwd: PROJECT_PATH,
      checks,
      allowExperimentalLocalModels: true,
      runtimeRosterRevision: runtimeRosterRevision(launch),
    });
    const authorizedCreate = authorizeProductionTeamCreateRequest(
      { ...launch, members: [], displayName: 'Experimental', executionProof: createProof },
      true
    );
    expect(consumeExecutionProof(authorizedCreate.executionProof!)).toBe(true);
    expect(consumeExecutionProof(authorizedCreate.executionProof!)).toBe(false);
  });

  it('fails closed for a missing model or missing non-Anthropic backend', () => {
    const proof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        proof,
        request({ model: undefined, executionProof: proof }),
        []
      )
    ).toBe(false);
    expect(
      verifyAuthoritativeModelExecutionProofForRequest(
        proof,
        request({ providerBackendId: undefined, executionProof: proof }),
        []
      )
    ).toBe(false);
  });

  it('authorizes the recomputed inherited tuple and rejects old or differently inherited proof', () => {
    const launch = request({
      providerBackendId: 'adapter',
      model: 'gpt-6',
      effort: 'xhigh',
    });
    const inheritedRoster = [
      {
        name: 'worker',
        providerId: 'codex' as const,
        providerBackendId: 'codex-native' as const,
        model: 'gpt-5',
        effort: 'high' as const,
        runtimeSelectionProvenance: {
          version: 1 as const,
          providerBackendId: 'inherited' as const,
          model: 'inherited' as const,
          effort: 'inherited' as const,
        },
      },
    ];
    const revision = runtimeRosterRevision(launch, inheritedRoster);
    const exact = issue(
      [
        {
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-6',
          effort: 'xhigh',
        },
      ],
      Date.now(),
      revision
    );
    expect(verifyAuthoritativeModelExecutionProofForRequest(exact, launch, inheritedRoster)).toBe(
      true
    );

    const old = issue(
      [
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
        },
      ],
      Date.now(),
      runtimeRosterRevision(request({ effort: 'high' }), inheritedRoster)
    );
    expect(verifyAuthoritativeModelExecutionProofForRequest(old, launch, inheritedRoster)).toBe(
      false
    );

    const explicitRoster = [
      {
        ...inheritedRoster[0],
        providerBackendId: 'adapter' as const,
        model: 'gpt-6',
        effort: 'xhigh' as const,
        runtimeSelectionProvenance: {
          version: 1 as const,
          providerBackendId: 'explicit' as const,
          model: 'explicit' as const,
          effort: 'explicit' as const,
        },
      },
    ];
    expect(verifyAuthoritativeModelExecutionProofForRequest(exact, launch, explicitRoster)).toBe(
      false
    );
  });

  it('blocks legacy and stale partial-continuation evidence before any fake launch call', () => {
    const launchAdapter = { launch: vi.fn() };
    const launch = request({
      providerBackendId: 'adapter',
      model: 'gpt-6',
      effort: 'xhigh',
    });
    const legacyRoster = [
      {
        name: 'legacy-worker',
        providerId: 'codex' as const,
        providerBackendId: 'codex-native' as const,
        model: 'gpt-5',
        effort: 'high' as const,
      },
    ];
    const staleProof = issue([
      {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'high',
      },
    ]);

    expect(() =>
      authorizeProductionTeamLaunchRequest(
        { ...launch, executionProof: staleProof },
        legacyRoster,
        true
      )
    ).toThrow('Fresh authoritative launch authorization is required');
    expect(launchAdapter.launch).toHaveBeenCalledTimes(0);
  });

  it('rejects caller-minted and expired candidates', () => {
    const now = 10_000;
    const proof = issue(
      [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' }],
      now
    );
    expect(verifyAuthoritativeModelExecutionProof(proof, now + 59_999)).toBe(true);
    expect(verifyAuthoritativeModelExecutionProof(proof, now + 60_000)).toBe(false);
    expect(() =>
      authorizeProductionTeamLaunchRequest(
        request({
          executionProof: {
            authorityId: 'caller',
            generation: 1,
            completedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            requestDigest: '0'.repeat(64),
          },
        }),
        [],
        true
      )
    ).toThrow('Fresh authoritative launch authorization is required');
  });

  it('prevents rebinding a consumed source proof', () => {
    const proof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);
    bindAuthoritativeModelExecutionProof(proof, 'first');
    expect(() => bindAuthoritativeModelExecutionProof(proof, 'second')).toThrow(
      'no longer authoritative'
    );
  });

  it('rejects late issuance after the captured preparation epoch is invalidated', () => {
    const authorityEpoch = captureAuthoritativeProofEpoch(PROJECT_PATH);
    invalidateAuthoritativeModelExecutionProofs();
    expect(() =>
      issueAuthoritativeModelExecutionProof({
        authorityEpoch,
        cwd: PROJECT_PATH,
        checks: [],
      })
    ).toThrow('epoch changed during preparation');
  });

  it('keeps an unrelated provider attempt and proof valid after provider invalidation', () => {
    const codexProof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);
    const geminiProof = issue([
      { providerId: 'gemini', providerBackendId: 'api', model: 'gemini-2.5-pro' },
    ]);
    const codexAttempt = captureAuthoritativeProofEpoch(PROJECT_PATH);
    const geminiAttempt = captureAuthoritativeProofEpoch(PROJECT_PATH);

    invalidateAuthoritativeModelExecutionProofsForProvider('codex');

    expect(verifyAuthoritativeModelExecutionProof(codexProof)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(geminiProof)).toBe(true);
    expect(() =>
      issueAuthoritativeModelExecutionProof({
        authorityEpoch: codexAttempt,
        cwd: PROJECT_PATH,
        checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-6' }],
      })
    ).toThrow('provider authority changed during preparation');
    const laterGeminiProof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: geminiAttempt,
      cwd: PROJECT_PATH,
      checks: [{ providerId: 'gemini', providerBackendId: 'api', model: 'gemini-3-pro' }],
    });
    expect(verifyAuthoritativeModelExecutionProof(laterGeminiProof)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects replacement between attempt capture and proof issuance',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-attempt-replacement-'));
      const project = path.join(root, 'project');
      const displaced = path.join(root, 'project-displaced');
      try {
        fs.mkdirSync(project);
        const authorityEpoch = captureAuthoritativeProofEpoch(project);
        fs.renameSync(project, displaced);
        fs.mkdirSync(project);

        expect(() =>
          issueAuthoritativeModelExecutionProof({ authorityEpoch, cwd: project, checks: [] })
        ).toThrow('project root changed during preparation');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('rejects the same visible tuple after a root authority handoff', () => {
    const proof = issue([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
    ]);
    const sameTuple = request({ executionProof: proof });
    expect(verifyAuthoritativeModelExecutionProofForRequest(proof, sameTuple, [])).toBe(true);

    invalidateAuthoritativeModelExecutionProofs();

    expect(verifyAuthoritativeModelExecutionProofForRequest(proof, sameTuple, [])).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a proof after its symlink cwd is retargeted',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-symlink-'));
      try {
        const projectA = path.join(root, 'project-a');
        const projectB = path.join(root, 'project-b');
        const linkedProject = path.join(root, 'project');
        fs.mkdirSync(projectA);
        fs.mkdirSync(projectB);
        fs.symlinkSync(projectA, linkedProject, 'dir');
        const authorityEpoch = captureAuthoritativeProofEpoch(linkedProject);
        const proof = issueAuthoritativeModelExecutionProof({
          authorityEpoch,
          cwd: linkedProject,
          checks: [],
        });

        fs.unlinkSync(linkedProject);
        fs.symlinkSync(projectB, linkedProject, 'dir');

        expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(false);
        expect(consumeExecutionProof(proof)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('rejects a proof after the project directory is replaced at the same path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-replacement-'));
    const project = path.join(root, 'project');
    try {
      fs.mkdirSync(project);
      const proof = issueAuthoritativeModelExecutionProof({
        authorityEpoch: captureAuthoritativeProofEpoch(project),
        cwd: project,
        checks: [],
      });
      fs.rmSync(project, { recursive: true });
      fs.mkdirSync(project);

      expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(false);
      expect(consumeExecutionProof(proof)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a proof valid across ordinary child-file mutations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-child-mutation-'));
    const project = path.join(root, 'project');
    try {
      fs.mkdirSync(project);
      const proof = issueAuthoritativeModelExecutionProof({
        authorityEpoch: captureAuthoritativeProofEpoch(project),
        cwd: project,
        checks: [],
      });
      const child = path.join(project, 'ordinary.txt');
      fs.writeFileSync(child, 'one');
      fs.writeFileSync(child, 'two');
      fs.unlinkSync(child);

      expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(true);
      expect(consumeExecutionProof(proof)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'returns 32 never-verified proof leases to the FD baseline at fake-clock expiry',
    () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
      const fdCount = () => fs.readdirSync('/proc/self/fd').length;
      const baseline = fdCount();
      try {
        for (let index = 0; index < 32; index += 1) {
          issueAuthoritativeModelExecutionProof({
            authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
            cwd: PROJECT_PATH,
            checks: [
              {
                providerId: 'codex',
                providerBackendId: 'codex-native',
                model: `expiry-${index}`,
              },
            ],
          });
        }
        expect(fdCount()).toBe(baseline + 32);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(60_000);

        expect(fdCount()).toBe(baseline);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        invalidateAuthoritativeModelExecutionProofs();
        vi.useRealTimers();
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'transfers or closes each lease once across replace, bind, consume, and invalidate',
    () => {
      const fdCount = () => fs.readdirSync('/proc/self/fd').length;
      const baseline = fdCount();
      const checks = [
        { providerId: 'codex' as const, providerBackendId: 'codex-native' as const, model: 'one' },
      ];
      const source = issue(checks);
      expect(fdCount()).toBe(baseline + 1);
      const bound = bindAuthoritativeModelExecutionProof(source, 'exact-request');
      expect(fdCount()).toBe(baseline + 1);
      expect(consumeExecutionProof(bound)).toBe(true);
      expect(fdCount()).toBe(baseline);

      issue(checks);
      issue(checks);
      expect(fdCount()).toBe(baseline + 1);
      invalidateAuthoritativeModelExecutionProofs();
      expect(fdCount()).toBe(baseline);
      invalidateAuthoritativeModelExecutionProofs();
      expect(fdCount()).toBe(baseline);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'returns 32 unused and 32 claimed invocation leases to the FD baseline',
    () => {
      const fdCount = () => fs.readdirSync('/proc/self/fd').length;
      const baseline = fdCount();
      const issueMany = () =>
        Array.from({ length: 32 }, (_, index) =>
          issueAuthoritativeModelExecutionProof({
            authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
            cwd: PROJECT_PATH,
            checks: [
              {
                providerId: 'codex',
                providerBackendId: 'codex-native',
                model: `lease-${index}`,
              },
            ],
          })
        );

      issueMany();
      expect(fdCount()).toBe(baseline + 32);
      invalidateAuthoritativeModelExecutionProofs();
      expect(fdCount()).toBe(baseline);

      const claims = issueMany().map((proof) =>
        claimAuthoritativeModelExecutionProofInvocation(proof)
      );
      expect(claims.every(Boolean)).toBe(true);
      expect(fdCount()).toBe(baseline + 32);
      invalidateAuthoritativeModelExecutionProofs();
      expect(fdCount()).toBe(baseline);
      for (const claim of claims) claim?.close();
      expect(fdCount()).toBe(baseline);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'expires 32 claimed invocation leases on the authority timer',
    () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
      const fdCount = () => fs.readdirSync('/proc/self/fd').length;
      const baseline = fdCount();
      try {
        const claims = Array.from({ length: 32 }, (_, index) => {
          const proof = issueAuthoritativeModelExecutionProof({
            authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
            cwd: PROJECT_PATH,
            checks: [
              {
                providerId: 'codex',
                providerBackendId: 'codex-native',
                model: `claimed-expiry-${index}`,
              },
            ],
          });
          return claimAuthoritativeModelExecutionProofInvocation(proof);
        });
        expect(claims.every(Boolean)).toBe(true);
        expect(fdCount()).toBe(baseline + 32);

        vi.advanceTimersByTime(60_000);

        expect(fdCount()).toBe(baseline);
        expect(claims.every((claim) => claim?.isCurrent() === false)).toBe(true);
      } finally {
        invalidateAuthoritativeModelExecutionProofs();
        vi.useRealTimers();
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'defers invalidation close until synchronous invocation returns and never replays',
    () => {
      const fdCount = () => fs.readdirSync('/proc/self/fd').length;
      const baseline = fdCount();
      const proof = issue([
        { providerId: 'codex', providerBackendId: 'codex-native', model: 'invoke-once' },
      ]);
      const claim = claimAuthoritativeModelExecutionProofInvocation(proof)!;
      expect(fdCount()).toBe(baseline + 1);

      const started = claim.beginInvocation(() => {
        invalidateAuthoritativeModelExecutionProofs();
        expect(fdCount()).toBe(baseline + 1);
        return 'started';
      });

      expect(started).toEqual({ started: true, value: 'started' });
      expect(fdCount()).toBe(baseline);
      expect(claim.beginInvocation(() => 'replayed')).toEqual({ started: false });
    }
  );

  it('refuses to issue authority for an initially missing project path', () => {
    const missing = path.join(os.tmpdir(), `missing-proof-project-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);
    expect(() =>
      issueAuthoritativeModelExecutionProof({
        authorityEpoch: captureAuthoritativeProofEpoch(missing),
        cwd: missing,
        checks: [],
      })
    ).toThrow('existing canonical project directory');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('uses conservative case-folded Windows canonical path keys', () => {
    expect(canonicalProjectPathComparisonKey('C:\\Work\\Project', 'win32')).toBe(
      canonicalProjectPathComparisonKey('c:\\work\\project', 'win32')
    );
    expect(canonicalProjectPathComparisonKey('/Work/Project', 'linux')).not.toBe(
      canonicalProjectPathComparisonKey('/work/project', 'linux')
    );
  });
});

describe('lead restart proof authority', () => {
  afterEach(() => invalidateAuthoritativeModelExecutionProofs());

  const binding = (
    overrides: Partial<LeadRuntimeRestartProofBinding> = {}
  ): LeadRuntimeRestartProofBinding => ({
    teamName: 'team-a',
    cwd: PROJECT_PATH,
    runId: 'run-1',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    selectedModel: 'gpt-5.6',
    selectedModelKind: 'explicit',
    resolvedLaunchModel: 'gpt-5.6',
    selectedEffort: 'high',
    resolvedEffort: 'high',
    leadTargetFingerprint: 'lead-fingerprint',
    launchIdentity: {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      billingMode: 'subscription',
      selectedModel: 'gpt-5.6',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-5.6',
      catalogId: 'gpt-5.6',
      catalogSource: 'app-server',
      catalogFetchedAt: '2026-08-22T00:00:00.000Z',
      selectedEffort: 'high',
      resolvedEffort: 'high',
      selectedFastMode: 'inherit',
      resolvedFastMode: false,
      fastResolutionReason: null,
    },
    ...overrides,
    leadRuntimeSelectionProvenance: overrides.leadRuntimeSelectionProvenance ?? {
      version: 1,
      providerBackendId: 'explicit',
      model: 'explicit',
      effort: 'explicit',
    },
  });

  it('is opaque, exact, single-use, expiring, and invalidated with launch proofs', () => {
    const now = 1_000;
    const exact = binding();
    const proof = issueLeadRuntimeRestartProof(
      exact,
      captureAuthoritativeProofEpoch(exact.cwd),
      now
    );
    expect(Object.keys(proof)).toEqual(['opaque']);
    expect(consumeLeadRuntimeRestartProof(proof, exact, now + 1)).toBe(true);
    expect(consumeLeadRuntimeRestartProof(proof, exact, now + 2)).toBe(false);

    const expired = issueLeadRuntimeRestartProof(
      exact,
      captureAuthoritativeProofEpoch(exact.cwd),
      now
    );
    expect(consumeLeadRuntimeRestartProof(expired, exact, now + 60_000)).toBe(false);
    const invalidated = issueLeadRuntimeRestartProof(
      exact,
      captureAuthoritativeProofEpoch(exact.cwd),
      now
    );
    invalidateAuthoritativeModelExecutionProofs();
    expect(consumeLeadRuntimeRestartProof(invalidated, exact, now + 1)).toBe(false);
  });

  it('supersedes every older proof for the same team and run regardless of selection', () => {
    const firstBinding = binding();
    const first = issueLeadRuntimeRestartProof(
      firstBinding,
      captureAuthoritativeProofEpoch(firstBinding.cwd)
    );
    const latestBinding = binding({ selectedModel: 'gpt-next', resolvedLaunchModel: 'gpt-next' });
    const latest = issueLeadRuntimeRestartProof(
      latestBinding,
      captureAuthoritativeProofEpoch(latestBinding.cwd)
    );
    expect(consumeLeadRuntimeRestartProof(first, binding())).toBe(false);
    expect(consumeLeadRuntimeRestartProof(latest, latestBinding)).toBe(true);
  });

  it('transfers the project descriptor into a close-owned invocation lease', () => {
    const exact = binding();
    const proof = issueLeadRuntimeRestartProof(exact, captureAuthoritativeProofEpoch(exact.cwd));
    const lease = consumeLeadRuntimeRestartProofForCurrentOwner(proof, exact);

    expect(lease?.launchIdentity).toEqual(exact.launchIdentity);
    expect(lease?.leadRuntimeSelectionProvenance).toEqual(exact.leadRuntimeSelectionProvenance);
    expect(lease?.isCurrent()).toBe(true);
    expect(consumeLeadRuntimeRestartProofForCurrentOwner(proof, exact)).toBeNull();

    invalidateAuthoritativeModelExecutionProofs();
    expect(lease?.isCurrent()).toBe(false);
    lease?.close();
    expect(lease?.isCurrent()).toBe(false);
  });

  it.each([
    ['team', { teamName: 'team-b' }],
    ['cwd', { cwd: '/sandbox/other' }],
    ['run', { runId: 'run-2' }],
    ['provider', { providerId: 'anthropic' as const }],
    ['backend-null', { providerBackendId: null }],
    ['selected-model', { selectedModel: 'gpt-other' }],
    ['resolved-model', { resolvedLaunchModel: 'gpt-other' }],
    ['selected-effort', { selectedEffort: 'low' as const }],
    ['resolved-effort', { resolvedEffort: 'low' as const }],
    ['fingerprint', { leadTargetFingerprint: 'other' }],
    [
      'selection-provenance',
      {
        leadRuntimeSelectionProvenance: {
          version: 1 as const,
          providerBackendId: 'default' as const,
          model: 'default' as const,
          effort: 'default' as const,
        },
      },
    ],
    [
      'attestation',
      {
        launchIdentity: {
          ...binding().launchIdentity,
          catalogSource: 'runtime' as const,
          catalogFetchedAt: '2026-08-22T00:01:00.000Z',
        },
      },
    ],
  ])('rejects a wrong %s binding without consuming the proof', (_label, change) => {
    const exact = binding();
    const proof = issueLeadRuntimeRestartProof(exact, captureAuthoritativeProofEpoch(exact.cwd));
    expect(consumeLeadRuntimeRestartProof(proof, binding(change))).toBe(false);
    expect(consumeLeadRuntimeRestartProof(proof, exact)).toBe(true);
  });

  it('does not interchange launch and lead-restart authority', () => {
    const restartBinding = binding();
    const restart = issueLeadRuntimeRestartProof(
      restartBinding,
      captureAuthoritativeProofEpoch(restartBinding.cwd)
    );
    const launch = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(PROJECT_PATH),
      cwd: PROJECT_PATH,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5.6' }],
    });
    expect(consumeLeadRuntimeRestartProof(launch as unknown as typeof restart, binding())).toBe(
      false
    );
    expect(consumeExecutionProof(restart as unknown as typeof launch)).toBe(false);
  });
});
