import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ManagementError } from '@uap/management-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalSkillMutationExecutor } from '../../../src/features/extension-management/main/adapters/output/createLocalSkillMutationExecutor';
import { SkillPlanService } from '../../../src/main/services/extensions/skills/SkillPlanService';

import type { ExtensionManagementFeature } from '../../../src/features/extension-management/core/application/ports';
import type { SkillUpsertRequest } from '../../../src/shared/types/extensions';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uap-local-adapter-'));
  roots.push(root);
  const skill = path.join(root, 'demo');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), 'original\n');
  const feature = {
    capture: vi.fn(async () => ({ contextId: 'host-a' })),
    localSkillStatus: vi.fn(async () => ({
      ownership: 'local',
      rootId: 'root-a',
      skillName: 'demo',
    })),
    prepareLocalSkill: vi.fn(async () => ({
      planId: 'plan-a',
      contextId: 'engine-a',
      action: 'local_skill',
      confirmable: true,
      expiresAt: '2099-01-01T00:00:00Z',
      actions: [],
      warnings: [],
      conflicts: [],
    })),
    apply: vi.fn(async () => ({ operationId: 'op-a', state: 'succeeded' })),
    operation: vi.fn(),
    discardPlan: vi.fn(async (_request: { contextId: string; planId: string }) => {}),
  };
  const executor = createLocalSkillMutationExecutor(
    feature as unknown as ExtensionManagementFeature
  );
  const request: SkillUpsertRequest = {
    scope: 'user',
    rootKind: 'claude',
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: 'reviewed\n' }],
  };
  const plan = await new SkillPlanService().buildUpsertPlan(skill, request.files);
  return { feature, executor, request, plan, skill };
}
describe('local Skill engine adapter', () => {
  it('releases abandoned reviews before the engine reaches its sixteen-plan capacity', async () => {
    const f = await fixture();
    const live = new Set<string>();
    let sequence = 0;
    f.feature.prepareLocalSkill.mockImplementation(async () => {
      if (live.size >= 16) throw new Error('Engine review capacity reached');
      const planId = `plan-${++sequence}`;
      live.add(planId);
      return {
        planId,
        contextId: 'engine-a',
        action: 'local_skill',
        confirmable: true,
        expiresAt: '2099-01-01T00:00:00Z',
        actions: [],
        warnings: [],
        conflicts: [],
      };
    });
    f.feature.discardPlan.mockImplementation(async (request: { planId: string }) => {
      live.delete(request.planId);
    });
    for (let index = 0; index < 20; index += 1) {
      const preview = await f.executor.preview(f.plan, f.request);
      await f.executor.discardReview(preview.planId);
    }
    expect(live.size).toBe(0);
    expect(f.feature.discardPlan).toHaveBeenCalledTimes(20);
    expect(f.feature.apply).not.toHaveBeenCalled();
  });

  it('retains exact bytes and delegates effects without writing from Node', async () => {
    const f = await fixture();
    const preview = await f.executor.preview(f.plan, f.request);
    expect(preview.planId).toBe('plan-a');
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledWith({
      contextId: 'host-a',
      change: {
        action: 'upsert',
        rootId: 'root-a',
        skillName: 'demo',
        files: [
          {
            relativePath: 'SKILL.md',
            expectedSHA256: createHash('sha256').update('original\n').digest('hex'),
            contentBase64: Buffer.from('reviewed\n').toString('base64'),
          },
        ],
      },
    });
    await f.executor.apply(preview.planId, { ...f.request, reviewPlanId: preview.planId });
    await f.executor.discardReview(preview.planId);
    expect(f.feature.discardPlan).not.toHaveBeenCalled();
    expect(f.feature.apply).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'host-a', planId: 'plan-a' })
    );
    expect(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8')).toBe('original\n');
  });
  it('discards a prepared review that cannot be returned to the editor', async () => {
    const f = await fixture();
    const plan = await f.feature.prepareLocalSkill();
    f.feature.prepareLocalSkill.mockResolvedValue({ ...plan, confirmable: false });
    await expect(f.executor.preview(f.plan, f.request)).rejects.toThrow('cannot be applied');
    expect(f.feature.discardPlan).toHaveBeenCalledExactlyOnceWith({
      contextId: 'host-a',
      planId: 'plan-a',
    });
  });

  it('blocks Apply while the same unattempted review is being discarded', async () => {
    const f = await fixture();
    const preview = await f.executor.preview(f.plan, f.request);
    let complete!: () => void;
    f.feature.discardPlan.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      })
    );
    const closing = f.executor.discardReview(preview.planId);
    await expect(f.executor.apply(preview.planId, f.request)).rejects.toThrow('closing');
    expect(f.feature.apply).not.toHaveBeenCalled();
    complete();
    await closing;
    await expect(f.executor.apply(preview.planId, f.request)).rejects.toThrow(
      'changed after review'
    );
  });
  it('never replaces the digest of reviewed old bytes with a later filesystem read', async () => {
    const f = await fixture();
    await writeFile(path.join(f.skill, 'SKILL.md'), 'concurrent edit\n');
    await f.executor.preview(f.plan, f.request);
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        change: expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              expectedSHA256: createHash('sha256').update('original\n').digest('hex'),
            }),
          ]),
        }),
      })
    );
  });
  it('rejects managed ownership before preparing local mutations', async () => {
    const f = await fixture();
    f.feature.localSkillStatus.mockResolvedValue({
      ownership: 'managed',
      rootId: 'root-a',
      skillName: 'demo',
    });
    await expect(f.executor.preview(f.plan, f.request)).rejects.toThrow('managed by UAP');
    await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow('managed by UAP');
    expect(f.feature.prepareLocalSkill).not.toHaveBeenCalled();
  });
  it('preserves a request identity after an uncertain reply and rejects changed intent', async () => {
    const f = await fixture();
    const preview = await f.executor.preview(f.plan, f.request);
    f.feature.apply.mockRejectedValueOnce(new Error('reply lost'));
    await expect(f.executor.apply(preview.planId, f.request)).rejects.toThrow('reply lost');
    await f.executor.discardReview(preview.planId);
    expect(f.feature.discardPlan).not.toHaveBeenCalled();
    await expect(
      f.executor.apply(preview.planId, { ...f.request, folderName: 'other' })
    ).rejects.toThrow('changed after review');
    await f.executor.apply(preview.planId, f.request);
    expect(f.feature.apply.mock.calls[0]).toEqual(f.feature.apply.mock.calls[1]);
  });

  it('binds scaffold create-only intent to the retained review', async () => {
    const f = await fixture();
    const request = {
      ...f.request,
      files: [
        ...f.request.files,
        { relativePath: 'assets/README.md', content: '# Assets', createOnly: true },
      ],
    };
    const plan = await new SkillPlanService().buildUpsertPlan(f.skill, request.files);
    const preview = await f.executor.preview(plan, request);
    await expect(
      f.executor.apply(preview.planId, {
        ...request,
        files: request.files.map((file) => ({ ...file, createOnly: false })),
      })
    ).rejects.toThrow('changed after review');
    expect(f.feature.apply).not.toHaveBeenCalled();
  });
  it('never falls back to a filesystem write when engine inspection is unavailable', async () => {
    const f = await fixture();
    f.feature.localSkillStatus.mockRejectedValue(new Error('engine unavailable'));
    await expect(f.executor.preview(f.plan, f.request)).rejects.toThrow('engine unavailable');
    await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow('engine unavailable');
    expect(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8')).toBe('original\n');
    expect(f.feature.apply).not.toHaveBeenCalled();
  });
  it('retains the exact delete request until its uncertain result is observed', async () => {
    const f = await fixture();
    f.feature.apply.mockRejectedValueOnce(new Error('reply lost'));
    await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow('reply lost');
    await f.executor.deleteSkill(f.skill);
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledTimes(1);
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledWith({
      contextId: 'host-a',
      change: { action: 'delete', rootId: 'root-a', skillName: 'demo' },
    });
    expect(f.feature.apply.mock.calls[0]).toEqual(f.feature.apply.mock.calls[1]);
    expect(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8')).toBe('original\n');
  });
  it('prepares a fresh deletion after a definitive stale-plan refusal', async () => {
    const f = await fixture();
    f.feature.apply.mockRejectedValueOnce(new ManagementError('PLAN_STALE', 'Files changed', 409));
    await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow('Files changed');
    await f.executor.deleteSkill(f.skill);
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledTimes(2);
    expect(f.feature.apply.mock.calls[0]).not.toEqual(f.feature.apply.mock.calls[1]);
  });
  it.each(['failed', 'canceled'])(
    'prepares a fresh deletion after an observed %s with no effects',
    async (state) => {
      const f = await fixture();
      f.feature.apply.mockResolvedValueOnce({
        operationId: 'failed-delete',
        state,
        result: { mutated: false, nextActions: [] },
      } as Awaited<ReturnType<typeof f.feature.apply>>);
      await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow(`Skill change ${state}`);
      await f.executor.deleteSkill(f.skill);
      expect(f.feature.prepareLocalSkill).toHaveBeenCalledTimes(2);
      expect(f.feature.apply.mock.calls[0]).not.toEqual(f.feature.apply.mock.calls[1]);
    }
  );
  it('preserves deletion identity when failed work still requires recovery', async () => {
    const f = await fixture();
    f.feature.apply.mockResolvedValueOnce({
      operationId: 'pending-delete',
      state: 'failed',
      result: { mutated: true, nextActions: [] },
    } as Awaited<ReturnType<typeof f.feature.apply>>);
    await expect(f.executor.deleteSkill(f.skill)).rejects.toThrow('Skill change failed');
    await f.executor.deleteSkill(f.skill);
    expect(f.feature.prepareLocalSkill).toHaveBeenCalledTimes(1);
    expect(f.feature.apply.mock.calls[0]).toEqual(f.feature.apply.mock.calls[1]);
  });
});
