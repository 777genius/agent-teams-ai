import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';

import type { GatewayProviderStorePort } from '../../core/application/ports';
import type { GatewayProviderState } from '../../core/domain';

const MAX_STORE_BYTES = 4 * 1024 * 1024;

function emptyState(): GatewayProviderState {
  return { schemaVersion: 1, profiles: [], bindings: [], sources: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeState(value: unknown): GatewayProviderState {
  const record = asRecord(value);
  if (record?.schemaVersion !== 1) throw new Error('Invalid gateway provider store schema');
  const profiles = Array.isArray(record.profiles) ? record.profiles : [];
  const bindings = Array.isArray(record.bindings) ? record.bindings : [];
  const sources = Array.isArray(record.sources) ? record.sources : [];
  return {
    schemaVersion: 1,
    profiles: profiles.flatMap((entry) => {
      const profile = asRecord(entry);
      const id = readString(profile?.id);
      const displayName = readString(profile?.displayName);
      const baseUrl = readString(profile?.baseUrl);
      const createdAt = readString(profile?.createdAt);
      const updatedAt = readString(profile?.updatedAt);
      return id && displayName && baseUrl && createdAt && updatedAt
        ? [
            {
              id,
              displayName,
              baseUrl,
              allowPrivateNetwork: readBoolean(profile?.allowPrivateNetwork),
              createdAt,
              updatedAt,
            },
          ]
        : [];
    }),
    bindings: bindings.flatMap((entry) => {
      const binding = asRecord(entry);
      const teamName = readString(binding?.teamName);
      const memberName = readString(binding?.memberName);
      const profileId = readString(binding?.profileId);
      const apiKeyRef = readString(binding?.apiKeyRef);
      const gatewayUsageRef = readString(binding?.gatewayUsageRef);
      const boundAt = readString(binding?.boundAt);
      return teamName && memberName && profileId && apiKeyRef && gatewayUsageRef && boundAt
        ? [
            {
              teamName,
              memberName,
              profileId,
              apiKeyRef,
              gatewayUsageRef,
              boundAt,
              draftOwner: readString(binding?.draftOwner),
            },
          ]
        : [];
    }),
    sources: sources.flatMap((entry) => {
      const source = asRecord(entry);
      const gatewayUsageRef = readString(source?.gatewayUsageRef);
      const canonicalEndpoint = readString(source?.canonicalEndpoint);
      const keyFingerprint = readString(source?.keyFingerprint);
      const secretStorageRef = readString(source?.secretStorageRef);
      const teamName = readString(source?.teamName);
      const memberName = readString(source?.memberName);
      const firstUsageDay = readString(source?.firstUsageDay);
      const createdAt = readString(source?.createdAt);
      const lastBoundAt = readString(source?.lastBoundAt);
      if (
        !gatewayUsageRef ||
        !canonicalEndpoint ||
        !keyFingerprint ||
        !secretStorageRef ||
        !teamName ||
        !memberName ||
        !firstUsageDay ||
        !createdAt ||
        !lastBoundAt
      ) {
        return [];
      }
      return [
        {
          gatewayUsageRef,
          canonicalEndpoint,
          allowPrivateNetwork: readBoolean(source?.allowPrivateNetwork),
          keyFingerprint,
          secretStorageRef,
          teamName,
          memberName,
          agentId: readString(source?.agentId),
          firstUsageDay,
          createdAt,
          lastBoundAt,
          lastUnboundAt: readString(source?.lastUnboundAt),
          draftOnly: source?.draftOnly === true ? true : undefined,
          draftOwner: readString(source?.draftOwner),
          hasActiveBinding: readBoolean(source?.hasActiveBinding),
          hasRuntimeArtifact: readBoolean(source?.hasRuntimeArtifact),
          runtimeArtifactRetiredAt: readString(source?.runtimeArtifactRetiredAt),
        },
      ];
    }),
  };
}

export class JsonGatewayProviderStore implements GatewayProviderStorePort {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<GatewayProviderState> {
    return structuredClone(await this.readState());
  }

  async mutate<T>(mutator: (draft: GatewayProviderState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.readState();
      const draft = structuredClone(current);
      const result = await mutator(draft);
      await this.writeState(draft);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readState(): Promise<GatewayProviderState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) {
      throw new Error('Gateway provider store exceeds its size limit');
    }
    return normalizeState(JSON.parse(raw) as unknown);
  }

  private async writeState(state: GatewayProviderState): Promise<void> {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      throw new Error('Gateway provider store exceeds its size limit');
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, serialized, { mode: 0o600 });
  }
}
