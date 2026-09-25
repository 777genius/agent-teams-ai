import { createHash } from 'node:crypto';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

export type ProductAgentBinding = Readonly<{
  workspaceId: string;
  teamId: string;
  workspaceRoot: string;
  planGeneration: string;
  runId: string;
  laneId: string;
  memberId: string;
  memberName: string;
  sessionID: string;
}>;

export type ProductAgentAuthority = Readonly<{
  actorId: string;
  deploymentId: string;
  bootId: string;
  restoreGeneration: number;
  workspaceId: string;
  mountGeneration: number;
  declaredRootHash: string;
  teamId: string;
  ownerAuthority: string;
  ownerGeneration: number;
  ownerSessionId: string;
}>;

export type ProductTaskPin = Readonly<{
  taskId: string;
  sourceGeneration: string;
  revision: string;
}>;

export type ProductRecipientPin = Readonly<{
  teamId: string;
  runId: string;
  laneId: string;
  memberId: string;
  memberName: string;
}>;

export type ProductTaskSnapshot = ProductTaskPin &
  Readonly<{
    teamId: string;
    ownerId: string | null;
    status: 'pending' | 'in_progress' | 'completed';
  }>;

export type ProductEffectRequest = Readonly<{
  binding: ProductAgentBinding;
  authority: ProductAgentAuthority;
  messageID: string;
  callID: string;
  signal: AbortSignal;
}> &
  (
    | Readonly<{ kind: 'status'; task: ProductTaskPin; status: 'in_progress' | 'completed' }>
    | Readonly<{ kind: 'comment'; task: ProductTaskPin; text: string }>
    | Readonly<{
        kind: 'message';
        recipient: ProductRecipientPin;
        text: string;
        taskRefs: readonly ProductTaskPin[];
      }>
  );

export type ProductCanonicalEffect =
  | Readonly<{
      kind: 'status';
      member: ProductAgentBinding & ProductAgentAuthority;
      task: ProductTaskSnapshot;
      status: 'in_progress' | 'completed';
    }>
  | Readonly<{
      kind: 'comment';
      member: ProductAgentBinding & ProductAgentAuthority;
      task: ProductTaskSnapshot;
      text: string;
    }>
  | Readonly<{
      kind: 'message';
      member: ProductAgentBinding & ProductAgentAuthority;
      recipient: ProductRecipientPin;
      taskRefs: readonly ProductTaskSnapshot[];
      text: string;
    }>;

/**
 * These reads must use Product's current v35 decision and canonical file state.
 * Product's worker invokes them synchronously after BEGIN IMMEDIATE, while holding
 * its filesystem writer lock. No Owner-supplied path or snapshot is accepted.
 */
export interface ProductEffectAuthority {
  currentMember(
    runId: string,
    memberId: string
  ): (ProductAgentBinding & ProductAgentAuthority) | null;
  task(teamId: string, taskId: string): ProductTaskSnapshot | null;
  recipient(runId: string, memberId: string): ProductRecipientPin | null;
}

/** Product reads independent root/FD3 evidence, never an Owner assertion. */
export interface ProductExactCallAttestation {
  hasExactCall(
    input: Readonly<{
      binding: ProductAgentBinding;
      messageID: string;
      callID: string;
      proposalFingerprint: string;
    }>
  ): boolean;
}

/**
 * Product's canonical file writer must atomically fsync each effect with the
 * deterministic effectId and recognize the exact effect after a crash between
 * file fsync and SQLite receipt commit. A message wake is part of that one
 * canonical effect; a replay must never wake again.
 */
export interface ProductCanonicalEffectWriter {
  withExclusiveLock<T>(run: () => T): T;
  findExactReceipt(effectId: string, fingerprint: string): string | null;
  writeOnce(effectId: string, fingerprint: string, effect: ProductCanonicalEffect): string;
}

/** Migration input for the Product SQLite worker. This is a receipt ledger only. */
export const HOSTED_PRODUCT_TASK_EFFECT_RECEIPTS_SQL = `CREATE TABLE hosted_product_task_effect_receipts (
  team_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY (team_id, call_id),
  UNIQUE (effect_id)
)`;

