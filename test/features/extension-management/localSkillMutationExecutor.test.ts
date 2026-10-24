import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    discardPlan: vi.fn(async () => {}),
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
    expect(f.feature.apply).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'host-a', planId: 'plan-a' })
    );
    expect(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8')).toBe('original\n');
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
    await expect(
      f.executor.apply(preview.planId, { ...f.request, folderName: 'other' })
    ).rejects.toThrow('changed after review');
    await f.executor.apply(preview.planId, f.request);
    expect(f.feature.apply.mock.calls[0]).toEqual(f.feature.apply.mock.calls[1]);
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
});
