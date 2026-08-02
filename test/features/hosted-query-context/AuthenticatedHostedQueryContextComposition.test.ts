// @vitest-environment node

import {
  type HostedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { describe, expect, it } from 'vitest';

import { createAuthenticatedHostedQueryContextFactory } from '../../../src/features/hosted-query-context/main/composition/createAuthenticatedHostedQueryContextFactory';

import type { AuthenticatedHostedPrincipalSourcePort } from '@features/hosted-query-context/main';

const USER_ID = parseUserId('user_owner0001');
const SESSION_ID = parseHostedSessionId('session-oidc_00000001');

function principal(
  permissions: HostedPrincipal['permissions'] = ['hosted.query']
): HostedPrincipal {
  return Object.freeze({
    userId: USER_ID,
    displayName: 'Hosted operator',
    role: 'owner',
    permissions: Object.freeze([...permissions]),
    authenticationMethod: 'oidc',
    sessionId: SESSION_ID,
  });
}

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: 'deployment_composition-test',
    bootId: 'boot_composition-test',
    claudeRoot: { kind: 'claude', reference: '/runtime/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/logs' },
  });
}

function source(value = principal()): AuthenticatedHostedPrincipalSourcePort {
  return {
    authenticatedPrincipalFor: () =>
      Object.freeze({ principal: value, authenticatedSessionId: SESSION_ID }),
  };
}

describe('authenticated hosted QueryContext composition', () => {
  it('installs the fixed server query scope, permission, timeout, and Node identity', () => {
    const factory = createAuthenticatedHostedQueryContextFactory({
      authentication: source(),
      runtimeInstance: runtimeInstance(),
      clock: { nowMs: () => 50_000 },
    });
    const signal = new AbortController().signal;

    const first = factory.create({}, signal);
    const second = factory.create({}, signal);

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') return;
    expect(first.context).toMatchObject({
      deploymentId: 'deployment_composition-test',
      bootId: 'boot_composition-test',
      authorizedScope: 'scope_authenticated-hosted-query',
      deadlineAtMs: 60_000,
      signal,
    });
    expect(first.context.actorId).toMatch(/^actor_[a-f0-9]{64}$/);
    expect(first.context.sessionId).toMatch(/^session_[a-f0-9]{64}$/);
    expect(first.context.requestId).toMatch(/^request_[a-f0-9]{32}$/);
    expect(second.context.requestId).not.toBe(first.context.requestId);
  });

  it('enforces the composed hosted.query permission', () => {
    const factory = createAuthenticatedHostedQueryContextFactory({
      authentication: source(principal(['hosted.command'])),
      runtimeInstance: runtimeInstance(),
      clock: { nowMs: () => 50_000 },
    });

    expect(factory.create({}, new AbortController().signal)).toEqual({
      kind: 'failure',
      code: 'permission_denied',
    });
  });
});
