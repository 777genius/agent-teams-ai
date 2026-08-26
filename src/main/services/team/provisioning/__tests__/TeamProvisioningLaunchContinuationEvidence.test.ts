import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDeterministicLaunchBootstrapSpec } from '../TeamProvisioningBootstrapSpec';
import {
  buildLaunchContinuationRosterFingerprint,
  type DurableLaunchContinuationEvidence,
  resolveDeterministicLaunchContinuation,
  snapshotLaunchContinuationSources,
  verifyLaunchContinuationSources,
} from '../TeamProvisioningLaunchContinuationEvidence';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

const request: TeamLaunchRequest = {
  teamName: 'demo',
  cwd: '/tmp/fake-project',
  providerId: 'anthropic',
  model: 'claude',
};

const members: TeamCreateRequest['members'] = [
  {
    name: 'alice',
    cwd: '/tmp/fake-project/alice',
    providerId: 'anthropic',
    providerBackendId: 'cli-sdk',
    model: 'claude',
    effort: 'high',
    role: 'builder',
    workflow: 'Use the project system prompt.',
    runtimeSelectionProvenance: {
      version: 1,
      providerBackendId: 'explicit',
      model: 'explicit',
      effort: 'explicit',
    },
    mcpPolicy: { mode: 'strictAllowlist', serverNames: ['agent-teams'] },
  },
  {
    name: 'bob',
    cwd: '/tmp/fake-project/bob',
    providerId: 'anthropic',
    providerBackendId: 'cli-sdk',
    model: 'claude',
    effort: 'high',
    role: 'reviewer',
  },
];

const launchIdentity = {
  providerId: 'anthropic' as const,
  providerBackendId: 'cli-sdk' as const,
  selectedModel: 'claude',
  selectedModelKind: 'explicit' as const,
  resolvedLaunchModel: 'claude',
  catalogId: 'claude',
  catalogSource: 'runtime' as const,
  catalogFetchedAt: '2026-08-26T00:00:00.000Z',
  selectedEffort: 'high' as const,
  resolvedEffort: 'high' as const,
};

const tempDirectories: string[] = [];
const credentialDigestKey = 'device-identity-for-tests';

async function createTempDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'launch-continuation-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
  );
});

function lanePlan(materializedMembers = members): TeamRuntimeLanePlan {
  const planned = materializedMembers.map((member) => ({
    ...member,
    providerId: 'anthropic' as const,
  }));
  return {
    mode: 'primary_only',
    primaryMembers: [...planned],
    allMembers: [...planned],
    sideLanes: [],
  };
}

function fingerprint(
  input: {
    request?: TeamLaunchRequest;
    materializedMemberSpecs?: TeamCreateRequest['members'];
    launchIdentityOverride?: typeof launchIdentity;
    runtimeLanePlan?: TeamRuntimeLanePlan;
    finalizedLaunchMaterial?: unknown;
  } = {}
) {
  const materializedMemberSpecs = input.materializedMemberSpecs ?? members;
  return buildLaunchContinuationRosterFingerprint({
    request: input.request ?? request,
    materializedMemberSpecs,
    launchIdentity: input.launchIdentityOverride ?? launchIdentity,
    runtimeLanePlan: input.runtimeLanePlan ?? lanePlan(materializedMemberSpecs),
    finalizedLaunchMaterial: input.finalizedLaunchMaterial ?? {
      settingsAndMcpSourceDigest: 'sha256:stable-material',
      finalArgvDigest: 'sha256:stable-argv',
    },
    credentialDigestKey,
  });
}

function evidence(
  overrides: Partial<DurableLaunchContinuationEvidence> = {}
): DurableLaunchContinuationEvidence {
  const updatedAt = '2026-08-26T00:00:00.000Z';
  return {
    version: 1,
    sourceRunId: 'run-1',
    teamName: 'demo',
    evidenceId: 'evidence-1',
    updatedAt,
    rosterFingerprint: fingerprint(),
    terminalStatus: 'partial_success',
    members: [
      {
        name: 'alice',
        outcome: 'bootstrap_confirmed',
        runtimeRunId: 'run-1',
        observedAt: updatedAt,
      },
      {
        name: 'bob',
        outcome: 'failed',
        observedAt: updatedAt,
        cleanup: { status: 'confirmed', runId: 'run-1', observedAt: updatedAt },
      },
    ],
    ...overrides,
  };
}

function resolve(inputEvidence: DurableLaunchContinuationEvidence) {
  return resolveDeterministicLaunchContinuation({
    teamName: 'demo',
    expectedMemberNames: members.map((member) => member.name),
    rosterFingerprint: fingerprint(),
    evidenceRead: { kind: 'evidence', evidence: inputEvidence },
  });
}

