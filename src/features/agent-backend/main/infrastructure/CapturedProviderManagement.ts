import { BackendRoutingError, captureBackendPayload } from '../application/backendBinding';

import type { CapturedHostClient } from './CapturedHostClient';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const methods = [
  'skills.capture',
  'skills.read',
  'skills.preview',
  'skills.mutate',
  'skills.lookup',
  'skills.pending',
  'skills.trash.finish',
  'catalog',
  'codex.metadata',
  'claude.metadata',
  'claude.auth',
  'extension.capture',
  'extension.read',
  'extension.diagnose',
  'extension.mutate',
  'extension.lookup',
  'extension.pending',
  'credential',
  'credential.lookup',
  'oauth.start',
  'oauth.read',
  'oauth.authorization',
  'oauth.complete',
  'oauth.cancel',
  'probe.start',
  'probe.read',
  'probe.cancel',
] as const;
export type ProviderManagementOperation = (typeof methods)[number];
export interface CapturedProviderPreferencePaths {
  readonly projectRoot: string | null;
  readonly globalRoot: string;
}
export interface CapturedProviderManagement {
  /** Private digest of the complete captured owner/profile selection; never a renderer selector. */
  readonly targetId: string;
  readonly profileId: string;
  readonly configRevision: string;
  readonly preferences?: CapturedProviderPreferencePaths;
  isCurrent(): boolean;
  request(
    operation: ProviderManagementOperation,
    payload: Record<string, JsonValue>
  ): Promise<JsonValue>;
}

/** Private Main-only capture. Auth controls retain the original owner after a foreground switch. */
export function captureProviderManagement(options: {
  targetId: string;
  profileId: string;
  configRevision: string;
  preferences?: CapturedProviderPreferencePaths;
  client: Pick<CapturedHostClient, 'request'>;
  start(): Promise<unknown>;
  ownerAvailable(): boolean;
  foregroundCurrent(): boolean;
}): CapturedProviderManagement {
  const { profileId, configRevision, client, start, ownerAvailable, foregroundCurrent } = options;
  const current = () => {
    try {
      return ownerAvailable() && foregroundCurrent();
    } catch {
      return false;
    }
  };
  const check = (retained: boolean, outcome: 'not-dispatched' | 'unknown') => {
    let owner = false,
      foreground = false;
    try {
      owner = ownerAvailable();
      foreground = retained || foregroundCurrent();
    } catch {
      /* Fail closed. */
    }
    if (!owner) throw new BackendRoutingError('unavailable', outcome);
    if (!foreground) throw new BackendRoutingError('forbidden', outcome);
  };
  return Object.freeze({
    targetId: options.targetId,
    profileId,
    configRevision,
    ...(options.preferences ? { preferences: Object.freeze({ ...options.preferences }) } : {}),
    isCurrent: current,
    async request(operation: ProviderManagementOperation, payload: Record<string, JsonValue>) {
      if (
        !methods.includes(operation) ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.hasOwn(payload, 'profileId') ||
        Object.hasOwn(payload, 'configRevision')
      )
        throw new BackendRoutingError('invalid-binding');
      const captured = captureBackendPayload(payload, `management.${operation}`);
      if (
        !captured ||
        typeof captured !== 'object' ||
        Array.isArray(captured) ||
        Object.hasOwn(captured, 'profileId') ||
        Object.hasOwn(captured, 'configRevision')
      )
        throw new BackendRoutingError('invalid-binding');
      const retained =
        operation === 'skills.lookup' ||
        operation === 'skills.pending' ||
        operation === 'skills.trash.finish' ||
        operation === 'extension.lookup' ||
        operation === 'extension.pending' ||
        operation === 'oauth.cancel' ||
        operation === 'oauth.read' ||
        operation === 'probe.read' ||
        operation === 'probe.cancel' ||
        operation === 'credential.lookup';
      check(retained, 'not-dispatched');
      await start();
      check(retained, 'not-dispatched');
      // The caller cannot substitute account/config selection in a payload.
      const result = await client.request(
        `management.${operation}`,
        { ...captured, profileId, configRevision },
        {
          control: ![
            'catalog',
            'codex.metadata',
            'claude.metadata',
            'claude.auth',
            'skills.capture',
            'skills.read',
            'skills.preview',
            'skills.mutate',
            'extension.capture',
            'extension.read',
            'extension.diagnose',
            'extension.mutate',
            'credential',
            'oauth.start',
            'probe.start',
          ].includes(operation),
        }
      );
      check(retained, 'unknown');
      return result;
    },
  });
}
