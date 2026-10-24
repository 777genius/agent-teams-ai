import { dirname } from 'node:path';

import { SkillValidator } from './SkillValidator';

import type { CapturedSkills } from './CapturedSkills';
import type {
  SkillDeleteRequest,
  SkillImportRequest,
  SkillUpsertRequest,
} from '@shared/types/extensions';
import type { IpcMainInvokeEvent } from 'electron';

/** Root list is supplied only by the trusted existing Main context/profile registry. */
export class CapturedSkillsCollection {
  constructor(
    private readonly roots: readonly CapturedSkills[],
    private readonly current: () => boolean
  ) {
    const keys = roots.map((root) => `${root.target.scope}:${root.target.rootKind}`);
    if (new Set(keys).size !== keys.length)
      throw new Error('Captured Skills root selection is ambiguous');
  }
  watcherRoots() {
    this.assertCurrent();
    return this.roots.map(({ target }) => ({
      scope: target.scope,
      rootKind: target.rootKind,
      projectRoot: target.projectRoot,
      rootPath: target.rootPath,
    }));
  }
  assertCurrent(): void {
    if (!this.current() || this.roots.some((root) => !root.isCurrent()))
      throw new Error('Original Skills context changed');
  }
  private forChoice(request: { scope: string; rootKind: string }): CapturedSkills {
    this.assertCurrent();
    const selected = this.roots.filter(
      (root) => root.target.scope === request.scope && root.target.rootKind === request.rootKind
    );
    if (selected.length !== 1) throw new Error('Requested captured Skills root is unavailable');
    return selected[0];
  }
  private forSkill(skillId: string): CapturedSkills {
    this.assertCurrent();
    const selected = this.roots.filter((root) => root.target.rootPath === dirname(skillId));
    if (selected.length !== 1) throw new Error('Skill is outside the captured roots');
    return selected[0];
  }
  async list() {
    this.assertCurrent();
    const details = (await Promise.all(this.roots.map((root) => root.list()))).flat();
    this.assertCurrent();
    return new SkillValidator().annotateCatalog(details.map((detail) => detail.item));
  }
  async getDetail(skillId: string) {
    const value = await this.forSkill(skillId).getDetail(skillId);
    this.assertCurrent();
    return value;
  }
  async previewUpsert(request: SkillUpsertRequest) {
    const value = await this.forChoice(request).previewUpsert(request);
    this.assertCurrent();
    return value;
  }
  async applyUpsert(request: SkillUpsertRequest) {
    const value = await this.forChoice(request).applyUpsert(request);
    this.assertCurrent();
    return value;
  }
  async previewImport(request: SkillImportRequest) {
    const value = await this.forChoice(request).previewImport(request);
    this.assertCurrent();
    return value;
  }
  async applyImport(request: SkillImportRequest) {
    const value = await this.forChoice(request).applyImport(request);
    this.assertCurrent();
    return value;
  }
  async deleteSkill(request: SkillDeleteRequest) {
    await this.forSkill(request.skillId).deleteSkill(request);
    this.assertCurrent();
  }
}

/** Undefined alone selects the unchanged legacy owner. Rejection never falls back to ambient roots. */
export type CapturedSkillsCapture = (
  event: IpcMainInvokeEvent,
  projectPath: string | undefined
) => Promise<CapturedSkillsCollection> | undefined;
