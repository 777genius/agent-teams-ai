import { describe, expect, it } from 'vitest';

import { PTY_KEY_ACTIONS, runPtyDialogEngine } from '@features/workspace-trust/core/application';

import type {
  PtyKeyAction,
  PtySessionPort,
  TerminalSnapshot,
} from '@features/workspace-trust/core/application';

class FakePtySession implements PtySessionPort {
  readonly actions: PtyKeyAction[] = [];

  constructor(private readonly snapshots: string[]) {}

  async readSnapshot(): Promise<TerminalSnapshot | null> {
    const text = this.snapshots.shift() ?? this.snapshots.at(-1) ?? '';
    return { text, capturedAtMs: Date.now() };
  }

  async writeAction(action: PtyKeyAction): Promise<void> {
    this.actions.push(action);
  }

  async kill(): Promise<void> {
    return undefined;
  }
}

describe('PtyDialogEngine', () => {
  it('sends allowlisted dialog actions once and stops when post-action verification succeeds', async () => {
    const session = new FakePtySession(['Quick safety check\ntrust this folder']);
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 200,
      pollIntervalMs: 1,
      isCancelled: () => false,
      detect: () => ({
        phase: 'dialog',
        ruleId: 'claude.workspace_trust',
        actions: [PTY_KEY_ACTIONS.enter],
        retryPolicy: 'once',
        evidence: ['trust prompt'],
      }),
      afterDialogAction: async () => ({ action: 'stop', reason: 'workspace_trust_persisted' }),
    });

    expect(result).toMatchObject({
      status: 'ok',
      reason: 'workspace_trust_persisted',
      actions: ['claude.workspace_trust:enter'],
    });
    expect(session.actions).toEqual([PTY_KEY_ACTIONS.enter]);
  });

  it('does not repeat once-only actions against stale terminal text', async () => {
    const session = new FakePtySession(['trust', 'trust', 'trust']);
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 20,
      pollIntervalMs: 1,
      settleDelayMs: 1,
      isCancelled: () => false,
      detect: () => ({
        phase: 'dialog',
        ruleId: 'claude.workspace_trust',
        actions: [PTY_KEY_ACTIONS.enter],
        retryPolicy: 'once',
        evidence: ['trust prompt'],
      }),
    });

    expect(result.status).toBe('timeout');
    expect(session.actions).toEqual([PTY_KEY_ACTIONS.enter]);
  });

  it('blocks when retryable dialogs exceed the configured action budget', async () => {
    const session = new FakePtySession(['confirm', 'confirm', 'confirm']);
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 100,
      pollIntervalMs: 1,
      settleDelayMs: 1,
      maxActions: 2,
      isCancelled: () => false,
      detect: () => ({
        phase: 'dialog',
        ruleId: 'claude.bypass_permissions',
        actions: [PTY_KEY_ACTIONS.down, PTY_KEY_ACTIONS.enter],
        retryPolicy: 'typed_retry',
        evidence: ['bypass prompt'],
      }),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'workspace_trust_too_many_dialog_actions',
      actions: ['claude.bypass_permissions:down', 'claude.bypass_permissions:enter'],
    });
    expect(session.actions).toEqual([PTY_KEY_ACTIONS.down, PTY_KEY_ACTIONS.enter]);
  });

  it('returns cancelled before writing actions when cancellation is requested after detection', async () => {
    const session = new FakePtySession(['Quick safety check\ntrust this folder']);
    let cancelled = false;
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 100,
      pollIntervalMs: 1,
      isCancelled: () => {
        const current = cancelled;
        cancelled = true;
        return current;
      },
      detect: () => ({
        phase: 'dialog',
        ruleId: 'claude.workspace_trust',
        actions: [PTY_KEY_ACTIONS.enter],
        retryPolicy: 'once',
        evidence: ['trust prompt'],
      }),
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      matchedRuleIds: ['claude.workspace_trust'],
      actions: [],
    });
    expect(session.actions).toEqual([]);
  });

  it('keeps the last non-empty terminal snapshot for timeout diagnostics', async () => {
    const session = new FakePtySession(['Unknown Claude startup screen', '', '']);
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 20,
      pollIntervalMs: 1,
      settleDelayMs: 1,
      isCancelled: () => false,
      detect: () => ({ phase: 'loading' }),
    });

    expect(result.status).toBe('timeout');
    expect(result.lastSnapshot?.text).toBe('Unknown Claude startup screen');
  });

  it('blocks setup-required screens without sending actions', async () => {
    const session = new FakePtySession(['Log in to Claude']);
    const result = await runPtyDialogEngine({
      session,
      timeoutMs: 20,
      pollIntervalMs: 1,
      isCancelled: () => false,
      detect: () => ({
        phase: 'setup_required',
        code: 'provider_auth_required',
        evidence: ['auth'],
      }),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'provider_auth_required',
    });
    expect(session.actions).toEqual([]);
  });
});