interface ReceiptRow {
  fingerprint: string;
  receipt: string;
}

function exactPin(a: ProductTaskPin, b: ProductTaskPin): boolean {
  return (
    a.taskId === b.taskId && a.sourceGeneration === b.sourceGeneration && a.revision === b.revision
  );
}

function sameRecipient(a: ProductRecipientPin, b: ProductRecipientPin): boolean {
  return (
    a.teamId === b.teamId &&
    a.runId === b.runId &&
    a.laneId === b.laneId &&
    a.memberId === b.memberId &&
    a.memberName === b.memberName
  );
}

function currentMatches(
  request: ProductEffectRequest,
  current: ProductAgentBinding & ProductAgentAuthority
): boolean {
  const { binding, authority } = request;
  return (
    binding.workspaceId === current.workspaceId &&
    binding.teamId === current.teamId &&
    binding.workspaceRoot === current.workspaceRoot &&
    binding.planGeneration === current.planGeneration &&
    binding.runId === current.runId &&
    binding.laneId === current.laneId &&
    binding.memberId === current.memberId &&
    binding.memberName === current.memberName &&
    binding.sessionID === current.sessionID &&
    authority.actorId === current.actorId &&
    authority.workspaceId === current.workspaceId &&
    authority.teamId === current.teamId &&
    authority.deploymentId === current.deploymentId &&
    authority.bootId === current.bootId &&
    authority.restoreGeneration === current.restoreGeneration &&
    authority.mountGeneration === current.mountGeneration &&
    authority.declaredRootHash === current.declaredRootHash &&
    authority.ownerAuthority === current.ownerAuthority &&
    authority.ownerGeneration === current.ownerGeneration &&
    authority.ownerSessionId === current.ownerSessionId
  );
}

function validText(text: string): boolean {
  return (
    typeof text === 'string' &&
    text.trim().length > 0 &&
    Buffer.byteLength(text, 'utf8') <= 64 * 1024
  );
}

function fingerprint(request: ProductEffectRequest): string {
  const { signal: ignoredSignal, ...payload } = request;
  void ignoredSignal;
  return createHash('sha256')
    .update(JSON.stringify(['hosted-product-effect/v1', payload]))
    .digest('hex');
}

/** Hashes only the agent's exact tool proposal, excluding Owner-read task revisions. */
export function fingerprintProductAgentProposal(request: ProductEffectRequest): string {
  const action =
    request.kind === 'status'
      ? ['status', request.task.taskId, request.status]
      : request.kind === 'comment'
        ? ['comment', request.task.taskId, request.text]
        : [
            'message',
            request.recipient.memberName,
            request.text,
            request.taskRefs.map((pin) => pin.taskId),
          ];
  return createHash('sha256')
    .update(
      JSON.stringify([
        'hosted-product-agent-proposal/v1',
        request.binding,
        request.messageID,
        request.callID,
        action,
      ])
    )
    .digest('hex');
}

function effectId(request: ProductEffectRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'hosted-product-effect-id/v1',
        request.binding.teamId,
        request.binding.runId,
        request.binding.memberId,
        request.binding.sessionID,
        request.callID,
      ])
    )
    .digest('hex');
}

/** Inactive until Product worker supplies v35 admission and a canonical file writer. */
export class HostedProductTaskEffectBoundary {
  constructor(
    private readonly database: () => Database,
    private readonly authority: ProductEffectAuthority,
    private readonly canonical: ProductCanonicalEffectWriter,
    private readonly attestation: ProductExactCallAttestation
  ) {}

