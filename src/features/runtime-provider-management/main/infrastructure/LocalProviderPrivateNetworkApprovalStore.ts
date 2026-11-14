import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';

const APPROVAL_STORE_MAX_BYTES = 131_072;
const APPROVAL_STORE_FILENAME = 'private-network-approvals.json';

export interface LocalProviderPrivateNetworkApproval {
  readonly configPath: string;
  readonly providerId: string;
  readonly baseUrl: string;
}

export interface LocalProviderPrivateNetworkApprovalStore {
  isApproved(approval: LocalProviderPrivateNetworkApproval): Promise<boolean>;
  approve(approval: LocalProviderPrivateNetworkApproval): Promise<void>;
}

interface PersistedApprovalStore {
  readonly schemaVersion: 1;
  readonly approvals: readonly LocalProviderPrivateNetworkApproval[];
}

/** Returns the app-owned persistence path for private-network provider approvals. */
export function getLocalProviderPrivateNetworkApprovalStorePath(): string {
  return path.join(getAppDataPath(), 'runtime-provider-management', APPROVAL_STORE_FILENAME);
}

/** Persists exact config, provider, and URL approval tuples in a private JSON file. */
export class JsonLocalProviderPrivateNetworkApprovalStore implements LocalProviderPrivateNetworkApprovalStore {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly configuredFilePath?: string) {}

  async isApproved(approval: LocalProviderPrivateNetworkApproval): Promise<boolean> {
    const approvalKey = buildApprovalKey(approval);
    const approvals = await this.readApprovals();
    return approvals.some((candidate) => buildApprovalKey(candidate) === approvalKey);
  }


  /** Captures the original read-only source; never joins or advances the approval write chain. */
  capture() {
    const filePath = this.getFilePath();
    return async <Source>(
      approvals: readonly LocalProviderPrivateNetworkApproval[],
      read: (filePath: string, maximum: number) => Promise<{ source: Source; raw: string | null }>
    ): Promise<{ source: Source; approved: LocalProviderPrivateNetworkApproval[] }> => {
      if (approvals.length > 256) throw new Error('Too many original provider destinations');
      const requested = approvals.map(normalizeApproval);
      const captured = await read(filePath, APPROVAL_STORE_MAX_BYTES);
      let parsed: unknown;
      try { parsed = captured.raw === null ? null : JSON.parse(captured.raw); } catch { parsed = null; }
      const allowed = new Set<string>();
      if (isRecord(parsed) && parsed.schemaVersion === 1 && Array.isArray(parsed.approvals)) {
        for (const candidate of parsed.approvals) {
          if (isRecord(candidate) && typeof candidate.configPath === 'string' &&
              typeof candidate.providerId === 'string' && typeof candidate.baseUrl === 'string')
            allowed.add(buildApprovalKey({
              configPath: candidate.configPath, providerId: candidate.providerId, baseUrl: candidate.baseUrl,
            }));
        }
      }
      const unique = new Map(requested.map(approval => [buildApprovalKey(approval), approval]));
      return { source: captured.source, approved: [...unique].flatMap(([key, approval]) =>
        allowed.has(key) ? [approval] : []) };
    };
  }

  approve(approval: LocalProviderPrivateNetworkApproval): Promise<void> {
    const normalizedApproval = normalizeApproval(approval);
    const run = this.writeChain.then(
      () => this.approveNow(normalizedApproval),
      () => this.approveNow(normalizedApproval)
    );
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async approveNow(approval: LocalProviderPrivateNetworkApproval): Promise<void> {
    const approvals = await this.readApprovals();
    const approvalKey = buildApprovalKey(approval);
    if (approvals.some((candidate) => buildApprovalKey(candidate) === approvalKey)) return;

    const filePath = this.getFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const next: PersistedApprovalStore = {
      schemaVersion: 1,
      approvals: [...approvals, approval],
    };
    await atomicWriteAsync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private async readApprovals(): Promise<readonly LocalProviderPrivateNetworkApproval[]> {
    try {
      const filePath = this.getFilePath();
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > APPROVAL_STORE_MAX_BYTES) {
        return [];
      }
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.approvals)) {
        return [];
      }
      return parsed.approvals.flatMap((candidate) => {
        if (
          !isRecord(candidate) ||
          typeof candidate.configPath !== 'string' ||
          typeof candidate.providerId !== 'string' ||
          typeof candidate.baseUrl !== 'string'
        ) {
          return [];
        }
        return [
          normalizeApproval({
            configPath: candidate.configPath,
            providerId: candidate.providerId,
            baseUrl: candidate.baseUrl,
          }),
        ];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  private getFilePath(): string {
    return this.configuredFilePath ?? getLocalProviderPrivateNetworkApprovalStorePath();
  }
}

function normalizeApproval(
  approval: LocalProviderPrivateNetworkApproval
): LocalProviderPrivateNetworkApproval {
  return {
    configPath: path.resolve(approval.configPath),
    providerId: approval.providerId.trim(),
    baseUrl: approval.baseUrl.trim(),
  };
}

function buildApprovalKey(approval: LocalProviderPrivateNetworkApproval): string {
  const normalized = normalizeApproval(approval);
  return JSON.stringify([normalized.configPath, normalized.providerId, normalized.baseUrl]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
