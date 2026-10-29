import { z } from 'zod';
import { OpenCodeManagementError } from '../adapters/providers/OpenCodeManagementHost.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';

/** Finite private management methods; controls reconcile only the original journaled intent. */
export function createProviderManagementMethods(
  management: ProviderManagementCoordinator | undefined,
  isSealed: () => boolean
): Record<string, HostMethod> {
  const managementMethods: Record<string, HostMethod> = {};
  if (management) {
    const actions: Record<string, (raw: unknown) => unknown> = {
      'claude.metadata': (raw) => management!.claude.read(raw),
      'claude.auth': (raw) => management!.claudeAuth.read(raw),
      'skills.capture': (raw) => management!.skills.capture(raw),
      'skills.read': (raw) => management!.skills.read(raw),
      'skills.preview': (raw) => management!.skills.preview(raw),
      'skills.mutate': (raw) => management!.skills.mutate(raw),
      'skills.lookup': (raw) => management!.skills.lookup(raw),
      'skills.pending': (raw) => management!.skills.pending(raw),
      'skills.trash.finish': (raw) => management!.skills.finishTrash(raw),
      'extension.capture': (raw) => management!.extensions.capture(raw),
      'extension.read': (raw) => management!.extensions.read(raw),
      'extension.diagnose': (raw) => management!.extensions.diagnose(raw),
      'extension.mutate': (raw) => management!.extensions.mutations.execute(raw),
      'extension.lookup': (raw) => management!.extensions.mutations.lookup(raw),
      'extension.pending': (raw) => management!.extensions.mutations.pending(raw),
      'codex.metadata': (raw) => management!.codex.read(raw),
      catalog: (raw) => management!.catalog(raw),
      credential: (raw) => management!.credentials.execute(raw),
      'credential.lookup': (raw) => management!.credentials.lookup(raw),
      'oauth.start': (raw) => management!.oauth.start(raw),
      'oauth.read': (raw) => management!.oauth.read(raw),
      'oauth.authorization': (raw) => management!.oauth.authorization(raw),
      'oauth.complete': (raw) => management!.oauth.complete(raw),
      'oauth.cancel': (raw) => management!.oauth.cancel(raw),
      'probe.start': (raw) => management!.probes.start(raw),
      'probe.read': (raw) => management!.probes.read(raw),
      'probe.cancel': (raw) => management!.probes.cancel(raw),
    };
    for (const [operation, action] of Object.entries(actions)) {
      managementMethods[`management.${operation}`] = {
        lane:
          operation === 'skills.lookup' ||
          operation === 'skills.pending' ||
          operation === 'skills.trash.finish' ||
          operation === 'extension.lookup' ||
          operation === 'extension.pending' ||
          operation === 'credential.lookup' ||
          operation === 'probe.read' ||
          operation === 'probe.cancel' ||
          (operation.startsWith('oauth.') && operation !== 'oauth.start')
            ? 'control'
            : 'work',
        async handle(raw): Promise<JsonValue> {
          try {
            if (isSealed()) throw new OpenCodeManagementError('unavailable');
            return { ok: true, value: JSON.parse(JSON.stringify(await action(raw))) as JsonValue };
          } catch (error) {
            return {
              ok: false,
              code:
                error instanceof OpenCodeManagementError || error instanceof ManagementCommandError
                  ? error.code
                  : error instanceof z.ZodError
                    ? 'invalid'
                    : 'held',
            };
          }
        },
      };
    }
  }

  return managementMethods;
}
