import { createHash } from 'node:crypto';

import { parseSha256Digest } from '../../contracts';

import { canonicalBackupJson } from './canonicalBackupJson';

import type { BackupManifestBody, Sha256Digest } from '../../contracts';
import type { BackupManifestHashPort } from '../../core/application';

export function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(createHash('sha256').update(bytes).digest('hex'));
}

export class NodeBackupManifestHasher implements BackupManifestHashPort {
  async hashCanonicalManifest(body: BackupManifestBody): Promise<Sha256Digest> {
    return sha256Bytes(Buffer.from(canonicalBackupJson(body), 'utf8'));
  }
}
