import { describe, expect, it } from 'vitest';

import {
  correlateOpenCodeLaunchAttemptResponseV1,
  decodeOpenCodeLaunchAttemptResponseV1,
  type OpenCodeLaunchAttemptResponse,
  type OpenCodeOpaqueIdentity,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeLaunchAttemptContractV1';
import {
  createOpenCodeLaunchRequestCorrelationDigestV1,
  type OpenCodeLaunchRequestCorrelationAuthorityV1,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeLaunchAttemptDigestV1';
import orchestratorVector from '../../../fixtures/team/opencode-launch-request-correlation-golden.json';

const hash = (character: string) => character.repeat(64);
const identity = (character: string): OpenCodeOpaqueIdentity => `sha256:${hash(character)}`;
const digestAuthority =
  orchestratorVector.authority as unknown as OpenCodeLaunchRequestCorrelationAuthorityV1;
const fixtureResponse =
  orchestratorVector.wire.response as unknown as OpenCodeLaunchAttemptResponse;
const requestCorrelationDigest =
  orchestratorVector.wire.request.launchAttempt.requestCorrelationDigest;
const memberOne = digestAuthority.command.members[0]!.memberIdentity;
const memberTwo = digestAuthority.command.members[1]!.memberIdentity;
const authority: OpenCodeLaunchRequestCorrelationAuthorityV1 = {
  ...digestAuthority,
  command: {
    ...digestAuthority.command,
    launchAttempt: {
      ...digestAuthority.command.launchAttempt,
      requestCorrelationDigest,
    },
  },
};

function response(): OpenCodeLaunchAttemptResponse {
  return JSON.parse(JSON.stringify(fixtureResponse)) as OpenCodeLaunchAttemptResponse;
}

const correlation = {
  authority,
};

describe('OpenCode strict launch attempt V1 desktop contract', () => {
  it('matches the canonical Orchestrator request-correlation vector', () => {
    expect(createOpenCodeLaunchRequestCorrelationDigestV1(digestAuthority)).toBe(
      requestCorrelationDigest
    );
  });

  it('decodes the full Orchestrator vector and accepts enriched server digests only with the exact request echo', () => {
    const wire = JSON.parse(JSON.stringify(orchestratorVector.wire.response)) as unknown;

    expect(decodeOpenCodeLaunchAttemptResponseV1(wire)).toEqual({
      ok: true,
      value: fixtureResponse,
    });
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({
        ...correlation,
        response: wire,
      })
    ).toMatchObject({ ok: true });
    expect(digestAuthority.command.projectPath).toBe(
      orchestratorVector.serverEnrichment.requestProjectPath
    );
    expect(orchestratorVector.serverEnrichment.projectPath).not.toBe(
      digestAuthority.command.projectPath
    );
    expect(fixtureResponse.launchAttempt.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtureResponse.launchAttempt.immutableDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      'request path',
      {
        ...digestAuthority,
        command: { ...digestAuthority.command, projectPath: '/real/sandbox/project' },
      },
    ],
    [
      'member order',
      {
        ...digestAuthority,
        command: { ...digestAuthority.command, members: [...digestAuthority.command.members].reverse() },
      },
    ],
    [
      'proof nonce',
      {
        ...digestAuthority,
        command: {
          ...digestAuthority.command,
          launchAttempt: {
            ...digestAuthority.command.launchAttempt,
            proofNonce: 'AQECAwQFBgcICQoLDA0ODw',
          },
        },
      },
    ],
    [
      'lease precondition',
      {
        ...digestAuthority,
        preconditions: { ...digestAuthority.preconditions, commandLeaseId: 'other-lease' },
      },
    ],
    ['requested budget', { ...digestAuthority, requestedBudgetMs: 120_001 }],
  ] as const)(
    'rejects an echoed digest from a different %s',
    (_field, changedAuthority) => {
      const changedDigest = createOpenCodeLaunchRequestCorrelationDigestV1(changedAuthority);
      expect(changedDigest).not.toBe(requestCorrelationDigest);
      expect(
        correlateOpenCodeLaunchAttemptResponseV1({
          authority: {
            ...changedAuthority,
            command: {
              ...changedAuthority.command,
              launchAttempt: {
                ...changedAuthority.command.launchAttempt,
                requestCorrelationDigest: changedDigest,
              },
            },
          },
          response: response(),
        })
      ).toEqual({ ok: false, field: 'launchAttempt.requestCorrelationDigest' });
    }
  );

  it('rejects wrong generation digests and non-exhaustive member partitions', () => {
    const wrongDigest = response();
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({
        ...correlation,
        response: wrongDigest,
        authority: {
          ...authority,
          command: {
            ...authority.command,
            launchAttempt: {
              ...authority.command.launchAttempt,
              requestCorrelationDigest: hash('0'),
            },
          },
        },
      })
    ).toEqual({ ok: false, field: 'launchAttempt.requestCorrelationDigest' });

    const missingMember = response();
    missingMember.members.failed = [];
    delete missingMember.members.continuationToken;
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({
        ...correlation,
        response: missingMember,
      })
    ).toEqual({ ok: false, field: 'members' });

    const lateGeneration = response();
    lateGeneration.launchAttempt.generation = 2;
    lateGeneration.proof!.generation = 2;
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({
        ...correlation,
        response: lateGeneration,
      })
    ).toEqual({ ok: false, field: 'launchAttempt.generation' });
  });

  it('rejects cancelled committed members without proof', () => {
    const cancelled = response();
    cancelled.launchAttempt.outcome = 'cancelled';
    delete cancelled.proof;
    delete cancelled.members.continuationToken;
    cancelled.members.failed = [];
    cancelled.members.pending = [memberTwo];
    cancelled.members.cleanupPending = [];
    cancelled.failure = {
      code: 'cancelled',
      origin: 'session',
      retryDisposition: 'never',
      retryable: false,
      phase: 'cleanup',
      sideEffectsStarted: false,
    };

    expect(decodeOpenCodeLaunchAttemptResponseV1(cancelled)).toEqual({
      ok: false,
      field: 'proof',
    });
  });

  it('rejects nonce, missing or wrong echoes, tool ordering, and cleanup partition drift', () => {
    const wrongNonce = response();
    wrongNonce.proof!.nonceHash = hash('0');
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: wrongNonce })
    ).toEqual({ ok: false, field: 'proof.nonceHash' });

    const extraTool = response();
    extraTool.proof!.observedMcpTools.push('agent-teams_task_list');
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: extraTool })
    ).toEqual({ ok: false, field: 'proof.observedMcpTools' });

    const permutedTools = response();
    permutedTools.proof!.observedMcpTools.reverse();
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: permutedTools })
    ).toEqual({ ok: false, field: 'proof.observedMcpTools' });

    const wrongInput = response();
    wrongInput.launchAttempt.requestCorrelationDigest = hash('0');
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: wrongInput })
    ).toEqual({ ok: false, field: 'launchAttempt.requestCorrelationDigest' });

    const missingInputEcho = response();
    delete missingInputEcho.launchAttempt.requestCorrelationDigest;
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: missingInputEcho })
    ).toEqual({ ok: false, field: 'launchAttempt.requestCorrelationDigest' });

    const missingProofEcho = response();
    delete missingProofEcho.proof!.requestCorrelationDigest;
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: missingProofEcho })
    ).toEqual({ ok: false, field: 'proof.requestCorrelationDigest' });

    const cleanupCommitted = response();
    cleanupCommitted.members.cleanupPending = [memberOne];
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: cleanupCommitted })
    ).toEqual({ ok: false, field: 'members.cleanupPending' });

    const unorderedRoster = response();
    unorderedRoster.launchAttempt.outcome = 'succeeded';
    unorderedRoster.launchAttempt.phase = 'complete';
    unorderedRoster.members.committed = [
      {
        memberIdentity: memberTwo,
        sessionIdentity: identity('3'),
        bootstrapMessageIdentity: identity('4'),
        commitIdentity: identity('5'),
      },
      unorderedRoster.members.committed[0],
    ];
    unorderedRoster.members.failed = [];
    unorderedRoster.members.cleanupPending = [];
    delete unorderedRoster.members.continuationToken;
    delete unorderedRoster.failure;
    expect(
      correlateOpenCodeLaunchAttemptResponseV1({ ...correlation, response: unorderedRoster })
    ).toEqual({ ok: false, field: 'members' });
  });

  it('rejects a continuation token on reconciliation-required unknown state', () => {
    const unknown = response();
    unknown.launchAttempt.outcome = 'reconciliation_required';
    delete unknown.proof;
    unknown.members.committed = [];
    unknown.members.failed = [];
    unknown.members.pending = [memberOne, memberTwo];
    unknown.failure = {
      code: 'unknown_transport_after_side_effect',
      origin: 'session',
      retryDisposition: 'never',
      retryable: false,
      phase: 'member_materialize',
      sideEffectsStarted: true,
    };

    expect(decodeOpenCodeLaunchAttemptResponseV1(unknown)).toEqual({
      ok: false,
      field: 'members.continuationToken',
    });
  });

  it.each(['https://example.invalid', 'Bearer credential', 'api_key-value'])(
    'keeps sensitive continuation token text off the accepted wire: %s',
    (continuationToken) => {
      const sensitive = response();
      sensitive.members.continuationToken = continuationToken;

      expect(decodeOpenCodeLaunchAttemptResponseV1(sensitive)).toEqual({
        ok: false,
        field: 'members.continuationToken',
      });
    }
  );
});
