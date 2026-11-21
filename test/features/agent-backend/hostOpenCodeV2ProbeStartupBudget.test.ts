// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { OpenCodeV2EmbeddedServerOptions } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer';

const controlled = vi.hoisted(() => ({
  namespace: () => {},
  create: (_options: OpenCodeV2EmbeddedServerOptions): unknown => { throw Error('TEST unexpected server creation'); },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
    const directory = await actual.mkdtemp(...args);
    controlled.namespace();
    return directory;
  } };
});
vi.mock('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.js',
  () => ({ createOpenCodeV2EmbeddedServer: (options: OpenCodeV2EmbeddedServerOptions) => controlled.create(options) }));

import { createOpenCodeV2ModelProbe } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe';
import { runtimeMemberProfileSchema } from '../../../packages/legacy-agent-host/src/composition/runtimeProfile';
import { teamModelProbeProfile } from '../../../packages/legacy-agent-host/src/composition/teamLaunchModelProbe';
import { openCodeManagementProfileSchema } from '../../../packages/legacy-agent-host/src/management/profile';
import { opencodeV2ModelProbeProfile } from '../../../packages/legacy-agent-host/tests/fixtures/opencode-v2-model-probe-profile';

afterEach(() => {
  controlled.namespace = () => {};
  controlled.create = () => { throw Error('TEST unexpected server creation'); };
  vi.restoreAllMocks();
});

/** Actual profile selection, ModelProbe preparation, namespace and deadline checks.
 * The finite server boundary throws before any native process, graph or HTTP work. */
test.each([
  { selected: 120000, remaining: 90000, preparation: 10000, startup: 80000 },
  { selected: 60000, remaining: 90000, preparation: 10000, startup: 60000 },
  { selected: 1000, remaining: 90000, preparation: 10000, startup: 1000 },
  { selected: 120000, remaining: 20000, preparation: 5000, startup: 15000 },
  { selected: 120000, remaining: 0, preparation: 0, startup: undefined },
])('V2 startup preserves original remaining deadline: %j', async scenario => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-probe-startup-budget-')));
  let now = 1700000000000, namespaces = 0, creates = 0, starts = 0, stops = 0;
  const deadline = now + scenario.remaining, nativeFailure = new Error('TEST finite native boundary');
  let captured: OpenCodeV2EmbeddedServerOptions | undefined, runningSignal: AbortSignal | undefined;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  controlled.namespace = () => { if (++namespaces === 1) now += scenario.preparation; };
  controlled.create = options => {
    creates++; captured = options;
    return {
      async start(signal: AbortSignal) { starts++; runningSignal = signal; signal.throwIfAborted(); throw nativeFailure; },
      async stopOwned() { stops++; return true; },
    };
  };
  const selected = runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root, 'TEST-model', scenario.selected));
  const profile = openCodeManagementProfileSchema.parse(teamModelProbeProfile(selected));
  const probe = createOpenCodeV2ModelProbe(profile, { commandId: 'TEST-budget-probe',
    profileId: profile.profileId, configRevision: profile.configRevision,
    providerId: 'TEST-provider', modelId: 'TEST-model' }, () => true, { readiness: {} });
  try {
    expect(probe.timeoutMs).toBe(90000);
    const signal = new AbortController().signal, original = probe.run(signal, deadline);
    expect(probe.run(signal, deadline + 10000), 'repeated run cannot renew its admitted deadline').toBe(original);
    if (scenario.startup === undefined) {
      await expect(original).rejects.toMatchObject({ code: 'held' });
      expect({ namespaces, creates, starts, stops }).toEqual({ namespaces: 0, creates: 0, starts: 0, stops: 0 });
    } else {
      await expect(original).rejects.toBe(nativeFailure);
      expect({ namespaces, creates, starts }).toEqual({ namespaces: 2, creates: 1, starts: 1 });
      expect(captured?.startupTimeoutMs).toBe(scenario.startup);
      expect(captured?.startupTimeoutMs).toBeLessThanOrEqual(deadline - now);
      expect(runningSignal?.aborted).toBe(false);
    }
    const closing = probe.close(deadline);
    expect(probe.close(deadline + 10000), 'close cannot replace the first deadline').toBe(closing);
    await expect(closing).resolves.toBe(scenario.startup !== undefined);
    expect(stops).toBe(scenario.startup === undefined ? 0 : 1);
    if (runningSignal) expect(runningSignal.aborted).toBe(true);
  } finally {
    await probe.close(deadline);
    rmSync(root, { recursive: true, force: true });
  }
});
