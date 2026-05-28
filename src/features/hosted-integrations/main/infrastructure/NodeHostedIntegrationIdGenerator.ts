import { createHash } from 'node:crypto';

import { createStableGithubActionRequestId } from '../../core/domain';

import type { HostedGitHubActionCommandDto } from '../../contracts';
import type { HostedIntegrationIdGeneratorPort } from '../../core/application';

export class NodeHostedIntegrationIdGenerator implements HostedIntegrationIdGeneratorPort {
  public async stableActionRequestId(input: HostedGitHubActionCommandDto): Promise<string> {
    return createStableGithubActionRequestId({
      actionType: input.actionType,
      localAttemptId: input.localAttemptId,
      payloadFingerprint: createPayloadFingerprint(input.payload),
      targetId: input.targetId,
    });
  }
}

export function createPayloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
