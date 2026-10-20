import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { InterruptionClassifyingCustomTeamTemplateStorageGateway } from '@features/custom-team-templates/main/adapters/output/InterruptionClassifyingCustomTeamTemplateStorageGateway';
import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

function gatewayWithCreate(
  create: CustomTeamTemplateStorageGateway['customTeamTemplateCreate']
): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate: create,
    customTeamTemplateList: vi.fn().mockResolvedValue({ templates: [], unreadableRecords: [] }),
    customTeamTemplateGetById: vi.fn().mockResolvedValue({ status: 'notFound' }),
  };
}

describe('InterruptionClassifyingCustomTeamTemplateStorageGateway', () => {
  it('translates an interrupted worker call and preserves execution and settlement', async () => {
    let settled = false;
    const settle = Promise.resolve().then(() => {
      settled = true;
    });
    const gateway = new InterruptionClassifyingCustomTeamTemplateStorageGateway(
      gatewayWithCreate(() =>
        Promise.reject(
          new InternalStorageOperationInterruptedError('worker exited', 'unknown', settle)
        )
      )
    );

    const failure = await gateway
      .customTeamTemplateCreate({ template: {} as never, contentHash: 'hash' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CustomTeamTemplateStorageInterruptedError);
    expect(failure).toMatchObject({
      execution: 'unknown',
      name: 'CustomTeamTemplateStorageInterruptedError',
    });
    await (failure as CustomTeamTemplateStorageInterruptedError).settled;
    expect(settled).toBe(true);
  });

  it('distinguishes a request that never started', async () => {
    const gateway = new InterruptionClassifyingCustomTeamTemplateStorageGateway(
      gatewayWithCreate(() =>
        Promise.reject(
          new InternalStorageOperationInterruptedError(
            'previous worker has not exited',
            'not_started',
            Promise.resolve()
          )
        )
      )
    );

    const failure = await gateway
      .customTeamTemplateCreate({ template: {} as never, contentHash: 'hash' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CustomTeamTemplateStorageInterruptedError);
    expect(failure).toMatchObject({ execution: 'not_started' });
  });

  it('passes through successful results and unrelated failures unchanged', async () => {
    const created = {
      status: 'created' as const,
      template: {
        templateId: 'tmpl-1',
        name: 'Template',
        schemaVersion: 1 as const,
        teamPrompt: '',
        members: [],
      },
    };
    const gateway = new InterruptionClassifyingCustomTeamTemplateStorageGateway(
      gatewayWithCreate(() => Promise.resolve(created))
    );
    await expect(
      gateway.customTeamTemplateCreate({ template: {} as never, contentHash: 'hash' })
    ).resolves.toEqual(created);

    const plain = new Error('SQLITE_CONSTRAINT');
    const failing = new InterruptionClassifyingCustomTeamTemplateStorageGateway(
      gatewayWithCreate(() => Promise.reject(plain))
    );
    await expect(
      failing.customTeamTemplateCreate({ template: {} as never, contentHash: 'hash' })
    ).rejects.toBe(plain);

    const throwingList = new InterruptionClassifyingCustomTeamTemplateStorageGateway({
      ...gatewayWithCreate(() => Promise.reject(plain)),
      customTeamTemplateList: () => Promise.reject(plain),
    });
    await expect(throwingList.customTeamTemplateList()).rejects.toBe(plain);
  });
});