  commit(request: ProductEffectRequest): string {
    if (
      !(request.signal instanceof AbortSignal) ||
      request.signal.aborted ||
      !request.callID ||
      !request.messageID ||
      !request.binding.sessionID ||
      (request.kind !== 'status' && !validText(request.text))
    ) {
      throw new Error('hosted-product-effect-invalid');
    }
    const db = this.database();
    if (db.inTransaction) throw new Error('hosted-product-effect-nested-transaction');
    const hash = fingerprint(request);
    const id = effectId(request);
    return this.canonical.withExclusiveLock(() =>
      db
        .transaction(() => {
          if (
            !this.attestation.hasExactCall({
              binding: request.binding,
              messageID: request.messageID,
              callID: request.callID,
              proposalFingerprint: fingerprintProductAgentProposal(request),
            })
          )
            throw new Error('hosted-product-effect-unattested-call');
          const existing = db
            .prepare(
              `SELECT fingerprint, receipt FROM main.hosted_product_task_effect_receipts
        WHERE team_id = ? AND call_id = ?`
            )
            .get(request.binding.teamId, request.callID) as ReceiptRow | undefined;
          if (existing) {
            if (existing.fingerprint !== hash)
              throw new Error('hosted-product-effect-idempotency-conflict');
            return existing.receipt;
          }
          // The canonical effect may have survived a crash before the receipt transaction did.
          const recovered = this.canonical.findExactReceipt(id, hash);
          if (recovered !== null) return this.recordReceipt(db, request, id, hash, recovered);

          const current = this.authority.currentMember(
            request.binding.runId,
            request.binding.memberId
          );
          if (!current || !currentMatches(request, current))
            throw new Error('hosted-product-effect-stale-member');
          let effect: ProductCanonicalEffect;
          if (request.kind === 'status' || request.kind === 'comment') {
            const task = this.authority.task(request.binding.teamId, request.task.taskId);
            if (
              !task ||
              task.teamId !== request.binding.teamId ||
              task.ownerId !== request.binding.memberId ||
              !exactPin(task, request.task)
            ) {
              throw new Error('hosted-product-effect-stale-task');
            }
            if (
              request.kind === 'status' &&
              task.status !== (request.status === 'in_progress' ? 'pending' : 'in_progress')
            ) {
              throw new Error('hosted-product-effect-invalid-transition');
            }
            effect =
              request.kind === 'status'
                ? { kind: 'status', member: current, task, status: request.status }
                : { kind: 'comment', member: current, task, text: request.text };
          } else {
            const recipient = this.authority.recipient(
              request.binding.runId,
              request.recipient.memberId
            );
            if (
              !recipient ||
              !sameRecipient(recipient, request.recipient) ||
              recipient.teamId !== request.binding.teamId ||
              recipient.runId !== request.binding.runId ||
              recipient.memberId === request.binding.memberId
            ) {
              throw new Error('hosted-product-effect-stale-recipient');
            }
            const taskRefs: ProductTaskSnapshot[] = [];
            const seen = new Set<string>();
            for (const pin of request.taskRefs) {
              if (seen.has(pin.taskId)) throw new Error('hosted-product-effect-duplicate-task-ref');
              seen.add(pin.taskId);
              const task = this.authority.task(request.binding.teamId, pin.taskId);
              if (!task || task.teamId !== request.binding.teamId || !exactPin(task, pin)) {
                throw new Error('hosted-product-effect-stale-task');
              }
              taskRefs.push(task);
            }
            effect = { kind: 'message', member: current, recipient, taskRefs, text: request.text };
          }
          if (request.signal.aborted) throw new Error('hosted-product-effect-aborted');
          const receipt = this.canonical.writeOnce(id, hash, effect);
          return this.recordReceipt(db, request, id, hash, receipt);
        })
        .immediate()
    );
  }

  private recordReceipt(
    db: Database,
    request: ProductEffectRequest,
    id: string,
    hash: string,
    receipt: string
  ): string {
    if (!receipt || Buffer.byteLength(receipt, 'utf8') > 4096) {
      throw new Error('hosted-product-effect-receipt-invalid');
    }
    db.prepare(
      `INSERT INTO main.hosted_product_task_effect_receipts
      (team_id, call_id, fingerprint, effect_id, receipt) VALUES (?, ?, ?, ?, ?)`
    ).run(request.binding.teamId, request.callID, hash, id, receipt);
    return receipt;
  }
}
