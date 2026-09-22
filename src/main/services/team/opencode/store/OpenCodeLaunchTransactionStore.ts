import { createHash } from 'crypto';

import { stableJsonStringify } from '../bridge/OpenCodeBridgeCommandContract';

import { VersionedJsonStore, VersionedJsonStoreError } from './VersionedJsonStore';

export const OPENCODE_LAUNCH_TRANSACTION_SCHEMA_VERSION = 1;

export type OpenCodeLaunchCheckpointName =
  | 'run_created'
  | 'host_ready'
  | 'lead_session_recorded'
  | 'member_session_recorded'
  | 'mcp_connected'
  | 'required_tools_proven'
  | 'prompt_sent'
  | 'bootstrap_confirmed'
  | 'permission_blocked'
  | 'delivery_ready'
  | 'member_ready'
  | 'run_ready'
  | 'run_failed'
  | 'run_cancelled';

export interface OpenCodeLaunchCheckpoint {
  name: OpenCodeLaunchCheckpointName;
  teamName: string;
  runId: string;
  memberName: string | null;
  runtimeSessionId: string | null;
  hostKey: string | null;
  evidenceHash: string;
  createdAt: string;
  diagnostics: string[];
}

export interface OpenCodeLaunchTransaction {
  teamName: string;
  runId: string;
  providerId: 'opencode';
  startedAt: string;
  updatedAt: string;
  status: 'active' | 'ready' | 'failed' | 'cancelled' | 'reconciled';
  checkpoints: OpenCodeLaunchCheckpoint[];
}

export interface OpenCodeRunReadyInput {
  members: { name: string; launchState?: string }[];
  transaction: OpenCodeLaunchTransaction;
  toolProof: { ok: boolean };
  deliveryReady: boolean;
}

export class OpenCodeLaunchTransactionStore {
  constructor(
    private readonly store: VersionedJsonStore<OpenCodeLaunchTransaction[]>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async beginRun(input: {
    teamName: string;
    runId: string;
    startedAt?: string;
  }): Promise<
    | { state: 'created'; transaction: OpenCodeLaunchTransaction }
    | { state: 'already_active'; transaction: OpenCodeLaunchTransaction }
  > {
    let result:
      | { state: 'created'; transaction: OpenCodeLaunchTransaction }
      | { state: 'already_active'; transaction: OpenCodeLaunchTransaction }
      | null = null;
    const startedAt = input.startedAt ?? this.clock().toISOString();

    await this.store.updateLocked((transactions) => {
      const active = transactions.find(
        (transaction) => transaction.teamName === input.teamName && transaction.status === 'active'
      );
      if (active) {
        result = { state: 'already_active', transaction: active };
        return transactions;
      }

      const transaction: OpenCodeLaunchTransaction = {
        teamName: input.teamName,
        runId: input.runId,
        providerId: 'opencode',
        startedAt,
        updatedAt: startedAt,
        status: 'active',
        checkpoints: [],
      };
      result = { state: 'created', transaction };
      return [...transactions, transaction];
    });

    if (!result) {
      throw new Error('OpenCode launch transaction begin failed');
    }
    return result;
  }

  async addCheckpoint(input: OpenCodeLaunchCheckpoint): Promise<'created' | 'unchanged'> {
    let outcome: 'created' | 'unchanged' = 'created';
    await this.store.updateLocked((transactions) =>
      transactions.map((transaction) => {
        if (transaction.teamName !== input.teamName || transaction.runId !== input.runId) {
          return transaction;
        }

        if (transaction.status !== 'active') {
          throw new Error(`OpenCode launch transaction is not active: ${input.runId}`);
        }

        const duplicate = transaction.checkpoints.some(
          (checkpoint) =>
            checkpoint.name === input.name &&
            checkpoint.memberName === input.memberName &&
            checkpoint.evidenceHash === input.evidenceHash
        );
        if (duplicate) {
          outcome = 'unchanged';
          return transaction;
        }

        return {
          ...transaction,
          updatedAt: input.createdAt,
          checkpoints: [...transaction.checkpoints, normalizeCheckpoint(input)],
        };
      })
    );

    if (!(await this.hasTransaction(input.teamName, input.runId))) {
      throw new Error(`OpenCode launch transaction not found: ${input.runId}`);
    }

    return outcome;
  }

  async hasCheckpoint(input: {
    teamName: string;
    runId: string;
    memberName: string | null;
    name: OpenCodeLaunchCheckpointName;
    evidenceHash?: string;
  }): Promise<boolean> {
    const transaction = await this.read(input.teamName, input.runId);
    return (
      transaction?.checkpoints.some(
        (checkpoint) =>
          checkpoint.name === input.name &&
          checkpoint.memberName === input.memberName &&
          (input.evidenceHash === undefined || checkpoint.evidenceHash === input.evidenceHash)
      ) ?? false
    );
  }

  async readActive(teamName: string): Promise<OpenCodeLaunchTransaction | null> {
    const transactions = await this.readRequired();
    return (
      transactions.find(
        (transaction) => transaction.teamName === teamName && transaction.status === 'active'
      ) ?? null
    );
  }

  async read(teamName: string, runId: string): Promise<OpenCodeLaunchTransaction | null> {
    const transactions = await this.readRequired();
    return (
      transactions.find(
        (transaction) => transaction.teamName === teamName && transaction.runId === runId
      ) ?? null
    );
  }

  async finish(input: {
    teamName: string;
    runId: string;
    status: 'ready' | 'failed' | 'cancelled' | 'reconciled';
    updatedAt?: string;
  }): Promise<'finished' | 'unchanged'> {
    let found = false;
    let outcome: 'finished' | 'unchanged' = 'finished';
    const updatedAt = input.updatedAt ?? this.clock().toISOString();

    await this.store.updateLocked((transactions) =>
      transactions.map((transaction) => {
        if (transaction.teamName !== input.teamName || transaction.runId !== input.runId) {
          return transaction;
        }
        found = true;
        if (transaction.status !== 'active') {
          outcome = 'unchanged';
          return transaction;
        }
        return {
          ...transaction,
          status: input.status,
          updatedAt,
        };
      })
    );

    if (!found) {
      const active = await this.readActive(input.teamName);
      if (active) {
        throw new Error(
          `OpenCode launch transaction ${input.runId} is stale; active run is ${active.runId}`
        );
      }
      throw new Error(`OpenCode launch transaction not found: ${input.runId}`);
    }

    return outcome;
  }

  async list(): Promise<OpenCodeLaunchTransaction[]> {
    return this.readRequired();
  }

  private async hasTransaction(teamName: string, runId: string): Promise<boolean> {
    return (await this.read(teamName, runId)) !== null;
  }

  private async readRequired(): Promise<OpenCodeLaunchTransaction[]> {
    const result = await this.store.read();
    if (!result.ok) {
      throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
    }
    return result.data;
  }
}

export function canMarkOpenCodeRunReady(input: OpenCodeRunReadyInput): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  for (const member of input.members) {
    if (!hasMemberCheckpoint(input.transaction, member.name, 'member_session_recorded')) {
      missing.push(`${member.name}:member_session_recorded`);
    }
    if (!hasMemberCheckpoint(input.transaction, member.name, 'required_tools_proven')) {
      missing.push(`${member.name}:required_tools_proven`);
    }
    if (member.launchState !== 'confirmed_alive') {
      missing.push(`${member.name}:bootstrap_confirmed`);
    }
  }

