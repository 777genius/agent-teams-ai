import crypto from 'node:crypto';

import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

export type GatewayCredentialStatus = 'ready' | 'credential_changed' | 'credential_missing';

export interface ResolvedGatewayCredential {
  storageRef: string;
  value: string;
  status: 'ready';
}

export function hashGatewayLiteral(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashGatewayUsageRef(canonicalEndpoint: string, keyFingerprint: string): string {
  return crypto
    .createHash('sha256')
    .update(`${canonicalEndpoint}\n${keyFingerprint}`, 'utf8')
    .digest('hex');
}

export class GatewayCredentialError extends Error {
  constructor(
    message: string,
    readonly reason: 'credential_changed' | 'credential_missing'
  ) {
    super(message);
    this.name = 'GatewayCredentialError';
  }
}

export class GatewayCredentialStore {
  constructor(private readonly apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>) {}

  async readExact(storageRef: string, keyFingerprint: string): Promise<ResolvedGatewayCredential> {
    let value: string | null;
    try {
      value = await this.apiKeys.readValueById(storageRef);
    } catch {
      throw new GatewayCredentialError(
        'The gateway key record cannot be decrypted. Re-enter the original key.',
        'credential_changed'
      );
    }
    if (value === null) {
      throw new GatewayCredentialError(
        'The gateway key record was deleted. Re-enter the original key.',
        'credential_missing'
      );
    }
    if (hashGatewayLiteral(value) !== keyFingerprint) {
      throw new GatewayCredentialError(
        'The gateway key was changed outside this binding. Re-enter the original key.',
        'credential_changed'
      );
    }
    return { storageRef, value, status: 'ready' };
  }

  async status(storageRef: string, keyFingerprint: string): Promise<GatewayCredentialStatus> {
    try {
      await this.readExact(storageRef, keyFingerprint);
      return 'ready';
    } catch (error) {
      return error instanceof GatewayCredentialError ? error.reason : 'credential_changed';
    }
  }

  async ensure(input: {
    apiKey: string;
    keyFingerprint: string;
    teamName: string;
    memberName: string;
    existingStorageRef?: string;
  }): Promise<string> {
    if (input.existingStorageRef) {
      try {
        await this.readExact(input.existingStorageRef, input.keyFingerprint);
        return input.existingStorageRef;
      } catch {
        // Deleted or edited through the shared editor: restore a dedicated record for the
        // same fingerprint so accounting identity (usage ref) does not change.
      }
    }
    const saved = await this.apiKeys.save({
      name: `Gateway ${input.teamName}/${input.memberName}`,
      envVarName: `GATEWAY_KEY_${input.keyFingerprint.slice(0, 16).toUpperCase()}`,
      value: input.apiKey,
      scope: 'user',
    });
    return saved.id;
  }
}
