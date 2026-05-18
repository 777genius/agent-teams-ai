import type { PtyKeyAction, PtySessionPort, TerminalSnapshot } from './ports';
import type { StartupReadinessState } from './StartupDialogRules';

export type PtyDialogEngineResult =
  | {
      status: 'ok';
      reason: string;
      matchedRuleIds: string[];
      actions: string[];
      lastSnapshot?: TerminalSnapshot;
    }
  | {
      status: 'ready';
      matchedRuleIds: string[];
      actions: string[];
      lastSnapshot?: TerminalSnapshot;
    }
  | {
      status: 'blocked';
      code: string;
      evidence: string[];
      matchedRuleIds: string[];
      actions: string[];
      lastSnapshot?: TerminalSnapshot;
    }
  | {
      status: 'timeout' | 'cancelled';
      matchedRuleIds: string[];
      actions: string[];
      lastSnapshot?: TerminalSnapshot;
    };

export interface PtyDialogEngineInput {
  session: PtySessionPort;
  detect(snapshotText: string): StartupReadinessState;
  isCancelled(): boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  settleDelayMs?: number;
  maxActions?: number;
  afterDialogAction?: (input: {
    ruleId: string;
    actions: PtyKeyAction[];
    snapshot: TerminalSnapshot;
  }) => Promise<{ action: 'continue' } | { action: 'stop'; reason: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPtyDialogEngine(
  input: PtyDialogEngineInput
): Promise<PtyDialogEngineResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const settleDelayMs = input.settleDelayMs ?? 250;
  const maxActions = input.maxActions ?? 12;
  const deadline = Date.now() + timeoutMs;
  const handledOnceRules = new Set<string>();
  const matchedRuleIds: string[] = [];
  const actions: string[] = [];
  let lastSnapshot: TerminalSnapshot | undefined;

  while (Date.now() <= deadline) {
    if (input.isCancelled()) {
      return { status: 'cancelled', matchedRuleIds, actions, lastSnapshot };
    }

    const snapshot = await input.session.readSnapshot(pollIntervalMs);
    if (!snapshot) {
      continue;
    }
    if (snapshot.text.trim().length > 0 || !lastSnapshot) {
      lastSnapshot = snapshot;
    }
    const state = input.detect(snapshot.text);

    if (state.phase === 'dialog') {
      if (!matchedRuleIds.includes(state.ruleId)) {
        matchedRuleIds.push(state.ruleId);
      }
      if (state.retryPolicy === 'once' && handledOnceRules.has(state.ruleId)) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (actions.length + state.actions.length > maxActions) {
        return {
          status: 'blocked',
          code: 'workspace_trust_too_many_dialog_actions',
          evidence: [`action limit ${maxActions} exceeded`],
          matchedRuleIds,
          actions,
          lastSnapshot,
        };
      }

      handledOnceRules.add(state.ruleId);
      for (const action of state.actions) {
        if (input.isCancelled()) {
          return { status: 'cancelled', matchedRuleIds, actions, lastSnapshot };
        }
        await input.session.writeAction(action);
        actions.push(`${state.ruleId}:${action.id}`);
      }

      const afterAction = await input.afterDialogAction?.({
        ruleId: state.ruleId,
        actions: state.actions,
        snapshot,
      });
      if (afterAction?.action === 'stop') {
        return {
          status: 'ok',
          reason: afterAction.reason,
          matchedRuleIds,
          actions,
          lastSnapshot,
        };
      }
      await sleep(settleDelayMs);
      continue;
    }

    if (state.phase === 'setup_required') {
      return {
        status: 'blocked',
        code: state.code,
        evidence: state.evidence,
        matchedRuleIds,
        actions,
        lastSnapshot,
      };
    }

    if (state.phase === 'ready') {
      return { status: 'ready', matchedRuleIds, actions, lastSnapshot };
    }
  }

  return { status: 'timeout', matchedRuleIds, actions, lastSnapshot };
}
