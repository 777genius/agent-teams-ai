import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  capturedSkillReadSchema,
  capturedSkillTargetSchema,
  captureSkillImportGrant,
  skillDigest,
  skillMutationResultSchema,
  skillPreviewSchema,
  skillReceiptSchema,
} from '@agent-teams/legacy-agent-host/skill-management';
import { validateOpenPathUserSelected } from '@main/utils/pathValidation';
import { isBinaryFileSync } from 'isbinaryfile';

import { SkillMetadataParser } from './SkillMetadataParser';
import { SkillValidator } from './SkillValidator';

import type {
  CapturedSkillTarget,
  SkillCommand,
} from '@agent-teams/legacy-agent-host/skill-management';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type {
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillUpsertRequest,
} from '@shared/types/extensions';

function value(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true || !('value' in raw))
    throw new Error('Original Skills request is unavailable');
  return raw.value;
}
function budget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    throw new Error(
      'Skill preview/import exceeds the encoded 32 MiB transport budget. No files were changed.'
    );
}
/** Original Main selection only. Existing UI requests never become native roots or paths. */
export class CapturedSkills {
  private readonly imports = new Map<
    string,
    { sourceDir: string; command: SkillCommand; source: ReturnType<typeof captureSkillImportGrant> }
  >();
  private readonly selectedSkills = new Map<string, string>();
  private constructor(
    private readonly owner: CapturedProviderManagement,
    readonly target: CapturedSkillTarget,
    private readonly contextId: string,
    private readonly trashItem: (path: string) => Promise<void>,
    private readonly parser = new SkillMetadataParser(),
    private readonly validator = new SkillValidator()
  ) {}
  isCurrent(): boolean {
    return this.owner.isCurrent();
  }
  static async capture(options: {
    owner: CapturedProviderManagement;
    contextId: string;
    scope: 'user' | 'project';
    rootKind: CapturedSkillTarget['rootKind'];
    trashItem(path: string): Promise<void>;
  }): Promise<CapturedSkills> {
    if (!options.owner.isCurrent()) throw new Error('Original Skills selection changed');
    const target = capturedSkillTargetSchema.parse(
      value(
        await options.owner.request('skills.capture', {
          scope: options.scope,
          rootKind: options.rootKind,
        })
      )
    );
    if (
      !options.owner.isCurrent() ||
      target.profileId !== options.owner.profileId ||
      target.configRevision !== options.owner.configRevision ||
      target.scope !== options.scope ||
      target.rootKind !== options.rootKind
    )
      throw new Error('Original Skills selection changed');
    return new CapturedSkills(options.owner, target, options.contextId, options.trashItem);
  }
  private payload(current = true) {
    if (current && !this.owner.isCurrent()) throw new Error('Original Skills selection changed');
    return {
      targetId: this.target.targetId,
      scope: this.target.scope,
      rootKind: this.target.rootKind,
    };
  }
  private checkTarget(result: {
    profileId: string;
    configRevision: string;
    targetId: string;
    scope: string;
    rootKind: string;
  }): void {
    if (
      result.profileId !== this.owner.profileId ||
      result.configRevision !== this.owner.configRevision ||
      result.targetId !== this.target.targetId ||
      result.scope !== this.target.scope ||
      result.rootKind !== this.target.rootKind
    )
      throw new Error('Original Skills response changed');
  }
  private checkRequest(request: { scope: string; rootKind: string; projectPath?: string }): void {
    this.payload();
    if (
      request.scope !== this.target.scope ||
      request.rootKind !== this.target.rootKind ||
      (request.scope === 'project' && request.projectPath !== this.target.projectRoot) ||
      (request.scope === 'user' && request.projectPath !== undefined)
    )
      throw new Error('Original Skills scope changed');
  }
  private folder(skillId: string): string {
    if (
      dirname(skillId) !== this.target.rootPath ||
      join(this.target.rootPath, basename(skillId)) !== skillId
    )
      throw new Error('Skill is outside the original captured root');
    return basename(skillId);
  }
  async list(): Promise<SkillDetail[]> {
    const result = capturedSkillReadSchema.parse(
      value(await this.owner.request('skills.read', this.payload()))
    );
    this.payload();
    this.checkTarget(result);
    if (result.rootPath !== this.target.rootPath || result.projectRoot !== this.target.projectRoot)
      throw new Error('Original Skills root changed');
    const details = result.items.map((entry) => {
      const skillDir = join(result.rootPath, entry.folderName);
      this.folder(skillDir);
      this.selectedSkills.set(skillDir, entry.identity);
      const flags = {
        hasScripts: entry.flags.scripts,
        hasReferences: entry.flags.references,
        hasAssets: entry.flags.assets,
      };
      const item = this.parser.parseCatalogItem({
        skillDir,
        folderName: entry.folderName,
        skillFile: join(skillDir, entry.skillFileName),
        rawContent: entry.rawContent,
        modifiedAt: entry.modifiedAt,
        flags,
        root: {
          rootPath: result.rootPath,
          projectRoot: result.projectRoot,
          scope: this.target.scope,
          rootKind: this.target.rootKind,
        },
      });
      const related = (prefix: string) =>
        entry.relatedFiles
          .filter((name) => name.startsWith(prefix + '/'))
          .map((name) => name.slice(prefix.length + 1));
      return this.parser.parseDetail(item, entry.rawContent, {
        referencesFiles: related('references'),
        scriptFiles: related('scripts'),
        assetFiles: related('assets'),
      });
    });
    const items = this.validator.annotateCatalog(details.map((detail) => detail.item));
    const detailsById = new Map(details.map((detail) => [detail.item.id, detail]));
    return items.map((item) => ({ ...detailsById.get(item.id)!, item }));
  }
  async getDetail(skillId: string): Promise<SkillDetail | null> {
    this.folder(skillId);
    return (await this.list()).find((detail) => detail.item.id === skillId) ?? null;
  }
  private upsert(request: SkillUpsertRequest): SkillCommand {
    this.checkRequest(request);
    if (request.existingSkillId && this.folder(request.existingSkillId) !== request.folderName)
      throw new Error('Original skill folder changed');
    return {
      action: 'upsert',
      folderName: request.folderName,
      files: structuredClone(request.files),
    };
  }
  private async preview(command: SkillCommand) {
    const input = { ...this.payload(), command };
    budget(input);
    const result = skillPreviewSchema.parse(
      value(await this.owner.request('skills.preview', input))
    );
    this.payload();
    budget(result);
    if (result.targetSkillDir !== join(this.target.rootPath, command.folderName))
      throw new Error('Original Skills preview changed');
    return result;
  }
  async previewUpsert(request: SkillUpsertRequest) {
    return this.preview(this.upsert(request));
  }
  async previewImport(request: SkillImportRequest) {
    this.checkRequest(request);
    const validated = validateOpenPathUserSelected(request.sourceDir);
    if (!validated.valid || !validated.normalizedPath) throw new Error('Invalid import source');
    const source = captureSkillImportGrant({
      sourceDir: validated.normalizedPath,
      originalContext: skillDigest({
        contextId: this.contextId,
        owner: this.owner.targetId,
        target: this.target,
      }),
      assertCurrent: () => {
        this.payload();
      },
      isBinary: isBinaryFileSync,
    });
    const command: SkillCommand = {
      action: 'import',
      folderName: request.folderName?.trim() || basename(validated.normalizedPath),
      bundle: source.bundle,
    };
    const preview = await this.preview(command);
    source.assertCurrent();
    this.imports.set(preview.planId, { sourceDir: request.sourceDir, command, source });
    return preview;
  }
  async applyUpsert(request: SkillUpsertRequest): Promise<SkillDetail | null> {
    const command = this.upsert(request);
    await this.execute(command, request.reviewPlanId);
    return this.getDetail(join(this.target.rootPath, command.folderName));
  }
  async applyImport(request: SkillImportRequest): Promise<SkillDetail | null> {
    this.checkRequest(request);
    const original = request.reviewPlanId ? this.imports.get(request.reviewPlanId) : undefined;
    if (
      !original ||
      original.sourceDir !== request.sourceDir ||
      original.command.action !== 'import' ||
      original.command.folderName !== (request.folderName?.trim() || basename(request.sourceDir))
    )
      throw new Error('Review the original skill import before saving.');
    original.source.assertCurrent();
    await this.execute(original.command, request.reviewPlanId, () =>
      original.source.assertCurrent()
    );
    return this.getDetail(join(this.target.rootPath, original.command.folderName));
  }
  async deleteSkill(request: SkillDeleteRequest): Promise<void> {
    const expectedIdentity = this.selectedSkills.get(request.skillId);
    if (!expectedIdentity) throw new Error('Open the original skill before moving it to Trash.');
    const command: SkillCommand = {
      action: 'trash',
      folderName: this.folder(request.skillId),
      expectedIdentity,
    };
    if (request.projectPath !== undefined && request.projectPath !== this.target.projectRoot)
      throw new Error('Original Skills project changed');
    const preview = await this.preview(command);
    await this.execute(command, preview.planId);
  }
  private async execute(
    command: SkillCommand,
    reviewPlanId: string | undefined,
    assertSource = () => {}
  ): Promise<void> {
    if (!reviewPlanId) throw new Error('Review the skill changes before saving.');
    const original = this.payload(),
      commandId = 'skills-' + skillDigest({ target: this.target, command, reviewPlanId });
    const lookup = async () => {
      const raw = value(await this.owner.request('skills.lookup', { ...original, commandId }));
      if (raw === null) return null;
      const receipt = skillReceiptSchema.parse(raw);
      this.checkTarget(receipt);
      if (receipt.commandId !== commandId || receipt.action !== command.action)
        throw new Error('Original Skills intent changed');
      return receipt;
    };
    const pending = value(await this.owner.request('skills.pending', { ...original, command }));
    this.payload();
    assertSource();
    if (pending !== null)
      throw new Error(
        'The original skill change is unconfirmed. Its original request has been retained.'
      );
    let result;
    try {
      const input = { ...original, commandId, reviewPlanId, command };
      budget(input);
      result = skillMutationResultSchema.parse(
        value(await this.owner.request('skills.mutate', input))
      );
      this.checkTarget(result.receipt);
      if (result.receipt.commandId !== commandId || result.receipt.action !== command.action)
        throw new Error('Original Skills intent changed');
    } catch {
      // Exactly the original deterministic intent is queried. Lookup never supplies a trash dispatch.
      const receipt = await lookup().catch(() => null);
      if (receipt?.phase === 'completed') {
        this.payload();
        return;
      }
      throw new Error(
        'The original skill change is unconfirmed. Query its original request before retrying.'
      );
    }
    this.payload();
    assertSource();
    if (command.action === 'trash' && result.nativeTrash) {
      const native = result.nativeTrash;
      const expected = join(
        this.target.rootPath,
        '._desktop-skill-' + skillDigest(commandId),
        'original'
      );
      if (native.path !== expected || realpathSync(dirname(native.path)) !== dirname(native.path))
        throw new Error('Original staged skill changed');
      const parent = lstatSync(dirname(native.path)),
        stat = lstatSync(native.path);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (parent.mode & 0o077) !== 0 ||
        parent.dev !== native.parentDev ||
        parent.ino !== native.parentIno ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== native.dev ||
        stat.ino !== native.ino ||
        parent.dev !== stat.dev
      )
        throw new Error('Original staged skill changed');
      this.payload();
      let nativeCompleted = false;
      try {
        await this.trashItem(native.path);
        nativeCompleted = true;
      } catch {
        /* Original staged data and intent remain recoverable/held; do not retry native call. */
      }
      let receipt;
      try {
        receipt = skillReceiptSchema.parse(
          value(
            await this.owner.request('skills.trash.finish', {
              ...original,
              commandId,
              token: native.token,
              nativeCompleted,
            })
          )
        );
      } catch {
        receipt = await lookup().catch(() => null);
      }
      this.payload();
      if (receipt) {
        this.checkTarget(receipt);
        if (receipt.commandId !== commandId || receipt.action !== 'trash')
          throw new Error('Original Skills intent changed');
      }
      if (!nativeCompleted || receipt?.phase !== 'completed')
        throw new Error(
          'Moving the original skill to OS Trash is unconfirmed. Its original request was retained; check OS Trash and its original staging location before any retry.'
        );
      return;
    }
    if (result.receipt.phase !== 'completed')
      throw new Error(
        'The original skill change is unconfirmed. Its original request has been retained.'
      );
  }
}
