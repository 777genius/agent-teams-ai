// @vitest-environment node

import {
  type HostedPrincipal,
  parseHostedSessionId,
  parseOperatorSessionId,
  parseUserId,
} from '@features/hosted-access/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { describe, expect, it } from 'vitest';

import { createAuthenticatedHostedQueryContextFactory } from '../../../src/features/hosted-query-context/main/composition/createAuthenticatedHostedQueryContextFactory';

import type {
  AuthenticatedHostedPrincipalSourcePort,
  AuthenticatedHostedSessionId,
} from '@features/hosted-query-context/main';

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

function runtimeInstance(
  deploymentId = 'deployment_composition-test',
  bootId = 'boot_composition-test'
) {
  return createRuntimeInstanceContext({
    deploymentId,
    bootId,
    claudeRoot: { kind: 'claude', reference: '/runtime/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/logs' },
  });
}

function source(
  value = principal(),
  authenticatedSessionId: AuthenticatedHostedSessionId = SESSION_ID
): AuthenticatedHostedPrincipalSourcePort {
  return {
    authenticatedPrincipalFor: () => Object.freeze({ principal: value, authenticatedSessionId }),
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

  it('projects the retained personal session identity without requiring it in the principal', () => {
    const authenticatedSessionId = parseOperatorSessionId('operator-session_composition-0001');
    const personal = Object.freeze({
      ...principal(),
      authenticationMethod: 'personal' as const,
      sessionId: null,
    });
    const factory = createAuthenticatedHostedQueryContextFactory({
      authentication: source(personal, authenticatedSessionId),
      runtimeInstance: runtimeInstance(),
      clock: { nowMs: () => 50_000 },
    });

    const result = factory.create({}, new AbortController().signal);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.context.sessionId).toMatch(/^session_[a-f0-9]{64}$/);
    expect(result.context.sessionId).not.toContain(authenticatedSessionId);
  });

  it('isolates user, session, and boot references across authenticated compositions', () => {
    const secondSessionId = parseHostedSessionId('session-oidc_00000002');
    const secondPrincipal = Object.freeze({
      ...principal(),
      userId: parseUserId('user_owner0002'),
      sessionId: secondSessionId,
    });
    const first = createAuthenticatedHostedQueryContextFactory({
      authentication: source(),
      runtimeInstance: runtimeInstance(),
      clock: { nowMs: () => 50_000 },
    }).create({}, new AbortController().signal);
    const second = createAuthenticatedHostedQueryContextFactory({
      authentication: source(secondPrincipal, secondSessionId),
      runtimeInstance: runtimeInstance('deployment_composition-test', 'boot_composition-other'),
      clock: { nowMs: () => 50_000 },
    }).create({}, new AbortController().signal);

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') return;
    expect(first.context.actorId).not.toBe(second.context.actorId);
    expect(first.context.sessionId).not.toBe(second.context.sessionId);
    expect(first.context.bootId).toBe('boot_composition-test');
    expect(second.context.bootId).toBe('boot_composition-other');
  });

  it('fails closed for an already-aborted request', () => {
    const factory = createAuthenticatedHostedQueryContextFactory({
      authentication: source(),
      runtimeInstance: runtimeInstance(),
    });
    const controller = new AbortController();
    controller.abort();

    expect(factory.create({}, controller.signal)).toEqual({
      kind: 'failure',
      code: 'request_cancelled',
    });
  });
});
