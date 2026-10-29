import { randomUUID } from 'node:crypto';

import { nativeExtensionReceiptSchema } from '@agent-teams/legacy-agent-host/extension-management';
import { BackendRoutingError } from '@features/agent-backend/main';
import {
  ApplicationCommandFailureKind,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger';
import { NodeApplicationCommandHasher } from '@features/application-command-ledger/main';
import { KeyedMutex } from '@features/internal-storage/main';

import type {
  NativeExtensionCommand,
  NativeExtensionTarget,
} from '@agent-teams/legacy-agent-host/extension-management';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type { ApplicationCommandRunner } from '@features/application-command-ledger';

const NAMESPACE = 'captured-native-extensions';
const commands = new KeyedMutex();
const unconfirmed = () =>
  new Error(
    'The original extension change is unconfirmed. Its original request has been retained.'
  );
class BeforeEffectRefusal extends Error {}
let configuredRunner: ApplicationCommandRunner | null = null;

/** Main bootstrap supplies the existing application ledger, never another extension journal. */
export function configureCapturedExtensionCommandRunner(
  runner: ApplicationCommandRunner | null
): void {
  configuredRunner = runner;
}
export function capturedExtensionCommandRunner(): ApplicationCommandRunner | null {
  return configuredRunner;
}

/** Retain only routing and intent digests. An uncertain dispatch is always original-ID lookup only. */
export function runCapturedExtensionCommand(
  runner: ApplicationCommandRunner,
  owner: CapturedProviderManagement,
  target: NativeExtensionTarget,
  command: NativeExtensionCommand
) {
  return commands.run(owner.targetId, () => runOriginalCommand(runner, owner, target, command));
}

async function runOriginalCommand(
  runner: ApplicationCommandRunner,
  owner: CapturedProviderManagement,
  target: NativeExtensionTarget,
  command: NativeExtensionCommand
) {
  const current = () => {
    if (!owner.isCurrent()) throw unconfirmed();
  };
  current();
  const hasher = new NodeApplicationCommandHasher();
  const payload = {
    ownerTargetId: owner.targetId,
    target: { ...target },
    intentDigest: hasher.hashJson(command),
  };
  const rows = await runner.readScope(NAMESPACE, owner.targetId);
  current();
  const unresolved = rows.filter(
    (row) =>
      row.status === ApplicationCommandLedgerStatus.Started ||
      row.status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
  );
  if (unresolved.length > 1) throw unconfirmed();
  const original = unresolved[0];
  if (
    original &&
    (original.operation !== command.action || original.payloadHash !== hasher.hashJson(payload))
  )
    throw unconfirmed();

  const selection = {
    targetId: target.targetId,
    panel: target.panel,
    scope: target.scope,
  };
  const read = (raw: unknown, expectedCommandId?: string) => {
    current();
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !('ok' in raw) ||
      raw.ok !== true ||
      !('value' in raw)
    )
      throw unconfirmed();
    if (raw.value === null) return null;
    const receipt = nativeExtensionReceiptSchema.parse(raw.value);
    if (
      (expectedCommandId !== undefined && receipt.commandId !== expectedCommandId) ||
      receipt.profileId !== owner.profileId ||
      receipt.configRevision !== owner.configRevision ||
      receipt.targetId !== target.targetId ||
      receipt.scope !== target.scope ||
      receipt.action !== command.action
    )
      throw unconfirmed();
    return receipt;
  };
  if (!original) {
    // Older Host-owned unresolved intents are still guarded before creating a new Main intent.
    const pending = read(await owner.request('extension.pending', { ...selection, command }));
    if (pending) {
      if (pending.phase !== 'held') throw unconfirmed();
      return pending;
    }
  }
  const commandId = original?.commandId ?? randomUUID();
  // A terminal observation ends an intent. A later identical UI action gets a fresh identity.
  const idempotencyKey = original?.idempotencyKey ?? commandId;
  const result = await runner.run(
    {
      namespace: NAMESPACE,
      scopeKey: owner.targetId,
      commandId,
      idempotencyKey,
      operation: command.action,
      payload,
      metadata: payload,
      startedStaleAfterMs: 1,
      classifyError: (error) => ({
        failureKind:
          error instanceof BeforeEffectRefusal ||
          (error instanceof BackendRoutingError && error.outcome === 'not-dispatched')
            ? ApplicationCommandFailureKind.Terminal
            : ApplicationCommandFailureKind.UnknownAfterTimeout,
        message: 'Original extension request was not confirmed',
      }),
      reconcile: async (record) => {
        current();
        const receipt = read(
          await owner.request('extension.lookup', {
            ...selection,
            commandId: record.commandId,
          }),
          record.commandId
        );
        // Missing state is uncertainty. It never authorizes the execute callback again.
        return receipt && receipt.phase !== 'held'
          ? { outcome: 'applied', result: receipt }
          : { outcome: 'unknown' };
      },
    },
    async (record) => {
      if (original) throw unconfirmed();
      current();
      const raw = await owner.request('extension.mutate', {
        ...selection,
        commandId: record.commandId,
        command,
      });
      if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        raw.ok === false &&
        'code' in raw &&
        ['busy', 'invalid', 'conflict'].includes(String(raw.code)) &&
        Object.keys(raw).length === 2
      )
        throw new BeforeEffectRefusal();
      const receipt = read(raw, record.commandId);
      if (!receipt || receipt.phase === 'held') throw unconfirmed();
      return receipt;
    }
  );
  current();
  const receipt = read({ ok: true, value: result.result }, result.record.commandId);
  if (!receipt) throw unconfirmed();
  return receipt;
}