describe('deterministic launch continuation evidence', () => {
  it('selects only cleanup-proven failed members and preserves success with prior-run binding', () => {
    const decision = resolve(evidence());

    expect(decision).toMatchObject({
      kind: 'continue',
      continuation: {
        sourceRunId: 'run-1',
        preservedMembers: [{ name: 'alice', runtimeRunId: 'run-1' }],
        retryMembers: [{ name: 'bob', cleanupRunId: 'run-1', outcome: 'failed' }],
      },
    });
    if (decision.kind !== 'continue') throw new Error('Expected continuation');
    const spec = buildDeterministicLaunchBootstrapSpec(
      'run-2',
      request,
      [members[1]],
      new Map(),
      new Map(),
      {
        rosterFingerprint: decision.rosterFingerprint,
        continuation: decision.continuation,
      }
    );
    expect(spec.members.map((member) => member.name)).toEqual(['bob']);
    expect(spec.launch?.continuation?.preservedMembers).toEqual([
      expect.objectContaining({ name: 'alice', runtimeRunId: 'run-1' }),
    ]);
  });

  it('accepts a cleanup-proven missing member as the retry roster', () => {
    const missing = evidence({
      members: [evidence().members[0], { ...evidence().members[1], outcome: 'missing' }],
    });
    expect(resolve(missing)).toMatchObject({
      kind: 'continue',
      continuation: { retryMembers: [{ name: 'bob', outcome: 'missing' }] },
    });
  });

  it('fails closed without exact cleanup proof or success run binding', () => {
    expect(() =>
      resolve(
        evidence({
          members: [evidence().members[0], { ...evidence().members[1], cleanup: undefined }],
        })
      )
    ).toThrow(/cleanup proof/);
    expect(() =>
      resolve(
        evidence({
          members: [{ ...evidence().members[0], runtimeRunId: undefined }, evidence().members[1]],
        })
      )
    ).toThrow(/run-bound success/);
  });

  it.each([
    ['duplicate', ['alice', 'alice']],
    ['member removed', ['alice']],
    ['member added', ['alice', 'bob', 'carol']],
  ])('fails closed for an inexact %s evidence roster', (_label, names) => {
    const source = evidence();
    const byName = new Map(source.members.map((member) => [member.name, member]));
    const evidenceMembers = names.map(
      (name) =>
        byName.get(name) ?? {
          name,
          outcome: 'missing' as const,
          observedAt: source.updatedAt,
          cleanup: {
            status: 'confirmed' as const,
            runId: source.sourceRunId,
            observedAt: source.updatedAt,
          },
        }
    );
    expect(() => resolve(evidence({ members: evidenceMembers }))).toThrow(
      /exact configured roster/
    );
  });

  it('fails closed when any member configuration changes under the same names', () => {
    const changed = members.map((member) =>
      member.name === 'bob' ? { ...member, role: 'changed' } : member
    );
    expect(() =>
      resolveDeterministicLaunchContinuation({
        teamName: 'demo',
        expectedMemberNames: changed.map((member) => member.name),
        rosterFingerprint: fingerprint({ materializedMemberSpecs: changed }),
        evidenceRead: { kind: 'evidence', evidence: evidence() },
      })
    ).toThrow(/configuration/);
  });

  it.each([
    [
      'mcpPolicy',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, mcpPolicy: { mode: 'appOnly' as const } } : member
        ),
    ],
    [
      'member cwd',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, cwd: '/tmp/another-project' } : member
        ),
    ],
    [
      'provider',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, providerId: 'codex' as const } : member
        ),
    ],
    [
      'backend',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, providerBackendId: 'adapter' as const } : member
        ),
    ],
    [
      'model',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, model: 'claude-next' } : member
        ),
    ],
    [
      'reasoning effort',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, effort: 'xhigh' as const } : member
        ),
    ],
    [
      'system/workflow prompt',
      () =>
        members.map((member) =>
          member.name === 'bob' ? { ...member, workflow: 'Use a different system prompt.' } : member
        ),
    ],
    [
      'runtime selection provenance',
      () =>
        members.map((member) =>
          member.name === 'bob'
            ? {
                ...member,
                runtimeSelectionProvenance: {
                  version: 1 as const,
                  providerBackendId: 'inherited' as const,
                  model: 'explicit' as const,
                  effort: 'explicit' as const,
                },
              }
            : member
        ),
    ],
  ])('changes the canonical fingerprint when materialized %s changes', (_label, mutate) => {
    expect(fingerprint({ materializedMemberSpecs: mutate() })).not.toBe(fingerprint());
  });

  it.each([
    ['cwd/project path', { ...request, cwd: '/tmp/another-project' }],
    ['provider', { ...request, providerId: 'codex' as const }],
    ['backend', { ...request, providerBackendId: 'adapter' as const }],
    ['model', { ...request, model: 'claude-next' }],
    ['reasoning effort', { ...request, effort: 'xhigh' as const }],
    ['permissions', { ...request, skipPermissions: false }],
    ['prompt', { ...request, prompt: 'A different launch prompt' }],
    ['config references', { ...request, extraCliArgs: '--settings /tmp/fake-settings.json' }],
    [
      'lead runtime selection provenance',
      {
        ...request,
        leadRuntimeSelectionProvenance: {
          version: 1 as const,
          providerBackendId: 'explicit' as const,
          model: 'explicit' as const,
          effort: 'explicit' as const,
        },
      },
    ],
  ])('changes the canonical fingerprint when team-level %s changes', (_label, changedRequest) => {
    expect(fingerprint({ request: changedRequest })).not.toBe(fingerprint());
  });

  it('binds resolved launch identity and transport lane selection', () => {
    expect(
      fingerprint({
        launchIdentityOverride: { ...launchIdentity, resolvedLaunchModel: 'claude-runtime-next' },
      })
    ).not.toBe(fingerprint());
    expect(
      fingerprint({
        runtimeLanePlan: {
          mode: 'mixed_opencode_side_lanes',
          primaryMembers: lanePlan().primaryMembers,
          allMembers: lanePlan().allMembers,
          sideLanes: [
            {
              laneId: 'opencode:bob',
              providerId: 'opencode',
              member: { ...lanePlan().allMembers[1], providerId: 'opencode' },
            },
          ],
        },
      })
    ).not.toBe(fingerprint());
  });

  it.each([
    ['MCP/bootstrap inputs', { mcpBootstrapDigest: 'sha256:changed' }],
    ['final process arguments', { finalArgvDigest: 'sha256:changed' }],
    ['workspace-trust patches', { workspaceTrustPatchDigest: 'sha256:changed' }],
    ['provider/plugin authority', { providerPluginProfileDigest: 'sha256:changed' }],
  ])('changes the fingerprint when finalized %s change', (_label, changedMaterial) => {
    expect(fingerprint({ finalizedLaunchMaterial: changedMaterial })).not.toBe(fingerprint());
  });

  it.each(['executionProof', 'transactionId', 'catalogFetchedAt'])(
    'retains a legitimate nested %s field outside the explicit volatile schema paths',
    (field) => {
      expect(
        fingerprint({
          finalizedLaunchMaterial: { providerConfig: { plugin: { [field]: 'changed' } } },
        })
      ).not.toBe(
        fingerprint({
          finalizedLaunchMaterial: { providerConfig: { plugin: { [field]: 'original' } } },
        })
      );
    }
  );

  it('binds source contents at the same settings path and preserves unchanged material', async () => {
    const directory = await createTempDirectory();
    const settingsPath = path.join(directory, 'settings.json');
    await fs.promises.writeFile(settingsPath, JSON.stringify({ enabledPlugins: { alpha: true } }));
    const original = await snapshotLaunchContinuationSources([settingsPath], credentialDigestKey);

    await expect(
      verifyLaunchContinuationSources(original, credentialDigestKey)
    ).resolves.toBeUndefined();
    await fs.promises.writeFile(settingsPath, JSON.stringify({ enabledPlugins: { beta: true } }));
    await expect(verifyLaunchContinuationSources(original, credentialDigestKey)).rejects.toThrow(
      /changed/
    );
  });

  it('binds project/global plugin-provider and MCP source revisions', async () => {
    const directory = await createTempDirectory();
    const projectSettings = path.join(directory, 'project-settings.json');
    const globalPlugins = path.join(directory, 'installed_plugins.json');
    const mcpConfig = path.join(directory, '.mcp.json');
    await Promise.all([
      fs.promises.writeFile(projectSettings, JSON.stringify({ provider: 'alpha' })),
      fs.promises.writeFile(globalPlugins, JSON.stringify({ plugins: ['alpha'] })),
      fs.promises.writeFile(mcpConfig, JSON.stringify({ mcpServers: { alpha: {} } })),
    ]);
    const original = await snapshotLaunchContinuationSources(
      [projectSettings, globalPlugins, mcpConfig],
      credentialDigestKey
    );

    for (const sourcePath of [projectSettings, globalPlugins, mcpConfig]) {
      const before = await snapshotLaunchContinuationSources(
        [projectSettings, globalPlugins, mcpConfig],
        credentialDigestKey
      );
      await fs.promises.writeFile(sourcePath, JSON.stringify({ revision: sourcePath }));
      const after = await snapshotLaunchContinuationSources(
        [projectSettings, globalPlugins, mcpConfig],
        credentialDigestKey
      );
      expect(after.digest).not.toBe(before.digest);
    }
    expect(
      (await snapshotLaunchContinuationSources([projectSettings], credentialDigestKey)).digest
    ).not.toBe(original.digest);
  });

  it('fails closed when a source mutates during its snapshot', async () => {
    const directory = await createTempDirectory();
    const settingsPath = path.join(directory, 'settings.json');
    await fs.promises.writeFile(settingsPath, JSON.stringify({ provider: 'alpha' }));
    const readFile = fs.promises.readFile.bind(fs.promises);
    let readCount = 0;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      const value = await readFile(...args);
      readCount += 1;
      if (readCount === 1) {
        await fs.promises.writeFile(settingsPath, JSON.stringify({ provider: 'beta' }));
      }
      return value;
    });

    await expect(
      snapshotLaunchContinuationSources([settingsPath], credentialDigestKey)
    ).rejects.toThrow(/changed while snapshotting/);
  });

  it('normalizes object key and member order deterministically', () => {
    const reorderedMembers = [
      { ...members[1] },
      {
        ...members[0],
        mcpPolicy: {
          serverNames: ['agent-teams'],
          mode: 'strictAllowlist' as const,
        },
      },
    ];
    const reorderedRequest = {
      model: request.model,
      providerId: request.providerId,
      cwd: '/tmp/fake-project/../fake-project',
      teamName: request.teamName,
    };
    const reorderedPlan = lanePlan(reorderedMembers);
    reorderedPlan.primaryMembers.reverse();
    reorderedPlan.allMembers.reverse();
    expect(
      fingerprint({
        request: reorderedRequest,
        materializedMemberSpecs: reorderedMembers,
        runtimeLanePlan: reorderedPlan,
      })
    ).toBe(fingerprint());
  });

  it('binds distinct inline credentials without exposing them in fingerprint material', () => {
    expect(
      fingerprint({
        request: {
          ...request,
          extraCliArgs: '--api-key first-secret --settings {"env":{"AUTH_TOKEN":"one"}}',
        },
      })
    ).not.toBe(
      fingerprint({
        request: {
          ...request,
          extraCliArgs: '--api-key second-secret --settings {"env":{"AUTH_TOKEN":"two"}}',
        },
      })
    );
  });

  it('excludes volatile attempt authorization and runtime catalog timestamps', () => {
    expect(
      fingerprint({
        request: {
          ...request,
          rosterTransactionId: 'attempt-2',
          rosterLaunchBinding: {
            transactionId: 'attempt-2',
            teamName: request.teamName,
            rosterFingerprint: 'stable-roster',
            rosterRevision: 'stable-revision',
            launchCommandId: 'command-2',
            launchRequestFingerprint: 'request-2',
          },
          executionProof: {
            authorityId: 'volatile-proof',
            generation: 2,
            completedAt: '2026-08-26T01:00:00.000Z',
            expiresAt: '2026-08-26T01:01:00.000Z',
            requestDigest: 'volatile-request-digest',
          },
        },
        launchIdentityOverride: {
          ...launchIdentity,
          catalogFetchedAt: '2026-08-27T00:00:00.000Z',
        },
      })
    ).toBe(
      fingerprint({
        request: {
          ...request,
          rosterLaunchBinding: {
            transactionId: 'attempt-1',
            teamName: request.teamName,
            rosterFingerprint: 'stable-roster',
            rosterRevision: 'stable-revision',
            launchCommandId: 'command-1',
            launchRequestFingerprint: 'request-1',
          },
        },
      })
    );
  });

  it('returns exact completed evidence idempotently and rejects mixed completed evidence', () => {
    const completedMembers = evidence().members.map((member) => ({
      name: member.name,
      outcome: 'bootstrap_confirmed' as const,
      runtimeRunId: member.name === 'alice' ? 'run-1' : 'run-2',
      observedAt: member.observedAt,
    }));
    expect(resolve(evidence({ terminalStatus: 'completed', members: completedMembers }))).toEqual({
      kind: 'complete',
      rosterFingerprint: evidence().rosterFingerprint,
      sourceRunId: 'run-1',
    });
    expect(() => resolve(evidence({ terminalStatus: 'completed' }))).toThrow(/unresolved/);
  });
});
