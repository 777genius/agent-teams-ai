import { z } from 'zod';
import { TeamOwnerError } from './contracts.js';
import { digest, effectId } from './identity.js';
import { nativeCommandMessage } from './nativeSessionCommand.js';
import type { CommandReceipt, RuntimeMemberBinding } from './contracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamPolicyPort, TeamStore } from './ports.js';

const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const units = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const schema = z.object({
  kind: z.literal('cost'),
  binding: z.object({
    backendId: id, teamId: id, runId: id, memberId: id, generation: id,
  }).strict(),
  capturedAt: z.string().datetime(),
  inputTokens: units,
  outputTokens: units,
  partial: z.boolean(),
  launchId: id.nullable(),
  elapsedMs: units,
  text: z.string().min(1).max(8192).refine(value => !value.includes('\0')),
}).strict();

/** Private prepared output, retained with its original Team command, never accepted from RPC. */
export type HostCostCommand = z.infer<typeof schema>;
export type PrepareHostCost = () => HostCostCommand;

function numberOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function output(value: Omit<HostCostCommand, 'text'>): string {
  const input = value.inputTokens === null ? 'not reported' : String(value.inputTokens);
  const result = value.outputTokens === null ? 'not reported' : String(value.outputTokens);
  const elapsed = value.elapsedMs === null ? 'not available' : String(Math.floor(value.elapsedMs / 1000)) + 's';
  return [
    'Codex usage reported to this Host',
    'Scope: retained activity for the captured session.',
    'Input tokens reported: ' + input,
    'Output tokens reported: ' + result,
    'Price: not reported by Codex.',
    'Elapsed since this launch: ' + elapsed,
    ...(value.partial ? ['Some usage is unavailable; these numbers are not a full session total.'] : []),
  ].join('\n');
}

/** Same reported units as Stats; no billing estimate, transcript scan or running timer. */
export function captureHostCostCommand(input: {
  binding: RuntimeMemberBinding;
  stats: { inputTokens: number | null; outputTokens: number | null; gaps: readonly string[] };
  launch?: { launchId: string; startedAtMs: number | null } | undefined;
  now: number;
}): HostCostCommand {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || input.now > 8.64e15)
    throw new TeamOwnerError('hold');
  const inputTokens = numberOrNull(input.stats.inputTokens);
  const outputTokens = numberOrNull(input.stats.outputTokens);
  const launch = input.launch?.launchId === input.binding.runId ? input.launch : undefined;
  const started = launch?.startedAtMs;
  const elapsedMs = typeof started === 'number' && Number.isSafeInteger(started) && started >= 0 &&
    started <= input.now ? numberOrNull(input.now - started) : null;
  const captured: Omit<HostCostCommand, 'text'> = {
    kind: 'cost', binding: { ...input.binding }, capturedAt: new Date(input.now).toISOString(),
    inputTokens, outputTokens,
    partial: input.stats.gaps.length > 0 || inputTokens === null || outputTokens === null,
    launchId: launch?.launchId ?? null, elapsedMs,
  };
  return schema.parse({ ...captured, text: output(captured) });
}

/** Storage reads verify the private format before any recovery can publish a product message. */
export function validateHostCostCommand(receipt: CommandReceipt): void {
  if (receipt.hostCommand === undefined) return;
  const parsed = schema.safeParse(receipt.hostCommand);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(receipt.hostCommand)) > 16 * 1024)
    throw new TeamOwnerError('hold');
  const captured = parsed.data;
  const command = receipt.command;
  const delivery = receipt.deliveryBinding;
  if (
    command.operation !== 'message.send' || command.payload.nativeCommand !== true ||
    nativeCommandMessage(command)?.raw !== '/cost' ||
    command.payload.attachments?.length || receipt.crossTeam || receipt.group ||
    receipt.messageRecipientRole !== 'lead' || !delivery ||
    !Number.isSafeInteger(receipt.authorityRevision) || receipt.authorityRevision! < 1 ||
    delivery.backendId !== receipt.binding.backendId || delivery.teamId !== receipt.binding.teamId ||
    delivery.teamName !== receipt.binding.teamName ||
    digest(captured.binding) !== digest({
      backendId: delivery.backendId, teamId: delivery.teamId, runId: delivery.runId,
      memberId: delivery.memberId, generation: delivery.generation,
    }) ||
    (captured.launchId !== null && captured.launchId !== captured.binding.runId) ||
    (captured.elapsedMs !== null && captured.launchId === null) ||
    captured.text !== output(captured)
  ) throw new TeamOwnerError('hold');
}

export function hostCostReplyId(receipt: CommandReceipt): string {
  if (!receipt.hostCommand) throw new TeamOwnerError('hold');
  return effectId('host-cost-output', receipt.commandId, digest(receipt.hostCommand.binding));
}

/** The ordinary command row is already committed. Only this exact prepared local reply remains. */
export function commitHostCostReply(
  receipt: CommandReceipt,
  actor: string,
  commandMessage: unknown,
  store: TeamStore,
  policy: TeamPolicyPort
): JsonValue {
  validateHostCostCommand(receipt);
  const captured = receipt.hostCommand;
  const command = receipt.command;
  if (!captured || actor !== 'user' || command.operation !== 'message.send')
    throw new TeamOwnerError('forbidden');
  // A previous native delivery cannot be reclassified as a Host-only result.
  if (store.read('outbox/' + receipt.effects.deliveryId + '.json') !== undefined)
    throw new TeamOwnerError('hold');
  const row = {
    from: command.payload.to, to: 'user', text: captured.text,
    timestamp: receipt.createdAt, messageId: hostCostReplyId(receipt), read: false,
    summary: '/cost',
  };
  const matches = policy.readInbox('user').filter(entry => entry && typeof entry === 'object' &&
    !Array.isArray(entry) && entry.messageId === row.messageId);
  if (matches.length > 1) throw new TeamOwnerError('hold');
  const existing = matches[0];
  if (existing) {
    if (digest({ ...(existing as Record<string, JsonValue>), read: false }) !== digest(row))
      throw new TeamOwnerError('hold');
  } else {
    const applied = policy.sendMessage(command.payload.to, { ...row, member: 'user' });
    if (applied.messageId !== row.messageId || digest(applied.message) !== digest(row))
      throw new TeamOwnerError('hold');
  }
  return JSON.parse(JSON.stringify({
    messageId: receipt.effects.messageId, message: commandMessage,
  })) as JsonValue;
}
