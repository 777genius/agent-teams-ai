import { describe, expect, it } from 'vitest';

import { createLaunchSettingsStore } from '../../../src/main/ipc/teams/teamLaunchSettingsStore';

import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';

/** The identity a copy keeps from its last run: the card shows its model before the saved one. */
const lastRun = {
  providerId: 'anthropic',
  selectedModel: 'model-one',
  selectedModelKind: 'explicit',
  resolvedLaunchModel: 'model-one',
  catalogId: 'model-one',
  selectedEffort: 'medium',
  resolvedEffort: 'medium',
} as unknown as NonNullable<TeamMetaFile['launchIdentity']>;

function store(followLeadLaunchIdentity: boolean) {
  let meta = {
    version: 1,
    createdAt: 1,
    cwd: '/work/app',
    model: 'model-one',
    effort: 'medium',
    launchIdentity: lastRun,
  } as TeamMetaFile;
  const metaStore = {
    getMeta: async () => meta,
    updateMeta: async (_team: string, update: (current: TeamMetaFile | null) => unknown) => {
      meta = { ...(update(meta) as TeamMetaFile), version: 1 };
    },
  } as never;
  return {
    launchSettings: createLaunchSettingsStore(metaStore, { followLeadLaunchIdentity }),
    meta: () => meta,
  };
}

/**
 * A stopped project copy refreshed from its definition shows the lead it will
 * start with, like a stopped ordinary team whose lead was saved: its last-run
 * identity follows a saved model or effort. The launch path does not touch it.
 */
describe('createLaunchSettingsStore', () => {
  it('moves the last-run lead identity with a saved model and effort for a stopped copy', async () => {
    const copy = store(true);
    await copy.launchSettings.save('ptc-a', { model: 'model-two', effort: 'high' });
    expect(copy.meta()).toMatchObject({ model: 'model-two', effort: 'high' });
    expect(copy.meta().launchIdentity).toMatchObject({
      selectedModel: 'model-two',
      resolvedLaunchModel: 'model-two',
      selectedEffort: 'high',
      resolvedEffort: 'high',
    });
  });

  it('leaves the identity alone for other settings and in the launch path', async () => {
    const copy = store(true);
    await copy.launchSettings.save('ptc-a', { syncModelsWithLead: false });
    expect(copy.meta().launchIdentity).toEqual(lastRun);

    const launched = store(false);
    await launched.launchSettings.save('ptc-a', { model: 'model-two' });
    expect(launched.meta().model).toBe('model-two');
    expect(launched.meta().launchIdentity).toEqual(lastRun);
  });
});
