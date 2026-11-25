import { z } from 'zod';
import { ManagementCommandError } from '../management/commandRecords.js';
import { RuntimeSourceAdmissionError } from './runtimeSourceQualification.js';
import { OpenCodeConfigurationError } from '../adapters/providers/OpenCodeConfigurationSource.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeSourceIndex } from './RuntimeSourceIndex.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';

/** Private Main-to-Host admission only. These names are absent from renderer and model-tool allowlists. */
export function createRuntimeSourceMethods(
  sources: RuntimeSourceIndex | undefined,
  management: ProviderManagementCoordinator | undefined,
  assertCurrent: () => void
): Record<string, HostMethod> {
  if (!sources || !management) return {};
  const actions: Record<string, (raw: unknown) => unknown> = {
    current: (raw) => sources.current(raw),
    retained: (raw) => sources.retained(raw),
    lookup: (raw) => sources.lookup(raw),
    publish: (raw) =>
      sources.publish(raw, (profile) => management.admitRuntimeSourceProfile(profile)),
    recover: (raw) =>
      sources.recover(raw, (profile) => management.admitRuntimeSourceProfile(profile)),
    refreshConfiguration: (raw) =>
      sources.refreshConfiguration(raw, (profile) => management.admitRuntimeSourceProfile(profile)),
  };
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      `runtime.source.${name}`,
      {
        lane: ['publish', 'recover', 'refreshConfiguration'].includes(name) ? 'work' : 'control',
        async handle(raw: unknown): Promise<JsonValue> {
          try {
            assertCurrent();
            return { ok: true, value: JSON.parse(JSON.stringify(await action(raw))) as JsonValue };
          } catch (error) {
            return {
              ok: false,
              ...(error instanceof RuntimeSourceAdmissionError || error instanceof OpenCodeConfigurationError
                ? { reason: error.reason } : {}),
              code:
                error instanceof ManagementCommandError
                  ? error.code
                  : error instanceof z.ZodError
                    ? 'invalid'
                    : 'held',
            };
          }
        },
      },
    ])
  );
}