  if (!input.toolProof.ok) {
    missing.push('required_runtime_tools');
  }
  if (!input.deliveryReady) {
    missing.push('runtime_delivery_service');
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

export function hasMemberCheckpoint(
  transaction: OpenCodeLaunchTransaction,
  memberName: string,
  name: OpenCodeLaunchCheckpointName
): boolean {
  return transaction.checkpoints.some(
    (checkpoint) => checkpoint.memberName === memberName && checkpoint.name === name
  );
}

export function createOpenCodeLaunchEvidenceHash(evidence: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableJsonStringify(redactOpenCodeLaunchEvidence(evidence)))
    .digest('hex')}`;
}

export function redactOpenCodeLaunchEvidence(evidence: unknown): unknown {
  if (evidence === null || typeof evidence !== 'object') {
    return evidence;
  }

  if (Array.isArray(evidence)) {
    return evidence.map(redactOpenCodeLaunchEvidence);
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactOpenCodeLaunchEvidence(value);
    }
  }
  return output;
}

export function createOpenCodeLaunchTransactionStore(options: {
  filePath: string;
  clock?: () => Date;
}): OpenCodeLaunchTransactionStore {
  const clock = options.clock ?? (() => new Date());
  return new OpenCodeLaunchTransactionStore(
    new VersionedJsonStore<OpenCodeLaunchTransaction[]>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_LAUNCH_TRANSACTION_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateOpenCodeLaunchTransactions,
      clock,
    }),
    clock
  );
}

export function validateOpenCodeLaunchTransactions(value: unknown): OpenCodeLaunchTransaction[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenCode launch transactions must be an array');
  }
  return value.map((transaction, index) => {
    if (!isLaunchTransaction(transaction)) {
      throw new Error(`Invalid OpenCode launch transaction at index ${index}`);
    }
    return transaction;
  });
}

function normalizeCheckpoint(input: OpenCodeLaunchCheckpoint): OpenCodeLaunchCheckpoint {
  return {
    ...input,
    diagnostics: [...input.diagnostics],
  };
}

function isLaunchTransaction(value: unknown): value is OpenCodeLaunchTransaction {
  return (
    isRecord(value) &&
    isNonEmptyString(value.teamName) &&
    isNonEmptyString(value.runId) &&
    value.providerId === 'opencode' &&
    isNonEmptyString(value.startedAt) &&
    isNonEmptyString(value.updatedAt) &&
    (value.status === 'active' ||
      value.status === 'ready' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'reconciled') &&
    Array.isArray(value.checkpoints) &&
    value.checkpoints.every(isLaunchCheckpoint)
  );
}

function isLaunchCheckpoint(value: unknown): value is OpenCodeLaunchCheckpoint {
  return (
    isRecord(value) &&
    isLaunchCheckpointName(value.name) &&
    isNonEmptyString(value.teamName) &&
    isNonEmptyString(value.runId) &&
    isNullableString(value.memberName) &&
    isNullableString(value.runtimeSessionId) &&
    isNullableString(value.hostKey) &&
    isNonEmptyString(value.evidenceHash) &&
    isNonEmptyString(value.createdAt) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((item) => typeof item === 'string')
  );
}

function isLaunchCheckpointName(value: unknown): value is OpenCodeLaunchCheckpointName {
  return (
    value === 'run_created' ||
    value === 'host_ready' ||
    value === 'lead_session_recorded' ||
    value === 'member_session_recorded' ||
    value === 'mcp_connected' ||
    value === 'required_tools_proven' ||
    value === 'prompt_sent' ||
    value === 'bootstrap_confirmed' ||
    value === 'permission_blocked' ||
    value === 'delivery_ready' ||
    value === 'member_ready' ||
    value === 'run_ready' ||
    value === 'run_failed' ||
    value === 'run_cancelled'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
